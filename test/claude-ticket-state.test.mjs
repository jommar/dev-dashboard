// claude-ticket-state.test.mjs — the pure truth table that turns a ticket's two state files, the
// CLI listing and the clock into the entry the My Tickets card shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FIRST_ID,
  GROOM,
  GROOM_NAME,
  HOUR_MS,
  IMPLEMENT,
  IMPLEMENT_NAME,
  INVESTIGATE,
  INVESTIGATE_NAME,
  KEY,
  REVIEW,
  REVIEW_NAME,
  START_MS,
  answeredMap,
  launchRecord,
  listed,
  question,
  reviewEntry,
  reviewRecord,
  sessionUuid,
  statusFile,
  workingEntry,
} from './claude-launcher-fixture.mjs';

const TEN_SECONDS_MS = 10_000;
const SIXTY_SECONDS_MS = 60_000;
const TEN_MINUTES_MS = 600_000;
const ATTACH = { kind: 'attach', command: `claude attach ${FIRST_ID}` };
const RESUME = {
  kind: 'resume',
  command: `cd ~/pathwise && claude --resume ${sessionUuid(FIRST_ID)}`,
};
// The go-to command of a live (or blocked) session and of a finished one, by short id.
const attachFor = (id) => ({ kind: 'attach', command: `claude attach ${id}` });
const resumeFor = (id) => ({
  kind: 'resume',
  command: `cd ~/pathwise && claude --resume ${sessionUuid(id)}`,
});

// ---- independent review lifecycle; completion is not a passing-review verdict ----

test('review state: exported action is outside PHASES and never becomes the current workflow', async () => {
  const state = await import('../backend/claude-ticket-state.mjs');
  assert.equal(state.REVIEW, REVIEW);
  assert.deepEqual(state.PHASES, [INVESTIGATE, IMPLEMENT]);
  assert.equal(state.sessionName(KEY, REVIEW), REVIEW_NAME);
  assert.deepEqual(state.readLaunch({ [REVIEW]: reviewRecord() }), []);
  assert.equal(state.currentRecord({ [REVIEW]: reviewRecord() }), null);
});

const REVIEW_STATES = [
  ['no record', { launch: {} }, 'none', null, null],
  [
    'malformed record',
    { launch: { [REVIEW]: { name: 7, launchedAt: START_MS } } },
    'none',
    null,
    null,
  ],
  [
    'working',
    { entries: [reviewEntry({ state: 'working' })] },
    'working',
    'running',
    'session_running',
  ],
  [
    'starting',
    {
      launch: { [REVIEW]: reviewRecord({ launchedAt: START_MS - 10_000, id: null }) },
      entries: [],
    },
    'working',
    'starting',
    'session_running',
  ],
  ['blocked', { entries: [reviewEntry({ state: 'blocked' })] }, 'waiting', 'blocked', null],
  ['finished', { entries: [reviewEntry()] }, 'done', 'finished', null],
  [
    'idle but finished',
    { entries: [reviewEntry({ state: 'done', status: 'idle', pid: 4242 })] },
    'done',
    'finished',
    null,
  ],
  ['missing after start window', { entries: [] }, 'failed', 'session_missing', null],
  [
    'exactly at start-window boundary',
    {
      launch: { [REVIEW]: reviewRecord({ launchedAt: START_MS - 30_000, id: null }) },
      entries: [],
    },
    'failed',
    'session_missing',
    null,
  ],
  [
    'unfamiliar listed state',
    { entries: [reviewEntry({ state: 'paused' })] },
    'unknown',
    'unrecognised_state',
    'unrecognised_state',
  ],
  [
    'unavailable listing',
    { entries: null },
    'unknown',
    'listing_unavailable',
    'listing_unavailable',
  ],
  [
    'unavailable listing without a record',
    { launch: {}, entries: null },
    'none',
    null,
    'listing_unavailable',
  ],
];

for (const [label, overrides, state, reason, block] of REVIEW_STATES) {
  test(`review state: ${label} has its independent classification and launch block`, async () => {
    const entry = await derive({
      status: null,
      planPresent: false,
      launch: { [REVIEW]: reviewRecord() },
      entries: [reviewEntry()],
      ...overrides,
    });
    assert.deepEqual(entry.review, { state, reason });
    assert.equal(entry.blocks.review, block);
    assert.equal(entry.phase, null);
    assert.equal(entry.state, 'none');
    assert.deepEqual(entry.flags, {
      [INVESTIGATE]: false,
      [IMPLEMENT]: false,
      done: false,
      approved: false,
    });
    assert.deepEqual(entry.questions, []);
    assert.equal(entry.unanswered, 0);
    assert.equal(entry.unsent, false);
    assert.deepEqual(entry.goTo, GO_TO_NONE, 'no additional review go-to control');
  });
}

test('review state: review changes no workflow or groom fields, flags, questions, answers or go-to', async () => {
  const arrangements = [
    {},
    { status: statusFile({ investigate: true, questions: [question('q1')] }) },
    { entries: [workingEntry({ id: FIRST_ID })] },
    implementRun(),
    { status: null, planPresent: false },
    { entries: null },
  ];
  for (const arrangement of arrangements) {
    const launch = {
      [INVESTIGATE]: launchRecord({ id: FIRST_ID }),
      ...arrangement.launch,
      [GROOM]: groomRecord(),
    };
    const entries =
      arrangement.entries === null
        ? null
        : [
            ...(arrangement.entries ?? [listed({ id: FIRST_ID })]),
            groomEntry({ state: 'working' }),
          ];
    const base = await derive({ ...arrangement, launch, entries });
    const reviewed = await derive({
      ...arrangement,
      launch: { ...launch, [REVIEW]: reviewRecord({ launchedAt: START_MS - 1_000 }) },
      entries: entries === null ? null : [...entries, reviewEntry({ state: 'working' })],
    });
    const withoutReview = ({ review, blocks, ...rest }) => {
      const { review: ignored, rereview: alsoIgnored, ...otherBlocks } = blocks;
      void review;
      void ignored;
      void alsoIgnored;
      return { ...rest, blocks: otherBlocks };
    };
    assert.deepEqual(withoutReview(reviewed), withoutReview(base));
    assert.deepEqual(
      reviewed.review,
      entries === null
        ? { state: 'unknown', reason: 'listing_unavailable' }
        : { state: 'working', reason: 'running' },
    );
  }
});

test('review state: working workflow and groom sessions never block a new review', async () => {
  for (const phase of [INVESTIGATE, IMPLEMENT, GROOM]) {
    const name = `${KEY}-${phase}`;
    const entry = await derive({
      status: statusFile(),
      planPresent: false,
      launch: { [phase]: launchRecord({ name, id: FIRST_ID }) },
      entries: [workingEntry({ id: FIRST_ID, name })],
    });
    assert.deepEqual(entry.review, { state: 'none', reason: null });
    assert.equal(entry.blocks.review, null, phase);
  }
});

test('review state: resolves its own record by id and then name/time, not another action', async () => {
  const byId = await derive({
    launch: { [REVIEW]: reviewRecord() },
    entries: [
      reviewEntry(),
      reviewEntry({ id: 'eeee0005', state: 'working', startedAt: START_MS - 1_000 }),
      workingEntry({ id: FIRST_ID }),
    ],
  });
  assert.deepEqual(byId.review, { state: 'done', reason: 'finished' }, 'saved id wins');
  const launch = { [REVIEW]: reviewRecord({ id: null }) };
  const byName = await derive({
    launch,
    entries: [
      reviewEntry({ startedAt: START_MS - HOUR_MS - 1, state: 'working' }),
      reviewEntry({ id: 'eeee0005', startedAt: START_MS - HOUR_MS + 1 }),
      workingEntry({ id: FIRST_ID }),
    ],
  });
  assert.deepEqual(byName.review, { state: 'done', reason: 'finished' });
  const tooOld = await derive({
    launch,
    entries: [reviewEntry({ state: 'working', startedAt: START_MS - HOUR_MS - 1 })],
  });
  assert.deepEqual(tooOld.review, { state: 'failed', reason: 'session_missing' });
});

test('review state: unknown review fails closed without changing existing unfamiliar-groom policy', async () => {
  const entry = await derive({
    launch: { [GROOM]: groomRecord(), [REVIEW]: reviewRecord() },
    entries: [groomEntry({ state: 'paused' }), reviewEntry({ state: 'paused' })],
  });
  assert.deepEqual(entry.review, { state: 'unknown', reason: 'unrecognised_state' });
  assert.equal(entry.blocks.review, 'unrecognised_state');
  assert.deepEqual(entry.groom, { state: 'unknown', reason: 'unrecognised_state' });
  assert.equal(entry.blocks.groom, null, 'groom keeps its pre-existing unfamiliar-state policy');
});
// `goTo` is always one command per phase and one for the groom session; one that has none to give
// is null.
const GO_TO_NONE = { investigate: null, implement: null, groom: null };
const investigateOnly = (command) => ({ investigate: command, implement: null, groom: null });

// The entry for one ticket. Defaults: an investigate run launched an hour ago, its session listed
// and done, flag true, `done` true, no question, the plan on disk.
async function derive(overrides = {}) {
  const { deriveEntry } = await import('../backend/claude-ticket-state.mjs');
  return deriveEntry({
    status: statusFile({ investigate: true, done: true }),
    launch: { [INVESTIGATE]: launchRecord({ id: FIRST_ID }) },
    entries: [listed({ id: FIRST_ID })],
    now: START_MS,
    planPresent: true,
    ...overrides,
  });
}

const launchedAgo = (milliseconds, extra = {}) => ({
  [INVESTIGATE]: launchRecord({ launchedAt: START_MS - milliseconds, id: FIRST_ID, ...extra }),
});

// Both phases launched: investigate two hours ago (id aaaa0001), implement an hour ago (id bbbb0002).
const INVESTIGATE_ID = 'aaaa0001';
const IMPLEMENT_ID = 'bbbb0002';
const bothLaunched = (extra = {}) => ({
  [INVESTIGATE]: launchRecord({
    launchedAt: START_MS - 2 * HOUR_MS,
    id: INVESTIGATE_ID,
    ...extra.investigate,
  }),
  [IMPLEMENT]: launchRecord({
    name: IMPLEMENT_NAME,
    launchedAt: START_MS - HOUR_MS,
    id: IMPLEMENT_ID,
    ...extra.implement,
  }),
});

function assertEntry(entry, expected, label = '') {
  const prefix = label ? `${label}: ` : '';
  assert.equal(entry.state, expected.state, `${prefix}state`);
  assert.equal(entry.reason, expected.reason, `${prefix}reason`);
  if ('phase' in expected) assert.equal(entry.phase, expected.phase, `${prefix}phase`);
}

test('scenario 13: a working session is working and running', async () => {
  const entry = await derive({
    entries: [workingEntry({ id: FIRST_ID })],
    status: statusFile({ investigate: true }),
  });
  assertEntry(entry, { state: 'working', reason: 'running', phase: INVESTIGATE });
});

test('scenario 13: a launch ten seconds ago that the listing does not show is working and starting', async () => {
  const entry = await derive({
    launch: launchedAgo(TEN_SECONDS_MS, { id: null }),
    entries: [],
    status: statusFile(),
  });
  assertEntry(entry, { state: 'working', reason: 'starting' });
});

test('scenario 13: a blocked session without a pid is waiting and blocked with an attach command', async () => {
  const entry = await derive({
    entries: [listed({ id: FIRST_ID, state: 'blocked' })],
    status: statusFile(),
  });
  assertEntry(entry, { state: 'waiting', reason: 'blocked' });
  assert.deepEqual(entry.goTo, investigateOnly(ATTACH));
});

test('scenario 13: a done session with one unanswered question is waiting for answers and blocks implement only', async () => {
  const entry = await derive({
    entries: [listed({ id: FIRST_ID, state: 'done' })],
    status: statusFile({ investigate: true, questions: [question('q1')] }),
    planPresent: true,
  });
  assertEntry(entry, { state: 'waiting', reason: 'questions' });
  assert.equal(entry.unanswered, 1);
  assert.equal(entry.blocks.implement, 'questions_unanswered');
  assert.equal(entry.blocks.answer, null);
  assert.equal(entry.blocks.investigate, null);
});

test('scenario 14: a finished idle session with a pid is done with the plan ready and an attach command', async () => {
  const entry = await derive({
    entries: [listed({ id: FIRST_ID, state: 'done', pid: 4242, status: 'idle' })],
  });
  assertEntry(entry, { state: 'done', reason: 'plan_ready', phase: INVESTIGATE });
  assert.deepEqual(entry.goTo, investigateOnly(ATTACH));
  assert.equal(entry.blocks.implement, 'not_approved', 'the plan waits for the approval');
  assert.equal(entry.blocks.approve, null, 'and can be approved');
});

test('scenario 14: a finished session without a pid is done with the plan ready and a resume command', async () => {
  const entry = await derive({ entries: [listed({ id: FIRST_ID, state: 'done' })] });
  assertEntry(entry, { state: 'done', reason: 'plan_ready' });
  assert.deepEqual(entry.goTo, investigateOnly(RESUME));
  assert.equal(entry.blocks.implement, 'not_approved');
});

test('scenario 14: a session absent for ten minutes with the flag set is done without a go-to command', async () => {
  const entry = await derive({ launch: launchedAgo(TEN_MINUTES_MS), entries: [] });
  assertEntry(entry, { state: 'done', reason: 'plan_ready' });
  assert.deepEqual(entry.goTo, GO_TO_NONE);
  assert.equal(entry.blocks.implement, 'not_approved');
});

test('scenario 14: the implement phase with its flag set is done and implemented', async () => {
  const entry = await derive({
    status: statusFile({ investigate: true, implement: true }),
    launch: {
      [INVESTIGATE]: launchRecord({ launchedAt: START_MS - 2 * HOUR_MS, id: 'aaaa0001' }),
      [IMPLEMENT]: launchRecord({
        name: IMPLEMENT_NAME,
        launchedAt: START_MS - HOUR_MS,
        id: FIRST_ID,
      }),
    },
    entries: [listed({ id: 'aaaa0001' }), listed({ id: FIRST_ID })],
    planPresent: false,
  });
  assertEntry(entry, { state: 'done', reason: 'implemented', phase: IMPLEMENT });
});

test('scenario 15: a done session with the flag unset failed without finishing', async () => {
  const entry = await derive({
    status: statusFile(),
    entries: [listed({ id: FIRST_ID, state: 'done' })],
  });
  assertEntry(entry, { state: 'failed', reason: 'ended_without_flag' });
});

test('scenario 15: a session absent for sixty seconds with the flag unset failed as missing', async () => {
  const entry = await derive({
    status: statusFile(),
    launch: launchedAgo(SIXTY_SECONDS_MS),
    entries: [],
  });
  assertEntry(entry, { state: 'failed', reason: 'session_missing' });
});

test('scenario 15: the flag set with no plan file failed with the plan missing', async () => {
  const entry = await derive({
    status: statusFile({ investigate: true, done: true }),
    entries: [listed({ id: FIRST_ID, state: 'done' })],
    planPresent: false,
  });
  assertEntry(entry, { state: 'failed', reason: 'plan_missing' });
});

test('scenario 15: a ticket with no launch record is none and has no phase', async () => {
  for (const launch of [null, {}]) {
    const entry = await derive({ launch, entries: [] });
    assert.equal(entry.state, 'none', `launch ${JSON.stringify(launch)}`);
    assert.equal(entry.phase, null, `launch ${JSON.stringify(launch)}: phase`);
    assert.equal(entry.reason ?? null, null, `launch ${JSON.stringify(launch)}: reason`);
    assert.deepEqual(entry.goTo, GO_TO_NONE, `launch ${JSON.stringify(launch)}: goTo`);
  }
});

test('scenario 15: an unavailable listing is unknown, blocks every action and has no go-to command', async () => {
  const entry = await derive({ entries: null, launch: bothLaunched() });
  assertEntry(entry, { state: 'unknown', reason: 'listing_unavailable' });
  assert.deepEqual(entry.goTo, GO_TO_NONE);
  assert.deepEqual(entry.blocks, {
    investigate: 'listing_unavailable',
    implement: 'listing_unavailable',
    answer: 'listing_unavailable',
    resend: 'listing_unavailable',
    approve: 'listing_unavailable',
    groom: 'listing_unavailable',
    review: 'listing_unavailable',
    rereview: 'no_review_session',
  });
});

test('scenario 15: a session in an unrecognised state is unknown and has no go-to command', async () => {
  const entry = await derive({ entries: [listed({ id: FIRST_ID, state: 'paused' })] });
  assertEntry(entry, { state: 'unknown', reason: 'unrecognised_state' });
  assert.deepEqual(entry.goTo, GO_TO_NONE);
});

const RECORD_ID = 'ab12cd34';
const LAUNCHED_AT = START_MS - HOUR_MS;
const newerThan = (milliseconds) => LAUNCHED_AT + milliseconds;

async function resolve(entries, record) {
  const { resolveSession } = await import('../backend/claude-ticket-state.mjs');
  return resolveSession(entries, record) ?? null;
}

test('scenario 16: the recorded id wins over a newer session with the same name', async () => {
  const entries = [
    listed({ id: 'aaaa0001', startedAt: LAUNCHED_AT - 5_000 }),
    listed({ id: 'aaaa0002', startedAt: newerThan(1_000) }),
    workingEntry({ id: 'aaaa0003', startedAt: newerThan(9_000) }),
    listed({ id: RECORD_ID, name: 'a different name', startedAt: newerThan(500) }),
  ];
  const found = await resolve(entries, {
    name: INVESTIGATE_NAME,
    launchedAt: LAUNCHED_AT,
    id: RECORD_ID,
  });
  assert.equal(found?.sessionId, sessionUuid(RECORD_ID));
});

test('scenario 16: without a recorded id the newest same-name session not older than the launch wins', async () => {
  const entries = [
    listed({ id: 'aaaa0001', startedAt: LAUNCHED_AT - 5_000 }),
    listed({ id: 'aaaa0002', startedAt: newerThan(1_000) }),
    workingEntry({ id: 'aaaa0003', startedAt: newerThan(9_000) }),
    listed({ id: RECORD_ID, name: 'a different name', startedAt: newerThan(20_000) }),
  ];
  const record = { name: INVESTIGATE_NAME, launchedAt: LAUNCHED_AT, id: null };
  assert.equal((await resolve(entries, record))?.sessionId, sessionUuid('aaaa0003'));
  assert.equal(
    (await resolve(entries.slice(0, 2), record))?.sessionId,
    sessionUuid('aaaa0002'),
    'the newer of the two that remain',
  );
});

test('scenario 16: a same-name session that started before the launch never matches', async () => {
  const record = { name: INVESTIGATE_NAME, launchedAt: LAUNCHED_AT, id: null };
  const before = listed({ id: 'aaaa0001', startedAt: LAUNCHED_AT - 1 });
  assert.equal(await resolve([before], record), null);
  const atLaunch = listed({ id: 'aaaa0002', startedAt: LAUNCHED_AT });
  assert.equal((await resolve([before, atLaunch], record))?.sessionId, sessionUuid('aaaa0002'));
});

const TAINTED = {
  name: `${INVESTIGATE_NAME}; $(touch /tmp/sentinel-name)`,
  cwd: '/tmp/$(sentinel-cwd)',
};

// An entry the record matches by name, so only its ids decide the go-to command.
const byName = (extra) => ({
  launch: launchedAgo(HOUR_MS, { id: null, name: TAINTED.name }),
  entries: [listed({ ...TAINTED, ...extra })],
});

test('scenario 17: a listed id that is not eight hex characters gives no go-to command', async () => {
  const entry = await derive(
    byName({
      id: 'zz;rm',
      sessionId: sessionUuid(FIRST_ID),
      state: 'working',
      status: 'busy',
      pid: 4242,
    }),
  );
  assert.deepEqual(entry.goTo, GO_TO_NONE);
});

test('scenario 17: a session id that is not a UUID gives no go-to command', async () => {
  const entry = await derive(
    byName({ id: FIRST_ID, sessionId: 'not-a-uuid; rm -rf ~', state: 'done' }),
  );
  assert.deepEqual(entry.goTo, GO_TO_NONE);
});

test('scenario 17: valid ids give exactly the attach and resume commands and no listing text', async () => {
  const live = await derive(byName({ id: FIRST_ID, state: 'working', status: 'busy', pid: 4242 }));
  assert.deepEqual(live.goTo, investigateOnly(ATTACH));
  const finished = await derive(byName({ id: FIRST_ID, state: 'done' }));
  assert.deepEqual(finished.goTo, investigateOnly(RESUME));
  for (const { goTo } of [live, finished]) {
    assert.equal(
      goTo.investigate.command.includes('sentinel'),
      false,
      'no name or cwd text in a command',
    );
  }
});

test('scenario 42: a launch time in the future is not a start in progress', async () => {
  const launchedAhead = (milliseconds) => ({
    [INVESTIGATE]: launchRecord({ launchedAt: START_MS + milliseconds, id: null }),
  });
  const hourAhead = await derive({
    status: statusFile(),
    launch: launchedAhead(HOUR_MS),
    entries: [],
  });
  assertEntry(hourAhead, { state: 'failed', reason: 'session_missing' });
  const fiveSecondsAhead = await derive({
    status: statusFile(),
    launch: launchedAhead(5_000),
    entries: [],
  });
  assertEntry(fiveSecondsAhead, { state: 'working', reason: 'starting' });
});

// ---- sessions are named per phase, and each phase runs or not on its own ----

const LONGEST_KEY = 'ABCDEFGHIJ-1234567';
const MAX_NAME_LENGTH = 40;

test('scenario 63: a session is named after the ticket key and the phase, nothing else', async () => {
  const { sessionName } = await import('../backend/claude-ticket-state.mjs');
  assert.equal(sessionName(KEY, INVESTIGATE), 'TAP-1234-investigate-and-plan');
  assert.equal(sessionName(KEY, IMPLEMENT), 'TAP-1234-implement-plan');
  for (const phase of [INVESTIGATE, IMPLEMENT]) {
    const name = sessionName(LONGEST_KEY, phase);
    assert.equal(name, `${LONGEST_KEY}-${phase}`);
    assert.ok(
      name.length <= MAX_NAME_LENGTH,
      `${name.length} characters is within the CLI's limit`,
    );
  }
});

const BOTH_PHASES = {
  [INVESTIGATE]: launchRecord({
    name: INVESTIGATE_NAME,
    launchedAt: START_MS - 2 * HOUR_MS,
    id: null,
  }),
  [IMPLEMENT]: launchRecord({ name: IMPLEMENT_NAME, launchedAt: START_MS - HOUR_MS, id: null }),
};

test('scenario 64: each phase resolves only its own session, by name and by id', async () => {
  const { readLaunch, resolveSession, sessionRunning } =
    await import('../backend/claude-ticket-state.mjs');
  const records = Object.fromEntries(readLaunch(BOTH_PHASES).map((found) => [found.phase, found]));
  const investigating = workingEntry({
    id: 'aaaa0001',
    name: INVESTIGATE_NAME,
    startedAt: START_MS - 2 * HOUR_MS + 1_000,
  });
  const implementing = workingEntry({
    id: 'aaaa0002',
    name: IMPLEMENT_NAME,
    startedAt: START_MS - HOUR_MS + 1_000,
  });
  const running = (entries, phase, record = records[phase]) =>
    sessionRunning(entries, record, START_MS);

  assert.equal(
    running([implementing], INVESTIGATE),
    false,
    'investigate with only implement listed',
  );
  assert.equal(running([implementing], IMPLEMENT), true, 'implement with only implement listed');
  assert.equal(
    running([investigating], IMPLEMENT),
    false,
    'implement with only investigate listed',
  );
  assert.equal(
    running([investigating], INVESTIGATE),
    true,
    'investigate with only investigate listed',
  );

  const byId = (phase, id) => ({ ...records[phase], id });
  const entries = [
    listed({ id: 'aaaa0001', name: INVESTIGATE_NAME }),
    workingEntry({ id: 'aaaa0002', name: IMPLEMENT_NAME }),
  ];
  assert.equal(running(entries, INVESTIGATE, byId(INVESTIGATE, 'aaaa0001')), false, 'by id');
  assert.equal(running(entries, IMPLEMENT, byId(IMPLEMENT, 'aaaa0002')), true, 'by id');
  assert.equal(resolveSession(entries, byId(INVESTIGATE, 'aaaa0001'))?.id, 'aaaa0001');
  assert.equal(resolveSession(entries, byId(IMPLEMENT, 'aaaa0002'))?.id, 'aaaa0002');
});

const BLOCKS_WHILE_INVESTIGATING = {
  investigate: 'session_running',
  implement: 'investigate_running',
  answer: 'session_running',
  resend: 'session_running',
  approve: 'session_running',
  groom: null,
  review: null,
  rereview: 'no_review_session',
};
const BLOCKS_WHILE_IMPLEMENTING = {
  investigate: 'implement_running',
  implement: 'session_running',
  answer: 'session_running',
  resend: 'session_running',
  approve: 'session_running',
  groom: null,
  review: null,
  rereview: 'no_review_session',
};

test('scenario 65: while the investigate session runs, implement says investigate is running', async () => {
  const arrangements = {
    'listed and working': { entries: [workingEntry({ id: FIRST_ID })] },
    'launched ten seconds ago and not listed yet': {
      launch: launchedAgo(TEN_SECONDS_MS, { id: null }),
      entries: [],
    },
    'investigate launched after an older implement run': {
      launch: {
        [IMPLEMENT]: launchRecord({
          name: IMPLEMENT_NAME,
          launchedAt: START_MS - 2 * HOUR_MS,
          id: 'aaaa0002',
        }),
        [INVESTIGATE]: launchRecord({ launchedAt: START_MS - HOUR_MS, id: FIRST_ID }),
      },
      entries: [listed({ id: 'aaaa0002', name: IMPLEMENT_NAME }), workingEntry({ id: FIRST_ID })],
    },
  };
  for (const [label, arrangement] of Object.entries(arrangements)) {
    const entry = await derive(arrangement);
    assertEntry(entry, {
      state: 'working',
      reason: arrangement.entries.length ? 'running' : 'starting',
    });
    assert.deepEqual(entry.blocks, BLOCKS_WHILE_INVESTIGATING, label);
  }
});

// The implement run launched an hour ago, after an investigate run two hours ago.
const implementRun = (extra = {}) => ({
  launch: {
    [INVESTIGATE]: launchRecord({ launchedAt: START_MS - 2 * HOUR_MS, id: 'aaaa0001' }),
    [IMPLEMENT]: launchRecord({
      name: IMPLEMENT_NAME,
      launchedAt: START_MS - HOUR_MS,
      id: FIRST_ID,
    }),
  },
  entries: [listed({ id: 'aaaa0001' }), workingEntry({ id: FIRST_ID, name: IMPLEMENT_NAME })],
  ...extra,
});

test('scenario 66: while the implement session runs, investigate says implement is running', async () => {
  const arrangements = {
    'listed and working': implementRun(),
    'launched ten seconds ago and not listed yet': implementRun({
      launch: {
        [INVESTIGATE]: launchRecord({ launchedAt: START_MS - 2 * HOUR_MS, id: 'aaaa0001' }),
        [IMPLEMENT]: launchRecord({
          name: IMPLEMENT_NAME,
          launchedAt: START_MS - TEN_SECONDS_MS,
          id: null,
        }),
      },
      entries: [listed({ id: 'aaaa0001' })],
    }),
    'investigate record without an id and only the implement session listed': implementRun({
      launch: {
        [INVESTIGATE]: launchRecord({ launchedAt: START_MS - 2 * HOUR_MS, id: null }),
        [IMPLEMENT]: launchRecord({
          name: IMPLEMENT_NAME,
          launchedAt: START_MS - HOUR_MS,
          id: FIRST_ID,
        }),
      },
      entries: [workingEntry({ id: FIRST_ID, name: IMPLEMENT_NAME })],
    }),
  };
  for (const [label, arrangement] of Object.entries(arrangements)) {
    const entry = await derive(arrangement);
    assert.equal(entry.phase, IMPLEMENT, `${label}: phase`);
    assert.equal(entry.state, 'working', `${label}: state`);
    assert.deepEqual(entry.blocks, BLOCKS_WHILE_IMPLEMENTING, label);
  }
});

test('scenario 67: the running phase is the implement block reason before any other', async () => {
  const unplanned = { status: statusFile() };
  const noPlanFile = { status: statusFile({ investigate: true }), planPresent: false };
  const unanswered = {
    status: statusFile({ investigate: true, questions: [question('q1')] }),
  };
  for (const [label, other] of Object.entries({
    'not planned': unplanned,
    'plan file missing': noPlanFile,
    'questions unanswered': unanswered,
  })) {
    const investigating = await derive({ entries: [workingEntry({ id: FIRST_ID })], ...other });
    assert.equal(investigating.blocks.implement, 'investigate_running', `investigate, ${label}`);
    const implementing = await derive(implementRun(other));
    assert.equal(implementing.blocks.implement, 'session_running', `implement, ${label}`);
  }
});

// ---- the answers go back to the session: done, unsent and the implement gate ----

const ANSWERED = [question('q1', 'Portage-backend'), question('q2', 'Portage-frontend')];
const OPEN = [question('q1', 'Portage-backend'), question('q2')];
const SENT_AT = '2026-10-28T13:00:00.000Z';
const sentFor = (questions) => ({ at: SENT_AT, answers: answeredMap(questions) });

// A finished first run, flag set, its session done and the answers saved by the dashboard.
// `sent` is what launch.json recorded of the last send.
const planned = ({
  questions = ANSWERED,
  done = false,
  approved = false,
  sent,
  ...overrides
} = {}) => ({
  status: statusFile({ investigate: true, done, approved, questions }),
  launch: {
    [INVESTIGATE]: launchRecord({ id: FIRST_ID, answered: answeredMap(questions), sent }),
  },
  entries: [listed({ id: FIRST_ID })],
  ...overrides,
});

test('scenario 77: done is a flag of the entry and anything but true reads false', async () => {
  const withDone = (value) => ({ ...statusFile({ investigate: true }), done: value });
  const absent = statusFile({ investigate: true });
  delete absent.done;
  const cases = [
    ['true', withDone(true), true],
    ['false', withDone(false), false],
    ['absent', absent, false],
    ['a string', withDone('true'), false],
    ['a number', withDone(1), false],
    ['null', withDone(null), false],
    ['an object', withDone({}), false],
  ];
  for (const [label, status, expected] of cases) {
    const entry = await derive({ status });
    assert.deepEqual(
      entry.flags,
      { [INVESTIGATE]: true, [IMPLEMENT]: false, done: expected, approved: false },
      label,
    );
    assert.notEqual(entry.blocks.answer, 'status_unreadable', `${label}: the file is readable`);
    assert.notEqual(entry.state, 'unknown', `${label}: state`);
  }
});

test('scenario 78: implement waits for done, so with the flag set, nothing open and everything sent it is plan_not_done', async () => {
  const waiting = await derive(planned({ done: false, sent: sentFor(ANSWERED) }));
  assert.equal(waiting.blocks.implement, 'plan_not_done');
  const done = await derive(planned({ done: true, sent: sentFor(ANSWERED) }));
  assert.equal(done.blocks.implement, 'not_approved', 'done, but not approved');
  const approved = await derive(planned({ done: true, approved: true, sent: sentFor(ANSWERED) }));
  assert.equal(approved.blocks.implement, null, 'done and approved');
});

test('scenario 79: the implement block reasons come in order, answers_not_sent then plan_not_done last', async () => {
  const unplanned = { status: statusFile({ done: false, questions: ANSWERED }) };
  const sent = sentFor(ANSWERED);
  const cases = [
    ['not planned', planned({ done: false, ...unplanned }), 'not_planned'],
    [
      'plan file missing, answers unsent',
      planned({ done: false, planPresent: false }),
      'plan_missing',
    ],
    ['a question open', planned({ done: false, questions: OPEN }), 'questions_unanswered'],
    ['a question open, done', planned({ done: true, questions: OPEN }), 'questions_unanswered'],
    ['unsent, not done', planned({ done: false }), 'answers_not_sent'],
    ['unsent, done', planned({ done: true }), 'answers_not_sent'],
    ['sent, not done', planned({ done: false, sent }), 'plan_not_done'],
    ['sent, done, not approved', planned({ done: true, sent }), 'not_approved'],
    ['sent, done, approved', planned({ done: true, approved: true, sent }), null],
  ];
  for (const [label, arrangement, expected] of cases) {
    assert.equal((await derive(arrangement)).blocks.implement, expected, label);
  }
});

test('scenario 80: unsent is true only when the answers are complete, the flag is set, no implement run exists and the answers differ from the last send', async () => {
  const lastSend = sentFor(ANSWERED);
  const implementRecord = launchRecord({
    name: IMPLEMENT_NAME,
    launchedAt: START_MS - HOUR_MS / 2,
    id: 'aaaa0002',
  });
  const base = planned();
  const cases = [
    ['never sent', planned(), true],
    ['sent, nothing changed', planned({ sent: lastSend }), false],
    [
      'sent, one answer differs',
      planned({ sent: { ...lastSend, answers: { ...lastSend.answers, q2: 'f'.repeat(64) } } }),
      true,
    ],
    [
      'sent before the second question was answered',
      planned({ sent: { ...lastSend, answers: { q1: lastSend.answers.q1 } } }),
      true,
    ],
    ['a question open', planned({ questions: OPEN }), false],
    [
      'the flag not set',
      planned({ status: statusFile({ done: false, questions: ANSWERED }) }),
      false,
    ],
    [
      'an implement run exists',
      planned({
        launch: { ...base.launch, [IMPLEMENT]: implementRecord },
        entries: [listed({ id: FIRST_ID }), listed({ id: 'aaaa0002', name: IMPLEMENT_NAME })],
      }),
      false,
    ],
    ['the session works', planned({ entries: [workingEntry({ id: FIRST_ID })] }), false],
    ['the listing is unavailable', planned({ entries: null }), false],
  ];
  for (const [label, arrangement, expected] of cases) {
    assert.equal((await derive(arrangement)).unsent, expected, label);
  }
});

test('scenario 81: a finished first run is needs-you until its answers are sent, then ended or done by done', async () => {
  const legacy = planned({ questions: OPEN });
  delete legacy.status.done;
  const rows = [
    ['questions open', planned({ questions: OPEN }), 'waiting', 'questions'],
    ['all answered, not sent', planned(), 'waiting', 'answers_not_sent'],
    ['sent, done false', planned({ sent: sentFor(ANSWERED) }), 'failed', 'plan_not_done'],
    ['sent, done true', planned({ sent: sentFor(ANSWERED), done: true }), 'done', 'plan_ready'],
    ['no questions, done true', planned({ questions: [], done: true }), 'done', 'plan_ready'],
    ['an older file with no done and open questions', legacy, 'waiting', 'questions'],
  ];
  for (const [label, arrangement, state, reason] of rows) {
    assertEntry(await derive(arrangement), { state, reason, phase: INVESTIGATE }, label);
  }
});

test('scenario 82: while the investigate session works the entry is working, sent or not', async () => {
  const working = { entries: [workingEntry({ id: FIRST_ID })] };
  const arrangements = {
    'first run, questions open': planned({ questions: OPEN, ...working }),
    'answers complete, not sent': planned(working),
    'answers sent': planned({ sent: sentFor(ANSWERED), ...working }),
  };
  for (const [label, arrangement] of Object.entries(arrangements)) {
    const entry = await derive(arrangement);
    assertEntry(entry, { state: 'working', reason: 'running', phase: INVESTIGATE });
    assert.equal(entry.unsent, false, `${label}: unsent`);
    assert.deepEqual(
      entry.blocks,
      {
        investigate: 'session_running',
        implement: 'investigate_running',
        answer: 'session_running',
        resend: 'session_running',
        approve: 'session_running',
        groom: null,
        review: null,
        rereview: 'no_review_session',
      },
      label,
    );
  }
});

test('scenario 83: the implement phase does not read done', async () => {
  const entry = await derive({
    status: statusFile({ investigate: true, implement: true, done: false, questions: ANSWERED }),
    launch: {
      [INVESTIGATE]: launchRecord({
        launchedAt: START_MS - 2 * HOUR_MS,
        id: 'aaaa0001',
        answered: answeredMap(ANSWERED),
        sent: sentFor(ANSWERED),
      }),
      [IMPLEMENT]: launchRecord({
        name: IMPLEMENT_NAME,
        launchedAt: START_MS - HOUR_MS,
        id: FIRST_ID,
      }),
    },
    entries: [listed({ id: 'aaaa0001' }), listed({ id: FIRST_ID, name: IMPLEMENT_NAME })],
    planPresent: false,
  });
  assertEntry(entry, { state: 'done', reason: 'implemented', phase: IMPLEMENT });
  assert.equal(entry.unsent, false);
});

test('scenario 101: an entry that is unsent blocks implement as answers_not_sent, even with done true', async () => {
  const lastSend = sentFor(ANSWERED);
  const cases = [
    ['never sent, done true', planned({ done: true }), 'answers_not_sent'],
    ['never sent, done false', planned({ done: false }), 'answers_not_sent'],
    [
      'one answer changed since the send, done true',
      planned({
        done: true,
        sent: { ...lastSend, answers: { ...lastSend.answers, q2: 'f'.repeat(64) } },
      }),
      'answers_not_sent',
    ],
    [
      'a question answered after the send, done true',
      planned({ done: true, sent: { ...lastSend, answers: { q1: lastSend.answers.q1 } } }),
      'answers_not_sent',
    ],
    [
      'sent, nothing changed, done true',
      planned({ done: true, approved: true, sent: lastSend }),
      null,
    ],
    [
      'sent, nothing changed, done true, not approved',
      planned({ done: true, sent: lastSend }),
      'not_approved',
    ],
    [
      'sent, nothing changed, done false',
      planned({ done: false, sent: lastSend }),
      'plan_not_done',
    ],
  ];
  for (const [label, arrangement, expected] of cases) {
    const entry = await derive(arrangement);
    assert.equal(entry.blocks.implement, expected, `${label}: blocks.implement`);
    assert.equal(
      entry.unsent,
      expected === 'answers_not_sent',
      `${label}: the block and unsent agree`,
    );
  }
});

test('scenario 101: answers_not_sent never hides a running session, a missing plan or an open question', async () => {
  const cases = [
    [
      'the investigate session works',
      planned({ done: true, entries: [workingEntry({ id: FIRST_ID })] }),
      'investigate_running',
    ],
    ['the plan file is missing', planned({ done: true, planPresent: false }), 'plan_missing'],
    ['a question is open', planned({ done: true, questions: OPEN }), 'questions_unanswered'],
    [
      'the flag is not set',
      planned({ done: true, status: statusFile({ done: true, questions: ANSWERED }) }),
      'not_planned',
    ],
  ];
  for (const [label, arrangement, expected] of cases) {
    assert.equal((await derive(arrangement)).blocks.implement, expected, label);
  }
});

// ---- one go-to command per phase ----

const bothStatus = statusFile({ investigate: true, implement: false, done: true });

test('scenario 111: both phases launched give both commands at once, each from its own session', async () => {
  const rows = [
    [
      'investigate finished, implement live',
      [listed({ id: INVESTIGATE_ID }), workingEntry({ id: IMPLEMENT_ID, name: IMPLEMENT_NAME })],
      { investigate: resumeFor(INVESTIGATE_ID), implement: attachFor(IMPLEMENT_ID) },
    ],
    [
      'investigate live and idle, implement finished',
      [
        listed({ id: INVESTIGATE_ID, state: 'done', status: 'idle', pid: 4242 }),
        listed({ id: IMPLEMENT_ID, name: IMPLEMENT_NAME }),
      ],
      { investigate: attachFor(INVESTIGATE_ID), implement: resumeFor(IMPLEMENT_ID) },
    ],
    [
      'both finished',
      [listed({ id: INVESTIGATE_ID }), listed({ id: IMPLEMENT_ID, name: IMPLEMENT_NAME })],
      { investigate: resumeFor(INVESTIGATE_ID), implement: resumeFor(IMPLEMENT_ID) },
    ],
    [
      'investigate blocked, implement live',
      [
        listed({ id: INVESTIGATE_ID, state: 'blocked' }),
        workingEntry({ id: IMPLEMENT_ID, name: IMPLEMENT_NAME }),
      ],
      { investigate: attachFor(INVESTIGATE_ID), implement: attachFor(IMPLEMENT_ID) },
    ],
  ];
  for (const [label, entries, expected] of rows) {
    const entry = await derive({ status: bothStatus, launch: bothLaunched(), entries });
    assert.deepEqual(entry.goTo, { ...expected, groom: null }, label);
    assert.equal(
      entry.phase,
      IMPLEMENT,
      `${label}: the rest of the entry follows the current phase`,
    );
  }
});

test('scenario 112: each phase finds its own session by the saved id, whatever else carries its name', async () => {
  const entry = await derive({
    status: bothStatus,
    launch: bothLaunched(),
    entries: [
      listed({ id: INVESTIGATE_ID }),
      listed({ id: IMPLEMENT_ID, name: IMPLEMENT_NAME }),
      // Newer sessions with the same names that no record points at.
      listed({ id: 'cccc0003', startedAt: START_MS - 1_000 }),
      listed({ id: 'dddd0004', name: IMPLEMENT_NAME, startedAt: START_MS - 1_000 }),
    ],
  });
  assert.deepEqual(entry.goTo, {
    investigate: resumeFor(INVESTIGATE_ID),
    implement: resumeFor(IMPLEMENT_ID),
    groom: null,
  });
});

test('scenario 113: older records without an id resolve by name and start time, each for its own phase', async () => {
  const launch = bothLaunched({ investigate: { id: null }, implement: { id: null } });
  const investigateStart = START_MS - 2 * HOUR_MS;
  const implementStart = START_MS - HOUR_MS;
  const entry = await derive({
    status: bothStatus,
    launch,
    entries: [
      listed({ id: INVESTIGATE_ID, startedAt: investigateStart + 5_000 }),
      workingEntry({ id: IMPLEMENT_ID, name: IMPLEMENT_NAME, startedAt: implementStart + 5_000 }),
    ],
  });
  assert.deepEqual(entry.goTo, {
    investigate: resumeFor(INVESTIGATE_ID),
    implement: attachFor(IMPLEMENT_ID),
    groom: null,
  });

  const earlierRun = await derive({
    status: bothStatus,
    launch,
    entries: [
      listed({ id: INVESTIGATE_ID, startedAt: investigateStart + 5_000 }),
      listed({ id: IMPLEMENT_ID, name: IMPLEMENT_NAME, startedAt: implementStart - 1 }),
    ],
  });
  assert.deepEqual(
    earlierRun.goTo,
    { investigate: resumeFor(INVESTIGATE_ID), implement: null, groom: null },
    'an implement session that started before its launch is another run',
  );
});

test('scenario 114: a phase with no record has no command, even when a session carries its name', async () => {
  const investigateRecord = { [INVESTIGATE]: bothLaunched()[INVESTIGATE] };
  const implementRecord = { [IMPLEMENT]: bothLaunched()[IMPLEMENT] };
  const both = [listed({ id: INVESTIGATE_ID }), listed({ id: IMPLEMENT_ID, name: IMPLEMENT_NAME })];
  const onlyInvestigate = await derive({
    status: bothStatus,
    launch: investigateRecord,
    entries: both,
  });
  assert.deepEqual(onlyInvestigate.goTo, investigateOnly(resumeFor(INVESTIGATE_ID)));
  const onlyImplement = await derive({
    status: bothStatus,
    launch: implementRecord,
    entries: both,
  });
  assert.deepEqual(onlyImplement.goTo, {
    investigate: null,
    implement: resumeFor(IMPLEMENT_ID),
    groom: null,
  });
});

test('scenario 115: a session in an unknown state gives no command for its phase, and the other phase keeps its own', async () => {
  // Unrecognised, with and without a process: neither is something the dashboard can join.
  for (const extra of [{}, { pid: 4242, status: 'idle' }]) {
    const label = JSON.stringify(extra);
    const unrecognisedInvestigate = await derive({
      status: bothStatus,
      launch: bothLaunched(),
      entries: [
        listed({ id: INVESTIGATE_ID, state: 'paused', ...extra }),
        workingEntry({ id: IMPLEMENT_ID, name: IMPLEMENT_NAME }),
      ],
    });
    assert.deepEqual(
      unrecognisedInvestigate.goTo,
      { investigate: null, implement: attachFor(IMPLEMENT_ID), groom: null },
      `investigate ${label}`,
    );

    const unrecognisedImplement = await derive({
      status: bothStatus,
      launch: bothLaunched(),
      entries: [
        listed({ id: INVESTIGATE_ID }),
        listed({ id: IMPLEMENT_ID, name: IMPLEMENT_NAME, state: 'paused', ...extra }),
      ],
    });
    assert.deepEqual(
      unrecognisedImplement.goTo,
      { investigate: resumeFor(INVESTIGATE_ID), implement: null, groom: null },
      `implement ${label}`,
    );
  }
});

// ---- the groom record: a session of its own, outside the workflow ----

const GROOM_ID = 'cccc0003';
const groomRecord = (extra = {}) =>
  launchRecord({ name: GROOM_NAME, launchedAt: START_MS - HOUR_MS, id: GROOM_ID, ...extra });
const groomEntry = (extra = {}) => listed({ id: GROOM_ID, name: GROOM_NAME, ...extra });
// A ticket that was only groomed: launch.json holds the groom record and status.json does not exist,
// which the launcher reads as an empty object.
const groomed = (overrides = {}) =>
  derive({
    status: {},
    launch: { [GROOM]: groomRecord() },
    entries: [groomEntry()],
    planPresent: false,
    ...overrides,
  });
const WITHOUT_GROOM = (entry) => {
  const { goTo, blocks, ...rest } = entry;
  delete rest.groom;
  return {
    ...rest,
    goTo: { investigate: goTo.investigate, implement: goTo.implement },
    blocks: {
      investigate: blocks.investigate,
      implement: blocks.implement,
      answer: blocks.answer,
      resend: blocks.resend,
      approve: blocks.approve,
    },
  };
};

test('scenario 210: groom is a name of its own and the workflow phases stay two', async () => {
  const state = await import('../backend/claude-ticket-state.mjs');

  assert.equal(state.GROOM, 'groom');
  assert.deepEqual(state.PHASES, [INVESTIGATE, IMPLEMENT], 'groom is not a workflow phase');
  assert.equal(state.sessionName(KEY, state.GROOM), GROOM_NAME);
  assert.equal(GROOM_NAME, 'TAP-1234-groom');
  assert.deepEqual(state.readLaunch({ [GROOM]: groomRecord() }), [], 'readLaunch ignores groom');
  assert.equal(state.currentRecord({ [GROOM]: groomRecord() }), null, 'no current phase');
});

test('scenario 211: readGroom gives the groom record of launch.json, validated like a phase record', async () => {
  const { readGroom } = await import('../backend/claude-ticket-state.mjs');
  assert.equal(typeof readGroom, 'function', 'the module exports readGroom');

  const record = readGroom({ [GROOM]: groomRecord() });
  assert.equal(record.name, GROOM_NAME);
  assert.equal(record.launchedAt, START_MS - HOUR_MS);
  assert.equal(record.id, GROOM_ID);
  assert.equal(
    readGroom({ [GROOM]: groomRecord(), [INVESTIGATE]: launchRecord() }).name,
    GROOM_NAME,
    'beside a workflow record',
  );
  assert.equal(readGroom({ [GROOM]: groomRecord({ id: null }) }).id, null, 'no id');
  for (const id of ['AB12CD34', 'ab12cd3', 'ab12cd345', 'ab12cd3g', 7, {}]) {
    assert.equal(readGroom({ [GROOM]: groomRecord({ id }) }).id, null, `id ${JSON.stringify(id)}`);
  }
});

test('scenario 211: readGroom is null when there is no record or it is not shaped like one', async () => {
  const { readGroom } = await import('../backend/claude-ticket-state.mjs');
  const record = groomRecord();
  const bad = {
    'a launch that is null': null,
    'a launch that is not an object': 'groom',
    'a launch with no groom': { [INVESTIGATE]: launchRecord() },
    'a groom that is null': { [GROOM]: null },
    'a groom that is a string': { [GROOM]: 'TAP-1234-groom' },
    'a name that is not text': { [GROOM]: { ...record, name: 7 } },
    'no name': { [GROOM]: { launchedAt: record.launchedAt, id: record.id } },
    'a launch time that is not a number': { [GROOM]: { ...record, launchedAt: '1' } },
    'a launch time that is not finite': { [GROOM]: { ...record, launchedAt: Infinity } },
    'no launch time': { [GROOM]: { name: record.name, id: record.id } },
  };
  for (const [label, launch] of Object.entries(bad)) assert.equal(readGroom(launch), null, label);
});

const NOW_MS = START_MS;
const GROOM_STATES = [
  ['a working session', { entries: [groomEntry({ state: 'working' })] }, 'working', 'running'],
  [
    'a launch ten seconds ago that is not listed yet',
    { launch: { [GROOM]: groomRecord({ launchedAt: NOW_MS - 10_000, id: null }) }, entries: [] },
    'working',
    'starting',
  ],
  ['a blocked session', { entries: [groomEntry({ state: 'blocked' })] }, 'waiting', 'blocked'],
  ['a finished session', { entries: [groomEntry({ state: 'done' })] }, 'done', 'finished'],
  [
    'a finished session that is still idle',
    { entries: [groomEntry({ state: 'done', pid: 4242, status: 'idle' })] },
    'done',
    'finished',
  ],
  [
    'a session in a state the dashboard does not know',
    { entries: [groomEntry({ state: 'paused' })] },
    'unknown',
    'unrecognised_state',
  ],
  ['a listing that is not available', { entries: null }, 'unknown', 'listing_unavailable'],
  [
    'a session that is not listed an hour after its launch',
    { entries: [] },
    'failed',
    'session_missing',
  ],
  [
    'a launch time an hour in the future that is not listed',
    { launch: { [GROOM]: groomRecord({ launchedAt: NOW_MS + HOUR_MS, id: null }) }, entries: [] },
    'failed',
    'session_missing',
  ],
];

for (const [label, arrangement, state, reason] of GROOM_STATES) {
  test(`scenario 212: ${label} is groom ${state} (${reason})`, async () => {
    const entry = await groomed(arrangement);

    assert.deepEqual(entry.groom, { state, reason });
  });
}

test('scenario 212: a ticket with no groom record has groom none, whatever else it holds', async () => {
  for (const launch of [null, {}, { [INVESTIGATE]: launchRecord({ id: FIRST_ID }) }]) {
    const entry = await derive({ launch, entries: [listed({ id: FIRST_ID })] });
    assert.deepEqual(entry.groom, { state: 'none', reason: null }, JSON.stringify(launch));
  }
  const unavailable = await derive({ entries: null });
  assert.deepEqual(unavailable.groom, { state: 'none', reason: null }, 'even with no listing');
});

test('scenario 212: a groom record that is not shaped like one is no record', async () => {
  const entry = await groomed({ launch: { [GROOM]: { name: 7, launchedAt: START_MS, id: null } } });

  assert.deepEqual(entry.groom, { state: 'none', reason: null });
  assert.equal(entry.goTo.groom, null);
  assert.equal(entry.blocks.groom, null);
});

test('scenario 213: a ticket that was only groomed reads as a ticket never started', async () => {
  for (const [label, entries] of [
    ['working', [groomEntry({ state: 'working' })]],
    ['done', [groomEntry({ state: 'done' })]],
    ['missing', []],
  ]) {
    const entry = await groomed({ entries });

    assert.equal(entry.state, 'none', `${label}: state`);
    assert.equal(entry.reason, null, `${label}: reason`);
    assert.equal(entry.phase, null, `${label}: phase`);
    assert.deepEqual(
      entry.flags,
      { [INVESTIGATE]: false, [IMPLEMENT]: false, done: false, approved: false },
      `${label}: flags`,
    );
    assert.deepEqual(entry.questions, [], `${label}: questions`);
    assert.equal(entry.unanswered, 0, `${label}: unanswered`);
    assert.equal(entry.unsent, false, `${label}: unsent`);
    assert.deepEqual(
      WITHOUT_GROOM(entry).blocks,
      {
        investigate: null,
        implement: 'not_planned',
        answer: 'no_questions',
        resend: 'no_questions',
        approve: 'not_planned',
      },
      `${label}: the workflow blocks are those of a ticket never started`,
    );
  }
});

test('scenario 214: a groom record changes no workflow field of the entry', async () => {
  const both = { status: bothStatus, launch: bothLaunched() };
  const arrangements = {
    'a finished plan': {},
    'a working investigate session': { entries: [workingEntry({ id: FIRST_ID })] },
    'a plan waiting for an answer': {
      status: statusFile({ investigate: true, questions: [question('q1')] }),
    },
    'a failed plan': { status: statusFile(), entries: [listed({ id: FIRST_ID })] },
    'both phases launched': {
      ...both,
      entries: [listed({ id: INVESTIGATE_ID }), listed({ id: IMPLEMENT_ID, name: IMPLEMENT_NAME })],
    },
    'an implement session that works': {
      ...both,
      entries: [
        listed({ id: INVESTIGATE_ID }),
        workingEntry({ id: IMPLEMENT_ID, name: IMPLEMENT_NAME }),
      ],
    },
    'no listing': { entries: null },
  };
  for (const [label, arrangement] of Object.entries(arrangements)) {
    const plain = await derive(arrangement);
    const base = { launch: { [INVESTIGATE]: launchRecord({ id: FIRST_ID }) }, ...arrangement };
    const entries =
      arrangement.entries === null
        ? null
        : [
            ...(arrangement.entries ?? [listed({ id: FIRST_ID })]),
            groomEntry({ state: 'working' }),
          ];
    const withGroom = await derive({
      ...arrangement,
      launch: { ...base.launch, [GROOM]: groomRecord() },
      entries,
    });

    assert.deepEqual(WITHOUT_GROOM(withGroom), WITHOUT_GROOM(plain), label);
    assert.notEqual(withGroom.groom.state, 'none', `${label}: the groom record was read`);
  }
});

test('scenario 214: a groom launch newer than the workflow does not become the current phase', async () => {
  const entry = await derive({
    status: statusFile({ investigate: true, implement: true }),
    launch: { ...bothLaunched(), [GROOM]: groomRecord({ launchedAt: START_MS - 1_000 }) },
    entries: [
      listed({ id: INVESTIGATE_ID }),
      listed({ id: IMPLEMENT_ID, name: IMPLEMENT_NAME }),
      groomEntry({ state: 'working', startedAt: START_MS - 500 }),
    ],
  });

  assertEntry(entry, { state: 'done', reason: 'implemented', phase: IMPLEMENT });
  assert.deepEqual(entry.groom, { state: 'working', reason: 'running' });
});

test('scenario 215: a running groom session blocks only groom, and only while it works', async () => {
  const workflow = {
    status: statusFile({ investigate: true, questions: [question('q1')] }),
    launch: { [INVESTIGATE]: launchRecord({ id: FIRST_ID }), [GROOM]: groomRecord() },
  };
  const withGroom = (groom, extra = {}) =>
    derive({ ...workflow, ...extra, entries: [listed({ id: FIRST_ID }), groom] });

  const working = await withGroom(groomEntry({ state: 'working' }));
  assert.deepEqual(
    working.blocks,
    {
      investigate: null,
      implement: 'questions_unanswered',
      answer: null,
      resend: 'questions_unanswered',
      approve: 'questions_unanswered',
      groom: 'session_running',
      review: null,
      rereview: 'no_review_session',
    },
    'investigate, implement and answers are as without a groom session',
  );
  const starting = await derive({
    ...workflow,
    launch: { ...workflow.launch, [GROOM]: groomRecord({ launchedAt: NOW_MS - 10_000, id: null }) },
    entries: [listed({ id: FIRST_ID })],
  });
  assert.equal(starting.blocks.groom, 'session_running', 'inside its start window');

  for (const state of ['done', 'blocked']) {
    const entry = await withGroom(groomEntry({ state }));
    assert.equal(entry.blocks.groom, null, `a ${state} groom session blocks nothing`);
  }
  const missing = await derive({ ...workflow, entries: [listed({ id: FIRST_ID })] });
  assert.equal(missing.blocks.groom, null, 'a session that is gone blocks nothing');
});

test('scenario 215: a running workflow session never blocks groom', async () => {
  const running = [
    [
      'investigate',
      { [INVESTIGATE]: launchRecord({ id: FIRST_ID }) },
      [workingEntry({ id: FIRST_ID })],
    ],
    [
      'implement',
      bothLaunched(),
      [listed({ id: INVESTIGATE_ID }), workingEntry({ id: IMPLEMENT_ID, name: IMPLEMENT_NAME })],
    ],
  ];
  for (const [label, launch, sessions] of running) {
    const entry = await derive({
      status: bothStatus,
      launch: { ...launch, [GROOM]: groomRecord() },
      entries: [...sessions, groomEntry()],
    });

    assert.equal(entry.state, 'working', `${label}: the workflow is working`);
    assert.equal(entry.blocks.groom, null, `${label}: groom is not blocked`);
  }
  const startingInvestigate = await derive({
    launch: { [INVESTIGATE]: launchRecord({ launchedAt: NOW_MS - 10_000, id: null }) },
    entries: [],
    status: statusFile(),
  });
  assert.equal(startingInvestigate.blocks.groom, null, 'not while investigate is starting either');
});

test('scenario 215: groom is blocked when the listing is not available, like every action', async () => {
  const groomOnly = await groomed({ entries: null });
  assert.equal(groomOnly.blocks.groom, 'listing_unavailable', 'a groom-only ticket');
  const workflow = await derive({ entries: null });
  assert.equal(workflow.blocks.groom, 'listing_unavailable', 'a workflow ticket');
});

test('scenario 216: goTo.groom joins the groom session by the command for its state, and no other key moves', async () => {
  const rows = [
    [
      'a working session',
      groomEntry({ state: 'working', pid: 4242, status: 'busy' }),
      attachFor(GROOM_ID),
    ],
    ['a blocked session', groomEntry({ state: 'blocked' }), attachFor(GROOM_ID)],
    [
      'an idle live session',
      groomEntry({ state: 'done', pid: 4242, status: 'idle' }),
      attachFor(GROOM_ID),
    ],
    ['a finished session', groomEntry({ state: 'done' }), resumeFor(GROOM_ID)],
    ['a state that is not known', groomEntry({ state: 'paused' }), null],
  ];
  for (const [label, session, expected] of rows) {
    const entry = await groomed({ entries: [session] });
    assert.deepEqual(entry.goTo, { ...GO_TO_NONE, groom: expected }, label);
  }
  assert.equal((await groomed({ entries: [] })).goTo.groom, null, 'a session that is not listed');
  assert.equal((await groomed({ entries: null })).goTo.groom, null, 'no listing');
  assert.equal(
    (await derive({ entries: [groomEntry()] })).goTo.groom,
    null,
    'a ticket with no groom record, even with a session of that name',
  );
});

test('scenario 216: goTo.groom finds the session by the saved id, or by name and start time without one', async () => {
  const newerSameName = groomEntry({ id: 'dddd0004', startedAt: START_MS - 1_000 });
  const byId = await groomed({ entries: [groomEntry(), newerSameName] });
  assert.deepEqual(byId.goTo.groom, resumeFor(GROOM_ID), 'the id wins over a newer same-name run');

  const noId = { [GROOM]: groomRecord({ id: null }) };
  const start = START_MS - HOUR_MS;
  const byName = await groomed({
    launch: noId,
    entries: [groomEntry({ startedAt: start + 5_000 })],
  });
  assert.deepEqual(byName.goTo.groom, resumeFor(GROOM_ID));
  const earlier = await groomed({ launch: noId, entries: [groomEntry({ startedAt: start - 1 })] });
  assert.equal(earlier.goTo.groom, null, 'a session that started before the launch is another run');
});

test('scenario 216: each of the three records gets the command of its own session', async () => {
  const entry = await derive({
    status: bothStatus,
    launch: { ...bothLaunched(), [GROOM]: groomRecord() },
    entries: [
      listed({ id: INVESTIGATE_ID }),
      workingEntry({ id: IMPLEMENT_ID, name: IMPLEMENT_NAME }),
      groomEntry({ state: 'blocked' }),
    ],
  });

  assert.deepEqual(entry.goTo, {
    investigate: resumeFor(INVESTIGATE_ID),
    implement: attachFor(IMPLEMENT_ID),
    groom: attachFor(GROOM_ID),
  });
});

// ---- approve and resend: the gates of the two planning-session messages ----

test('approve block: the plan must be ready and done, with no implement run and no approval yet', async () => {
  const sent = sentFor(ANSWERED);
  const withImplement = (arrangement) => ({
    ...arrangement,
    launch: {
      ...arrangement.launch,
      [IMPLEMENT]: launchRecord({ name: IMPLEMENT_NAME, id: IMPLEMENT_ID }),
    },
  });
  const cases = [
    ['unreadable status', { ...planned({ done: true, sent }), status: null }, 'status_unreadable'],
    [
      'not planned',
      { ...planned({ done: true, sent }), status: statusFile({ done: true, questions: ANSWERED }) },
      'not_planned',
    ],
    ['plan file missing', planned({ done: true, sent, planPresent: false }), 'plan_missing'],
    ['a question open', planned({ done: true, questions: OPEN }), 'questions_unanswered'],
    ['answers unsent', planned({ done: true }), 'answers_not_sent'],
    ['not done', planned({ done: false, sent }), 'plan_not_done'],
    ['done', planned({ done: true, sent }), null],
    ['already approved', planned({ done: true, approved: true, sent }), 'already_approved'],
    ['an implement run', withImplement(planned({ done: true, sent })), 'implement_started'],
  ];
  for (const [label, arrangement, expected] of cases) {
    assert.equal((await derive(arrangement)).blocks.approve, expected, label);
  }
});

test('approve block: only a true flag counts, and a status without the key reads as not approved', async () => {
  const sent = sentFor(ANSWERED);
  const absent = planned({ done: true, sent });
  delete absent.status.approved;
  const entry = await derive(absent);
  assert.equal(entry.flags.approved, false, 'absent is false');
  assert.equal(entry.blocks.approve, null, 'and can be approved');
  assert.equal(entry.blocks.implement, 'not_approved', 'and does not open implement');
  for (const value of ['true', 1, null, {}]) {
    const odd = planned({ done: true, sent });
    odd.status.approved = value;
    const result = await derive(odd);
    assert.equal(result.flags.approved, false, `${JSON.stringify(value)} reads false`);
    assert.equal(result.blocks.implement, 'not_approved', JSON.stringify(value));
  }
});

test('approve: the entry carries when the approval was given', async () => {
  const sent = sentFor(ANSWERED);
  const arrangement = planned({ done: true, approved: true, sent });
  arrangement.launch[INVESTIGATE].approved = { at: '2026-11-09T21:50:00.000Z' };

  const entry = await derive(arrangement);

  assert.equal(entry.approvedAt, '2026-11-09T21:50:00.000Z');
  assert.equal((await derive(planned({ done: true, sent }))).approvedAt, null);
});

test('resend block: the gates of a send, whether or not anything changed, and not the done flag', async () => {
  const sent = sentFor(ANSWERED);
  const cases = [
    ['unreadable status', { ...planned({ sent }), status: null }, 'status_unreadable'],
    ['no questions', planned({ questions: [], sent }), 'no_questions'],
    ['a question open', planned({ questions: OPEN }), 'questions_unanswered'],
    [
      'not planned',
      { ...planned({ sent }), status: statusFile({ questions: ANSWERED }) },
      'not_planned',
    ],
    ['nothing changed, not done', planned({ done: false, sent }), null],
    ['nothing changed, done', planned({ done: true, sent }), null],
    ['never sent', planned({ done: true }), null],
  ];
  for (const [label, arrangement, expected] of cases) {
    assert.equal((await derive(arrangement)).blocks.resend, expected, label);
  }
  const withImplement = {
    ...planned({ sent }),
    launch: {
      ...planned({ sent }).launch,
      [IMPLEMENT]: launchRecord({ name: IMPLEMENT_NAME, id: IMPLEMENT_ID }),
    },
  };
  assert.equal((await derive(withImplement)).blocks.resend, 'implement_started');
});

test('answersToSend: a resend lists every id even when nothing changed, a plain send skips', async () => {
  const { answersToSend } = await import('../backend/claude-ticket-state.mjs');
  const { status, launch } = planned({ done: true, sent: sentFor(ANSWERED) });

  assert.deepEqual(answersToSend(status, launch), { skip: 'unchanged' });
  const again = answersToSend(status, launch, { resend: true });
  assert.deepEqual(
    again.changed,
    ANSWERED.map(({ id }) => id),
  );
});

// ---- `stopped` (a session ended with `claude stop`, listed with pid null) is a finished session ----

const STOPPED = { state: 'stopped', pid: null };
const ENDED_PLAN = {
  status: statusFile({
    investigate: true,
    done: true,
    questions: [question('q1', 'Portage-backend')],
  }),
  launch: {
    [INVESTIGATE]: launchRecord({
      id: FIRST_ID,
      answered: answeredMap([question('q1', 'Portage-backend')]),
      sent: {
        at: START_MS - HOUR_MS,
        answers: answeredMap([question('q1', 'Portage-backend')]),
      },
    }),
  },
};

test('stopped: a plan session ended with claude stop is done, resumable, and keeps Approve and Resend open', async () => {
  const entry = await derive({ ...ENDED_PLAN, entries: [listed({ id: FIRST_ID, ...STOPPED })] });

  assertEntry(entry, { state: 'done', reason: 'plan_ready', phase: INVESTIGATE });
  assert.deepEqual(entry.goTo, investigateOnly(RESUME), 'the resume command, as for done');
  assert.equal(entry.blocks.approve, null);
  assert.equal(entry.blocks.resend, null);
  assert.equal(entry.blocks.answer, null);
  assert.equal(entry.blocks.investigate, null);
  assert.equal(entry.blocks.implement, 'not_approved', 'only the approval is missing');
});

test('stopped: every entry reads exactly as it does for a done session without a pid', async () => {
  const scenarios = {
    'plan ready': ENDED_PLAN,
    'plan not marked done': {
      ...ENDED_PLAN,
      status: { ...ENDED_PLAN.status, done: false },
    },
    'approved plan': { ...ENDED_PLAN, status: { ...ENDED_PLAN.status, approved: true } },
    'open question': {
      ...ENDED_PLAN,
      status: statusFile({ investigate: true, questions: [question('q1')] }),
    },
    'plan flag never set': { status: statusFile(), launch: ENDED_PLAN.launch },
  };
  for (const [label, scenario] of Object.entries(scenarios)) {
    const done = await derive({ ...scenario, entries: [listed({ id: FIRST_ID, state: 'done' })] });
    const stopped = await derive({
      ...scenario,
      entries: [listed({ id: FIRST_ID, ...STOPPED })],
    });
    assert.deepEqual(stopped, done, label);
  }
});

test('stopped: an implement session ended with claude stop is implemented and resumable', async () => {
  const entry = await derive({
    status: statusFile({ investigate: true, implement: true, done: true, approved: true }),
    launch: bothLaunched(),
    entries: [
      listed({ id: INVESTIGATE_ID, state: 'done' }),
      listed({ id: IMPLEMENT_ID, name: IMPLEMENT_NAME, ...STOPPED }),
    ],
  });

  assertEntry(entry, { state: 'done', reason: 'implemented', phase: IMPLEMENT });
  assert.deepEqual(entry.goTo.implement, resumeFor(IMPLEMENT_ID));
});

test('stopped: a stopped review session is done and Re-review stays open', async () => {
  const entry = await derive({
    launch: { [REVIEW]: reviewRecord() },
    entries: [reviewEntry(STOPPED)],
  });

  assert.deepEqual(entry.review, { state: 'done', reason: 'finished' });
  assert.equal(entry.blocks.review, null, 'a new review may start');
  assert.equal(entry.blocks.rereview, null, 'and a re-review may be sent');
});

test('stopped: a stopped groom session is done and blocks nothing, with a resume command', async () => {
  const entry = await derive({
    launch: { [GROOM]: groomRecord() },
    entries: [groomEntry(STOPPED)],
  });

  assert.deepEqual(entry.groom, { state: 'done', reason: 'finished' });
  assert.equal(entry.blocks.groom, null);
  assert.deepEqual(entry.goTo.groom, resumeFor(GROOM_ID));
});

test('stopped: is never running, so a ticket that only has stopped sessions is not working', async () => {
  const { sessionRunning, sideActionState } = await import('../backend/claude-ticket-state.mjs');
  const entries = [reviewEntry(STOPPED)];
  assert.equal(sessionRunning(entries, reviewRecord(), START_MS), false);
  assert.equal(sideActionState(reviewRecord(), entries, START_MS).state, 'done');
});

test('stopped: any other unfamiliar state is still unrecognised', async () => {
  const entry = await derive({
    launch: { [REVIEW]: reviewRecord() },
    entries: [reviewEntry({ state: 'stopping', pid: null })],
  });
  assert.deepEqual(entry.review, { state: 'unknown', reason: 'unrecognised_state' });
  assert.equal(entry.blocks.rereview, 'unrecognised_state');
});
