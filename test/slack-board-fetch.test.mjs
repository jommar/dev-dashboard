import test from 'node:test';
import assert from 'node:assert/strict';
import { createSlackIntegration, slackPaths } from '../backend/slack.mjs';
import { withAttachedSessions } from '../backend/slack-model.mjs';
import { threadsByTicket } from '../ui/slack-ticket-links.js';

const NOW = Date.parse('2026-11-07T12:00:00.000Z');
const WINDOW = 28 * 24 * 60 * 60 * 1000;
const CHANNEL = 'C024BE91L';
const TEAM = 'T0EXAMPLE1';
const ME = 'U9';
const OTHER = 'U1';
const SEARCH_DATE = new Date(NOW - WINDOW).toISOString().slice(0, 10);

// Slack timestamps are integer microseconds; keep boundary cases exact.
function ts(microseconds) {
  const value = BigInt(microseconds);
  return `${value / 1_000_000n}.${String(value % 1_000_000n).padStart(6, '0')}`;
}
const at = (milliseconds, microseconds = 0) =>
  ts(BigInt(milliseconds) * 1000n + BigInt(microseconds));
const timeOf = (value) => {
  const [seconds, fraction = ''] = String(value).split('.');
  return BigInt(seconds) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
};

function root(timestamp, { user = ME, text = 'TAP-1: synthetic thread', latest = timestamp } = {}) {
  return {
    ts: timestamp,
    thread_ts: timestamp,
    user,
    text,
    reply_count: latest === timestamp ? 0 : 1,
    ...(latest === timestamp ? {} : { latest_reply: latest }),
  };
}

function reply(timestamp, threadTs, { user = OTHER, text = 'A reply' } = {}) {
  return { ts: timestamp, thread_ts: threadTs, user, text };
}

function hit(message, { threadTs = message.thread_ts, permalinkTs = threadTs } = {}) {
  return {
    ...message,
    ...(threadTs === undefined ? {} : { thread_ts: threadTs }),
    channel: { id: CHANNEL, name: 'ezat_claudio' },
    ...(permalinkTs === undefined
      ? {}
      : {
          permalink: `https://example.slack.com/archives/${CHANNEL}/p${message.ts.replace('.', '')}?thread_ts=${permalinkTs}&cid=${CHANNEL}`,
        }),
  };
}

// No disk, network or real credential access. Both fs and fetch are injected.
function fixture({ historyPages, searchPages, mentionPages, conversations = {}, override } = {}) {
  let clock = NOW;
  let stored = JSON.stringify({
    token: 'xoxc-synthetic',
    cookie: 'xoxd-synthetic',
    teamId: TEAM,
    teamDomain: 'example',
  });
  const paths = slackPaths('/virtual-board-home');
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
  const calls = [];
  const pages = historyPages || [{ messages: [] }];
  const named = (method) => calls.filter((entry) => entry.method === method);
  const asResponse = (payload) =>
    payload instanceof Response ? payload : new Response(JSON.stringify(payload));
  const fetchImpl = async (url, init) => {
    const target = new URL(url);
    const method = target.pathname.split('/').pop();
    const params = Object.fromEntries(target.searchParams);
    const entry = { method, params, at: clock, authorization: init.headers.Authorization };
    calls.push(entry);
    const custom = await override?.(entry);
    if (custom !== undefined) return asResponse(custom);

    if (method === 'auth.test')
      return asResponse({ ok: true, user: 'testuser', user_id: ME, team_id: TEAM });
    if (method === 'users.list')
      return asResponse({ ok: true, members: [{ id: OTHER, real_name: 'Colleague' }] });
    if (method === 'client.counts')
      return asResponse({
        ok: true,
        channels: [{ id: CHANNEL, mention_count: 1, has_unreads: true }],
      });
    if (method === 'conversations.list')
      return asResponse({ ok: true, channels: [{ id: CHANNEL, name: 'ezat_claudio' }] });
    if (method === 'conversations.history') {
      const index = params.cursor ? Number(params.cursor.replace('history-', '')) : 0;
      const page = pages[index] || { messages: [] };
      // Unless deliberately overridden, Slack honors its inclusive oldest bound.
      const messages = (page.messages || []).filter((message) => {
        if (!params.oldest) return true;
        try {
          return timeOf(message.ts) >= timeOf(params.oldest);
        } catch {
          return false;
        }
      });
      return asResponse({
        ok: true,
        messages,
        has_more: Boolean(page.hasMore || page.next),
        response_metadata: { next_cursor: page.next || '' },
      });
    }
    if (method === 'search.messages') {
      // The one-result, unbounded channel lookup is explicitly allowed to find metadata only.
      if (params.count === '1')
        return asResponse({
          ok: true,
          messages: { total: 1, matches: [{ channel: { id: CHANNEL, name: 'ezat_claudio' } }] },
        });
      const selected = (params.query || '').includes(`<@${ME}>`) ? mentionPages : searchPages;
      const page = selected?.[Number(params.page || 1) - 1] || { matches: [], total: 0 };
      return asResponse({
        ok: true,
        messages: {
          total: page.total ?? page.matches.length,
          matches: page.matches,
          paging: {
            count: 100,
            page: Number(params.page || 1),
            pages: page.pages || 1,
            total: page.total ?? page.matches.length,
          },
        },
      });
    }
    if (method === 'conversations.replies') {
      const messages = conversations[params.ts];
      if (!messages) return asResponse({ ok: false, error: 'thread_not_found' });
      const filtered = messages.filter((message) => {
        if (params.oldest && timeOf(message.ts) < timeOf(params.oldest)) return false;
        if (params.latest && timeOf(message.ts) > timeOf(params.latest)) return false;
        return true;
      });
      // Slack returns the earliest messages first, not root plus the latest for limit=1.
      const limit = Number(params.limit || 100);
      const offset = params.cursor ? Number(params.cursor.replace('reply-', '')) : 0;
      const next = offset + limit < filtered.length ? `reply-${offset + limit}` : '';
      return asResponse({
        ok: true,
        messages: filtered.slice(offset, offset + limit),
        has_more: Boolean(next),
        response_metadata: { next_cursor: next },
      });
    }
    return asResponse({ ok: false, error: 'unknown_method' });
  };
  return {
    integration: createSlackIntegration({ paths, fs, fetchImpl, now: () => clock }),
    calls,
    named,
    advance: (milliseconds) => {
      clock += milliseconds;
    },
    replaceSession: () => {
      stored = JSON.stringify({
        token: 'xoxc-replacement',
        cookie: 'xoxd-replacement',
        teamId: TEAM,
      });
    },
  };
}

// Let background reply enrichment settle without wall-clock sleeps.
async function flush() {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
}
const ids = (rows) => rows.map((row) => row.ts);

function assertCoverageReason(value) {
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== 'object') continue;
    for (const [key, detail] of Object.entries(item)) {
      if (
        /reason/i.test(key) &&
        (typeof detail === 'string' ? detail.length : Array.isArray(detail) && detail.length)
      )
        return;
      if (detail && typeof detail === 'object') pending.push(detail);
    }
  }
  assert.fail('partial coverage includes at least one reason');
}

test('board scope: creation cutoff includes equality and excludes a root one microsecond older', async () => {
  const exact = at(NOW - WINDOW);
  const outside = ts(timeOf(exact) - 1n);
  const inside = ts(timeOf(exact) + 1n);
  const recent = at(NOW - 1000);
  const exactRoot = root(exact, { latest: recent });
  const insideRoot = root(inside, { latest: recent });
  const outsideRoot = root(outside, { latest: recent });
  const f = fixture({
    historyPages: [{ messages: [insideRoot, exactRoot, outsideRoot] }],
    conversations: {
      [exact]: [exactRoot, reply(recent, exact)],
      [inside]: [insideRoot, reply(recent, inside)],
      [outside]: [outsideRoot, reply(recent, outside)],
    },
  });
  const result = await f.integration.threads();
  await flush();
  assert.equal(result.available, true);
  assert.deepEqual(new Set(ids(result.started)), new Set([exact, inside]));
  assert.ok(
    !f.named('conversations.replies').some((call) => call.params.ts === outside),
    'an old root is never read even with a recent reply',
  );
});

test('board scope: creation cutoff discards an old search hit before any targeted read', async () => {
  const old = at(NOW - WINDOW - 1);
  const recent = at(NOW - 1000);
  const oldRoot = root(old, { user: OTHER, latest: recent });
  const mention = hit(reply(recent, old, { text: 'Recent ping <@U9>' }));
  const f = fixture({
    mentionPages: [{ matches: [mention], total: 1 }],
    searchPages: [{ matches: [mention], total: 1 }],
    conversations: { [old]: [oldRoot, mention] },
  });
  const result = await f.integration.threads();
  await flush();
  assert.equal(result.available, true);
  assert.ok(
    !f.named('conversations.replies').some((call) => call.params.ts === old),
    'search hits cannot authorize a targeted old-root read',
  );
  assert.ok(!ids(result.mentions).includes(old));
  assert.ok(!ids(result.started).includes(old));
});

test('board scope: creation cutoff rejects an ambiguous search result instead of guessing its own ts', async () => {
  const recent = at(NOW - 2000);
  const ambiguous = {
    ts: recent,
    user: OTHER,
    text: 'Ping <@U9>',
    channel: { id: CHANNEL, name: 'ezat_claudio' },
  };
  const guessed = root(recent, { user: OTHER });
  const f = fixture({
    mentionPages: [{ matches: [ambiguous], total: 1 }],
    conversations: { [recent]: [guessed] },
  });
  const result = await f.integration.threads();
  await flush();
  assert.ok(
    !f.named('conversations.replies').some((call) => call.params.ts === recent),
    'a match timestamp alone is not root identity',
  );
  assert.equal(result.mentions.length, 0);
  assert.equal(result.partial, true, 'the uninspectable hit is disclosed');
  assert.ok(result.partialReasons.includes('ambiguous_search_result'));
});

test('board scope: an unmarked history mention stays ambiguous and incomplete', async () => {
  const recent = at(NOW - 2000);
  const unmarked = { ts: recent, user: OTHER, text: 'TAP-1: Ping <@U9>' };
  const marked = root(at(NOW - 3000), { user: OTHER, text: 'TAP-1: Ping <@U9>' });
  const f = fixture({
    historyPages: [{ messages: [unmarked, marked] }],
    mentionPages: [{ matches: [hit(unmarked), hit(marked)], total: 2 }],
  });
  const result = await f.integration.threads();
  await flush();
  assert.deepEqual(ids(result.mentions), [marked.ts]);
  assert.equal(result.partial, true);
  assert.ok(result.partialReasons.includes('ambiguous_search_result'));
  const sharedResult = withAttachedSessions(result, {});
  assert.equal(sharedResult.partial, true);
  assert.ok(sharedResult.partialReasons.includes('ambiguous_search_result'));
  assert.ok(!f.named('conversations.replies').some((call) => call.params.ts === recent));

  const count = f.calls.length;
  assert.equal((await f.integration.thread(recent)).available, false);
  assert.equal(f.calls.length, count, 'the ambiguous hit cannot authorize a dialog read');
});

test('board scope: creation cutoff rejects contradictory search identity without targeted reads', async () => {
  const old = at(NOW - WINDOW - 1000);
  const eligible = at(NOW - 10000);
  const recent = at(NOW - 1000);
  const conflicting = hit(reply(recent, eligible, { text: '<@U9> ping' }), {
    threadTs: eligible,
    permalinkTs: old,
  });
  const f = fixture({
    mentionPages: [{ matches: [conflicting], total: 1 }],
    conversations: { [eligible]: [root(eligible)] },
  });
  const result = await f.integration.threads();
  await flush();
  assert.equal(
    f.named('conversations.replies').length,
    0,
    'conflicting root identifiers cannot authorize a lookup',
  );
  assert.equal(result.mentions.length, 0);
  assert.equal(result.partial, true);
});

test('board scope: malformed or mismatched permalink message identities cannot authorize reads', async () => {
  const rootTs = at(NOW - 30_000);
  const recent = at(NOW - 1000);
  const message = reply(recent, rootTs, { text: '<@U9> ping' });
  const malformed = hit(message);
  malformed.permalink = `https://example.slack.com/archives/${CHANNEL}/not-a-message?thread_ts=${rootTs}`;
  const mismatched = hit(message);
  mismatched.permalink = `https://example.slack.com/archives/${CHANNEL}/p${rootTs.replace('.', '')}?thread_ts=${rootTs}`;
  const impostor = hit(message);
  impostor.permalink = `https://example.invalid/archives/${CHANNEL}/p${recent.replace('.', '')}?thread_ts=${rootTs}`;
  const f = fixture({
    mentionPages: [{ matches: [malformed, mismatched, impostor], total: 3 }],
    conversations: { [rootTs]: [root(rootTs)] },
  });
  const result = await f.integration.threads();
  await flush();
  assert.equal(result.mentions.length, 0);
  assert.equal(f.named('conversations.replies').length, 0);
  assert.ok(result.partialReasons.includes('ambiguous_search_result'));
});

test('board scope: upstream and watcher binds every history page and listing search', async () => {
  const first = root(at(NOW - 1000));
  const second = root(at(NOW - 2000));
  const f = fixture({
    historyPages: [{ messages: [first], next: 'history-1' }, { messages: [second] }],
  });
  const result = await f.integration.threads();
  await flush();
  assert.equal(result.available, true);
  assert.deepEqual(new Set(ids(result.started)), new Set([first.ts, second.ts]));
  const history = f.named('conversations.history');
  assert.equal(history.length, 2);
  for (const call of history) {
    assert.ok(call.params.oldest, 'each page has a cutoff');
    assert.equal(
      timeOf(call.params.oldest),
      timeOf(at(call.at - WINDOW)),
      'each page uses its current exact cutoff',
    );
    assert.equal(call.params.inclusive, 'true');
  }
});

test('board scope: upstream and watcher date-bounds both listing search streams', async () => {
  const f = fixture();
  await f.integration.threads();
  await flush();
  const searches = f.named('search.messages').filter((call) => call.params.count !== '1');
  assert.ok(searches.length >= 2, 'both recent-message and mention streams run');
  assert.ok(searches.some((call) => call.params.query.includes(`<@${ME}>`)));
  assert.ok(searches.some((call) => !call.params.query.includes(`<@${ME}>`)));
  for (const call of searches)
    assert.match(call.params.query, new RegExp(`\\bafter:${SEARCH_DATE}\\b`));
});

test('board scope: upstream and watcher updates cursor bounds and expires roots between pages', async () => {
  const expiring = root(at(NOW - WINDOW + 1), { latest: at(NOW - 1000) });
  const stillEligible = root(at(NOW - 5000));
  const f = fixture({
    historyPages: [{ messages: [expiring], next: 'history-1' }, { messages: [stillEligible] }],
    override: ({ method, params }) => {
      if (method === 'conversations.history' && !params.cursor) {
        f.advance(2);
        return {
          ok: true,
          messages: [expiring],
          has_more: true,
          response_metadata: { next_cursor: 'history-1' },
        };
      }
    },
    conversations: { [expiring.ts]: [expiring, reply(expiring.latest_reply, expiring.ts)] },
  });
  const result = await f.integration.threads();
  await flush();
  assert.ok(
    !ids(result.started).includes(expiring.ts),
    'a root that expires mid-snapshot cannot be published',
  );
  assert.ok(
    !f.named('conversations.replies').some((call) => call.params.ts === expiring.ts),
    'no reply scan starts after expiry',
  );
  const next = f.named('conversations.history').find((call) => call.params.cursor === 'history-1');
  assert.ok(next, 'the next history page is requested');
  assert.ok(next.params.oldest);
  assert.equal(timeOf(next.params.oldest), timeOf(at(next.at - WINDOW)));
  assert.equal(next.params.inclusive, 'true');
});

test('board scope: upstream and watcher refuses an old dialog but preserves independent watcher reads', async () => {
  const old = at(NOW - WINDOW - 60_000);
  const recent = at(NOW - 1000);
  const oldRoot = root(old, { latest: recent });
  const f = fixture({ conversations: { [old]: [oldRoot, reply(recent, old)] } });
  const dialog = await f.integration.thread(old);
  assert.equal(dialog.available, false);
  assert.equal(f.calls.length, 0, 'the old dialog is refused before any Slack request');
  const watched = await f.integration.lastInThread({
    channelId: CHANNEL,
    threadTs: old,
    asOfTs: recent,
  });
  assert.equal(watched.ok, true, 'configured watcher may still read old threads');
  assert.equal(watched.last.ts, recent);
  assert.deepEqual(
    f.calls.map((call) => call.method),
    ['auth.test', 'conversations.replies'],
  );
});

test('board scope: a recent reply to an old root cannot be used as a dialog root', async () => {
  const old = at(NOW - WINDOW - 60_000);
  const recent = at(NOW - 1000);
  const oldRoot = root(old, { latest: recent });
  const recentReply = reply(recent, old, { text: 'Recent <@U9> mention' });
  const f = fixture({
    mentionPages: [{ matches: [hit(recentReply)], total: 1 }],
    conversations: { [recent]: [oldRoot, recentReply], [old]: [oldRoot, recentReply] },
  });
  await f.integration.threads();
  await flush();
  const count = f.calls.length;
  assert.equal((await f.integration.thread(recent)).available, false);
  assert.equal(f.calls.length, count, 'unverified reply timestamps do not reach Slack');
});

test('board scope: upstream and watcher independently reads an old configured thread', async () => {
  const old = at(NOW - WINDOW - 60_000);
  const recent = at(NOW - 1000);
  const f = fixture({
    conversations: { [old]: [root(old, { latest: recent }), reply(recent, old)] },
  });
  const result = await f.integration.lastInThread({
    channelId: CHANNEL,
    threadTs: old,
    asOfTs: recent,
  });
  assert.equal(result.ok, true);
  assert.equal(result.last.ts, recent);
  assert.deepEqual(
    f.calls.map((call) => call.method),
    ['auth.test', 'conversations.replies'],
  );
});

test('board scope: upstream and watcher allows channel identification from an incidental old hit', async () => {
  const old = at(NOW - WINDOW - 60_000);
  const f = fixture({
    override: ({ method, params }) =>
      method === 'search.messages' && params.count === '1'
        ? { ok: true, messages: { total: 1, matches: [hit(root(old, { user: OTHER }))] } }
        : undefined,
  });
  const badge = await f.integration.pending();
  assert.equal(badge.available, true);
  assert.equal(badge.channel.id, CHANNEL);
  assert.equal(
    f.named('conversations.replies').length,
    0,
    'channel identification is metadata only',
  );
});

test('board discovery: eligible mentions include a root mention and an earlier reply mention', async () => {
  const firstTs = at(NOW - 30_000);
  const secondTs = at(NOW - 25_000);
  const mentionTs = at(NOW - 20_000);
  const latestTs = at(NOW - 10_000);
  const first = root(firstTs, { user: OTHER, text: 'Root says <@U9>', latest: latestTs });
  const second = { ...root(secondTs, { latest: latestTs }), reply_count: 2 };
  const mention = reply(mentionTs, secondTs, { text: 'Earlier mention <@U9>' });
  const f = fixture({
    historyPages: [{ messages: [first, second] }],
    mentionPages: [{ matches: [hit(mention)], total: 1 }],
    conversations: {
      [firstTs]: [first, reply(latestTs, firstTs)],
      [secondTs]: [second, mention, reply(latestTs, secondTs)],
    },
  });
  const result = await f.integration.threads();
  await flush();
  const current = await f.integration.threads();
  assert.deepEqual(new Set(ids(current.mentions)), new Set([firstTs, secondTs]));
  assert.ok(ids(result.started).includes(secondTs));
  assert.match(current.mentions.find((row) => row.ts === firstTs).text, /Root says/);
  assert.match(current.mentions.find((row) => row.ts === secondTs).text, /Earlier mention/);
  assert.equal(current.mentions.find((row) => row.ts === secondTs).author.id, OTHER);
});

test('board discovery: eligible mentions resolve a recent started root missing from bounded history', async () => {
  const rootTs = at(NOW - 30_000);
  const recent = at(NOW - 1000);
  const candidate = root(rootTs, { latest: recent });
  const message = reply(recent, rootTs, { text: 'Progress without a mention' });
  const f = fixture({
    searchPages: [{ matches: [hit(message)], total: 1 }],
    conversations: { [rootTs]: [candidate, message] },
  });
  const result = await f.integration.threads();
  await flush();
  assert.ok(
    ids(result.started).includes(rootTs),
    'a verified recent-message candidate can recover an eligible started root',
  );
  assert.ok(f.named('conversations.replies').some((call) => call.params.ts === rootTs));
});

test('board discovery: eligible mentions resolve a permalink root missing from history', async () => {
  const rootTs = at(NOW - 30_000);
  const recent = at(NOW - 1000);
  const candidate = root(rootTs, { user: OTHER, latest: recent });
  const mention = hit(reply(recent, rootTs, { text: 'Recent ping <@U9>' }));
  delete mention.thread_ts;
  const f = fixture({
    mentionPages: [{ matches: [mention], total: 1 }],
    conversations: { [rootTs]: [candidate, reply(recent, rootTs, { text: mention.text })] },
  });
  const result = await f.integration.threads();
  await flush();
  assert.deepEqual(ids(result.mentions), [rootTs]);
  assert.match(result.mentions[0].text, /Recent ping/);
  assert.ok(f.named('conversations.replies').every((call) => call.params.ts === rootTs));
});

test('board discovery: eligible mentions never attribute the earliest reply as the latest', async () => {
  const rootTs = at(NOW - 30_000);
  const earlier = at(NOW - 20_000);
  const latest = at(NOW - 10_000);
  const candidate = { ...root(rootTs, { latest }), reply_count: 2 };
  const f = fixture({
    historyPages: [{ messages: [candidate] }],
    conversations: {
      [rootTs]: [
        candidate,
        reply(earlier, rootTs, { user: ME }),
        reply(latest, rootTs, { user: OTHER }),
      ],
    },
  });
  await f.integration.threads();
  await flush();
  const row = (await f.integration.threads()).started[0];
  assert.ok(
    row.needsReply === null || row.needsReply === true,
    'unknown is acceptable, a false claim is not',
  );
  if (row.latestReplyBy !== null) assert.equal(row.latestReplyBy.id, OTHER);
});

test('board discovery: pagination and budgets returns more than 25 eligible found rows', async () => {
  const roots = Array.from({ length: 26 }, (_, index) =>
    root(at(NOW - (index + 2) * 2000), { latest: at(NOW - (index + 1) * 1000) }),
  );
  const conversations = Object.fromEntries(
    roots.map((item) => [item.ts, [item, reply(item.latest_reply, item.ts)]]),
  );
  const f = fixture({ historyPages: [{ messages: roots }], conversations });
  const result = await f.integration.threads();
  await flush();
  assert.equal(result.started.length, 26, 'the shared list has no silent 25-row cap');
  assert.deepEqual(
    ids(result.started),
    roots.map((item) => item.ts),
  );
});

test('board discovery: pagination and budgets returns more than 25 eligible mentioned threads', async () => {
  const roots = Array.from({ length: 26 }, (_, index) =>
    root(at(NOW - (index + 2) * 2000), { user: OTHER, latest: at(NOW - (index + 1) * 1000) }),
  );
  const messages = roots.map((item) => reply(item.latest_reply, item.ts, { text: 'Ping <@U9>' }));
  const conversations = Object.fromEntries(
    roots.map((item, index) => [item.ts, [item, messages[index]]]),
  );
  const f = fixture({
    historyPages: [{ messages: roots }],
    mentionPages: [{ matches: messages.map((message) => hit(message)), total: 26 }],
    conversations,
  });
  const result = await f.integration.threads();
  await flush();
  assert.equal(result.mentions.length, 26, 'the mentions section also has no silent 25-row cap');
  assert.deepEqual(
    ids(result.mentions),
    roots.map((item) => item.ts),
  );
});

test('board discovery: pagination and budgets orders eligible rows by full-precision latest activity', async () => {
  const sameSecond = NOW - 1000;
  const earlier = root(at(NOW - 30_000), { latest: at(sameSecond, 100) });
  const later = root(at(NOW - 20_000), { latest: at(sameSecond, 900) });
  const f = fixture({
    historyPages: [{ messages: [earlier, later] }],
    conversations: {
      [earlier.ts]: [earlier, reply(earlier.latest_reply, earlier.ts)],
      [later.ts]: [later, reply(later.latest_reply, later.ts)],
    },
  });
  const result = await f.integration.threads();
  await flush();
  assert.deepEqual(ids(result.started), [later.ts, earlier.ts]);
});

test('board discovery: pagination and budgets flags has_more without a cursor as incomplete', async () => {
  const candidate = root(at(NOW - 1000));
  const f = fixture({ historyPages: [{ messages: [candidate], hasMore: true }] });
  const result = await f.integration.threads();
  await flush();
  assert.deepEqual(ids(result.started), [candidate.ts], 'valid rows survive an incomplete page');
  assert.equal(f.named('conversations.history').length, 1, 'no invented cursor or unbounded retry');
  assert.equal(result.partial, true);
  assertCoverageReason(result);
});

test('board discovery: pagination and budgets exposes a bounded continuation at the history page ceiling', async () => {
  const roots = [1, 2, 3].map((n) => root(at(NOW - n * 1000)));
  const f = fixture({
    historyPages: roots.map((candidate, index) => ({
      messages: [candidate],
      next: `history-${index + 1}`,
    })),
  });
  const result = await f.integration.threads();
  await flush();
  assert.deepEqual(
    ids(result.started),
    roots.map((candidate) => candidate.ts),
  );
  assert.equal(f.named('conversations.history').length, 3);
  assert.equal(result.partial, true, 'an upstream cursor remains after the page budget');
  assert.ok(result.continuation, 'a session-bound continuation is offered');
});

test('board discovery: pagination and budgets discloses an exhausted mention search', async () => {
  const rootTs = at(NOW - 60_000);
  const candidate = root(rootTs, { user: OTHER, latest: at(NOW - 1000) });
  const matches = Array.from({ length: 200 }, (_, index) =>
    hit(reply(at(NOW - 10_000, index), rootTs, { text: `<@U9> mention ${index}` })),
  );
  const f = fixture({
    historyPages: [{ messages: [candidate] }],
    mentionPages: [
      { matches: matches.slice(0, 100), total: 201, pages: 3 },
      { matches: matches.slice(100), total: 201, pages: 3 },
    ],
    conversations: { [rootTs]: [candidate, reply(candidate.latest_reply, rootTs)] },
  });
  const result = await f.integration.threads();
  await flush();
  assert.ok(ids(result.mentions).includes(rootTs), 'found rows survive the search ceiling');
  assert.equal(
    f.named('search.messages').filter((call) => call.params.query.includes(`<@${ME}>`)).length,
    2,
  );
  assert.equal(result.partial, true);
  assert.ok(result.continuation, 'the remaining bounded work is offered for continuation');
});

test('board discovery: eligible mentions marks a truncated reply scan incomplete', async () => {
  const rootTs = at(NOW - 600_000);
  const replies = Array.from({ length: 401 }, (_, index) =>
    reply(at(NOW - 500_000 + index * 1000), rootTs),
  );
  replies[400].text = 'Uninspected mention <@U9>';
  const candidate = { ...root(rootTs, { latest: replies[400].ts }), reply_count: replies.length };
  const f = fixture({
    historyPages: [{ messages: [candidate] }],
    conversations: { [rootTs]: [candidate, ...replies] },
  });
  await f.integration.threads();
  await flush();
  const result = await f.integration.threads();
  assert.equal(result.mentions.length, 0, 'an uninspected page cannot invent a mention');
  assert.equal(result.partial, true, 'the bounded candidate scan does not claim complete coverage');
});

test('board discovery: pagination and budgets rejects an out-of-bound upstream page and marks it partial', async () => {
  const eligible = root(at(NOW - 1000));
  const old = root(at(NOW - WINDOW - 1));
  const f = fixture({
    override: ({ method }) =>
      method === 'conversations.history'
        ? {
            ok: true,
            messages: [eligible, old],
            has_more: true,
            response_metadata: { next_cursor: 'history-1' },
          }
        : undefined,
  });
  const result = await f.integration.threads();
  await flush();
  assert.ok(!ids(result.started).includes(old.ts));
  assert.equal(
    f.named('conversations.history').length,
    1,
    'an untrustworthy bound stops pagination',
  );
  assert.equal(result.partial, true);
});

test('board scope: creation cutoff fails closed for future or malformed root timestamps', async () => {
  const good = root(at(NOW - 1000));
  const future = root(at(NOW + 1000));
  const invalid = root('not-a-slack-timestamp');
  const f = fixture({
    override: ({ method }) =>
      method === 'conversations.history'
        ? { ok: true, messages: [good, future, invalid], has_more: false, response_metadata: {} }
        : undefined,
  });
  const result = await f.integration.threads();
  await flush();
  assert.ok(!ids(result.started).includes(future.ts));
  assert.ok(!ids(result.started).includes(invalid.ts));
  assert.ok(
    !f
      .named('conversations.replies')
      .some((call) => [future.ts, invalid.ts].includes(call.params.ts)),
  );
  assert.equal(result.partial, true);
});

test('board cache: session and expiry removes a cached row immediately after its creation cutoff', async () => {
  const rootTs = at(NOW - WINDOW + 1000);
  const candidate = root(rootTs);
  const f = fixture({
    historyPages: [{ messages: [candidate] }],
    conversations: { [rootTs]: [candidate] },
  });
  const first = await f.integration.threads();
  await flush();
  assert.deepEqual(ids(first.started), [rootTs]);
  f.advance(1000);
  assert.deepEqual(
    ids((await f.integration.threads()).started),
    [rootTs],
    'equality remains eligible',
  );
  f.advance(1);
  assert.deepEqual(
    ids((await f.integration.threads()).started),
    [],
    'a cached snapshot cannot extend eligibility',
  );
});

test('board cache: session and expiry excludes unconfirmed rows when refresh is offline', async () => {
  const expiring = root(at(NOW - WINDOW + 301_000));
  const eligible = root(at(NOW - 1000));
  let offline = false;
  const f = fixture({
    historyPages: [{ messages: [eligible, expiring] }],
    override: ({ method }) => {
      if (offline && method === 'conversations.history') throw new Error('synthetic offline');
    },
  });
  const initial = await f.integration.threads();
  await flush();
  assert.deepEqual(new Set(ids(initial.started)), new Set([eligible.ts, expiring.ts]));
  offline = true;
  f.advance(301_001);
  const stale = await f.integration.threads();
  await flush();
  const afterFailure = await f.integration.threads();
  assert.deepEqual(ids(stale.started), [eligible.ts]);
  assert.deepEqual(ids(afterFailure.started), [], 'unconfirmed rows disappear after refresh');
  assert.equal(afterFailure.stale, true);
  assert.ok(afterFailure.partialReasons.includes('history_unavailable'));
  assert.equal(
    afterFailure.partial,
    true,
    'stale results after an unsuccessful refresh are disclosed',
  );
});

test('board cache: session and expiry refuses a cached dialog after its root expires', async () => {
  const rootTs = at(NOW - WINDOW + 1000);
  const candidate = root(rootTs);
  const f = fixture({
    historyPages: [{ messages: [candidate] }],
    conversations: { [rootTs]: [candidate] },
  });
  await f.integration.threads();
  await flush();
  assert.equal((await f.integration.thread(rootTs)).available, true);
  const count = f.calls.length;
  f.advance(1001);
  assert.equal((await f.integration.thread(rootTs)).available, false);
  assert.equal(f.calls.length, count, 'expiry is checked before reading the dialog cache or Slack');
});

test('board cache: session and expiry does not start queued reply reads after expiry', async () => {
  const roots = Array.from({ length: 6 }, (_, index) =>
    root(at(NOW - WINDOW + 1000, index), { latest: at(NOW - 1000) }),
  );
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const f = fixture({
    historyPages: [{ messages: roots }],
    override: async ({ method, params }) => {
      if (method !== 'conversations.replies') return undefined;
      await held;
      const candidate = roots.find((item) => item.ts === params.ts);
      return { ok: true, messages: [candidate], response_metadata: { next_cursor: '' } };
    },
  });
  const pending = f.integration.threads();
  await flush();
  f.advance(1001);
  release();
  await pending;
  await flush();
  assert.ok(
    !f.named('conversations.replies').some((call) => call.at > NOW + 1000),
    'queued work is rechecked immediately before each read',
  );
  assert.deepEqual(
    ids((await f.integration.threads()).started),
    [],
    'an expired in-flight snapshot cannot be returned',
  );
});

test('board cache: session and expiry cannot publish the previous session snapshot after replacement', async () => {
  const rootTs = at(NOW - 10_000);
  const candidate = root(rootTs);
  const replacement = root(at(NOW - 5000), { text: 'TAP-2: replacement identity' });
  const f = fixture({
    historyPages: [{ messages: [candidate] }],
    override: ({ method, authorization }) =>
      method === 'conversations.history' && authorization === 'Bearer xoxc-replacement'
        ? { ok: true, messages: [replacement], response_metadata: {} }
        : undefined,
  });
  assert.deepEqual(ids((await f.integration.threads()).started), [rootTs]);
  await flush();
  const oldHistoryCount = f.named('conversations.history').length;
  f.replaceSession();
  const result = await f.integration.threads();
  await flush();
  assert.ok(
    !result.available || !ids(result.started).includes(rootTs),
    'the previous session cannot see its old snapshot',
  );
  assert.ok(
    f.named('conversations.history').length > oldHistoryCount,
    'session replacement invalidates the snapshot',
  );
});

test('board discovery: eligible mentions invalidate reply enrichment for a same-second new reply', async () => {
  const rootTs = at(NOW - 30_000);
  const mention = reply(at(NOW - 2000), rootTs, { text: 'Earlier ping <@U9>' });
  const oldLatest = at(NOW - 1000, 100);
  const newLatest = at(NOW - 1000, 900);
  const oldRoot = { ...root(rootTs, { user: OTHER, latest: oldLatest }), reply_count: 2 };
  const pages = [{ messages: [oldRoot] }];
  const conversations = { [rootTs]: [oldRoot, mention, reply(oldLatest, rootTs)] };
  const f = fixture({
    historyPages: pages,
    mentionPages: [{ matches: [hit(mention)], total: 1 }],
    conversations,
  });
  await f.integration.threads();
  await flush();
  const initial = (await f.integration.threads()).mentions[0];
  assert.equal(initial.needsReply, true, 'the verified old latest reply is from a colleague');

  const newRoot = { ...root(rootTs, { user: OTHER, latest: newLatest }), reply_count: 3 };
  pages[0].messages = [newRoot];
  conversations[rootTs] = [
    newRoot,
    mention,
    reply(oldLatest, rootTs),
    reply(newLatest, rootTs, { user: ME }),
  ];
  f.advance(300_001);
  await f.integration.threads(); // stale-while-revalidate
  await flush();
  const refreshed = (await f.integration.threads()).mentions[0];
  assert.ok(
    refreshed.needsReply === false || refreshed.needsReply === null,
    'the old colleague reply must not be reused for a different microsecond timestamp',
  );
  if (refreshed.latestReplyBy !== null) assert.equal(refreshed.latestReplyBy.id, ME);
});

test('board failure: rate and partial retains a good row but reports an unreadable reply', async () => {
  const rootTs = at(NOW - 30_000);
  const latest = at(NOW - 1000);
  const candidate = root(rootTs, { latest });
  const f = fixture({
    historyPages: [{ messages: [candidate] }],
    override: ({ method }) =>
      method === 'conversations.replies'
        ? new Response(JSON.stringify({ ok: false, error: 'ratelimited' }), {
            status: 429,
            headers: { 'Retry-After': '30' },
          })
        : undefined,
  });
  await f.integration.threads();
  await flush();
  const result = await f.integration.threads();
  assert.deepEqual(ids(result.started), [rootTs]);
  assert.equal(result.started[0].needsReply, null);
  assert.equal(result.started[0].latestReplyBy, null);
  assert.equal(result.partial, true, 'a rate-limited reply cannot be called complete');
  assertCoverageReason(result);
});

for (const pagination of [
  { has_more: true, response_metadata: {} },
  { has_more: false, response_metadata: { next_cursor: 'reply-1' } },
]) {
  test(`board failure: root-only lookup rejects zero replies when ${pagination.has_more ? 'has_more' : 'a cursor'} remains`, async () => {
    const rootTs = at(NOW - 30_000);
    const candidate = root(rootTs);
    const f = fixture({
      searchPages: [{ matches: [hit(candidate)], total: 1 }],
      override: ({ method, params }) => {
        if (method !== 'conversations.replies') return undefined;
        if (params.limit === '1') return { ok: true, messages: [candidate], ...pagination };
        return { ok: true, messages: [candidate], has_more: false, response_metadata: {} };
      },
    });
    const result = await f.integration.threads();
    await flush();
    const row = result.started.find((item) => item.ts === rootTs);
    assert.ok(row);
    assert.equal(row.activityAt, '');
    assert.equal(row.activityTs, null);
    assert.equal(row.latestReplyBy, null);
    assert.equal(row.needsReply, null);
    assert.ok(result.partialReasons.includes('root_reply_count_inconsistent'));
    assert.ok(f.named('conversations.replies').some((call) => call.params.limit === '200'));
  });
}

for (const failedStream of ['recent messages', 'mentions']) {
  test(`board failure: ${failedStream} search refresh keeps only confirmed rows and recovers`, async () => {
    const stable = root(at(NOW - 10_000));
    const searchOnly = root(at(NOW - 90_000));
    let failed = false;
    const f = fixture({
      historyPages: [{ messages: [stable] }],
      searchPages: [{ matches: [hit(searchOnly)], total: 1 }],
      conversations: { [searchOnly.ts]: [searchOnly] },
      override: ({ method, params }) => {
        const isMentionSearch = (params.query || '').includes(`<@${ME}>`);
        if (
          failed &&
          method === 'search.messages' &&
          params.count !== '1' &&
          isMentionSearch === (failedStream === 'mentions')
        )
          return { ok: false, error: 'unavailable' };
      },
    });
    const initial = await f.integration.threads();
    await flush();
    assert.deepEqual(new Set(ids(initial.started)), new Set([stable.ts, searchOnly.ts]));

    failed = true;
    f.advance(300_001);
    await f.integration.threads();
    await flush();
    const stale = await f.integration.threads();
    assert.equal(stale.stale, true);
    assert.ok(stale.partialReasons.includes('refresh_failed'));
    assert.ok(stale.partialReasons.includes('search_unavailable'));
    assert.deepEqual(
      new Set(ids(stale.started)),
      new Set(failedStream === 'recent messages' ? [stable.ts] : [stable.ts, searchOnly.ts]),
    );

    failed = false;
    f.advance(60_001);
    await f.integration.threads();
    await flush();
    const recovered = await f.integration.threads();
    assert.equal(recovered.stale, false);
    assert.deepEqual(new Set(ids(recovered.started)), new Set([stable.ts, searchOnly.ts]));
  });
}

test('board failure: a rate-limited search continuation retains rows and remains stale until recovery', async () => {
  const stable = root(at(NOW - 10_000));
  const searchOnly = root(at(NOW - 90_000));
  let failed = true;
  const f = fixture({
    historyPages: [{ messages: [stable] }],
    searchPages: [
      { matches: [hit(searchOnly)], total: 201, pages: 3 },
      { matches: [], total: 201, pages: 3 },
      { matches: [], total: 201, pages: 3 },
    ],
    conversations: { [searchOnly.ts]: [searchOnly] },
    override: ({ method, params }) => {
      if (
        failed &&
        method === 'search.messages' &&
        params.page === '3' &&
        !(params.query || '').includes(`<@${ME}>`)
      )
        return new Response(JSON.stringify({ ok: false, error: 'ratelimited' }), {
          status: 429,
          headers: { 'Retry-After': '30' },
        });
    },
  });
  const initial = await f.integration.threads();
  await flush();
  assert.ok(initial.continuation);
  assert.deepEqual(new Set(ids(initial.started)), new Set([stable.ts, searchOnly.ts]));
  const interrupted = await f.integration.threads({ continuation: initial.continuation });
  await flush();
  assert.equal(interrupted.stale, true);
  assert.ok(interrupted.partialReasons.includes('search_unavailable'));
  assert.deepEqual(new Set(ids(interrupted.started)), new Set([stable.ts, searchOnly.ts]));
  assert.ok(interrupted.continuation);

  failed = false;
  f.advance(30_001);
  const recovered = await f.integration.threads({ continuation: interrupted.continuation });
  await flush();
  assert.equal(recovered.stale, false);
  assert.ok(!recovered.partialReasons.includes('search_unavailable'));
  assert.deepEqual(new Set(ids(recovered.started)), new Set([stable.ts, searchOnly.ts]));
});

test('board failure: rate and partial retains verified search results when cold history fails', async () => {
  const rootTs = at(NOW - 30_000);
  const recent = at(NOW - 1000);
  const candidate = root(rootTs, { latest: recent });
  const message = reply(recent, rootTs);
  const f = fixture({
    searchPages: [{ matches: [hit(message)], total: 1 }],
    conversations: { [rootTs]: [candidate, message] },
    override: ({ method }) =>
      method === 'conversations.history' ? { ok: false, error: 'unavailable' } : undefined,
  });
  const result = await f.integration.threads();
  await flush();
  assert.equal(result.available, true);
  assert.deepEqual(ids(result.started), [rootTs]);
  assert.ok(result.partialReasons.includes('history_unavailable'));
  assert.ok(result.continuation);
});

test('board failure: rate and partial retains earlier history pages when a later page fails', async () => {
  const candidate = root(at(NOW - 1000));
  const f = fixture({
    historyPages: [{ messages: [candidate], next: 'history-1' }],
    override: ({ method, params }) =>
      method === 'conversations.history' && params.cursor
        ? { ok: false, error: 'unavailable' }
        : undefined,
  });
  const result = await f.integration.threads();
  await flush();
  assert.equal(result.available, true);
  assert.deepEqual(ids(result.started), [candidate.ts]);
  assert.ok(result.partialReasons.includes('history_unavailable'));
  assert.ok(result.continuation);
});

test('board failure: rate and partial stops queued reply scans on Retry-After', async () => {
  const roots = Array.from({ length: 8 }, (_, index) =>
    root(at(NOW - 30_000 - index * 1000), { latest: at(NOW - 1000 - index) }),
  );
  const f = fixture({
    historyPages: [{ messages: roots }],
    override: ({ method }) =>
      method === 'conversations.replies'
        ? new Response(JSON.stringify({ ok: false, error: 'ratelimited' }), {
            status: 429,
            headers: { 'Retry-After': '30' },
          })
        : undefined,
  });
  const first = await f.integration.threads();
  await flush();
  const count = f.named('conversations.replies').length;
  assert.ok(count <= 5, 'already in-flight reads may finish, but queued reads do not start');
  await f.integration.threads();
  await flush();
  assert.equal(
    f.named('conversations.replies').length,
    count,
    'no immediate retry storm within Retry-After',
  );
  assert.equal(first.started.length, roots.length);
});

test('board scope: shared My Tickets consumer keeps eligible links and fresh watch annotations only', async () => {
  const eligibleTs = at(NOW - 10_000);
  const oldTs = at(NOW - WINDOW - 1000);
  const eligible = root(eligibleTs, { text: 'TAP-42: eligible' });
  const old = root(oldTs, { text: 'TAP-42: old', latest: at(NOW - 1000) });
  const f = fixture({
    historyPages: [{ messages: [eligible, old] }],
    conversations: { [eligibleTs]: [eligible], [oldTs]: [old] },
  });
  const result = await f.integration.threads();
  await flush();
  const links = { [`${CHANNEL}:${eligibleTs}`]: { sessionIds: ['session-a', 'session-b'] } };
  const annotated = withAttachedSessions(result, links);
  const ticketRows = threadsByTicket(annotated.started).get('TAP-42');
  assert.deepEqual(ids(ticketRows), [eligibleTs]);
  assert.equal(ticketRows[0].attachedSessions, 2);
  assert.ok(ticketRows[0].url.includes(eligibleTs));
  assert.equal(annotated.available, true);
  for (const field of ['channel', 'started', 'mentions', 'updatedAt', 'enriched'])
    assert.ok(field in annotated);
});

test('board discovery: an unresolved search candidate does not prove a later hit is a root', async () => {
  const rootTs = at(NOW - 30_000);
  const recent = at(NOW - 1000);
  const candidate = root(rootTs, { user: OTHER, latest: recent });
  const first = hit(reply(recent, rootTs));
  const ambiguous = { ts: rootTs, user: OTHER, text: '<@U9> unverified', channel: { id: CHANNEL } };
  const f = fixture({
    searchPages: [{ matches: [first, ambiguous], total: 2 }],
    conversations: { [rootTs]: [candidate, reply(recent, rootTs)] },
  });
  const result = await f.integration.threads();
  await flush();
  assert.equal(result.mentions.length, 0);
  assert.ok(result.partialReasons.includes('ambiguous_search_result'));
});

test('board activity: missing, inconsistent, and future latest timestamps remain unknown', async () => {
  const roots = [
    { ...root(at(NOW - 10_000)), reply_count: 1 },
    { ...root(at(NOW - 20_000)), reply_count: 1, latest_reply: at(NOW - 21_000) },
    { ...root(at(NOW - 30_000)), reply_count: 1, latest_reply: at(NOW + 1000) },
    { ...root(at(NOW - 40_000)), reply_count: undefined },
    { ...root(at(NOW - 50_000)), latest_reply: at(NOW - 1000) },
  ];
  const conversations = Object.fromEntries(roots.map((item) => [item.ts, [item]]));
  const f = fixture({ historyPages: [{ messages: roots }], conversations });
  await f.integration.threads();
  await flush();
  const result = await f.integration.threads();
  assert.equal(result.started.length, roots.length);
  for (const row of result.started) {
    assert.equal(row.activityAt, '');
    assert.equal(row.activityTs, null);
    assert.equal(row.latestReplyBy, null);
    assert.equal(row.needsReply, null);
  }
  assert.ok(result.partialReasons.includes('activity_unavailable'));
});

test('board activity: an observed reply newer than latest metadata invalidates activity and author', async () => {
  const rootTs = at(NOW - 20_000);
  const candidate = root(rootTs, { latest: at(NOW - 3000) });
  const f = fixture({
    historyPages: [{ messages: [candidate] }],
    conversations: {
      [rootTs]: [candidate, reply(candidate.latest_reply, rootTs), reply(at(NOW - 1000), rootTs)],
    },
  });
  await f.integration.threads();
  await flush();
  const row = (await f.integration.threads()).started[0];
  assert.equal(row.activityTs, null);
  assert.equal(row.activityAt, '');
  assert.equal(row.needsReply, null);
  assert.equal(row.latestReplyBy, null);
});

test('board activity: an exhausted scan that disproves latest metadata leaves activity unknown', async () => {
  const rootTs = at(NOW - 30_000);
  const candidate = root(rootTs, { latest: at(NOW - 1000) });
  const f = fixture({
    historyPages: [{ messages: [candidate] }],
    conversations: { [rootTs]: [candidate, reply(at(NOW - 2000), rootTs)] },
  });
  await f.integration.threads();
  await flush();
  const result = await f.integration.threads();
  assert.equal(result.started[0].activityAt, '');
  assert.equal(result.started[0].activityTs, null);
  assert.equal(result.started[0].needsReply, null);
  assert.ok(result.partialReasons.includes('latest_reply_unverified'));
});

test('board activity: unrepresentable future timestamps do not make eligible rows unavailable', async () => {
  const rootTs = at(NOW - 30_000);
  const candidate = root(rootTs, { latest: '9999999999999.000000' });
  const f = fixture({
    historyPages: [{ messages: [candidate] }],
    conversations: { [rootTs]: [candidate] },
  });
  const result = await f.integration.threads();
  await flush();
  assert.equal(result.available, true);
  assert.equal(result.started.length, 1);
  assert.equal(result.started[0].activityAt, '');
  assert.equal(result.started[0].activityTs, null);
});

test('board cache: identical concurrent cold loads share one upstream snapshot', async () => {
  const f = fixture({ historyPages: [{ messages: [root(at(NOW - 1000))] }] });
  const [first, second] = await Promise.all([f.integration.threads(), f.integration.threads()]);
  await flush();
  assert.deepEqual(ids(first.started), ids(second.started));
  assert.equal(f.named('auth.test').length, 1);
  assert.equal(f.named('conversations.history').length, 1);
});

test('board scope: a dialog expiring during its Slack request cannot publish a result', async () => {
  const rootTs = at(NOW - WINDOW + 1000);
  const candidate = root(rootTs);
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const f = fixture({
    historyPages: [{ messages: [candidate] }],
    override: async ({ method }) => {
      if (method === 'conversations.replies') {
        await held;
        return { ok: true, messages: [candidate], response_metadata: {} };
      }
    },
  });
  await f.integration.threads();
  await flush();
  const pending = f.integration.thread(rootTs);
  await flush();
  assert.equal(f.named('conversations.replies').length, 1);
  f.advance(1001);
  release();
  assert.equal((await pending).available, false);
});

test('board scope: an unavailable user directory does not hide a verified dialog', async () => {
  const rootTs = at(NOW - 30_000);
  const candidate = root(rootTs);
  const f = fixture({
    historyPages: [{ messages: [candidate] }],
    conversations: { [rootTs]: [candidate] },
    override: ({ method }) =>
      method === 'users.list' ? { ok: false, error: 'unavailable' } : undefined,
  });
  const list = await f.integration.threads();
  assert.ok(list.partialReasons.includes('users_unavailable'));
  const dialog = await f.integration.thread(rootTs);
  assert.equal(dialog.available, true);
  assert.equal(dialog.thread.messages[0].ts, rootTs);
});

test('board continuation: reply paging finds a later mention and the verified latest author', async () => {
  const rootTs = at(NOW - 600_000);
  const replies = Array.from({ length: 401 }, (_, index) =>
    reply(at(NOW - 500_000 + index * 1000), rootTs),
  );
  replies[400] = reply(replies[400].ts, rootTs, { user: ME, text: 'Late <@U9> mention' });
  const candidate = { ...root(rootTs, { latest: replies[400].ts }), reply_count: replies.length };
  const f = fixture({
    historyPages: [{ messages: [candidate] }],
    conversations: { [rootTs]: [candidate, ...replies] },
  });
  const first = await f.integration.threads();
  await flush();
  assert.equal(first.mentions.length, 0);
  assert.ok(first.continuation);
  const continued = await f.integration.threads({ continuation: first.continuation });
  await flush();
  assert.deepEqual(ids(continued.mentions), [rootTs]);
  assert.equal(continued.started[0].latestReplyBy.id, ME);
  assert.equal(continued.started[0].needsReply, false);
});

test('board pagination: short history pages still follow cursors and expose remaining work', async () => {
  const roots = Array.from({ length: 46 }, (_, index) => root(at(NOW - (index + 1) * 1000)));
  const f = fixture({
    override: ({ method, params }) => {
      if (method !== 'conversations.history') return undefined;
      const offset = params.cursor ? Number(params.cursor.replace('short-', '')) : 0;
      const next = offset + 15 < roots.length ? `short-${offset + 15}` : '';
      return {
        ok: true,
        messages: roots.slice(offset, offset + 15),
        has_more: Boolean(next),
        response_metadata: { next_cursor: next },
      };
    },
  });
  const first = await f.integration.threads();
  await flush();
  assert.equal(first.started.length, 45);
  assert.equal(f.named('conversations.history').length, 3);
  assert.ok(first.continuation);
  const continued = await f.integration.threads({ continuation: first.continuation });
  await flush();
  assert.equal(continued.started.length, 46);
  assert.equal(f.named('conversations.history').length, 4);
});

test('board pagination: short reply pages continue until latest author is verified', async () => {
  const rootTs = at(NOW - 90_000);
  const replies = Array.from({ length: 45 }, (_, index) =>
    reply(at(NOW - 80_000 + index * 1000), rootTs, { user: index === 44 ? ME : OTHER }),
  );
  const candidate = { ...root(rootTs, { latest: replies[44].ts }), reply_count: replies.length };
  const messages = [candidate, ...replies];
  const f = fixture({
    historyPages: [{ messages: [candidate] }],
    override: ({ method, params }) => {
      if (method !== 'conversations.replies') return undefined;
      const offset = params.cursor ? Number(params.cursor.replace('short-', '')) : 0;
      const next = offset + 15 < messages.length ? `short-${offset + 15}` : '';
      return {
        ok: true,
        messages: messages.slice(offset, offset + 15),
        has_more: Boolean(next),
        response_metadata: { next_cursor: next },
      };
    },
  });
  const first = await f.integration.threads();
  await flush();
  assert.equal(first.started[0].needsReply, null);
  assert.equal(f.named('conversations.replies').length, 2);
  assert.ok(first.continuation);
  const continued = await f.integration.threads({ continuation: first.continuation });
  await flush();
  assert.equal(f.named('conversations.replies').length, 4);
  assert.equal(continued.started[0].latestReplyBy.id, ME);
  assert.equal(continued.started[0].needsReply, false);
});

test('board cache: an old session rate limit cannot throttle its replacement', async () => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const roots = [1, 2, 3, 4].map((n) => root(at(NOW - n * 1000)));
  const f = fixture({
    historyPages: roots.map((candidate, index) => ({
      messages: [candidate],
      ...(index < roots.length - 1 ? { next: `history-${index + 1}` } : {}),
    })),
    override: async ({ method, authorization }) => {
      if (method === 'conversations.history' && authorization === 'Bearer xoxc-synthetic') {
        await held;
        return new Response(JSON.stringify({ ok: false, error: 'ratelimited' }), {
          status: 429,
          headers: { 'Retry-After': '30' },
        });
      }
    },
  });
  const previous = f.integration.threads();
  await flush();
  f.replaceSession();
  const next = await f.integration.threads();
  await flush();
  const token = next.continuation;
  assert.ok(token);
  release();
  assert.equal((await previous).available, false);
  const before = f.named('conversations.history').length;
  const continued = await f.integration.threads({ continuation: token });
  await flush();
  assert.equal(continued.available, true);
  assert.ok(f.named('conversations.history').length > before);
  assert.deepEqual(
    ids(continued.started),
    roots.map((item) => item.ts),
  );
});

test('board cache: a pending old-session badge cannot poison a replacement channel cache', async () => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const f = fixture({
    override: async ({ method, authorization, params }) => {
      if (method === 'auth.test' && authorization === 'Bearer xoxc-synthetic') {
        await held;
        return { ok: true, user: 'old', user_id: ME, team_id: TEAM };
      }
      if (
        method === 'search.messages' &&
        params.count === '1' &&
        authorization === 'Bearer xoxc-synthetic'
      )
        return {
          ok: true,
          messages: { matches: [{ channel: { id: 'COLDSESSION', name: 'ezat_claudio' } }] },
        };
    },
  });
  const previous = f.integration.pending();
  await flush();
  f.replaceSession();
  const current = await f.integration.threads();
  assert.equal(current.channel.id, CHANNEL);
  release();
  assert.equal((await previous).available, false);
  f.advance(300_001);
  await f.integration.threads();
  await flush();
  assert.ok(f.named('conversations.history').every((call) => call.params.channel === CHANNEL));
  assert.ok(
    !f.calls.some(
      (call) => call.authorization === 'Bearer xoxc-synthetic' && call.method === 'search.messages',
    ),
  );
});

test('board continuation: unreadable early roots do not starve a later eligible candidate', async () => {
  const roots = Array.from({ length: 41 }, (_, index) =>
    root(at(NOW - 90_000 - index * 1000), { latest: at(NOW - 1000 - index) }),
  );
  const f = fixture({
    historyPages: [{ messages: roots }],
    override: ({ method, params }) => {
      if (method !== 'conversations.replies') return undefined;
      if (params.ts !== roots[40].ts) return { ok: false, error: 'thread_not_found' };
      return {
        ok: true,
        messages: [roots[40], reply(roots[40].latest_reply, roots[40].ts)],
        response_metadata: {},
      };
    },
  });
  const first = await f.integration.threads();
  await flush();
  assert.ok(first.continuation);
  assert.ok(!f.named('conversations.replies').some((call) => call.params.ts === roots[40].ts));
  const continued = await f.integration.threads({ continuation: first.continuation });
  await flush();
  assert.ok(f.named('conversations.replies').some((call) => call.params.ts === roots[40].ts));
  assert.equal(continued.started.find((row) => row.ts === roots[40].ts).needsReply, true);
});

test('board continuation: unresolved early search hits do not starve a later root', async () => {
  const roots = Array.from({ length: 41 }, (_, index) =>
    root(at(NOW - 90_000 - index * 1000), { latest: at(NOW - 1000 - index) }),
  );
  const matches = roots.map((item) => hit(reply(item.latest_reply, item.ts)));
  const f = fixture({
    searchPages: [{ matches, total: matches.length }],
    override: ({ method, params }) => {
      if (method !== 'conversations.replies') return undefined;
      if (params.ts !== roots[40].ts) return { ok: false, error: 'thread_not_found' };
      return { ok: true, messages: [roots[40]], response_metadata: {} };
    },
  });
  const first = await f.integration.threads();
  await flush();
  assert.ok(first.continuation);
  assert.ok(!f.named('conversations.replies').some((call) => call.params.ts === roots[40].ts));
  const continued = await f.integration.threads({ continuation: first.continuation });
  await flush();
  assert.ok(f.named('conversations.replies').some((call) => call.params.ts === roots[40].ts));
  assert.ok(ids(continued.started).includes(roots[40].ts));
});

test('board continuation: unresolved search candidates cannot consume the reply-scan budget', async () => {
  const knownTs = at(NOW - 120_000);
  const known = root(knownTs, { latest: at(NOW - 1000) });
  const unresolved = Array.from({ length: 40 }, (_, index) => {
    const ts = at(NOW - 90_000 - index * 1000);
    return hit(reply(at(NOW - 2000 - index), ts));
  });
  const f = fixture({
    historyPages: [{ messages: [known] }],
    searchPages: [{ matches: unresolved, total: unresolved.length }],
    override: ({ method, params }) => {
      if (method !== 'conversations.replies') return undefined;
      if (params.ts !== knownTs) return { ok: false, error: 'thread_not_found' };
      return {
        ok: true,
        messages: [known, reply(known.latest_reply, knownTs)],
        response_metadata: {},
      };
    },
  });
  const result = await f.integration.threads();
  await flush();
  assert.ok(f.named('conversations.replies').some((call) => call.params.ts === knownTs));
  assert.equal(result.started.find((row) => row.ts === knownTs).needsReply, true);
  assert.ok(result.continuation, 'unresolved candidates are still resumable');
});

test('board continuation: a throttled reply scan gets first use of the next rate-limit window', async () => {
  const knownTs = at(NOW - 120_000);
  const known = root(knownTs, { latest: at(NOW - 1000) });
  const unresolved = [1, 2].map((index) => {
    const ts = at(NOW - 90_000 - index * 1000);
    return hit(reply(at(NOW - 2000 - index), ts));
  });
  let window = -1;
  let callsInWindow = 0;
  const historyPages = Array.from({ length: 8 }, (_, index) => ({
    messages: [...(index === 0 ? [known] : []), root(at(NOW - 200_000 - index * 1000))],
    ...(index < 7 ? { next: `history-${index + 1}` } : {}),
  }));
  const f = fixture({
    historyPages,
    searchPages: [{ matches: unresolved, total: unresolved.length }],
    override: ({ method, params, at: callTime }) => {
      if (method !== 'conversations.replies') return undefined;
      const currentWindow = Math.floor((callTime - NOW) / 60_000);
      if (currentWindow !== window) {
        window = currentWindow;
        callsInWindow = 0;
      }
      callsInWindow++;
      if (callsInWindow > 1)
        return new Response(JSON.stringify({ ok: false, error: 'ratelimited' }), {
          status: 429,
          headers: { 'Retry-After': '60' },
        });
      if (params.ts !== knownTs) return { ok: false, error: 'thread_not_found' };
      return {
        ok: true,
        messages: [known, reply(known.latest_reply, knownTs)],
        response_metadata: {},
      };
    },
  });
  const first = await f.integration.threads();
  await flush();
  assert.ok(first.continuation);
  assert.equal(first.started.find((row) => row.ts === knownTs).needsReply, null);
  assert.ok(!f.named('conversations.replies').some((call) => call.params.ts === knownTs));
  f.advance(60_001);
  const continued = await f.integration.threads({ continuation: first.continuation });
  await flush();
  const resumed = f.named('conversations.replies').find((call) => call.at >= NOW + 60_000);
  assert.equal(resumed.params.ts, knownTs, 'the scan has priority at the next available window');
  assert.equal(continued.started.find((row) => row.ts === knownTs).needsReply, true);
});

test('board activity: an exact reply on an incomplete scan cannot establish latest author', async () => {
  const rootTs = at(NOW - 60_000);
  const claimed = at(NOW - 3000);
  const newer = at(NOW - 1000);
  const candidate = root(rootTs, { latest: claimed });
  const f = fixture({
    historyPages: [{ messages: [candidate] }],
    override: ({ method, params }) => {
      if (method !== 'conversations.replies') return undefined;
      if (!params.cursor)
        return {
          ok: true,
          messages: [candidate, reply(claimed, rootTs)],
          has_more: true,
          response_metadata: { next_cursor: 'reply-1' },
        };
      if (params.cursor === 'reply-1')
        return {
          ok: true,
          messages: [],
          has_more: true,
          response_metadata: { next_cursor: 'reply-2' },
        };
      return {
        ok: true,
        messages: [reply(newer, rootTs, { user: ME })],
        has_more: false,
        response_metadata: {},
      };
    },
  });
  const first = await f.integration.threads();
  await flush();
  assert.ok(first.continuation);
  assert.equal(first.started[0].activityTs, null);
  assert.equal(first.started[0].latestReplyBy, null);
  assert.equal(first.started[0].needsReply, null);
  const continued = await f.integration.threads({ continuation: first.continuation });
  await flush();
  assert.equal(
    continued.started[0].activityTs,
    null,
    'the later reply contradicts latest metadata',
  );
  assert.equal(continued.started[0].latestReplyBy, null);
  assert.equal(continued.started[0].needsReply, null);
});
