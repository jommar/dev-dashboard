// claude-ticket-state.test.mjs — the pure truth table that turns a ticket's two state files, the
// CLI listing and the clock into the entry the My Tickets card shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FIRST_ID,
  HOUR_MS,
  IMPLEMENT,
  INVESTIGATE,
  NAME,
  START_MS,
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
// and done, flag true, no question, the plan on disk.
async function derive(overrides = {}) {
  const { deriveEntry } = await import('../backend/claude-ticket-state.mjs');
  return deriveEntry({
    status: statusFile({ investigate: true }),
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

function assertEntry(entry, expected) {
  assert.equal(entry.state, expected.state, 'state');
  assert.equal(entry.reason, expected.reason, 'reason');
  if ('phase' in expected) assert.equal(entry.phase, expected.phase, 'phase');
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
      [IMPLEMENT]: launchRecord({ launchedAt: START_MS - HOUR_MS, id: FIRST_ID }),
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
    status: statusFile({ investigate: true }),
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
  const found = await resolve(entries, { name: NAME, launchedAt: LAUNCHED_AT, id: RECORD_ID });
  assert.equal(found?.sessionId, sessionUuid(RECORD_ID));
});

test('scenario 16: without a recorded id the newest same-name session not older than the launch wins', async () => {
  const entries = [
    listed({ id: 'aaaa0001', startedAt: LAUNCHED_AT - 5_000 }),
    listed({ id: 'aaaa0002', startedAt: newerThan(1_000) }),
    workingEntry({ id: 'aaaa0003', startedAt: newerThan(9_000) }),
    listed({ id: RECORD_ID, name: 'a different name', startedAt: newerThan(20_000) }),
  ];
  const record = { name: NAME, launchedAt: LAUNCHED_AT, id: null };
  assert.equal((await resolve(entries, record))?.sessionId, sessionUuid('aaaa0003'));
  assert.equal(
    (await resolve(entries.slice(0, 2), record))?.sessionId,
    sessionUuid('aaaa0002'),
    'the newer of the two that remain',
  );
});

test('scenario 16: a same-name session that started before the launch never matches', async () => {
  const record = { name: NAME, launchedAt: LAUNCHED_AT, id: null };
  const before = listed({ id: 'aaaa0001', startedAt: LAUNCHED_AT - 1 });
  assert.equal(await resolve([before], record), null);
  const atLaunch = listed({ id: 'aaaa0002', startedAt: LAUNCHED_AT });
  assert.equal((await resolve([before, atLaunch], record))?.sessionId, sessionUuid('aaaa0002'));
});

const TAINTED = { name: `${NAME}; $(touch /tmp/sentinel-name)`, cwd: '/tmp/$(sentinel-cwd)' };

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
