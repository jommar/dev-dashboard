import test from 'node:test';
import assert from 'node:assert/strict';
import { createSlackBoard } from '../backend/slack-board.mjs';

const NOW = Date.parse('2026-11-07T12:00:00.000Z');
const ME = 'U9';
const OTHER = 'U1';

function at(ms, micros = 0) {
  const value = BigInt(ms) * 1000n + BigInt(micros);
  return `${value / 1_000_000n}.${String(value % 1_000_000n).padStart(6, '0')}`;
}

function deferred() {
  let release;
  const promise = new Promise((resolve) => (release = resolve));
  return { promise, release };
}

async function flush() {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
}

function fixture(evidence) {
  let clock = NOW;
  let stage = 'prime';
  let gen = 1;
  const oldGate = deferred();
  const newGate = deferred();
  const historyGate = deferred();
  let holdHistory = false;
  let historyStarted = false;
  let oldStarted = false;
  let newStarted = false;
  const roots = [30_000, 40_000].map((age, index) => ({
    ts: at(NOW - age),
    thread_ts: at(NOW - age),
    user: ME,
    text: `TAP-${index + 1} synthetic`,
    reply_count: 1,
    latest_reply: at(NOW - 1000 - index),
  }));
  const replies = roots.map((root) => ({
    ts: root.latest_reply,
    thread_ts: root.ts,
    user: OTHER,
    text: 'synthetic reply',
  }));
  const integration = createSlackBoard({
    now: () => clock,
    session: () => ({}),
    verify: async () => ({ connected: true, userId: ME, teamId: 'T1' }),
    channel: async () => ({ id: 'C1', name: 'ezat_claudio' }),
    users: async () => ({}),
    generation: () => gen,
    isCurrent: (value) => value === gen,
    call: async (method, params) => {
      if (method === 'conversations.history') {
        if (stage === 'new' && holdHistory) {
          historyStarted = true;
          await historyGate.promise;
        }
        return { ok: true, messages: roots };
      }
      if (method === 'search.messages') {
        if (stage !== 'prime' && stage !== 'replacement') throw new Error('unavailable');
        return { ok: true, messages: { matches: [], total: 0, paging: { pages: 1 } } };
      }
      if (method !== 'conversations.replies') throw new Error(`unexpected ${method}`);
      const index = roots.findIndex((root) => root.ts === params.ts);
      assert.notEqual(index, -1);
      if (stage === 'prime' || stage === 'replacement')
        return { ok: true, messages: [roots[index], replies[index]], response_metadata: {} };
      if (stage === 'old' && index === 0) {
        oldStarted = true;
        await oldGate.promise;
        if (evidence === 'conflict')
          return {
            ok: true,
            messages: [{ ...roots[0], reply_count: 2, latest_reply: at(NOW - 1000, 900) }],
            has_more: true,
            response_metadata: { next_cursor: 'next' },
          };
        if (evidence === 'matching')
          return {
            ok: true,
            messages: [roots[0], replies[0]],
            has_more: true,
            response_metadata: { next_cursor: 'next' },
          };
        return { ok: false, error: evidence };
      }
      if (stage === 'new') {
        newStarted = true;
        await newGate.promise;
      }
      throw new Error('unavailable');
    },
  });
  return {
    integration,
    roots,
    oldGate,
    newGate,
    historyGate,
    holdHistory: () => (holdHistory = true),
    historyStarted: () => historyStarted,
    setStage: (value) => (stage = value),
    advance: (ms) => (clock += ms),
    oldStarted: () => oldStarted,
    newStarted: () => newStarted,
    replace: () => {
      gen++;
      integration.clear();
      stage = 'replacement';
    },
  };
}

function assertActivity(result, root, expected) {
  const row = result.started.find((item) => item.ts === root.ts);
  assert.ok(row, 'freshly confirmed root is displayed');
  assert.equal(row.latestReplyBy?.id || null, expected ? OTHER : null);
  assert.equal(row.activityTs, expected ? root.latest_reply : null);
  assert.equal(row.needsReply, expected ? true : null);
}

for (const evidence of [
  'conflict',
  'not_in_channel',
  'invalid_auth',
  'token_revoked',
  'matching',
]) {
  for (const order of ['old first', 'replacement first']) {
    test(`reply evidence: ${evidence} survives overlapping refresh (${order})`, async () => {
      const f = fixture(evidence);
      await f.integration.threads();
      await flush();
      const primed = await f.integration.threads();
      for (const root of f.roots) assertActivity(primed, root, true);

      f.setStage('failed');
      f.advance(300_001);
      await f.integration.threads();
      await flush();
      const previous = structuredClone(await f.integration.threads());
      assert.ok(previous.continuation);
      for (const root of f.roots) assertActivity(previous, root, true);

      f.setStage('old');
      const continuation = f.integration.threads({ continuation: previous.continuation });
      try {
        await flush();
        assert.ok(f.oldStarted(), 'old continuation started its held reply');
        f.setStage('new');
        f.advance(60_001);
        await f.integration.threads();
        await flush();
        assert.ok(f.newStarted(), 'replacement started its held replies');
        if (order === 'replacement first') {
          f.newGate.release();
          await flush();
          const beforeEvidence = structuredClone(await f.integration.threads());
          for (const root of f.roots) assertActivity(beforeEvidence, root, true);
          assert.ok(beforeEvidence.partialReasons.includes('reply_activity_stale'));
          f.oldGate.release();
        } else {
          f.oldGate.release();
          await flush();
          f.newGate.release();
        }
        await continuation;
        await flush();
        const afterEvidence = structuredClone(await f.integration.threads());
        assertActivity(afterEvidence, f.roots[0], evidence === 'matching');
        const otherRetained = !['invalid_auth', 'token_revoked'].includes(evidence);
        assertActivity(afterEvidence, f.roots[1], otherRetained);
        assert.equal(
          afterEvidence.partialReasons.includes('reply_activity_stale'),
          evidence === 'matching' || otherRetained,
        );

        f.setStage('later');
        f.advance(300_001);
        await f.integration.threads();
        await flush();
        const later = await f.integration.threads();
        assertActivity(later, f.roots[0], evidence === 'matching');
        assertActivity(later, f.roots[1], otherRetained);
      } finally {
        f.oldGate.release();
        f.newGate.release();
      }
    });
  }
}

for (const evidence of ['conflict', 'not_in_channel', 'invalid_auth']) {
  test(`reply evidence: late ${evidence} cannot invalidate a replacement session`, async () => {
    const f = fixture(evidence);
    await f.integration.threads();
    await flush();
    f.setStage('failed');
    f.advance(300_001);
    await f.integration.threads();
    await flush();
    const previous = await f.integration.threads();
    f.setStage('old');
    const continuation = f.integration.threads({ continuation: previous.continuation });
    try {
      await flush();
      assert.ok(f.oldStarted());
      f.replace();
      await f.integration.threads();
      await flush();
      const replacement = await f.integration.threads();
      for (const root of f.roots) assertActivity(replacement, root, true);
      f.oldGate.release();
      await continuation;
      await flush();
      const after = await f.integration.threads();
      for (const root of f.roots) assertActivity(after, root, true);
      f.setStage('later');
      f.advance(300_001);
      await f.integration.threads();
      await flush();
      const later = await f.integration.threads();
      for (const root of f.roots) assertActivity(later, root, true);
      assert.ok(later.partialReasons.includes('reply_activity_stale'));
    } finally {
      f.oldGate.release();
    }
  });
}

for (const evidence of ['conflict', 'not_in_channel', 'invalid_auth']) {
  test(`reply evidence: ${evidence} before replacement publication prevents copying`, async () => {
    const f = fixture(evidence);
    await f.integration.threads();
    await flush();
    f.setStage('failed');
    f.advance(300_001);
    await f.integration.threads();
    await flush();
    const previous = await f.integration.threads();
    f.setStage('old');
    const continuation = f.integration.threads({ continuation: previous.continuation });
    try {
      await flush();
      assert.ok(f.oldStarted());
      f.holdHistory();
      f.setStage('new');
      f.advance(60_001);
      await f.integration.threads();
      await flush();
      assert.ok(f.historyStarted());
      f.oldGate.release();
      await flush();
      f.historyGate.release();
      f.newGate.release();
      await continuation;
      await flush();
      const result = await f.integration.threads();
      assertActivity(result, f.roots[0], false);
      assertActivity(result, f.roots[1], evidence !== 'invalid_auth');
    } finally {
      f.oldGate.release();
      f.newGate.release();
      f.historyGate.release();
    }
  });
}

for (const evidence of ['not_in_channel', 'invalid_auth', 'token_revoked']) {
  test(`reply evidence: ${evidence} affects only its proper scope in the current snapshot`, async () => {
    const f = fixture(evidence);
    await f.integration.threads();
    await flush();
    f.setStage('failed');
    f.advance(300_001);
    await f.integration.threads();
    await flush();
    const previous = await f.integration.threads();
    f.setStage('old');
    const continuation = f.integration.threads({ continuation: previous.continuation });
    try {
      await flush();
      assert.ok(f.oldStarted());
      f.oldGate.release();
      await continuation;
      await flush();
      const after = await f.integration.threads();
      assertActivity(after, f.roots[0], false);
      assertActivity(after, f.roots[1], evidence === 'not_in_channel');

      f.setStage('replacement');
      f.advance(300_001);
      await f.integration.threads();
      await flush();
      const recovered = await f.integration.threads();
      for (const root of f.roots) assertActivity(recovered, root, true);
      f.setStage('later');
      f.advance(300_001);
      await f.integration.threads();
      await flush();
      const throttled = await f.integration.threads();
      for (const root of f.roots) assertActivity(throttled, root, true);
      assert.ok(throttled.partialReasons.includes('reply_activity_stale'));
    } finally {
      f.oldGate.release();
    }
  });
}

for (const evidence of ['conflict', 'not_in_channel']) {
  test(`reply evidence: late ${evidence} does not revoke a newly verified independent reply`, async () => {
    const f = fixture(evidence);
    await f.integration.threads();
    await flush();
    f.setStage('failed');
    f.advance(300_001);
    await f.integration.threads();
    await flush();
    const previous = await f.integration.threads();
    f.setStage('old');
    const continuation = f.integration.threads({ continuation: previous.continuation });
    try {
      await flush();
      assert.ok(f.oldStarted());
      f.setStage('replacement');
      f.advance(60_001);
      await f.integration.threads();
      await flush();
      for (const root of f.roots) assertActivity(await f.integration.threads(), root, true);
      f.oldGate.release();
      await continuation;
      await flush();
      f.setStage('later');
      f.advance(300_001);
      await f.integration.threads();
      await flush();
      const result = await f.integration.threads();
      for (const root of f.roots) assertActivity(result, root, true);
      assert.ok(result.partialReasons.includes('reply_activity_stale'));
    } finally {
      f.oldGate.release();
    }
  });
}

for (const evidence of ['count', 'latest', 'missing', 'equivalent']) {
  test(`reply evidence: late ${evidence} history parent cannot leave a contradictory fallback`, async () => {
    let clock = NOW;
    let stage = 'prime';
    let oldStarted = false;
    const gate = deferred();
    const root = {
      ts: at(NOW - 30_000),
      thread_ts: at(NOW - 30_000),
      user: ME,
      reply_count: 1,
      latest_reply: at(NOW - 1000, 100),
    };
    const reply = { ts: root.latest_reply, thread_ts: root.ts, user: OTHER };
    const integration = createSlackBoard({
      now: () => clock,
      session: () => ({}),
      verify: async () => ({ connected: true, userId: ME, teamId: 'T1' }),
      channel: async () => ({ id: 'C1', name: 'ezat_claudio' }),
      users: async () => ({}),
      generation: () => 1,
      isCurrent: () => true,
      call: async (method, params) => {
        if (method === 'conversations.history') {
          if (stage === 'failed' && !params.cursor)
            return { ok: true, messages: [root], response_metadata: { next_cursor: 'p2' } };
          if (stage === 'failed' && params.cursor) throw new Error('unavailable');
          if (stage === 'old' && params.cursor) {
            oldStarted = true;
            await gate.promise;
            const parents = {
              count: { ...root, reply_count: 2 },
              latest: { ...root, latest_reply: at(NOW - 1000, 900) },
              missing: { ts: root.ts, thread_ts: root.ts, user: ME },
              equivalent: { ...root, latest_reply: root.latest_reply.replace(/0+$/, '') },
            };
            return { ok: true, messages: [parents[evidence]] };
          }
          return { ok: true, messages: [root] };
        }
        if (method === 'search.messages') {
          if (stage !== 'prime') throw new Error('unavailable');
          return { ok: true, messages: { matches: [], total: 0, paging: { pages: 1 } } };
        }
        if (method === 'conversations.replies') {
          if (stage === 'prime') return { ok: true, messages: [root, reply] };
          throw new Error('unavailable');
        }
        throw new Error(`unexpected ${method}`);
      },
    });
    await integration.threads();
    await flush();
    stage = 'failed';
    clock += 300_001;
    await integration.threads();
    await flush();
    const previous = await integration.threads();
    assert.ok(previous.continuation);
    stage = 'old';
    const continuation = integration.threads({ continuation: previous.continuation });
    try {
      await flush();
      assert.ok(oldStarted);
      stage = 'new';
      clock += 60_001;
      await integration.threads();
      await flush();
      assertActivity(await integration.threads(), root, true);
      gate.release();
      await continuation;
      await flush();
      const after = await integration.threads();
      assertActivity(after, root, evidence === 'missing' || evidence === 'equivalent');
    } finally {
      gate.release();
    }
  });
}
