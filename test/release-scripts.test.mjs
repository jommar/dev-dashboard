// release-scripts.test.mjs — hybrid GraphQL + selective REST script/migration/Prisma-schema
// detection and the POST /api/releases/scripts HTTP route.
import test from 'node:test';
import assert from 'node:assert/strict';
import { listenHttp, requestRaw } from './http-test-fixture.mjs';
import { settingsFixture, accept, githubToken, jiraToken } from './settings-fixture.mjs';
import { createHttpHandler } from '../backend/http-app.mjs';

const API = 'https://api.github.example.invalid';
const ORG = 'TransActComm';
const TRACKER = `${ORG}/TravelTracker`;
const BACKEND = `${ORG}/Portage-backend`;
const FRONTEND = `${ORG}/Portage-frontend`;

const scriptsSnapshot = (overrides = {}) => ({
  revision: 'synthetic-release-scripts',
  github: {
    api: API,
    org: ORG,
    repos: ['TravelTracker', 'Portage-backend', 'Portage-frontend'],
    maxResults: 50,
  },
  jira: {
    baseUrl: 'https://jira.example.invalid',
    email: 'qa@example.invalid',
    sprintField: 'customfield_101',
    pointsField: 'customfield_102',
  },
  credentials: { githubToken, jiraToken },
  ...overrides,
});

const loadReleaseScripts = () => import('../backend/release-scripts.mjs');

const PACKAGE_JSON_SCRIPTS_PATCH = [
  '@@ -5,6 +5,7 @@',
  '   "scripts": {',
  '     "start": "node index.js",',
  '+    "backfill-addresses": "node setup/scripts/backfill.js",',
  '     "test": "mocha"',
  '   },',
].join('\n');

const PACKAGE_JSON_DEPS_PATCH = [
  '@@ -10,6 +10,7 @@',
  '   "dependencies": {',
  '     "express": "^4.18.0",',
  '+    "lodash": "^4.17.21"',
  '   }',
].join('\n');

test('parsePackageScriptsPatch flags added/modified scripts entries and ignores dependency edits and comma-only rewrites', async () => {
  const { parsePackageScriptsPatch } = await loadReleaseScripts();
  const added = parsePackageScriptsPatch(PACKAGE_JSON_SCRIPTS_PATCH);
  assert.ok(added.length > 0, 'added script entry is detected');
  assert.ok(
    added.some((entry) => String(entry).includes('backfill-addresses')),
    'detected entry names the added script',
  );
  assert.deepEqual(parsePackageScriptsPatch(PACKAGE_JSON_DEPS_PATCH), []);
  assert.deepEqual(parsePackageScriptsPatch(''), []);

  const trailingCommaAppend = [
    '@@ -5,6 +5,7 @@',
    '   "scripts": {',
    '     "start": "node index.js",',
    '-    "test": "mocha"',
    '+    "test": "mocha",',
    '+    "backfill-addresses": "node setup/scripts/backfill.js"',
    '   },',
  ].join('\n');
  assert.deepEqual(parsePackageScriptsPatch(trailingCommaAppend), ['backfill-addresses']);

  const modifiedValue = [
    '@@ -5,5 +5,5 @@',
    '   "scripts": {',
    '-    "test": "mocha"',
    '+    "test": "vitest"',
    '   },',
  ].join('\n');
  assert.deepEqual(parsePackageScriptsPatch(modifiedValue), ['test']);
});

test('hybrid GraphQL + selective REST classifies migrations, scripts, and Prisma schemas while filtering lib, DELETED, and non-scripts package.json', async (t) => {
  const { fetchReleaseScripts, resetReleaseScriptsCache } = await loadReleaseScripts();
  resetReleaseScriptsCache();
  t.after(() => resetReleaseScriptsCache());

  const prs = [
    {
      ticket: 'DEMO-100',
      repo: TRACKER,
      number: 101,
      state: 'merged',
      updatedAt: '2026-10-06T12:00:00Z',
    },
    {
      ticket: 'DEMO-101',
      repo: TRACKER,
      number: 102,
      state: 'open',
      updatedAt: '2026-10-06T12:00:00Z',
    },
    {
      ticket: 'DEMO-102',
      repo: BACKEND,
      number: 201,
      state: 'merged',
      updatedAt: '2026-10-06T12:00:00Z',
    },
    {
      ticket: 'DEMO-103',
      repo: FRONTEND,
      number: 301,
      state: 'open',
      updatedAt: '2026-10-06T12:00:00Z',
    },
    {
      ticket: 'DEMO-104',
      repo: TRACKER,
      number: 103,
      state: 'open',
      updatedAt: '2026-10-06T12:00:00Z',
    },
    {
      ticket: 'DEMO-105',
      repo: FRONTEND,
      number: 302,
      state: 'open',
      updatedAt: '2026-10-06T12:00:00Z',
    },
  ];

  const filesByIndex = [
    [
      { path: 'setup/knex/migrations/20260101_add.js', changeType: 'ADDED' },
      { path: 'setup/knex/migrations/admin/20260102_adm.js', changeType: 'ADDED' },
      { path: 'setup/knex/migrations/20250101_old.js', changeType: 'DELETED' },
    ],
    [
      { path: 'setup/scripts/backfill.js', changeType: 'ADDED' },
      { path: 'setup/scripts/lib/helper.js', changeType: 'ADDED' },
    ],
    [{ path: 'libs/client/prisma/client/client.prisma', changeType: 'MODIFIED' }],
    [{ path: 'scripts/check.mjs', changeType: 'ADDED' }],
    [{ path: 'package.json', changeType: 'MODIFIED' }],
    [{ path: 'package.json', changeType: 'MODIFIED' }],
  ];

  const graphqlCalls = [];
  const restCalls = [];

  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = String(input);
    if (url === `${API}/graphql`) {
      const { query } = JSON.parse(init.body);
      graphqlCalls.push(query);
      const data = Object.fromEntries(
        filesByIndex.map((nodes, index) => [
          `a${index}`,
          {
            pullRequest: {
              files: { pageInfo: { hasNextPage: false }, nodes },
            },
          },
        ]),
      );
      return Response.json({ data });
    }
    restCalls.push(url);
    if (url.includes(`/repos/${TRACKER}/pulls/103/files`)) {
      return Response.json([
        { filename: 'package.json', status: 'modified', patch: PACKAGE_JSON_SCRIPTS_PATCH },
      ]);
    }
    if (url.includes(`/repos/${FRONTEND}/pulls/302/files`)) {
      return Response.json([
        { filename: 'package.json', status: 'modified', patch: PACKAGE_JSON_DEPS_PATCH },
      ]);
    }
    return new Response('unexpected rest call', { status: 500 });
  });

  const result = await fetchReleaseScripts(prs, { snapshot: scriptsSnapshot() });

  assert.equal(result.available, true);
  assert.equal(result.truncated, false);
  assert.equal(graphqlCalls.length, 1, 'all PRs queried in one GraphQL batch');
  assert.match(graphqlCalls[0], /files\(first:\s*100\)/);
  assert.equal(
    restCalls.length,
    2,
    'REST /pulls/{n}/files runs only for PRs touching package.json',
  );
  assert.ok(restCalls.some((url) => url.includes(`/repos/${TRACKER}/pulls/103/files`)));
  assert.ok(restCalls.some((url) => url.includes(`/repos/${FRONTEND}/pulls/302/files`)));

  // DEMO-100: both Knex migrations kept, DELETED migration excluded.
  const migrations = result.byTicket['DEMO-100'] ?? [];
  assert.equal(migrations.length, 2);
  assert.ok(migrations.every((item) => item.kind === 'migration'));
  assert.deepEqual(migrations.map((item) => item.path).sort(), [
    'setup/knex/migrations/20260101_add.js',
    'setup/knex/migrations/admin/20260102_adm.js',
  ]);
  for (const item of migrations) {
    assert.equal(item.repo, TRACKER);
    assert.equal(item.prNumber, 101);
    assert.ok(typeof item.label === 'string' && item.label.length > 0);
  }

  // DEMO-101: runnable script kept, setup/scripts/lib/helper.js excluded.
  const trackerScripts = result.byTicket['DEMO-101'] ?? [];
  assert.equal(trackerScripts.length, 1);
  assert.equal(trackerScripts[0].kind, 'script');
  assert.equal(trackerScripts[0].path, 'setup/scripts/backfill.js');

  // DEMO-102: Portage-backend .prisma schema flagged as prisma-schema.
  const prisma = result.byTicket['DEMO-102'] ?? [];
  assert.equal(prisma.length, 1);
  assert.equal(prisma[0].kind, 'prisma-schema');
  assert.equal(prisma[0].path, 'libs/client/prisma/client/client.prisma');

  // DEMO-103: Portage-frontend scripts/check.mjs flagged as script.
  const feScripts = result.byTicket['DEMO-103'] ?? [];
  assert.equal(feScripts.length, 1);
  assert.equal(feScripts[0].kind, 'script');
  assert.equal(feScripts[0].path, 'scripts/check.mjs');

  // DEMO-104: package.json adding a "scripts" entry flagged as script.
  const pkgScripts = result.byTicket['DEMO-104'] ?? [];
  assert.equal(pkgScripts.length, 1);
  assert.equal(pkgScripts[0].kind, 'script');
  assert.equal(pkgScripts[0].path, 'package.json');

  // DEMO-105: package.json touching only "dependencies" excluded.
  assert.equal(result.byTicket['DEMO-105'], undefined);
});

test('per-PR cache serves repeat reads with zero fetch calls and clears on resetReleaseScriptsCache', async (t) => {
  const { fetchReleaseScripts, resetReleaseScriptsCache } = await loadReleaseScripts();
  resetReleaseScriptsCache();
  t.after(() => resetReleaseScriptsCache());

  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return Response.json({
      data: {
        a0: {
          pullRequest: {
            files: {
              pageInfo: { hasNextPage: false },
              nodes: [{ path: 'setup/knex/migrations/20260101_cached.js', changeType: 'ADDED' }],
            },
          },
        },
      },
    });
  });

  const prs = [
    {
      ticket: 'DEMO-200',
      repo: TRACKER,
      number: 555,
      state: 'merged',
      updatedAt: '2026-10-06T12:00:00Z',
    },
  ];
  const snap = scriptsSnapshot();

  const first = await fetchReleaseScripts(prs, { snapshot: snap });
  assert.equal(calls, 1);
  assert.equal(first.byTicket['DEMO-200']?.length, 1);

  const second = await fetchReleaseScripts(prs, { snapshot: snap });
  assert.equal(calls, 1, 'cached PR is served without another GitHub call');
  assert.deepEqual(second.byTicket, first.byTicket);

  resetReleaseScriptsCache();
  await fetchReleaseScripts(prs, { snapshot: snap });
  assert.equal(calls, 2, 'resetReleaseScriptsCache forces a fresh read');
});

test('per-PR cache invalidates when an open PR transitions to merged', async (t) => {
  const { fetchReleaseScripts, resetReleaseScriptsCache } = await loadReleaseScripts();
  resetReleaseScriptsCache();
  t.after(() => resetReleaseScriptsCache());

  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    const path =
      calls === 1
        ? 'setup/knex/migrations/20260101_open.js'
        : 'setup/knex/migrations/20260102_merged.js';
    return Response.json({
      data: {
        a0: {
          pullRequest: {
            files: {
              pageInfo: { hasNextPage: false },
              nodes: [{ path, changeType: 'ADDED' }],
            },
          },
        },
      },
    });
  });

  const snap = scriptsSnapshot();
  const base = {
    ticket: 'DEMO-201',
    repo: TRACKER,
    number: 556,
    updatedAt: '2026-10-06T12:00:00Z',
  };
  const openRes = await fetchReleaseScripts([{ ...base, state: 'open' }], { snapshot: snap });
  assert.equal(calls, 1);
  assert.equal(openRes.byTicket['DEMO-201']?.[0]?.label, '20260101_open.js');

  const mergedRes = await fetchReleaseScripts([{ ...base, state: 'merged' }], { snapshot: snap });
  assert.equal(calls, 2, 'state transition from open to merged invalidates cached entry');
  assert.equal(mergedRes.byTicket['DEMO-201']?.[0]?.label, '20260102_merged.js');
});

test('concurrent fetchReleaseScripts calls deduplicate in-flight GraphQL and REST fetches per PR', async (t) => {
  const { fetchReleaseScripts, resetReleaseScriptsCache } = await loadReleaseScripts();
  resetReleaseScriptsCache();
  t.after(() => resetReleaseScriptsCache());

  let graphqlCalls = 0;
  let restCalls = 0;
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = String(input);
    await new Promise((resolve) => setTimeout(resolve, 15));
    if (url === `${API}/graphql`) {
      graphqlCalls += 1;
      return Response.json({
        data: {
          a0: {
            pullRequest: {
              files: {
                pageInfo: { hasNextPage: false },
                nodes: [{ path: 'package.json', changeType: 'MODIFIED' }],
              },
            },
          },
        },
      });
    }
    restCalls += 1;
    return Response.json([
      { filename: 'package.json', status: 'modified', patch: PACKAGE_JSON_SCRIPTS_PATCH },
    ]);
  });

  const prs = [
    {
      ticket: 'DEMO-202',
      repo: TRACKER,
      number: 557,
      state: 'open',
      updatedAt: '2026-10-06T12:00:00Z',
    },
  ];
  const snap = scriptsSnapshot();
  const [first, second] = await Promise.all([
    fetchReleaseScripts(prs, { snapshot: snap }),
    fetchReleaseScripts(prs, { snapshot: snap }),
  ]);

  assert.equal(graphqlCalls, 1, 'overlapping calls share one GraphQL fetch');
  assert.equal(restCalls, 1, 'overlapping calls share one REST /pulls/{n}/files fetch');
  assert.equal(first.available, true);
  assert.equal(second.available, true);
  assert.deepEqual(second.byTicket, first.byTicket);
  assert.equal(first.byTicket['DEMO-202']?.[0]?.label, 'npm run backfill-addresses');
});

test('missing GitHub token returns available: false (unconfigured) with zero fetch calls', async (t) => {
  const { fetchReleaseScripts, resetReleaseScriptsCache } = await loadReleaseScripts();
  resetReleaseScriptsCache();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return Response.json({});
  });

  const result = await fetchReleaseScripts(
    [{ ticket: 'DEMO-1', repo: TRACKER, number: 1, state: 'open', updatedAt: '2026-10-06Z' }],
    { snapshot: scriptsSnapshot({ credentials: { githubToken: '', jiraToken } }) },
  );
  assert.equal(calls, 0);
  assert.equal(result.available, false);
  assert.equal(result.reason, 'unconfigured');
  assert.deepEqual(result.byTicket, {});
});

test('upstream 429 and 500 degrade gracefully to available: false (unavailable) without throwing', async (t) => {
  const { fetchReleaseScripts, resetReleaseScriptsCache } = await loadReleaseScripts();
  for (const status of [429, 500]) {
    resetReleaseScriptsCache();
    t.mock.method(globalThis, 'fetch', async () => new Response('upstream error', { status }));
    const result = await fetchReleaseScripts(
      [{ ticket: 'DEMO-1', repo: TRACKER, number: 1, state: 'open', updatedAt: '2026-10-06Z' }],
      { snapshot: scriptsSnapshot() },
    );
    assert.equal(result.available, false, `status ${status}`);
    assert.equal(result.reason, 'unavailable', `status ${status}`);
    assert.deepEqual(result.byTicket, {}, `status ${status}`);
  }
});

async function startScriptsRoute(t, { ready = true, fetchReleaseScripts } = {}) {
  const fixture = settingsFixture(t);
  const store = await fixture.store();
  if (ready) await accept(fixture, store);
  else await store.initialize();
  const calls = [];
  const handler = createHttpHandler({
    settings: store,
    manager: { list: () => [], logs: () => '', applySettings: async () => {} },
    integrations: {
      fetchReleaseScripts: async (...args) => {
        calls.push(args);
        if (fetchReleaseScripts) return fetchReleaseScripts(...args);
        return { available: true, truncated: false, byTicket: {} };
      },
    },
  });
  const { origin } = await listenHttp(t, handler);
  const post = async (body, headers = {}) => {
    const response = await requestRaw(origin, '/api/releases/scripts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { ...response, json: () => JSON.parse(response.text) };
  };
  return { post, calls };
}

test('POST /api/releases/scripts enforces setup gate, 403 INVALID_ORIGIN, and 400 payload validation', async (t) => {
  const unready = await startScriptsRoute(t, { ready: false });
  const setupRes = await unready.post({ prs: [] });
  assert.equal(setupRes.status, 409);
  assert.equal(setupRes.json().code, 'SETUP_REQUIRED');
  assert.deepEqual(unready.calls, []);

  const { post, calls } = await startScriptsRoute(t, { ready: true });

  // Cross-site Sec-Fetch-Site is refused with 403 INVALID_ORIGIN.
  const crossSite = await post(
    { prs: [{ ticket: 'DEMO-1', repo: 'ExampleOrg/app', number: 1, state: 'open' }] },
    { 'sec-fetch-site': 'cross-site' },
  );
  assert.equal(crossSite.status, 403);
  assert.equal(crossSite.json().code, 'INVALID_ORIGIN');
  assert.deepEqual(calls, []);

  // Repo outside the configured org is rejected with 400.
  const badRepo = await post({
    prs: [{ ticket: 'DEMO-1', repo: 'OtherOrg/secret-repo', number: 1, state: 'open' }],
  });
  assert.equal(badRepo.status, 400);
  assert.deepEqual(calls, []);

  // Malformed repo names in the configured org are rejected with 400.
  for (const invalidRepo of ['ExampleOrg/..', 'ExampleOrg/.', 'ExampleOrg/a/b', 'ExampleOrg/']) {
    const res = await post({
      prs: [{ ticket: 'DEMO-1', repo: invalidRepo, number: 1, state: 'open' }],
    });
    assert.equal(res.status, 400);
  }
  assert.deepEqual(calls, []);

  // Other repos in the configured org (e.g. test/infra repos linked in Jira) are accepted.
  const siblingRepo = await post({
    prs: [{ ticket: 'DEMO-1', repo: 'ExampleOrg/ezat-infra', number: 147, state: 'open' }],
  });
  assert.equal(siblingRepo.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0][0].repo, 'ExampleOrg/ezat-infra');
  calls.length = 0;

  // Over 200 PRs is rejected with 400.
  const tooMany = Array.from({ length: 201 }, (_, i) => ({
    ticket: `DEMO-${i + 1}`,
    repo: 'ExampleOrg/app',
    number: i + 1,
    state: 'open',
  }));
  const capped = await post({ prs: tooMany });
  assert.equal(capped.status, 400);
  assert.deepEqual(calls, []);

  // Invalid PR number or invalid ticket key is rejected with 400.
  const badNumber = await post({
    prs: [{ ticket: 'DEMO-1', repo: 'ExampleOrg/app', number: 0, state: 'open' }],
  });
  assert.equal(badNumber.status, 400);
  const badTicket = await post({
    prs: [{ ticket: '../bad', repo: 'ExampleOrg/app', number: 1, state: 'open' }],
  });
  assert.equal(badTicket.status, 400);
  assert.deepEqual(calls, []);
});

test('POST /api/releases/scripts returns 200 with byTicket and updatedAt on valid payload', async (t) => {
  const expectedByTicket = {
    'DEMO-1': [
      {
        kind: 'migration',
        label: '20260101_add.js',
        path: 'setup/knex/migrations/20260101_add.js',
        repo: 'ExampleOrg/app',
        prNumber: 42,
      },
    ],
  };
  const { post, calls } = await startScriptsRoute(t, {
    ready: true,
    fetchReleaseScripts: async () => ({
      available: true,
      truncated: false,
      byTicket: expectedByTicket,
    }),
  });
  const response = await post({
    prs: [{ ticket: 'DEMO-1', repo: 'ExampleOrg/app', number: 42, state: 'merged' }],
  });
  assert.equal(response.status, 200);
  const body = response.json();
  assert.equal(body.available, true);
  assert.equal(body.truncated, false);
  assert.deepEqual(body.byTicket, expectedByTicket);
  assert.ok(Number.isFinite(Date.parse(body.updatedAt)));
  assert.equal(calls.length, 1);
});
