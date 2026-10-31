// slack-watch-ratelimit.test.mjs — a rate-limited Slack is never asked again before its Retry-After
// has passed, and a continuous rate-limit stream stays under 20 calls in a simulated hour.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OTHER,
  SESSION_A,
  rateLimitedResponse,
  tsAt,
  watchFixture,
} from './slack-watch-fixture.mjs';

const SECOND = 1000;
const FLOOR_INTERVAL_SECONDS = 30;
const MAX_CALLS_PER_HOUR = 20;
const MINUTES_PER_HOUR = 60;
const MARGIN_AFTER_RETRY_SECONDS = 120;
const LINKS_IN_ONE_TICK = 3;
const BLOCK_SECONDS = 120;

// Records the simulated time and method of every Slack fetch, then answers with `respond`.
function recordCalls(f, respond) {
  const calls = [];
  f.slackFetch.script(({ method, index }) => {
    calls.push({ at: f.clock.now(), method });
    return respond({ method, index });
  });
  return calls;
}

async function watchedThread(t, options) {
  const f = await watchFixture(t, { reader: 'real', sessions: 'fake', ...options });
  await f.watch({ sessionIds: [SESSION_A], messages: [{ ts: tsAt(-600), user: OTHER }] });
  return f;
}

async function watchedThreads(t, count, options) {
  const f = await watchFixture(t, { reader: 'real', sessions: 'fake', ...options });
  for (let index = 0; index < count; index++)
    await f.watch({
      threadTs: `${1_793_192_214 + index}.000100`,
      sessionIds: [SESSION_A],
      messages: [{ ts: tsAt(-600, index + 1), user: OTHER }],
    });
  return f;
}

// Answers the thread reads of one tick in order: the first with a 429 for BLOCK_SECONDS, the others
// as `laterAnswers` says (a null entry means Slack answers normally).
function answerRepliesInOrder(f, laterAnswers) {
  let repliesSeen = 0;
  return recordCalls(f, ({ method }) => {
    if (method !== 'conversations.replies') return null;
    const position = repliesSeen++;
    return position === 0
      ? rateLimitedResponse(BLOCK_SECONDS)
      : (laterAnswers[position - 1]?.() ?? null);
  });
}

async function runPastTheBlock(f, calls) {
  f.watcher.start();
  await f.timers.advance(FLOOR_INTERVAL_SECONDS * SECOND);
  const limitedAt = calls.find(({ method }) => method === 'conversations.replies').at;
  const callsInFirstTick = calls.length;
  await f.timers.advance((BLOCK_SECONDS + MARGIN_AFTER_RETRY_SECONDS) * SECOND);
  return { limitedAt, laterCalls: calls.slice(callsInFirstTick) };
}

async function runForOneHour(f) {
  f.watcher.start();
  for (let minute = 0; minute < MINUTES_PER_HOUR; minute++) await f.timers.advance(60 * SECOND);
}

for (const retryAfter of [30, 120, 600]) {
  test(`rate limit: no Slack call before Retry-After of ${retryAfter} s has passed, one after`, async (t) => {
    const f = await watchedThread(t, { intervalSeconds: FLOOR_INTERVAL_SECONDS });
    const calls = recordCalls(f, ({ index }) =>
      index === 0 ? rateLimitedResponse(retryAfter) : null,
    );

    f.watcher.start();
    await f.timers.advance(
      (FLOOR_INTERVAL_SECONDS + retryAfter + MARGIN_AFTER_RETRY_SECONDS) * SECOND,
    );

    assert.ok(calls.length >= 2, 'the rate-limited call and a later call were both made');
    const limitedAt = calls[0].at;
    const reopensAt = limitedAt + retryAfter * SECOND;
    const early = calls.slice(1).filter((call) => call.at < reopensAt);
    assert.deepEqual(early, [], `no call in the ${retryAfter} s after the 429`);
    assert.ok(
      calls.slice(1).some((call) => call.at >= reopensAt),
      'a call occurs once the delay has passed',
    );
    assert.deepEqual(f.timers.escapes, [], 'nothing escapes the timer callback');
  });
}

for (const retryAfter of [30, 600]) {
  test(`rate limit: a continuous 429 stream (Retry-After ${retryAfter} s) makes at most 20 calls in an hour`, async (t) => {
    const f = await watchedThread(t);
    const calls = recordCalls(f, () => rateLimitedResponse(retryAfter));

    await runForOneHour(f);

    assert.ok(calls.length >= 1, 'the watcher did call Slack');
    assert.ok(
      calls.length <= MAX_CALLS_PER_HOUR,
      `${calls.length} Slack calls in one simulated hour`,
    );
    assert.deepEqual(f.timers.escapes, [], 'nothing escapes the timer callback');
  });
}

test('rate limit: an auth.test that answers ratelimited with HTTP 200 stays under 20 calls an hour', async (t) => {
  const f = await watchedThread(t);
  const calls = recordCalls(f, ({ method }) =>
    method === 'auth.test' ? Response.json({ ok: false, error: 'ratelimited' }) : null,
  );

  await runForOneHour(f);

  assert.ok(calls.length >= 1, 'the watcher did call Slack');
  assert.ok(
    calls.length <= MAX_CALLS_PER_HOUR,
    `${calls.length} Slack calls in one simulated hour`,
  );
  assert.deepEqual(f.timers.escapes, [], 'nothing escapes the timer callback');
});

const LATER_ANSWERS = {
  'a success': [() => null, () => null],
  'a failure of HTTP 500': [() => new Response('{}', { status: 500 }), () => null],
  'a shorter rate limit of 30 seconds': [() => rateLimitedResponse(30), () => null],
};

for (const [label, laterAnswers] of Object.entries(LATER_ANSWERS))
  test(`rate limit: one of ${LINKS_IN_ONE_TICK} links answering 429 for ${BLOCK_SECONDS} s blocks every call, though the others see ${label}`, async (t) => {
    const f = await watchedThreads(t, LINKS_IN_ONE_TICK, {
      intervalSeconds: FLOOR_INTERVAL_SECONDS,
    });
    const calls = answerRepliesInOrder(f, laterAnswers);

    const { limitedAt, laterCalls } = await runPastTheBlock(f, calls);

    const reopensAt = limitedAt + BLOCK_SECONDS * SECOND;
    assert.deepEqual(
      laterCalls.filter((call) => call.at < reopensAt),
      [],
      `no Slack call by any link in the ${BLOCK_SECONDS} s after the 429`,
    );
    assert.ok(
      laterCalls.some((call) => call.at >= reopensAt),
      'calls resume once the block has ended',
    );
    assert.deepEqual(f.timers.escapes, [], 'nothing escapes the timer callback');
  });
