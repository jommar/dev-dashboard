import test from 'node:test';
import assert from 'node:assert/strict';
import { createSlackBoard } from '../backend/slack-board.mjs';

const NOW = Date.parse('2026-11-07T12:00:00.000Z');
const WINDOW = 28 * 24 * 60 * 60 * 1000;
const ME = 'U9';

function at(ms) {
  const micros = BigInt(ms) * 1000n;
  return `${micros / 1_000_000n}.${String(micros % 1_000_000n).padStart(6, '0')}`;
}

async function flush() {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
}

function fixture(messages) {
  let clock = NOW;
  let history = messages;
  let gen = 1;
  const calls = [];
  const board = createSlackBoard({
    now: () => clock,
    session: () => ({}),
    verify: async () => ({ connected: true, userId: ME, teamId: 'T1' }),
    channel: async () => ({ id: 'C1', name: 'ezat_claudio' }),
    users: async () => ({}),
    generation: () => gen,
    isCurrent: (value) => value === gen,
    call: async (method, params) => {
      calls.push({ method, params });
      if (method === 'conversations.history') return { ok: true, messages: history };
      if (method === 'search.messages')
        return { ok: true, messages: { matches: [], total: 0, paging: { pages: 1 } } };
      throw new Error(`unexpected targeted read ${method}`);
    },
  });
  return {
    board,
    calls,
    setHistory: (value) => (history = value),
    advance: (ms) => (clock += ms),
    replace: () => {
      gen++;
      board.clear();
    },
  };
}

const root = {
  ts: at(NOW - 86_400_000),
  thread_ts: at(NOW - 86_400_000),
  user: ME,
  text: 'TAP-1 verified',
  reply_count: 0,
};
const mention = { ts: at(NOW - 60_000), user: 'U1', text: `TAP-2 <@${ME}>` };

for (const [label, value] of [
  ['missing', undefined],
  ['malformed', 'not-a-timestamp'],
  ['later than the message', at(NOW - 1000)],
  ['equivalent but unaccepted root marker', mention.ts.replace(/0+$/, '')],
]) {
  test(`history mention: skipped ${label} marker is disclosed without targeted reads`, async () => {
    const message = { ...mention, ...(value === undefined ? {} : { thread_ts: value }) };
    const f = fixture([root, message]);
    await f.board.threads();
    await flush();
    const result = await f.board.threads();
    assert.deepEqual(
      result.started.map((row) => row.ts),
      [root.ts],
    );
    assert.deepEqual(result.mentions, []);
    assert.equal(result.partial, true);
    assert.ok(result.partialReasons.includes('ambiguous_history_mention'));
    assert.ok(result.partialReasons.includes('search_coverage_uncertain'));
    assert.equal(f.calls.filter((call) => call.method === 'search.messages').length, 2);
    assert.ok(!f.calls.some((call) => call.method === 'conversations.replies'));
  });
}

for (const [label, message] of [
  ['non-mention', { ...mention, text: 'no mention' }],
  ['another user', { ...mention, text: '<@U2>' }],
  ['known old parent', { ...mention, thread_ts: at(NOW - WINDOW - 60_000) }],
  ['known recent parent', { ...mention, thread_ts: root.ts }],
  ['confirmed root mention', { ...root, user: 'U1', text: `<@${ME}>` }],
  ['outside the window', { ...mention, ts: at(NOW - WINDOW - 1) }],
]) {
  test(`history mention: ${label} does not claim an ambiguous standalone mention`, async () => {
    const f = fixture([root, message]);
    const result = await f.board.threads();
    await flush();
    assert.ok(!result.partialReasons.includes('ambiguous_history_mention'));
    assert.ok(!f.calls.some((call) => call.method === 'conversations.replies'));
  });
}

test('history mention: an empty displayed list still discloses a skipped mention', async () => {
  const f = fixture([mention]);
  const result = await f.board.threads();
  assert.deepEqual(result.started, []);
  assert.deepEqual(result.mentions, []);
  assert.ok(result.partialReasons.includes('ambiguous_history_mention'));
  assert.ok(!f.calls.some((call) => call.method === 'conversations.replies'));
});

test('history mention: fresh refresh and replacement session do not retain an omitted ambiguity', async () => {
  const f = fixture([root, mention]);
  const first = await f.board.threads();
  await flush();
  assert.ok(first.partialReasons.includes('ambiguous_history_mention'));
  f.setHistory([]);
  f.advance(300_001);
  await f.board.threads();
  await flush();
  const refreshed = await f.board.threads();
  assert.deepEqual(refreshed.started, []);
  assert.ok(!refreshed.partialReasons.includes('ambiguous_history_mention'));
  f.replace();
  const replacement = await f.board.threads();
  assert.ok(!replacement.partialReasons.includes('ambiguous_history_mention'));
  assert.deepEqual(replacement.started, []);
  assert.ok(!f.calls.some((call) => call.method === 'conversations.replies'));
});
