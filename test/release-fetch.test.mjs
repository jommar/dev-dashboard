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

const jiraVersion = (id, name, { released = false, releaseDate, archived = false } = {}) => ({
  self: `https://jira.example.invalid/rest/api/3/version/${id}`,
  id,
  name,
  archived,
  released,
  projectId: 10000,
  ...(releaseDate ? { releaseDate } : {}),
});

const rawVersions = [
  jiraVersion('18838', 'EZAT | Sprint 20.0 | 10/23/26', { releaseDate: '2026-10-23' }),
  jiraVersion('18741', 'EZAT | Sprint 19.0 | 10/09/26', { releaseDate: '2026-10-09' }),
  jiraVersion('18700', 'AS | Sprint 13.0 | 10/02/26', { releaseDate: '2026-10-02' }),
  jiraVersion('18600', 'EZAT | Sprint 18.0 | 09/25/26', {
    released: true,
    releaseDate: '2026-09-25',
  }),
  jiraVersion('18000', 'EZAT | Sprint 9.0 | 04/01/26', {
    released: true,
    releaseDate: '2026-04-01',
    archived: true,
  }),
];

const issue = (id, key, fields = {}) => ({
  id,
  key,
  fields: {
    summary: `Summary of ${key}`,
    status: { name: 'In Progress', statusCategory: { name: 'In Progress' } },
    issuetype: { name: 'Story' },
    priority: { name: 'High' },
    assignee: { displayName: 'QA Tester' },
    updated: '2026-10-05T12:00:00.000+0000',
    ...fields,
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

const mileageMergedTracker = rawPr({
  number: 2075,
  repo: tracker,
  title: '[DEMO-1058] Fix the mileage rate',
  status: 'MERGED',
  head: 'DEMO-1058/mileage-rate-fix',
});
const mileageMergedFrontend = rawPr({
  number: 535,
  repo: frontend,
  title: 'DEMO-1058: Mileage rate in the form',
  status: 'MERGED',
  head: 'DEMO-1058/mileage-rate-fix',
});
const mileageOpenBackend = rawPr({
  number: 451,
  repo: backend,
  title: '[DEMO-1058] Mileage rate API',
  status: 'OPEN',
  head: 'DEMO-1058/mileage-rate-fix',
});
const promotionDevToQa = rawPr({
  number: 2060,
  repo: tracker,
  title: '[MERGE] DEV → QA',
  status: 'MERGED',
  base: 'ops/qa',
  head: 'ops/development',
});
const promotionQaToUat = rawPr({
  number: 2061,
  repo: tracker,
  title: '[MERGE] QA → UAT',
  status: 'DECLINED',
  base: 'ops/uat',
  head: 'ops/qa',
});
const foreignPr = rawPr({
  number: 2079,
  repo: tracker,
  title: '[DEMO-1748] Estimator on the shared rate',
  status: 'OPEN',
  head: 'DEMO-1748-estimator-on-1058',
});

function standardHandlers({ versions = rawVersions, issues = [], devStatus = {} } = {}) {
  return {
    versions: () => Response.json(versions),
    search: () => Response.json({ issues, isLast: true }),
    summary: (url) =>
      Response.json(summaryBody(devStatus[url.searchParams.get('issueId')]?.count ?? 0)),
    detail: (url) => {
      const entry = devStatus[url.searchParams.get('issueId')];
      if (entry?.failure)
        return new Response(JSON.stringify({ errorMessages: ['upstream failure'] }), {
          status: entry.failure,
        });
      if (url.searchParams.get('applicationType') !== GITHUB_INSTANCE)
        return Response.json({ errors: [], detail: [] });
      return Response.json({ errors: [], detail: entry?.detail ?? [] });
    },
  };
}

function installJira(t, handlers, projectKey = 'TRIPS') {
  const calls = [];
  const paths = { ...PATHS, versions: `/rest/api/3/project/${projectKey}/versions` };
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname === '/graphql') {
      calls.push({ kind: 'githubOwners', url, init });
      const aliases = [
        ...JSON.parse(init.body).query.matchAll(
          /a(\d+): repository[\s\S]*?pullRequest\(number: (\d+)\)/g,
        ),
      ];
      return Response.json({
        data: Object.fromEntries(
          aliases.map(([, index, number]) => [
            `a${index}`,
            { pullRequest: { author: { login: `github-owner-${number}` } } },
          ]),
        ),
      });
    }
    const kind = Object.keys(paths).find((name) => paths[name] === url.pathname) ?? 'unexpected';
    calls.push({ kind, url, init });
    return (handlers[kind] ?? (() => new Response('{}', { status: 404 })))(url, init);
  });
  return calls;
}

async function startRelease(
  t,
  handlers,
  { specifier = '../backend/releases.mjs', projectKey } = {},
) {
  const releases = await import(specifier);
  for (const name of ['fetchRelease', 'resetReleaseCaches']) {
    assert.equal(typeof releases[name], 'function', `releases.mjs must export ${name}`);
  }
  t.after(() => releases.resetReleaseCaches());
  const fixture = settingsFixture(t);
  const store = await fixture.store();
  await accept(fixture, store);
  const snapshot = store.getSnapshot();
  const calls = installJira(t, handlers, projectKey);
  const fetchRelease = (options = {}) =>
    releases.fetchRelease({ versionId: '18741', mine: true, refresh: false, snapshot, ...options });
  return { fetchRelease, calls };
}

const threeTicketRelease = () =>
  standardHandlers({
    issues: [
      issue('39151', 'DEMO-1398'),
      issue('38010', 'DEMO-1058'),
      issue('38052', 'DEMO-1100', { assignee: null }),
    ],
    devStatus: {
      38010: {
        count: 7,
        detail: [
          detailEntry([mileageMergedTracker, mileageMergedFrontend, promotionDevToQa]),
          detailEntry([mileageOpenBackend, promotionQaToUat, foreignPr]),
        ],
      },
      38052: { count: 0, detail: [detailEntry([])] },
      39151: { failure: 500 },
    },
  });

const callsOf = (calls, kind) => calls.filter((call) => call.kind === kind);
const prIds = (ticket) => ticket.prs.map(({ repo, number }) => `${repo}#${number}`).sort();

test('tickets come back in numeric key order whatever order Jira returned them', async (t) => {
  const { fetchRelease } = await startRelease(t, threeTicketRelease());
  const data = await fetchRelease();
  assert.deepEqual(
    data.tickets.map((ticket) => ticket.key),
    ['DEMO-1058', 'DEMO-1100', 'DEMO-1398'],
  );
  assert.equal(data.total, 3);
  assert.equal(data.truncated, false);
});

test('a ticket keeps only its own PRs, with their states, and rolls up to partial', async (t) => {
  const { fetchRelease, calls } = await startRelease(t, threeTicketRelease());
  const [ticket] = (await fetchRelease()).tickets;
  assert.equal(ticket.key, 'DEMO-1058');
  assert.equal(ticket.summary, 'Summary of DEMO-1058');
  assert.equal(ticket.status, 'In Progress');
  assert.equal(ticket.issueType, 'Story');
  assert.equal(ticket.priority, 'High');
  assert.equal(ticket.assignee, 'QA Tester');
  assert.equal(ticket.updated, '2026-10-05T12:00:00.000+0000');
  assert.equal(ticket.prsStatus, 'ok');
  assert.equal(ticket.mergeState, 'partial');
  assert.deepEqual(prIds(ticket), [
    'TransActComm/Portage-backend#451',
    'TransActComm/Portage-frontend#535',
    'TransActComm/TravelTracker#2075',
  ]);
  const frontendPr = ticket.prs.find((pr) => pr.number === 535);
  assert.deepEqual(frontendPr, {
    repo: 'TransActComm/Portage-frontend',
    number: 535,
    title: 'DEMO-1058: Mileage rate in the form',
    owner: 'github-owner-535',
    url: 'https://github.com/TransActComm/Portage-frontend/pull/535',
    state: 'merged',
    base: 'ops/development',
    head: 'DEMO-1058/mileage-rate-fix',
    updatedAt: '2026-10-05T15:58:37.000Z',
    countsAsMerged: true,
  });
  assert.ok(calls.some((call) => call.url.pathname === '/graphql'));
  assert.equal(ticket.prs.find((pr) => pr.number === 451).state, 'open');
  assert.equal(ticket.prs.find((pr) => pr.number === 451).countsAsMerged, false);
});

test('a ticket without PRs is no-pr and an unassigned ticket has a null assignee', async (t) => {
  const { fetchRelease } = await startRelease(t, threeTicketRelease());
  const ticket = (await fetchRelease()).tickets[1];
  assert.equal(ticket.key, 'DEMO-1100');
  assert.equal(ticket.mergeState, 'no-pr');
  assert.equal(ticket.prsStatus, 'ok');
  assert.deepEqual(ticket.prs, []);
  assert.equal(ticket.assignee, null);
  assert.equal(ticket.prsError, undefined);
});

test('only the ticket whose detail call failed is unavailable, with prsError http', async (t) => {
  const { fetchRelease } = await startRelease(t, threeTicketRelease());
  const data = await fetchRelease();
  const failed = data.tickets[2];
  assert.equal(failed.key, 'DEMO-1398');
  assert.equal(failed.mergeState, 'unavailable');
  assert.equal(failed.prsStatus, 'unavailable');
  assert.equal(failed.prsError, 'http');
  assert.deepEqual(failed.prs, []);
  assert.deepEqual(
    data.tickets.slice(0, 2).map((ticket) => ticket.prsStatus),
    ['ok', 'ok'],
  );
});

test('duplicate PR URLs from several detail entries collapse into one PR', async (t) => {
  const devStatus = {
    38010: {
      count: 3,
      detail: [
        detailEntry([mileageMergedTracker, mileageMergedTracker]),
        detailEntry([mileageMergedTracker]),
      ],
    },
  };
  const { fetchRelease } = await startRelease(
    t,
    standardHandlers({ issues: [issue('38010', 'DEMO-1058')], devStatus }),
  );
  const [ticket] = (await fetchRelease()).tickets;
  assert.deepEqual(prIds(ticket), ['TransActComm/TravelTracker#2075']);
  assert.equal(ticket.mergeState, 'merged');
});

test('the payload lists the ordered versions, the requested version and the scope', async (t) => {
  const { fetchRelease } = await startRelease(t, threeTicketRelease());
  const data = await fetchRelease();
  assert.deepEqual(
    data.versions.map((version) => version.id),
    ['18700', '18741', '18838', '18600'],
  );
  assert.equal(data.version.id, '18741');
  assert.equal(data.version.name, 'EZAT | Sprint 19.0 | 10/09/26');
  assert.equal(data.version.released, false);
  assert.equal(data.version.releaseDate, '2026-10-09');
  assert.equal(data.scope, 'mine');
});

test('my tickets searches Jira for the version and the current user', async (t) => {
  const { fetchRelease, calls } = await startRelease(t, threeTicketRelease());
  await fetchRelease({ mine: true });
  const [search] = callsOf(calls, 'search');
  assert.equal(
    search.url.searchParams.get('jql'),
    'fixVersion = 18741 AND assignee = currentUser() ORDER BY key ASC',
  );
});

test('all release tickets searches Jira for the version only and reports scope all', async (t) => {
  const { fetchRelease, calls } = await startRelease(t, threeTicketRelease());
  const data = await fetchRelease({ mine: false });
  const [search] = callsOf(calls, 'search');
  assert.equal(search.url.searchParams.get('jql'), 'fixVersion = 18741 ORDER BY key ASC');
  assert.equal(data.scope, 'all');
});

test('without a requested version the earliest unreleased EZAT version is used', async (t) => {
  const { fetchRelease, calls } = await startRelease(t, threeTicketRelease());
  const data = await fetchRelease({ versionId: null });
  assert.equal(data.version.id, '18741');
  assert.equal(
    callsOf(calls, 'search')[0].url.searchParams.get('jql'),
    'fixVersion = 18741 AND assignee = currentUser() ORDER BY key ASC',
  );
});

test('a version id missing from the fetched list is rejected with status hint 400 before any search', async (t) => {
  const { fetchRelease, calls } = await startRelease(t, threeTicketRelease());
  await assert.rejects(fetchRelease({ versionId: '99999' }), (error) => error?.statusHint === 400);
  assert.equal(callsOf(calls, 'search').length, 0);
});

test('a failed versions call rejects', async (t) => {
  const handlers = {
    ...threeTicketRelease(),
    versions: () => new Response('{"message":"down"}', { status: 500 }),
  };
  const { fetchRelease } = await startRelease(t, handlers);
  await assert.rejects(fetchRelease());
});

test('a failed search call rejects', async (t) => {
  const handlers = {
    ...threeTicketRelease(),
    search: () => new Response('{"message":"down"}', { status: 500 }),
  };
  const { fetchRelease } = await startRelease(t, handlers);
  await assert.rejects(fetchRelease());
});

const manyIssues = (count, offset) =>
  Array.from({ length: count }, (_, index) =>
    issue(String(70000 + offset + index), `DEMO-${3000 + offset + index}`),
  );
const pagedSearch = (pages) => (url) =>
  Response.json(pages[url.searchParams.get('nextPageToken') ?? 'first']);

test('more than 100 matching tickets keeps 100 and sets truncated', async (t) => {
  const handlers = {
    ...standardHandlers(),
    search: pagedSearch({
      first: { issues: manyIssues(50, 0), isLast: false, nextPageToken: 'second' },
      second: { issues: manyIssues(50, 50), isLast: false, nextPageToken: 'third' },
      third: { issues: manyIssues(3, 100), isLast: true },
    }),
  };
  const { fetchRelease } = await startRelease(t, handlers);
  const data = await fetchRelease();
  assert.equal(data.tickets.length, 100);
  assert.equal(data.truncated, true);
});

test('exactly 100 matching tickets is a complete answer and is not truncated', async (t) => {
  const handlers = {
    ...standardHandlers(),
    search: pagedSearch({
      first: { issues: manyIssues(50, 0), isLast: false, nextPageToken: 'second' },
      second: { issues: manyIssues(50, 50), isLast: true },
    }),
  };
  const { fetchRelease } = await startRelease(t, handlers);
  const data = await fetchRelease();
  assert.equal(data.tickets.length, 100);
  assert.equal(data.truncated, false);
});

test('an empty version list returns a null version and tickets without searching', async (t) => {
  const { fetchRelease, calls } = await startRelease(t, standardHandlers({ versions: [] }));
  const data = await fetchRelease({ versionId: null });
  assert.equal(data.version, null);
  assert.deepEqual(data.versions, []);
  assert.deepEqual(data.tickets, []);
  assert.equal(callsOf(calls, 'search').length, 0);
});

const withEnvironment = (t, name, value) => {
  process.env[name] = value;
  t.after(() => {
    delete process.env[name];
  });
};

const searchedJql = (calls) =>
  callsOf(calls, 'search').map((call) => call.url.searchParams.get('jql'));
const nameOfSprintTwenty = 'EZAT | Sprint 20.0 | 10/23/26';
const duplicateNameVersions = [
  ...rawVersions,
  jiraVersion('18839', nameOfSprintTwenty, { releaseDate: '2026-10-24' }),
];

test('a version name that matches exactly one version is resolved to its id and never reaches the JQL', async (t) => {
  const { fetchRelease, calls } = await startRelease(t, threeTicketRelease());
  const data = await fetchRelease({
    versionId: null,
    versionName: 'EZAT | Sprint 19.0 | 10/09/26',
  });
  assert.equal(data.version.id, '18741');
  assert.deepEqual(searchedJql(calls), [
    'fixVersion = 18741 AND assignee = currentUser() ORDER BY key ASC',
  ]);
});

test('a version name shared by two versions is rejected with status hint 400 before any search', async (t) => {
  const { fetchRelease, calls } = await startRelease(
    t,
    standardHandlers({ versions: duplicateNameVersions }),
  );
  await assert.rejects(
    fetchRelease({ versionId: null, versionName: nameOfSprintTwenty }),
    (error) => error?.statusHint === 400,
  );
  assert.equal(callsOf(calls, 'search').length, 0);
});

test('an unknown version name, or a name carrying JQL, is rejected with status hint 400 before any search', async (t) => {
  const { fetchRelease, calls } = await startRelease(t, threeTicketRelease());
  for (const versionName of [
    'EZAT | Sprint 99.0 | 01/01/27',
    'EZAT | Sprint 19.0 | 10/09/26" OR project = X',
  ]) {
    await assert.rejects(
      fetchRelease({ versionId: null, versionName }),
      (error) => error?.statusHint === 400,
      versionName,
    );
  }
  assert.equal(callsOf(calls, 'search').length, 0);
});

test('a project key from the environment is validated when a request runs, so an invalid one does not stop the import and sends nothing', async (t) => {
  withEnvironment(t, 'JIRA_RELEASES_PROJECT', 'bad key!');
  const { fetchRelease, calls } = await startRelease(t, threeTicketRelease(), {
    specifier: '../backend/releases.mjs?invalid-project-key',
  });
  await assert.rejects(fetchRelease(), /JIRA_RELEASES_PROJECT/);
  assert.equal(calls.length, 0);
});

test('a ticket whose id is not digits is unavailable with prsError http and never reaches a dev-status URL', async (t) => {
  const issues = [
    issue('38010', 'DEMO-1058'),
    issue('38052/../admin', 'DEMO-1100'),
    issue('39151', 'DEMO-1398'),
  ];
  const devStatus = {
    38010: { count: 1, detail: [detailEntry([mileageOpenBackend])] },
    39151: { count: 0, detail: [detailEntry([])] },
  };
  const { fetchRelease, calls } = await startRelease(t, standardHandlers({ issues, devStatus }));
  const data = await fetchRelease();
  const bad = data.tickets.find((ticket) => ticket.key === 'DEMO-1100');
  assert.equal(bad.mergeState, 'unavailable');
  assert.equal(bad.prsStatus, 'unavailable');
  assert.equal(bad.prsError, 'http');
  assert.deepEqual(bad.prs, []);
  assert.deepEqual(
    data.tickets.map((ticket) => ticket.prsStatus),
    ['ok', 'unavailable', 'ok'],
  );
  const devStatusCalls = [...callsOf(calls, 'summary'), ...callsOf(calls, 'detail')];
  assert.equal(
    devStatusCalls.some(
      (call) => call.url.href.includes('admin') || call.url.href.includes('38052'),
    ),
    false,
  );
});

test('a stalled dev-status call is cut off by a 15 second signal and its ticket reads unavailable with prsError timeout', async (t) => {
  const stalledUntilAborted = (signal) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  const issues = [issue('39151', 'DEMO-1398'), issue('39160', 'DEMO-1400')];
  const devStatus = {
    39151: {
      count: 1,
      detail: [
        detailEntry([
          rawPr({
            number: 2081,
            repo: tracker,
            title: '[DEMO-1398] Gate export',
            status: 'OPEN',
            head: 'DEMO-1398/gate',
          }),
        ]),
      ],
    },
    39160: { count: 1, detail: [] },
  };
  const standard = standardHandlers({ issues, devStatus });
  const handlers = {
    ...standard,
    detail: (url, init) =>
      url.searchParams.get('issueId') === '39160'
        ? stalledUntilAborted(init.signal)
        : standard.detail(url, init),
  };
  const { fetchRelease } = await startRelease(t, handlers);
  const requestedTimeouts = [];
  t.mock.method(AbortSignal, 'timeout', (milliseconds) => {
    requestedTimeouts.push(milliseconds);
    const controller = new AbortController();
    setImmediate(() =>
      controller.abort(
        new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
      ),
    );
    return controller.signal;
  });
  const data = await fetchRelease();
  assert.equal(data.tickets[0].prsStatus, 'ok');
  const stalled = data.tickets[1];
  assert.equal(stalled.mergeState, 'unavailable');
  assert.equal(stalled.prsStatus, 'unavailable');
  assert.equal(stalled.prsError, 'timeout');
  assert.ok(requestedTimeouts.length >= 4, 'every Jira call carries a timeout signal');
  assert.ok(
    requestedTimeouts.every((milliseconds) => milliseconds === 15_000),
    JSON.stringify(requestedTimeouts),
  );
});

const underscoreProject = 'MY_PROJ';

test('with an underscore project key from the environment each ticket keeps the PRs that name its key', async (t) => {
  withEnvironment(t, 'JIRA_RELEASES_PROJECT', underscoreProject);
  const issues = [issue('38010', 'MY_PROJ-12')];
  const titleOwned = rawPr({
    number: 77,
    repo: tracker,
    title: '[MY_PROJ-12] Rename the column',
    status: 'OPEN',
    head: 'feature/rename',
  });
  const branchOwned = rawPr({
    number: 78,
    repo: frontend,
    title: 'Rename the column',
    status: 'OPEN',
    head: 'MY_PROJ-12/rename-column',
  });
  const lookalike = rawPr({
    number: 79,
    repo: backend,
    title: '[MY_PROJ-120] Other work',
    status: 'OPEN',
    head: 'MY_PROJ-120/other',
  });
  const devStatus = {
    38010: { count: 3, detail: [detailEntry([titleOwned, branchOwned, lookalike])] },
  };
  const { fetchRelease } = await startRelease(t, standardHandlers({ issues, devStatus }), {
    specifier: '../backend/releases.mjs?underscore-project-key',
    projectKey: underscoreProject,
  });
  const [ticket] = (await fetchRelease()).tickets;
  assert.equal(ticket.mergeState, 'open');
  assert.deepEqual(prIds(ticket), [
    'TransActComm/Portage-frontend#78',
    'TransActComm/TravelTracker#77',
  ]);
});
