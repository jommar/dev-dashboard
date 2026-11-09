import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildHomeVelocity, fetchHomeVelocity } from '../backend/home-velocity.mjs';
import { freeze } from '../backend/settings.mjs';
import { assertNoSecrets, githubToken, jiraToken } from './settings-fixture.mjs';

const snapshot = freeze({
  jira: {
    baseUrl: 'https://velocity.example.invalid',
    email: 'velocity@example.invalid',
    sprintField: 'customfield_201',
    pointsField: 'customfield_202',
  },
  credentials: { githubToken, jiraToken },
});
const sprint = (id = 1, name = 'Nexus Sprint 1', state = 'closed', endDate = null) => ({
  id,
  name,
  state,
  endDate,
});
const issue = (key, points, sprints = [sprint()], category = 'Done', updated) => ({
  key,
  fields: {
    updated,
    status: { statusCategory: { name: category } },
    [snapshot.jira.sprintField]: sprints,
    [snapshot.jira.pointsField]: points,
  },
});
const build = (issues) => buildHomeVelocity(issues, { snapshot });
const firstEntry = (issues) => build(issues).boards[0].series[0];
const personId = (accountId) =>
  `person:${createHash('sha256').update(`accountId:${accountId}`).digest('hex')}`;
const nameId = (displayName) =>
  `name:${createHash('sha256').update(`displayName:${displayName}`).digest('hex')}`;
const assigned = (row, assignee) => ({ ...row, fields: { ...row.fields, assignee } });
const aggregateEntry = (sprint, points = 0, count = 0, unestimated = 0, byStatus = {}) => ({
  sprint,
  points,
  count,
  unestimated,
  byStatus: { done: 0, inProgress: 0, notStarted: 0, ...byStatus },
});

function assertPeopleReconcile(board) {
  assert.ok(Array.isArray(board.people), 'people is a required array');
  for (const person of board.people) {
    assert.deepEqual(Object.keys(person).sort(), ['displayName', 'id', 'series']);
    assert.deepEqual(
      person.series.map(({ sprint }) => sprint),
      board.series.map(({ sprint }) => sprint),
      'every person uses the exact team sprint window, order and metadata',
    );
  }
  for (const [index, entry] of board.series.entries()) {
    for (const field of ['points', 'count', 'unestimated']) {
      const total = board.people.reduce((sum, person) => sum + person.series[index][field], 0);
      assert.ok(Math.abs(total - entry[field]) < 1e-10, `${entry.sprint.name}: ${field}`);
    }
    for (const status of ['done', 'inProgress', 'notStarted']) {
      const total = board.people.reduce(
        (sum, person) => sum + person.series[index].byStatus[status],
        0,
      );
      assert.ok(
        Math.abs(total - entry.byStatus[status]) < 1e-10,
        `${entry.sprint.name}: ${status}`,
      );
    }
  }
}

test('overlapping issues use their newest version once per distinct carried sprint without mutating inputs', () => {
  const first = sprint(1, 'Nexus Sprint 1', 'closed', '2026-10-01');
  const second = sprint(2, 'Nexus Sprint 2', 'active', '2026-10-15');
  const newer = issue(
    'DEMO-1',
    2.5,
    [first, second, { ...second, id: '2' }],
    'In Progress',
    '2026-11-02T00:00:00Z',
  );
  const older = issue('DEMO-1', 3, [first, second], 'Done', '2026-11-01T00:00:00Z');
  const issues = freeze([newer, older]);
  const before = structuredClone(issues);
  const result = build(issues);
  assert.deepEqual(result.boards, [
    {
      name: 'Nexus',
      series: [first, second].map((sprint) => ({
        sprint,
        points: 2.5,
        count: 1,
        unestimated: 0,
        byStatus: { done: 0, inProgress: 2.5, notStarted: 0 },
      })),
      people: [
        {
          id: 'unassigned',
          displayName: 'Unassigned',
          series: [first, second].map((membership) =>
            aggregateEntry(membership, 2.5, 1, 0, { inProgress: 2.5 }),
          ),
        },
      ],
    },
  ]);
  assert.deepEqual(issues, before);
});

test('later occurrence wins timestamp ties and unknown timestamps', async (t) => {
  for (const [label, updated] of [
    ['equal valid dates', '2026-11-01T00:00:00Z'],
    ['invalid dates', 'not-a-date'],
    ['missing dates', undefined],
  ]) {
    await t.test(label, () => {
      const board = build([
        assigned(issue('DEMO-1', 3, [sprint()], 'Done', updated), {
          accountId: 'earlier-owner',
          displayName: 'Earlier',
        }),
        assigned(issue('DEMO-1', 2.5, [sprint()], 'In Progress', updated), {
          accountId: 'later-owner',
          displayName: 'Later',
        }),
      ]).boards[0];
      const entry = board.series[0];
      assert.equal(entry.count, 1);
      assert.equal(entry.points, 2.5);
      assert.deepEqual(entry.byStatus, { done: 0, inProgress: 2.5, notStarted: 0 });
      assert.deepEqual(board.people, [
        {
          id: personId('later-owner'),
          displayName: 'Later',
          series: [aggregateEntry(sprint(), 2.5, 1, 0, { inProgress: 2.5 })],
        },
      ]);
    });
  }
});

test('nonempty keys take precedence over IDs, empty keys fall back to IDs, and identity-less rows remain separate', () => {
  const entry = firstEntry([
    { ...issue('KEY-1', 1), id: 'shared-id' },
    { ...issue('KEY-2', 2), id: 'shared-id' },
    { ...issue('', 4), id: 'fallback-id' },
    { ...issue(undefined, 8), id: 'fallback-id' },
    issue(undefined, 16),
    { ...issue('', 32), id: '' },
  ]);
  assert.equal(entry.count, 5);
  assert.equal(entry.points, 59);
});

test('membership identity falls back to sprint name while preserving nullable IDs and dates', () => {
  const membership = sprint(null, 'Nexus Sprint 3');
  const entry = firstEntry([issue('DEMO-1', 2.5, [membership, { ...membership }])]);
  assert.deepEqual(entry.sprint, membership);
  assert.equal(entry.points, 2.5);
  assert.equal(entry.count, 1);
});

test('status bands preserve fractions and distinguish valid zero from missing or invalid estimates', () => {
  const issues = [
    issue('DONE', 2.5),
    issue('PROGRESS', 1.25, [sprint()], 'In Progress'),
    issue('TODO', 4, [sprint()], 'To Do'),
    issue('UNKNOWN-STATUS', 2, [sprint()], undefined),
    issue('ZERO', 0),
    ...[null, undefined, '5', -1, NaN, Infinity].map((points, index) =>
      issue(`MISSING-${index}`, points),
    ),
  ];
  delete issues[3].fields.status;
  const entry = firstEntry(issues);
  assert.equal(entry.points, 9.75);
  assert.equal(entry.count, 11);
  assert.equal(entry.unestimated, 6);
  assert.deepEqual(entry.byStatus, { done: 2.5, inProgress: 1.25, notStarted: 6 });
  assert.equal(
    Object.values(entry.byStatus).reduce((sum, points) => sum + points, 0),
    entry.points,
  );
  const zero = firstEntry([issue('ZERO', 0)]);
  assert.equal(zero.points, 0);
  assert.equal(zero.unestimated, 0);
  const missing = firstEntry([issue('MISSING', null)]);
  assert.equal(missing.points, 0);
  assert.equal(missing.unestimated, 1);
  assertPeopleReconcile(build(issues).boards[0]);
});

test('teams sort alphabetically and retain only their latest eight active or closed sprints in helper date order', () => {
  const history = Array.from({ length: 9 }, (_, index) =>
    sprint(
      index + 1,
      `Nexus Sprint ${90 - index}`,
      index === 8 ? 'active' : 'closed',
      `2026-10-${String(index + 1).padStart(2, '0')}`,
    ),
  );
  const result = build([
    issue('NEXUS', 1, [...history].reverse()),
    issue('FUTURE', 100, [sprint(100, 'Nexus Sprint 100', 'future', '2027-01-01')]),
    issue('MOBILE', 3, [sprint(20, 'Mobile Sprint 20', 'active', '2026-10-01')]),
  ]);
  assert.equal(result.keep, 8);
  assert.deepEqual(
    result.boards.map(({ name }) => name),
    ['Mobile', 'Nexus'],
  );
  assert.deepEqual(
    result.boards[1].series.map(({ sprint }) => sprint.id),
    [2, 3, 4, 5, 6, 7, 8, 9],
  );
  assert.equal(result.boards[1].series.at(-1).sprint.state, 'active');
});

test('missing and invalid end dates sort oldest, then by name rather than numeric sprint suffix', () => {
  const memberships = [
    sprint(2, 'Nexus Sprint 2', 'closed', null),
    sprint(3, 'Nexus Sprint 3', 'active', '2026-10-01'),
    sprint(10, 'Nexus Sprint 10', 'closed', 'invalid-date'),
  ];
  const result = build([issue('DEMO-1', 1, memberships)]);
  assert.deepEqual(
    result.boards[0].series.map(({ sprint }) => sprint.id),
    [10, 2, 3],
  );
  assert.equal(result.boards[0].series[0].sprint.endDate, 'invalid-date');
  assert.equal(result.boards[0].series[1].sprint.endDate, null);
});

test('adapter emits only plain team/person aggregate JSON, never raw issues, accounts or credentials', () => {
  const privateIssue = issue('PRIVATE-ISSUE-KEY', 2.5, [{ ...sprint(), privateSprint: jiraToken }]);
  privateIssue.fields.assignee = {
    displayName: 'Visible Person',
    accountId: 'PRIVATE-ACCOUNT',
    emailAddress: 'private-person@example.invalid',
    avatarUrls: { '48x48': 'https://private-avatar.example.invalid/person.png' },
    self: 'https://private-account.example.invalid',
  };
  privateIssue.credentials = { githubToken, jiraToken };
  privateIssue.settings = snapshot;
  const result = build([privateIssue]);
  assert.deepEqual(Object.keys(result).sort(), ['boards', 'coverage', 'keep']);
  assert.deepEqual(result.boards, [
    {
      name: 'Nexus',
      series: [
        {
          sprint: sprint(),
          points: 2.5,
          count: 1,
          unestimated: 0,
          byStatus: { done: 2.5, inProgress: 0, notStarted: 0 },
        },
      ],
      people: [
        {
          id: personId('PRIVATE-ACCOUNT'),
          displayName: 'Visible Person',
          series: [aggregateEntry(sprint(), 2.5, 1, 0, { done: 2.5 })],
        },
      ],
    },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  assertNoSecrets(result, [
    'PRIVATE-ISSUE-KEY',
    'PRIVATE-ACCOUNT',
    'private-person@example.invalid',
    'private-avatar.example.invalid',
    'private-account.example.invalid',
    snapshot.jira.email,
    snapshot.jira.baseUrl,
  ]);
});

test('person series use the retained eight team sprints, zero-fill sparse work and exclude only out-of-window people', () => {
  const history = Array.from({ length: 10 }, (_, index) =>
    sprint(
      index + 1,
      `Nexus Sprint ${index + 1}`,
      index === 9 ? 'active' : 'closed',
      `2026-10-${String(index + 1).padStart(2, '0')}`,
    ),
  );
  const board = build([
    assigned(issue('ALL', 1, history), { accountId: 'all', displayName: 'All sprints' }),
    assigned(issue('SPARSE', 2.5, [history[0], history[9]]), {
      accountId: 'sparse',
      displayName: 'Sparse',
    }),
    assigned(issue('OLD', 7, [history[0]]), { accountId: 'old', displayName: 'Old only' }),
    assigned(issue('ZERO', 0, [history[8]]), { accountId: 'zero', displayName: 'Zero' }),
    assigned(issue('MISSING', null, [history[7]], 'To Do'), {
      accountId: 'missing',
      displayName: 'Missing estimate',
    }),
    assigned(issue('FUTURE', 100, [sprint(99, 'Nexus Sprint 99', 'future')]), {
      accountId: 'future',
      displayName: 'Future only',
    }),
  ]).boards[0];
  assert.deepEqual(
    board.series.map(({ sprint }) => sprint),
    history.slice(2),
  );
  assert.ok(Array.isArray(board.people), 'people is required');
  assert.deepEqual(
    board.people.map(({ displayName }) => displayName),
    ['All sprints', 'Missing estimate', 'Sparse', 'Zero'],
  );
  const sparse = board.people.find(({ id }) => id === personId('sparse'));
  assert.deepEqual(
    sparse.series,
    history
      .slice(2)
      .map((membership, index) =>
        index === 7
          ? aggregateEntry(membership, 2.5, 1, 0, { done: 2.5 })
          : aggregateEntry(membership),
      ),
  );
  assert.deepEqual(
    board.people.find(({ id }) => id === personId('zero')).series[6],
    aggregateEntry(history[8], 0, 1),
  );
  assert.deepEqual(
    board.people.find(({ id }) => id === personId('missing')).series[5],
    aggregateEntry(history[7], 0, 1, 1),
  );
  assertPeopleReconcile(board);
});

test('person partitions use the deduplicated current assignee and keep distinct carried memberships', () => {
  const first = sprint(1, 'Nexus Sprint 1', 'closed', '2026-10-01');
  const second = sprint(2, 'Nexus Sprint 2', 'active', '2026-10-15');
  const old = assigned(issue('CARRY', 9, [first, second], 'Done', '2026-11-01'), {
    accountId: 'previous',
    displayName: 'Previous owner',
  });
  const current = assigned(
    issue('CARRY', 2.5, [first, second, { ...second, id: '2' }], 'In Progress', '2026-11-02'),
    { accountId: 'current', displayName: 'Current owner' },
  );
  const rows = freeze([
    current,
    old,
    assigned(issue('DONE', 0.1, [first]), { accountId: 'other', displayName: 'Other' }),
    assigned(issue('TODO', 0.2, [second], 'To Do'), { accountId: 'other', displayName: 'Other' }),
    assigned(issue('NO-ESTIMATE', null, [first, second]), {
      accountId: 'other',
      displayName: 'Other',
    }),
  ]);
  const before = structuredClone(rows);
  const board = build(rows).boards[0];
  assert.deepEqual(board.series, [
    aggregateEntry(first, 2.6, 3, 1, { done: 0.1, inProgress: 2.5 }),
    aggregateEntry(second, 2.7, 3, 1, { inProgress: 2.5, notStarted: 0.2 }),
  ]);
  assert.ok(Array.isArray(board.people), 'people is required');
  assert.deepEqual(board.people, [
    {
      id: personId('current'),
      displayName: 'Current owner',
      series: [first, second].map((membership) =>
        aggregateEntry(membership, 2.5, 1, 0, { inProgress: 2.5 }),
      ),
    },
    {
      id: personId('other'),
      displayName: 'Other',
      series: [
        aggregateEntry(first, 0.1, 2, 1, { done: 0.1 }),
        aggregateEntry(second, 0.2, 2, 1, { notStarted: 0.2 }),
      ],
    },
  ]);
  assertPeopleReconcile(board);
  assert.deepEqual(rows, before);
});

test('equal display names retain distinct namespaced SHA-256 identities, sorted by label then ID not points', () => {
  const board = build([
    assigned(issue('B', 100), { accountId: 'same-value', displayName: 'Alex' }),
    assigned(issue('A', 1), { accountId: 'another-account', displayName: 'Alex' }),
    assigned(issue('NAME', 3), { displayName: 'same-value' }),
    assigned(issue('NAME-AGAIN', 2), { displayName: 'same-value' }),
  ]).boards[0];
  const expected = [
    { id: personId('same-value'), displayName: 'Alex', points: 100 },
    { id: personId('another-account'), displayName: 'Alex', points: 1 },
    { id: nameId('same-value'), displayName: 'same-value', points: 5 },
  ].sort((a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id));
  assert.ok(Array.isArray(board.people), 'people is required');
  assert.deepEqual(
    board.people.map(({ id, displayName, series }) => ({
      id,
      displayName,
      points: series[0].points,
    })),
    expected,
  );
  for (const { id } of board.people) assert.match(id, /^(person|name):[a-f0-9]{64}$/);
  assert.notEqual(personId('same-value'), nameId('same-value'));
  assert.deepEqual(
    build([assigned(issue('RENAMED', 1), { displayName: 'Renamed' })]).boards[0].people[0].id,
    nameId('Renamed'),
  );
  assertPeopleReconcile(board);
});

test('fallback, Unassigned, unknown and nameless-account buckets preserve every membership without using email identity', () => {
  const rows = [
    issue('MISSING-ASSIGNEE', 1),
    assigned(issue('NULL-ASSIGNEE', 2), null),
    assigned(issue('EMPTY-OBJECT', 3), {}),
    assigned(issue('EMAIL-ONLY', 4), {
      accountId: '',
      displayName: '',
      emailAddress: 'secret@example.invalid',
    }),
    assigned(issue('NAMELESS-ACCOUNT', 5), { accountId: 'nameless' }),
    assigned(issue('FALLBACK', 0), { accountId: '', displayName: 'Fallback' }),
    assigned(issue('UNESTIMATED', null), { displayName: 'Fallback' }),
  ];
  const board = build(rows).boards[0];
  assert.equal(board.series[0].count, 7);
  assert.equal(board.series[0].points, 15);
  assert.equal(board.series[0].unestimated, 1);
  const expected = [
    {
      id: nameId('Fallback'),
      displayName: 'Fallback',
      series: [aggregateEntry(sprint(), 0, 2, 1)],
    },
    {
      id: 'unassigned',
      displayName: 'Unassigned',
      series: [aggregateEntry(sprint(), 3, 2, 0, { done: 3 })],
    },
    {
      id: 'unknown',
      displayName: 'Unknown assignee',
      series: [aggregateEntry(sprint(), 7, 2, 0, { done: 7 })],
    },
    {
      id: personId('nameless'),
      displayName: 'Unknown assignee',
      series: [aggregateEntry(sprint(), 5, 1, 0, { done: 5 })],
    },
  ].sort((a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id));
  assert.deepEqual(board.people, expected);
  assertPeopleReconcile(board);
  assertNoSecrets(board, ['secret@example.invalid', 'nameless']);
});

test('one account label uses the newest valid update and later rows break valid or unknown timestamp ties', async (t) => {
  for (const [label, updates, expectedName] of [
    ['newest valid', ['2026-11-03', '2026-11-01', '2026-11-02'], 'Label 0'],
    ['equal valid', ['2026-11-01', '2026-11-01', '2026-11-01'], 'Label 2'],
    ['invalid', ['invalid', 'invalid', 'invalid'], 'Label 2'],
    ['missing', [undefined, undefined, undefined], 'Label 2'],
  ]) {
    await t.test(label, () => {
      const board = build(
        updates.map((updated, index) =>
          assigned(issue(`LABEL-${index}`, 1, [sprint()], 'Done', updated), {
            accountId: 'one-account',
            displayName: `Label ${index}`,
          }),
        ),
      ).boards[0];
      assert.deepEqual(board.people, [
        {
          id: personId('one-account'),
          displayName: expectedName,
          series: [aggregateEntry(sprint(), 3, 3, 0, { done: 3 })],
        },
      ]);
      assertPeopleReconcile(board);
    });
  }
});

test('one opaque account identity spans teams without leaking memberships between their sprint windows', () => {
  const nexus = sprint(1, 'Nexus Sprint 1', 'closed', null);
  const mobile = sprint(2, 'Mobile Sprint 2', 'active', '2026-10-15');
  const boards = build([
    assigned(issue('BOTH', 2.5, [nexus, mobile]), {
      accountId: ' shared-account ',
      displayName: 'Shared',
    }),
  ]).boards;
  assert.deepEqual(boards, [
    {
      name: 'Mobile',
      series: [aggregateEntry(mobile, 2.5, 1, 0, { done: 2.5 })],
      people: [
        {
          id: personId(' shared-account '),
          displayName: 'Shared',
          series: [aggregateEntry(mobile, 2.5, 1, 0, { done: 2.5 })],
        },
      ],
    },
    {
      name: 'Nexus',
      series: [aggregateEntry(nexus, 2.5, 1, 0, { done: 2.5 })],
      people: [
        {
          id: personId(' shared-account '),
          displayName: 'Shared',
          series: [aggregateEntry(nexus, 2.5, 1, 0, { done: 2.5 })],
        },
      ],
    },
  ]);
  boards.forEach(assertPeopleReconcile);
});

test('empty data is explicit and completeness remains unknown below, at and above the raw query cap', () => {
  assert.deepEqual(build([]), {
    boards: [],
    keep: 8,
    coverage: { completeness: 'unknown', possibleTruncation: false, maxIssuesPerQuery: 5000 },
  });
  for (const length of [4999, 5000, 5001]) {
    const result = build(Array.from({ length }, () => issue('DUPLICATE', 1)));
    assert.deepEqual(result.coverage, {
      completeness: 'unknown',
      possibleTruncation: length >= 5000,
      maxIssuesPerQuery: 5000,
    });
    assert.equal(result.boards[0].series[0].count, 1, 'cap is measured before issue deduplication');
  }
});

test('fetch wrapper reuses both Jira queries with captured fields/auth, normalizes overlap and stamps completion', async (t) => {
  const calls = [];
  const closed = issue('DEMO-1', 3, [sprint()], 'Done', '2026-11-01T00:00:00Z');
  const open = issue('DEMO-1', 2.5, [sprint()], 'In Progress', '2026-11-02T00:00:00Z');
  closed.fields.assignee = { accountId: 'old-account', displayName: 'Old owner' };
  open.fields.assignee = { accountId: 'current-account', displayName: 'Current owner' };
  let completedAt;
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    assert.equal(url.origin, snapshot.jira.baseUrl);
    assert.equal(url.pathname, '/rest/api/3/search/jql');
    const jql = url.searchParams.get('jql');
    assert.match(jql, /^sprint in (openSprints|closedSprints)\(\) ORDER BY updated DESC$/);
    completedAt = Date.now();
    return Response.json({ issues: [jql.includes('openSprints') ? open : closed], isLast: true });
  });
  const result = await fetchHomeVelocity({ snapshot });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(({ url }) => url.searchParams.get('jql')).sort(), [
    'sprint in closedSprints() ORDER BY updated DESC',
    'sprint in openSprints() ORDER BY updated DESC',
  ]);
  for (const { url, init } of calls) {
    assert.deepEqual(url.searchParams.get('fields').split(',').sort(), [
      'assignee',
      'customfield_201',
      'customfield_202',
      'status',
      'updated',
    ]);
    assert.equal(init.redirect, 'error');
    assert.equal(
      init.headers.Authorization,
      `Basic ${Buffer.from(`${snapshot.jira.email}:${jiraToken}`).toString('base64')}`,
    );
  }
  const { updatedAt, ...aggregate } = result;
  assert.equal(new Date(updatedAt).toISOString(), updatedAt);
  assert.ok(Date.parse(updatedAt) >= completedAt);
  assert.ok(Date.parse(updatedAt) <= Date.now());
  assert.deepEqual(aggregate, build([closed, open]));
  assert.deepEqual(aggregate.boards[0].people, [
    {
      id: personId('current-account'),
      displayName: 'Current owner',
      series: [aggregateEntry(sprint(), 2.5, 1, 0, { inProgress: 2.5 })],
    },
  ]);
  assertPeopleReconcile(aggregate.boards[0]);
  assertNoSecrets(result);
});

test('fetch wrapper rejects an upstream failure rather than returning a successful partial or empty aggregate', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    return url.searchParams.get('jql').includes('closedSprints')
      ? Response.json({ issues: [issue('DEMO-1', 3)], isLast: true })
      : Response.json({ error: 'synthetic upstream failure' }, { status: 503 });
  });
  await assert.rejects(fetchHomeVelocity({ snapshot }), /503/);
});
