import test from 'node:test';
import assert from 'node:assert/strict';
import { createSlackBoard } from '../backend/slack-board.mjs';

const NOW = Date.parse('2026-11-07T12:00:00.000Z');
const WINDOW = 28 * 24 * 60 * 60 * 1000;
const CHANNEL = 'C024BE91L';
const ME = 'U9';

function at(ms) {
  const micros = BigInt(ms) * 1000n;
  return `${micros / 1_000_000n}.${String(micros % 1_000_000n).padStart(6, '0')}`;
}

function root(ts) {
  return { ts, thread_ts: ts, user: ME, text: 'TAP-42: synthetic root', reply_count: 0 };
}

function board(call, now) {
  return createSlackBoard({
    call,
    session: () => ({}),
    verify: async () => ({ connected: true, userId: ME, user: 'testuser', teamId: 'T1' }),
    channel: async () => ({ id: CHANNEL, name: 'ezat_claudio' }),
    users: async () => ({}),
    now,
    isCurrent: () => true,
    generation: () => 1,
  });
}

async function flush() {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
}

test('review decision: a bounded refresh replaces continued rows until its own continuation retrieves them', async () => {
  let clock = NOW;
  const roots = Array.from({ length: 8 }, (_, index) => root(at(NOW - (index + 1) * 1000)));
  const pages = roots.map((item) => [item]);
  const calls = [];
  const integration = board(
    async (method, params) => {
      calls.push({ method, params });
      if (method === 'conversations.history') {
        const index = params.cursor ? Number(params.cursor.slice(1)) : 0;
        const next = index + 1 < pages.length ? `p${index + 1}` : '';
        return {
          ok: true,
          messages: pages[index],
          has_more: Boolean(next),
          response_metadata: { next_cursor: next },
        };
      }
      if (method === 'search.messages')
        return { ok: true, messages: { matches: [], total: 0, paging: { pages: 1 } } };
      throw new Error(`unexpected method ${method}`);
    },
    () => clock,
  );

  const first = await integration.threads();
  await flush();
  const continued = await integration.threads({ continuation: first.continuation });
  await flush();
  const oldToken = continued.continuation;
  assert.ok(oldToken, 'more history remains in the previous snapshot');
  assert.deepEqual(
    continued.started.map((row) => row.ts),
    roots.slice(0, 6).map((item) => item.ts),
  );

  pages[5] = []; // The previously loaded sixth row is no longer returned by Slack.
  clock += 300_001;
  await integration.threads();
  await flush();
  const refreshed = structuredClone(await integration.threads());
  assert.equal(refreshed.partial, true);
  assert.ok(refreshed.continuation);
  assert.deepEqual(
    refreshed.started.map((row) => row.ts),
    roots.slice(0, 3).map((item) => item.ts),
  );
  const count = calls.length;
  assert.equal((await integration.threads({ continuation: oldToken })).available, false);
  assert.equal(calls.length, count, 'a superseded continuation cannot read or restore old rows');

  const more = await integration.threads({ continuation: refreshed.continuation });
  await flush();
  assert.deepEqual(
    more.started.map((row) => row.ts),
    roots.slice(0, 5).map((item) => item.ts),
  );
  assert.ok(!more.started.some((row) => row.ts === roots[5].ts), 'the deleted row stays absent');
});

for (const failure of ['search', 'history with a confirmed search root', 'history with no roots']) {
  test(`review decision: incomplete ${failure} refresh excludes omitted prior rows`, async () => {
    let clock = NOW;
    let refreshing = false;
    const present = root(at(NOW - 1000));
    const omitted = root(at(NOW - 2000));
    const calls = [];
    const integration = board(
      async (method, params) => {
        calls.push({ method, params, refreshing });
        if (method === 'conversations.history') {
          if (refreshing && failure.startsWith('history')) throw new Error('rate_limited');
          return { ok: true, messages: refreshing ? [present] : [present, omitted] };
        }
        if (method === 'search.messages') {
          if (refreshing && failure === 'search' && !params.query.includes(`<@${ME}>`))
            throw new Error('rate_limited');
          const matches =
            refreshing &&
            failure === 'history with a confirmed search root' &&
            !params.query.includes(`<@${ME}>`)
              ? [{ ...present, channel: { id: CHANNEL, name: 'ezat_claudio' } }]
              : [];
          return { ok: true, messages: { matches, total: matches.length, paging: { pages: 1 } } };
        }
        if (method === 'conversations.replies')
          return { ok: true, messages: [present], has_more: false, response_metadata: {} };
        throw new Error(`unexpected method ${method}`);
      },
      () => clock,
    );

    await integration.threads();
    await flush();
    assert.deepEqual(
      new Set((await integration.threads()).started.map((row) => row.ts)),
      new Set([present.ts, omitted.ts]),
      'both roots were previously loaded',
    );
    refreshing = true;
    clock += 300_001;
    await integration.threads();
    await flush();
    const result = structuredClone(await integration.threads());
    assert.equal(result.available, true);
    assert.equal(result.partial, true);
    assert.ok(
      calls.some((call) => call.refreshing),
      'the new snapshot was attempted',
    );
    const expected = failure === 'history with no roots' ? [] : [present.ts];
    assert.deepEqual(
      result.started.map((row) => row.ts),
      expected,
      'only roots confirmed by the incomplete refresh can remain',
    );
  });
}

test('review decision: moving cutoff bounds every history page before old roots are returned', async () => {
  let clock = NOW;
  let moved = false;
  let returnedExpired = false;
  const expired = root(at(NOW - WINDOW + 1));
  const calls = [];
  const integration = board(
    async (method, params) => {
      calls.push({ method, params, at: clock });
      if (method === 'conversations.history') {
        if (!moved) {
          moved = true;
          clock += 2;
          return {
            ok: true,
            messages: [],
            has_more: true,
            response_metadata: { next_cursor: 'p2' },
          };
        }
        const messages = params.oldest <= expired.ts ? [expired] : [];
        returnedExpired ||= messages.length > 0;
        return { ok: true, messages, has_more: false, response_metadata: {} };
      }
      if (method === 'search.messages')
        return { ok: true, messages: { matches: [], total: 0, paging: { pages: 1 } } };
      if (method === 'conversations.replies') throw new Error('unexpected targeted reply read');
      throw new Error(`unexpected method ${method}`);
    },
    () => clock,
  );

  const result = await integration.threads();
  await flush();
  assert.equal(result.available, true);
  assert.deepEqual(result.started, []);
  assert.deepEqual(result.mentions, []);
  assert.ok(!calls.some((call) => call.method === 'conversations.replies'));
  const history = calls.filter((call) => call.method === 'conversations.history');
  assert.deepEqual(
    { oldest: history.map((call) => call.params.oldest), returnedExpired },
    { oldest: history.map((call) => at(call.at - WINDOW)), returnedExpired: false },
    'every page must use the current creation cutoff, or stop/restart safely',
  );
  assert.ok(history.every((call) => call.params.inclusive === true));
});

test('review: recovered reply enrichment no longer reports the resolved failure', async () => {
  let clock = NOW;
  let throttled = false;
  const candidate = { ...root(at(NOW - 30_000)), reply_count: 1, latest_reply: at(NOW - 1000) };
  const latest = { ts: candidate.latest_reply, thread_ts: candidate.ts, user: 'U1', text: 'reply' };
  const integration = board(
    async (method) => {
      if (method === 'conversations.history') return { ok: true, messages: [candidate] };
      if (method === 'search.messages')
        return { ok: true, messages: { matches: [], total: 0, paging: { pages: 1 } } };
      if (method === 'conversations.replies') {
        if (throttled) throw new Error('rate_limited');
        return { ok: true, messages: [candidate, latest], has_more: false, response_metadata: {} };
      }
      throw new Error(`unexpected method ${method}`);
    },
    () => clock,
  );

  await integration.threads();
  await flush();
  assert.equal((await integration.threads()).started[0].needsReply, true);
  throttled = true;
  clock += 300_001;
  await integration.threads();
  await flush();
  const failed = structuredClone(await integration.threads());
  assert.ok(failed.partialReasons.includes('reply_unavailable'));
  assert.ok(failed.continuation);

  throttled = false;
  clock += 30_001;
  await integration.threads({ continuation: failed.continuation });
  await flush();
  const recovered = await integration.threads();
  assert.equal(recovered.started[0].needsReply, true);
  assert.ok(!recovered.partialReasons.includes('reply_activity_stale'));
  assert.ok(!recovered.partialReasons.includes('reply_unavailable'), 'the failure was resolved');
});
