import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as jira from '../backend/jira.mjs';
import { createHttpHandler } from '../backend/http-app.mjs';
import { listenHttp, requestRaw } from './http-test-fixture.mjs';
import { settingsFixture, accept } from './settings-fixture.mjs';

const SPRINT_FIELD = 'customfield_101';
const POINTS_FIELD = 'customfield_102';
const OPEN_JQL = 'sprint in openSprints() ORDER BY updated DESC';
const CLOSED_JQL = 'sprint in closedSprints() ORDER BY updated DESC';

const sprint = (id, name, state, startDate = null, endDate = null) => ({
  id,
  name,
  state,
  boardId: 1,
  startDate,
  endDate,
});

const NEXUS_17 = sprint(
  4017,
  'Nexus Sprint 17',
  'active',
  '2026-11-09T00:00:00.000Z',
  '2026-11-20T00:00:00.000Z',
);
const NEXUS_18 = sprint(4018, 'Nexus Sprint 18', 'future');
const NEXUS_19 = sprint(
  4019,
  'Nexus Sprint 19',
  'future',
  '2026-11-23T00:00:00.000Z',
  '2026-12-04T00:00:00.000Z',
);
const NEXUS_20 = sprint(
  4020,
  'Nexus Sprint 20',
  'future',
  '2026-12-07T00:00:00.000Z',
  '2026-12-18T00:00:00.000Z',
);
const NEXUS_21 = sprint(4021, 'Nexus Sprint 21', 'future');
const nexusClosed = (number, startDate, endDate) =>
  sprint(4000 + number, `Nexus Sprint ${number}`, 'closed', startDate, endDate);
const NEXUS_12 = nexusClosed(12, '2026-09-14T00:00:00.000Z', '2026-09-25T00:00:00.000Z');
const NEXUS_13 = nexusClosed(13, '2026-09-28T00:00:00.000Z', '2026-10-09T00:00:00.000Z');
const NEXUS_14 = nexusClosed(14, '2026-10-12T00:00:00.000Z', '2026-10-23T00:00:00.000Z');
const NEXUS_15 = nexusClosed(15, '2026-10-26T00:00:00.000Z', '2026-11-06T00:00:00.000Z');
const NEXUS_16 = nexusClosed(16, '2026-10-27T00:00:00.000Z', '2026-11-07T00:00:00.000Z');
const ORION_3 = sprint(
  5003,
  'Orion Sprint 3',
  'active',
  '2026-11-02T00:00:00.000Z',
  '2026-11-13T00:00:00.000Z',
);

const sprintIssue = (key, sprints) => ({ key, fields: { [SPRINT_FIELD]: sprints } });

const OPEN_ISSUES = [
  sprintIssue('ORB-1', [ORION_3]),
  sprintIssue('NEX-1', [NEXUS_16, NEXUS_17]),
  sprintIssue('NEX-2', [NEXUS_18]),
  sprintIssue('NEX-3', [NEXUS_17]),
  sprintIssue('NEX-8', [NEXUS_21, NEXUS_20, NEXUS_19]),
];
const CLOSED_ISSUES = [
  sprintIssue('NEX-4', [NEXUS_13]),
  sprintIssue('NEX-5', [NEXUS_15, NEXUS_12]),
  sprintIssue('NEX-6', [NEXUS_14]),
  sprintIssue('NEX-7', [NEXUS_16]),
];

async function configured(t) {
  const { clearSprintBoardCaches } = await import('../backend/sprint-board.mjs');
  clearSprintBoardCaches();
  t.after(() => clearSprintBoardCaches());
  const fixture = settingsFixture(t);
  const settings = await fixture.store();
  await accept(fixture, settings);
  const handler = createHttpHandler({
    settings,
    manager: { list: () => [], applySettings() {} },
    integrations: { log: () => {} },
  });
  const { origin } = await listenHttp(t, handler);
  return origin;
}

// A Jira answering each search JQL from `answers` (a list of issues, paged by `maxResults`) and,
// with `agile`, the Agile board and sprint lists: `agile.boards` is the board list and
// `agile.sprints[boardId]` a board's sprints, oldest first as Jira lists them. Without `agile` the
// board list is a 404, so the list falls back to the scan; `boardListHeaders` go on that refusal.
// `agile.status[boardId]` is the status a board's sprint reads answer with, and `noTotal` leaves
// `total` out of every sprint page. Returns the searches it is asked, with every Agile request under
// `.agile` and the most Agile requests at once under `.agilePeak`.
function fakeJira(
  t,
  answers,
  {
    status = 200,
    agile = null,
    boardListStatus = 404,
    boardListHeaders = {},
    noTotal = false,
  } = {},
) {
  const searches = [];
  // Not enumerable, so a deepEqual of the searches still compares the JQL list alone.
  const agileCalls = [];
  let agilePeak = 0;
  Object.defineProperty(searches, 'agile', { value: agileCalls });
  Object.defineProperty(searches, 'agilePeak', { get: () => agilePeak });
  let inFlight = 0;
  const page = (list, url, { withTotal = true } = {}) => {
    const startAt = Number(url.searchParams.get('startAt') || 0);
    const size = Math.min(Number(url.searchParams.get('maxResults') || 50), 50);
    const values = list.slice(startAt, startAt + size);
    return Response.json({
      maxResults: size,
      startAt,
      ...(withTotal ? { total: list.length } : {}),
      isLast: startAt + size >= list.length,
      values,
    });
  };
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    if (url.pathname.startsWith('/rest/agile/1.0/')) {
      agileCalls.push(`${url.pathname}${url.search}`);
      if (status !== 200) return new Response('nope', { status });
      if (url.pathname === '/rest/agile/1.0/board') {
        if (!agile)
          return new Response('nope', { status: boardListStatus, headers: boardListHeaders });
        assert.equal(url.searchParams.get('type'), 'scrum');
        return page(agile.boards, url);
      }
      const match = url.pathname.match(/^\/rest\/agile\/1\.0\/board\/(\d+)\/sprint$/);
      assert.ok(match, `unexpected Agile path ${url.pathname}`);
      inFlight += 1;
      agilePeak = Math.max(agilePeak, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      const refused = agile.status?.[match[1]];
      if (refused) return new Response('nope', { status: refused });
      const states = (url.searchParams.get('state') || '').split(',');
      const list = (agile.sprints[match[1]] || []).filter((each) => states.includes(each.state));
      return page(list, url, { withTotal: !noTotal });
    }
    assert.equal(url.pathname, '/rest/api/3/search/jql');
    const jql = url.searchParams.get('jql');
    searches.push(jql);
    if (status !== 200) return new Response('nope', { status });
    const issues = answers[jql] || [];
    const start = Number(url.searchParams.get('nextPageToken') || 0);
    const size = Number(url.searchParams.get('maxResults') || 50);
    const end = start + size;
    const last = end >= issues.length;
    return Response.json({
      issues: issues.slice(start, end),
      isLast: last,
      ...(last ? {} : { nextPageToken: String(end) }),
    });
  });
  return searches;
}

const board = (id, name) => ({ id, name, type: 'scrum' });
// Nexus on its own board, oldest closed first; a second board holds Nexus Sprint 17 too.
const AGILE = {
  boards: [board(11, 'Nexus board'), board(12, 'Orion board'), board(13, 'Shared board')],
  sprints: {
    11: [
      NEXUS_12,
      NEXUS_13,
      NEXUS_14,
      NEXUS_15,
      NEXUS_16,
      NEXUS_17,
      NEXUS_18,
      NEXUS_19,
      NEXUS_20,
      NEXUS_21,
    ],
    12: [ORION_3],
    13: [NEXUS_17],
  },
};

const get = (origin, pathname, headers) =>
  requestRaw(origin, pathname, {
    headers,
    timeout: 2000,
    timeoutMessage: 'sprint board request timed out',
  });

const EXPECTED_TEAMS = [
  {
    name: 'Nexus',
    sprints: [
      {
        id: 4017,
        name: 'Nexus Sprint 17',
        state: 'active',
        startDate: '2026-11-09T00:00:00.000Z',
        endDate: '2026-11-20T00:00:00.000Z',
      },
      {
        id: 4019,
        name: 'Nexus Sprint 19',
        state: 'future',
        startDate: '2026-11-23T00:00:00.000Z',
        endDate: '2026-12-04T00:00:00.000Z',
      },
      {
        id: 4020,
        name: 'Nexus Sprint 20',
        state: 'future',
        startDate: '2026-12-07T00:00:00.000Z',
        endDate: '2026-12-18T00:00:00.000Z',
      },
      { id: 4018, name: 'Nexus Sprint 18', state: 'future', startDate: null, endDate: null },
      { id: 4021, name: 'Nexus Sprint 21', state: 'future', startDate: null, endDate: null },
      {
        id: 4016,
        name: 'Nexus Sprint 16',
        state: 'closed',
        startDate: '2026-10-27T00:00:00.000Z',
        endDate: '2026-11-07T00:00:00.000Z',
      },
      {
        id: 4015,
        name: 'Nexus Sprint 15',
        state: 'closed',
        startDate: '2026-10-26T00:00:00.000Z',
        endDate: '2026-11-06T00:00:00.000Z',
      },
      {
        id: 4014,
        name: 'Nexus Sprint 14',
        state: 'closed',
        startDate: '2026-10-12T00:00:00.000Z',
        endDate: '2026-10-23T00:00:00.000Z',
      },
    ],
  },
  {
    name: 'Orion',
    sprints: [
      {
        id: 5003,
        name: 'Orion Sprint 3',
        state: 'active',
        startDate: '2026-11-02T00:00:00.000Z',
        endDate: '2026-11-13T00:00:00.000Z',
      },
    ],
  },
];

test('sprint list reads the Agile boards: by team, active, future nearest first, the newest three closed, each sprint once', async (t) => {
  const origin = await configured(t);
  const searches = fakeJira(t, {}, { agile: AGILE });
  const response = await get(origin, '/api/sprints');
  assert.equal(response.status, 200);
  const body = JSON.parse(response.text);
  assert.deepEqual(body.teams, EXPECTED_TEAMS);
  assert.equal(body.truncated, false);
  assert.ok(Number.isFinite(Date.parse(body.updatedAt)), 'updatedAt is a timestamp');
  assert.deepEqual(searches, [], 'no issue scan runs');
  // One board list, then per board one open read and one closed read, all its closed fitting a page.
  assert.equal(searches.agile.length, 1 + AGILE.boards.length * 2);
});

test('closed sprints past one page: only the first and the last page are read, for the newest three', async (t) => {
  const origin = await configured(t);
  const closed = Array.from({ length: 120 }, (_, i) =>
    nexusClosed(
      i + 1,
      new Date(Date.UTC(2022, 0, 1 + i * 14)).toISOString(),
      new Date(Date.UTC(2022, 0, 12 + i * 14)).toISOString(),
    ),
  );
  const searches = fakeJira(
    t,
    {},
    { agile: { boards: [board(11, 'Nexus board')], sprints: { 11: closed } } },
  );
  const body = JSON.parse((await get(origin, '/api/sprints')).text);
  assert.deepEqual(
    body.teams[0].sprints.map(({ id }) => id),
    [4120, 4119, 4118],
  );
  assert.equal(body.truncated, false);
  const closedReads = searches.agile.filter((path) => path.includes('state=closed'));
  assert.equal(closedReads.length, 2, 'the first page, then the last page by total');
  assert.match(closedReads[1], /startAt=70\b/);
});

test('board reads are bounded: at most 20 boards, three at a time, and a capped list is truncated', async (t) => {
  const origin = await configured(t);
  const boards = Array.from({ length: 25 }, (_, i) => board(100 + i, `Board ${i}`));
  const sprints = Object.fromEntries(
    boards.map(({ id }, i) => [id, [sprint(6000 + i, `Team${i} Sprint 1`, 'active')]]),
  );
  const searches = fakeJira(t, {}, { agile: { boards, sprints } });
  const body = JSON.parse((await get(origin, '/api/sprints')).text);
  assert.equal(body.truncated, true);
  assert.equal(body.teams.length, 20);
  const boardReads = new Set(
    searches.agile.map((path) => path.match(/board\/(\d+)\/sprint/)?.[1]).filter(Boolean),
  );
  assert.equal(boardReads.size, 20, 'boards past the cap are never read');
  assert.ok(
    searches.agilePeak <= 3,
    `at most three board reads at once, saw ${searches.agilePeak}`,
  );
  assert.ok(searches.agilePeak > 1, 'board reads overlap');
});

test('a board list Jira refuses with 401, 403 or 404 falls back to the issue scan; a rate limit does not', async (t) => {
  for (const boardListStatus of [401, 403, 404]) {
    const origin = await configured(t);
    t.mock.restoreAll();
    const searches = fakeJira(
      t,
      { [OPEN_JQL]: OPEN_ISSUES, [CLOSED_JQL]: CLOSED_ISSUES },
      { boardListStatus },
    );
    const response = await get(origin, '/api/sprints');
    assert.equal(response.status, 200, `status after a ${boardListStatus}`);
    assert.deepEqual(
      JSON.parse(response.text).teams,
      EXPECTED_TEAMS,
      `teams after ${boardListStatus}`,
    );
    assert.deepEqual([...searches].sort(), [CLOSED_JQL, OPEN_JQL]);
  }

  const origin = await configured(t);
  t.mock.restoreAll();
  const searches = fakeJira(t, {}, { boardListStatus: 429 });
  const response = await get(origin, '/api/sprints');
  assert.equal(response.status, 502);
  assert.deepEqual(searches, [], 'a rate-limited board list runs no scan');

  // A 403 that says it is a rate limit is not a refusal the scan can cover. No retry time, so no
  // cool-down outlives this test.
  const limitedOrigin = await configured(t);
  t.mock.restoreAll();
  const limited = fakeJira(
    t,
    {},
    { boardListStatus: 403, boardListHeaders: { 'x-ratelimit-remaining': '0' } },
  );
  const limitedResponse = await get(limitedOrigin, '/api/sprints');
  assert.equal(limitedResponse.status, 502);
  assert.deepEqual(limited, [], 'a rate-limited 403 runs no scan');
});

test('a board whose sprint reads are refused with 400, 403 or 404 is skipped and the list is truncated', async (t) => {
  for (const refused of [400, 403, 404]) {
    const origin = await configured(t);
    t.mock.restoreAll();
    fakeJira(t, {}, { agile: { ...AGILE, status: { 12: refused } } });
    const response = await get(origin, '/api/sprints');
    assert.equal(response.status, 200, `status with a board answering ${refused}`);
    const body = JSON.parse(response.text);
    assert.equal(body.truncated, true, `truncated after ${refused}`);
    assert.deepEqual(
      body.teams.map(({ name }) => name),
      ['Nexus'],
      `the other boards are still listed after ${refused}`,
    );
  }
});

test('a board read that fails stops the other board reads: the reply is 502 and the rest are never asked', async (t) => {
  const origin = await configured(t);
  const boards = Array.from({ length: 10 }, (_, i) => board(100 + i, `Board ${i}`));
  const sprints = Object.fromEntries(
    boards.map(({ id }, i) => [id, [sprint(6000 + i, `Team${i} Sprint 1`, 'active')]]),
  );
  const searches = fakeJira(t, {}, { agile: { boards, sprints, status: { 100: 500 } } });
  const response = await get(origin, '/api/sprints');
  assert.equal(response.status, 502);
  // Let any worker still running finish, then count: the two other workers end the board they
  // are on (two reads each) and start no other.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const boardReads = searches.agile.filter((path) => /board\/\d+\/sprint/.test(path));
  assert.ok(boardReads.length <= 5, `board reads after the failure: ${boardReads.length}`);
});

test('closed sprints without a total are paged forward, at most four pages, truncated only at the cap', async (t) => {
  const closedOf = (count) =>
    Array.from({ length: count }, (_, i) =>
      nexusClosed(
        i + 1,
        new Date(Date.UTC(2020, 0, 1 + i * 14)).toISOString(),
        new Date(Date.UTC(2020, 0, 12 + i * 14)).toISOString(),
      ),
    );
  const read = async (count) => {
    const origin = await configured(t);
    t.mock.restoreAll();
    const searches = fakeJira(
      t,
      {},
      {
        agile: { boards: [board(11, 'Nexus board')], sprints: { 11: closedOf(count) } },
        noTotal: true,
      },
    );
    const body = JSON.parse((await get(origin, '/api/sprints')).text);
    const closedReads = searches.agile.filter((path) => path.includes('state=closed'));
    return { body, closedReads };
  };

  const within = await read(120);
  assert.deepEqual(
    within.body.teams[0].sprints.map(({ id }) => id),
    [4120, 4119, 4118],
  );
  assert.equal(within.body.truncated, false);
  assert.equal(within.closedReads.length, 3, 'pages at 0, 50 and 100');
  assert.match(within.closedReads[2], /startAt=100\b/);

  const capped = await read(250);
  assert.equal(capped.closedReads.length, 4, 'no read past the fourth page');
  assert.equal(capped.body.truncated, true);
});

test('the issue scan groups sprints by team: active, future nearest first, then the newest three closed', async (t) => {
  const origin = await configured(t);
  fakeJira(t, { [OPEN_JQL]: OPEN_ISSUES, [CLOSED_JQL]: CLOSED_ISSUES });
  const response = await get(origin, '/api/sprints');
  assert.equal(response.status, 200);
  const body = JSON.parse(response.text);
  assert.deepEqual(body.teams, [
    {
      name: 'Nexus',
      sprints: [
        {
          id: 4017,
          name: 'Nexus Sprint 17',
          state: 'active',
          startDate: '2026-11-09T00:00:00.000Z',
          endDate: '2026-11-20T00:00:00.000Z',
        },
        {
          id: 4019,
          name: 'Nexus Sprint 19',
          state: 'future',
          startDate: '2026-11-23T00:00:00.000Z',
          endDate: '2026-12-04T00:00:00.000Z',
        },
        {
          id: 4020,
          name: 'Nexus Sprint 20',
          state: 'future',
          startDate: '2026-12-07T00:00:00.000Z',
          endDate: '2026-12-18T00:00:00.000Z',
        },
        { id: 4018, name: 'Nexus Sprint 18', state: 'future', startDate: null, endDate: null },
        { id: 4021, name: 'Nexus Sprint 21', state: 'future', startDate: null, endDate: null },
        {
          id: 4016,
          name: 'Nexus Sprint 16',
          state: 'closed',
          startDate: '2026-10-27T00:00:00.000Z',
          endDate: '2026-11-07T00:00:00.000Z',
        },
        {
          id: 4015,
          name: 'Nexus Sprint 15',
          state: 'closed',
          startDate: '2026-10-26T00:00:00.000Z',
          endDate: '2026-11-06T00:00:00.000Z',
        },
        {
          id: 4014,
          name: 'Nexus Sprint 14',
          state: 'closed',
          startDate: '2026-10-12T00:00:00.000Z',
          endDate: '2026-10-23T00:00:00.000Z',
        },
      ],
    },
    {
      name: 'Orion',
      sprints: [
        {
          id: 5003,
          name: 'Orion Sprint 3',
          state: 'active',
          startDate: '2026-11-02T00:00:00.000Z',
          endDate: '2026-11-13T00:00:00.000Z',
        },
      ],
    },
  ]);
  assert.equal(body.truncated, false);
  assert.ok(Number.isFinite(Date.parse(body.updatedAt)), 'updatedAt is a timestamp');
});

test('the fallback scan is truncated when the open-sprint scan hits its 300-issue cap', async (t) => {
  const origin = await configured(t);
  const many = Array.from({ length: 301 }, (_, i) => sprintIssue(`NEX-${100 + i}`, [NEXUS_17]));
  fakeJira(t, { [OPEN_JQL]: many, [CLOSED_JQL]: CLOSED_ISSUES });
  const response = await get(origin, '/api/sprints');
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.text).truncated, true);
});

test('sprint caches are kept per Jira account, so another account on the same site asks again', async (t) => {
  const { clearSprintBoardCaches, fetchSprintList, fetchSprintTickets } =
    await import('../backend/sprint-board.mjs');
  clearSprintBoardCaches();
  t.after(() => clearSprintBoardCaches());
  const searches = fakeJira(t, { [OPEN_JQL]: OPEN_ISSUES, [CLOSED_JQL]: CLOSED_ISSUES });
  const account = (email) => ({
    jira: {
      baseUrl: 'https://jira.example.invalid',
      email,
      sprintField: SPRINT_FIELD,
      pointsField: POINTS_FIELD,
    },
    credentials: { jiraToken: 'not-a-real-token' },
  });
  for (const email of ['first@example.invalid', 'second@example.invalid']) {
    await fetchSprintList({ snapshot: account(email) });
    await fetchSprintTickets('17', { snapshot: account(email) });
  }
  assert.equal(searches.length, 6, 'each account runs its own two list scans and one ticket read');
});

test('fetchSprintTickets refuses a bad sprint id itself, before any Jira call', (t) => {
  const searches = fakeJira(t, {});
  return import('../backend/sprint-board.mjs').then(({ fetchSprintTickets }) => {
    for (const bad of ['17 OR 1=1', '0', 'abc', '']) {
      assert.throws(() => fetchSprintTickets(bad), { code: 'INVALID_SPRINT', status: 400 }, bad);
    }
    assert.deepEqual(searches, []);
  });
});

test('sprint list cache: a repeat within five minutes asks Jira nothing, past it Jira is searched again', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const origin = await configured(t);
  const searches = fakeJira(t, { [OPEN_JQL]: OPEN_ISSUES, [CLOSED_JQL]: CLOSED_ISSUES });
  assert.equal((await get(origin, '/api/sprints')).status, 200);
  assert.deepEqual([...searches].sort(), [CLOSED_JQL, OPEN_JQL]);

  t.mock.timers.tick(299_999);
  assert.equal((await get(origin, '/api/sprints')).status, 200);
  assert.equal(searches.length, 2, 'a read within the five minutes makes no Jira call');

  t.mock.timers.tick(2);
  assert.equal((await get(origin, '/api/sprints')).status, 200);
  assert.deepEqual(
    searches.slice(2).sort(),
    [CLOSED_JQL, OPEN_JQL],
    'past the TTL both searches run',
  );
});

test('sprint tickets carry the assignee beside every My Tickets field', async (t) => {
  const origin = await configured(t);
  const ticketSprint = sprint(
    17,
    'Nexus Sprint 17',
    'active',
    '2026-11-09T00:00:00.000Z',
    '2026-11-20T00:00:00.000Z',
  );
  const issue = (key, id, summary, assignee, points) => ({
    key,
    id,
    fields: {
      summary,
      status: { name: 'In Progress', statusCategory: { name: 'In Progress' } },
      issuetype: { name: 'Story' },
      priority: { name: 'Medium' },
      updated: '2026-11-12T09:00:00.000+0000',
      created: '2026-11-03T09:00:00.000+0000',
      assignee: assignee ? { displayName: assignee, accountId: 'acct-1' } : null,
      [SPRINT_FIELD]: [ticketSprint],
      [POINTS_FIELD]: points,
    },
  });
  const searches = fakeJira(t, {
    'sprint = 17 ORDER BY updated DESC': [
      issue('A-1', '10001', 'Add an export button', 'Sam Sample', 3),
      issue('A-2', '10002', 'Tidy the settings form', null, 2),
      issue('A-3', '10003', 'Rename the report tab', 'Robin Placeholder', null),
    ],
  });
  const response = await get(origin, '/api/sprint-tickets?sprint=17');
  assert.equal(response.status, 200);
  assert.deepEqual(searches, ['sprint = 17 ORDER BY updated DESC']);
  const body = JSON.parse(response.text);
  const expectedSprint = {
    id: 17,
    name: 'Nexus Sprint 17',
    state: 'active',
    startDate: '2026-11-09T00:00:00.000Z',
    endDate: '2026-11-20T00:00:00.000Z',
  };
  const expected = (key, id, summary, assignee, storyPoints) => ({
    key,
    id,
    summary,
    status: 'In Progress',
    statusCategory: 'In Progress',
    issueType: 'Story',
    priority: 'Medium',
    updated: '2026-11-12T09:00:00.000+0000',
    created: '2026-11-03T09:00:00.000+0000',
    sprints: [expectedSprint],
    sprint: expectedSprint,
    storyPoints,
    assignee,
  });
  assert.deepEqual(body.tickets, [
    expected('A-1', '10001', 'Add an export button', 'Sam Sample', 3),
    expected('A-2', '10002', 'Tidy the settings form', null, 2),
    expected('A-3', '10003', 'Rename the report tab', 'Robin Placeholder', null),
  ]);
  assert.equal(body.total, 3);
  assert.equal(body.truncated, false);
  assert.ok(Number.isFinite(Date.parse(body.updatedAt)), 'updatedAt is a timestamp');
});

test('invalid sprint ids are refused with INVALID_SPRINT before any Jira call', async (t) => {
  const origin = await configured(t);
  const searches = fakeJira(t, {});
  for (const query of [
    '',
    '?sprint=abc',
    '?sprint=0',
    `?sprint=${encodeURIComponent('17 OR 1=1')}`,
  ]) {
    const response = await get(origin, `/api/sprint-tickets${query}`);
    assert.equal(response.status, 400, `status for "${query}"`);
    assert.equal(JSON.parse(response.text).code, 'INVALID_SPRINT', `code for "${query}"`);
  }
  assert.deepEqual(searches, [], 'no bad id reaches Jira');
});

test('sprint routes refuse: a Jira failure is 502 UPSTREAM_FAILED, a cross-site read is 403 with no Jira call', async (t) => {
  const origin = await configured(t);
  const routes = ['/api/sprints', '/api/sprint-tickets?sprint=17'];
  const crossSiteSearches = fakeJira(t, {});
  for (const route of routes) {
    for (const site of ['cross-site', 'same-site']) {
      const response = await get(origin, route, { 'Sec-Fetch-Site': site });
      assert.equal(response.status, 403, `${site} ${route}`);
    }
  }
  assert.deepEqual(crossSiteSearches, [], 'a cross-site read reaches no Jira');

  t.mock.restoreAll();
  fakeJira(t, {}, { status: 500 });
  for (const route of routes) {
    const response = await get(origin, route);
    assert.equal(response.status, 502, `Jira failure on ${route}`);
    assert.equal(JSON.parse(response.text).code, 'UPSTREAM_FAILED', `code on ${route}`);
  }
});

test('sprint tickets cache: a repeat within 30 s asks Jira nothing, and 250 issues are capped at 200', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const origin = await configured(t);
  const many = Array.from({ length: 250 }, (_, i) => ({
    key: `CAP-${i + 1}`,
    id: String(20000 + i),
    fields: { summary: `Capped ticket ${i + 1}`, status: { name: 'To Do' } },
  }));
  const searches = fakeJira(t, {
    'sprint = 17 ORDER BY updated DESC': [
      { key: 'A-1', id: '10001', fields: { summary: 'Add an export button' } },
    ],
    'sprint = 18 ORDER BY updated DESC': many,
  });
  assert.equal((await get(origin, '/api/sprint-tickets?sprint=17')).status, 200);
  const first = searches.length;
  assert.ok(first > 0, 'the first read searches Jira');
  t.mock.timers.tick(29_999);
  assert.equal((await get(origin, '/api/sprint-tickets?sprint=17')).status, 200);
  assert.equal(searches.length, first, 'a read within 30 s makes no Jira call');

  const capped = await get(origin, '/api/sprint-tickets?sprint=18');
  assert.equal(capped.status, 200);
  const body = JSON.parse(capped.text);
  assert.equal(body.tickets.length, 200);
  assert.equal(body.tickets[0].key, 'CAP-1');
  assert.equal(body.tickets[199].key, 'CAP-200');
  assert.equal(body.truncated, true);
});

test('mapTicketIssue keys are the My Tickets keys, unchanged by the export', () => {
  assert.equal(typeof jira.mapTicketIssue, 'function', 'mapTicketIssue is exported');
  const mapped = jira.mapTicketIssue(
    { key: 'A-1', id: '10001', fields: { summary: 'Add an export button' } },
    { sprintField: SPRINT_FIELD, pointsField: POINTS_FIELD },
  );
  assert.deepEqual(
    Object.keys(mapped).sort(),
    [
      'key',
      'id',
      'summary',
      'status',
      'statusCategory',
      'issueType',
      'priority',
      'updated',
      'created',
      'sprints',
      'sprint',
      'storyPoints',
    ].sort(),
  );
});

test('read-only and silent: the sprint board module sends no POST or PUT and logs nothing', () => {
  const source = fs.readFileSync(
    fileURLToPath(new URL('../backend/sprint-board.mjs', import.meta.url)),
    'utf8',
  );
  assert.doesNotMatch(source, /method:\s*['"](POST|PUT)['"]/, 'no Jira write');
  assert.ok(!source.includes('console.'), 'no console output');
});
