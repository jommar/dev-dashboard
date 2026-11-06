import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpHandler } from '../backend/http-app.mjs';
import { createSlackIntegration, slackPaths } from '../backend/slack.mjs';

const NOW = Date.parse('2026-11-07T12:00:00.000Z');
const WINDOW = 28 * 24 * 60 * 60 * 1000;
const CHANNEL = 'C024BE91L';
const ME = 'U9';
const OTHER = 'U1';

function at(milliseconds) {
  const microseconds = BigInt(milliseconds) * 1000n;
  return `${microseconds / 1_000_000n}.${String(microseconds % 1_000_000n).padStart(6, '0')}`;
}

function micros(timestamp) {
  const [seconds, fraction = ''] = timestamp.split('.');
  return BigInt(seconds) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}

function root(timestamp, latest = timestamp) {
  return {
    ts: timestamp,
    thread_ts: timestamp,
    user: ME,
    text: 'TAP-1: synthetic thread',
    reply_count: latest === timestamp ? 0 : 1,
    ...(latest === timestamp ? {} : { latest_reply: latest }),
  };
}

function reply(timestamp, threadTs) {
  return { ts: timestamp, thread_ts: threadTs, user: OTHER, text: 'Reply <@U9>' };
}

function fixture({
  pages = Array.from({ length: 12 }, (_, i) => [root(at(NOW - (i + 1) * 1000))]),
  mentionPages = [],
  conversations = {},
} = {}) {
  let clock = NOW;
  let stored = session('original');
  let rateLimitStatus = null;
  const paths = slackPaths('/virtual-board-home');
  const calls = [];
  const fs = {
    lstatSync(file) {
      if (file === paths.session && !stored)
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return {
        isDirectory: () => file !== paths.session,
        isFile: () => file === paths.session,
        isSymbolicLink: () => false,
      };
    },
    chmodSync() {},
    readFileSync: () => stored,
    rmSync: () => {
      stored = '';
    },
  };

  function session(name) {
    return JSON.stringify({
      token: `xoxc-${name}`,
      cookie: `xoxd-${name}`,
      teamId: 'T0EXAMPLE1',
      teamDomain: 'example',
    });
  }

  const fetchImpl = async (url) => {
    const target = new URL(url);
    const method = target.pathname.split('/').pop();
    const params = Object.fromEntries(target.searchParams);
    calls.push({ method, params, at: clock });
    const response = (payload) => new Response(JSON.stringify(payload));

    if (method === 'auth.test')
      return response({ ok: true, user: 'testuser', user_id: ME, team_id: 'T0EXAMPLE1' });
    if (method === 'users.list')
      return response({ ok: true, members: [{ id: OTHER, real_name: 'Colleague' }] });
    if (method === 'client.counts')
      return response({
        ok: true,
        channels: [{ id: CHANNEL, mention_count: 1, has_unreads: true }],
      });
    if (method === 'conversations.list')
      return response({ ok: true, channels: [{ id: CHANNEL, name: 'ezat_claudio' }] });
    if (method === 'search.messages') {
      if (params.count === '1')
        return response({
          ok: true,
          messages: { total: 1, matches: [{ channel: { id: CHANNEL, name: 'ezat_claudio' } }] },
        });
      if ((params.query || '').includes(`<@${ME}>`) && mentionPages.length) {
        const page = Number(params.page || 1);
        const matches = mentionPages[page - 1] || [];
        const total = mentionPages.reduce((count, items) => count + items.length, 0);
        return response({
          ok: true,
          messages: {
            total,
            matches,
            paging: { count: 100, page, pages: mentionPages.length, total },
          },
        });
      }
      return response({ ok: true, messages: { total: 0, matches: [], paging: { pages: 1 } } });
    }
    if (method === 'conversations.history') {
      if (rateLimitStatus !== null) {
        const status = rateLimitStatus;
        rateLimitStatus = null;
        return new Response(
          JSON.stringify({ ok: false, error: status === 429 ? 'other_error' : 'ratelimited' }),
          {
            status,
            headers: { 'Retry-After': '30' },
          },
        );
      }
      const index = params.cursor ? Number(params.cursor.replace('history-', '')) : 0;
      const messages = (pages[index] || []).filter(
        (message) => !params.oldest || micros(message.ts) >= micros(params.oldest),
      );
      const next = index + 1 < pages.length ? `history-${index + 1}` : '';
      return response({
        ok: true,
        messages,
        has_more: Boolean(next),
        response_metadata: { next_cursor: next },
      });
    }
    if (method === 'conversations.replies') {
      const candidate = pages.flat().find((item) => item.ts === params.ts);
      if (!candidate) return response({ ok: false, error: 'thread_not_found' });
      const messages = conversations[candidate.ts] || [candidate];
      if (!conversations[candidate.ts] && candidate.latest_reply)
        messages.push(reply(candidate.latest_reply, candidate.ts));
      const filtered = messages.filter(
        (message) =>
          (!params.oldest || micros(message.ts) >= micros(params.oldest)) &&
          (!params.latest || micros(message.ts) <= micros(params.latest)),
      );
      const offset = params.cursor ? Number(params.cursor.replace('reply-', '')) : 0;
      const limit = Number(params.limit || 100);
      const next = offset + limit < filtered.length ? `reply-${offset + limit}` : '';
      return response({
        ok: true,
        messages: filtered.slice(offset, offset + limit),
        has_more: Boolean(next),
        response_metadata: { next_cursor: next },
      });
    }
    return response({ ok: false, error: 'unknown_method' });
  };

  return {
    integration: createSlackIntegration({ paths, fs, fetchImpl, now: () => clock }),
    calls,
    named: (method) => calls.filter((entry) => entry.method === method),
    advance: (milliseconds) => {
      clock += milliseconds;
    },
    replaceSession: () => {
      stored = session('replacement');
    },
    restoreSession: () => {
      stored = session('original');
    },
    rateLimitNextHistory: (status) => {
      rateLimitStatus = status;
    },
  };
}

async function flush() {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
}

const ids = (rows) => rows.map((row) => row.ts);

async function initialPage(f) {
  const result = await f.integration.threads();
  await flush();
  assert.equal(result.available, true, `initial listing failed: ${JSON.stringify(f.calls)}`);
  assert.equal(result.partial, true);
  assert.equal(typeof result.continuation, 'string', 'the continuation is an opaque string');
  assert.ok(result.continuation.length > 0);
  return result;
}

test('board continuation: advances bounded work and merges previously loaded eligible rows', async () => {
  const f = fixture();
  const first = await initialPage(f);
  const before = f.named('conversations.history').length;
  const previous = new Set(ids(first.started));
  const continued = await f.integration.threads({ continuation: first.continuation });
  await flush();
  const after = f.named('conversations.history').length;

  assert.equal(continued.available, true);
  assert.ok(before > 0 && before < 12, 'the first load stops within its work budget');
  assert.ok(after > before && after - before < 12, 'continuation advances bounded work');
  const merged = ids(continued.started);
  assert.ok(
    [...previous].every((id) => merged.includes(id)),
    'earlier eligible rows remain',
  );
  assert.ok(
    merged.some((id) => !previous.has(id)),
    'new eligible rows are added',
  );
  assert.equal(new Set(merged).size, merged.length, 'the merged rows are deduplicated');
});

test('board continuation: invalid tokens are unavailable without fetching', async () => {
  const f = fixture();
  const before = f.calls.length;
  const result = await f.integration.threads({ continuation: 'not-a-valid-continuation' });
  await flush();
  assert.equal(result.available, false);
  assert.equal(f.calls.length, before, 'invalid continuation does not call Slack');
});

test('board continuation: an expired token is removed and a fresh snapshot can replace it', async () => {
  const f = fixture();
  const first = await initialPage(f);
  f.advance(9 * 60_000);
  const continued = await f.integration.threads({ continuation: first.continuation });
  await flush();
  const token = continued.continuation;
  assert.ok(token);
  const before = f.calls.length;
  f.advance(60_001);
  assert.equal((await f.integration.threads({ continuation: token })).available, false);
  assert.equal(f.calls.length, before, 'an expired token cannot resume old work');
  const expired = await f.integration.threads();
  assert.equal(expired.continuation, null);
  assert.ok(expired.partialReasons.includes('continuation_expired'));
  await flush();
  const refreshed = await f.integration.threads();
  await flush();
  assert.ok(refreshed.continuation);
  assert.notEqual(refreshed.continuation, token);
});

for (const mode of ['replacement', 'disconnect and reconnect']) {
  test(`board continuation: ${mode} invalidates prior-session tokens without fetching`, async () => {
    const f = fixture();
    const first = await initialPage(f);
    if (mode === 'replacement') f.replaceSession();
    else {
      f.integration.disconnect();
      f.restoreSession();
    }
    const before = f.calls.length;
    const result = await f.integration.threads({ continuation: first.continuation });
    await flush();
    assert.equal(result.available, false);
    assert.equal(f.calls.length, before, 'a previous generation cannot resume Slack work');
  });
}

test('board continuation: expiry removes merged rows while cursor bounds advance', async () => {
  const stable = { ...root(at(NOW - 10_000), at(NOW - 1500)), reply_count: 201 };
  const expiring = root(at(NOW - WINDOW + 1000), at(NOW - 1000));
  const pages = [
    [stable, expiring],
    ...Array.from({ length: 11 }, (_, i) => [root(at(NOW - WINDOW + 999 - i))]),
  ];
  const messages = Array.from({ length: 200 }, (_, i) => reply(at(NOW - 3000 + i), stable.ts));
  const hit = (message) => ({
    ...message,
    channel: { id: CHANNEL, name: 'ezat_claudio' },
    permalink: `https://example.slack.com/archives/${CHANNEL}/p${message.ts.replace('.', '')}?thread_ts=${message.thread_ts}&cid=${CHANNEL}`,
  });
  const expiredHit = hit(reply(expiring.latest_reply, expiring.ts));
  const f = fixture({
    pages,
    mentionPages: [messages.slice(0, 100).map(hit), messages.slice(100).map(hit), [expiredHit]],
    conversations: { [stable.ts]: [stable, ...messages, reply(stable.latest_reply, stable.ts)] },
  });
  const first = await initialPage(f);
  assert.ok(ids(first.started).includes(expiring.ts), 'the candidate starts eligible');
  assert.ok(
    !f
      .named('search.messages')
      .some((call) => call.params.page === '3' && call.params.query.includes(`<@${ME}>`)),
    'the expiring search candidate remains for continuation',
  );
  f.advance(1000);
  assert.ok(
    ids((await f.integration.threads()).started).includes(expiring.ts),
    'equality is eligible',
  );
  await flush();
  const firstCallCount = f.calls.length;
  f.advance(1);

  let token = first.continuation;
  for (let i = 0; i < 12 && token; i++) {
    const continued = await f.integration.threads({ continuation: token });
    await flush();
    assert.equal(continued.available, true);
    assert.ok(ids(continued.started).includes(stable.ts), 'still-eligible rows remain');
    assert.ok(!ids(continued.started).includes(expiring.ts), 'expired merged rows are removed');
    assert.ok(!ids(continued.mentions).includes(expiring.ts), 'expired mention rows are removed');
    token = continued.continuation;
    if (
      f
        .named('search.messages')
        .some((call) => call.params.page === '3' && call.params.query.includes(`<@${ME}>`))
    )
      break;
  }
  const laterCalls = f.calls.slice(firstCallCount);
  assert.ok(laterCalls.some((call) => call.method === 'conversations.history'));
  assert.ok(
    laterCalls.some(
      (call) =>
        call.method === 'search.messages' &&
        call.params.page === '3' &&
        call.params.query.includes(`<@${ME}>`),
    ),
    'continuation encounters the recent hit belonging to the now-expired root',
  );
  assert.ok(
    !laterCalls.some(
      (call) => call.method === 'conversations.replies' && call.params.ts === expiring.ts,
    ),
    'an expired candidate is never targeted',
  );
  for (const call of f.named('conversations.history')) {
    assert.ok(call.params.oldest, 'every page is bounded');
    assert.equal(
      micros(call.params.oldest),
      micros(at(call.at - WINDOW)),
      'each cursor request uses its current cutoff',
    );
    assert.equal(call.params.inclusive, 'true');
  }
});

test('board continuation: HTTP query forwards the token and returns the advanced merged listing', async () => {
  const f = fixture();
  const handler = createHttpHandler({
    settings: {},
    manager: {},
    integrations: {
      slack: f.integration,
      slackWatchStore: {},
      claudeSessions: {},
      slackWatcher: { isDisabled: () => true, stop() {} },
    },
  });
  async function get(url) {
    let status;
    let body;
    const res = {
      writeHead(value) {
        status = value;
      },
      end(value) {
        body = JSON.parse(value);
      },
    };
    await handler({ method: 'GET', url, headers: { host: 'localhost' }, socket: {} }, res);
    return { status, body };
  }

  try {
    const first = await get('/api/slack/threads');
    await flush();
    assert.equal(first.status, 200);
    assert.equal(typeof first.body.continuation, 'string');
    const before = f.named('conversations.history').length;
    const next = await get(
      `/api/slack/threads?continuation=${encodeURIComponent(first.body.continuation)}`,
    );
    await flush();
    assert.equal(next.status, 200);
    assert.equal(next.body.available, true);
    assert.ok(f.named('conversations.history').length > before, 'the query advances work');
    assert.ok(ids(first.body.started).every((id) => ids(next.body.started).includes(id)));
    assert.ok(ids(next.body.started).some((id) => !ids(first.body.started).includes(id)));
    assert.ok(next.body.started.every((row) => row.attachedSessions === 0));
  } finally {
    handler.close();
  }
});

for (const status of [429, 200]) {
  test(`board continuation: Retry-After on ${status === 429 ? 'HTTP 429' : 'Slack ratelimited'} blocks only its method until the deadline`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture();
    const first = await initialPage(f);
    const before = f.named('conversations.history').length;
    f.rateLimitNextHistory(status);

    function track(promise) {
      const state = { settled: false, value: undefined };
      promise.then(
        (value) => {
          state.settled = true;
          state.value = value;
        },
        (error) => {
          state.settled = true;
          state.value = { error };
        },
      );
      return state;
    }
    const limited = track(f.integration.threads({ continuation: first.continuation }));
    await flush();
    assert.equal(
      f.named('conversations.history').length,
      before + 1,
      'Slack returned the rate limit',
    );
    let token = limited.value?.continuation || first.continuation;
    let retry;
    if (limited.settled) {
      assert.equal(
        limited.value?.partial,
        true,
        'the interrupted listing reports partial coverage',
      );
      assert.equal(typeof limited.value?.continuation, 'string', 'remaining work stays resumable');
      retry = track(f.integration.threads({ continuation: token }));
      await flush();
    }
    assert.equal(f.named('conversations.history').length, before + 1, 'no immediate retry storm');

    const badge = track(f.integration.pending());
    await flush();
    assert.equal(badge.settled, true, 'the independent client.counts method is not stalled');
    assert.equal(badge.value.available, true);
    assert.equal(f.named('client.counts').length, 1);

    f.advance(29_999);
    t.mock.timers.tick(29_999);
    await flush();
    assert.equal(
      f.named('conversations.history').length,
      before + 1,
      'the deadline has not elapsed',
    );
    token = retry?.value?.continuation || limited.value?.continuation || token;
    f.advance(1);
    t.mock.timers.tick(1);
    await flush();
    if (
      f.named('conversations.history').length === before + 1 &&
      (retry?.settled || (!retry && limited.settled))
    ) {
      track(f.integration.threads({ continuation: token }));
      await flush();
    }
    assert.ok(f.named('conversations.history').length > before + 1, 'work resumes at the deadline');
    assert.ok(
      f
        .named('conversations.history')
        .slice(before + 1)
        .every((call) => call.at >= NOW + 30_000),
    );
  });
}
