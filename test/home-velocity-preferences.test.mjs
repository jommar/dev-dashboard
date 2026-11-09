import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as velocity from '../ui/home-velocity.js';
import { buildHomeVelocity } from '../backend/home-velocity.mjs';

const {
  readVelocityTeam,
  writeVelocityTeam,
  readVelocitySnapshot,
  writeVelocitySnapshot,
  validateVelocitySnapshot,
} = velocity;

const key = 'dev-dashboard.home-velocity';
const storage = (value) => ({
  getItem(name) {
    assert.equal(name, key);
    return value;
  },
});

test('Home team preference: absent, malformed and unsupported records default to Nexus without writes', () => {
  for (const raw of [
    null,
    '',
    '{',
    'null',
    '[]',
    '"Mobile"',
    '{}',
    '{"version":2,"team":"Mobile"}',
    '{"version":1,"team":""}',
    '{"version":1,"team":42}',
    '{"version":1,"team":"   "}',
  ]) {
    assert.equal(readVelocityTeam(storage(raw)), 'Nexus', String(raw));
  }
});

test('Home team preference: valid identities survive even when no such team is loaded', () => {
  for (const team of ['Mobile', 'Removed Team', 'Nexus']) {
    assert.equal(readVelocityTeam(storage(JSON.stringify({ version: 1, team }))), team);
  }
});

test('Home team preference: explicit selection writes only the versioned Home record', () => {
  const writes = [];
  writeVelocityTeam('Mobile', { setItem: (...args) => writes.push(args) });
  assert.deepEqual(writes, [[key, JSON.stringify({ version: 1, team: 'Mobile' })]]);
});

test('Home team preference: denied storage does not break reading or explicit changes', () => {
  const denied = {
    getItem() {
      throw new Error('Storage denied');
    },
    setItem() {
      throw new Error('Quota exceeded');
    },
  };
  assert.equal(readVelocityTeam(denied), 'Nexus');
  assert.doesNotThrow(() => writeVelocityTeam('Mobile', denied));
});

const snapshotKey = 'dev-dashboard.home-velocity.snapshot';
const personId = `person:${'a'.repeat(64)}`;
const nameId = `name:${'b'.repeat(64)}`;

function snapshotFixture() {
  const series = [
    {
      sprint: { id: null, name: 'Nexus Sprint 1', state: 'closed', endDate: null },
      points: 0,
      count: 1,
      unestimated: 1,
      byStatus: { done: 0, inProgress: 0, notStarted: 0 },
    },
    {
      sprint: {
        id: 'sprint-2',
        name: 'Nexus Sprint 2',
        state: 'active',
        endDate: '2026-11-09T12:00:00Z',
      },
      points: 3.75,
      count: 3,
      unestimated: 0,
      byStatus: { done: 2.5, inProgress: 1.25, notStarted: 0 },
    },
  ];
  return {
    boards: [
      { name: 'Mobile', series: [], people: [] },
      {
        name: 'Nexus',
        series,
        people: [
          { id: personId, displayName: 'Alex', series: structuredClone(series) },
          {
            id: nameId,
            displayName: 'Alex',
            series: series.map(({ sprint }) => ({
              sprint: { ...sprint },
              points: 0,
              count: 0,
              unestimated: 0,
              byStatus: { done: 0, inProgress: 0, notStarted: 0 },
            })),
          },
        ],
      },
    ],
    keep: 8,
    coverage: { completeness: 'unknown', possibleTruncation: false, maxIssuesPerQuery: 5000 },
    updatedAt: '2000-01-02T03:04:05.000Z',
  };
}

function snapshotStorage(raw, failure) {
  let value = raw;
  const calls = [];
  return {
    calls,
    get value() {
      return value;
    },
    getItem(name) {
      calls.push(['getItem', name]);
      if (failure === 'read') throw new Error('Storage denied');
      return value;
    },
    setItem(name, next) {
      calls.push(['setItem', name, next]);
      if (failure === 'write') throw new Error('Storage denied');
      if (failure === 'quota') throw new DOMException('Quota exceeded', 'QuotaExceededError');
      value = next;
    },
    removeItem(name) {
      calls.push(['removeItem', name]);
      value = null;
    },
  };
}

const snapshotRecord = (snapshot) => JSON.stringify({ version: 2, snapshot });

function arithmeticFixture() {
  const input = snapshotFixture();
  const board = input.boards[1];
  board.series = [
    {
      ...board.series[1],
      points: 3,
      count: 1,
      byStatus: { done: 3, inProgress: 0, notStarted: 0 },
    },
  ];
  board.people[0].series = structuredClone(board.series);
  board.people[1].series = [
    {
      ...structuredClone(board.series[0]),
      points: 0,
      count: 0,
      byStatus: { done: 0, inProgress: 0, notStarted: 0 },
    },
  ];
  return input;
}

test('Home velocity snapshot arithmetic: impossible relationships reject at validate/read/write boundaries without repair', async (t) => {
  const mutations = [
    [
      'team total 3/completed 30',
      (board) => {
        board.series[0].byStatus.done = 30;
      },
    ],
    [
      'person total 300/team 3',
      (board) => {
        board.people[0].series[0].points = 300;
        board.people[0].series[0].byStatus.done = 300;
      },
    ],
    [
      'team unestimated 100/count 1',
      (board) => {
        board.series[0].unestimated = 100;
      },
    ],
    [
      'person unestimated exceeds own count',
      (board) => {
        board.people[1].series[0].unestimated = 1;
      },
    ],
    [
      'no contributors for nonzero team',
      (board) => {
        board.people = [];
      },
    ],
    [
      'counts stay exact at large scales',
      (board) => {
        board.series[0].count = 1e12;
        board.people[0].series[0].count = 1e12 - 1;
      },
    ],
    [
      'unestimated sums stay exact at large scales',
      (board) => {
        board.series[0].count = board.people[0].series[0].count = 1e12;
        board.series[0].unestimated = 1e12;
        board.people[0].series[0].unestimated = 1e12 - 1;
      },
    ],
    [
      'per-status person sums disagree despite matching totals',
      (board) => {
        board.people[0].series[0].byStatus = { done: 0, inProgress: 3, notStarted: 0 };
      },
    ],
    [
      'person categories disagree with own points',
      (board) => {
        board.people[0].series[0].byStatus.notStarted = 1;
      },
    ],
    [
      'finite fields overflow their category sum',
      (board) => {
        for (const entry of [board.series[0], board.people[0].series[0]]) {
          entry.points = Number.MAX_VALUE;
          entry.byStatus = { done: Number.MAX_VALUE, inProgress: Number.MAX_VALUE, notStarted: 0 };
        }
      },
    ],
    [
      'near-zero discrepancy exceeds absolute tolerance',
      (board) => {
        for (const entry of [board.series[0], board.people[0].series[0]]) {
          entry.points = 0;
          entry.byStatus.done = 2e-9;
        }
      },
    ],
    [
      'large discrepancy exceeds relative tolerance',
      (board) => {
        for (const entry of [board.series[0], board.people[0].series[0]]) {
          entry.points = 1e12;
          entry.byStatus.done = 1e12 + 2000;
        }
      },
    ],
  ];
  const fetch = t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Validation must not fetch');
  });
  for (const [label, mutate] of mutations) {
    await t.test(label, () => {
      const input = arithmeticFixture();
      mutate(input.boards[1]);
      const before = structuredClone(input);
      const raw = snapshotRecord(input);
      const cached = snapshotStorage(raw);
      const older = snapshotRecord(arithmeticFixture());
      const destination = snapshotStorage(older);
      const validated = validateVelocitySnapshot(input);
      const restored = readVelocitySnapshot(cached);
      const saved = writeVelocitySnapshot(input, destination);
      assert.deepEqual(
        {
          validated,
          restored,
          saved,
          readCalls: cached.calls,
          rawAfterRead: cached.value,
          writeCalls: destination.calls,
          lastGood: destination.value,
          source: input,
        },
        {
          validated: null,
          restored: null,
          saved: false,
          readCalls: [['getItem', snapshotKey]],
          rawAfterRead: raw,
          writeCalls: [],
          lastGood: older,
          source: before,
        },
      );
    });
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('Home velocity snapshot arithmetic: legitimate decimal and backend summation-order differences remain unrounded', () => {
  const decimal = arithmeticFixture();
  const board = decimal.boards[1];
  board.series[0].points = 0.3;
  board.series[0].count = 2;
  board.series[0].byStatus = { done: 0.1, inProgress: 0.2, notStarted: 0 };
  board.people[0].series[0].points = 0.1;
  board.people[0].series[0].byStatus = { done: 0.1, inProgress: 0, notStarted: 0 };
  board.people[1].series[0].count = 1;
  board.people[1].series[0].points = 0.2;
  board.people[1].series[0].byStatus = { done: 0, inProgress: 0.2, notStarted: 0 };
  assert.notEqual(0.1 + 0.2, board.series[0].points);
  const inputs = [decimal];
  for (const pointsFor of [() => 0.1, (index) => (index % 2 ? 0.1 : 1e12)]) {
    const issues = Array.from({ length: 10_000 }, (_, index) => ({
      key: `FLOAT-${index}`,
      fields: {
        points: pointsFor(index),
        sprints: [board.series[0].sprint],
        assignee: { accountId: `person-${index % 400}`, displayName: `Person ${index % 400}` },
        status: { statusCategory: { name: ['Done', 'In Progress', 'To Do'][index % 3] } },
      },
    }));
    const actual = {
      ...buildHomeVelocity(issues, {
        snapshot: { jira: { sprintField: 'sprints', pointsField: 'points' } },
      }),
      updatedAt: decimal.updatedAt,
    };
    const team = actual.boards[0].series[0];
    assert.notEqual(
      team.points,
      actual.boards[0].people.reduce((sum, p) => sum + p.series[0].points, 0),
    );
    inputs.push(actual);
  }
  for (const input of inputs) {
    const before = structuredClone(input);
    assert.deepEqual(validateVelocitySnapshot(input), before);
    assert.deepEqual(readVelocitySnapshot(snapshotStorage(snapshotRecord(input))), before);
    const destination = snapshotStorage('older record');
    assert.equal(writeVelocitySnapshot(input, destination), true);
    assert.equal(
      destination.value,
      snapshotRecord(before),
      'save must not round legitimate source values',
    );
    assert.deepEqual(input, before);
  }
});

test('Home velocity snapshot: frozen helpers are exported', () => {
  for (const name of [
    'readVelocitySnapshot',
    'writeVelocitySnapshot',
    'validateVelocitySnapshot',
  ]) {
    assert.equal(typeof velocity[name], 'function', name);
  }
});

test('Home velocity snapshot: valid empty and sparse payloads retain zeros, fractions and nullable source metadata', () => {
  const sparse = snapshotFixture();
  const numericId = snapshotFixture();
  for (const entry of [
    numericId.boards[1].series[1],
    ...numericId.boards[1].people.map((p) => p.series[1]),
  ]) {
    entry.sprint.id = 42;
  }
  const capped = snapshotFixture();
  capped.coverage.possibleTruncation = true;
  const fullWindow = snapshotFixture();
  const board = fullWindow.boards[1];
  board.series = Array.from({ length: 8 }, (_, index) => ({
    ...structuredClone(board.series[0]),
    sprint: { id: index, name: `Nexus Sprint ${index}`, state: 'closed', endDate: null },
  }));
  board.people = [
    { id: 'unassigned', displayName: 'Unassigned', series: structuredClone(board.series) },
  ];
  const unknown = snapshotFixture();
  unknown.boards[1].people[0].id = 'unknown';
  unknown.boards[1].people[0].displayName = 'Unknown assignee';
  for (const input of [{ ...sparse, boards: [] }, sparse, numericId, capped, fullWindow, unknown]) {
    const before = structuredClone(input);
    assert.deepEqual(validateVelocitySnapshot(input), before);
    assert.deepEqual(readVelocitySnapshot(snapshotStorage(snapshotRecord(input))), before);
    assert.deepEqual(input, before, 'validation does not mutate the source');
  }
});

test('Home velocity snapshot: whitelist projection strips sensitive arbitrary fields at every nested level', () => {
  const expected = snapshotFixture();
  const input = structuredClone(expected);
  const extras = {
    issues: [{ key: 'PRIVATE-1' }],
    accountId: 'private-account',
    token: 'secret',
    arbitrary: true,
  };
  Object.assign(input, extras);
  Object.assign(input.coverage, extras);
  for (const board of input.boards) {
    Object.assign(board, extras, { byUser: { 'private@example.test': 100 } });
    for (const person of board.people)
      Object.assign(person, extras, { emailAddress: 'private@example.test' });
    for (const entry of [...board.series, ...board.people.flatMap((person) => person.series)]) {
      Object.assign(entry, extras);
      Object.assign(entry.sprint, extras);
      Object.assign(entry.byStatus, extras);
    }
  }
  const before = structuredClone(input);
  assert.deepEqual(validateVelocitySnapshot(input), expected);
  const raw = JSON.stringify({ version: 2, snapshot: input, ...extras });
  const store = snapshotStorage(raw);
  assert.deepEqual(readVelocitySnapshot(store), expected);
  assert.deepEqual(store.calls, [['getItem', snapshotKey]]);
  assert.equal(store.value, raw, 'reading never repairs the stored record');
  const output = snapshotStorage(null);
  assert.equal(writeVelocitySnapshot(input, output), true);
  assert.deepEqual(JSON.parse(output.value), { version: 2, snapshot: expected });
  assert.deepEqual(output.calls, [['setItem', snapshotKey, snapshotRecord(expected)]]);
  assert.deepEqual(input, before);
});

test('Home velocity snapshot: missing, corrupt, old and personless records fail closed without side effects', (t) => {
  const personless = snapshotFixture();
  delete personless.boards[1].people;
  const invalid = snapshotFixture();
  invalid.boards[1].series[0].count = '1';
  const rawValues = [
    null,
    '',
    '{',
    'null',
    '[]',
    '"snapshot"',
    '{}',
    JSON.stringify({ version: 1, snapshot: snapshotFixture() }),
    JSON.stringify({ version: 3, snapshot: snapshotFixture() }),
    JSON.stringify({ version: '2', snapshot: snapshotFixture() }),
    JSON.stringify({ version: 2 }),
    snapshotRecord(null),
    snapshotRecord(personless),
    snapshotRecord(invalid),
    JSON.stringify(snapshotFixture()),
  ];
  const fetch = t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Cache helpers must not fetch');
  });
  for (const raw of rawValues) {
    const store = snapshotStorage(raw);
    assert.equal(readVelocitySnapshot(store), null, String(raw));
    assert.deepEqual(store.calls, [['getItem', snapshotKey]]);
    assert.equal(store.value, raw);
  }
  const denied = snapshotStorage('older record', 'read');
  assert.equal(readVelocitySnapshot(denied), null);
  assert.deepEqual(denied.calls, [['getItem', snapshotKey]]);
  assert.equal(denied.value, 'older record');
  assert.equal(fetch.mock.callCount(), 0);
});

test('Home velocity snapshot: bounded schema rejects invalid required types and numeric ranges', () => {
  const cases = [
    ['boards', [undefined, null, {}, 'boards']],
    ['boards.1', [null, [], 'Nexus']],
    ['boards.1.name', [undefined, null, '', '   ', 7]],
    ['boards.1.series', [undefined, null, {}]],
    ['boards.1.people', [undefined, null, {}]],
    ['boards.1.people.0', [null, [], 'Alex']],
    ['boards.1.people.0.displayName', [undefined, null, '', '   ', 7]],
    ['boards.1.people.0.series', [undefined, null, {}]],
    ['keep', [undefined, null, '8', 0, 7, 9]],
    ['coverage', [undefined, null, [], 'unknown']],
    ['coverage.completeness', [undefined, null, true, 'complete']],
    ['coverage.possibleTruncation', [undefined, null, 0, 'false']],
    ['coverage.maxIssuesPerQuery', [undefined, null, '5000', -1, 1.5, Infinity]],
    ['updatedAt', [undefined, null, '', 'not-a-date', 123, {}]],
  ];
  const entryCases = [
    ['', [null, [], 'entry']],
    ['sprint', [undefined, null, []]],
    ['sprint.id', [undefined, {}, [], true, NaN, Infinity, -Infinity]],
    ['sprint.name', [undefined, null, '', '  ', 1]],
    ['sprint.state', [undefined, null, 'future', 'ACTIVE', 1]],
    ['sprint.endDate', [undefined, 123, {}, []]],
    ['points', [undefined, null, '0', -0.5, NaN, Infinity, -Infinity]],
    ['count', [undefined, null, '1', -1, 0.5, NaN, Infinity]],
    ['unestimated', [undefined, null, '0', -1, 0.5, NaN, Infinity]],
    ['byStatus', [undefined, null, []]],
    ...['done', 'inProgress', 'notStarted'].map((status) => [
      `byStatus.${status}`,
      [undefined, null, '0', -0.5, NaN, Infinity, -Infinity],
    ]),
  ];
  for (const base of ['boards.1.series.0', 'boards.1.people.0.series.0']) {
    for (const [suffix, values] of entryCases)
      cases.push([suffix ? `${base}.${suffix}` : base, values]);
  }
  for (const [path, values] of cases) {
    for (const value of values) {
      const input = snapshotFixture();
      const parts = path.split('.');
      const field = parts.pop();
      const parent = parts.reduce((object, part) => object[part], input);
      if (value === undefined) delete parent[field];
      else parent[field] = value;
      assert.equal(validateVelocitySnapshot(input), null, `${path} = ${String(value)}`);
    }
  }
  for (const value of [undefined, null, [], '', 8, true])
    assert.equal(validateVelocitySnapshot(value), null);
});

test('Home velocity snapshot: safe person identities are unique within each team', () => {
  for (const id of [
    undefined,
    null,
    '',
    'account-123',
    'private@example.test',
    'person:raw-account-id',
    `person:${'a'.repeat(63)}`,
    `person:${'a'.repeat(65)}`,
    `person:${'A'.repeat(64)}`,
    `name:${'g'.repeat(64)}`,
    `other:${'a'.repeat(64)}`,
    'everyone',
    42,
  ]) {
    const input = snapshotFixture();
    input.boards[1].people[0].id = id;
    assert.equal(validateVelocitySnapshot(input), null, String(id));
  }
  for (const id of [personId, nameId, 'unassigned', 'unknown']) {
    const input = snapshotFixture();
    input.boards[1].people[0].id = id;
    input.boards[1].people[1].id = id;
    assert.equal(validateVelocitySnapshot(input), null, `duplicate ${id}`);
  }
  const input = snapshotFixture();
  input.boards.push({ ...structuredClone(input.boards[1]), name: 'Other Team' });
  assert.deepEqual(
    validateVelocitySnapshot(input),
    input,
    'one person may appear on different teams',
  );
});

test('Home velocity snapshot: person series must match the team metadata, order and bounded window exactly', () => {
  const mutations = [
    (board) => board.people[0].series.pop(),
    (board) => board.people[0].series.push(structuredClone(board.series[0])),
    (board) => board.people[0].series.reverse(),
    (board) => (board.people[0].series[0].sprint.id = 'different'),
    (board) => (board.people[0].series[0].sprint.name = 'Different sprint'),
    (board) => (board.people[0].series[0].sprint.state = 'active'),
    (board) => (board.people[0].series[0].sprint.endDate = '2026-01-01'),
    (board) => {
      board.series = Array.from({ length: 9 }, () => structuredClone(board.series[0]));
      for (const person of board.people) person.series = structuredClone(board.series);
    },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const input = snapshotFixture();
    mutate(input.boards[1]);
    assert.equal(validateVelocitySnapshot(input), null, `alignment case ${index}`);
  }
});

test('Home velocity snapshot: successful writes replace only the snapshot key with the projected version-2 record', () => {
  const input = snapshotFixture();
  const store = snapshotStorage('older record');
  assert.equal(writeVelocitySnapshot(input, store), true);
  assert.deepEqual(store.calls, [['setItem', snapshotKey, snapshotRecord(input)]]);
  assert.deepEqual(JSON.parse(store.value), { version: 2, snapshot: input });
  assert.deepEqual(
    readVelocitySnapshot(store),
    input,
    'read returns payload, not the storage wrapper',
  );
});

test('Home velocity snapshot: invalid, denied and quota writes return false and preserve the older record', () => {
  const older = snapshotRecord(snapshotFixture());
  const invalid = snapshotFixture();
  delete invalid.boards[1].people;
  for (const input of [null, {}, invalid, { ...snapshotFixture(), updatedAt: 'bad-date' }]) {
    const store = snapshotStorage(older);
    assert.equal(writeVelocitySnapshot(input, store), false);
    assert.equal(store.value, older);
    assert.deepEqual(store.calls, [], 'invalid data must not touch storage');
  }
  for (const failure of ['write', 'quota']) {
    const store = snapshotStorage(older, failure);
    const fresh = snapshotFixture();
    fresh.updatedAt = '2026-11-09T14:00:00.000Z';
    assert.equal(writeVelocitySnapshot(fresh, store), false);
    assert.equal(store.value, older);
    assert.deepEqual(store.calls, [['setItem', snapshotKey, snapshotRecord(fresh)]]);
    assert.deepEqual(readVelocitySnapshot(store), snapshotFixture());
  }
});

test('Home velocity snapshot: default localStorage access, including a denied getter, stays inside try/catch', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const input = snapshotFixture();
  const store = snapshotStorage(snapshotRecord(input));
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: store });
    assert.deepEqual(readVelocitySnapshot(), input);
    assert.equal(writeVelocitySnapshot(input), true);
    assert.deepEqual(store.calls, [
      ['getItem', snapshotKey],
      ['setItem', snapshotKey, snapshotRecord(input)],
    ]);
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('Storage denied', 'SecurityError');
      },
    });
    assert.equal(readVelocitySnapshot(), null);
    assert.equal(writeVelocitySnapshot(input), false);
    const explicit = snapshotStorage(snapshotRecord(input));
    assert.deepEqual(
      readVelocitySnapshot(explicit),
      input,
      'injected storage bypasses the denied default',
    );
    assert.equal(writeVelocitySnapshot(input, explicit), true);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  }
});
