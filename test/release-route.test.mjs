import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { settingsFixture, accept, githubToken, jiraToken } from './settings-fixture.mjs';

const genericFailure = { code: 'OPERATION_FAILED', error: 'OPERATION FAILED', errors: [] };
const releaseResult = {
  versions: [
    {
      id: '18741',
      name: 'EZAT | Sprint 19.0 | 10/09/26',
      released: false,
      releaseDate: '2026-10-09',
      family: 'EZAT',
    },
  ],
  version: {
    id: '18741',
    name: 'EZAT | Sprint 19.0 | 10/09/26',
    released: false,
    releaseDate: '2026-10-09',
  },
  scope: 'all',
  total: 1,
  truncated: false,
  tickets: [
    {
      key: 'DEMO-1058',
      summary: 'Mileage rate',
      status: 'In Progress',
      issueType: 'Story',
      priority: 'High',
      assignee: 'QA Tester',
      updated: '2026-10-05T12:00:00.000+0000',
      mergeState: 'merged',
      prsStatus: 'ok',
      prs: [
        {
          repo: 'TransActComm/Portage-frontend',
          number: 535,
          title: 'DEMO-1058: Mileage rate in the form',
          url: 'https://github.com/TransActComm/Portage-frontend/pull/535',
          state: 'merged',
          base: 'ops/development',
          head: 'DEMO-1058/mileage-rate-fix',
          updatedAt: '2026-10-05T15:58:37.000Z',
          countsAsMerged: true,
        },
      ],
    },
  ],
};

async function startRoute(t, { ready }) {
  const fixture = settingsFixture(t);
  const store = await fixture.store();
  if (ready) await accept(fixture, store);
  else await store.initialize();
  const { createHttpHandler } = await import('../backend/http-app.mjs');
  const calls = [];
  const behaviour = { next: async () => releaseResult };
  const manager = { list: () => [], logs: () => '', applySettings: async () => {} };
  const handler = createHttpHandler({
    settings: store,
    manager,
    integrations: {
      fetchRelease: async (options) => {
        calls.push(options);
        return behaviour.next(options);
      },
    },
  });
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (pathname, method = 'GET', body) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        base + pathname,
        { method, headers: { 'content-type': 'application/json' } },
        (res) => {
          let text = '';
          res.on('data', (chunk) => {
            text += chunk;
          });
          res.on('end', () =>
            resolve({ status: res.statusCode, text, json: () => JSON.parse(text) }),
          );
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  return { fixture, store, calls, behaviour, request };
}

test('a ready setup passes the parsed query and the snapshot to fetchRelease and answers with its result plus updatedAt', async (t) => {
  const { store, calls, request } = await startRoute(t, { ready: true });
  const before = Date.now();
  const response = await request('/api/releases?version=18741&scope=all&refresh=1');
  const after = Date.now();
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    { versionId: '18741', mine: false, refresh: true, snapshot: store.getSnapshot() },
  ]);
  const { updatedAt, ...body } = response.json();
  assert.deepEqual(body, releaseResult);
  assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(Date.parse(updatedAt) >= before && Date.parse(updatedAt) <= after);
});

test('without parameters fetchRelease gets my tickets, no refresh and no requested version', async (t) => {
  const { store, calls, request } = await startRoute(t, { ready: true });
  const response = await request('/api/releases');
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    { versionId: null, mine: true, refresh: false, snapshot: store.getSnapshot() },
  ]);
});

test('a bad scope or version gets the generic 400 body and never reaches fetchRelease', async (t) => {
  const { calls, request } = await startRoute(t, { ready: true });
  for (const query of [
    'scope=everyone',
    'version=abc',
    'version=18741%20OR%20project%20%3D%20X',
    'version=',
  ]) {
    const response = await request(`/api/releases?${query}`);
    assert.equal(response.status, 400, query);
    assert.deepEqual(response.json(), genericFailure, query);
    assert.equal(
      response.text.includes('everyone') ||
        response.text.includes('abc') ||
        response.text.includes('project'),
      false,
      query,
    );
  }
  assert.deepEqual(calls, []);
});

test('a fetchRelease error with status hint 400 answers 400 and any other rejection answers 502, both with the generic body', async (t) => {
  const { behaviour, request } = await startRoute(t, { ready: true });
  behaviour.next = async () => {
    throw Object.assign(new Error('version not found for this project'), { statusHint: 400 });
  };
  const missing = await request('/api/releases?version=99999');
  assert.equal(missing.status, 400);
  assert.deepEqual(missing.json(), genericFailure);
  behaviour.next = async () => {
    throw new Error('jira versions failed: 500');
  };
  const failed = await request('/api/releases');
  assert.equal(failed.status, 502);
  assert.deepEqual(failed.json(), genericFailure);
  assert.equal(failed.text.includes('jira versions failed'), false);
});

test('an unsaved setup gets 409 SETUP_REQUIRED without calling fetchRelease, a saved setup reaches it, a revoked one is blocked again', async (t) => {
  const { fixture, store, calls, request } = await startRoute(t, { ready: false });
  const unsaved = await request('/api/releases');
  assert.equal(unsaved.status, 409);
  assert.equal(unsaved.json().code, 'SETUP_REQUIRED');
  assert.deepEqual(calls, []);
  const saved = await request(
    '/api/settings',
    'PUT',
    JSON.stringify({
      ...fixture.configuration,
      expectedRevision: store.getSetupStatus().revision,
      credentials: { githubToken, jiraToken },
    }),
  );
  assert.equal(saved.status, 200);
  assert.equal((await request('/api/releases')).status, 200);
  assert.equal(calls.length, 1);
  fixture.network.status = 401;
  await request('/api/settings/validate', 'POST', '{}');
  const revoked = await request('/api/releases');
  assert.equal(revoked.status, 409);
  assert.equal(revoked.json().code, 'SETUP_REQUIRED');
  assert.equal(calls.length, 1);
});
