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

const REVIEW = {
  complete: true,
  state: 'approved',
  approvers: ['someone-else'],
  changesRequesters: [],
  reviewDecision: null,
};
const PR = {
  repo: 'ExampleOrg/app',
  number: 7,
  title: '[DEMO-1] Synthetic change',
  url: 'https://github.com/ExampleOrg/app/pull/7',
  owner: 'another-author',
  draft: false,
  updatedAt: '2026-11-01T12:00:00Z',
  review: REVIEW,
};
const SPRINT = { id: 5, name: 'Synthetic sprint', state: 'active', startDate: null, endDate: null };
const ticket = (key, prs) => ({
  key,
  summary: `Jira summary for ${key}`,
  status: 'Ready For Code Review',
  statusCategory: 'In Progress',
  priority: 'High',
  updated: '2026-11-01T12:00:00Z',
  created: '2026-10-01T00:00:00Z',
  sprint: SPRINT,
  sprints: [SPRINT],
  prs,
});
const PAYLOAD = {
  total: 2,
  tickets: [ticket('DEMO-1', [PR]), ticket('DEMO-2', [])],
  prCoverage: { available: true, complete: true, repos: ['ExampleOrg/app'], reasons: [] },
  updatedAt: '2026-11-01T12:00:00Z',
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
  const handler = createHttpHandler({
    settings,
    manager: { list: () => [], applySettings() {} },
    integrations: {
      fetchReviewTickets: async (...args) => {
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
        `http://127.0.0.1:${server.address().port}/api/review-tickets`,
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
  return { request, calls };
}

test('review queue route is setup-gated before its integration runs', async (t) => {
  const { request, calls } = await endpoint(t, { ready: false });
  const response = await request();
  assert.equal(response.status, 409);
  assert.equal(response.json.code, 'SETUP_REQUIRED');
  assert.deepEqual(calls, []);
});

test('review queue route preserves assigned and unassigned display names without private user fields', async (t) => {
  const result = {
    ...PAYLOAD,
    tickets: [
      { ...ticket('DEMO-1', [PR]), assignee: 'Alex Example', accountId: 'private-account-id' },
      { ...ticket('DEMO-2', []), assignee: null },
    ],
  };
  const { request } = await endpoint(t, { result });
  const response = await request();
  assert.equal(response.status, 200);
  assert.deepEqual(
    response.json.tickets.map(({ assignee }) => assignee),
    ['Alex Example', null],
  );
  assert.equal(response.text.includes('private-account-id'), false);
  assertNoSecrets(response.text);
});

test('review queue route freezes the exact nested safe response contract, including PR-free Jira tickets', async (t) => {
  const privateFields = {
    credentials: { githubToken, jiraToken },
    snapshot: { githubToken },
    raw: githubToken,
  };
  const result = {
    ...PAYLOAD,
    ...privateFields,
    prCoverage: { ...PAYLOAD.prCoverage, ...privateFields },
    tickets: PAYLOAD.tickets.map((entry) => ({
      ...entry,
      ...privateFields,
      sprint: { ...entry.sprint, ...privateFields },
      sprints: entry.sprints.map((sprint) => ({ ...sprint, ...privateFields })),
      prs: entry.prs.map((pr) => ({
        ...pr,
        ...privateFields,
        review: { ...pr.review, ...privateFields },
      })),
    })),
  };
  const { request, calls } = await endpoint(t, { result });
  const response = await request();
  assert.equal(response.status, 200);
  assert.match(String(response.headers['cache-control']), /no-store/);
  assert.deepEqual(Object.keys(response.json).sort(), [
    'prCoverage',
    'tickets',
    'total',
    'updatedAt',
  ]);
  assert.equal(response.json.total, 2);
  assert.deepEqual(response.json.tickets, PAYLOAD.tickets);
  assert.deepEqual(response.json.prCoverage, PAYLOAD.prCoverage);
  assert.ok(Number.isFinite(Date.parse(response.json.updatedAt)));
  assertNoSecrets(response.text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 1);
  const captured = calls[0][0].snapshot;
  assert.ok(Object.isFrozen(captured), 'one frozen settings snapshot enters the loader');
  assert.equal(captured.credentials.githubToken, githubToken);
  assert.equal(captured.credentials.jiraToken, jiraToken);
});

test('GitHub-only failure still returns every eligible Jira ticket and explicit discovery uncertainty', async (t) => {
  const prCoverage = {
    available: false,
    complete: false,
    repos: ['ExampleOrg/app'],
    reasons: ['GitHub discovery unavailable'],
  };
  const { request } = await endpoint(t, { result: { ...PAYLOAD, prCoverage } });
  const response = await request();
  assert.equal(response.status, 200);
  assert.deepEqual(response.json.tickets, PAYLOAD.tickets);
  assert.equal(response.json.total, 2);
  assert.equal(response.json.prCoverage.available, false);
  assert.equal(response.json.prCoverage.complete, false);
  assert.ok(response.json.prCoverage.reasons.length > 0);
});

test('cross-site and same-site queue requests are rejected before costly integration reads', async (t) => {
  const { request, calls } = await endpoint(t);
  for (const site of ['cross-site', 'same-site']) {
    const response = await request({ headers: { 'sec-fetch-site': site } });
    assert.equal(response.status, 403, site);
    assert.deepEqual(Object.keys(response.json).sort(), ['code', 'error', 'errors']);
    assertNoSecrets(response.text);
  }
  assert.deepEqual(calls, []);
});

test('same-origin, typed-address and headerless clients can read the queue', async (t) => {
  const { request, calls } = await endpoint(t);
  for (const headers of [{ 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-site': 'none' }, {}]) {
    const response = await request({ headers });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json.tickets, PAYLOAD.tickets);
  }
  assert.equal(calls.length, 3);
});

test('Jira queue failure is a sanitized non-success error, never a successful empty or prefix queue', async (t) => {
  const { request, calls } = await endpoint(t, {
    error: new Error(`synthetic private upstream ${githubToken} ${jiraToken}`),
  });
  const response = await request();
  assert.equal(calls.length, 1, 'the route reaches the failing queue reader');
  assert.ok(response.status >= 400);
  assert.equal(typeof response.json.error, 'string', 'a queue error has an explicit error body');
  assert.equal('tickets' in response.json, false);
  assertNoSecrets(response.text);
  assert.equal(response.text.includes('synthetic private upstream'), false);
});

test('review queue offers no write route', async (t) => {
  const { request, calls } = await endpoint(t);
  const response = await request({ method: 'POST' });
  assert.ok(response.status >= 400);
  assert.deepEqual(calls, []);
});
