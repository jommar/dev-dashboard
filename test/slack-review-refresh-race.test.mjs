import test from 'node:test';
import assert from 'node:assert/strict';
import { createSlackBoard } from '../backend/slack-board.mjs';

const NOW = Date.parse('2026-11-07T12:00:00.000Z');

function at(ms) {
  const micros = BigInt(ms) * 1000n;
  return `${micros / 1_000_000n}.${String(micros % 1_000_000n).padStart(6, '0')}`;
}

function root(ts) {
  return { ts, thread_ts: ts, user: 'U9', text: 'synthetic root', reply_count: 0 };
}

async function flush() {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
}

test('review: an old continuation cannot supersede a pending partial refresh', async () => {
  let clock = NOW;
  let refreshing = false;
  let signalStarted;
  let releaseRefresh;
  const started = new Promise((resolve) => (signalStarted = resolve));
  const held = new Promise((resolve) => (releaseRefresh = resolve));
  const confirmed = root(at(NOW - 1000));
  const omitted = root(at(NOW - 2000));
  const calls = [];
  const integration = createSlackBoard({
    now: () => clock,
    session: () => ({}),
    verify: async () => ({ connected: true, userId: 'U9', teamId: 'T1' }),
    channel: async () => ({ id: 'C1', name: 'ezat_claudio' }),
    users: async () => ({}),
    isCurrent: () => true,
    generation: () => 1,
    call: async (method, params) => {
      calls.push({ method, cursor: params.cursor, refreshing });
      if (method === 'conversations.history') {
        if (refreshing && !params.cursor) {
          signalStarted();
          await held;
          return { ok: true, messages: [confirmed], response_metadata: {} };
        }
        const page = params.cursor ? Number(params.cursor.slice(1)) : 0;
        return {
          ok: true,
          messages: page === 0 ? [confirmed, omitted] : [],
          has_more: page < 3,
          response_metadata: { next_cursor: page < 3 ? `p${page + 1}` : '' },
        };
      }
      if (method === 'search.messages') {
        if (refreshing && !params.query.includes('<@U9>')) throw new Error('rate_limited');
        return { ok: true, messages: { matches: [], total: 0, paging: { pages: 1 } } };
      }
      throw new Error(`unexpected method ${method}`);
    },
  });

  const initial = await integration.threads();
  await flush();
  assert.deepEqual(
    initial.started.map((row) => row.ts),
    [confirmed.ts, omitted.ts],
  );
  assert.ok(initial.continuation, 'the old snapshot has more history');
  const oldToken = initial.continuation;

  refreshing = true;
  clock += 300_001;
  await integration.threads();
  await started;
  const oldContinuation = integration.threads({ continuation: oldToken });
  await flush();
  releaseRefresh();
  await oldContinuation;
  await flush();

  const result = await integration.threads();
  assert.ok(calls.some((call) => call.method === 'conversations.history' && call.refreshing));
  assert.deepEqual(
    result.started.map((row) => row.ts),
    [confirmed.ts],
  );
  assert.equal(result.partial, true);
  assert.ok(result.partialReasons.includes('search_unavailable'));
});

test('review: a connected but unverified refresh replaces prior rows with an empty partial', async () => {
  let clock = NOW;
  let verified = true;
  const prior = root(at(NOW - 1000));
  const integration = createSlackBoard({
    now: () => clock,
    session: () => ({}),
    verify: async () =>
      verified ? { connected: true, userId: 'U9', teamId: 'T1' } : { connected: true },
    channel: async () => ({ id: 'C1', name: 'ezat_claudio' }),
    users: async () => ({}),
    isCurrent: () => true,
    generation: () => 1,
    call: async (method) => {
      if (method === 'conversations.history') return { ok: true, messages: [prior] };
      if (method === 'search.messages')
        return { ok: true, messages: { matches: [], total: 0, paging: { pages: 1 } } };
      throw new Error(`unexpected method ${method}`);
    },
  });

  assert.deepEqual(
    (await integration.threads()).started.map((row) => row.ts),
    [prior.ts],
  );
  await flush();
  verified = false;
  clock += 300_001;
  await integration.threads();
  await flush();
  const result = await integration.threads();
  assert.equal(result.available, true, 'both consumers can replace the prior snapshot');
  assert.deepEqual(result.started, []);
  assert.deepEqual(result.mentions, []);
  assert.equal(result.partial, true);
  assert.ok(result.partialReasons.includes('refresh_failed'));
  assert.equal(integration.isVerifiedRoot(prior.ts), false);
});

test('review: a cold history failure preserves an empty partial and continuation', async () => {
  const integration = createSlackBoard({
    now: () => NOW,
    session: () => ({}),
    verify: async () => ({ connected: true, userId: 'U9', teamId: 'T1' }),
    channel: async () => ({ id: 'C1', name: 'ezat_claudio' }),
    users: async () => ({}),
    isCurrent: () => true,
    generation: () => 1,
    call: async (method) => {
      if (method === 'conversations.history') throw new Error('rate_limited');
      if (method === 'search.messages')
        return { ok: true, messages: { matches: [], total: 0, paging: { pages: 1 } } };
      throw new Error(`unexpected method ${method}`);
    },
  });

  const result = await integration.threads();
  assert.equal(result.available, true, 'an empty partial is still a usable snapshot');
  assert.deepEqual(result.started, []);
  assert.deepEqual(result.mentions, []);
  assert.equal(result.partial, true);
  assert.ok(result.partialReasons.includes('history_unavailable'));
  assert.ok(result.continuation, 'the failed bounded history can be continued');
});
