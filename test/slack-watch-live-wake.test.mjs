// slack-watch-live-wake.test.mjs — an attached idle background session is woken under its own id by
// one awaited flow: the poll that finds the notice appends the line, stops the session, waits out
// the settle gap on the injected timers and resumes it. Every test runs the real claude-sessions
// module and the real watcher over the stateful fake CLI, which forks a copy for any resume inside
// its trap window, so a premature resume fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as watcherModule from '../backend/slack-watcher.mjs';
import {
  CLI_OUTPUT_SENTINELS,
  OTHER,
  SESSION_A,
  SESSION_B,
  SESSION_C,
  START_MS,
  TRAP_WINDOW_MS,
  captureConsole,
  findInTree,
  flush,
  returnsWithoutTimers,
  tsAt,
  watchFixture,
} from './slack-watch-fixture.mjs';

const { MAX_DELIVERY_ATTEMPTS } = watcherModule;

const SETTLE_GAP_MS = 15_000;
const WAKE_DEADLINE_MS = 7_200_000;
const TICK_MS = 180_000;
const BASELINE_TS = tsAt(-120);
const NEW_MESSAGE_TS = tsAt(60);
const SECOND_THREAD_TS = '1793192300.000100';
const NOTICE_PREFIX = "There's a new message on ";
const NAME_SENTINEL = 'sentinel-session-name-7a1f';
const CWD_SENTINEL = '/work/sentinel-cwd-2c9d';
const NEVER_RESUMES_MS = 60 * 60_000;
const SETTLED_WORDS = 'delivered:resumed';

// One link with the given sessions attached and a not-mine message newer than the attach, so the
// first poll baselines the thread and delivers that message. `sessions` maps an id to the options
// of `f.cli.add`; the default is one idle background session.
async function wakeScenario(t, { sessions = { [SESSION_A]: {} }, ...fixtureOptions } = {}) {
  const f = await watchFixture(t, { sessions: 'real', ...fixtureOptions });
  for (const [sessionId, options] of Object.entries(sessions)) f.cli.add(sessionId, options);
  const key = await f.watch({
    sessionIds: Object.keys(sessions),
    messages: [{ user: OTHER, ts: BASELINE_TS }],
  });
  f.threads.post(key, { user: OTHER, ts: NEW_MESSAGE_TS });
  return { f, key };
}

const pollOnce = (f) => returnsWithoutTimers(() => f.tick());
const forcedCheck = (f) => returnsWithoutTimers(() => f.watcher.checkNow());
const resumeButton = (f) => returnsWithoutTimers(() => f.watcher.resume());
const endSettleGap = (f) => f.timers.advance(SETTLE_GAP_MS);

async function tickAfter(f, milliseconds) {
  f.clock.advance(milliseconds);
  await pollOnce(f);
}

async function tickAt(f, clockMs) {
  f.clock.set(clockMs);
  await pollOnce(f);
}

// The one poll that appends the line and stops the idle session: the session is stopped when this
// returns and is waiting out its settle gap.
async function wakeUntilStopped(f) {
  await pollOnce(f);
  assert.equal(f.cli.stops.length, 1, 'the poll that wrote the line stopped the idle session');
}

// Runs `effect(index)` at each listing the CLI serves, counting from 1, before it prints.
function beforeListing(f, effect) {
  let served = 0;
  f.exec.onListing(async () => {
    served += 1;
    effect(served);
    return { stdout: JSON.stringify(f.cli.entries()) };
  });
}

// Holds the poll's first listing while `duringListing` runs, so the change lands in the middle of the
// pass, after the poll decided to run and before it acts on the session.
async function pollWithListingHeld(f, duringListing) {
  const hold = f.cli.hold('listing');
  const polling = f.tick();
  await flush();
  await duringListing();
  hold.release();
  await polling;
  await flush();
}

const noticeFor = (f, key) => `${NOTICE_PREFIX}${f.entry(key).link}`;
const resumeOutcomes = (f) => f.cli.resumes.map(({ outcome }) => outcome);
const secondsSinceStart = (f) => Math.floor((f.clock.now() - START_MS) / 1000);
const tsAfterNow = (f, offsetSeconds) => tsAt(secondsSinceStart(f) + offsetSeconds);

function deliveryWords(f, key, sessionId = SESSION_A) {
  const delivery = f.delivery(key, sessionId);
  return `${delivery?.status}:${delivery?.reason}`;
}

function assertDelivery(f, key, sessionId, expected) {
  assert.equal(deliveryWords(f, key, sessionId), expected, `delivery of ${sessionId.slice(0, 8)}`);
}

async function secondLinkWithNewMessage(f, sessionIds) {
  const key = await f.watch({
    threadTs: SECOND_THREAD_TS,
    sessionIds,
    messages: [{ user: OTHER, ts: tsAt(secondsSinceStart(f) - 100) }],
  });
  f.threads.post(key, { user: OTHER, ts: tsAfterNow(f, 5) });
  return key;
}

// Decorates the store so `append` rejects for each blocked line until it is unblocked, and counts
// every append attempt per line.
function appendFailures() {
  const blockedLines = new Set();
  const attempts = [];
  return {
    block: (line) => blockedLines.add(line),
    unblock: (line) => blockedLines.delete(line),
    attemptsFor: (line) => attempts.filter((attempted) => attempted === line).length,
    wrapStore: (store) => ({
      ...store,
      async append(sessionId, line) {
        attempts.push(line);
        if (blockedLines.has(line)) throw new Error('synthetic append failure');
        return store.append(sessionId, line);
      },
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// wake flow: idle — one awaited flow from the notice to the resume

test('wake flow: idle: the poll that finds the notice stops the idle session, waits the settle gap and resumes it once under its own id', async (t) => {
  const { f, key } = await wakeScenario(t);
  const notice = noticeFor(f, key);

  await pollOnce(f);
  assert.deepEqual(f.inboxLines(SESSION_A), [notice], 'the poll appends one line');
  assert.deepEqual(
    f.exec.stops().map(({ args }) => args),
    [['stop', SESSION_A.slice(0, 8)]],
    'and stops the session in that same pass',
  );
  assert.deepEqual(f.cli.stops, [{ sessionId: SESSION_A, atMs: START_MS }]);
  assert.equal(f.cli.session(SESSION_A).live, false);
  assert.equal(f.cli.resumes.length, 0, 'nothing is resumed inside the gap');
  assertDelivery(f, key, SESSION_A, 'waiting:settling');
  assert.equal(f.entry(key).lastNotifiedTs, BASELINE_TS, 'the cursor waits for the resume');
  assert.deepEqual(f.timers.delays(), [SETTLE_GAP_MS], 'the only wait is the settle gap');

  await f.timers.advance(SETTLE_GAP_MS - 1);
  assert.equal(f.cli.resumes.length, 0, 'one millisecond before the gap ends');
  assert.equal(f.exec.spawns().length, 0);

  await f.timers.advance(1);
  assert.deepEqual(
    f.cli.resumes,
    [{ sessionId: SESSION_A, outcome: 'continued', atMs: START_MS + SETTLE_GAP_MS }],
    'exactly one resume, the settle gap after the stop, under the same id',
  );
  assert.equal(f.cli.stops.length, 1, 'exactly one stop in all');
  assert.equal(f.cli.forks.length, 0, 'no copy');
  assert.equal(f.cli.entryCount(), 1, 'the listing did not grow');
  assert.equal(f.cli.session(SESSION_A).live, true);
  assert.deepEqual(
    f.exec.spawns().map(({ args }) => args),
    [['--bg', '--resume', SESSION_A, '--', notice]],
  );
  assert.deepEqual(f.inboxLines(SESSION_A), [notice], 'no second line');
  assertDelivery(f, key, SESSION_A, SETTLED_WORDS);
  assert.equal(f.entry(key).lastNotifiedTs, NEW_MESSAGE_TS, 'the cursor advances');
  assert.equal(f.timers.pending(), 0, 'no timer is left behind');
  assert.deepEqual(f.timers.escapes, []);
});

test('wake flow: idle: a timed poll and a forced check wake the same way', async (t) => {
  const timed = await wakeScenario(t);
  timed.f.watcher.start();
  await timed.f.timers.advance(TICK_MS);
  assert.deepEqual(
    timed.f.cli.stops.map(({ atMs }) => atMs),
    [START_MS + TICK_MS],
    'the timed poll stopped the session in its own pass',
  );
  assertDelivery(timed.f, timed.key, SESSION_A, 'waiting:settling');
  assert.equal(timed.f.cli.resumes.length, 0);
  await endSettleGap(timed.f);
  assert.deepEqual(timed.f.cli.resumes, [
    { sessionId: SESSION_A, outcome: 'continued', atMs: START_MS + TICK_MS + SETTLE_GAP_MS },
  ]);
  assertDelivery(timed.f, timed.key, SESSION_A, SETTLED_WORDS);

  const forced = await wakeScenario(t);
  assert.deepEqual(await forcedCheck(forced.f), { state: 'running', checked: true });
  assert.deepEqual(
    forced.f.cli.stops.map(({ atMs }) => atMs),
    [START_MS],
    'the forced check stopped the session in its own pass',
  );
  assertDelivery(forced.f, forced.key, SESSION_A, 'waiting:settling');
  await endSettleGap(forced.f);
  assert.deepEqual(resumeOutcomes(forced.f), ['continued']);
  assert.equal(forced.f.cli.forks.length, 0);
  assertDelivery(forced.f, forced.key, SESSION_A, SETTLED_WORDS);
});

test('wake flow: idle: the settle gap is 15 s, the deadline stays 2 h and the grace wait is gone', () => {
  assert.equal(watcherModule.SETTLE_MS, SETTLE_GAP_MS);
  assert.equal(watcherModule.WAKE_DEADLINE_MS, WAKE_DEADLINE_MS);
  assert.equal('WAKE_GRACE_MS' in watcherModule, false, 'no grace constant is exported');
  assert.ok(SETTLE_GAP_MS >= TRAP_WINDOW_MS, 'the settle gap covers the fake CLI trap window');
});

test('wake flow: idle: a session found busy just before the stop is not stopped and is delivered woke_itself', async (t) => {
  const { f, key } = await wakeScenario(t);
  beforeListing(f, (index) => {
    if (index === 2) f.cli.setStatus(SESSION_A, 'busy');
  });

  await pollOnce(f);
  assertDelivery(f, key, SESSION_A, 'delivered:woke_itself');
  assert.equal(f.exec.stops().length, 0, 'a session that woke on its own is not stopped');
  assert.equal(f.exec.spawns().length, 0);
  assert.equal(f.timers.pending(), 0, 'no settle wait was started');
  assert.equal(f.entry(key).lastNotifiedTs, NEW_MESSAGE_TS);

  f.cli.setStatus(SESSION_A, 'idle');
  await tickAfter(f, TICK_MS);
  await tickAfter(f, TICK_MS);
  assert.equal(f.exec.stops().length, 0, 'and going idle again starts nothing');
  assert.equal(f.exec.spawns().length, 0);
  assertDelivery(f, key, SESSION_A, 'delivered:woke_itself');
});

test('wake flow: idle: a session that turns busy after a failed stop is delivered woke_itself on the next poll', async (t) => {
  const idleFirst = await wakeScenario(t);
  idleFirst.f.cli.failNext('stop', { exitCode: 1, stderr: 'stop refused' }, 1);
  await pollOnce(idleFirst.f);
  assertDelivery(idleFirst.f, idleFirst.key, SESSION_A, 'failed-transient:stop_failed');
  idleFirst.f.cli.setStatus(SESSION_A, 'busy');
  await tickAfter(idleFirst.f, TICK_MS);
  assertDelivery(idleFirst.f, idleFirst.key, SESSION_A, 'delivered:woke_itself');
  assert.equal(idleFirst.f.exec.stops().length, 1, 'only the failed stop was ever tried');
  assert.equal(idleFirst.f.exec.spawns().length, 0);
  assert.equal(idleFirst.f.entry(idleFirst.key).lastNotifiedTs, NEW_MESSAGE_TS);

  const busyFirst = await wakeScenario(t, { sessions: { [SESSION_A]: { status: 'busy' } } });
  await pollOnce(busyFirst.f);
  assertDelivery(busyFirst.f, busyFirst.key, SESSION_A, 'waiting:awaiting_wake');
  busyFirst.f.cli.setStatus(SESSION_A, 'idle');
  busyFirst.f.cli.failNext('stop', { exitCode: 1, stderr: 'stop refused' }, 1);
  await tickAfter(busyFirst.f, TICK_MS);
  assertDelivery(busyFirst.f, busyFirst.key, SESSION_A, 'failed-transient:stop_failed');
  busyFirst.f.cli.setStatus(SESSION_A, 'busy');
  await tickAfter(busyFirst.f, TICK_MS);
  assertDelivery(busyFirst.f, busyFirst.key, SESSION_A, 'delivered:woke_itself');
  assert.equal(busyFirst.f.exec.stops().length, 1);
  assert.equal(busyFirst.f.exec.spawns().length, 0);
});

test('wake flow: idle: a session owed two notices in one poll is stopped once and resumed once', async (t) => {
  const { f, key } = await wakeScenario(t);
  const secondKey = await secondLinkWithNewMessage(f, [SESSION_A]);

  await wakeUntilStopped(f);
  assert.equal(f.exec.stops().length, 1, 'one stop call for the session');
  assert.deepEqual(
    [...f.inboxLines(SESSION_A)].sort(),
    [noticeFor(f, key), noticeFor(f, secondKey)].sort(),
    'both lines are in the inbox',
  );

  await endSettleGap(f);
  assert.deepEqual(resumeOutcomes(f), ['continued'], 'one resume, same id');
  assert.equal(f.exec.spawns().length, 1);
  assert.equal(f.cli.forks.length, 0);
  assertDelivery(f, key, SESSION_A, SETTLED_WORDS);
  assertDelivery(f, secondKey, SESSION_A, SETTLED_WORDS);
  assert.equal(f.entry(key).lastNotifiedTs, NEW_MESSAGE_TS);
  assert.equal(f.entry(secondKey).lastNotifiedTs, f.threads.newest(secondKey).ts);
});

// ---------------------------------------------------------------------------------------------
// wake flow: busy — a busy session is never stopped

test('wake flow: busy: a busy session is never stopped and is woken by the poll that finds it idle', async (t) => {
  const { f, key } = await wakeScenario(t, { sessions: { [SESSION_A]: { status: 'busy' } } });

  await pollOnce(f);
  for (let later = 0; later < 3; later++) await tickAfter(f, TICK_MS);
  assertDelivery(f, key, SESSION_A, 'waiting:awaiting_wake');
  assert.equal(f.exec.stops().length, 0, 'a busy session is never stopped');
  assert.equal(f.timers.pending(), 0, 'a busy session has no timer running');

  f.cli.setStatus(SESSION_A, 'idle');
  await tickAfter(f, TICK_MS);
  assert.deepEqual(
    f.cli.stops.map(({ atMs }) => atMs),
    [START_MS + 4 * TICK_MS],
    'the poll that found it idle stopped it in that pass',
  );
  assertDelivery(f, key, SESSION_A, 'waiting:settling');

  await endSettleGap(f);
  assert.deepEqual(f.cli.resumes, [
    { sessionId: SESSION_A, outcome: 'continued', atMs: START_MS + 4 * TICK_MS + SETTLE_GAP_MS },
  ]);
  assert.equal(f.cli.forks.length, 0);
  assertDelivery(f, key, SESSION_A, SETTLED_WORDS);
  assert.equal(f.entry(key).lastNotifiedTs, NEW_MESSAGE_TS);
});

test('wake flow: busy: a session that never goes idle ends never_idle at the wake deadline', async (t) => {
  const { f, key } = await wakeScenario(t, { sessions: { [SESSION_A]: { status: 'busy' } } });

  await pollOnce(f);
  for (let later = 0; later < 3; later++) await tickAfter(f, TICK_MS);
  assertDelivery(f, key, SESSION_A, 'waiting:awaiting_wake');

  await tickAt(f, START_MS + WAKE_DEADLINE_MS - 1_000);
  assertDelivery(f, key, SESSION_A, 'waiting:awaiting_wake');

  await tickAt(f, START_MS + WAKE_DEADLINE_MS + 1_000);
  assertDelivery(f, key, SESSION_A, 'failed-permanent:never_idle');
  assert.equal(f.exec.stops().length, 0, 'a busy session is never stopped');
  assert.equal(f.exec.spawns().length, 0);
  assert.equal(f.entry(key).lastNotifiedTs, NEW_MESSAGE_TS, 'a permanent end lets the cursor move');
});

// ---------------------------------------------------------------------------------------------
// wake flow: concurrency — the settle wait holds nothing back

test('wake flow: concurrency: a session waiting out its gap holds back neither the next poll, a forced check nor another session', async (t) => {
  const { f, key } = await wakeScenario(t);
  f.cli.add(SESSION_B);
  await wakeUntilStopped(f);
  const readsAfterFirstPoll = f.fakeReader.calls.length;

  await f.timers.advance(5_000);
  const secondKey = await secondLinkWithNewMessage(f, [SESSION_B]);
  assert.deepEqual(await forcedCheck(f), { state: 'running', checked: true });
  assert.equal(f.fakeReader.calls.length, readsAfterFirstPoll + 2, 'the check read both links');
  assert.deepEqual(
    f.cli.stops,
    [
      { sessionId: SESSION_A, atMs: START_MS },
      { sessionId: SESSION_B, atMs: START_MS + 5_000 },
    ],
    'the other session was stopped by the check while the first waits out its gap',
  );

  await f.timers.advance(5_000);
  await pollOnce(f);
  assert.equal(f.fakeReader.calls.length, readsAfterFirstPoll + 4, 'the next poll ran normally');
  assert.equal(f.cli.stops.length, 2, 'and started no second stop');
  assert.equal(f.inboxLines(SESSION_A).length, 1);
  assert.equal(f.inboxLines(SESSION_B).length, 1);

  await f.timers.advance(5_000);
  assert.deepEqual(
    f.cli.resumes,
    [{ sessionId: SESSION_A, outcome: 'continued', atMs: START_MS + SETTLE_GAP_MS }],
    'the first session resumes a gap after its own stop',
  );
  assert.equal(f.cli.session(SESSION_B).live, false, 'the second is still inside its own gap');

  await f.timers.advance(5_000);
  assert.deepEqual(f.cli.resumes, [
    { sessionId: SESSION_A, outcome: 'continued', atMs: START_MS + SETTLE_GAP_MS },
    { sessionId: SESSION_B, outcome: 'continued', atMs: START_MS + 5_000 + SETTLE_GAP_MS },
  ]);
  assert.equal(f.cli.forks.length, 0);
  assertDelivery(f, key, SESSION_A, SETTLED_WORDS);
  assertDelivery(f, secondKey, SESSION_B, SETTLED_WORDS);
  assert.equal(f.timers.pending(), 0);
});

test('wake flow: concurrency: two sessions owed the same notice wake concurrently', async (t) => {
  const { f, key } = await wakeScenario(t, {
    sessions: { [SESSION_A]: {}, [SESSION_B]: {} },
  });

  await pollOnce(f);
  assert.deepEqual(
    f.cli.stops.map(({ sessionId }) => sessionId),
    [SESSION_A, SESSION_B],
    'both are stopped in the one poll',
  );
  assert.deepEqual(f.timers.delays(), [SETTLE_GAP_MS, SETTLE_GAP_MS], 'each waits its own gap');
  for (const sessionId of [SESSION_A, SESSION_B])
    assertDelivery(f, key, sessionId, 'waiting:settling');
  assert.equal(f.entry(key).lastNotifiedTs, BASELINE_TS, 'the cursor waits for both');

  await endSettleGap(f);
  assert.deepEqual(resumeOutcomes(f), ['continued', 'continued']);
  assert.equal(f.cli.forks.length, 0);
  assert.equal(f.cli.entryCount(), 2);
  for (const sessionId of [SESSION_A, SESSION_B]) assertDelivery(f, key, sessionId, SETTLED_WORDS);
  assert.equal(f.entry(key).lastNotifiedTs, NEW_MESSAGE_TS);
});

test('wake flow: concurrency: a poll that finds a flow in flight for the session starts nothing', async (t) => {
  const { f, key } = await wakeScenario(t);
  await wakeUntilStopped(f);

  for (let later = 0; later < 3; later++) {
    await f.timers.advance(1_000);
    await pollOnce(f);
  }
  assert.equal(f.cli.stops.length, 1, 'never a second stop');
  assert.equal(f.exec.stops().length, 1);
  assert.equal(f.exec.spawns().length, 0, 'and no resume before the gap ends');
  assert.equal(f.inboxLines(SESSION_A).length, 1, 'no second line');
  assert.deepEqual(f.timers.delays(), [SETTLE_GAP_MS], 'still one flow, one wait');
  assertDelivery(f, key, SESSION_A, 'waiting:settling');

  await f.timers.advance(SETTLE_GAP_MS - 3_000);
  assert.deepEqual(resumeOutcomes(f), ['continued'], 'one resume, same id');
  assert.equal(f.cli.forks.length, 0);
});

// ---------------------------------------------------------------------------------------------
// wake flow: guards — the rules that hold in the new flow

test('wake flow: guards: a paused or disabled watcher never stops a session, and the first running poll then does', async (t) => {
  const { f, key } = await wakeScenario(t, { sessions: { [SESSION_A]: { status: 'busy' } } });
  await pollOnce(f);
  await f.watcher.pause();
  f.cli.setStatus(SESSION_A, 'idle');

  await tickAfter(f, TICK_MS);
  assert.equal(f.exec.stops().length, 0, 'no stop while paused');
  assertDelivery(f, key, SESSION_A, 'waiting:awaiting_wake');

  f.claudeHome.readable = false;
  await tickAfter(f, TICK_MS);
  assert.equal(f.exec.stops().length, 0, 'no stop while disabled');
  f.claudeHome.readable = true;

  assert.equal(await resumeButton(f), 'running');
  assert.equal(f.cli.stops.length, 1, 'the first running poll stops it in that pass');
  await endSettleGap(f);
  assert.deepEqual(resumeOutcomes(f), ['continued']);
  assertDelivery(f, key, SESSION_A, SETTLED_WORDS);
});

test('wake flow: guards: a paused watcher still resumes the session it stopped', async (t) => {
  const { f, key } = await wakeScenario(t);
  await wakeUntilStopped(f);

  await f.watcher.pause();
  await endSettleGap(f);

  assert.deepEqual(resumeOutcomes(f), ['continued'], 'one resume, same id');
  assert.equal(f.cli.forks.length, 0);
  assertDelivery(f, key, SESSION_A, SETTLED_WORDS);
  assert.equal(f.entry(key).lastNotifiedTs, NEW_MESSAGE_TS);
});

test('wake flow: guards: Pause pressed while the poll waits on the listing stops nothing, and one poll after Resume does', async (t) => {
  const { f, key } = await wakeScenario(t);

  await pollWithListingHeld(f, () => f.watcher.pause());
  assert.equal(f.exec.stops().length, 0, 'no stop after the pause');
  assertDelivery(f, key, SESSION_A, 'waiting:awaiting_wake');

  assert.equal(await resumeButton(f), 'running');
  assert.equal(f.cli.stops.length, 1, 'one poll after Resume stops it');
  await endSettleGap(f);
  assert.deepEqual(resumeOutcomes(f), ['continued']);
  assertDelivery(f, key, SESSION_A, SETTLED_WORDS);
});

test('wake flow: guards: the Claude home turning unreadable while the poll waits on the listing stops nothing, and one poll once it is readable does', async (t) => {
  const { f, key } = await wakeScenario(t);

  await pollWithListingHeld(f, () => {
    f.claudeHome.readable = false;
  });
  assert.equal(f.exec.stops().length, 0, 'no stop after the watch was disabled');
  assertDelivery(f, key, SESSION_A, 'waiting:awaiting_wake');

  f.claudeHome.readable = true;
  await tickAfter(f, TICK_MS);
  assert.equal(f.cli.stops.length, 1, 'one poll once it is readable stops it');
  await endSettleGap(f);
  assert.deepEqual(resumeOutcomes(f), ['continued']);
  assertDelivery(f, key, SESSION_A, SETTLED_WORDS);
});

test('wake flow: guards: a paused poll still resumes a stopped session whose resume failed and has no flow', async (t) => {
  const { f, key } = await wakeScenario(t);
  f.cli.failNext('resume', { exitCode: 2, stderr: 'resume refused' }, 1);
  await wakeUntilStopped(f);
  await endSettleGap(f);
  assertDelivery(f, key, SESSION_A, 'failed-transient:spawn_failed');
  assert.equal(f.cli.resumes.length, 0, 'the one resume so far failed');

  await f.watcher.pause();
  await tickAfter(f, TICK_MS);

  assert.deepEqual(resumeOutcomes(f), ['continued'], 'the paused poll resumes it once, same id');
  assert.equal(f.exec.spawns().length, 2, 'one failed attempt and one resume');
  assert.equal(f.cli.forks.length, 0);
  assertDelivery(f, key, SESSION_A, SETTLED_WORDS);
});

test('wake flow: guards: no poll, Resume button or second link resumes a session inside its settle gap', async (t) => {
  const { f, key } = await wakeScenario(t);
  await wakeUntilStopped(f);

  await f.timers.advance(1_000);
  assert.equal(await resumeButton(f), 'running');
  assert.equal(f.cli.resumes.length, 0, 'the Resume button poll does not resume');
  assert.equal(f.exec.spawns().length, 0);
  assertDelivery(f, key, SESSION_A, 'waiting:settling');

  const secondKey = await secondLinkWithNewMessage(f, [SESSION_A]);
  await f.timers.advance(1_000);
  await pollOnce(f);
  assert.equal(f.cli.resumes.length, 0, 'a second link notice inside the gap does not resume');
  assert.equal(f.cli.stops.length, 1, 'and does not stop a second time');

  await f.timers.advance(SETTLE_GAP_MS - 2_000 - 1);
  assert.equal(f.cli.resumes.length, 0, 'one millisecond before the gap ends');
  assert.equal(f.cli.forks.length, 0, 'no copy was made');

  await f.timers.advance(1);
  assert.deepEqual(resumeOutcomes(f), ['continued'], 'exactly one resume, same id');
  assert.equal(f.exec.spawns().length, 1);
  assert.equal(f.cli.forks.length, 0);
  assert.equal(f.cli.entryCount(), 1);
  assertDelivery(f, key, SESSION_A, SETTLED_WORDS);
  assert.equal(f.entry(key).lastNotifiedTs, NEW_MESSAGE_TS);
  assertDelivery(f, secondKey, SESSION_A, SETTLED_WORDS);
  assert.equal(f.entry(secondKey).lastNotifiedTs, f.threads.newest(secondKey).ts);
});

test('wake flow: guards: a session detached during its settle gap is still resumed once, under its own id', async (t) => {
  const { f, key } = await wakeScenario(t);
  await wakeUntilStopped(f);

  await f.store.detach(key, SESSION_A);
  await f.timers.advance(1_000);
  await pollOnce(f);
  assert.equal(f.exec.spawns().length, 0, 'nothing resumes inside the gap');
  assert.equal(f.cli.stops.length, 1, 'and a detach starts no second stop');

  await f.timers.advance(SETTLE_GAP_MS - 1_000);
  assert.deepEqual(
    f.exec.spawns().map(({ args }) => args[2]),
    [SESSION_A],
    'the stopped session is resumed at the end of the gap, so a detach never leaves it dead',
  );
  assert.deepEqual(resumeOutcomes(f), ['continued'], 'same id');
  assert.equal(f.cli.forks.length, 0);
  assert.equal(f.cli.session(SESSION_A).live, true);

  for (let later = 0; later < 2; later++) await tickAfter(f, TICK_MS);
  assert.equal(f.exec.spawns().length, 1, 'no second resume');
  assert.equal(f.cli.stops.length, 1);
});

test('wake flow: guards: nothing new starts for a detached session, so a detached busy session is never stopped', async (t) => {
  const { f, key } = await wakeScenario(t, { sessions: { [SESSION_A]: { status: 'busy' } } });
  await pollOnce(f);
  await f.store.detach(key, SESSION_A);
  f.cli.setStatus(SESSION_A, 'idle');

  await tickAfter(f, TICK_MS);
  await tickAfter(f, TICK_MS);
  assert.equal(f.exec.stops().length, 0, 'a detached session is never stopped');
  assert.equal(f.exec.spawns().length, 0);
});

test('wake flow: guards: a session live again at the second listing is not resumed and goes back to waiting', async (t) => {
  const { f, key } = await wakeScenario(t);
  await wakeUntilStopped(f);

  f.cli.revive(SESSION_A, 'busy');
  await endSettleGap(f);
  assertDelivery(f, key, SESSION_A, 'waiting:awaiting_wake');
  assert.equal(f.exec.spawns().length, 0, 'a live session is not resumed');
  assert.equal(f.cli.forks.length, 0);

  f.cli.setStatus(SESSION_A, 'idle');
  await tickAfter(f, TICK_MS);
  assert.equal(f.cli.stops.length, 2, 'back in the wake, an idle session is stopped again');
  await endSettleGap(f);
  assert.deepEqual(resumeOutcomes(f), ['continued'], 'and resumed under its own id');
  assertDelivery(f, key, SESSION_A, SETTLED_WORDS);
});

test('wake flow: guards: a restart inside the settle gap never resumes early and never forks', async (t) => {
  const { f, key } = await wakeScenario(t);
  await wakeUntilStopped(f);
  await f.timers.advance(1_000);
  await f.restart();
  const restartedAtMs = f.clock.now();

  await tickAfter(f, 1_000);
  assert.equal(f.cli.resumes.length, 0, 'a poll right after the restart does not resume');
  assertDelivery(f, key, SESSION_A, 'waiting:settling');

  await tickAt(f, restartedAtMs + SETTLE_GAP_MS - 1);
  assert.equal(f.cli.resumes.length, 0, 'nor one millisecond before the gap since the restart');
  assert.equal(f.cli.forks.length, 0);
  assertDelivery(f, key, SESSION_A, 'waiting:settling');

  await tickAt(f, restartedAtMs + SETTLE_GAP_MS + 1_000);
  assert.deepEqual(resumeOutcomes(f), ['continued'], 'one resume, same id');
  assert.equal(f.cli.forks.length, 0);
  assert.equal(f.cli.entryCount(), 1);
  assertDelivery(f, key, SESSION_A, SETTLED_WORDS);
});

test('wake flow: guards: a link in backoff does not hold back the resume of a stopped session', async (t) => {
  const { f, key } = await wakeScenario(t);
  await wakeUntilStopped(f);

  f.fakeReader.script(() => ({ ok: false, reason: 'rate_limited', retryAfterSeconds: 3600 }));
  await f.timers.advance(1_000);
  await pollOnce(f);
  const readsInBackoff = f.fakeReader.calls.length;

  await f.timers.advance(SETTLE_GAP_MS - 1_000);
  assert.equal(
    f.fakeReader.calls.length,
    readsInBackoff,
    'the link was not read: it is backed off',
  );
  assert.deepEqual(resumeOutcomes(f), ['continued'], 'one resume, same id');
  assert.equal(f.cli.forks.length, 0);
  assertDelivery(f, key, SESSION_A, SETTLED_WORDS);
});

// ---------------------------------------------------------------------------------------------
// wake flow: cleanup — stop() cancels every wait

test('wake flow: cleanup: stop() cancels every pending settle wait and nothing keeps the process alive', async (t) => {
  const { f } = await wakeScenario(t, { sessions: { [SESSION_A]: {}, [SESSION_B]: {} } });
  f.watcher.start();
  await pollOnce(f);
  assert.equal(f.cli.stops.length, 2, 'both sessions are inside their settle gap');
  assert.equal(
    f.timers.delays().filter((delay) => delay === SETTLE_GAP_MS).length,
    2,
    'each has its own wait',
  );
  assert.equal(f.timers.referenced(), 0, 'none of the timers keeps the process alive');

  f.watcher.stop();
  assert.equal(f.timers.pending(), 0, 'stop clears every timer');
  await f.timers.advance(SETTLE_GAP_MS + TICK_MS);
  assert.equal(f.exec.spawns().length, 0, 'a stopped watcher resumes nothing');
  assert.equal(f.exec.stops().length, 2, 'and stops nothing more');
  assert.deepEqual(f.timers.escapes, []);
});

test('wake flow: cleanup: a watcher closed while its poll waits on the listing makes no stop call', async (t) => {
  async function pollWhileListing(scenarioT, closeWatcher) {
    const { f } = await wakeScenario(scenarioT);
    const hold = f.cli.hold('listing');
    const polling = f.tick();
    await flush();
    if (closeWatcher) f.watcher.stop();
    hold.release();
    await polling;
    await flush();
    return f;
  }

  const open = await pollWhileListing(t, false);
  assert.equal(open.exec.stops().length, 1, 'control: an open watcher stops the session');

  const closed = await pollWhileListing(t, true);
  assert.equal(closed.exec.stops().length, 0, 'a closed watcher makes no stop call');
  assert.equal(closed.exec.spawns().length, 0);
  assert.equal(closed.timers.pending(), 0, 'and starts no wait');
});

// ---------------------------------------------------------------------------------------------
// wake flow: races — what lands between a poll's listing and the call it then makes

test('wake flow: races: a session the user stopped just before the watcher stop is not woke_itself and is resumed', async (t) => {
  const { f, key } = await wakeScenario(t);
  beforeListing(f, (index) => {
    if (index === 2) f.cli.finish(SESSION_A);
  });

  await pollOnce(f);
  assert.match(deliveryWords(f, key), /^waiting:(awaiting_wake|settling)$/, 'the notice is kept');
  assert.equal(f.entry(key).lastNotifiedTs, BASELINE_TS, 'the cursor waits for the resume');
  assert.equal(f.exec.stops().length, 0, 'there was nothing left to stop');

  await tickAfter(f, TICK_MS);
  await endSettleGap(f);
  assert.deepEqual(resumeOutcomes(f), ['continued'], 'resumed once, same id');
  assert.deepEqual(
    f.exec.spawns().map(({ args }) => args[2]),
    [SESSION_A],
  );
  assert.equal(f.cli.forks.length, 0);
  assertDelivery(f, key, SESSION_A, SETTLED_WORDS);
  assert.equal(f.entry(key).lastNotifiedTs, NEW_MESSAGE_TS);
});

test('wake flow: races: a session whose pid is no longer trusted just before the watcher stop is not woke_itself', async (t) => {
  const { f, key } = await wakeScenario(t);
  beforeListing(f, (index) => {
    if (index === 2) f.cli.override(SESSION_A, { pid: '4242' });
  });

  await pollOnce(f);
  assertDelivery(f, key, SESSION_A, 'waiting:awaiting_wake');
  assert.equal(f.entry(key).lastNotifiedTs, BASELINE_TS, 'the cursor waits');
  assert.equal(f.exec.stops().length, 0);

  await tickAfter(f, TICK_MS);
  assertDelivery(f, key, SESSION_A, 'delivered:inbox_only');
  assert.equal(f.entry(key).lastNotifiedTs, NEW_MESSAGE_TS);
  assert.equal(f.exec.spawns().length, 0, 'a session with an untrusted pid is never resumed');
});

test('wake flow: races: a watcher closed while the claude stop is running arms nothing and resumes nothing', async (t) => {
  const { f } = await wakeScenario(t);
  const hold = f.cli.hold('stop');
  const polling = f.tick();
  await flush(100);
  assert.equal(f.exec.stops().length, 1, 'the claude stop call is running');

  f.watcher.stop();
  hold.release();
  await polling;
  await flush();
  assert.equal(f.timers.pending(), 0, 'no settle wait was armed after stop()');

  await f.timers.advance(SETTLE_GAP_MS + TICK_MS + SETTLE_GAP_MS);
  assert.equal(f.exec.spawns().length, 0, 'no resume however far the clock advances');
  assert.equal(f.cli.resumes.length, 0);
});

// A busy session waiting for its notice that the user then stops: the next poll finds it finished and
// starts its gap, though the watcher stopped nothing.
async function userStopsWaitingSession(t) {
  const { f, key } = await wakeScenario(t, { sessions: { [SESSION_A]: { status: 'busy' } } });
  await pollOnce(f);
  f.cli.finish(SESSION_A);
  await tickAfter(f, TICK_MS);
  assertDelivery(f, key, SESSION_A, 'waiting:settling');
  assert.equal(f.exec.stops().length, 0, 'the watcher stopped nothing');
  return { f, key };
}

test('wake flow: races: a session a poll found finished is not resumed once it is detached inside its gap', async (t) => {
  const { f, key } = await userStopsWaitingSession(t);

  await f.store.detach(key, SESSION_A);
  await endSettleGap(f);
  assert.equal(f.exec.spawns().length, 0, 'the detached session is not resumed');

  await tickAfter(f, TICK_MS);
  await endSettleGap(f);
  assert.equal(f.exec.spawns().length, 0, 'and not retried');
  assert.equal(f.cli.session(SESSION_A).live, false);
});

const GAP_INTERRUPTIONS = {
  paused: (f) => f.watcher.pause(),
  disabled: (f) => {
    f.claudeHome.readable = false;
  },
};

for (const [label, interrupt] of Object.entries(GAP_INTERRUPTIONS))
  test(`wake flow: races: a session a poll found finished is not resumed while the watcher is ${label} inside its gap`, async (t) => {
    const { f } = await userStopsWaitingSession(t);

    await interrupt(f);
    await endSettleGap(f);
    assert.equal(f.exec.spawns().length, 0, `no resume while ${label}`);

    await tickAfter(f, TICK_MS);
    await endSettleGap(f);
    assert.equal(f.exec.spawns().length, 0, 'and not retried by a poll while it stays so');
    assert.equal(f.cli.session(SESSION_A).live, false);
  });

// ---------------------------------------------------------------------------------------------
// Who is never stopped

test('never stopped: interactive, status-less and unknown-pid sessions get only their line', async (t) => {
  const { f, key } = await wakeScenario(t, {
    sessions: {
      [SESSION_A]: { kind: 'interactive', status: 'idle' },
      [SESSION_B]: { status: 'idle' },
      [SESSION_C]: { status: 'idle' },
    },
  });
  f.cli.override(SESSION_B, { status: undefined });
  f.cli.override(SESSION_C, { pid: '4242' });

  await pollOnce(f);
  for (let later = 0; later < 3; later++) await tickAfter(f, TICK_MS);

  for (const sessionId of [SESSION_A, SESSION_B, SESSION_C])
    assertDelivery(f, key, sessionId, 'delivered:inbox_only');
  assert.equal(f.exec.stops().length, 0, 'no stop call');
  assert.equal(f.exec.spawns().length, 0, 'no resume call');
  assert.equal(f.entry(key).lastNotifiedTs, NEW_MESSAGE_TS, 'the line settles the notice');
});

// ---------------------------------------------------------------------------------------------
// Attempts and terminal outcomes

test('attempts: waiting costs no attempt, so a normal wake never reaches a failure', async (t) => {
  const { f, key } = await wakeScenario(t, { sessions: { [SESSION_A]: { status: 'busy' } } });
  const observed = [];

  await pollOnce(f);
  observed.push(deliveryWords(f, key));
  for (let wait = 0; wait < MAX_DELIVERY_ATTEMPTS + 1; wait++) {
    await tickAfter(f, TICK_MS);
    observed.push(deliveryWords(f, key));
  }
  f.cli.setStatus(SESSION_A, 'idle');
  await tickAfter(f, TICK_MS);
  observed.push(deliveryWords(f, key));
  await endSettleGap(f);
  observed.push(deliveryWords(f, key));

  assert.deepEqual(observed, [
    ...Array(MAX_DELIVERY_ATTEMPTS + 2).fill('waiting:awaiting_wake'),
    'waiting:settling',
    SETTLED_WORDS,
  ]);
  assert.equal(f.cli.forks.length, 0);
});

test('attempts: three failing stops end failed-permanent with the last reason', async (t) => {
  const { f, key } = await wakeScenario(t);
  f.cli.failNext('stop', { exitCode: 1, stderr: 'stop refused' }, MAX_DELIVERY_ATTEMPTS);
  const observed = [];

  await pollOnce(f);
  observed.push(deliveryWords(f, key));
  for (let attempt = 1; attempt < MAX_DELIVERY_ATTEMPTS; attempt++) {
    await tickAfter(f, TICK_MS);
    observed.push(deliveryWords(f, key));
  }

  assert.deepEqual(observed, [
    'failed-transient:stop_failed',
    'failed-transient:stop_failed',
    'failed-permanent:stop_failed',
  ]);
  assert.equal(f.exec.stops().length, MAX_DELIVERY_ATTEMPTS);
  assert.equal(
    f.entry(key).lastNotifiedTs,
    NEW_MESSAGE_TS,
    'the permanent failure moves the cursor',
  );

  await tickAfter(f, TICK_MS);
  assert.equal(f.exec.stops().length, MAX_DELIVERY_ATTEMPTS, 'a permanent failure is not retried');
});

test('attempts: three failing resumes end failed-permanent with the last reason', async (t) => {
  const { f, key } = await wakeScenario(t);
  f.cli.failNext('resume', { exitCode: 2, stderr: 'resume refused' }, MAX_DELIVERY_ATTEMPTS);
  const observed = [];

  await pollOnce(f);
  observed.push(deliveryWords(f, key));
  await endSettleGap(f);
  observed.push(deliveryWords(f, key));
  for (let retry = 1; retry < MAX_DELIVERY_ATTEMPTS; retry++) {
    await tickAfter(f, TICK_MS);
    observed.push(deliveryWords(f, key));
  }

  assert.deepEqual(observed, [
    'waiting:settling',
    'failed-transient:spawn_failed',
    'failed-transient:spawn_failed',
    'failed-permanent:spawn_failed',
  ]);
  assert.equal(f.exec.spawns().length, MAX_DELIVERY_ATTEMPTS);

  await tickAfter(f, TICK_MS);
  assert.equal(f.exec.spawns().length, MAX_DELIVERY_ATTEMPTS, 'a permanent failure is not retried');
});

test('attempts: a forked resume is failed-permanent resume_forked, never retried, and leaves the copy alone', async (t) => {
  const { f, key } = await wakeScenario(t);
  f.cli.trapWindowMs = NEVER_RESUMES_MS;
  await wakeUntilStopped(f);

  await endSettleGap(f);
  assert.equal(f.cli.forks.length, 1, 'the fake CLI forked the resume');
  assertDelivery(f, key, SESSION_A, 'failed-permanent:resume_forked');
  const [{ copyId }] = f.cli.forks;

  for (let later = 0; later < 3; later++) await tickAfter(f, TICK_MS);
  assert.equal(f.exec.spawns().length, 1, 'no retry');
  assert.equal(f.cli.stops.length, 1, 'only the original stop: the copy is never stopped');
  assert.equal(f.cli.session(copyId).live, true, 'the copy is left running');
  assert.equal(f.cli.entryCount(), 2);
  assert.equal(f.entry(key).lastNotifiedTs, NEW_MESSAGE_TS);
});

// ---------------------------------------------------------------------------------------------
// The wake outcome reaches only the lines that are in the inbox

// Each ending brings a wake on the first link of `scenario` to the point where one more step ends
// it with `outcome`: `prepare` runs before the second link of the same session gets its message
// and `end` after. `sharesOutcome` says whether the second link's record, once its line is in the
// inbox, ends with the same outcome: a wake that ends inside the very poll that wrote the first
// line has already ended when the second link is handled.
const WAKE_ENDINGS = {
  resumed: {
    outcome: SETTLED_WORDS,
    scenario: {},
    prepare: wakeUntilStopped,
    async end(f) {
      await f.timers.advance(1_000);
      await pollOnce(f);
      await f.timers.advance(SETTLE_GAP_MS - 1_000);
    },
    sharesOutcome: true,
  },
  woke_itself: {
    outcome: 'delivered:woke_itself',
    scenario: {},
    prepare(f) {
      beforeListing(f, (index) => {
        if (index === 2) f.cli.setStatus(SESSION_A, 'busy');
      });
    },
    end: pollOnce,
    sharesOutcome: false,
  },
  'failed-permanent': {
    outcome: 'failed-permanent:never_idle',
    scenario: { sessions: { [SESSION_A]: { status: 'busy' } } },
    async prepare(f) {
      await pollOnce(f);
      f.clock.set(START_MS + WAKE_DEADLINE_MS - 100_000);
    },
    end: (f) => tickAt(f, START_MS + WAKE_DEADLINE_MS + 1_000),
    sharesOutcome: true,
  },
};

async function endWakeWithSecondLink(t, ending, { appendFails }) {
  const append = appendFailures();
  const { f, key } = await wakeScenario(t, { ...ending.scenario, wrapStore: append.wrapStore });
  await ending.prepare(f);
  const secondBaselineTs = tsAfterNow(f, -100);
  const secondKey = await secondLinkWithNewMessage(f, [SESSION_A]);
  const secondNotice = noticeFor(f, secondKey);
  if (appendFails) append.block(secondNotice);
  await ending.end(f);
  return { f, key, secondKey, secondNotice, secondBaselineTs, append };
}

for (const [endingName, ending] of Object.entries(WAKE_ENDINGS)) {
  test(`mirror: a wake that ends ${endingName} never settles a record whose line is not in the inbox`, async (t) => {
    const { f, key, secondKey, secondNotice, secondBaselineTs, append } =
      await endWakeWithSecondLink(t, ending, { appendFails: true });
    const firstNotice = noticeFor(f, key);

    assertDelivery(f, key, SESSION_A, ending.outcome);
    assert.equal(
      f.entry(key).lastNotifiedTs,
      NEW_MESSAGE_TS,
      'the first link settles with the wake',
    );
    assert.equal(
      deliveryWords(f, secondKey),
      'failed-transient:append_failed',
      'the wake does not settle the second link record',
    );
    assert.equal(
      f.entry(secondKey).lastNotifiedTs,
      secondBaselineTs,
      'the second link cursor waits for its own line',
    );
    assert.deepEqual(f.inboxLines(SESSION_A), [firstNotice], 'the second line was never written');

    append.unblock(secondNotice);
    await tickAfter(f, TICK_MS);
    assert.deepEqual(
      f.inboxLines(SESSION_A),
      [firstNotice, secondNotice],
      'the next poll retries the append and writes the line',
    );
    for (let later = 0; later < 3; later++) await tickAfter(f, TICK_MS);
    assert.deepEqual(f.inboxLines(SESSION_A), [firstNotice, secondNotice], 'and never again');
    assert.equal(append.attemptsFor(secondNotice), 2, 'one attempt that failed, one that wrote');
    assert.equal(append.attemptsFor(firstNotice), 1, 'the retry repeats only the failed step');
  });

  if (ending.sharesOutcome)
    test(`mirror: a wake that ends ${endingName} still settles a record whose line is in the inbox`, async (t) => {
      const { f, key, secondKey, secondNotice } = await endWakeWithSecondLink(t, ending, {
        appendFails: false,
      });

      assertDelivery(f, key, SESSION_A, ending.outcome);
      assertDelivery(f, secondKey, SESSION_A, ending.outcome);
      assert.equal(
        f.entry(secondKey).lastNotifiedTs,
        f.threads.newest(secondKey).ts,
        'the second link cursor moves with the wake',
      );
      assert.deepEqual(f.inboxLines(SESSION_A), [noticeFor(f, key), secondNotice]);
    });
}

// ---------------------------------------------------------------------------------------------
// Nothing the CLI prints, no name and no directory leaves the modules

test('leak: no CLI text, session name or working directory from a stop, a resume or a fork leaves the watcher', async (t) => {
  const lines = captureConsole(t);
  const f = await watchFixture(t, { sessions: 'real', http: true });
  f.cli.add(SESSION_A, { name: NAME_SENTINEL, cwd: CWD_SENTINEL });
  f.cli.add(SESSION_B, { name: NAME_SENTINEL, cwd: CWD_SENTINEL });
  const needles = [
    NAME_SENTINEL,
    CWD_SENTINEL,
    CLI_OUTPUT_SENTINELS.stop,
    CLI_OUTPUT_SENTINELS.forkName,
    CLI_OUTPUT_SENTINELS.resumeName,
  ];
  const namesAllowedInPicker = [NAME_SENTINEL, CLI_OUTPUT_SENTINELS.forkName];
  const leaks = [];
  const record = (where, text, allowed = []) =>
    needles
      .filter((needle) => !allowed.includes(needle) && text.includes(needle))
      .forEach((needle) => leaks.push(`${where}: ${needle.slice(0, 18)}`));

  async function checkpoint(step) {
    for (const { file, needle } of findInTree(f.home, needles))
      leaks.push(`${step}: file ${file}: ${needles[needle].slice(0, 18)}`);
    record(`${step}: console`, lines.join('\n'));
    const argv = [...f.exec.spawns(), ...f.exec.stops()].map(({ file, args }) => ({ file, args }));
    record(`${step}: argv`, JSON.stringify(argv));
    record(`${step}: list()`, JSON.stringify(f.watcher.list()));
    record(`${step}: list body`, (await f.http.bare('GET', '/api/slack/watch')).text);
    record(
      `${step}: picker body`,
      (await f.http.bare('GET', '/api/slack/watch/sessions')).text,
      namesAllowedInPicker,
    );
  }

  const key = await f.watch({
    sessionIds: [SESSION_A],
    messages: [{ user: OTHER, ts: BASELINE_TS }],
  });
  f.threads.post(key, { user: OTHER, ts: NEW_MESSAGE_TS });
  await pollOnce(f);
  await checkpoint('stopped');
  await endSettleGap(f);
  await checkpoint('resumed');

  f.cli.trapWindowMs = NEVER_RESUMES_MS;
  await secondLinkWithNewMessage(f, [SESSION_B]);
  await tickAfter(f, TICK_MS);
  await endSettleGap(f);
  await checkpoint('forked');

  assert.deepEqual(leaks, []);
  assert.ok(f.cli.stops.length >= 2, 'the scenario stopped both sessions');
  assert.ok(resumeOutcomes(f).includes('continued'), 'and continued one of them');
  assert.ok(f.cli.forks.length >= 1, 'and forked a resume of the other');
});
