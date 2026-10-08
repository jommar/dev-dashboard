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
const frontend = 'TransActComm/Portage-frontend';
const backend = 'TransActComm/Portage-backend';

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

const issue = (id, key) => ({
  id,
  key,
  fields: {
    summary: `Summary of ${key}`,
    status: { name: 'In Progress', statusCategory: { name: 'In Progress' } },
    issuetype: { name: 'Story' },
    priority: { name: 'High' },
    assignee: { displayName: 'QA Tester' },
    updated: '2026-10-05T12:00:00.000+0000',
  },
});

const rawPr = ({ number, repo, title, status, head, base = 'ops/development' }) => ({
  id: `#${number}`,
  name: title,
  status,
  url: `https://github.com/${repo}/pull/${number}`,
  repositoryName: repo,
  repositoryUrl: `https://github.com/${repo}`,
  source: { branch: head },
  destination: { branch: base },
  lastUpdate: '2026-10-05T15:58:37.000Z',
  author: { name: 'User ' },
  commentCount: 0,
});

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

const detailEntry = (pullRequests) => ({
  _instance: { name: 'GitHub', type: GITHUB_INSTANCE },
  pullRequests,
  branches: [],
  repositories: [],
});

function installJira(t, { issues, devStatus }) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = new URL(input);
    const kind = Object.keys(PATHS).find((name) => PATHS[name] === url.pathname) ?? 'unexpected';
    calls.push({ kind, url, init });
    const entry = devStatus[url.searchParams.get('issueId')];
    if (kind === 'versions') return Response.json(rawVersions);
    if (kind === 'search') return Response.json({ issues, isLast: true });
    if (kind === 'summary') {
      if (entry?.summaryFailure)
        return new Response('{"errorMessages":["upstream failure"]}', {
          status: entry.summaryFailure,
        });
      return Response.json(summaryBody(entry?.count ?? 0));
    }
    if (kind === 'detail') {
      if (entry?.detailFailure)
        return new Response('{"errorMessages":["upstream failure"]}', {
          status: entry.detailFailure,
        });
      if (url.searchParams.get('applicationType') !== GITHUB_INSTANCE)
        return Response.json({ errors: [], detail: [] });
      return Response.json({ errors: [], detail: entry?.detail ?? [] });
    }
    return new Response('{}', { status: 404 });
  });
  return calls;
}

async function startRelease(t, scenario) {
  const releases = await import('../backend/releases.mjs');
  for (const name of ['fetchRelease', 'resetReleaseCaches']) {
    assert.equal(typeof releases[name], 'function', `releases.mjs must export ${name}`);
  }
  t.after(() => releases.resetReleaseCaches());
  const fixture = settingsFixture(t);
  const store = await fixture.store();
  await accept(fixture, store);
  const snapshot = store.getSnapshot();
  const calls = installJira(t, scenario);
  const fetchRelease = (options = {}) =>
    releases.fetchRelease({ versionId: '18741', mine: true, refresh: false, snapshot, ...options });
  return { fetchRelease, calls };
}

const callsOf = (calls, kind) => calls.filter((call) => call.kind === kind);
const issueIds = (calls) => calls.map((call) => call.url.searchParams.get('issueId'));
const prIds = (ticket) => ticket.prs.map(({ repo, number }) => `${repo}#${number}`).sort();

test('detail is requested with the discovered instance key and returns the PRs of every detail entry', async (t) => {
  const devStatus = {
    39151: {
      count: 3,
      detail: [
        detailEntry([
          rawPr({
            number: 2081,
            repo: tracker,
            title: '[DEMO-1398] Gate export on role',
            status: 'OPEN',
            head: 'DEMO-1398/export-role-gate',
          }),
        ]),
        detailEntry([
          rawPr({
            number: 540,
            repo: frontend,
            title: 'DEMO-1398: Gate export button',
            status: 'OPEN',
            head: 'DEMO-1398/export-role-gate',
          }),
        ]),
        detailEntry([
          rawPr({
            number: 455,
            repo: backend,
            title: '[DEMO-1398] Export permission check',
            status: 'OPEN',
            head: 'DEMO-1398/export-role-gate',
          }),
        ]),
      ],
    },
    39160: {
      count: 1,
      detail: [
        detailEntry([
          rawPr({
            number: 2090,
            repo: tracker,
            title: '[DEMO-1400] Rename the column',
            status: 'OPEN',
            head: 'DEMO-1400/rename-column',
          }),
        ]),
      ],
    },
  };
  const { fetchRelease, calls } = await startRelease(t, {
    issues: [issue('39151', 'DEMO-1398'), issue('39160', 'DEMO-1400')],
    devStatus,
  });
  const data = await fetchRelease();
  const details = callsOf(calls, 'detail');
  assert.deepEqual(issueIds(details).sort(), ['39151', '39160']);
  for (const { url } of details) {
    assert.equal(
      url.searchParams.get('applicationType'),
      'oAuth-com.github.integration.production',
    );
    assert.equal(url.searchParams.get('dataType'), 'pullrequest');
  }
  assert.equal(
    calls.some(({ url }) => url.searchParams.get('applicationType') === 'GitHub'),
    false,
  );
  assert.deepEqual(
    data.tickets.map((ticket) => ticket.key),
    ['DEMO-1398', 'DEMO-1400'],
  );
  assert.deepEqual(prIds(data.tickets[0]), [
    'TransActComm/Portage-backend#455',
    'TransActComm/Portage-frontend#540',
    'TransActComm/TravelTracker#2081',
  ]);
  assert.deepEqual(prIds(data.tickets[1]), ['TransActComm/TravelTracker#2090']);
  assert.equal(data.tickets[0].prsStatus, 'ok');
  assert.equal(data.tickets[0].mergeState, 'open');
});

const mismatchedDevStatus = () => ({
  39151: { count: 3, detail: [] },
  39160: { count: 3, detail: [] },
  39170: { count: 3, detail: [] },
});
const mismatchIssues = [
  issue('39151', 'DEMO-1398'),
  issue('39160', 'DEMO-1400'),
  issue('39170', 'DEMO-1401'),
];

test('a summary count above zero with an empty detail marks every ticket unavailable as an instance mismatch, never no-pr', async (t) => {
  const { fetchRelease } = await startRelease(t, {
    issues: mismatchIssues,
    devStatus: mismatchedDevStatus(),
  });
  const data = await fetchRelease();
  assert.equal(data.tickets.length, 3);
  for (const ticket of data.tickets) {
    assert.equal(ticket.mergeState, 'unavailable', ticket.key);
    assert.equal(ticket.prsStatus, 'unavailable', ticket.key);
    assert.equal(ticket.prsError, 'instance-mismatch', ticket.key);
    assert.deepEqual(ticket.prs, [], ticket.key);
  }
});

test('after an instance mismatch the next load discovers the instance key again', async (t) => {
  const devStatus = mismatchedDevStatus();
  const { fetchRelease, calls } = await startRelease(t, {
    issues: mismatchIssues.slice(0, 1),
    devStatus,
  });
  const failed = await fetchRelease();
  assert.equal(failed.tickets[0].prsError, 'instance-mismatch');
  const summariesBefore = callsOf(calls, 'summary').length;
  devStatus[39151].detail = [
    detailEntry([
      rawPr({
        number: 2081,
        repo: tracker,
        title: '[DEMO-1398] Gate export on role',
        status: 'OPEN',
        head: 'DEMO-1398/export-role-gate',
      }),
    ]),
  ];
  const recovered = await fetchRelease();
  assert.equal(callsOf(calls, 'summary').length - summariesBefore, 1);
  assert.deepEqual(prIds(recovered.tickets[0]), ['TransActComm/TravelTracker#2081']);
  assert.equal(recovered.tickets[0].prsStatus, 'ok');
});

test('leading tickets with a zero summary count cost one summary each, no detail, are no-pr, and discovery continues', async (t) => {
  const devStatus = {
    41000: { count: 0 },
    41010: { count: 0 },
    39151: {
      count: 3,
      detail: [
        detailEntry([
          rawPr({
            number: 2081,
            repo: tracker,
            title: '[DEMO-1398] Gate export on role',
            status: 'OPEN',
            head: 'DEMO-1398/export-role-gate',
          }),
          rawPr({
            number: 540,
            repo: frontend,
            title: 'DEMO-1398: Gate export button',
            status: 'OPEN',
            head: 'DEMO-1398/export-role-gate',
          }),
          rawPr({
            number: 455,
            repo: backend,
            title: '[DEMO-1398] Export permission check',
            status: 'OPEN',
            head: 'DEMO-1398/export-role-gate',
          }),
        ]),
      ],
    },
  };
  const issues = [
    issue('41000', 'DEMO-300'),
    issue('41010', 'DEMO-310'),
    issue('39151', 'DEMO-1398'),
  ];
  const { fetchRelease, calls } = await startRelease(t, { issues, devStatus });
  const data = await fetchRelease();
  assert.deepEqual(issueIds(callsOf(calls, 'summary')), ['41000', '41010', '39151']);
  assert.deepEqual(issueIds(callsOf(calls, 'detail')), ['39151']);
  for (const ticket of data.tickets.slice(0, 2)) {
    assert.equal(ticket.mergeState, 'no-pr', ticket.key);
    assert.equal(ticket.prsStatus, 'ok', ticket.key);
    assert.deepEqual(ticket.prs, [], ticket.key);
  }
  assert.equal(data.tickets[2].prs.length, 3);
  assert.equal(data.tickets[2].prsStatus, 'ok');
});

const staleKeyIssues = [
  issue('39151', 'DEMO-1398'),
  issue('39160', 'DEMO-1400'),
  issue('39170', 'DEMO-1401'),
];
const ownPrFor = (key, number) =>
  rawPr({
    number,
    repo: tracker,
    title: `[${key}] Change for ${key}`,
    status: 'OPEN',
    head: `${key}/change`,
  });
const healthyDevStatus = () => ({
  39151: { count: 1, detail: [detailEntry([ownPrFor('DEMO-1398', 2081)])] },
  39160: { count: 1, detail: [detailEntry([ownPrFor('DEMO-1400', 2090)])] },
  39170: { count: 1, detail: [detailEntry([ownPrFor('DEMO-1401', 2091)])] },
});
const withoutPullRequests = (devStatus, count) => {
  for (const entry of Object.values(devStatus)) Object.assign(entry, { count, detail: [] });
};

test('a cached instance key whose every detail now comes back empty fails loud as an instance mismatch, never no-pr', async (t) => {
  const devStatus = healthyDevStatus();
  const { fetchRelease } = await startRelease(t, { issues: staleKeyIssues, devStatus });
  const first = await fetchRelease();
  assert.deepEqual(
    first.tickets.map((ticket) => ticket.prsStatus),
    ['ok', 'ok', 'ok'],
  );
  withoutPullRequests(devStatus, 3);
  const stale = await fetchRelease({ refresh: true });
  assert.equal(stale.tickets.length, 3);
  for (const ticket of stale.tickets) {
    assert.equal(ticket.mergeState, 'unavailable', ticket.key);
    assert.equal(ticket.prsStatus, 'unavailable', ticket.key);
    assert.equal(ticket.prsError, 'instance-mismatch', ticket.key);
    assert.deepEqual(ticket.prs, [], ticket.key);
  }
});

test('after a stale-key mismatch nothing is cached as no-pr and the next load discovers the instance key again', async (t) => {
  const devStatus = healthyDevStatus();
  const { fetchRelease, calls } = await startRelease(t, { issues: staleKeyIssues, devStatus });
  await fetchRelease();
  const healthy = structuredClone(devStatus);
  withoutPullRequests(devStatus, 3);
  await fetchRelease({ refresh: true });
  Object.assign(devStatus, healthy);
  const afterMismatch = await fetchRelease();
  assert.equal(
    afterMismatch.tickets.some((ticket) => ticket.mergeState === 'no-pr'),
    false,
  );
  const summariesBefore = callsOf(calls, 'summary').length;
  const rediscovered = await fetchRelease({ refresh: true });
  assert.ok(
    callsOf(calls, 'summary').length - summariesBefore >= 1,
    'the cleared key is discovered again from a summary',
  );
  assert.deepEqual(
    rediscovered.tickets.map((ticket) => prIds(ticket)),
    [
      ['TransActComm/TravelTracker#2081'],
      ['TransActComm/TravelTracker#2090'],
      ['TransActComm/TravelTracker#2091'],
    ],
  );
  assert.deepEqual(
    rediscovered.tickets.map((ticket) => ticket.prsStatus),
    ['ok', 'ok', 'ok'],
  );
});

test('a cached key with every detail empty and every summary at zero is a PR-less release, verified by a summary first', async (t) => {
  const devStatus = healthyDevStatus();
  const { fetchRelease, calls } = await startRelease(t, { issues: staleKeyIssues, devStatus });
  await fetchRelease();
  withoutPullRequests(devStatus, 0);
  const summariesBefore = callsOf(calls, 'summary').length;
  const release = await fetchRelease({ refresh: true });
  assert.ok(
    callsOf(calls, 'summary').length - summariesBefore >= 1,
    'empty details are re-verified against a summary before no-pr is trusted',
  );
  for (const ticket of release.tickets) {
    assert.equal(ticket.mergeState, 'no-pr', ticket.key);
    assert.equal(ticket.prsStatus, 'ok', ticket.key);
    assert.equal(ticket.prsError, undefined, ticket.key);
    assert.deepEqual(ticket.prs, [], ticket.key);
  }
});

const sixIssues = Array.from({ length: 6 }, (_, index) =>
  issue(String(40001 + index), `DEMO-${2001 + index}`),
);
const sixIds = sixIssues.map(({ id }) => id);
const firstThreeIds = sixIds.slice(0, 3);
const healthySix = () =>
  Object.fromEntries(
    sixIssues.map(({ id, key }, index) => [
      id,
      { count: 1, detail: [detailEntry([ownPrFor(key, 3000 + index)])] },
    ]),
  );

test('discovery stops after three consecutive failing summaries and strands the rest as unavailable', async (t) => {
  const devStatus = healthySix();
  for (const id of firstThreeIds) devStatus[id] = { summaryFailure: 500 };
  const { fetchRelease, calls } = await startRelease(t, { issues: sixIssues, devStatus });
  const release = await fetchRelease();
  assert.deepEqual(issueIds(callsOf(calls, 'summary')), firstThreeIds);
  assert.deepEqual(issueIds(callsOf(calls, 'detail')), []);
  assert.deepEqual(
    release.tickets.map((ticket) => [ticket.mergeState, ticket.prsStatus, ticket.prsError]),
    sixIds.map(() => ['unavailable', 'unavailable', 'http']),
  );
});

test('discovery stops after three consecutive failing details and strands the rest as unavailable', async (t) => {
  const devStatus = healthySix();
  for (const id of firstThreeIds) devStatus[id] = { count: 1, detailFailure: 500 };
  const { fetchRelease, calls } = await startRelease(t, { issues: sixIssues, devStatus });
  const release = await fetchRelease();
  assert.deepEqual(issueIds(callsOf(calls, 'summary')), firstThreeIds);
  assert.deepEqual(issueIds(callsOf(calls, 'detail')), firstThreeIds);
  assert.deepEqual(
    release.tickets.map((ticket) => [ticket.mergeState, ticket.prsStatus, ticket.prsError]),
    sixIds.map(() => ['unavailable', 'unavailable', 'http']),
  );
});

test('two failing discovery tickets do not stop discovery: the next ticket reveals the key and the rest are looked up', async (t) => {
  const devStatus = healthySix();
  devStatus[sixIds[0]] = { summaryFailure: 500 };
  devStatus[sixIds[1]] = { count: 1, detailFailure: 500 };
  const { fetchRelease } = await startRelease(t, { issues: sixIssues, devStatus });
  const release = await fetchRelease();
  assert.deepEqual(
    release.tickets.map((ticket) => [ticket.prsStatus, ticket.prsError]),
    [
      ['unavailable', 'http'],
      ['unavailable', 'http'],
      ['ok', undefined],
      ['ok', undefined],
      ['ok', undefined],
      ['ok', undefined],
    ],
  );
  assert.deepEqual(prIds(release.tickets[5]), ['TransActComm/TravelTracker#3005']);
});
