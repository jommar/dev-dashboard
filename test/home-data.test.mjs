import test from 'node:test';
import assert from 'node:assert/strict';
import {
  actionQueue,
  allTickets,
  capTiers,
  countsByCategory,
  donePointsBySprint,
  inSprints,
  kpiCounts,
  myReviewsUnknown,
  needsMyReview,
  pointsByCategory,
  selectableSprints,
  sprintProgress,
  sprintProgressFor,
} from '../ui/home-data.js';

const ACTIVE = {
  id: 1404,
  name: 'Nexus Sprint 17',
  state: 'active',
  startDate: '2026-08-24',
  endDate: '2026-09-06',
};
const NEXT = {
  id: 1405,
  name: 'Nexus Sprint 18',
  state: 'future',
  startDate: '2026-09-07',
  endDate: '2026-09-20',
};
const PREV = {
  id: 1299,
  name: 'Nexus Sprint 16',
  state: 'closed',
  startDate: '2026-08-10',
  endDate: '2026-08-23',
};

const ticket = (key, statusCategory, sprints, updated = '2026-09-01T00:00:00Z') => ({
  key,
  summary: key + ' summary',
  status: statusCategory === 'In Progress' ? 'In Progress' : statusCategory,
  statusCategory,
  updated,
  sprints,
  sprint: sprints[0] || null,
  storyPoints: null,
});

// Same ticket, with an estimate. Kept separate so the existing count-only
// tests stay untouched.
const pointed = (key, statusCategory, sprints, storyPoints, updated) => ({
  ...ticket(key, statusCategory, sprints, updated),
  storyPoints,
});

// groupsByCategory is what the server sends; tickets[] is not relied on.
const ticketsPayload = (list, activeSprintList = [ACTIVE]) => {
  const groups = {};
  for (const t of list) (groups[t.statusCategory] ||= []).push(t);
  return { total: list.length, groupsByCategory: groups, activeSprints: activeSprintList };
};

const pr = (number, over = {}) => ({
  number,
  repo: 'TransActComm/Portage-backend',
  title: `[TRIPS-${number}] thing`,
  url: `https://github.com/x/${number}`,
  owner: 'someone',
  draft: false,
  updatedAt: '2026-09-01T00:00:00Z',
  reviews: { state: null, approvers: [], changesRequesters: [], available: true },
  ...over,
});

test('allTickets flattens groupsByCategory and tolerates a missing payload', () => {
  const list = [ticket('A-1', 'To Do', [ACTIVE]), ticket('A-2', 'Done', [ACTIVE])];
  assert.equal(allTickets(ticketsPayload(list)).length, 2);
  assert.deepEqual(allTickets(null), []);
  assert.deepEqual(allTickets({}), []);
});

test('sprint scoping counts a ticket carried into a later sprint', () => {
  // sprints[0] is the future sprint, so scoping on `sprint` alone would miss it.
  const carried = ticket('A-9', 'Done', [NEXT, ACTIVE]);
  assert.equal(inSprints(carried, [ACTIVE]), true);
  assert.equal(inSprints(ticket('A-8', 'To Do', [NEXT]), [ACTIVE]), false);
  assert.equal(inSprints(ticket('A-7', 'To Do', []), [ACTIVE]), false);
  assert.equal(inSprints(ticket('A-6', 'To Do', [ACTIVE]), []), false);
});

test('sprint scoping falls back to name when the sprint id is absent', () => {
  const noId = {
    id: null,
    name: 'Nexus Sprint 17',
    state: 'active',
    startDate: null,
    endDate: null,
  };
  assert.equal(inSprints(ticket('A-5', 'To Do', [noId]), [noId]), true);
});

test('countsByCategory buckets unknown categories as todo', () => {
  assert.deepEqual(
    countsByCategory([
      ticket('A-1', 'To Do', []),
      ticket('A-2', 'In Progress', []),
      ticket('A-3', 'Done', []),
      ticket('A-4', 'Unknown', []),
    ]),
    { todo: 2, active: 1, done: 1 },
  );
});

test('sprintProgress reports one entry per active sprint, scoped to it', () => {
  const payload = ticketsPayload([
    ticket('A-1', 'Done', [ACTIVE]),
    ticket('A-2', 'Done', [NEXT, ACTIVE]),
    ticket('A-3', 'In Progress', [ACTIVE]),
    ticket('A-4', 'To Do', [NEXT]),
  ]);
  const progress = sprintProgress(payload);
  assert.equal(progress.length, 1);
  assert.equal(progress[0].sprint.name, 'Nexus Sprint 17');
  assert.equal(progress[0].total, 3);
  assert.deepEqual(progress[0].counts, { todo: 0, active: 1, done: 2 });
});

test('sprintProgress is empty when no ticket is in an active sprint', () => {
  assert.deepEqual(sprintProgress(ticketsPayload([ticket('A-1', 'To Do', [NEXT])], [])), []);
  assert.deepEqual(sprintProgress(null), []);
});

test('needsMyReview drops drafts, and PRs I already reviewed', () => {
  const prs = {
    login: 'jommar',
    approvalThreshold: 1,
    prsNeedingApprovals: [
      pr(1),
      pr(2, { draft: true }),
      pr(3, { reviews: { state: 'approved', approvers: ['jommar'], changesRequesters: [] } }),
      pr(4, {
        reviews: { state: 'changes_requested', approvers: [], changesRequesters: ['jommar'] },
      }),
      pr(5, { reviews: { state: 'approved', approvers: ['someone-else'], changesRequesters: [] } }),
    ],
  };
  assert.deepEqual(
    needsMyReview(prs).map((p) => p.number),
    [1, 5],
  );
  assert.deepEqual(needsMyReview(null), []);
});

test('myReviewsUnknown flags an all-null review set but not a genuinely empty one', () => {
  // reviewDataAvailable describes the non-mine fetch, so it cannot answer this.
  assert.equal(
    myReviewsUnknown({ prs: [pr(1, { reviews: null }), pr(2, { reviews: null })] }),
    true,
  );
  assert.equal(myReviewsUnknown({ prs: [pr(1), pr(2, { reviews: null })] }), false);
  assert.equal(myReviewsUnknown({ prs: [] }), false, 'no PRs is known, not unknown');
  assert.equal(myReviewsUnknown(null), true);
});

test('actionQueue orders tiers by urgency and each tier stalest-first', () => {
  const prs = {
    login: 'jommar',
    approvalThreshold: 1,
    prs: [
      pr(10, {
        reviews: { state: 'changes_requested', approvers: [], changesRequesters: ['bob'] },
        updatedAt: '2026-09-02T00:00:00Z',
      }),
      pr(11, {
        reviews: { state: 'changes_requested', approvers: [], changesRequesters: ['bob'] },
        updatedAt: '2026-08-30T00:00:00Z',
      }),
      pr(12, { reviews: { state: null, approvers: [], changesRequesters: [] } }),
      pr(13, { draft: true, reviews: { state: null, approvers: [], changesRequesters: [] } }),
      pr(14, { reviews: { state: 'approved', approvers: ['bob'], changesRequesters: [] } }),
    ],
    prsNeedingApprovals: [pr(20)],
  };
  const tickets = ticketsPayload([
    ticket('A-1', 'In Progress', [ACTIVE], '2026-09-03T00:00:00Z'),
    ticket('A-2', 'In Progress', [ACTIVE], '2026-08-28T00:00:00Z'),
    ticket('A-3', 'To Do', [ACTIVE]),
  ]);
  const tiers = actionQueue(prs, tickets);

  assert.deepEqual(
    tiers.map((t) => t.id),
    ['changes-requested', 'needs-approval', 'awaiting-approval', 'in-progress'],
  );
  // Stalest first within the tier.
  assert.deepEqual(
    tiers[0].items.map((p) => p.number),
    [11, 10],
  );
  // A draft and an already-approved PR are not waiting on approval.
  assert.deepEqual(
    tiers[2].items.map((p) => p.number),
    [12],
  );
  // Only In Progress tickets, oldest first.
  assert.deepEqual(
    tiers[3].items.map((t) => t.key),
    ['A-2', 'A-1'],
  );
});

test('capTiers spends the budget in tier order and counts the remainder', () => {
  const tiers = [
    { id: 'a', items: [1, 2, 3] },
    { id: 'b', items: [4, 5] },
    { id: 'c', items: [6] },
  ];
  const { tiers: kept, hidden } = capTiers(tiers, 4);
  assert.deepEqual(
    kept.map((t) => t.items),
    [[1, 2, 3], [4], []],
  );
  assert.equal(hidden, 2);

  const room = capTiers(tiers, 99);
  assert.equal(room.hidden, 0);
  assert.deepEqual(
    room.tiers.map((t) => t.items.length),
    [3, 2, 1],
  );
});

test('kpiCounts separates sprint total from sprint done', () => {
  const prs = {
    login: 'jommar',
    approvalThreshold: 1,
    prs: [pr(1), pr(2)],
    prsNeedingApprovals: [pr(3)],
  };
  const tickets = ticketsPayload([
    ticket('A-1', 'Done', [ACTIVE]),
    ticket('A-2', 'In Progress', [ACTIVE]),
    ticket('A-3', 'To Do', [NEXT]),
  ]);
  assert.deepEqual(kpiCounts(prs, tickets), {
    myPrs: 2,
    needsReview: 1,
    sprintTickets: 2,
    sprintDone: 1,
  });
  assert.deepEqual(kpiCounts(null, null), {
    myPrs: 0,
    needsReview: 0,
    sprintTickets: 0,
    sprintDone: 0,
  });
});

// ── Story points ────────────────────────────────────────────────────────────

test('pointsByCategory sums per band and ignores unestimated tickets', () => {
  const list = [
    pointed('A-1', 'To Do', [ACTIVE], 3),
    pointed('A-2', 'To Do', [ACTIVE], null),
    pointed('A-3', 'In Progress', [ACTIVE], 5),
    pointed('A-4', 'Done', [ACTIVE], 8),
    pointed('A-5', 'Done', [ACTIVE], 0),
  ];
  assert.deepEqual(pointsByCategory(list), { todo: 3, active: 5, done: 8 });
  // 0 is a real estimate, not a missing one — it must not inflate `unestimated`.
  const [p] = sprintProgress(ticketsPayload(list));
  assert.equal(p.unestimated, 1);
  assert.deepEqual(
    p.byBand.unestimated.map((t) => t.key),
    ['A-2'],
  );
});

test('sprintProgress reports points alongside untouched counts', () => {
  const list = [
    pointed('B-1', 'To Do', [ACTIVE], 2),
    pointed('B-2', 'In Progress', [ACTIVE], 1.5),
    pointed('B-3', 'Done', [ACTIVE], 0.5),
  ];
  const [p] = sprintProgress(ticketsPayload(list));
  assert.deepEqual(p.points, { todo: 2, active: 1.5, done: 0.5 });
  assert.equal(p.pointsTotal, 4);
  assert.equal(p.total, 3);
  // The pre-existing counts contract must not gain or lose a key.
  assert.deepEqual(Object.keys(p.counts).sort(), ['active', 'done', 'todo']);
  assert.deepEqual(p.counts, { todo: 1, active: 1, done: 1 });
});

test('sprintProgress counts a carried-in ticket toward the active sprint', () => {
  const list = [pointed('C-1', 'Done', [NEXT, ACTIVE], 13)];
  const [p] = sprintProgress(ticketsPayload(list));
  assert.equal(p.pointsTotal, 13);
  assert.deepEqual(
    p.byBand.done.map((t) => t.key),
    ['C-1'],
  );
});

test('sprintProgress reports zero points when nothing is estimated', () => {
  const list = [ticket('D-1', 'To Do', [ACTIVE]), ticket('D-2', 'Done', [ACTIVE])];
  const [p] = sprintProgress(ticketsPayload(list));
  assert.equal(p.pointsTotal, 0);
  assert.equal(p.unestimated, 2);
  // The count bar is the fallback, so counts still have to be right.
  assert.deepEqual(p.counts, { todo: 1, active: 0, done: 1 });
});

test('sprintProgress buckets tickets into byBand newest-first', () => {
  const list = [
    pointed('E-1', 'Done', [ACTIVE], 1, '2026-09-01T00:00:00Z'),
    pointed('E-2', 'Done', [ACTIVE], 2, '2026-09-04T00:00:00Z'),
    pointed('E-3', 'To Do', [ACTIVE], 3, '2026-09-02T00:00:00Z'),
  ];
  const [p] = sprintProgress(ticketsPayload(list));
  assert.deepEqual(
    p.byBand.done.map((t) => t.key),
    ['E-2', 'E-1'],
  );
  assert.deepEqual(
    p.byBand.todo.map((t) => t.key),
    ['E-3'],
  );
  assert.deepEqual(p.byBand.active, []);
});

test('two active sprints keep independent totals and lists', () => {
  const OTHER = { id: 99, name: 'Nexus Sprint 17', state: 'active' };
  const list = [pointed('F-1', 'Done', [ACTIVE], 5), pointed('F-2', 'To Do', [OTHER], 8)];
  const progress = sprintProgress(ticketsPayload(list, [ACTIVE, OTHER]));
  assert.equal(progress.length, 2);
  assert.equal(progress[0].pointsTotal, 5);
  assert.equal(progress[1].pointsTotal, 8);
  // Same display name, different board — identity must come from the id.
  assert.deepEqual(
    progress[1].byBand.todo.map((t) => t.key),
    ['F-2'],
  );
});

test('selectableSprints prefers the server list and falls back to tickets', () => {
  const server = { allSprints: [ACTIVE, PREV], groupsByCategory: {} };
  assert.deepEqual(
    selectableSprints(server).map((s) => s.id),
    [1404, 1299],
  );
  const derived = ticketsPayload(
    [ticket('G-1', 'Done', [PREV]), ticket('G-2', 'To Do', [ACTIVE])],
    [ACTIVE],
  );
  assert.deepEqual(
    selectableSprints(derived).map((s) => s.id),
    [1404, 1299],
  );
  assert.deepEqual(selectableSprints(null), []);
});

test('sprintProgressFor scopes a closed sprint independently of the active one', () => {
  const payload = ticketsPayload(
    [
      pointed('H-1', 'Done', [PREV], 5),
      pointed('H-2', 'Done', [ACTIVE], 8),
      pointed('H-3', 'Done', [NEXT, ACTIVE], 3),
    ],
    [ACTIVE],
  );
  payload.allSprints = [ACTIVE, NEXT, PREV];
  const prev = sprintProgressFor(payload, PREV);
  assert.equal(prev.total, 1);
  assert.equal(prev.pointsTotal, 5);
  assert.deepEqual(
    prev.byBand.done.map((t) => t.key),
    ['H-1'],
  );
  // The active entry is untouched by the closed selection.
  const active = sprintProgressFor(payload, ACTIVE);
  assert.equal(active.total, 2);
  assert.equal(active.pointsTotal, 11);
});

test('donePointsBySprint orders closed and active sprints chronologically', () => {
  const payload = ticketsPayload([
    pointed('V-1', 'Done', [PREV], 3),
    pointed('V-2', 'Done', [ACTIVE], 5),
    pointed('V-3', 'Done', [NEXT], 8),
  ]);
  payload.allSprints = [ACTIVE, NEXT, PREV];
  assert.deepEqual(
    donePointsBySprint(payload).map((entry) => entry.sprint.id),
    [1299, 1404],
  );
});

test('donePointsBySprint counts carried tickets in every listed sprint', () => {
  const payload = ticketsPayload([
    pointed('V-1', 'Done', [ACTIVE, PREV], 5),
    pointed('V-2', 'Done', [ACTIVE], null),
    pointed('V-3', 'In Progress', [ACTIVE], 13),
  ]);
  payload.allSprints = [ACTIVE, PREV];
  const [previous, active] = donePointsBySprint(payload);
  assert.deepEqual(
    { points: previous.points, count: previous.count, unestimated: previous.unestimated },
    { points: 5, count: 1, unestimated: 0 },
  );
  assert.deepEqual(
    { points: active.points, count: active.count, unestimated: active.unestimated },
    { points: 5, count: 2, unestimated: 1 },
  );
  assert.deepEqual(donePointsBySprint(null), []);
});
