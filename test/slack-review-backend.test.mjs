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

function root(ts, latest) {
  return {
    ts,
    thread_ts: ts,
    user: ME,
    text: 'TAP-42: synthetic thread',
    reply_count: latest ? 1 : 0,
    ...(latest ? { latest_reply: latest } : {}),
  };
}

function reply(ts, threadTs, user = OTHER) {
  return { ts, thread_ts: threadTs, user, text: 'synthetic reply' };
}

// Every session read and Slack response is synthetic and in memory.
function fixture(initialPages) {
  let now = NOW;
  let pages = initialPages;
  let session = 'original';
  let channel = CHANNEL;
  let throttleReplies = false;
  let heldHistory = null;
  let heldReply = null;
  let replyMessages = null;
  let replyResponse = null;
  const calls = [];
  const paths = slackPaths('/virtual-review-home');
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
      JSON.stringify({ token: `xoxc-${session}`, cookie: `xoxd-${session}`, teamId: 'T1' }),
  };
  const respond = (payload) =>
    payload instanceof Response ? payload : new Response(JSON.stringify(payload));
  const fetchImpl = async (url) => {
    const request = new URL(url);
    const method = request.pathname.split('/').pop();
    const params = Object.fromEntries(request.searchParams);
    calls.push({ method, params, at: now });
    if (method === 'auth.test')
      return respond({ ok: true, user: 'testuser', user_id: ME, team_id: 'T1' });
    if (method === 'users.list')
      return respond({ ok: true, members: [{ id: OTHER, real_name: 'Colleague' }] });
    if (method === 'search.messages') {
      const matches =
        params.count === '1' ? [{ channel: { id: channel, name: 'ezat_claudio' } }] : [];
      return respond({
        ok: true,
        messages: { matches, total: matches.length, paging: { pages: 1 } },
      });
    }
    if (method === 'conversations.history') {
      const index = params.cursor ? Number(params.cursor.replace('page-', '')) : 0;
      const next = index + 1 < pages.length ? `page-${index + 1}` : '';
      const payload = {
        ok: true,
        messages: (pages[index] || []).filter((message) => message.ts >= params.oldest),
        has_more: Boolean(next),
        response_metadata: { next_cursor: next },
      };
      const held = heldHistory;
      heldHistory = null;
      if (held) await held;
      return respond(payload);
    }
    if (method === 'conversations.replies') {
      const held = heldReply;
      heldReply = null;
      if (held) await held;
      if (throttleReplies)
        return new Response(JSON.stringify({ ok: false, error: 'ratelimited' }), {
          status: 429,
          headers: { 'Retry-After': '30' },
        });
      const candidate = pages.flat().find((item) => item.ts === params.ts);
      if (!candidate) return respond({ ok: false, error: 'thread_not_found' });
      if (replyResponse) return respond(replyResponse(params, candidate));
      const messages =
        replyMessages ||
        (candidate.latest_reply
          ? [candidate, reply(candidate.latest_reply, candidate.ts)]
          : [candidate]);
      return respond({ ok: true, messages, has_more: false, response_metadata: {} });
    }
    throw new Error(`unexpected Slack method ${method}`);
  };
  return {
    integration: createSlackIntegration({ paths, fs, fetchImpl, now: () => now }),
    calls,
    advance: (ms) => {
      now += ms;
    },
    setPages: (value) => {
      pages = value;
    },
    setThrottled: (value) => {
      throttleReplies = value;
    },
    setReplyMessages: (messages) => {
      replyMessages = messages;
    },
    setReplyResponse: (value) => {
      replyResponse = value;
    },
    replaceSession: () => {
      session = 'replacement';
    },
    setChannel: (value) => {
      channel = value;
    },
    holdNextHistory: () => {
      let release;
      heldHistory = new Promise((resolve) => {
        release = resolve;
      });
      return release;
    },
    holdNextReply: () => {
      let release;
      heldReply = new Promise((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}

async function flush() {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
}

const ids = (rows) => rows.map((row) => row.ts);

async function completeSixPages(f) {
  const first = await f.integration.threads();
  await flush();
  assert.equal(first.available, true);
  assert.ok(first.continuation, 'the first three pages leave bounded work');
  const continued = await f.integration.threads({ continuation: first.continuation });
  await flush();
  assert.equal(continued.available, true);
  return structuredClone(await f.integration.threads());
}

test('review: continued rows expire safely across a bounded refresh', async (t) => {
  const stable = Array.from({ length: 6 }, (_, index) => root(at(NOW - (index + 1) * 1000)));
  const expiring = root(at(NOW - WINDOW + 300_000));
  const pages = stable.map((item, index) => (index === 5 ? [item, expiring] : [item]));
  const f = fixture(pages);
  const loaded = await completeSixPages(f);
  assert.deepEqual(
    new Set(ids(loaded.started)),
    new Set([...stable, expiring].map((item) => item.ts)),
  );

  f.advance(300_001);
  const stale = structuredClone(await f.integration.threads());
  await flush();
  const refreshed = structuredClone(await f.integration.threads());
  assert.deepEqual(new Set(ids(stale.started)), new Set(stable.map((item) => item.ts)));
  assert.equal(refreshed.partial, true, 'the refresh has more history than its page budget');
  assert.ok(!ids(refreshed.started).includes(expiring.ts), 'expired rows stay excluded');
  assert.ok(
    ids(refreshed.started).every((ts) => stable.some((item) => item.ts === ts)),
    'every returned row belongs to the eligible set',
  );
  if (refreshed.started.length < stable.length)
    assert.ok(
      refreshed.stale ||
        refreshed.continuation ||
        refreshed.partialReasons.includes('bounded_work_remaining'),
      'remaining coverage is disclosed',
    );
  t.diagnostic(
    `Eligible continued rows: ${stale.started.length} before refresh, ${refreshed.started.length} after`,
  );
});

test('review: session replacement cannot reuse continuation-loaded rows', async () => {
  const stable = Array.from({ length: 6 }, (_, index) => root(at(NOW - (index + 1) * 1000)));
  const f = fixture(stable.map((item) => [item]));
  const loaded = await completeSixPages(f);
  assert.equal(loaded.started.length, stable.length);
  f.advance(300_001);
  const release = f.holdNextHistory();
  try {
    const before = f.calls.length;
    await f.integration.threads();
    await flush();
    assert.ok(
      f.calls.slice(before).some((call) => call.method === 'conversations.history'),
      'the old-session refresh is in flight',
    );
    f.setPages([]);
    f.replaceSession();
    const replacement = await f.integration.threads();
    await flush();
    assert.equal(replacement.available, true);
    assert.deepEqual(replacement.started, [], 'old-session rows do not cross generations');
  } finally {
    release();
  }
  await flush();
  const afterOldRefresh = await f.integration.threads();
  assert.equal(afterOldRefresh.available, true);
  assert.deepEqual(
    afterOldRefresh.started,
    [],
    'the late old refresh cannot repaint the new session',
  );
});

test('review: throttled refresh preserves unchanged verified activity and recovers', async () => {
  const stable = root(at(NOW - 30_000), at(NOW - 1000));
  const newRoot = root(at(NOW - 20_000), at(NOW - 500));
  const f = fixture([[stable]]);
  await f.integration.threads();
  await flush();
  const before = structuredClone(await f.integration.threads()).started[0];
  assert.equal(before.activityTs, stable.latest_reply);
  assert.equal(before.latestReplyBy.id, OTHER);
  assert.equal(before.needsReply, true);

  f.setPages([[stable, newRoot]]);
  f.setThrottled(true);
  f.advance(300_001);
  const beforeRefreshCalls = f.calls.length;
  await f.integration.threads();
  await flush();
  const failed = structuredClone(await f.integration.threads());
  const failedRow = failed.started.find((row) => row.ts === stable.ts);
  const replyAttempts = f.calls
    .slice(beforeRefreshCalls)
    .filter((call) => call.method === 'conversations.replies');
  assert.ok(replyAttempts.length, 'a reply request receives the synthetic HTTP 429');

  f.setThrottled(false);
  f.advance(30_001);
  if (failed.continuation) {
    await f.integration.threads({ continuation: failed.continuation });
  } else {
    f.advance(300_001);
    await f.integration.threads();
  }
  await flush();
  const recovered = structuredClone(await f.integration.threads());
  const recoveredRow = recovered.started.find((row) => row.ts === stable.ts);

  assert.equal(recoveredRow.activityTs, stable.latest_reply);
  assert.equal(recoveredRow.latestReplyBy.id, OTHER);
  assert.equal(recoveredRow.needsReply, true);
  assert.ok(failedRow, 'the verified root remains visible');
  assert.ok(
    failed.stale ||
      failed.partialReasons.some(
        (reason) => reason === 'reply_unavailable' || reason === 'refresh_failed',
      ),
    'the failed refresh or enrichment is disclosed beyond generic search uncertainty',
  );
  assert.deepEqual(
    {
      activityTs: failedRow.activityTs,
      latestReplyBy: failedRow.latestReplyBy,
      needsReply: failedRow.needsReply,
    },
    {
      activityTs: before.activityTs,
      latestReplyBy: before.latestReplyBy,
      needsReply: before.needsReply,
    },
    'a failed reply read must not replace matching last-good activity with unknown',
  );
});

test('review: a changed full latest timestamp cannot reuse old verified reply state', async () => {
  const rootTs = at(NOW - 30_000);
  const first = root(rootTs, at(NOW - 1000, 100));
  const changed = root(rootTs, at(NOW - 1000, 900));
  const f = fixture([[first]]);
  await f.integration.threads();
  await flush();
  const before = structuredClone(await f.integration.threads()).started[0];
  assert.equal(before.activityTs, first.latest_reply);
  assert.equal(before.needsReply, true);

  f.setPages([[changed]]);
  f.setThrottled(true);
  f.advance(300_001);
  await f.integration.threads();
  await flush();
  const after = structuredClone(await f.integration.threads()).started[0];
  assert.ok(after, 'the eligible root remains visible');
  assert.equal(after.activityTs, null);
  assert.equal(after.latestReplyBy, null);
  assert.equal(after.needsReply, null);
});

test('review: equivalent full timestamps can reuse verified activity during throttling', async () => {
  const first = root(at(NOW - 30_000), at(NOW - 1000));
  const equivalent = { ...first, latest_reply: first.latest_reply.replace(/0+$/, '') + '0' };
  const f = fixture([[first]]);
  await f.integration.threads();
  await flush();
  assert.equal((await f.integration.threads()).started[0].needsReply, true);

  f.setPages([[equivalent]]);
  f.setThrottled(true);
  f.advance(300_001);
  await f.integration.threads();
  await flush();
  const result = await f.integration.threads();
  assert.equal(result.started[0].activityTs, equivalent.latest_reply);
  assert.equal(result.started[0].latestReplyBy.id, OTHER);
  assert.equal(result.started[0].needsReply, true);
  assert.ok(result.partialReasons.includes('reply_activity_stale'));
});

test('review: a conflicting latest author on a partial page invalidates the fallback', async () => {
  const candidate = root(at(NOW - 30_000), at(NOW - 1000));
  const f = fixture([[candidate]]);
  await f.integration.threads();
  await flush();
  assert.equal((await f.integration.threads()).started[0].needsReply, true);

  f.setReplyResponse((params) =>
    params.cursor
      ? new Response(JSON.stringify({ ok: false, error: 'ratelimited' }), {
          status: 429,
          headers: { 'Retry-After': '30' },
        })
      : {
          ok: true,
          messages: [candidate, reply(candidate.latest_reply, candidate.ts, ME)],
          has_more: true,
          response_metadata: { next_cursor: 'reply-1' },
        },
  );
  const release = f.holdNextReply();
  try {
    f.advance(300_001);
    await f.integration.threads();
    await flush();
    const pending = await f.integration.threads();
    assert.equal(pending.started[0].latestReplyBy.id, OTHER);
    assert.ok(pending.partialReasons.includes('reply_activity_stale'));
  } finally {
    release();
  }
  await flush();
  const result = await f.integration.threads();
  assert.equal(result.started[0].activityTs, null);
  assert.equal(result.started[0].latestReplyBy, null);
  assert.equal(result.started[0].needsReply, null);
  assert.ok(result.partialReasons.includes('reply_unavailable'));
  assert.ok(!result.partialReasons.includes('reply_activity_stale'));
});

test('review: a matching latest author on a partial page retains the stale fallback', async () => {
  const candidate = root(at(NOW - 30_000), at(NOW - 1000));
  const f = fixture([[candidate]]);
  await f.integration.threads();
  await flush();
  assert.equal((await f.integration.threads()).started[0].needsReply, true);

  f.setReplyResponse((params) =>
    params.cursor
      ? new Response(JSON.stringify({ ok: false, error: 'ratelimited' }), {
          status: 429,
          headers: { 'Retry-After': '30' },
        })
      : {
          ok: true,
          messages: [candidate, reply(candidate.latest_reply, candidate.ts)],
          has_more: true,
          response_metadata: { next_cursor: 'reply-1' },
        },
  );
  f.advance(300_001);
  await f.integration.threads();
  await flush();
  const result = await f.integration.threads();
  assert.equal(result.started[0].activityTs, candidate.latest_reply);
  assert.equal(result.started[0].latestReplyBy.id, OTHER);
  assert.equal(result.started[0].needsReply, true);
  assert.ok(result.partialReasons.includes('reply_unavailable'));
  assert.ok(result.partialReasons.includes('reply_activity_stale'));
});

for (const error of [
  'thread_not_found',
  'channel_not_found',
  'not_in_channel',
  'missing_scope',
  'invalid_auth',
  'token_revoked',
]) {
  test(`review: ${error} invalidates prior activity across later throttling`, async () => {
    const candidate = root(at(NOW - 30_000), at(NOW - 1000));
    const f = fixture([[candidate]]);
    await f.integration.threads();
    await flush();
    assert.equal((await f.integration.threads()).started[0].needsReply, true);

    f.setReplyResponse(() => ({ ok: false, error }));
    f.advance(300_001);
    await f.integration.threads();
    await flush();
    let result = await f.integration.threads();
    assert.equal(result.started[0].activityTs, null);
    assert.equal(result.started[0].latestReplyBy, null);
    assert.equal(result.started[0].needsReply, null);
    assert.ok(result.partialReasons.includes('reply_unavailable'));
    assert.ok(!result.partialReasons.includes('reply_activity_stale'));

    f.setThrottled(true);
    f.advance(300_001);
    await f.integration.threads();
    await flush();
    result = await f.integration.threads();
    assert.equal(result.started[0].activityTs, null);
    assert.equal(result.started[0].latestReplyBy, null);
    assert.equal(result.started[0].needsReply, null);
    assert.ok(!result.partialReasons.includes('reply_activity_stale'));

    f.setThrottled(false);
    f.setReplyResponse(null);
    f.advance(30_001);
    assert.ok(result.continuation);
    await f.integration.threads({ continuation: result.continuation });
    await flush();
    const recovered = await f.integration.threads();
    assert.equal(recovered.started[0].activityTs, candidate.latest_reply);
    assert.equal(recovered.started[0].latestReplyBy.id, OTHER);
    assert.equal(recovered.started[0].needsReply, true);
    assert.ok(!recovered.partialReasons.includes('reply_activity_stale'));
  });
}

test('review: a changed reply count cannot reuse old verified reply state', async () => {
  const first = root(at(NOW - 30_000), at(NOW - 1000));
  const changed = { ...first, reply_count: 2 };
  const f = fixture([[first]]);
  await f.integration.threads();
  await flush();
  assert.equal((await f.integration.threads()).started[0].needsReply, true);

  f.setPages([[changed]]);
  f.setThrottled(true);
  f.advance(300_001);
  await f.integration.threads();
  await flush();
  const row = (await f.integration.threads()).started[0];
  assert.equal(row.activityTs, null);
  assert.equal(row.latestReplyBy, null);
  assert.equal(row.needsReply, null);
});

test('review: an expired verified root cannot be restored by a refresh', async () => {
  const candidate = root(at(NOW - WINDOW + 300_000), at(NOW - 1000));
  const f = fixture([[candidate]]);
  await f.integration.threads();
  await flush();
  assert.equal((await f.integration.threads()).started[0].needsReply, true);

  f.advance(300_001);
  const callCount = f.calls.length;
  await f.integration.threads();
  await flush();
  assert.deepEqual((await f.integration.threads()).started, []);
  assert.ok(
    !f.calls
      .slice(callCount)
      .some((call) => call.method === 'conversations.replies' && call.params.ts === candidate.ts),
  );
});

test('review: a replacement session cannot reuse matching verified activity', async () => {
  const candidate = root(at(NOW - 30_000), at(NOW - 1000));
  const f = fixture([[candidate]]);
  await f.integration.threads();
  await flush();
  assert.equal((await f.integration.threads()).started[0].needsReply, true);

  f.replaceSession();
  f.setThrottled(true);
  await f.integration.threads();
  await flush();
  const row = (await f.integration.threads()).started[0];
  assert.equal(row.activityTs, null);
  assert.equal(row.latestReplyBy, null);
  assert.equal(row.needsReply, null);
});

test('review: a replacement channel cannot reuse matching verified activity', async () => {
  const candidate = root(at(NOW - 30_000), at(NOW - 1000));
  const f = fixture([[candidate]]);
  await f.integration.threads();
  await flush();
  assert.equal((await f.integration.threads()).started[0].needsReply, true);

  f.setChannel('C0OTHER001');
  f.setThrottled(true);
  f.advance(600_001);
  await f.integration.threads();
  await flush();
  const result = await f.integration.threads();
  assert.equal(result.channel.id, 'C0OTHER001');
  assert.equal(result.started[0].activityTs, null);
  assert.equal(result.started[0].latestReplyBy, null);
  assert.equal(result.started[0].needsReply, null);
});

test('review: repeated throttled refreshes retain only the same verified activity', async () => {
  const candidate = root(at(NOW - 30_000), at(NOW - 1000));
  const f = fixture([[candidate]]);
  await f.integration.threads();
  await flush();
  assert.equal((await f.integration.threads()).started[0].needsReply, true);

  f.setThrottled(true);
  for (let attempt = 0; attempt < 2; attempt++) {
    f.advance(300_001);
    await f.integration.threads();
    await flush();
    const result = await f.integration.threads();
    assert.equal(result.started[0].activityTs, candidate.latest_reply);
    assert.equal(result.started[0].latestReplyBy.id, OTHER);
    assert.equal(result.started[0].needsReply, true);
    assert.ok(result.partialReasons.includes('reply_activity_stale'));
  }
});

test('review: an unverified prior scan cannot become a last-good fallback', async () => {
  const candidate = root(at(NOW - 30_000), at(NOW - 1000));
  const f = fixture([[candidate]]);
  f.setThrottled(true);
  await f.integration.threads();
  await flush();
  assert.equal((await f.integration.threads()).started[0].needsReply, null);

  f.advance(300_001);
  await f.integration.threads();
  await flush();
  const result = await f.integration.threads();
  assert.equal(result.started[0].activityTs, null);
  assert.equal(result.started[0].latestReplyBy, null);
  assert.equal(result.started[0].needsReply, null);
  assert.ok(!result.partialReasons.includes('reply_activity_stale'));
});

test('review: a matching reply from an incomplete prior scan cannot become a fallback', async () => {
  const candidate = root(at(NOW - 30_000), at(NOW - 1000));
  const f = fixture([[candidate]]);
  f.setReplyResponse((params) => ({
    ok: true,
    messages: params.cursor ? [] : [candidate, reply(candidate.latest_reply, candidate.ts)],
    has_more: true,
    response_metadata: { next_cursor: params.cursor ? 'reply-2' : 'reply-1' },
  }));
  await f.integration.threads();
  await flush();
  assert.equal((await f.integration.threads()).started[0].needsReply, null);

  f.setThrottled(true);
  f.advance(300_001);
  await f.integration.threads();
  await flush();
  const result = await f.integration.threads();
  assert.equal(result.started[0].activityTs, null);
  assert.equal(result.started[0].latestReplyBy, null);
  assert.equal(result.started[0].needsReply, null);
  assert.ok(!result.partialReasons.includes('reply_activity_stale'));
});

test('review: a newer observed reply prevents reuse of previous activity', async () => {
  const candidate = root(at(NOW - 30_000), at(NOW - 2000));
  const f = fixture([[candidate]]);
  await f.integration.threads();
  await flush();
  assert.equal((await f.integration.threads()).started[0].needsReply, true);

  f.setReplyMessages([
    candidate,
    reply(candidate.latest_reply, candidate.ts),
    reply(at(NOW - 1000), candidate.ts, ME),
  ]);
  f.advance(300_001);
  await f.integration.threads();
  await flush();
  const row = (await f.integration.threads()).started[0];
  assert.equal(row.activityTs, null);
  assert.equal(row.latestReplyBy, null);
  assert.equal(row.needsReply, null);
});

test('review: verified activity remains labelled stale while a refresh scan is pending', async () => {
  const candidate = root(at(NOW - 30_000), at(NOW - 1000));
  const f = fixture([[candidate]]);
  await f.integration.threads();
  await flush();
  assert.equal((await f.integration.threads()).started[0].needsReply, true);

  f.setReplyMessages([candidate, reply(candidate.latest_reply, candidate.ts, ME)]);
  const release = f.holdNextReply();
  try {
    f.advance(300_001);
    await f.integration.threads();
    await flush();
    const pending = structuredClone(await f.integration.threads());
    assert.equal(pending.started[0].activityTs, candidate.latest_reply);
    assert.equal(pending.started[0].latestReplyBy.id, OTHER);
    assert.equal(pending.started[0].needsReply, true);
    assert.ok(pending.partialReasons.includes('reply_activity_stale'));
  } finally {
    release();
  }
  await flush();
  const recovered = await f.integration.threads();
  assert.equal(recovered.started[0].latestReplyBy.id, ME);
  assert.equal(recovered.started[0].needsReply, false);
  assert.ok(!recovered.partialReasons.includes('reply_activity_stale'));
});
