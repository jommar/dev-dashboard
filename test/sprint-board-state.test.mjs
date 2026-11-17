import { test } from 'node:test';
import assert from 'node:assert/strict';

// Loaded inside the test so a missing module fails it by name.
const load = () => import('../ui/sprint-board.js');

const STORAGE_KEY = 'dev-dashboard.sprint-board';

const memoryStorage = () => {
  const items = new Map();
  return {
    items,
    getItem: (name) => (items.has(name) ? items.get(name) : null),
    setItem: (name, value) => items.set(name, String(value)),
  };
};

const deniedStorage = {
  getItem() {
    throw new Error('storage denied');
  },
  setItem() {
    throw new Error('storage denied');
  },
};

const sprint = (id, state, endDate) => ({
  id,
  name: `Nexus Sprint ${id}`,
  state,
  startDate: null,
  endDate,
});

const active = sprint(17, 'active', '2026-11-28T00:00:00.000Z');
const future = sprint(18, 'future', null);
const newestClosed = sprint(16, 'closed', '2026-11-14T00:00:00.000Z');
const olderClosed = sprint(15, 'closed', '2026-10-31T00:00:00.000Z');

const side = (state) => ({ state, reason: null });

test('team and sprint choice: storage, pickers and session chips', async () => {
  const {
    SPRINT_BOARD_POLL_MS,
    DEFAULT_SPRINT_TEAM,
    readSprintChoice,
    writeSprintChoice,
    pickTeam,
    pickSprint,
    sessionChips,
  } = await load();

  assert.equal(SPRINT_BOARD_POLL_MS, 60000);
  assert.equal(DEFAULT_SPRINT_TEAM, 'Nexus');

  const empty = readSprintChoice(memoryStorage());
  assert.equal(empty.team, 'Nexus');
  assert.equal(empty.sprint, null);

  const denied = readSprintChoice(deniedStorage);
  assert.equal(denied.team, 'Nexus');
  assert.equal(denied.sprint, null);
  assert.doesNotThrow(() => writeSprintChoice({ team: 'Orion', sprint: 3 }, deniedStorage));

  const storage = memoryStorage();
  writeSprintChoice({ team: 'Orion', sprint: 3 }, storage);
  assert.deepEqual([...storage.items.keys()], [STORAGE_KEY]);
  assert.deepEqual(JSON.parse(storage.items.get(STORAGE_KEY)), {
    version: 1,
    team: 'Orion',
    sprint: 3,
  });
  const saved = readSprintChoice(storage);
  assert.equal(saved.team, 'Orion');
  assert.equal(saved.sprint, 3);

  const nexus = { name: 'Nexus', sprints: [active, future, newestClosed, olderClosed] };
  const orion = { name: 'Orion', sprints: [sprint(3, 'active', null)] };
  const atlas = { name: 'Atlas', sprints: [sprint(9, 'active', null)] };
  assert.equal(pickTeam([nexus, orion], 'Orion').name, 'Orion');
  assert.equal(pickTeam([nexus, orion], 'Gone').name, 'Nexus');
  assert.equal(pickTeam([atlas, orion], 'Nexus').name, 'Atlas');

  const all = [active, future, newestClosed, olderClosed];
  assert.equal(pickSprint(all, 15).id, 15);
  assert.equal(pickSprint(all, null).id, 17);
  assert.equal(pickSprint(all, 99).id, 17);
  assert.equal(pickSprint([future, newestClosed, olderClosed], 99).id, 18);
  assert.equal(pickSprint([newestClosed, olderClosed], 99).id, 16);

  const chips = sessionChips({
    phase: 'implement-plan',
    state: 'working',
    reason: 'running',
    groom: { state: 'done', reason: 'finished', verdict: 'READY' },
    review: side('none'),
    specReview: side('none'),
    e2e: side('failed'),
  });
  assert.deepEqual(
    chips.map(({ phase, state }) => ({ phase, state })),
    [
      { phase: 'implement-plan', state: 'working' },
      { phase: 'groom', state: 'done' },
      { phase: 'e2e', state: 'failed' },
    ],
  );
  assert.deepEqual(
    sessionChips({
      phase: null,
      state: 'none',
      reason: null,
      groom: side('none'),
      review: side('none'),
      specReview: side('none'),
      e2e: side('none'),
    }),
    [],
  );
});

test('a sprint choice follows the active sprint unless another sprint is picked', async () => {
  const { sprintChoice } = await load();
  const nexus = { name: 'Nexus', sprints: [active, future, newestClosed, olderClosed] };

  assert.deepEqual(sprintChoice(nexus, 17), { team: 'Nexus', sprint: null });
  assert.deepEqual(sprintChoice(nexus, 18), { team: 'Nexus', sprint: 18 });
  assert.deepEqual(sprintChoice(nexus, 15), { team: 'Nexus', sprint: 15 });
});

test('session chip words are the Sessions drawer phase words', async () => {
  const { sessionChipWords } = await load();
  const { PHASES } = await import('../ui/session-phases.js');
  const drawerPhaseOf = {
    'investigate-and-plan': 'investigate',
    'implement-plan': 'implement',
    review: 'review',
    groom: 'groom',
    e2e: 'e2e',
    reviewRequest: 'reviewRequest',
  };
  for (const [entryPhase, drawerPhase] of Object.entries(drawerPhaseOf)) {
    assert.equal(sessionChipWords(entryPhase), PHASES[drawerPhase].words, entryPhase);
  }
  assert.equal(sessionChipWords('unlisted-phase'), 'unlisted-phase');
});

test('a waiting spec review gets its own session chip', async () => {
  const { sessionChips, sessionChipWords } = await load();
  const chips = sessionChips({
    phase: 'implement-plan',
    state: 'done',
    reason: 'finished',
    groom: side('none'),
    review: side('done'),
    specReview: side('waiting'),
    e2e: side('none'),
  });
  assert.deepEqual(
    chips.map(({ phase, state }) => ({ phase, state })),
    [
      { phase: 'implement-plan', state: 'done' },
      { phase: 'review', state: 'done' },
      { phase: 'specReview', state: 'waiting' },
    ],
  );
  assert.equal(sessionChipWords('specReview'), 'Spec review');
});

test('a pinned sprint that has become active settles to following the active sprint', async () => {
  const { settledChoice } = await load();
  const rolledOver = {
    name: 'Nexus',
    sprints: [sprint(18, 'active', null), sprint(17, 'closed', null)],
  };

  assert.deepEqual(settledChoice(rolledOver, { team: 'Nexus', sprint: 18 }), {
    team: 'Nexus',
    sprint: null,
  });
  assert.deepEqual(settledChoice(rolledOver, { team: 'Nexus', sprint: 17 }), {
    team: 'Nexus',
    sprint: 17,
  });
});

test('finished columns that are not done-kind move after the done band, order otherwise kept', async () => {
  const { finishedColumnsLast } = await load();
  const { boardColumns } = await import('../ui/ticket-board.js');
  const tickets = [
    ['A-1', 'Rejected', 'Done'],
    ['A-2', 'In Progress', 'In Progress'],
    ['A-3', 'Complete', 'Done'],
    ['A-4', 'Duplicate', 'Done'],
    ['A-5', 'To Do', 'To Do'],
    ['A-6', 'Blocked', 'In Progress'],
    ['A-7', 'Deployed', 'Done'],
  ].map(([key, status, statusCategory]) => ({ key, status, statusCategory }));
  const columns = boardColumns(tickets);
  // The shared order puts Rejected in the attention band and Duplicate among the queued.
  assert.deepEqual(
    columns.map(({ status }) => status),
    ['Blocked', 'Rejected', 'To Do', 'Duplicate', 'In Progress', 'Deployed', 'Complete'],
  );

  const moved = finishedColumnsLast(columns);
  assert.deepEqual(
    moved.map(({ status }) => status),
    ['Blocked', 'To Do', 'In Progress', 'Deployed', 'Complete', 'Rejected', 'Duplicate'],
  );
  assert.equal(moved.find(({ status }) => status === 'Rejected').tickets[0].key, 'A-1');
  assert.deepEqual(
    columns.map(({ status }) => status),
    ['Blocked', 'Rejected', 'To Do', 'Duplicate', 'In Progress', 'Deployed', 'Complete'],
    'the input is not mutated',
  );
});
