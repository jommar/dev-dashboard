import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHttpHandler } from '../backend/http-app.mjs';
import {
  settingsFixture,
  accept,
  assertNoSecrets,
  githubToken,
  jiraToken,
} from './settings-fixture.mjs';

const PAYLOAD = {
  boards: [
    {
      name: 'Nexus',
      series: [
        {
          sprint: { id: null, name: 'Nexus Sprint 1', state: 'active', endDate: null },
          points: 2.5,
          count: 2,
          unestimated: 1,
          byStatus: { done: 0, inProgress: 2.5, notStarted: 0 },
        },
      ],
      people: [
        {
          id: 'unassigned',
          displayName: 'Unassigned',
          series: [
            {
              sprint: { id: null, name: 'Nexus Sprint 1', state: 'active', endDate: null },
              points: 2.5,
              count: 2,
              unestimated: 1,
              byStatus: { done: 0, inProgress: 2.5, notStarted: 0 },
            },
          ],
        },
      ],
    },
  ],
  keep: 8,
  coverage: { completeness: 'unknown', possibleTruncation: false, maxIssuesPerQuery: 5000 },
  updatedAt: '2026-11-01T12:00:00.000Z',
};

async function endpoint(t, { ready = true, result = PAYLOAD, error } = {}) {
  t.mock.method(globalThis, 'fetch', async () =>
    assert.fail('route tests must never contact an upstream'),
  );
  const fixture = settingsFixture(t);
  const settings = await fixture.store();
  if (ready) await accept(fixture, settings);
  else await settings.initialize();
  const calls = [];
  const snapshots = [];
  const getSnapshot = settings.getSnapshot.bind(settings);
  t.mock.method(settings, 'getSnapshot', () => {
    const captured = getSnapshot();
    snapshots.push(captured);
    return captured;
  });
  const handler = createHttpHandler({
    settings,
    manager: { list: () => [], applySettings() {} },
    integrations: {
      fetchHomeVelocity: async (...args) => {
        calls.push(args);
        if (error) throw error;
        return structuredClone(result);
      },
    },
  });
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    handler.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const request = ({ headers = {}, method = 'GET' } = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        `http://127.0.0.1:${server.address().port}/api/team-velocity`,
        { headers, method },
        (res) => {
          let text = '';
          res.on('data', (chunk) => {
            text += chunk;
          });
          res.on('end', () => {
            try {
              resolve({
                status: res.statusCode,
                headers: res.headers,
                text,
                json: JSON.parse(text),
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.setTimeout(2000, () => req.destroy(new Error('synthetic route request timed out')));
      req.on('error', reject);
      req.end();
    });
  return { request, calls, snapshots };
}

test('team velocity route returns setup-required before capturing settings or calling its integration', async (t) => {
  const { request, calls, snapshots } = await endpoint(t, { ready: false });
  const response = await request();
  assert.equal(response.status, 409);
  assert.equal(response.json.code, 'SETUP_REQUIRED');
  assert.deepEqual(calls, []);
  assert.deepEqual(snapshots, []);
  assertNoSecrets(response.text);
});

test('ready team velocity route passes one frozen snapshot to its injectable adapter and returns uncached agreed JSON', async (t) => {
  const { request, calls, snapshots } = await endpoint(t);
  const response = await request();
  assert.equal(response.status, 200);
  assert.match(String(response.headers['cache-control']), /no-store/);
  assert.match(String(response.headers['content-type']), /application\/json/);
  assert.deepEqual(response.json, PAYLOAD);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 1);
  assert.deepEqual(Object.keys(calls[0][0]), ['snapshot']);
  assert.equal(snapshots.length, 1, 'capture once per request');
  assert.equal(calls[0][0].snapshot, snapshots[0]);
  assert.ok(Object.isFrozen(snapshots[0]));
  assert.ok(Object.isFrozen(snapshots[0].jira));
  assert.equal(snapshots[0].credentials.githubToken, githubToken);
  assert.equal(snapshots[0].credentials.jiraToken, jiraToken);
  assertNoSecrets(response.text);
});

test('cross-site and same-site team velocity reads are forbidden before expensive integration calls', async (t) => {
  const { request, calls } = await endpoint(t);
  for (const site of ['cross-site', 'same-site']) {
    const response = await request({ headers: { 'sec-fetch-site': site } });
    assert.equal(response.status, 403, site);
    // The existing expensive-read routes sanitize this internal code through the shared catch.
    assert.equal(response.json.code, 'OPERATION_FAILED');
    assert.deepEqual(Object.keys(response.json).sort(), ['code', 'error', 'errors']);
    assertNoSecrets(response.text);
  }
  assert.deepEqual(calls, []);
});

test('same-origin, typed-address and headerless clients can read team velocity', async (t) => {
  const { request, calls } = await endpoint(t);
  for (const headers of [{ 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-site': 'none' }, {}]) {
    const response = await request({ headers });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, PAYLOAD);
  }
  assert.equal(calls.length, 3);
});

test('upstream team velocity errors return sanitized 502 rather than successful empty data', async (t) => {
  const { request, calls } = await endpoint(t, {
    error: new Error(`synthetic private upstream ${githubToken} ${jiraToken}`),
  });
  const response = await request();
  assert.equal(calls.length, 1, 'the integration failure is actually reached');
  assert.equal(response.status, 502);
  assert.deepEqual(response.json, {
    code: 'OPERATION_FAILED',
    error: 'OPERATION FAILED',
    errors: [],
  });
  assert.equal('boards' in response.json, false);
  assert.equal(response.text.includes('synthetic private upstream'), false);
  assertNoSecrets(response.text);
});

test('team velocity has no write route', async (t) => {
  const { request, calls } = await endpoint(t);
  const response = await request({ method: 'POST' });
  assert.ok(response.status >= 400);
  assert.deepEqual(calls, []);
});
