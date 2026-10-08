import test from 'node:test';
import assert from 'node:assert/strict';
import { settingsFixture, accept } from './settings-fixture.mjs';

const GITHUB_INSTANCE = 'oAuth-com.github.integration.production';
const PATHS = {
  versions: '/rest/api/3/project/TRIPS/versions',
  search: '/rest/api/3/search/jql',
  summary: '/rest/dev-status/latest/issue/summary',
  detail: '/rest/dev-status/latest/issue/detail',
};
const tracker = 'TransActComm/TravelTracker';
const START_TIME = Date.UTC(2026, 9, 8, 12, 0, 0);

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

const releaseTickets = (count) =>
  Array.from({ length: count }, (_, index) => ({
    id: String(50001 + index),
    key: `DEMO-${1001 + index}`,
    fields: {
      summary: `Summary ${index + 1}`,
      status: { name: 'In Progress', statusCategory: { name: 'In Progress' } },
      issuetype: { name: 'Story' },
      priority: { name: 'High' },
      assignee: { displayName: 'QA Tester' },
      updated: '2026-10-05T12:00:00.000+0000',
    },
  }));

const pullRequestOf = (issue) => {
  const number = 900 + Number(issue.key.slice(5)) - 1000;
  return {
    id: `#${number}`,
    name: `[${issue.key}] Change for ${issue.key}`,
    status: 'OPEN',
    url: `https://github.com/${tracker}/pull/${number}`,
    repositoryName: tracker,
    repositoryUrl: `https://github.com/${tracker}`,
    source: { branch: `${issue.key}/change` },
    destination: { branch: 'ops/development' },
    lastUpdate: '2026-10-05T15:58:37.000Z',
  };
};

const summaryBody = (count) => ({
  errors: [],
  configErrors: [],
  summary: {
    pullrequest: {
      overall: { count, dataType: 'pullrequest' },
      byInstanceType: count ? { [GITHUB_INSTANCE]: { count, name: 'GitHub' } } : {},
    },
  },
});

function installJira(t, { issues, failingDetailIds = new Set() }) {
  const calls = [];
  const flight = { current: 0, peak: 0 };
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = new URL(input);
    const kind = Object.keys(PATHS).find((name) => PATHS[name] === url.pathname) ?? 'unexpected';
    calls.push({ kind, url, init });
    if (kind === 'versions') return Response.json(rawVersions);
    if (kind === 'search') return Response.json({ issues, isLast: true });
    if (kind === 'unexpected') return new Response('{}', { status: 404 });
    flight.current += 1;
    flight.peak = Math.max(flight.peak, flight.current);
    await new Promise((resolve) => setImmediate(resolve));
    flight.current -= 1;
    const issue = issues.find(({ id }) => id === url.searchParams.get('issueId'));
    if (kind === 'summary') return Response.json(summaryBody(1));
    if (failingDetailIds.has(issue.id))
      return new Response('{"errorMessages":["upstream failure"]}', { status: 500 });
    return Response.json({ errors: [], detail: [{ pullRequests: [pullRequestOf(issue)] }] });
  });
  return { calls, flight };
}

async function startRelease(t, scenario) {
  const releases = await import('../releases.mjs');
  for (const name of ['fetchRelease', 'resetReleaseCaches']) {
    assert.equal(typeof releases[name], 'function', `releases.mjs must export ${name}`);
  }
  t.after(() => releases.resetReleaseCaches());
  t.mock.timers.enable({ apis: ['Date'], now: START_TIME });
  const fixture = settingsFixture(t);
  const store = await fixture.store();
  await accept(fixture, store);
  const snapshot = store.getSnapshot();
  const jira = installJira(t, scenario);
  const fetchRelease = (refresh = false) =>
    releases.fetchRelease({ versionId: '18741', mine: true, refresh, snapshot });
  return { fetchRelease, ...jira };
}

const countOf = (calls, kind) => calls.filter((call) => call.kind === kind).length;
const detailIds = (calls) =>
  calls
    .filter((call) => call.kind === 'detail')
    .map((call) => call.url.searchParams.get('issueId'));

test('a cold load of an 11-ticket release costs 14 Jira calls', async (t) => {
  const { fetchRelease, calls } = await startRelease(t, { issues: releaseTickets(11) });
  await fetchRelease();
  assert.equal(calls.length, 14);
  assert.deepEqual(
    [
      countOf(calls, 'versions'),
      countOf(calls, 'search'),
      countOf(calls, 'summary'),
      countOf(calls, 'detail'),
    ],
    [1, 1, 1, 11],
  );
});

test('a second load within 60 seconds costs 2 calls, only the versions and the search', async (t) => {
  const { fetchRelease, calls } = await startRelease(t, { issues: releaseTickets(11) });
  await fetchRelease();
  const coldCalls = calls.length;
  t.mock.timers.tick(30_000);
  await fetchRelease();
  assert.equal(calls.length - coldCalls, 2);
  assert.deepEqual(
    calls
      .slice(coldCalls)
      .map((call) => call.kind)
      .sort(),
    ['search', 'versions'],
  );
});

test('refresh bypasses the PR cache and costs 13 calls', async (t) => {
  const { fetchRelease, calls } = await startRelease(t, { issues: releaseTickets(11) });
  await fetchRelease();
  const coldCalls = calls.length;
  await fetchRelease(true);
  assert.equal(calls.length - coldCalls, 13);
  assert.equal(detailIds(calls.slice(coldCalls)).length, 11);
});

test('dev-status calls in flight never exceed 4 while still running in parallel', async (t) => {
  const { fetchRelease, flight } = await startRelease(t, { issues: releaseTickets(11) });
  await fetchRelease();
  assert.ok(flight.peak <= 4, `peak in flight was ${flight.peak}`);
  assert.ok(flight.peak > 1, 'detail lookups should overlap');
});

test('a cached ticket lookup expires after 60 seconds', async (t) => {
  const { fetchRelease, calls } = await startRelease(t, { issues: releaseTickets(11) });
  await fetchRelease();
  t.mock.timers.tick(59_000);
  const beforeExpiry = calls.length;
  await fetchRelease();
  assert.equal(detailIds(calls.slice(beforeExpiry)).length, 0);
  t.mock.timers.tick(2_000);
  const afterExpiry = calls.length;
  await fetchRelease();
  assert.equal(detailIds(calls.slice(afterExpiry)).length, 11);
});

test('a failed lookup is not cached while the successful ones are', async (t) => {
  const failingDetailIds = new Set(['50002']);
  const { fetchRelease, calls } = await startRelease(t, {
    issues: releaseTickets(3),
    failingDetailIds,
  });
  const first = await fetchRelease();
  assert.equal(first.tickets[1].prsStatus, 'unavailable');
  failingDetailIds.clear();
  t.mock.timers.tick(5_000);
  const afterFirst = calls.length;
  const second = await fetchRelease();
  assert.deepEqual(detailIds(calls.slice(afterFirst)), ['50002']);
  assert.equal(second.tickets[1].prsStatus, 'ok');
  assert.equal(second.tickets[1].prs.length, 1);
});
