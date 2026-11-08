// claude-ticket-state.test.mjs — the pure truth table that turns a ticket's two state files, the
// CLI listing and the clock into the entry the My Tickets card shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FIRST_ID,
  HOUR_MS,
  IMPLEMENT,
  IMPLEMENT_NAME,
  INVESTIGATE,
  INVESTIGATE_NAME,
  KEY,
  START_MS,
  answeredMap,
  launchRecord,
  listed,
  question,
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
  assert.deepEqual(entry.goTo, ATTACH);
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
  assert.deepEqual(entry.goTo, ATTACH);
  assert.equal(entry.blocks.implement, null);
});

test('scenario 14: a finished session without a pid is done with the plan ready and a resume command', async () => {
  const entry = await derive({ entries: [listed({ id: FIRST_ID, state: 'done' })] });
  assertEntry(entry, { state: 'done', reason: 'plan_ready' });
  assert.deepEqual(entry.goTo, RESUME);
  assert.equal(entry.blocks.implement, null);
});

test('scenario 14: a session absent for ten minutes with the flag set is done without a go-to command', async () => {
  const entry = await derive({ launch: launchedAgo(TEN_MINUTES_MS), entries: [] });
  assertEntry(entry, { state: 'done', reason: 'plan_ready' });
  assert.equal(entry.goTo, null);
  assert.equal(entry.blocks.implement, null);
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
  }
});

test('scenario 15: an unavailable listing is unknown and blocks every action', async () => {
  const entry = await derive({ entries: null });
  assertEntry(entry, { state: 'unknown', reason: 'listing_unavailable' });
  assert.deepEqual(entry.blocks, {
    investigate: 'listing_unavailable',
    implement: 'listing_unavailable',
    answer: 'listing_unavailable',
  });
});

test('scenario 15: a session in an unrecognised state is unknown', async () => {
  const entry = await derive({ entries: [listed({ id: FIRST_ID, state: 'stopped' })] });
  assertEntry(entry, { state: 'unknown', reason: 'unrecognised_state' });
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
  assert.equal(entry.goTo, null);
});

test('scenario 17: a session id that is not a UUID gives no go-to command', async () => {
  const entry = await derive(
    byName({ id: FIRST_ID, sessionId: 'not-a-uuid; rm -rf ~', state: 'done' }),
  );
  assert.equal(entry.goTo, null);
});

test('scenario 17: valid ids give exactly the attach and resume commands and no listing text', async () => {
  const live = await derive(byName({ id: FIRST_ID, state: 'working', status: 'busy', pid: 4242 }));
  assert.deepEqual(live.goTo, ATTACH);
  const finished = await derive(byName({ id: FIRST_ID, state: 'done' }));
  assert.deepEqual(finished.goTo, RESUME);
  for (const { goTo } of [live, finished]) {
    assert.equal(goTo.command.includes('sentinel'), false, 'no name or cwd text in a command');
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
};
const BLOCKS_WHILE_IMPLEMENTING = {
  investigate: 'implement_running',
  implement: 'session_running',
  answer: 'session_running',
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
const planned = ({ questions = ANSWERED, done = false, sent, ...overrides } = {}) => ({
  status: statusFile({ investigate: true, done, questions }),
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
      { [INVESTIGATE]: true, [IMPLEMENT]: false, done: expected },
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
  assert.equal(done.blocks.implement, null, 'done');
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
    ['sent, done', planned({ done: true, sent }), null],
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
    ['sent, nothing changed, done true', planned({ done: true, sent: lastSend }), null],
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
