// slack-watch-live-wake.test.mjs — an attached idle background session is woken under its own id:
// the line is appended, a later tick stops the session, and once the settle gap has passed it is
// resumed. Every test runs the real claude-sessions module and the real watcher over the stateful
// fake CLI, which forks a copy for any resume inside its trap window, so a premature resume fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_DELIVERY_ATTEMPTS } from '../backend/slack-watcher.mjs';
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
  tsAt,
  wakeConstants,
  watchFixture,
} from './slack-watch-fixture.mjs';

const { SETTLE_MS, WAKE_GRACE_MS, WAKE_DEADLINE_MS, exported } = await wakeConstants();

const TICK_MS = 180_000;
const BASELINE_TS = tsAt(-120);
const NEW_MESSAGE_TS = tsAt(60);
const SECOND_THREAD_TS = '1793192300.000100';
const NOTICE_PREFIX = "There's a new message on ";
const NAME_SENTINEL = 'sentinel-session-name-7a1f';
const CWD_SENTINEL = '/work/sentinel-cwd-2c9d';
const NEVER_RESUMES_MS = 60 * 60_000;

// One link with the given sessions attached and a not-mine message newer than the attach, so the
// first tick baselines the thread and delivers that message. `sessions` maps an id to the options
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

async function tickAfter(f, milliseconds) {
  f.clock.advance(milliseconds);
  await f.tick();
}

async function tickAt(f, clockMs) {
  f.clock.set(clockMs);
  await f.tick();
}

// The append tick, then the tick that stops the session: the session is stopped when this returns.
async function wakeUntilStopped(f) {
  await f.tick();
  await tickAfter(f, TICK_MS);
  assert.equal(f.cli.stops.length, 1, 'the second tick stopped the idle session');
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
// The wake sequence

test('wake: idle session is appended, stopped on the next tick and resumed under its own id', async (t) => {
  const { f, key } = await wakeScenario(t);
  const notice = noticeFor(f, key);

  await f.tick();
  assert.deepEqual(f.inboxLines(SESSION_A), [notice], 'tick 1 appends one line');
  assert.equal(f.cli.stops.length, 0, 'tick 1 stops nothing');
  assertDelivery(f, key, SESSION_A, 'waiting:awaiting_wake');
  assert.equal(f.entry(key).lastNotifiedTs, BASELINE_TS, 'the cursor waits for the wake');

  await tickAfter(f, TICK_MS);
  assert.equal(f.cli.stops.length, 1, 'tick 2 stops the session once');
  assert.deepEqual(
    f.exec.stops().map(({ args }) => args),
    [['stop', SESSION_A.slice(0, 8)]],
  );
  assert.equal(f.cli.session(SESSION_A).live, false);
  assert.equal(f.cli.resumes.length, 0, 'tick 2 resumes nothing');
  assertDelivery(f, key, SESSION_A, 'waiting:settling');
  assert.deepEqual(f.inboxLines(SESSION_A), [notice], 'no second line');

  await tickAfter(f, TICK_MS);
  assert.deepEqual(resumeOutcomes(f), ['continued'], 'tick 3 resumes once, same id');
  assert.equal(f.cli.forks.length, 0, 'no copy');
  assert.equal(f.cli.entryCount(), 1, 'the listing did not grow');
  assert.equal(f.cli.session(SESSION_A).live, true);
  assert.deepEqual(
    f.exec.spawns().map(({ args }) => args),
    [['--bg', '--resume', SESSION_A, '--', notice]],
  );
  assertDelivery(f, key, SESSION_A, 'delivered:resumed');
  assert.equal(f.entry(key).lastNotifiedTs, NEW_MESSAGE_TS, 'the cursor advances');
});

test('trap: no tick resumes inside the settle gap, the Resume button and a second link included', async (t) => {
  const { f, key } = await wakeScenario(t);
  await wakeUntilStopped(f);
  const stoppedAtMs = f.cli.stops[0].atMs;

  f.clock.set(stoppedAtMs + 1_000);
  await f.watcher.resume();
  assert.equal(f.cli.resumes.length, 0, 'the Resume button tick does not resume');
  assert.equal(f.exec.spawns().length, 0);
  assertDelivery(f, key, SESSION_A, 'waiting:settling');

  const secondKey = await secondLinkWithNewMessage(f, [SESSION_A]);
  await tickAt(f, stoppedAtMs + 2_000);
  assert.equal(f.cli.resumes.length, 0, 'a second link notice inside the gap does not resume');

  await tickAt(f, stoppedAtMs + SETTLE_MS - 1);
  assert.equal(f.cli.resumes.length, 0, 'one millisecond before the gap ends');
  assert.equal(f.cli.forks.length, 0, 'no copy was made');

  await tickAt(f, stoppedAtMs + SETTLE_MS);
  assert.deepEqual(resumeOutcomes(f), ['continued'], 'exactly one resume, same id');
  assert.equal(f.exec.spawns().length, 1);
  assert.equal(f.cli.forks.length, 0);
  assert.equal(f.cli.entryCount(), 1);
  assertDelivery(f, key, SESSION_A, 'delivered:resumed');
  assert.equal(f.entry(key).lastNotifiedTs, NEW_MESSAGE_TS);
  assertDelivery(f, secondKey, SESSION_A, 'delivered:resumed');
  assert.equal(f.entry(secondKey).lastNotifiedTs, f.threads.newest(secondKey).ts);
});

test('grace: the append tick never stops and an early tick waits for the 60 s grace', async (t) => {
  assert.equal(exported, true, 'the watcher exports its settle gap, grace and deadline');
  assert.equal(WAKE_GRACE_MS, 60_000);
  assert.equal(WAKE_DEADLINE_MS, 7_200_000);
  assert.ok(SETTLE_MS >= TRAP_WINDOW_MS, 'the settle gap covers the fake CLI trap window');
  const { f } = await wakeScenario(t);

  await f.tick();
  assert.equal(f.cli.stops.length, 0, 'the append tick stops nothing');

  await tickAt(f, START_MS + 1_000);
  assert.equal(f.cli.stops.length, 0, 'a tick one second later waits for the grace');

  await tickAt(f, START_MS + WAKE_GRACE_MS - 1);
  assert.equal(f.cli.stops.length, 0, 'one millisecond before the grace ends');

  await tickAt(f, START_MS + WAKE_GRACE_MS);
  assert.equal(f.cli.stops.length, 1, 'a tick a full grace after the line stops the session');
});

test('restart: a restart inside the settle gap never resumes early and never forks', async (t) => {
  const { f, key } = await wakeScenario(t);
  await wakeUntilStopped(f);
  f.clock.advance(1_000);
  await f.restart();
  const restartedAtMs = f.clock.now();

  await tickAfter(f, 1_000);
  assert.equal(f.cli.resumes.length, 0, 'a tick right after the restart does not resume');
  assertDelivery(f, key, SESSION_A, 'waiting:settling');

  await tickAt(f, restartedAtMs + SETTLE_MS - 1);
  assert.equal(f.cli.resumes.length, 0, 'nor one millisecond before the gap since the restart');
  assert.equal(f.cli.forks.length, 0);
  assertDelivery(f, key, SESSION_A, 'waiting:settling');

  await tickAt(f, restartedAtMs + SETTLE_MS + 1_000);
  assert.deepEqual(resumeOutcomes(f), ['continued'], 'one resume, same id');
  assert.equal(f.cli.forks.length, 0);
  assert.equal(f.cli.entryCount(), 1);
  assertDelivery(f, key, SESSION_A, 'delivered:resumed');
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

  await f.tick();
  for (let later = 0; later < 3; later++) await tickAfter(f, TICK_MS);

  for (const sessionId of [SESSION_A, SESSION_B, SESSION_C])
    assertDelivery(f, key, sessionId, 'delivered:inbox_only');
  assert.equal(f.exec.stops().length, 0, 'no stop call');
  assert.equal(f.exec.spawns().length, 0, 'no resume call');
  assert.equal(f.entry(key).lastNotifiedTs, NEW_MESSAGE_TS, 'the line settles the notice');
});

test('never stopped: a busy session waits and ends never_idle at the wake deadline', async (t) => {
  const { f, key } = await wakeScenario(t, { sessions: { [SESSION_A]: { status: 'busy' } } });

  await f.tick();
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

test('never stopped: a session busy at first and idle later joins the stop path', async (t) => {
  const { f, key } = await wakeScenario(t, { sessions: { [SESSION_A]: { status: 'busy' } } });

  await f.tick();
  await tickAfter(f, TICK_MS);
  assert.equal(f.exec.stops().length, 0, 'busy: no stop');
  assertDelivery(f, key, SESSION_A, 'waiting:awaiting_wake');

  f.cli.setStatus(SESSION_A, 'idle');
  await tickAfter(f, TICK_MS);
  assert.equal(f.cli.stops.length, 1, 'idle: the stop path runs');
  assertDelivery(f, key, SESSION_A, 'waiting:settling');

  await tickAfter(f, TICK_MS);
  assert.deepEqual(resumeOutcomes(f), ['continued']);
  assert.equal(f.cli.forks.length, 0);
  assertDelivery(f, key, SESSION_A, 'delivered:resumed');
});

test('never stopped: a watcher closed while its tick waits on the listing makes no stop call', async (t) => {
  async function stopTick(scenarioT, closeWatcherMidTick) {
    const { f } = await wakeScenario(scenarioT);
    await f.tick();
    f.clock.advance(TICK_MS);
    const hold = f.cli.hold('listing');
    const ticking = f.tick();
    await flush();
    if (closeWatcherMidTick) f.watcher.stop();
    hold.release();
    await ticking;
    return f;
  }

  const open = await stopTick(t, false);
  assert.equal(open.exec.stops().length, 1, 'control: an open watcher stops the session');

  const closed = await stopTick(t, true);
  assert.equal(closed.exec.stops().length, 0, 'a closed watcher makes no stop call');
  assert.equal(closed.exec.spawns().length, 0);
});

test('woke itself: an idle session that turns busy after the line is delivered without a stop', async (t) => {
  const { f, key } = await wakeScenario(t);
  await f.tick();
  assertDelivery(f, key, SESSION_A, 'waiting:awaiting_wake');

  f.cli.setStatus(SESSION_A, 'busy');
  await tickAfter(f, TICK_MS);
  assertDelivery(f, key, SESSION_A, 'delivered:woke_itself');
  assert.equal(f.exec.stops().length, 0, 'a session that woke on its own is not stopped');
  assert.equal(f.entry(key).lastNotifiedTs, NEW_MESSAGE_TS);

  f.cli.setStatus(SESSION_A, 'idle');
  await tickAfter(f, TICK_MS);
  await tickAfter(f, TICK_MS);
  assert.equal(f.exec.stops().length, 0, 'and going idle again starts nothing');
  assert.equal(f.exec.spawns().length, 0);
  assertDelivery(f, key, SESSION_A, 'delivered:woke_itself');
});

// ---------------------------------------------------------------------------------------------
// A stopped session is never stranded

test('stranded: a paused watcher still resumes the session it stopped, after the settle gap', async (t) => {
  const { f, key } = await wakeScenario(t);
  await wakeUntilStopped(f);

  await f.watcher.pause();
  await tickAfter(f, SETTLE_MS);

  assert.deepEqual(resumeOutcomes(f), ['continued'], 'one resume, same id');
  assert.equal(f.cli.forks.length, 0);
  assertDelivery(f, key, SESSION_A, 'delivered:resumed');
});

test('stranded: a paused watcher never stops a session', async (t) => {
  const { f, key } = await wakeScenario(t);
  await f.tick();
  assertDelivery(f, key, SESSION_A, 'waiting:awaiting_wake');

  await f.watcher.pause();
  await tickAfter(f, WAKE_GRACE_MS + TICK_MS);
  await tickAfter(f, TICK_MS);

  assert.equal(f.exec.stops().length, 0, 'a paused tick never stops');
  assert.equal(f.exec.spawns().length, 0);
});

test('stranded: a session detached after its stop is still resumed once', async (t) => {
  const { f, key } = await wakeScenario(t);
  await wakeUntilStopped(f);

  await f.store.detach(key, SESSION_A);
  await tickAfter(f, SETTLE_MS);

  assert.deepEqual(resumeOutcomes(f), ['continued'], 'one resume, same id');
  assert.deepEqual(
    f.exec.spawns().map(({ args }) => args[2]),
    [SESSION_A],
  );
  assert.equal(f.cli.forks.length, 0);
});

test('stranded: a link in backoff does not hold back the resume of a stopped session', async (t) => {
  const { f, key } = await wakeScenario(t);
  await wakeUntilStopped(f);
  const stoppedAtMs = f.cli.stops[0].atMs;

  f.fakeReader.script(() => ({ ok: false, reason: 'rate_limited', retryAfterSeconds: 3600 }));
  await tickAt(f, stoppedAtMs + 1_000);
  const readsInBackoff = f.fakeReader.calls.length;

  await tickAt(f, stoppedAtMs + SETTLE_MS);
  assert.equal(
    f.fakeReader.calls.length,
    readsInBackoff,
    'the link was not read: it is backed off',
  );
  assert.deepEqual(resumeOutcomes(f), ['continued'], 'one resume, same id');
  assert.equal(f.cli.forks.length, 0);
  assertDelivery(f, key, SESSION_A, 'delivered:resumed');
});

// ---------------------------------------------------------------------------------------------
// Attempts and terminal outcomes

test('attempts: waiting costs no attempt, so a normal wake never reaches a failure', async (t) => {
  const { f, key } = await wakeScenario(t, { sessions: { [SESSION_A]: { status: 'busy' } } });
  const observed = [];

  await f.tick();
  observed.push(deliveryWords(f, key));
  for (let wait = 0; wait < MAX_DELIVERY_ATTEMPTS + 1; wait++) {
    await tickAfter(f, TICK_MS);
    observed.push(deliveryWords(f, key));
  }
  f.cli.setStatus(SESSION_A, 'idle');
  await tickAfter(f, TICK_MS);
  observed.push(deliveryWords(f, key));
  await tickAfter(f, TICK_MS);
  observed.push(deliveryWords(f, key));

  assert.deepEqual(observed, [
    ...Array(MAX_DELIVERY_ATTEMPTS + 2).fill('waiting:awaiting_wake'),
    'waiting:settling',
    'delivered:resumed',
  ]);
  assert.equal(f.cli.forks.length, 0);
});

test('attempts: three failing stops end failed-permanent with the last reason', async (t) => {
  const { f, key } = await wakeScenario(t);
  f.cli.failNext('stop', { exitCode: 1, stderr: 'stop refused' }, MAX_DELIVERY_ATTEMPTS);
  const observed = [];

  await f.tick();
  observed.push(deliveryWords(f, key));
  for (let attempt = 0; attempt < MAX_DELIVERY_ATTEMPTS; attempt++) {
    await tickAfter(f, TICK_MS);
    observed.push(deliveryWords(f, key));
  }

  assert.deepEqual(observed, [
    'waiting:awaiting_wake',
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

  await f.tick();
  observed.push(deliveryWords(f, key));
  for (let step = 0; step < MAX_DELIVERY_ATTEMPTS + 1; step++) {
    await tickAfter(f, TICK_MS);
    observed.push(deliveryWords(f, key));
  }

  assert.deepEqual(observed, [
    'waiting:awaiting_wake',
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

  await tickAfter(f, TICK_MS);
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

test('attempts: a session live again at resume time goes back to waiting', async (t) => {
  const { f, key } = await wakeScenario(t);
  await wakeUntilStopped(f);

  f.cli.revive(SESSION_A, 'busy');
  await tickAfter(f, SETTLE_MS);

  assert.equal(f.delivery(key, SESSION_A)?.status, 'waiting');
  assert.equal(f.exec.spawns().length, 0, 'a live session is not resumed');
  assert.equal(f.cli.forks.length, 0);

  f.cli.setStatus(SESSION_A, 'idle');
  await tickAfter(f, TICK_MS);
  await tickAfter(f, TICK_MS);
  assert.equal(f.cli.stops.length, 2, 'back in the wake, an idle session is stopped again');
  assert.deepEqual(resumeOutcomes(f), ['continued'], 'and resumed under its own id');
  assertDelivery(f, key, SESSION_A, 'delivered:resumed');
});

// ---------------------------------------------------------------------------------------------
// The wake outcome reaches only the lines that are in the inbox

// Each ending opens a wake on the first link through `scenario`, brings it to the point where the
// next tick ends it with `outcome`, and names the clock of that tick. A second link of the same
// session gets its message before that tick.
const WAKE_ENDINGS = {
  resumed: {
    outcome: 'delivered:resumed',
    scenario: {},
    prepare: wakeUntilStopped,
    endAtMs: (f) => f.cli.stops[0].atMs + SETTLE_MS,
  },
  woke_itself: {
    outcome: 'delivered:woke_itself',
    scenario: {},
    async prepare(f) {
      await f.tick();
      f.cli.setStatus(SESSION_A, 'busy');
    },
    endAtMs: () => START_MS + TICK_MS,
  },
  'failed-permanent': {
    outcome: 'failed-permanent:never_idle',
    scenario: { sessions: { [SESSION_A]: { status: 'busy' } } },
    async prepare(f) {
      await f.tick();
      f.clock.set(START_MS + WAKE_DEADLINE_MS - 100_000);
    },
    endAtMs: () => START_MS + WAKE_DEADLINE_MS + 1_000,
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
  await tickAt(f, ending.endAtMs(f));
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
      'the next tick retries the append and writes the line',
    );
    for (let later = 0; later < 3; later++) await tickAfter(f, TICK_MS);
    assert.deepEqual(f.inboxLines(SESSION_A), [firstNotice, secondNotice], 'and never again');
    assert.equal(append.attemptsFor(secondNotice), 2, 'one attempt that failed, one that wrote');
    assert.equal(append.attemptsFor(firstNotice), 1, 'the retry repeats only the failed step');
  });

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
  await f.tick();
  await checkpoint('appended');
  await tickAfter(f, TICK_MS);
  await checkpoint('stopped');
  await tickAfter(f, TICK_MS);
  await checkpoint('resumed');

  f.cli.trapWindowMs = NEVER_RESUMES_MS;
  await secondLinkWithNewMessage(f, [SESSION_B]);
  await tickAfter(f, TICK_MS);
  await tickAfter(f, TICK_MS);
  await tickAfter(f, TICK_MS);
  await checkpoint('forked');

  assert.deepEqual(leaks, []);
  assert.ok(f.cli.stops.length >= 2, 'the scenario stopped both sessions');
  assert.ok(resumeOutcomes(f).includes('continued'), 'and continued one of them');
  assert.ok(f.cli.forks.length >= 1, 'and forked a resume of the other');
});
