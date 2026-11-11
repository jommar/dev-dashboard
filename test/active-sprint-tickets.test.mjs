import test from 'node:test';
import assert from 'node:assert/strict';
import * as jira from '../backend/jira.mjs';
import { createHttpHandler } from '../backend/http-app.mjs';
import { listenHttp, requestRaw } from './http-test-fixture.mjs';
import { settingsFixture, accept } from './settings-fixture.mjs';

const ACTIVE = { id: 8, name: 'Active sprint', state: 'active' };
const CLOSED = { id: 7, name: 'Old sprint', state: 'closed', endDate: '2026-09-30' };
const FUTURE = { id: 9, name: 'Next sprint', state: 'future' };

async function configured(t) {
  jira.clearActiveSprintAnswers();
  t.after(() => jira.clearActiveSprintAnswers());
  const fixture = settingsFixture(t);
  const settings = await fixture.store();
  await accept(fixture, settings);
  return { settings, snapshot: settings.getSnapshot() };
}

// A Jira that answers `key in (...)` searches from `sprintsByKey`, and records each search's keys.
function fakeJira(t, sprintsByKey, { fail = false } = {}) {
  const searches = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    assert.equal(url.pathname, '/rest/api/3/search/jql');
    const keys = [...url.searchParams.get('jql').matchAll(/"([A-Z]+-\d+)"/g)].map(([, key]) => key);
    searches.push(keys);
    if (fail) return new Response('nope', { status: 500 });
    return Response.json({
      isLast: true,
      issues: keys
        .filter((key) => key in sprintsByKey)
        .map((key) => ({
          key,
          fields: { status: { name: 'Code Review' }, customfield_101: sprintsByKey[key] },
        })),
    });
  });
  return searches;
}

test('only tickets whose most relevant sprint is active are in the active sprint', async (t) => {
  const { snapshot } = await configured(t);
  const searches = fakeJira(t, {
    'DEMO-1': [CLOSED, ACTIVE],
    'DEMO-2': [CLOSED, FUTURE],
    'DEMO-3': [CLOSED],
    'DEMO-4': null,
    'DEMO-5': [{ id: 11, name: 'Other board sprint', state: 'active' }],
  });
  const result = await jira.fetchActiveSprintKeys(
    ['DEMO-5', 'DEMO-1', 'DEMO-2', 'DEMO-3', 'DEMO-4', 'DEMO-6', 'demo-7', 'junk', 'DEMO-1'],
    { snapshot },
  );
  assert.deepEqual(result, {
    available: true,
    keys: ['DEMO-1', 'DEMO-5'],
    statuses: {
      'DEMO-1': 'Code Review',
      'DEMO-2': 'Code Review',
      'DEMO-3': 'Code Review',
      'DEMO-4': 'Code Review',
      'DEMO-5': 'Code Review',
    },
  });
  assert.equal(searches.length, 1, 'one search for the whole list');
  assert.deepEqual(searches[0], ['DEMO-1', 'DEMO-2', 'DEMO-3', 'DEMO-4', 'DEMO-5', 'DEMO-6']);
});

test('answers are cached for the TTL and only new keys reach Jira', async (t) => {
  const { snapshot } = await configured(t);
  const searches = fakeJira(t, { 'DEMO-1': [ACTIVE], 'DEMO-2': [CLOSED], 'DEMO-3': [ACTIVE] });
  const t0 = 1_000_000;
  await jira.fetchActiveSprintKeys(['DEMO-1', 'DEMO-2'], { snapshot, now: t0 });
  const again = await jira.fetchActiveSprintKeys(['DEMO-1', 'DEMO-2'], {
    snapshot,
    now: t0 + 1000,
  });
  assert.deepEqual(again.keys, ['DEMO-1']);
  assert.deepEqual(again.statuses, { 'DEMO-1': 'Code Review', 'DEMO-2': 'Code Review' });
  assert.equal(searches.length, 1, 'a repeat asks Jira nothing');
  const grown = await jira.fetchActiveSprintKeys(['DEMO-1', 'DEMO-2', 'DEMO-3'], {
    snapshot,
    now: t0 + 2000,
  });
  assert.deepEqual(grown.keys, ['DEMO-1', 'DEMO-3']);
  assert.deepEqual(searches[1], ['DEMO-3'], 'only the key with no answer is searched');
  await jira.fetchActiveSprintKeys(['DEMO-1'], { snapshot, now: t0 + jira.ACTIVE_SPRINT_TTL_MS });
  assert.deepEqual(searches[2], ['DEMO-1'], 'an answer past the TTL is asked again');
});

test('a long list is searched in chunks and capped', async (t) => {
  const { snapshot } = await configured(t);
  const searches = fakeJira(t, {});
  const keys = Array.from({ length: 260 }, (_, i) => `DEMO-${i + 1}`);
  await jira.fetchActiveSprintKeys(keys, { snapshot });
  assert.equal(searches.flat().length, jira.ACTIVE_SPRINT_MAX_KEYS);
  assert.ok(searches.every((chunk) => chunk.length <= 50));
});

test('an unavailable or unconfigured Jira reports unavailable, never an empty answer', async (t) => {
  const { snapshot } = await configured(t);
  fakeJira(t, { 'DEMO-1': [ACTIVE] }, { fail: true });
  assert.deepEqual(await jira.fetchActiveSprintKeys(['DEMO-1'], { snapshot }), {
    available: false,
    reason: 'jira_unavailable',
    keys: [],
    statuses: {},
  });
  t.mock.restoreAll();
  const searches = fakeJira(t, { 'DEMO-1': [ACTIVE] });
  assert.deepEqual((await jira.fetchActiveSprintKeys(['DEMO-1'], { snapshot })).keys, ['DEMO-1']);
  assert.equal(searches.length, 1, 'a failed answer was not cached');
  assert.deepEqual(await jira.fetchActiveSprintKeys(['DEMO-1'], {}), {
    available: false,
    reason: 'jira_not_configured',
    keys: [],
    statuses: {},
  });
});

test('GET /api/active-sprint-tickets is setup-gated and passes the keys to the integration', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('route tests never reach Jira'));
  for (const ready of [false, true]) {
    const fixture = settingsFixture(t);
    const settings = await fixture.store();
    if (ready) await accept(fixture, settings);
    else await settings.initialize();
    const calls = [];
    const handler = createHttpHandler({
      settings,
      manager: { list: () => [], applySettings() {} },
      integrations: {
        fetchActiveSprintKeys: async (keys) => {
          calls.push(keys);
          return { available: true, keys: ['DEMO-1'], statuses: { 'DEMO-1': 'Code Review' } };
        },
      },
    });
    const { origin } = await listenHttp(t, handler);
    const response = await requestRaw(origin, '/api/active-sprint-tickets?keys=DEMO-1,DEMO-2', {
      timeout: 2000,
      timeoutMessage: 'synthetic route request timed out',
    });
    if (!ready) {
      assert.equal(response.status, 409);
      assert.deepEqual(calls, []);
      continue;
    }
    assert.equal(response.status, 200);
    assert.match(String(response.headers['cache-control']), /no-store/);
    assert.deepEqual(calls, [['DEMO-1', 'DEMO-2']]);
    const body = JSON.parse(response.text);
    assert.deepEqual([body.available, body.keys], [true, ['DEMO-1']]);
    assert.deepEqual(body.statuses, { 'DEMO-1': 'Code Review' });
    assert.ok(body.updatedAt);
  }
});
