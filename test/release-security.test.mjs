import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { settingsFixture, accept, jiraToken, assertNoSecrets } from './settings-fixture.mjs';

const JIRA_ORIGIN = 'https://jira.example.invalid';
const SAVED_AUTHORIZATION =
  'Basic cWFAZXhhbXBsZS5pbnZhbGlkOnN5bnRoZXRpYy1qaXJhLW9ubHktZm9yLXRlc3Rz';
const GITHUB_INSTANCE = 'oAuth-com.github.integration.production';
const canary = 'canary-upstream-text-4f2c9d';
const leakMarkers = [
  canary,
  'fixVersion',
  'currentUser',
  Buffer.from(`qa@example.invalid:${jiraToken}`).toString('base64'),
];
const PATHS = {
  versions: '/rest/api/3/project/TRIPS/versions',
  search: '/rest/api/3/search/jql',
  summary: '/rest/dev-status/latest/issue/summary',
  detail: '/rest/dev-status/latest/issue/detail',
};

const rawVersions = [
  {
    self: 'https://jira.example.invalid/rest/api/3/version/18741',
    id: '18741',
    name: 'EZAT | Sprint 19.0 | 10/09/26',
    archived: false,
    released: false,
    releaseDate: '2026-10-09',
    projectId: 10000,
  },
];
const releaseIssues = [
  {
    id: '38010',
    key: 'DEMO-1058',
    fields: {
      summary: 'Mileage rate',
      status: { name: 'In Progress' },
      issuetype: { name: 'Story' },
      priority: { name: 'High' },
      assignee: { displayName: 'QA Tester' },
      updated: '2026-10-05T12:00:00.000+0000',
    },
  },
  {
    id: '39151',
    key: 'DEMO-1398',
    fields: {
      summary: 'Export gate',
      status: { name: 'To Do' },
      issuetype: { name: 'Defect' },
      priority: { name: 'Low' },
      assignee: null,
      updated: '2026-10-06T12:00:00.000+0000',
    },
  },
];
const mileagePr = {
  id: '#535',
  name: 'DEMO-1058: Mileage rate in the form',
  status: 'MERGED',
  url: 'https://github.com/TransActComm/Portage-frontend/pull/535',
  repositoryName: 'TransActComm/Portage-frontend',
  repositoryUrl: 'https://github.com/TransActComm/Portage-frontend',
  source: { branch: 'DEMO-1058/mileage-rate-fix' },
  destination: { branch: 'ops/development' },
  lastUpdate: '2026-10-05T15:58:37.000Z',
  author: { name: canary },
  reviewers: [{ name: canary }],
  commentCount: 0,
};

const failure = (status) =>
  new Response(JSON.stringify({ errorMessages: [canary], message: canary }), { status });
const healthyUpstream = {
  versions: () => Response.json(rawVersions),
  search: () => Response.json({ issues: releaseIssues, isLast: true }),
  summary: () =>
    Response.json({
      errors: [],
      summary: {
        pullrequest: {
          overall: { count: 1 },
          byInstanceType: { [GITHUB_INSTANCE]: { count: 1, name: 'GitHub' } },
        },
      },
    }),
  detail: (url) =>
    url.searchParams.get('issueId') === '39151'
      ? Response.json({ errors: [], detail: [{ pullRequests: [] }] })
      : Response.json({ errors: [], detail: [{ pullRequests: [mileagePr] }] }),
};

async function startRelease(t) {
  const releases = await import('../releases.mjs');
  for (const name of ['fetchRelease', 'resetReleaseCaches']) {
    assert.equal(typeof releases[name], 'function', `releases.mjs must export ${name}`);
  }
  t.after(() => releases.resetReleaseCaches());
  const fixture = settingsFixture(t);
  const store = await fixture.store();
  await accept(fixture, store);
  const upstream = { ...healthyUpstream };
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = new URL(input);
    const kind = Object.keys(PATHS).find((name) => PATHS[name] === url.pathname) ?? 'unexpected';
    calls.push({ kind, url, init });
    return (upstream[kind] ?? (() => new Response('{}', { status: 404 })))(url, init);
  });
  return { releases, store, upstream, calls, snapshot: store.getSnapshot() };
}

async function serveRoute(t, store) {
  const { createHttpHandler } = await import('../http-app.mjs');
  const manager = { list: () => [], logs: () => '', applySettings: async () => {} };
  const server = http.createServer(createHttpHandler({ settings: store, manager }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return (pathname) =>
    new Promise((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${server.address().port}${pathname}`, (res) => {
          let text = '';
          res.on('data', (chunk) => {
            text += chunk;
          });
          res.on('end', () => resolve({ status: res.statusCode, text }));
        })
        .on('error', reject);
    });
}

test('an upstream 401 on the versions call gives the route a generic 502 with no token, Basic value, canary or JQL', async (t) => {
  const { store, upstream } = await startRelease(t);
  const get = await serveRoute(t, store);
  upstream.versions = () => failure(401);
  const response = await get('/api/releases');
  assert.equal(response.status, 502);
  assertNoSecrets(response.text, leakMarkers);
});

test('an upstream 500 on the search call gives the route a generic 502 with no token, Basic value, canary or JQL', async (t) => {
  const { store, upstream } = await startRelease(t);
  const get = await serveRoute(t, store);
  upstream.search = () => failure(500);
  const response = await get('/api/releases');
  assert.equal(response.status, 502);
  assertNoSecrets(response.text, leakMarkers);
});

test('an upstream 500 on a dev-status call leaves the route payload free of the canary, token, Basic value and JQL', async (t) => {
  const { store, upstream } = await startRelease(t);
  const get = await serveRoute(t, store);
  upstream.detail = () => failure(500);
  const response = await get('/api/releases');
  assert.equal(response.status, 200);
  assertNoSecrets(response.text, leakMarkers);
});

test('a successful payload carries no token, Basic value, JQL or unmapped upstream text', async (t) => {
  const { store } = await startRelease(t);
  const get = await serveRoute(t, store);
  const response = await get('/api/releases?scope=all');
  assert.equal(response.status, 200);
  assert.ok(response.text.includes('DEMO-1058'));
  assertNoSecrets(response.text, leakMarkers);
});

test('the error thrown for an upstream 401 or 500 carries no token, Basic value, canary or JQL, so the CLI stderr cannot either', async (t) => {
  const { releases, upstream, snapshot } = await startRelease(t);
  const options = { versionId: '18741', mine: true, refresh: false, snapshot };
  for (const [kind, status] of [
    ['versions', 401],
    ['search', 500],
  ]) {
    upstream[kind] = () => failure(status);
    await assert.rejects(
      releases.fetchRelease(options),
      (error) => {
        assertNoSecrets(String(error.message), leakMarkers);
        assertNoSecrets(String(error), leakMarkers);
        return true;
      },
      `${kind} ${status}`,
    );
    upstream[kind] = healthyUpstream[kind];
  }
});

test('every request goes to the saved Jira origin with redirect error and the saved credentials, even when the environment points elsewhere', async (t) => {
  const { releases, calls, snapshot } = await startRelease(t);
  const poisoned = {
    JIRA_BASE_URL: 'https://env-poison.example.invalid',
    JIRA_EMAIL: 'poison@example.invalid',
    JIRA_TOKEN: 'synthetic-env-poison-token',
    GH_TOKEN: 'synthetic-env-poison-github',
  };
  Object.assign(process.env, poisoned);
  t.after(() => {
    for (const name of Object.keys(poisoned)) delete process.env[name];
  });
  await releases.fetchRelease({ versionId: '18741', mine: true, refresh: false, snapshot });
  assert.deepEqual([...new Set(calls.map((call) => call.kind))].sort(), [
    'detail',
    'search',
    'summary',
    'versions',
  ]);
  for (const { url, init } of calls) {
    assert.equal(url.origin, JIRA_ORIGIN, url.href);
    assert.equal(init.redirect, 'error', url.href);
    assert.equal(new Headers(init.headers).get('authorization'), SAVED_AUTHORIZATION, url.href);
  }
});

test('no GitHub request is made and no GitHub token is sent', async (t) => {
  const { releases, calls, snapshot } = await startRelease(t);
  process.env.GH_TOKEN = 'synthetic-env-poison-github';
  t.after(() => {
    delete process.env.GH_TOKEN;
  });
  await releases.fetchRelease({ versionId: '18741', mine: false, refresh: true, snapshot });
  assert.ok(calls.length >= 4);
  assert.equal(
    calls.some(({ url }) => /github/i.test(url.hostname)),
    false,
  );
  assert.equal(
    calls.some(({ init }) =>
      /Bearer|synthetic-env-poison-github/.test(JSON.stringify(init.headers ?? {})),
    ),
    false,
  );
});
