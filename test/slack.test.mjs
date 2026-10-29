// slack.test.mjs — the Slack integration must never throw at the dashboard:
// every missing, rejected or unreachable session resolves to "not connected".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createSlackIntegration, slackPaths } from '../backend/slack.mjs';

function setup(t, { fetchImpl, spawnImpl, now } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = slackPaths(home);
  fs.mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  const calls = [];
  const spawned = [];
  const integration = createSlackIntegration({
    paths,
    now,
    fetchImpl:
      fetchImpl ||
      (async (...args) => {
        calls.push(args);
        return new Response(
          JSON.stringify({ ok: true, user: 'jommari', team: 'TeamPathwise', team_id: 'T1' }),
        );
      }),
    spawnImpl:
      spawnImpl ||
      (() => {
        const child = new EventEmitter();
        child.unref = () => {};
        spawned.push(child);
        return child;
      }),
  });
  return { home, paths, integration, calls, spawned };
}

function writeSession(paths, overrides = {}) {
  fs.writeFileSync(
    paths.session,
    JSON.stringify({
      token: 'xoxc-synthetic',
      cookie: 'xoxd-synthetic',
      teamId: 'T1',
      teamDomain: 'example',
      savedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    }),
    { mode: 0o600 },
  );
}

test('no stored session reports not connected without touching Slack', async (t) => {
  const { integration, calls } = setup(t);
  assert.deepEqual(await integration.status(), { connected: false, connecting: false });
  assert.equal(calls.length, 0);
});

test('a stored session is verified with the web-client credentials', async (t) => {
  const { paths, integration, calls } = setup(t);
  writeSession(paths);
  const status = await integration.status();
  assert.equal(status.connected, true);
  assert.equal(status.verified, true);
  assert.equal(status.user, 'jommari');
  assert.equal(status.team, 'TeamPathwise');
  assert.equal(calls.length, 1);
  const [url, init] = calls[0];
  assert.match(url, /^https:\/\/app\.slack\.com\/api\/auth\.test/);
  assert.equal(init.headers.Authorization, 'Bearer xoxc-synthetic');
  assert.equal(init.headers.Cookie, 'd=xoxd-synthetic');
});

test('a rejected session degrades to not connected instead of an error', async (t) => {
  const { paths, integration } = setup(t, {
    fetchImpl: async () => new Response(JSON.stringify({ ok: false, error: 'invalid_auth' })),
  });
  writeSession(paths);
  const status = await integration.status();
  assert.equal(status.connected, false);
  assert.equal(status.reason, 'invalid_auth');
});

test('an unreachable Slack keeps the session but stops claiming it is verified', async (t) => {
  const { paths, integration } = setup(t, {
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });
  writeSession(paths);
  const status = await integration.status();
  assert.equal(status.connected, true);
  assert.equal(status.verified, false);
});

test('connect launches the sign-in helper once and reports progress', async (t) => {
  const { integration, spawned } = setup(t);
  assert.deepEqual(integration.connect(), { ok: true, connecting: true });
  assert.equal(spawned.length, 1);
  assert.equal((await integration.status()).connecting, true);
  assert.deepEqual(integration.connect(), { ok: true, connecting: true });
  assert.equal(spawned.length, 1, 'a second click reuses the running window');
  spawned[0].emit('exit', 0);
  assert.equal((await integration.status()).connecting, false);
});

test('disconnect removes the stored session', async (t) => {
  const { paths, integration } = setup(t);
  writeSession(paths);
  assert.equal((await integration.status()).connected, true);
  assert.deepEqual(integration.disconnect(), { ok: true });
  assert.equal(fs.existsSync(paths.session), false);
  assert.deepEqual(await integration.status(), { connected: false, connecting: false });
});

test('a captured session is written atomically with owner-only permissions', async (t) => {
  const { paths, integration } = setup(t);
  integration.writeSession({ token: 'xoxc-synthetic', cookie: 'xoxd-synthetic', teamId: 'T1' });
  assert.equal(fs.statSync(paths.session).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(paths.session, 'utf8')).token, 'xoxc-synthetic');
});

test('a session file with unexpected contents is ignored', async (t) => {
  const { paths, integration } = setup(t);
  writeSession(paths, { cookie: 'not-a-cookie' });
  assert.deepEqual(await integration.status(), { connected: false, connecting: false });
});

// Let the fire-and-forget reply read after the rows settle. The fake does no
// real I/O, so a macrotask is enough.
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

function fakeSlack() {
  const calls = [];
  const replies = []; // { ts, limit } for every conversations.replies call.
  // Slack answers limit=1 with the root plus the newest message only.
  const threads = {
    100.0001: [
      { ts: '100.0001', user: 'U9' },
      { ts: '300.0003', user: 'U1' },
    ],
    200.0002: [
      { ts: '200.0002', user: 'U2' },
      { ts: '400.0004', user: 'U9' },
    ],
    600.0006: [
      { ts: '600.0006', user: 'U1' },
      { ts: '700.0007', user: 'U1' },
    ],
  };
  const mentions = [
    // Three matches in one thread, distinct ts, same permalink thread_ts.
    {
      ts: '250.0002',
      user: 'U1',
      channel: { id: 'C1', name: 'ezat_claudio' },
      text: 'hey <@U9> look',
      permalink: 'https://team.slack.com/archives/C1/p2500002?thread_ts=200.0002&cid=C1',
    },
    {
      ts: '260.0006',
      user: 'U2',
      channel: { id: 'C1', name: 'ezat_claudio' },
      text: 'later <@U9>',
      permalink: 'https://team.slack.com/archives/C1/p2600006?thread_ts=200.0002&cid=C1',
    },
    {
      ts: '270.0007',
      user: 'U1',
      channel: { id: 'C1', name: 'ezat_claudio' },
      text: 'third <@U9> ping',
      permalink: 'https://team.slack.com/archives/C1/p2700007?thread_ts=200.0002&cid=C1',
    },
    // One match in another thread, which is also in the history page.
    {
      ts: '650.0008',
      user: 'U2',
      channel: { id: 'C1', name: 'ezat_claudio' },
      text: 'other <@U9> thread',
      permalink: 'https://team.slack.com/archives/C1/p6500008?thread_ts=600.0006&cid=C1',
    },
  ];
  const routes = {
    'auth.test': () => ({
      ok: true,
      user: 'jommari',
      user_id: 'U9',
      team: 'TeamPathwise',
      team_id: 'T1',
    }),
    'users.list': () => ({
      ok: true,
      members: [
        { id: 'U1', real_name: 'Patrick Rivera', name: 'patrick' },
        { id: 'U2', real_name: 'Yuliia Palamarchuk', name: 'yuliia' },
      ],
    }),
    'conversations.list': () => ({
      ok: true,
      channels: [{ id: 'C1', name: 'ezat_claudio' }],
    }),
    'client.counts': () => ({
      ok: true,
      channels: [{ id: 'C1', mention_count: 2, has_unreads: true }],
      activity_v2: { at_user: 5 },
    }),
    'conversations.history': () => ({
      ok: true,
      messages: [
        // thread started by me, latest reply from Patrick
        {
          ts: '100.0001',
          thread_ts: '100.0001',
          user: 'U9',
          text: 'TAP-1 mine',
          reply_count: 2,
          latest_reply: '300.0003',
        },
        // thread started by someone else, my reply is newest
        {
          ts: '200.0002',
          thread_ts: '200.0002',
          user: 'U2',
          text: 'TAP-2 theirs',
          reply_count: 1,
          latest_reply: '400.0004',
        },
        // a second thread I was mentioned in
        {
          ts: '600.0006',
          thread_ts: '600.0006',
          user: 'U1',
          text: 'TAP-3 theirs',
          reply_count: 1,
          latest_reply: '700.0007',
        },
        // plain message, not a thread
        { ts: '500.0005', user: 'U1', text: 'no replies here' },
      ],
    }),
    'search.messages': (url) => {
      const query = url.searchParams.get('query') || '';
      // `in:<channel>` alone names the channel; `... <@U9>` lists the mentions.
      if (!query.includes('<@'))
        return {
          ok: true,
          messages: { total: 1, matches: [{ channel: { id: 'C1', name: 'ezat_claudio' } }] },
        };
      return { ok: true, messages: { total: mentions.length, matches: mentions } };
    },
    'conversations.replies': (url) => {
      const ts = url.searchParams.get('ts');
      const limit = url.searchParams.get('limit');
      replies.push({ ts, limit });
      const thread = threads[ts];
      if (!thread) return { ok: false, error: 'thread_not_found' };
      return {
        ok: true,
        messages: limit === '1' ? [thread[0], thread[thread.length - 1]] : thread,
      };
    },
  };
  const fetchImpl = async (url) => {
    const method = String(url).split('/api/')[1].split('?')[0];
    calls.push(method);
    const handler = routes[method];
    return new Response(JSON.stringify(handler ? handler(new URL(url)) : { ok: false }));
  };
  return { fetchImpl, calls, replies };
}

test('threads list only my threads and group mentions by their thread', async (t) => {
  const slack = fakeSlack();
  const { paths, integration } = setup(t, { fetchImpl: slack.fetchImpl });
  writeSession(paths);

  const result = await integration.threads();
  assert.equal(result.available, true);
  assert.deepEqual(result.channel, { id: 'C1', name: 'ezat_claudio' });
  assert.equal(result.enriched, false, 'the rows are served before the reply flags');

  assert.equal(result.started.length, 1, 'a plain message is not a thread');
  const mine = result.started[0];
  assert.equal(mine.ts, '100.0001');
  assert.equal(mine.text, 'TAP-1 mine');
  assert.equal(mine.replyCount, 2);

  assert.deepEqual(
    result.mentions.map((row) => row.ts),
    ['600.0006', '200.0002'],
    'one row per thread, newest activity first',
  );

  await settle();
  const before = slack.calls.length;
  const enriched = await integration.threads();
  assert.equal(enriched.enriched, true, 'the reply flags were filled in behind the first call');
  assert.equal(enriched.started[0].needsReply, true, 'Patrick spoke last, so a reply is owed');
  assert.equal(enriched.started[0].latestReplyBy.name, 'Patrick Rivera');
  assert.equal(enriched.mentions[1].needsReply, false, 'my reply is the newest message');
  assert.equal(slack.calls.length, before, 'the result is cached between refreshes');

  const after = slack.calls.length;
  await integration.threads();
  assert.equal(slack.calls.length, after, 'the result is cached between refreshes');
});

test('mention grouping collapses four matches into two threads without re-reading them', async (t) => {
  const slack = fakeSlack();
  const { paths, integration } = setup(t, { fetchImpl: slack.fetchImpl });
  writeSession(paths);

  const result = await integration.threads();
  const tss = result.mentions.map((row) => row.ts);
  assert.deepEqual(tss, ['600.0006', '200.0002']);
  assert.equal(new Set(tss).size, tss.length, 'no thread appears twice');
  assert.equal(
    result.mentions.find((row) => row.ts === '200.0002').text,
    'third @jommari ping',
    'the newest mention of a thread is its preview',
  );

  // Both threads are in the history page, so no match timestamp is ever looked
  // up: only the enrichment calls fetch replies, and always for a thread root.
  const looked = slack.replies.map((entry) => entry.ts);
  for (const ts of ['250.0002', '260.0006', '270.0007', '650.0008'])
    assert.ok(!looked.includes(ts), `${ts} belongs to a thread the history page already has`);
  assert.ok(slack.replies.length > 0, 'the listed threads are still read for their last reply');
  assert.ok(
    slack.replies.every((entry) => entry.limit === '1'),
    'the last reply needs the root and the newest message, nothing more',
  );
  await settle();
});

test('the channel is resolved by search, so conversations.list is never paged', async (t) => {
  const slack = fakeSlack();
  const { paths, integration } = setup(t, { fetchImpl: slack.fetchImpl });
  writeSession(paths);

  const result = await integration.threads();
  assert.deepEqual(result.channel, { id: 'C1', name: 'ezat_claudio' });
  assert.ok(slack.calls.includes('search.messages'));
  assert.ok(!slack.calls.includes('conversations.list'), 'one search names the private channel');
  await settle();
});

test('a channel search cannot see falls back to the paged channel list', async (t) => {
  const slack = fakeSlack();
  const { paths, integration } = setup(t, {
    fetchImpl: async (url) => {
      const target = decodeURIComponent(String(url));
      if (target.includes('/api/search.messages') && !target.includes('<@'))
        return new Response(JSON.stringify({ ok: true, messages: { total: 0, matches: [] } }));
      return slack.fetchImpl(url);
    },
  });
  writeSession(paths);

  const result = await integration.threads();
  assert.deepEqual(result.channel, { id: 'C1', name: 'ezat_claudio' });
  assert.ok(slack.calls.includes('conversations.list'));
  await settle();
});

test('a snapshot past its TTL is served immediately and revalidated once', async (t) => {
  let clock = 1_000_000;
  const slack = fakeSlack();
  const { paths, integration } = setup(t, { fetchImpl: slack.fetchImpl, now: () => clock });
  writeSession(paths);

  await integration.threads();
  await settle();
  const cached = await integration.threads();
  assert.equal(cached.enriched, true);

  clock += 5 * 60 * 1000 + 1;
  const stale = await integration.threads();
  assert.equal(stale, cached, 'the stale snapshot is returned without waiting for a refresh');

  await integration.threads();
  await integration.threads();
  await settle();
  assert.equal(
    slack.calls.filter((method) => method === 'conversations.history').length,
    2,
    'three stale calls start one background refresh',
  );

  const refreshed = await integration.threads();
  assert.notEqual(refreshed, cached, 'the refresh replaced the snapshot');
  assert.equal(refreshed.enriched, true);
});

test('a failed load backs off for a minute instead of retrying on every call', async (t) => {
  const slack = fakeSlack();
  const { paths, integration } = setup(t, {
    fetchImpl: async (url) => {
      if (String(url).includes('/api/conversations.history')) throw new Error('offline');
      return slack.fetchImpl(url);
    },
  });
  writeSession(paths);

  assert.deepEqual(await integration.threads(), { available: false });
  const afterFailure = slack.calls.length;
  assert.ok(afterFailure > 0);

  assert.deepEqual(await integration.threads(), { available: false });
  assert.equal(slack.calls.length, afterFailure, 'nothing is asked inside the backoff window');
});

test('a failed background refresh never downgrades a good snapshot', async (t) => {
  let clock = 1_000_000;
  let offline = false;
  const slack = fakeSlack();
  const { paths, integration } = setup(t, {
    fetchImpl: async (url) => {
      if (offline) throw new Error('offline');
      return slack.fetchImpl(url);
    },
    now: () => clock,
  });
  writeSession(paths);
  const good = await integration.threads();
  await settle();
  assert.equal((await integration.threads()).enriched, true);

  offline = true;
  clock += 5 * 60 * 1000 + 1;
  assert.equal((await integration.threads()).available, true, 'the snapshot survives the failure');
  await settle();
  const after = await integration.threads();
  assert.equal(after.available, true);
  assert.equal(after.started[0].ts, good.started[0].ts);
});

test('disconnect stops a late refresh from repopulating the cache', async (t) => {
  let clock = 1_000_000;
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let holdHistory = false;
  const slack = fakeSlack();
  const { paths, integration } = setup(t, {
    fetchImpl: async (url) => {
      if (holdHistory && String(url).includes('/api/conversations.history')) await held;
      return slack.fetchImpl(url);
    },
    now: () => clock,
  });
  writeSession(paths);
  await integration.threads();
  await settle();

  holdHistory = true;
  clock += 5 * 60 * 1000 + 1;
  await integration.threads(); // starts the refresh, which parks in the history read
  integration.disconnect();
  release();
  await settle();
  holdHistory = false;

  writeSession(paths);
  const before = slack.calls.length;
  const reloaded = await integration.threads();
  assert.ok(slack.calls.length > before, 'the cache was cleared, so the rows are read again');
  assert.equal(reloaded.enriched, false, 'the stale snapshot was not written back');
  await settle();
});

test('pending reports nothing to show while disconnected', async (t) => {
  const slack = fakeSlack();
  const { integration } = setup(t, { fetchImpl: slack.fetchImpl });
  assert.deepEqual(await integration.pending(), { available: false });
  assert.equal(slack.calls.length, 0, 'a disconnected badge never touches Slack');
});

test('pending reports the channel unread mentions and workspace mentions', async (t) => {
  const slack = fakeSlack();
  const { paths, integration } = setup(t, { fetchImpl: slack.fetchImpl });
  writeSession(paths);

  const result = await integration.pending();
  assert.equal(result.available, true);
  assert.deepEqual(result.channel, {
    id: 'C1',
    name: 'ezat_claudio',
    mentions: 2,
    unread: true,
  });
  assert.equal(result.mentionsTotal, 5);
  assert.equal(typeof result.updatedAt, 'string');
  assert.equal(
    new Date(result.updatedAt).toISOString(),
    result.updatedAt,
    'updatedAt is an ISO timestamp',
  );
  assert.ok(slack.calls.includes('client.counts'));
});

test('pending is cached between calls', async (t) => {
  const slack = fakeSlack();
  const { paths, integration } = setup(t, { fetchImpl: slack.fetchImpl });
  writeSession(paths);

  await integration.pending();
  const before = slack.calls.length;
  await integration.pending();
  assert.equal(slack.calls.length, before, 'the badge is served from cache for a minute');
});

test('a rejected client.counts degrades to nothing to show', async (t) => {
  const slack = fakeSlack();
  const { paths, integration } = setup(t, {
    fetchImpl: async (url) => {
      const method = String(url).split('/api/')[1].split('?')[0];
      if (method !== 'client.counts') return slack.fetchImpl(url);
      slack.calls.push(method);
      return new Response(JSON.stringify({ ok: false, error: 'invalid_auth' }));
    },
  });
  writeSession(paths);

  assert.deepEqual(await integration.pending(), { available: false });
});

test('disconnect clears the pending cache so the next call re-fetches', async (t) => {
  const slack = fakeSlack();
  const { paths, integration } = setup(t, { fetchImpl: slack.fetchImpl });
  writeSession(paths);

  await integration.pending();
  const before = slack.calls.length;
  integration.disconnect();
  writeSession(paths);
  await integration.pending();
  assert.ok(slack.calls.length > before, 'the badge is fetched again after reconnecting');
});
