import test from 'node:test';
import assert from 'node:assert/strict';
import { createSlackIntegration, slackPaths } from '../backend/slack.mjs';

const NOW = Date.parse('2026-11-07T12:00:00.000Z');
const WINDOW = 28 * 24 * 60 * 60 * 1000;
const CHANNEL = 'C024BE91L';
const ME = 'U9';
const OTHER = 'U1';

function at(ms, micros = 0) {
  const value = BigInt(ms) * 1000n + BigInt(micros);
  return `${value / 1_000_000n}.${String(value % 1_000_000n).padStart(6, '0')}`;
}

async function flush() {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
}

// Every response, session and clock below is synthetic and in memory.
function fixture(
  rootTs = at(NOW - 30_000),
  { rootUser = ME, rootText = 'TAP-42 synthetic thread', includeOmitted = true } = {},
) {
  let now = NOW;
  let mode = 'verified';
  let session = 'original';
  let heldReply = null;
  const root = {
    ts: rootTs,
    thread_ts: rootTs,
    user: rootUser,
    text: rootText,
    reply_count: 1,
    latest_reply: at(NOW - 1000, 100),
  };
  const changed = { ...root, reply_count: 2, latest_reply: at(NOW - 1000, 900) };
  const omitted = {
    ts: at(NOW - 40_000),
    thread_ts: at(NOW - 40_000),
    user: ME,
    text: 'TAP-43 omitted thread',
    reply_count: 0,
  };
  const oldReply = { ts: root.latest_reply, thread_ts: root.ts, user: OTHER, text: 'Old reply' };
  const newReply = { ts: changed.latest_reply, thread_ts: root.ts, user: ME, text: 'New reply' };
  const calls = [];
  const paths = slackPaths('/virtual-contradiction-home');
  const fs = {
    lstatSync(file) {
      return {
        isDirectory: () => file !== paths.session,
        isFile: () => file === paths.session,
        isSymbolicLink: () => false,
      };
    },
    chmodSync() {},
    readFileSync: () =>
      JSON.stringify({ token: `xoxc-synthetic-${session}`, cookie: `xoxd-synthetic-${session}` }),
  };
  const respond = (payload) => new Response(JSON.stringify(payload));
  const limited = () =>
    new Response(JSON.stringify({ ok: false, error: 'ratelimited' }), {
      status: 429,
      headers: { 'Retry-After': '30' },
    });
  const fetchImpl = async (url) => {
    const request = new URL(url);
    const method = request.pathname.split('/').pop();
    const params = Object.fromEntries(request.searchParams);
    calls.push({ method, params, mode });
    if (method === 'auth.test')
      return respond({ ok: true, user: 'testuser', user_id: ME, team_id: 'T1' });
    if (method === 'users.list')
      return respond({ ok: true, members: [{ id: OTHER, real_name: 'Colleague' }] });
    if (method === 'search.messages') {
      const matches =
        params.count === '1' ? [{ channel: { id: CHANNEL, name: 'ezat_claudio' } }] : [];
      return respond({
        ok: true,
        messages: { matches, total: matches.length, paging: { pages: 1 } },
      });
    }
    if (method === 'conversations.history') {
      const current = mode === 'recovered' ? changed : root;
      const messages = [
        current,
        ...(mode === 'verified' && includeOmitted ? [omitted] : []),
      ].filter((item) => item.ts >= params.oldest);
      return respond({ ok: true, messages, response_metadata: {} });
    }
    if (method === 'conversations.replies') {
      assert.equal(params.ts, root.ts, 'only the eligible test root is read');
      const held = heldReply;
      heldReply = null;
      if (held) await held;
      if (mode === 'throttled' || params.cursor) return limited();
      if (mode === 'denied-http')
        return new Response(JSON.stringify({ ok: false, error: 'not_in_channel' }), {
          status: 403,
        });
      if (mode === 'denied-payload') return respond({ ok: false, error: 'not_in_channel' });
      if (mode === 'denied-http-401')
        return new Response(JSON.stringify({ ok: false, error: 'invalid_auth' }), {
          status: 401,
        });
      if (mode === 'unknown-http-403')
        return new Response(JSON.stringify({ ok: false, error: 'internal_error' }), {
          status: 403,
        });
      if (mode === 'service-error')
        return new Response(JSON.stringify({ ok: false, error: 'internal_error' }), {
          status: 503,
        });
      if (mode === 'verified')
        return respond({ ok: true, messages: [root, oldReply], response_metadata: {} });
      if (mode === 'recovered')
        return respond({
          ok: true,
          messages: [changed, oldReply, newReply],
          response_metadata: {},
        });
      const parents = {
        conflict: changed,
        'conflict-count': { ...root, reply_count: 2 },
        'conflict-latest': { ...root, latest_reply: changed.latest_reply },
        'conflict-earlier': { ...root, latest_reply: at(NOW - 1000, 50) },
        equivalent: { ...root, latest_reply: root.latest_reply.replace(/0+$/, '') },
        missing: { ts: root.ts, thread_ts: root.ts, user: ME, text: root.text },
      };
      const parent = parents[mode] || root;
      const observedReply =
        mode === 'reply-metadata'
          ? { ...oldReply, reply_count: 2, latest_reply: changed.latest_reply }
          : oldReply;
      return respond({
        ok: true,
        messages: [parent, observedReply],
        has_more: true,
        response_metadata: { next_cursor: 'reply-1' },
      });
    }
    throw new Error(`unexpected synthetic method ${method}`);
  };
  return {
    integration: createSlackIntegration({ paths, fs, fetchImpl, now: () => now }),
    root,
    changed,
    omitted,
    calls,
    setMode: (value) => (mode = value),
    replaceSession: () => (session = 'replacement'),
    advance: (ms) => (now += ms),
    holdNextReply: () => {
      let release;
      heldReply = new Promise((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}

async function prime(f) {
  await f.integration.threads();
  await flush();
  const result = structuredClone(await f.integration.threads());
  const row = result.started.find((item) => item.ts === f.root.ts);
  assert.equal(row.activityTs, f.root.latest_reply);
  assert.equal(row.latestReplyBy.id, OTHER);
  assert.equal(row.needsReply, true);
  return result;
}

async function refresh(f, mode) {
  f.setMode(mode);
  f.advance(300_001);
  const before = f.calls.length;
  await f.integration.threads();
  await flush();
  return { result: structuredClone(await f.integration.threads()), calls: f.calls.slice(before) };
}

test('review contradiction: conflicting reply-page root invalidates fallback before a 429', async (t) => {
  const f = fixture();
  const initial = await prime(f);
  assert.ok(initial.started.some((row) => row.ts === f.omitted.ts));
  const { result, calls } = await refresh(f, 'conflict');
  assert.deepEqual(
    result.started.map((row) => row.ts),
    [f.root.ts],
    'only current roots remain',
  );
  assert.equal(result.partial, true);
  assert.ok(result.partialReasons.includes('reply_unavailable'));
  const replies = calls.filter((call) => call.method === 'conversations.replies');
  assert.equal(replies.length, 2);
  assert.equal(replies[0].params.cursor, undefined);
  assert.equal(replies[1].params.cursor, 'reply-1', 'the second reply page returns HTTP 429');
  assert.equal(f.root.reply_count, 1);
  assert.equal(f.changed.reply_count, 2);
  assert.notEqual(f.root.latest_reply, f.changed.latest_reply);
  const row = result.started[0];
  t.diagnostic(
    `conflict result: ${JSON.stringify({ activityTs: row.activityTs, latestReplyBy: row.latestReplyBy, needsReply: row.needsReply, partialReasons: result.partialReasons })}`,
  );

  f.setMode('recovered');
  f.advance(300_001);
  await f.integration.threads();
  await flush();
  const recovered = structuredClone(await f.integration.threads());
  assert.equal(recovered.started[0].activityTs, f.changed.latest_reply);
  assert.equal(recovered.started[0].latestReplyBy.id, ME);
  assert.equal(recovered.started[0].needsReply, false);
  assert.ok(!recovered.partialReasons.includes('reply_activity_stale'));

  assert.deepEqual(
    { activityTs: row.activityTs, latestReplyBy: row.latestReplyBy, needsReply: row.needsReply },
    { activityTs: null, latestReplyBy: null, needsReply: null },
    'contradictory current evidence cannot certify the previously cached reply',
  );
  assert.ok(!result.partialReasons.includes('reply_activity_stale'));
});

for (const mode of [
  'matching',
  'missing',
  'equivalent',
  'reply-metadata',
  'throttled',
  'service-error',
  'unknown-http-403',
]) {
  test(`review control: ${mode} reply page retains verified stale activity`, async () => {
    const f = fixture();
    await prime(f);
    const { result, calls } = await refresh(f, mode);
    assert.deepEqual(
      result.started.map((row) => row.ts),
      [f.root.ts],
    );
    assert.equal(result.started[0].activityTs, f.root.latest_reply);
    assert.equal(result.started[0].latestReplyBy.id, OTHER);
    assert.equal(result.started[0].needsReply, true);
    assert.equal(result.partial, true);
    assert.ok(result.partialReasons.includes('reply_unavailable'));
    assert.ok(result.partialReasons.includes('reply_activity_stale'));
    const replies = calls.filter((call) => call.method === 'conversations.replies');
    const paged = ['matching', 'missing', 'equivalent', 'reply-metadata'].includes(mode);
    assert.equal(replies.length, paged ? 2 : 1);
    if (paged) assert.equal(replies[1].params.cursor, 'reply-1');
  });
}

for (const mode of ['conflict-count', 'conflict-latest', 'conflict-earlier']) {
  test(`review contradiction: ${mode} alone invalidates fallback through later throttling`, async () => {
    const f = fixture();
    await prime(f);
    const { result } = await refresh(f, mode);
    assertNoReplyFallback(result);
    assert.ok(result.partialReasons.includes('reply_root_metadata_conflict'));
    const later = await refresh(f, 'throttled');
    assertNoReplyFallback(later.result);
  });
}

test('review contradiction: a delayed conflicting parent invalidates an already displayed fallback', async () => {
  const f = fixture();
  await prime(f);
  f.setMode('conflict');
  const release = f.holdNextReply();
  try {
    f.advance(300_001);
    await f.integration.threads();
    await flush();
    const pending = structuredClone(await f.integration.threads());
    assert.equal(pending.started[0].latestReplyBy.id, OTHER);
    assert.ok(pending.partialReasons.includes('reply_activity_stale'));
  } finally {
    release();
  }
  await flush();
  const result = await f.integration.threads();
  assertNoReplyFallback(result);
  assert.ok(result.partialReasons.includes('reply_root_metadata_conflict'));
});

test('review control: a replacement session cannot reuse the previous reply fallback', async () => {
  const f = fixture();
  await prime(f);
  f.replaceSession();
  f.setMode('throttled');
  await f.integration.threads();
  await flush();
  const result = await f.integration.threads();
  assert.equal(result.started[0].ts, f.root.ts);
  assert.equal(result.started[0].activityTs, null);
  assert.equal(result.started[0].latestReplyBy, null);
  assert.equal(result.started[0].needsReply, null);
  assert.ok(!result.partialReasons.includes('reply_activity_stale'));
});

test('review control: an expired root is neither displayed nor read during refresh', async () => {
  const f = fixture(at(NOW - WINDOW + 300_000));
  await prime(f);
  const { result, calls } = await refresh(f, 'conflict');
  assert.deepEqual(result.started, []);
  assert.ok(!calls.some((call) => call.method === 'conversations.replies'));
});

async function afterAccessFailure(mode) {
  const f = fixture();
  await prime(f);
  const denied = await refresh(f, mode);
  assert.ok(denied.calls.some((call) => call.method === 'conversations.replies'));
  const later = await refresh(f, 'throttled');
  assert.ok(later.calls.some((call) => call.method === 'conversations.replies'));
  return { denied: denied.result, later: later.result };
}

function assertNoReplyFallback(result) {
  assert.equal(result.started.length, 1);
  assert.equal(result.partial, true);
  assert.ok(result.partialReasons.includes('reply_unavailable'));
  const row = result.started[0];
  assert.deepEqual(
    { activityTs: row.activityTs, latestReplyBy: row.latestReplyBy, needsReply: row.needsReply },
    { activityTs: null, latestReplyBy: null, needsReply: null },
  );
  assert.ok(!result.partialReasons.includes('reply_activity_stale'));
}

test('review MINOR: HTTP 403 with not_in_channel invalidates fallback through later throttling', async (t) => {
  const { denied, later } = await afterAccessFailure('denied-http');
  t.diagnostic(
    `403 then 429: ${JSON.stringify([denied, later].map((result) => ({ activityTs: result.started[0].activityTs, latestReplyBy: result.started[0].latestReplyBy, needsReply: result.started[0].needsReply, reasons: result.partialReasons })))}`,
  );
  assertNoReplyFallback(denied);
  assertNoReplyFallback(later);
});

test('review control: HTTP 200 not_in_channel invalidates fallback through later throttling', async () => {
  const { denied, later } = await afterAccessFailure('denied-payload');
  assertNoReplyFallback(denied);
  assertNoReplyFallback(later);
});

test('review MINOR: HTTP 401 with invalid_auth invalidates fallback through later throttling', async () => {
  const { denied, later } = await afterAccessFailure('denied-http-401');
  assertNoReplyFallback(denied);
  assertNoReplyFallback(later);
});

test('review MINOR: hidden roots do not produce a stale-reply warning', async (t) => {
  const f = fixture(undefined, { rootUser: OTHER, includeOmitted: false });
  const initial = await f.integration.threads();
  await flush();
  assert.deepEqual(initial.started, []);
  assert.deepEqual(initial.mentions, []);
  assert.ok(f.calls.some((call) => call.method === 'conversations.replies'));
  const { result } = await refresh(f, 'throttled');
  assert.deepEqual(result.started, []);
  assert.deepEqual(result.mentions, []);
  assert.equal(result.partial, true);
  assert.ok(result.partialReasons.includes('reply_unavailable'));
  t.diagnostic(`hidden root reasons: ${JSON.stringify(result.partialReasons)}`);
  assert.ok(!result.partialReasons.includes('reply_activity_stale'));
});

test('review control: a mentions-only row does produce a stale-reply warning', async () => {
  const f = fixture(undefined, {
    rootUser: OTHER,
    rootText: 'TAP-42 synthetic <@U9>',
    includeOmitted: false,
  });
  await f.integration.threads();
  await flush();
  const initial = await f.integration.threads();
  assert.deepEqual(initial.started, []);
  assert.equal(initial.mentions[0].activityTs, f.root.latest_reply);
  assert.equal(initial.mentions[0].latestReplyBy.id, OTHER);
  const { result } = await refresh(f, 'throttled');
  assert.deepEqual(result.started, []);
  assert.equal(result.mentions[0].ts, f.root.ts);
  assert.equal(result.mentions[0].latestReplyBy.id, OTHER);
  assert.equal(result.mentions[0].needsReply, true);
  assert.equal(result.partial, true);
  assert.ok(result.partialReasons.includes('reply_activity_stale'));
});
