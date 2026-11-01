// slack-watcher.test.mjs — the watcher's tick: baseline, wake rule, per-session delivery, backoff,
// scheduling, pause and resume, states, pruning and the per-tick wake cap.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  watchFixture,
  flush,
  tsAt,
  listingEntry,
  permalinkFor,
  START_MS,
  SESSION_A,
  SESSION_B,
  SESSION_C,
  ME,
  OTHER,
} from './slack-watch-fixture.mjs';

const TICK_GAP_MS = 180_000;
const FINISHED_CWD = '/work/finished-session';
const UNUSABLE_LISTINGS = {
  'a timeout': { timeout: true },
  'a non-zero exit': { exitCode: 1, stderr: 'listing failed' },
  'a missing CLI': { spawnError: 'ENOENT' },
};
const BASELINE_TS = tsAt(-100, 100);
const NOTICE = `There's a new message on ${permalinkFor()}`;
const OTHER_THREAD_TS = '1793192300.000100';
const SNAKE_CASE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const CONCURRENT_READS = 3;
const LINES_PER_TICK = 20;
const PRUNE_INTERVAL_MS = 600_000;
const WRITE_METHODS = /^(append|write|rename|unlink|rm|mkdir|copy|truncate)/;

function post(f, key, user, offsetSeconds, micro = 0) {
  const ts = tsAt(offsetSeconds, micro);
  f.threads.post(key, user ? { user, ts } : { ts });
  return ts;
}

async function tickAfterGap(f, gapMs = TICK_GAP_MS) {
  f.clock.advance(gapMs);
  await f.tick();
}

// An entry with no `activity` is a live session with no idle status: it gets only its line.
function listSessions(f, sessionIds, states = {}) {
  f.fakeSessions.setSessions(
    sessionIds.map((sessionId) => ({ sessionId, state: states[sessionId] ?? 'live' })),
  );
}

// A link with its sessions attached and its first tick done: the cursor sits on the message that
// predates the attach and nothing has been written. Sessions are listed live with no idle status
// unless told otherwise, so they get only their line and no pruning, stop or resume step interferes.
async function baselinedLink(t, { sessionIds = [SESSION_A], states = {}, ...options } = {}) {
  const f = await watchFixture(t, options);
  const key = await f.watch({ sessionIds, messages: [{ user: OTHER, ts: BASELINE_TS }] });
  listSessions(f, sessionIds, states);
  await f.tick();
  assert.equal(f.totalLines(), 0, 'attaching under an existing message must not wake');
  assert.equal(f.entry(key).lastNotifiedTs, BASELINE_TS);
  return { f, key };
}

const threadTsFor = (index) => `${1_793_192_214 + index}.000100`;
const sessionUuid = (index) => `a0000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;

async function watchLinks(f, count, sessionIdFor) {
  const keys = [];
  for (let index = 0; index < count; index++)
    keys.push(
      await f.watch({
        threadTs: threadTsFor(index),
        sessionIds: [sessionIdFor(index)],
        messages: [{ user: OTHER, ts: BASELINE_TS }],
      }),
    );
  return keys;
}

// Decorates the store so `append` rejects for one session a fixed number of times, and counts every
// append attempt per session.
function failingAppend({ sessionId, failures }) {
  const attempts = new Map();
  let remaining = failures;
  return {
    attempts: (id) => attempts.get(id) ?? 0,
    wrapStore: (store) => ({
      ...store,
      async append(id, line) {
        attempts.set(id, (attempts.get(id) ?? 0) + 1);
        if (id === sessionId && remaining > 0) {
          remaining -= 1;
          throw new Error('synthetic append failure');
        }
        return store.append(id, line);
      },
    }),
  };
}

function assertDelivery(f, key, sessionId, expected) {
  const delivery = f.delivery(key, sessionId);
  assert.equal(delivery?.status, expected.status, `delivery status of ${sessionId}`);
  if ('reason' in expected)
    assert.equal(delivery.reason, expected.reason, `delivery reason of ${sessionId}`);
}

// Runs one tick with the Slack read held open, lets `whileReading` change the store, then lets the
// read return and finishes the tick.
async function tickWhileReading(f, whileReading) {
  const hold = f.fakeReader.hold();
  f.clock.advance(TICK_GAP_MS);
  const readsBefore = f.fakeReader.calls.length;
  const tick = f.tick();
  await flush();
  assert.equal(f.fakeReader.calls.length, readsBefore + 1, 'the tick is waiting on its read');
  await whileReading();
  hold.release();
  await tick;
}

// A finished session on one link with a not-mine message waiting, after a quiet baseline tick, and
// then a session listing that cannot be used.
async function unusableListingLink(t, outcome) {
  const f = await watchFixture(t, { sessions: 'real' });
  const key = await f.watch({
    sessionIds: [SESSION_C],
    messages: [{ user: OTHER, ts: BASELINE_TS }],
  });
  f.exec.setListing([listingEntry({ sessionId: SESSION_C, cwd: FINISHED_CWD })]);
  await f.tick();
  assert.equal(f.entry(key).lastNotifiedTs, BASELINE_TS);
  f.exec.onListing(() => outcome);
  const messageTs = post(f, key, OTHER, 10);
  return { f, key, messageTs };
}

async function settlesWithoutRelease(promise) {
  const outcome = await Promise.race([
    promise.then(() => 'settled'),
    flush(100).then(() => 'blocked'),
  ]);
  return outcome === 'settled';
}

const writeCalls = (f) =>
  f.recorder.calls.map(({ method }) => method).filter((method) => WRITE_METHODS.test(method));

// ---------------------------------------------------------------------------------------------
// Baseline: attaching never wakes

test('baseline: attaching under another users newest message writes no line and records its ts', async (t) => {
  const f = await watchFixture(t);
  const key = await f.watch({
    sessionIds: [SESSION_A],
    messages: [
      { user: OTHER, ts: tsAt(-200) },
      { user: OTHER, ts: tsAt(-100, 100) },
    ],
  });
  await f.tick();
  assert.equal(f.totalLines(), 0);
  assert.equal(f.entry(key).lastNotifiedTs, tsAt(-100, 100));
});

test('baseline: a not-mine message posted after the attach wakes the session once at the first tick', async (t) => {
  const f = await watchFixture(t);
  const key = await f.watch({
    sessionIds: [SESSION_A],
    messages: [
      { user: OTHER, ts: tsAt(-100) },
      { user: OTHER, ts: tsAt(60) },
    ],
  });
  await f.tick();
  assert.equal(f.inboxLines(SESSION_A).length, 1);
  assert.equal(f.entry(key).lastNotifiedTs, tsAt(60));
});

test('baseline: a not-mine message posted after a quiet first tick wakes the session once', async (t) => {
  const { f, key } = await baselinedLink(t);
  const messageTs = post(f, key, OTHER, 60);
  await tickAfterGap(f);
  assert.equal(f.inboxLines(SESSION_A).length, 1);
  assert.equal(f.entry(key).lastNotifiedTs, messageTs);
});

test('baseline: a link with no session is never read', async (t) => {
  const f = await watchFixture(t);
  await f.watch({ sessionIds: [], messages: [{ user: OTHER, ts: tsAt(-100) }] });
  await f.tick();
  await tickAfterGap(f);
  assert.equal(f.fakeReader.calls.length, 0);
});

test('baseline: attaching a session makes no reader call until a tick', async (t) => {
  const f = await watchFixture(t);
  const key = await f.watch({ sessionIds: [], messages: [{ user: OTHER, ts: tsAt(-100) }] });
  await f.store.attach(key, SESSION_A);
  assert.equal(f.fakeReader.calls.length, 0);
  await f.tick();
  assert.equal(f.fakeReader.calls.length, 1);
});

test('baseline: a link whose last session detached and later re-attached is re-baselined', async (t) => {
  const { f, key } = await baselinedLink(t);
  await f.store.detach(key, SESSION_A);
  const readsWhileUnattached = f.fakeReader.calls.length;
  await tickAfterGap(f);
  assert.equal(f.fakeReader.calls.length, readsWhileUnattached, 'no session, no read');

  f.clock.advance(TICK_GAP_MS);
  const earlierTs = post(f, key, OTHER, 30);
  listSessions(f, [SESSION_B]);
  await f.store.attach(key, SESSION_B);
  assert.equal(f.fakeReader.calls.length, readsWhileUnattached, 'attach makes no reader call');

  await f.tick();
  assert.equal(f.totalLines(), 0, 'a message from before the re-attach must not wake');
  assert.equal(f.entry(key).lastNotifiedTs, earlierTs);
});

for (const [label, replacement] of [
  ['the same session', SESSION_A],
  ['a new session', SESSION_B],
])
  test(`baseline: ${label} attaching after the last one detached during the read is re-baselined and never wakes for an earlier message`, async (t) => {
    const { f, key } = await baselinedLink(t);
    listSessions(f, [SESSION_A, SESSION_B]);
    const earlierTs = post(f, key, OTHER, 10);

    await tickWhileReading(f, async () => {
      await f.store.detach(key, SESSION_A);
      await f.store.attach(key, replacement);
    });
    assert.equal(f.totalLines(), 0, 'a message from before the new attach must not wake');
    assert.equal(
      f.entry(key).lastNotifiedTs,
      null,
      'the stale cursor must not overwrite the baseline',
    );

    await tickAfterGap(f);
    assert.equal(f.totalLines(), 0, 'the next read resolves the baseline without a line');
    assert.equal(f.entry(key).lastNotifiedTs, earlierTs);

    const laterTs = post(f, key, OTHER, 400);
    await tickAfterGap(f);
    assert.equal(f.inboxLines(replacement).length, 1, 'a message after the attach wakes once');
    assert.equal(f.entry(key).lastNotifiedTs, laterTs);
  });

// ---------------------------------------------------------------------------------------------
// Wake rule

test('wake rule: the newest message being the users own never wakes', async (t) => {
  const { f, key } = await baselinedLink(t);
  post(f, key, ME, 10);
  await tickAfterGap(f);
  await tickAfterGap(f);
  assert.equal(f.totalLines(), 0);
});

test('wake rule: a reply a session posted as the user after a wake adds no further line', async (t) => {
  const { f, key } = await baselinedLink(t);
  post(f, key, OTHER, 10);
  await tickAfterGap(f);
  assert.equal(f.inboxLines(SESSION_A).length, 1);
  post(f, key, ME, 20);
  await tickAfterGap(f);
  await tickAfterGap(f);
  assert.equal(f.inboxLines(SESSION_A).length, 1);
});

test('wake rule: a further tick with no change, as after a reaction, writes nothing more', async (t) => {
  const { f, key } = await baselinedLink(t);
  post(f, key, OTHER, 10);
  await tickAfterGap(f);
  assert.equal(f.inboxLines(SESSION_A).length, 1);
  await tickAfterGap(f);
  await tickAfterGap(f);
  assert.equal(f.inboxLines(SESSION_A).length, 1);
});

test('wake rule: an edit that re-reads the same ts writes nothing more', async (t) => {
  const { f, key } = await baselinedLink(t);
  post(f, key, OTHER, 10);
  await tickAfterGap(f);
  f.threads.set(
    key,
    f.threads.messages(key).map((message) => ({ ...message, text: 'edited' })),
  );
  await tickAfterGap(f);
  assert.equal(f.inboxLines(SESSION_A).length, 1);
});

test('wake rule: deleting the newest message so an older one shows again writes nothing more', async (t) => {
  const { f, key } = await baselinedLink(t);
  post(f, key, OTHER, 10);
  await tickAfterGap(f);
  const newestTs = post(f, key, OTHER, 20);
  await tickAfterGap(f);
  assert.equal(f.inboxLines(SESSION_A).length, 2);
  f.threads.remove(key, newestTs);
  await tickAfterGap(f);
  await tickAfterGap(f);
  assert.equal(f.inboxLines(SESSION_A).length, 2);
});

test('wake rule: a bot message with no user never wakes and does not block the next real one', async (t) => {
  const { f, key } = await baselinedLink(t);
  post(f, key, undefined, 10);
  await tickAfterGap(f);
  assert.equal(f.totalLines(), 0);
  post(f, key, OTHER, 20);
  await tickAfterGap(f);
  assert.equal(f.inboxLines(SESSION_A).length, 1);
});

test('wake rule: another user posting next gives each attached session exactly one notice line', async (t) => {
  const { f, key } = await baselinedLink(t, { sessionIds: [SESSION_A, SESSION_B] });
  const messageTs = post(f, key, OTHER, 10);
  await tickAfterGap(f);
  assert.deepEqual(f.inboxLines(SESSION_A), [NOTICE]);
  assert.deepEqual(f.inboxLines(SESSION_B), [NOTICE]);
  assert.equal(f.entry(key).lastNotifiedTs, messageTs);
  await tickAfterGap(f);
  assert.equal(f.totalLines(), 2, 'a further tick with no change writes nothing more');
});

// ---------------------------------------------------------------------------------------------
// Delivery: per-session status, retry and race

test('delivery: MAX_DELIVERY_ATTEMPTS is 3', async () => {
  const { MAX_DELIVERY_ATTEMPTS } = await import('../backend/slack-watcher.mjs');
  assert.equal(MAX_DELIVERY_ATTEMPTS, 3);
});

test('delivery: a permanently failing session is recorded once and never repeats notices to the others', async (t) => {
  const { f, key } = await baselinedLink(t, {
    sessionIds: [SESSION_A, SESSION_B, SESSION_C],
    states: { [SESSION_C]: 'finished' },
  });
  f.fakeSessions.onResume(SESSION_C, { status: 'failed-permanent', reason: 'untrusted_workspace' });
  for (const sessionId of [SESSION_A, SESSION_B, SESSION_C])
    assert.equal(f.delivery(key, sessionId), null, 'no attempt has been made yet');

  const messageTs = post(f, key, OTHER, 10);
  await tickAfterGap(f);
  assert.equal(f.entry(key).lastNotifiedTs, messageTs, 'the cursor advances on the first tick');
  const linesAfterFirstTick = f.totalLines();

  for (let tick = 0; tick < 5; tick++) await tickAfterGap(f);
  assert.equal(f.inboxLines(SESSION_A).length, 1);
  assert.equal(f.inboxLines(SESSION_B).length, 1);
  assert.equal(f.totalLines(), linesAfterFirstTick, 'no later tick writes a line');
  assertDelivery(f, key, SESSION_A, { status: 'delivered', reason: 'inbox_only' });
  assertDelivery(f, key, SESSION_B, { status: 'delivered', reason: 'inbox_only' });
  assert.deepEqual(f.delivery(key, SESSION_C), {
    status: 'failed-permanent',
    reason: 'untrusted_workspace',
    at: new Date(START_MS + TICK_GAP_MS).toISOString(),
  });
  assert.equal(
    f.fakeSessions.resumeCalls.filter(({ sessionId }) => sessionId === SESSION_C).length,
    1,
    'a permanent failure is never retried for that notice',
  );
  assert.deepEqual(
    f.fakeSessions.resumeCalls.filter(({ sessionId }) => sessionId !== SESSION_C),
    [],
    'a live session with no idle status gets only its line',
  );
});

test('delivery: a transient append failure is retried once per tick and delivers without repeats', async (t) => {
  const append = failingAppend({ sessionId: SESSION_B, failures: 2 });
  const { f, key } = await baselinedLink(t, {
    sessionIds: [SESSION_A, SESSION_B],
    wrapStore: append.wrapStore,
  });
  const messageTs = post(f, key, OTHER, 10);

  await tickAfterGap(f);
  assert.equal(f.entry(key).lastNotifiedTs, BASELINE_TS, 'the cursor waits for every session');
  assertDelivery(f, key, SESSION_A, { status: 'delivered' });
  assertDelivery(f, key, SESSION_B, { status: 'failed-transient', reason: 'append_failed' });
  assert.equal(f.inboxLines(SESSION_A).length, 1);
  assert.equal(f.inboxLines(SESSION_B).length, 0);
  assert.equal(append.attempts(SESSION_B), 1);

  await tickAfterGap(f);
  assert.equal(f.entry(key).lastNotifiedTs, BASELINE_TS);
  assertDelivery(f, key, SESSION_B, { status: 'failed-transient', reason: 'append_failed' });
  assert.equal(append.attempts(SESSION_A), 1, 'a delivered session is not sent the notice again');
  assert.equal(append.attempts(SESSION_B), 2, 'the failed step is retried once per tick');

  await tickAfterGap(f);
  assertDelivery(f, key, SESSION_B, { status: 'delivered' });
  assert.equal(
    f.entry(key).lastNotifiedTs,
    messageTs,
    'the retry that succeeds advances the cursor',
  );
  assert.equal(f.inboxLines(SESSION_A).length, 1);
  assert.equal(f.inboxLines(SESSION_B).length, 1);

  await tickAfterGap(f);
  assert.equal(append.attempts(SESSION_A), 1);
  assert.equal(append.attempts(SESSION_B), 3);
  assert.equal(f.totalLines(), 2);
});

test('delivery: a failed spawn step is retried alone and the inbox line is written once', async (t) => {
  const { f, key } = await baselinedLink(t, {
    sessionIds: [SESSION_C],
    states: { [SESSION_C]: 'finished' },
  });
  f.fakeSessions.onResume(SESSION_C, [
    { status: 'failed-transient', reason: 'spawn_failed' },
    { status: 'failed-transient', reason: 'timed_out' },
    { status: 'delivered' },
  ]);
  const messageTs = post(f, key, OTHER, 10);

  await tickAfterGap(f);
  assertDelivery(f, key, SESSION_C, { status: 'failed-transient', reason: 'spawn_failed' });
  assert.equal(f.entry(key).lastNotifiedTs, BASELINE_TS);
  assert.deepEqual(f.fakeSessions.resumeCalls[0], { sessionId: SESSION_C, notice: NOTICE });

  await tickAfterGap(f);
  assertDelivery(f, key, SESSION_C, { status: 'failed-transient', reason: 'timed_out' });
  assert.equal(f.entry(key).lastNotifiedTs, BASELINE_TS);

  await tickAfterGap(f);
  assertDelivery(f, key, SESSION_C, { status: 'delivered' });
  assert.equal(
    f.entry(key).lastNotifiedTs,
    messageTs,
    'the cursor advances on the delivering tick',
  );

  await tickAfterGap(f);
  assert.equal(f.fakeSessions.resumeCalls.length, 3);
  assert.equal(f.inboxLines(SESSION_C).length, 1, 'only the failed step is repeated');
});

test('delivery: the third failed append gives up with the last reason and advances the cursor', async (t) => {
  const append = failingAppend({ sessionId: SESSION_B, failures: Infinity });
  const { f, key } = await baselinedLink(t, {
    sessionIds: [SESSION_A, SESSION_B],
    wrapStore: append.wrapStore,
  });
  const messageTs = post(f, key, OTHER, 10);

  await tickAfterGap(f);
  await tickAfterGap(f);
  assertDelivery(f, key, SESSION_B, { status: 'failed-transient', reason: 'append_failed' });
  assert.equal(f.entry(key).lastNotifiedTs, BASELINE_TS);

  await tickAfterGap(f);
  assertDelivery(f, key, SESSION_B, { status: 'failed-permanent', reason: 'append_failed' });
  assert.equal(f.entry(key).lastNotifiedTs, messageTs);

  await tickAfterGap(f);
  assert.equal(append.attempts(SESSION_B), 3, 'a fourth tick makes no further attempt');
  assert.equal(f.inboxLines(SESSION_A).length, 1);
});

test('delivery: the third failed spawn gives up with the last failure reason', async (t) => {
  const { f, key } = await baselinedLink(t, {
    sessionIds: [SESSION_C],
    states: { [SESSION_C]: 'finished' },
  });
  f.fakeSessions.onResume(SESSION_C, [
    { status: 'failed-transient', reason: 'spawn_failed' },
    { status: 'failed-transient', reason: 'spawn_failed' },
    { status: 'failed-transient', reason: 'timed_out' },
  ]);
  const messageTs = post(f, key, OTHER, 10);

  await tickAfterGap(f);
  await tickAfterGap(f);
  assert.equal(f.entry(key).lastNotifiedTs, BASELINE_TS);
  await tickAfterGap(f);
  assertDelivery(f, key, SESSION_C, { status: 'failed-permanent', reason: 'timed_out' });
  assert.equal(f.entry(key).lastNotifiedTs, messageTs);

  await tickAfterGap(f);
  assert.equal(f.fakeSessions.resumeCalls.length, 3, 'a fourth tick makes no further attempt');
});

test('delivery: a new not-mine message after a failure attempts every session afresh', async (t) => {
  const append = failingAppend({ sessionId: SESSION_B, failures: Infinity });
  const { f, key } = await baselinedLink(t, {
    sessionIds: [SESSION_A, SESSION_B],
    wrapStore: append.wrapStore,
  });
  post(f, key, OTHER, 10);
  for (let tick = 0; tick < 4; tick++) await tickAfterGap(f);
  assertDelivery(f, key, SESSION_B, { status: 'failed-permanent', reason: 'append_failed' });
  assert.equal(append.attempts(SESSION_B), 3);
  assert.equal(f.inboxLines(SESSION_A).length, 1);

  const secondTs = post(f, key, OTHER, 20);
  await tickAfterGap(f);
  assert.equal(f.inboxLines(SESSION_A).length, 2, 'the healthy session gets the new notice');
  assert.equal(append.attempts(SESSION_B), 4, 'the failed session is attempted afresh');
  assertDelivery(f, key, SESSION_B, { status: 'failed-transient', reason: 'append_failed' });

  await tickAfterGap(f);
  assert.equal(append.attempts(SESSION_B), 5);
  await tickAfterGap(f);
  assert.equal(append.attempts(SESSION_B), 6, 'the attempt count was reset: up to three again');
  assertDelivery(f, key, SESSION_B, { status: 'failed-permanent', reason: 'append_failed' });
  assert.equal(f.entry(key).lastNotifiedTs, secondTs);

  await tickAfterGap(f);
  assert.equal(append.attempts(SESSION_B), 6);
  assert.equal(append.attempts(SESSION_A), 2);
});

test('delivery: a message landing after the read and before the session reads gets a further line', async (t) => {
  const thread = {};
  let landed = false;
  const wrapStore = (store) => ({
    ...store,
    async append(sessionId, line) {
      if (!landed) {
        landed = true;
        post(thread.f, thread.key, OTHER, 20, 7);
      }
      return store.append(sessionId, line);
    },
  });
  const { f, key } = await baselinedLink(t, { wrapStore });
  Object.assign(thread, { f, key });
  const firstTs = post(f, key, OTHER, 10);

  await tickAfterGap(f);
  assert.equal(f.inboxLines(SESSION_A).length, 1);
  assert.equal(f.entry(key).lastNotifiedTs, firstTs, 'the cursor covers only what was read');

  await tickAfterGap(f);
  assert.equal(f.inboxLines(SESSION_A).length, 2, 'a redundant wake, never a missing one');
  assert.equal(f.entry(key).lastNotifiedTs, tsAt(20, 7));
});

test('delivery: a session attaching during the read hears the message that triggered it', async (t) => {
  const { f, key } = await baselinedLink(t);
  listSessions(f, [SESSION_A, SESSION_B]);
  const messageTs = post(f, key, OTHER, 10);

  await tickWhileReading(f, () => f.store.attach(key, SESSION_B));

  assert.deepEqual(f.inboxLines(SESSION_A), [NOTICE]);
  assert.deepEqual(f.inboxLines(SESSION_B), [NOTICE], 'the new session also gets the line');
  assertDelivery(f, key, SESSION_A, { status: 'delivered' });
  assertDelivery(f, key, SESSION_B, { status: 'delivered' });
  assert.equal(f.entry(key).lastNotifiedTs, messageTs);

  await tickAfterGap(f);
  assert.equal(f.totalLines(), 2, 'a further tick writes nothing more');
});

test('delivery: a session detaching during the read no longer holds the cursor', async (t) => {
  const { f, key } = await baselinedLink(t, { sessionIds: [SESSION_A, SESSION_B] });
  const messageTs = post(f, key, OTHER, 10);

  await tickWhileReading(f, () => f.store.detach(key, SESSION_B));

  assert.deepEqual(f.inboxLines(SESSION_A), [NOTICE]);
  assert.equal(f.entry(key).lastNotifiedTs, messageTs, 'settled over the sessions that remain');
  assert.deepEqual(f.entry(key).sessionIds, [SESSION_A]);
});

test('delivery: a session absent from a good listing is delivered with its line and reason not_listed', async (t) => {
  const f = await watchFixture(t);
  const key = await f.watch({
    sessionIds: [SESSION_A],
    messages: [{ user: OTHER, ts: BASELINE_TS }],
  });
  f.fakeSessions.setSessions([{ sessionId: SESSION_B, state: 'live' }]);
  await f.tick();
  const messageTs = post(f, key, OTHER, 10);

  await tickAfterGap(f);

  assert.deepEqual(f.inboxLines(SESSION_A), [NOTICE]);
  assert.deepEqual(f.delivery(key, SESSION_A), {
    status: 'delivered',
    reason: 'not_listed',
    at: new Date(START_MS + TICK_GAP_MS).toISOString(),
  });
  assert.deepEqual(f.fakeSessions.resumeCalls, [], 'no resume for a session nobody listed');
  assert.equal(f.entry(key).lastNotifiedTs, messageTs);
});

for (const [label, outcome] of Object.entries(UNUSABLE_LISTINGS))
  test(`delivery: with ${label} for the listing a finished session is failed-transient listing_unavailable after its line`, async (t) => {
    const { f, key } = await unusableListingLink(t, outcome);

    await tickAfterGap(f);

    assert.deepEqual(f.inboxLines(SESSION_C), [NOTICE], 'the line is written first');
    assertDelivery(f, key, SESSION_C, {
      status: 'failed-transient',
      reason: 'listing_unavailable',
    });
    assert.equal(f.entry(key).lastNotifiedTs, BASELINE_TS, 'the cursor waits');
    assert.deepEqual(f.exec.spawns(), [], 'nothing is resumed without a usable listing');
  });

test('delivery: an unusable listing repeats only the resume step and the third failure is failed-permanent', async (t) => {
  const { f, key, messageTs } = await unusableListingLink(t, { timeout: true });

  await tickAfterGap(f);
  await tickAfterGap(f);
  assertDelivery(f, key, SESSION_C, { status: 'failed-transient', reason: 'listing_unavailable' });
  assert.equal(f.entry(key).lastNotifiedTs, BASELINE_TS);
  assert.deepEqual(f.inboxLines(SESSION_C), [NOTICE], 'a retry never appends a second line');

  await tickAfterGap(f);
  assertDelivery(f, key, SESSION_C, { status: 'failed-permanent', reason: 'listing_unavailable' });
  assert.equal(f.entry(key).lastNotifiedTs, messageTs, 'the third failure lets the cursor advance');

  await tickAfterGap(f);
  assertDelivery(f, key, SESSION_C, { status: 'failed-permanent', reason: 'listing_unavailable' });
  assert.deepEqual(f.inboxLines(SESSION_C), [NOTICE]);
  assert.deepEqual(f.exec.spawns(), []);
});

test('delivery: a listing that recovers on the retry lets the resume step run once and deliver', async (t) => {
  const { f, key, messageTs } = await unusableListingLink(t, { timeout: true });

  await tickAfterGap(f);
  assertDelivery(f, key, SESSION_C, { status: 'failed-transient', reason: 'listing_unavailable' });

  f.exec.setListing([listingEntry({ sessionId: SESSION_C, cwd: FINISHED_CWD })]);
  await tickAfterGap(f);

  assertDelivery(f, key, SESSION_C, { status: 'delivered' });
  assert.equal(f.entry(key).lastNotifiedTs, messageTs);
  assert.deepEqual(f.inboxLines(SESSION_C), [NOTICE], 'still one line');
  assert.equal(f.exec.spawns().length, 1);
  assert.deepStrictEqual(f.exec.spawns()[0].args, ['--bg', '--resume', SESSION_C, '--', NOTICE]);
});

// ---------------------------------------------------------------------------------------------
// Backoff: reader failures keep state and never throw

const READER_FAILURES = [
  { reason: 'rate_limited', result: { ok: false, reason: 'rate_limited', retryAfterSeconds: 120 } },
  { reason: 'not_connected', result: { ok: false, reason: 'not_connected' } },
  { reason: 'session_rejected', result: { ok: false, reason: 'session_rejected' } },
  { reason: 'unavailable', result: { ok: false, reason: 'unavailable' } },
  { reason: 'too_long', result: { ok: false, reason: 'too_long' } },
  { reason: 'thread_unreadable', result: { ok: false, reason: 'thread_unreadable' } },
];

for (const { reason, result } of READER_FAILURES)
  test(`backoff: an answer of ${reason} keeps the map and the cursor and reports its class`, async (t) => {
    const { f, key } = await baselinedLink(t, { intervalSeconds: 30 });
    post(f, key, OTHER, 10); // a wake is waiting, so any state change would show
    const mapBefore = f.mapText();
    f.fakeReader.failNext(result);
    f.clock.advance(TICK_GAP_MS);
    await assert.doesNotReject(f.tick());
    assert.equal(f.mapText(), mapBefore);
    assert.equal(f.entry(key).lastNotifiedTs, BASELINE_TS);
    assert.equal(f.totalLines(), 0);
    const status = f.linkStatus(key);
    assert.equal(status.lastStatus, reason);
    assert.equal(status.lastCheckedAt, new Date(START_MS + TICK_GAP_MS).toISOString());
  });

test('backoff: a reader that throws never escapes the tick and keeps the map and the cursor', async (t) => {
  const { f, key } = await baselinedLink(t, { intervalSeconds: 30 });
  post(f, key, OTHER, 10);
  const mapBefore = f.mapText();
  f.fakeReader.script(() => {
    throw new Error('synthetic reader failure');
  });
  f.clock.advance(TICK_GAP_MS);
  await assert.doesNotReject(f.tick());
  assert.equal(f.mapText(), mapBefore);
  assert.equal(f.entry(key).lastNotifiedTs, BASELINE_TS);
  assert.equal(f.totalLines(), 0);
});

for (const form of ['a failed answer', 'a thrown error'])
  test(`backoff: the timer survives ${form} over several periods with one timer pending`, async (t) => {
    const f = await watchFixture(t);
    await f.watch({ sessionIds: [SESSION_A], messages: [{ user: OTHER, ts: BASELINE_TS }] });
    listSessions(f, [SESSION_A]);
    f.fakeReader.script(() => {
      if (form === 'a thrown error') throw new Error('synthetic reader failure');
      return { ok: false, reason: 'unavailable' };
    });
    await f.watcher.start();
    await f.timers.advance(5 * TICK_GAP_MS);
    assert.ok(f.fakeReader.calls.length >= 1, 'the timer fired at least one tick');
    assert.deepEqual(f.timers.escapes, []);
    assert.equal(f.timers.pending(), 1);
  });

test('backoff: a rate limit of 120 seconds blocks every read until 120 seconds have passed', async (t) => {
  const { f } = await baselinedLink(t, { intervalSeconds: 30 });
  f.fakeReader.failNext({ ok: false, reason: 'rate_limited', retryAfterSeconds: 120 });
  f.clock.advance(10_000);
  await f.tick();
  const readsAfterAnswer = f.fakeReader.calls.length;

  f.clock.advance(119_000);
  await f.tick();
  assert.equal(f.fakeReader.calls.length, readsAfterAnswer, 'no read 119 seconds after the answer');

  f.clock.advance(1_000);
  await f.tick();
  assert.equal(f.fakeReader.calls.length, readsAfterAnswer + 1, 'a read at exactly 120 seconds');
});

test('backoff: consecutive failures wait 60, 120, 240, 480 seconds and then stay at 900', async (t) => {
  const { f } = await baselinedLink(t, { intervalSeconds: 30 });
  f.fakeReader.script(() => ({ ok: false, reason: 'unavailable' }));
  f.clock.advance(10_000);
  await f.tick();
  for (const waitSeconds of [60, 120, 240, 480, 900, 900]) {
    const reads = f.fakeReader.calls.length;
    f.clock.advance((waitSeconds - 1) * 1_000);
    await f.tick();
    assert.equal(f.fakeReader.calls.length, reads, `no read one second before ${waitSeconds}`);
    f.clock.advance(1_000);
    await f.tick();
    assert.equal(f.fakeReader.calls.length, reads + 1, `a read at exactly ${waitSeconds}`);
  }
});

test('backoff: a successful read resets the wait to 60 seconds for the next failure', async (t) => {
  const { f, key } = await baselinedLink(t, { intervalSeconds: 30 });
  let failing = true;
  f.fakeReader.script(() => (failing ? { ok: false, reason: 'unavailable' } : undefined));
  f.clock.advance(10_000);
  await f.tick();
  for (const waitSeconds of [60, 120, 240]) {
    f.clock.advance(waitSeconds * 1_000);
    await f.tick();
  }
  failing = false;
  f.clock.advance(480_000);
  await f.tick();
  assert.equal(f.linkStatus(key).lastStatus, 'ok');

  failing = true;
  f.clock.advance(TICK_GAP_MS);
  await f.tick();
  const reads = f.fakeReader.calls.length;
  f.clock.advance(59_000);
  await f.tick();
  assert.equal(f.fakeReader.calls.length, reads, 'no read 59 seconds after the new failure');
  f.clock.advance(1_000);
  await f.tick();
  assert.equal(f.fakeReader.calls.length, reads + 1, 'the wait was reset to 60 seconds');
});

for (const reason of ['thread_unreadable', 'too_long'])
  test(`backoff: with six links and the first answering ${reason}, links 2 to 6 are read on every one of eight ticks`, async (t) => {
    const f = await watchFixture(t);
    const sessionIds = Array.from({ length: 6 }, (_, index) => sessionUuid(index));
    const keys = await watchLinks(f, 6, (index) => sessionIds[index]);
    listSessions(f, sessionIds);
    const readSeconds = new Map();
    const unchanged = {
      ok: true,
      me: ME,
      last: { user: OTHER, ts: BASELINE_TS },
      asOf: BASELINE_TS,
    };
    // The healthy links answer after the failing one, as a slow Slack would.
    f.fakeReader.script(async ({ threadTs }) => {
      readSeconds.set(threadTs, [
        ...(readSeconds.get(threadTs) ?? []),
        (f.clock.now() - START_MS) / 1000,
      ]);
      if (threadTs === threadTsFor(0)) return { ok: false, reason };
      await flush(2);
      return unchanged;
    });

    for (let tick = 0; tick < 8; tick++) {
      await f.tick();
      f.clock.advance(TICK_GAP_MS);
    }

    const everyTick = [0, 180, 360, 540, 720, 900, 1080, 1260];
    for (const index of [1, 2, 3, 4, 5])
      assert.deepEqual(
        readSeconds.get(threadTsFor(index)),
        everyTick,
        `reads of link ${index + 1}`,
      );
    assert.deepEqual(
      readSeconds.get(threadTsFor(0)),
      [0, 180, 360, 720, 1260],
      'the failing link is read only at its own 60, 120, 240 and 480 second steps',
    );
    assert.equal(f.linkStatus(keys[0]).lastStatus, reason);
    for (const key of keys.slice(1)) assert.equal(f.linkStatus(key).lastStatus, 'ok');
  });

// ---------------------------------------------------------------------------------------------
// Schedule: seconds, live reschedule, single flight, bounded concurrency

test('schedule: start arms one timer at the interval and every firing reads each due link', async (t) => {
  const f = await watchFixture(t);
  await watchLinks(f, 2, () => SESSION_A);
  listSessions(f, [SESSION_A]);
  await f.watcher.start();
  assert.equal(f.timers.pending(), 1);
  assert.deepEqual(f.timers.delays(), [180_000]);

  const before = f.fakeReader.calls.length;
  await f.timers.advance(180_000);
  assert.equal(f.fakeReader.calls.length - before, 2, 'one read per due link');
  assert.equal(f.timers.pending(), 1);
  assert.deepEqual(f.timers.delays(), [180_000]);

  await f.timers.advance(180_000);
  assert.equal(f.fakeReader.calls.length - before, 4);
  assert.equal(f.timers.pending(), 1);
  assert.deepEqual(f.timers.escapes, []);
});

test('schedule: a saved interval of 60 re-arms the single timer at once without an extra tick', async (t) => {
  const f = await watchFixture(t);
  await watchLinks(f, 1, () => SESSION_A);
  listSessions(f, [SESSION_A]);
  await f.watcher.start();
  await f.timers.advance(180_000);
  const reads = f.fakeReader.calls.length;

  f.settings.slackWatch.intervalSeconds = 60;
  await f.watcher.refreshSchedule();
  assert.equal(f.timers.pending(), 1);
  assert.deepEqual(f.timers.delays(), [60_000]);
  assert.equal(f.fakeReader.calls.length, reads, 'refreshing the schedule is not a tick');

  await f.timers.advance(60_000);
  assert.equal(f.fakeReader.calls.length, reads + 1, 'the next tick comes 60 seconds later');
  assert.equal(f.timers.pending(), 1);
});

test('schedule: without a refresh the next tick picks up a changed interval', async (t) => {
  const f = await watchFixture(t);
  await watchLinks(f, 1, () => SESSION_A);
  listSessions(f, [SESSION_A]);
  await f.watcher.start();
  f.settings.slackWatch.intervalSeconds = 60;

  await f.timers.advance(180_000);
  assert.equal(f.timers.pending(), 1);
  assert.deepEqual(f.timers.delays(), [60_000]);

  const reads = f.fakeReader.calls.length;
  await f.timers.advance(60_000);
  assert.equal(f.fakeReader.calls.length, reads + 1);
});

test('schedule: a tick still running makes a second tick and a due timer do nothing', async (t) => {
  const f = await watchFixture(t);
  await watchLinks(f, 1, () => SESSION_A);
  listSessions(f, [SESSION_A]);
  await f.watcher.start();
  const gate = f.fakeReader.hold();
  const running = f.tick();
  await flush();
  assert.equal(f.fakeReader.calls.length, 1);

  assert.ok(await settlesWithoutRelease(f.tick()), 'a second tick returns at once');
  assert.ok(await settlesWithoutRelease(f.timers.advance(TICK_GAP_MS)), 'a due timer returns');
  assert.equal(f.fakeReader.calls.length, 1, 'the reader is called once only');

  gate.release();
  await running;
  assert.equal(f.fakeReader.calls.length, 1);
  assert.deepEqual(f.timers.escapes, []);
  assert.equal(f.timers.pending(), 1);

  await f.tick();
  assert.equal(f.fakeReader.calls.length, 2, 'the finished tick no longer blocks the next');
});

test('schedule: twelve due links are read at most three at a time', async (t) => {
  const f = await watchFixture(t);
  await watchLinks(f, 12, () => SESSION_A);
  listSessions(f, [SESSION_A]);
  const gate = f.fakeReader.hold();
  const running = f.tick();
  await flush();
  assert.equal(f.fakeReader.maxInFlight, CONCURRENT_READS);
  assert.equal(f.fakeReader.calls.length, CONCURRENT_READS);

  gate.release();
  await running;
  assert.equal(f.fakeReader.calls.length, 12, 'every link is read once released');
  assert.equal(f.fakeReader.maxInFlight, CONCURRENT_READS);
});

// ---------------------------------------------------------------------------------------------
// Paused: silent, state kept, map editable

test('paused: a tick makes no read and no write and keeps every cursor', async (t) => {
  const { f, key } = await baselinedLink(t, { sessionIds: [SESSION_A, SESSION_B] });
  post(f, key, OTHER, 10); // a wake is waiting
  f.settings.slackWatch.paused = true;
  await f.watcher.start();
  const snapshotBefore = structuredClone(f.store.snapshot());
  const readsBefore = f.fakeReader.calls.length;
  f.recorder.clearCalls();

  for (let tick = 0; tick < 3; tick++) await tickAfterGap(f);
  assert.equal(f.fakeReader.calls.length, readsBefore);
  assert.equal(f.totalLines(), 0);
  assert.deepEqual(writeCalls(f), []);
  assert.deepEqual(f.store.snapshot(), snapshotBefore);
  assert.equal(f.watcher.list().state, 'paused');
});

test('paused: add, attach and detach still succeed and make no read', async (t) => {
  const { f, key } = await baselinedLink(t);
  f.settings.slackWatch.paused = true;
  await f.watcher.start();
  const readsBefore = f.fakeReader.calls.length;

  const secondKey = await f.watch({
    threadTs: OTHER_THREAD_TS,
    sessionIds: [SESSION_B],
    messages: [{ user: OTHER, ts: tsAt(-100) }],
  });
  await f.store.attach(key, SESSION_C);
  await f.store.detach(key, SESSION_A);
  assert.deepEqual(f.entry(key).sessionIds, [SESSION_C]);
  assert.deepEqual(f.entry(secondKey).sessionIds, [SESSION_B]);

  await tickAfterGap(f);
  assert.equal(f.fakeReader.calls.length, readsBefore);
  const added = f.watcher.list().links.find((link) => link.key === secondKey);
  assert.equal(added.lastStatus, null);
  assert.equal(f.watcher.list().state, 'paused');
});

// ---------------------------------------------------------------------------------------------
// Resume: a pause survives a restart, and resuming catches up once

test('resume: a pause set before a restart is still in force afterwards', async (t) => {
  const { f, key } = await baselinedLink(t, { settings: 'real' });
  await f.watcher.start();
  await f.watcher.pause();
  post(f, key, OTHER, 10);
  const readsBefore = f.fakeReader.calls.length;

  await f.restart();
  await f.watcher.start();
  assert.equal(f.watcher.list().state, 'paused');
  assert.equal(f.settings.getPublicSettings().slackWatch.paused, true);
  await f.timers.advance(TICK_GAP_MS);
  assert.equal(f.fakeReader.calls.length, readsBefore, 'no read after the restart');
  assert.equal(f.totalLines(), 0);
});

test('resume: activity during the pause wakes once at the immediate tick and the flag clears', async (t) => {
  const { f, key } = await baselinedLink(t, { settings: 'real' });
  await f.watcher.start();
  post(f, key, OTHER, 10);
  await tickAfterGap(f);
  assert.equal(f.inboxLines(SESSION_A).length, 1);

  await f.watcher.pause();
  const duringPauseTs = post(f, key, OTHER, 70);
  const readsBefore = f.fakeReader.calls.length;
  await tickAfterGap(f);
  await tickAfterGap(f);
  assert.equal(f.fakeReader.calls.length, readsBefore, 'ticks make no call while on pause');
  assert.equal(f.inboxLines(SESSION_A).length, 1);

  await f.watcher.resume();
  assert.equal(f.inboxLines(SESSION_A).length, 2, 'exactly one catch-up line, written by return');
  assert.equal(f.entry(key).lastNotifiedTs, duringPauseTs);
  assert.equal(f.watcher.list().state, 'running');
  const persisted = JSON.parse(fs.readFileSync(f.paths.settings, 'utf8'));
  assert.equal(persisted.slackWatch.paused, false);
});

test('resume: a thread whose newest message is the users own does not wake', async (t) => {
  const { f, key } = await baselinedLink(t, { settings: 'real' });
  await f.watcher.start();
  post(f, key, OTHER, 10);
  await tickAfterGap(f);
  await f.watcher.pause();
  post(f, key, OTHER, 60);
  post(f, key, ME, 70);

  await f.watcher.resume();
  assert.equal(f.inboxLines(SESSION_A).length, 1, 'no new line after the resume');
  assert.equal(f.watcher.list().state, 'running');
});

test('resume: a second resume is idempotent and arms no second timer', async (t) => {
  const { f, key } = await baselinedLink(t, { settings: 'real' });
  await f.watcher.start();
  await f.watcher.pause();
  post(f, key, OTHER, 10);

  await f.watcher.resume();
  assert.equal(f.totalLines(), 1);
  assert.equal(f.timers.pending(), 1);

  await f.watcher.resume();
  assert.equal(f.totalLines(), 1, 'the repeat writes nothing more');
  assert.equal(f.watcher.list().state, 'running');
  assert.equal(f.timers.pending(), 1);
  assert.deepEqual(f.timers.escapes, []);
});

// ---------------------------------------------------------------------------------------------
// States: running, paused, disabled

test('states: without a readable Claude home the watcher is disabled with a reason and no timer', async (t) => {
  const f = await watchFixture(t, { claudeHome: false });
  await f.watch({ sessionIds: [SESSION_A], messages: [{ user: OTHER, ts: tsAt(-100) }] });
  await assert.doesNotReject(async () => f.watcher.start());
  assert.equal(f.timers.pending(), 0);
  const listing = f.watcher.list();
  assert.equal(listing.state, 'disabled');
  assert.match(listing.reason, SNAKE_CASE);
});

test('states: with a readable Claude home and no pause flag the watcher is running with one timer', async (t) => {
  const f = await watchFixture(t, { claudeHome: true });
  await f.watcher.start();
  assert.equal(f.watcher.list().state, 'running');
  assert.equal(f.timers.pending(), 1);
});

test('states: a pause flag with a readable Claude home reports the pause state', async (t) => {
  const f = await watchFixture(t, { claudeHome: true, paused: true });
  await f.watcher.start();
  assert.equal(f.watcher.list().state, 'paused');
});

test('states: a disabled watcher wins over the pause flag and the flag is kept', async (t) => {
  const f = await watchFixture(t, { claudeHome: false, paused: true });
  await f.watcher.start();
  const listing = f.watcher.list();
  assert.equal(listing.state, 'disabled');
  assert.match(listing.reason, SNAKE_CASE);
  assert.equal(f.settings.slackWatch.paused, true);
  assert.equal(f.timers.pending(), 0);
});

for (const { label, options, state } of [
  { label: 'running', options: { http: true }, state: 'running' },
  { label: 'the pause state', options: { http: true, paused: true }, state: 'paused' },
  { label: 'disabled', options: { http: true, claudeHome: false }, state: 'disabled' },
])
  test(`states: GET /api/slack/watch reports ${label}`, async (t) => {
    const f = await watchFixture(t, options);
    await f.watcher.start();
    const response = await f.http.raw('GET', '/api/slack/watch');
    assert.equal(response.status, 200);
    const body = response.json();
    assert.equal(body.state, state);
    if (state === 'disabled') assert.match(body.reason, SNAKE_CASE);
  });

test('states: a disabled watcher refuses add, attach and remove with 409 and still detaches', async (t) => {
  const f = await watchFixture(t, { http: true, claudeHome: false });
  const key = await f.watch({
    sessionIds: [SESSION_A],
    messages: [{ user: OTHER, ts: tsAt(-100) }],
  });
  await f.watcher.start();

  const add = await f.http.json('POST', '/api/slack/watch/links', {
    links: [permalinkFor(undefined, OTHER_THREAD_TS)],
  });
  assert.equal(add.status, 409);
  assert.equal(add.json().code, 'WATCH_DISABLED');

  const attach = await f.http.json('POST', '/api/slack/watch/attach', {
    link: permalinkFor(),
    sessionId: SESSION_B,
  });
  assert.equal(attach.status, 409);
  assert.equal(attach.json().code, 'WATCH_DISABLED');

  const remove = await f.http.json('POST', '/api/slack/watch/remove', { link: permalinkFor() });
  assert.equal(remove.status, 409);
  assert.equal(remove.json().code, 'WATCH_DISABLED');

  assert.deepEqual(Object.keys(f.store.snapshot().links), [key], 'nothing was added or removed');
  assert.deepEqual(f.entry(key).sessionIds, [SESSION_A], 'nothing was attached');

  const detach = await f.http.json('POST', '/api/slack/watch/detach', {
    link: permalinkFor(),
    sessionId: SESSION_A,
  });
  assert.equal(detach.status, 200);
  assert.deepEqual(f.entry(key).sessionIds, []);
  assert.equal(fs.existsSync(f.inboxFile(SESSION_A)), false, 'the inbox is cleaned up');
});

// ---------------------------------------------------------------------------------------------
// Prune: stopped sessions leave the map

async function pruneSetup(t, listed) {
  const f = await watchFixture(t);
  const silent = [{ user: ME, ts: tsAt(-100) }];
  const keyOne = await f.watch({ sessionIds: [SESSION_A, SESSION_B], messages: silent });
  const keyTwo = await f.watch({
    threadTs: OTHER_THREAD_TS,
    sessionIds: [SESSION_B],
    messages: silent,
  });
  f.fakeSessions.setSessions(listed);
  return { f, keyOne, keyTwo };
}

test('prune: a session seen listed and then absent on two passes ten minutes apart is removed everywhere', async (t) => {
  const finished = { sessionId: SESSION_A, state: 'finished' };
  const { f, keyOne, keyTwo } = await pruneSetup(t, [
    finished,
    { sessionId: SESSION_B, state: 'live' },
  ]);

  await f.tick();
  assert.deepEqual(f.entry(keyOne).sessionIds.toSorted(), [SESSION_A, SESSION_B]);
  f.fakeSessions.setSessions([finished]);

  await tickAfterGap(f, PRUNE_INTERVAL_MS);
  assert.ok(f.entry(keyOne).sessionIds.includes(SESSION_B), 'absent from one pass is not enough');

  await tickAfterGap(f, PRUNE_INTERVAL_MS / 2);
  assert.ok(f.entry(keyOne).sessionIds.includes(SESSION_B), 'no pass runs five minutes later');
  assert.deepEqual(f.entry(keyTwo).sessionIds, [SESSION_B]);

  await tickAfterGap(f, PRUNE_INTERVAL_MS / 2);
  assert.deepEqual(f.entry(keyOne).sessionIds, [SESSION_A]);
  assert.deepEqual(f.entry(keyTwo).sessionIds, []);
  assert.equal(fs.existsSync(f.inboxFile(SESSION_B)), false, 'its inbox is removed');
  assert.equal(fs.existsSync(f.inboxFile(SESSION_A)), true, 'a listed session keeps its inbox');
});

test('prune: a session attached by manual id and never seen listed is kept with its inbox and delivery status', async (t) => {
  const { f, keyOne, keyTwo } = await pruneSetup(t, [{ sessionId: SESSION_A, state: 'finished' }]);
  await f.tick();
  post(f, keyOne, OTHER, 10);
  await tickAfterGap(f);
  assertDelivery(f, keyOne, SESSION_B, { status: 'delivered', reason: 'not_listed' });

  for (let pass = 0; pass < 6; pass++) await tickAfterGap(f, PRUNE_INTERVAL_MS);

  assert.deepEqual(f.entry(keyOne).sessionIds.toSorted(), [SESSION_A, SESSION_B]);
  assert.deepEqual(f.entry(keyTwo).sessionIds, [SESSION_B]);
  assert.deepEqual(f.inboxLines(SESSION_B), [NOTICE], 'its inbox and its line stay');
  assertDelivery(f, keyOne, SESSION_B, { status: 'delivered', reason: 'not_listed' });
});

test('prune: a session seen listed before a restart is not pruned until it is seen listed again', async (t) => {
  const finished = { sessionId: SESSION_A, state: 'finished' };
  const { f, keyOne } = await pruneSetup(t, [finished, { sessionId: SESSION_B, state: 'live' }]);
  await f.tick();
  f.fakeSessions.setSessions([finished]);
  await f.restart();

  for (let pass = 0; pass < 4; pass++) await tickAfterGap(f, PRUNE_INTERVAL_MS);

  assert.deepEqual(f.entry(keyOne).sessionIds.toSorted(), [SESSION_A, SESSION_B]);
  assert.equal(fs.existsSync(f.inboxFile(SESSION_B)), true);
});

test('prune: a session that reappears between passes starts the count again', async (t) => {
  const finished = { sessionId: SESSION_A, state: 'finished' };
  const { f, keyOne } = await pruneSetup(t, [finished]);

  await f.tick();
  f.fakeSessions.setSessions([finished, { sessionId: SESSION_B, state: 'live' }]);
  await tickAfterGap(f, PRUNE_INTERVAL_MS);
  f.fakeSessions.setSessions([finished]);
  await tickAfterGap(f, PRUNE_INTERVAL_MS);
  assert.ok(f.entry(keyOne).sessionIds.includes(SESSION_B), 'absent once since it reappeared');

  await tickAfterGap(f, PRUNE_INTERVAL_MS);
  assert.deepEqual(f.entry(keyOne).sessionIds, [SESSION_A]);
});

test('prune: a failed listing never prunes however many passes run', async (t) => {
  const { f, keyOne } = await pruneSetup(t, [{ sessionId: SESSION_A, state: 'finished' }]);
  f.fakeSessions.failListing();

  await f.tick();
  for (let pass = 0; pass < 4; pass++) await tickAfterGap(f, PRUNE_INTERVAL_MS);
  assert.deepEqual(f.entry(keyOne).sessionIds.toSorted(), [SESSION_A, SESSION_B]);
  assert.equal(fs.existsSync(f.inboxFile(SESSION_B)), true);
  assert.equal(fs.existsSync(f.inboxFile(SESSION_A)), true);
});

test('prune: a session listed as finished is kept over many passes', async (t) => {
  const f = await watchFixture(t);
  const key = await f.watch({
    sessionIds: [SESSION_A],
    messages: [{ user: ME, ts: tsAt(-100) }],
  });
  f.fakeSessions.setSessions([{ sessionId: SESSION_A, state: 'finished' }]);

  await f.tick();
  for (let pass = 0; pass < 6; pass++) await tickAfterGap(f, PRUNE_INTERVAL_MS);
  assert.deepEqual(f.entry(key).sessionIds, [SESSION_A]);
  assert.equal(fs.existsSync(f.inboxFile(SESSION_A)), true);
});

// ---------------------------------------------------------------------------------------------
// Wake cap: at most twenty lines per tick

test('wake cap: forty due links write twenty lines a tick, none dropped, none repeated', async (t) => {
  const f = await watchFixture(t);
  const sessionIds = Array.from({ length: 40 }, (_, index) => sessionUuid(index));
  const keys = await watchLinks(f, 40, (index) => sessionIds[index]);
  listSessions(f, sessionIds);
  await f.tick();
  assert.equal(f.totalLines(), 0, 'attaching under an existing message must not wake');

  keys.forEach((key, index) => post(f, key, OTHER, 10 + index));
  const linesOf = (index) => f.inboxLines(sessionIds[index]).length;

  await tickAfterGap(f);
  assert.equal(f.totalLines(), LINES_PER_TICK);
  assert.equal(sessionIds.filter((_, index) => linesOf(index) === 1).length, LINES_PER_TICK);
  keys.forEach((key, index) => {
    const expected = linesOf(index) === 1 ? tsAt(10 + index) : BASELINE_TS;
    assert.equal(f.entry(key).lastNotifiedTs, expected, `cursor of link ${index}`);
  });

  await tickAfterGap(f);
  assert.equal(f.totalLines(), 2 * LINES_PER_TICK, 'the remaining links are served next tick');

  await tickAfterGap(f);
  assert.equal(f.totalLines(), 2 * LINES_PER_TICK, 'a third tick writes none');
  sessionIds.forEach((_, index) => assert.equal(linesOf(index), 1, `lines of session ${index}`));
});
