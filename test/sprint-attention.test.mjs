import { test } from 'node:test';
import assert from 'node:assert/strict';

// Loaded inside each test so a missing module fails that test alone, by name.
const load = () => import('../ui/sprint-attention.js');

const ticket = (key, overrides = {}) => ({
  key,
  id: null,
  summary: `Invented work for ${key}`,
  status: 'In Progress',
  statusCategory: 'In Progress',
  issueType: 'Story',
  priority: 'Medium',
  updated: '2026-11-10T09:00:00.000Z',
  created: '2026-11-01T09:00:00.000Z',
  sprints: [],
  sprint: null,
  storyPoints: 3,
  assignee: 'Rowan Tester',
  ...overrides,
});

const side = (state, extra = {}) => ({ state, reason: null, ...extra });

const entry = (overrides = {}) => ({
  phase: null,
  state: 'none',
  reason: null,
  groom: side('none'),
  review: side('none'),
  specReview: side('none'),
  e2e: side('none'),
  ...overrides,
});

const loaded = { claudeLoaded: true };
const notStarted = { status: 'To Do', statusCategory: 'To Do' };

test('attention reasons fire one per rule, listed in table sequence', async () => {
  const { ATTENTION_REASONS, attentionReasons } = await load();

  assert.ok(Object.isFrozen(ATTENTION_REASONS));
  assert.deepEqual(
    ATTENTION_REASONS.map(({ id, label }) => ({ id, label })),
    [
      { id: 'claude-waiting', label: 'Claude waiting' },
      { id: 'groom-open', label: 'Groom: open questions' },
      { id: 'slack-reply', label: 'Slack reply owed' },
      { id: 'jira-blocked', label: 'Blocked' },
      { id: 'unassigned', label: 'Unassigned' },
      { id: 'no-estimate', label: 'No estimate' },
      { id: 'not-groomed', label: 'Not groomed' },
    ],
  );

  assert.deepEqual(attentionReasons(ticket('ABC-1'), entry({ groom: side('waiting') }), loaded), [
    'claude-waiting',
  ]);
  assert.deepEqual(
    attentionReasons(
      ticket('ABC-2'),
      entry({ groom: side('done', { verdict: 'NEEDS_INFO' }) }),
      loaded,
    ),
    ['groom-open'],
  );
  assert.deepEqual(attentionReasons(ticket('ABC-3', { status: 'Blocked' }), entry(), loaded), [
    'jira-blocked',
  ]);
  assert.deepEqual(attentionReasons(ticket('ABC-4', { assignee: null }), entry(), loaded), [
    'unassigned',
  ]);
  assert.deepEqual(attentionReasons(ticket('ABC-5', { storyPoints: null }), entry(), loaded), [
    'no-estimate',
  ]);
  assert.deepEqual(attentionReasons(ticket('ABC-6', notStarted), undefined, loaded), [
    'not-groomed',
  ]);

  assert.deepEqual(
    attentionReasons(
      ticket('ABC-7', { ...notStarted, assignee: null, storyPoints: null }),
      entry({ state: 'waiting' }),
      loaded,
    ),
    ['claude-waiting', 'unassigned', 'no-estimate', 'not-groomed'],
  );
});

test('a Slack thread that names the ticket and waits on a reply flags it, whatever Claude has read', async () => {
  const { CLAUDE_REASONS, attentionReasons } = await load();
  const thread = (needsReply) => ({
    ts: '1700000000.000100',
    url: 'https://example.invalid/t',
    needsReply,
  });

  assert.equal(CLAUDE_REASONS.includes('slack-reply'), false);
  assert.deepEqual(
    attentionReasons(ticket('ABC-1'), undefined, {
      ...loaded,
      slackLinks: [thread(false), thread(true)],
    }),
    ['slack-reply'],
  );
  assert.deepEqual(
    attentionReasons(ticket('ABC-2'), undefined, {
      claudeLoaded: false,
      slackLinks: [thread(true)],
    }),
    ['slack-reply'],
  );
  // Only a known reply owed counts: a quiet thread or an unknown reply state is no reason.
  assert.deepEqual(
    attentionReasons(ticket('ABC-3'), undefined, {
      ...loaded,
      slackLinks: [thread(false), thread(null), thread(undefined)],
    }),
    [],
  );
  assert.deepEqual(attentionReasons(ticket('ABC-4'), undefined, loaded), []);
  // In table sequence among the others, and never on a done ticket.
  assert.deepEqual(
    attentionReasons(
      ticket('ABC-5', { status: 'Blocked' }),
      entry({ groom: side('done', { verdict: 'NEEDS_INFO' }) }),
      { ...loaded, slackLinks: [thread(true)] },
    ),
    ['groom-open', 'slack-reply', 'jira-blocked'],
  );
  assert.deepEqual(
    attentionReasons(ticket('ABC-6', { status: 'Done', statusCategory: 'Done' }), undefined, {
      ...loaded,
      slackLinks: [thread(true)],
    }),
    [],
  );
});

test('no reason comes from unknown Claude state, a done ticket or started work', async () => {
  const { attentionReasons } = await load();
  const unloaded = { claudeLoaded: false };
  const toDoUnassigned = ticket('ABC-1', { ...notStarted, assignee: null });

  assert.deepEqual(attentionReasons(toDoUnassigned, entry({ state: 'waiting' }), unloaded), [
    'unassigned',
  ]);
  assert.deepEqual(
    attentionReasons(
      toDoUnassigned,
      entry({ groom: side('done', { verdict: 'BLOCKED' }), review: side('waiting') }),
      unloaded,
    ),
    ['unassigned'],
  );
  assert.deepEqual(attentionReasons(toDoUnassigned, undefined, unloaded), ['unassigned']);

  assert.deepEqual(
    attentionReasons(
      ticket('ABC-2', {
        status: 'Done',
        statusCategory: 'Done',
        storyPoints: null,
        assignee: null,
      }),
      undefined,
      loaded,
    ),
    [],
  );

  assert.deepEqual(attentionReasons(ticket('ABC-3'), undefined, loaded), []);
});

test('a status Jira files under Done is done even when the status table does not know it', async () => {
  const { attentionReasons, sprintSummary } = await load();
  const wontDo = ticket('ABC-1', {
    status: "Won't Do",
    statusCategory: 'Done',
    assignee: null,
    storyPoints: 2,
  });

  assert.deepEqual(attentionReasons(wontDo, undefined, loaded), []);
  assert.equal(sprintSummary([wontDo], { 'ABC-1': [] }).donePoints, 2);
});

test('Rejected and Duplicate filed under Done are finished: no reasons, no groom, done points', async () => {
  const { attentionReasons, groomCandidates, isFinished, sprintSummary } = await load();
  // Rejected reads as a blocked kind and Duplicate as a queued one, but Jira files both under Done.
  const rejected = ticket('ABC-1', {
    status: 'Rejected',
    statusCategory: 'Done',
    assignee: null,
    storyPoints: 2,
  });
  const duplicate = ticket('ABC-2', {
    status: 'Duplicate',
    statusCategory: 'Done',
    assignee: null,
    storyPoints: 3,
  });
  const deployed = ticket('ABC-3', { status: 'Deployed', statusCategory: 'Done' });
  const blocked = ticket('ABC-4', { status: 'Blocked', statusCategory: 'In Progress' });
  const queued = ticket('ABC-5', notStarted);

  assert.equal(isFinished(rejected), true);
  assert.equal(isFinished(duplicate), true);
  assert.equal(isFinished(deployed), true);
  assert.equal(isFinished(blocked), false);
  assert.equal(isFinished(queued), false);

  const tickets = [rejected, duplicate, queued];
  const reasonsByKey = Object.fromEntries(
    tickets.map((each) => [each.key, attentionReasons(each, undefined, loaded)]),
  );
  assert.deepEqual(reasonsByKey['ABC-1'], []);
  assert.deepEqual(reasonsByKey['ABC-2'], []);
  assert.deepEqual(groomCandidates(tickets, reasonsByKey, {}), ['ABC-5']);
  assert.equal(sprintSummary([rejected, duplicate, blocked], reasonsByKey).donePoints, 5);
});

test('summary totals count, points, done points, unestimated and reasons per id', async () => {
  const { sprintSummary } = await load();
  const tickets = [
    ticket('ABC-1', { status: 'Done', statusCategory: 'Done', storyPoints: 3 }),
    ticket('ABC-2', { storyPoints: 5 }),
    ticket('ABC-3', { ...notStarted, storyPoints: null }),
  ];
  const reasonsByKey = {
    'ABC-1': [],
    'ABC-2': ['unassigned'],
    'ABC-3': ['unassigned', 'no-estimate', 'not-groomed'],
  };

  const summary = sprintSummary(tickets, reasonsByKey);

  assert.equal(summary.count, 3);
  assert.equal(summary.points, 8);
  assert.equal(summary.donePoints, 3);
  assert.equal(summary.unestimated, 1);
  const expected = {
    'claude-waiting': 0,
    'groom-open': 0,
    'jira-blocked': 0,
    unassigned: 2,
    'no-estimate': 1,
    'not-groomed': 1,
  };
  for (const [id, count] of Object.entries(expected)) {
    assert.equal(summary.reasons[id] ?? 0, count, id);
  }
});

test('filter passes a ticket with any selected reason, and everything when none is selected', async () => {
  const { matchesReasons } = await load();
  const selected = ['unassigned', 'no-estimate'];

  assert.equal(matchesReasons(['unassigned'], selected), true);
  assert.equal(matchesReasons(['no-estimate', 'not-groomed'], selected), true);
  assert.equal(matchesReasons(['jira-blocked'], selected), false);
  assert.equal(matchesReasons([], selected), false);

  assert.equal(matchesReasons([], []), true);
  assert.equal(matchesReasons(['jira-blocked'], []), true);
});

test('order of the attention list drops clean tickets and sorts by first reason, then reason count', async () => {
  const { attentionOrder } = await load();
  const tickets = [ticket('ABC-1'), ticket('ABC-5'), ticket('ABC-7'), ticket('ABC-9')];
  const reasonsByKey = {
    'ABC-1': [],
    'ABC-5': ['unassigned'],
    'ABC-7': ['unassigned', 'no-estimate'],
    'ABC-9': ['jira-blocked'],
  };

  assert.deepEqual(
    attentionOrder(tickets, reasonsByKey).map(({ key }) => key),
    ['ABC-9', 'ABC-7', 'ABC-5'],
  );
});

test('groom batch takes five minus working sessions of eligible keys and reads each launch outcome', async () => {
  const { GROOM_BATCH_MAX, groomCandidates, groomOutcome } = await load();
  assert.equal(GROOM_BATCH_MAX, 5);

  const working = ['ABC-10', 'ABC-11'];
  const ungroomed = [
    'ABCDEFGHIJK-1',
    'ABC-1',
    'ABC-2',
    'ABC-3',
    'ABC-4',
    'ABC-5',
    'ABC-6',
    'ABC-7',
    'ABC-8',
  ];
  const tickets = [...working, ...ungroomed].map((key) => ticket(key, notStarted));
  const reasonsByKey = Object.fromEntries([
    ...working.map((key) => [key, []]),
    ...ungroomed.map((key) => [key, ['not-groomed']]),
  ]);
  const byTicket = Object.fromEntries(
    working.map((key) => [key, entry({ groom: side('working', { reason: 'running' }) })]),
  );

  assert.deepEqual(groomCandidates(tickets, reasonsByKey, byTicket), ['ABC-1', 'ABC-2', 'ABC-3']);

  const refusal = (code, reason, status) => ({
    ok: false,
    status,
    code,
    error: 'Claude action refused.',
    errors: [reason],
  });

  const skipped = groomOutcome(refusal('CLAUDE_REFUSED', 'session_running', 409));
  assert.equal(skipped.outcome, 'skipped');
  assert.equal(skipped.stop, false);

  const listing = groomOutcome(refusal('CLAUDE_REFUSED', 'listing_unavailable', 409));
  assert.equal(listing.outcome, 'failed');
  assert.equal(listing.stop, true);

  const failure = groomOutcome(refusal('CLAUDE_FAILED', 'spawn_failed', 502));
  assert.equal(failure.outcome, 'failed');
  assert.equal(failure.stop, true);

  const started = groomOutcome({ ok: true, status: 200, errors: [], ticket: entry() });
  assert.equal(started.outcome, 'started');
});
