// slack-watch-delivery-property.test.mjs — at-least-once delivery under seeded faults. An oracle
// kept here, never derived from the watcher, tracks which session still owes a line for a thread
// and counts a missed wake for every one still owed after the faults stop and the watcher drains.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANNEL,
  ME,
  OTHER,
  SESSION_A,
  SESSION_B,
  SESSION_C,
  SESSION_D,
  mulberry32,
  permalinkFor,
  threadKey,
  tsAt,
  watchFixture,
} from './slack-watch-fixture.mjs';

const SEED = 20261031;
const TICKS = 500;
const DRAIN_EVERY_TICKS = 50;
const DRAIN_TICKS = 5;
const MIN_GAP_SECONDS = 20;
const MAX_GAP_SECONDS = 400;
const BACKOFF_CEILING_SECONDS = 900;
const DRAIN_GAP_SECONDS = BACKOFF_CEILING_SECONDS + 100;
const NOT_MINE_ARRIVAL_ODDS = 0.45;
const OWN_POST_ODDS = 0.15;
const READER_FAULT_ODDS = 0.15;
const APPEND_FAULT_ODDS = 0.15;
const RESTART_ODDS = 0.02;
const TRANSIENT_RESUME_FAILURE_ODDS = 0.4;
const MIN_LINES_OVERALL = 20;
const READER_FAULTS = ['rate_limited', 'unavailable', 'throws'];
const SESSIONS = [SESSION_A, SESSION_B, SESSION_C, SESSION_D];
const LINKS = [
  { threadTs: '1793192214.548389', sessionIds: [SESSION_A, SESSION_B, SESSION_C] },
  { threadTs: '1793192215.000123', sessionIds: [SESSION_A, SESSION_D] },
  { threadTs: '1793192216.000456', sessionIds: [SESSION_B, SESSION_C] },
];

test(
  'delivery property: no missed wake over 500 seeded ticks with read, 429, append and restart faults',
  { timeout: 300_000 },
  async (t) => {
    const random = mulberry32(SEED);
    // A second stream for the resume outcomes: how often the watcher resumes a session depends on
    // the implementation, and that must not shift the draws that script the scenario.
    const resumeRandom = mulberry32(SEED ^ 0x9e3779b9);
    const faults = { reader: null, appendSessionId: null };
    const injected = { rate_limited: 0, unavailable: 0, throws: 0, append: 0, restart: 0 };

    const f = await watchFixture(t, {
      settings: 'fake',
      sessions: 'fake',
      wrapStore: (store) => ({
        ...store,
        append: async (...args) => {
          if (faults.appendSessionId === args[0]) {
            injected.append += 1;
            throw new Error('synthetic append failure');
          }
          return store.append(...args);
        },
      }),
    });
    f.fakeReader.script(() => {
      if (faults.reader === 'rate_limited') {
        injected.rate_limited += 1;
        return { ok: false, reason: 'rate_limited', retryAfterSeconds: 30 };
      }
      if (faults.reader === 'unavailable') {
        injected.unavailable += 1;
        return { ok: false, reason: 'unavailable' };
      }
      if (faults.reader === 'throws') {
        injected.throws += 1;
        throw new Error('synthetic reader failure');
      }
      return undefined;
    });
    f.fakeSessions.setSessions([
      { sessionId: SESSION_A, state: 'live' },
      { sessionId: SESSION_B, state: 'finished' },
      { sessionId: SESSION_C, state: 'finished' },
      { sessionId: SESSION_D, state: 'finished' },
    ]);
    f.fakeSessions.onResume(SESSION_C, () =>
      resumeRandom() < TRANSIENT_RESUME_FAILURE_ODDS
        ? { status: 'failed-transient', reason: 'spawn_failed' }
        : { status: 'delivered' },
    );
    f.fakeSessions.onResume(SESSION_D, {
      status: 'failed-permanent',
      reason: 'untrusted_workspace',
    });

    const keys = [];
    for (const { threadTs, sessionIds } of LINKS)
      keys.push(
        await f.watch({
          threadTs,
          sessionIds,
          messages: [{ ts: threadTs, user: OTHER }],
        }),
      );
    assert.deepEqual(
      keys,
      LINKS.map(({ threadTs }) => threadKey(CHANNEL, threadTs)),
    );

    // Oracle: owed[link:session] is true while a not-mine message is the newest on the thread and
    // no line naming that thread has reached the session since it arrived.
    const owed = new Map();
    const seenLines = new Map();
    const slot = (linkIndex, sessionId) => `${linkIndex}:${sessionId}`;
    const sessionsOf = (linkIndex) => LINKS[linkIndex].sessionIds;
    const linesNaming = (linkIndex, sessionId) => {
      const link = permalinkFor(CHANNEL, LINKS[linkIndex].threadTs);
      return f.inboxLines(sessionId).filter((line) => line.includes(link)).length;
    };
    const setOwed = (linkIndex, value) =>
      sessionsOf(linkIndex).forEach((sessionId) => owed.set(slot(linkIndex, sessionId), value));
    LINKS.forEach((_, linkIndex) =>
      sessionsOf(linkIndex).forEach((sessionId) => {
        owed.set(slot(linkIndex, sessionId), false);
        seenLines.set(slot(linkIndex, sessionId), 0);
      }),
    );

    const failedPermanent = new Set();
    const tickRejections = [];
    const missedWakes = [];
    let elapsedSeconds = 0;
    const advanceSeconds = (seconds) => {
      elapsedSeconds += seconds;
      f.clock.advance(seconds * 1000);
    };
    const between = (low, high) => low + Math.floor(random() * (high - low + 1));

    async function tickAndObserve() {
      try {
        await f.tick();
      } catch (error) {
        tickRejections.push(error);
      }
      LINKS.forEach((_, linkIndex) =>
        sessionsOf(linkIndex).forEach((sessionId) => {
          const lines = linesNaming(linkIndex, sessionId);
          if (lines > seenLines.get(slot(linkIndex, sessionId)))
            owed.set(slot(linkIndex, sessionId), false);
          seenLines.set(slot(linkIndex, sessionId), lines);
          if (f.delivery(keys[linkIndex], sessionId)?.status === 'failed-permanent')
            failedPermanent.add(slot(linkIndex, sessionId));
        }),
      );
    }

    async function drain(afterTick) {
      faults.reader = null;
      faults.appendSessionId = null;
      for (let step = 0; step < DRAIN_TICKS; step++) {
        advanceSeconds(DRAIN_GAP_SECONDS);
        await tickAndObserve();
      }
      LINKS.forEach((_, linkIndex) =>
        sessionsOf(linkIndex).forEach((sessionId) => {
          const stillOwed = owed.get(slot(linkIndex, sessionId));
          const status = f.delivery(keys[linkIndex], sessionId)?.status;
          if (stillOwed && status !== 'failed-permanent')
            missedWakes.push({ afterTick, link: linkIndex, sessionId, status: status ?? null });
          owed.set(slot(linkIndex, sessionId), false);
        }),
      );
    }

    for (let tick = 0; tick < TICKS; tick++) {
      // Every random value is drawn on every tick, whatever the tick does with it.
      const gap = between(MIN_GAP_SECONDS, MAX_GAP_SECONDS);
      const eventRoll = random();
      const eventLink = Math.floor(random() * LINKS.length);
      const readerRoll = random();
      const readerKind = Math.floor(random() * READER_FAULTS.length);
      const appendRoll = random();
      const appendTarget = Math.floor(random() * SESSIONS.length);
      const restartRoll = random();

      advanceSeconds(gap);
      const ts = tsAt(elapsedSeconds, tick + 1);
      if (eventRoll < NOT_MINE_ARRIVAL_ODDS) {
        f.threads.post(keys[eventLink], { ts, user: OTHER });
        setOwed(eventLink, true);
      } else if (eventRoll < NOT_MINE_ARRIVAL_ODDS + OWN_POST_ODDS) {
        f.threads.post(keys[eventLink], { ts, user: ME });
        setOwed(eventLink, false);
      }
      faults.reader = readerRoll < READER_FAULT_ODDS ? READER_FAULTS[readerKind] : null;
      faults.appendSessionId = appendRoll < APPEND_FAULT_ODDS ? SESSIONS[appendTarget] : null;
      if (restartRoll < RESTART_ODDS) {
        await f.restart();
        injected.restart += 1;
      }

      await tickAndObserve();
      if ((tick + 1) % DRAIN_EVERY_TICKS === 0) await drain(tick + 1);
    }

    assert.deepEqual(missedWakes, [], 'a session still owed a line after the drain');
    assert.ok(f.totalLines() >= MIN_LINES_OVERALL, `${f.totalLines()} inbox lines were written`);
    for (const [kind, count] of Object.entries(injected))
      assert.ok(count >= 1, `the ${kind} fault was injected at least once`);
    assert.ok(failedPermanent.size >= 1, 'at least one session reached failed-permanent');
  },
);
