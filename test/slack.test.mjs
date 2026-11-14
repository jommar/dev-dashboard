// slack.test.mjs — the Slack integration must never throw at the dashboard:
// every missing, rejected or unreachable session resolves to "not connected".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createSlackIntegration, slackPaths } from '../backend/slack.mjs';
import { SECRET_ENV_NAMES } from '../backend/config.mjs';
import { parseSlackLink } from '../backend/slack-link.mjs';

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

test('connect starts the sign-in helper without the dashboard credentials', async (t) => {
  const saved = Object.fromEntries(SECRET_ENV_NAMES.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
  for (const name of SECRET_ENV_NAMES) process.env[name] = 'synthetic-secret';
  const options = [];
  const { integration, paths } = setup(t, {
    spawnImpl: (command, args, spawnOptions) => {
      options.push(spawnOptions);
      const child = new EventEmitter();
      child.unref = () => {};
      return child;
    },
  });
  integration.connect();
  const { env } = options[0];
  for (const name of SECRET_ENV_NAMES) assert.equal(name in env, false, `${name} is not passed on`);
  assert.equal(env.SLACK_PROFILE_DIR, paths.profile);
  assert.equal(env.PATH, process.env.PATH, 'the rest of the environment is kept');
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

// Freeze the list and dialog tests just after their synthetic 2026 messages.
const FIXTURE_NOW = 1_793_201_000_000;
const MINE = '1793190100.000100';
const THEIRS = '1793190200.000200';
const OTHER = '1793190600.000600';

function slackMicros(ts) {
  const [seconds, fraction = ''] = ts.split('.');
  return BigInt(seconds) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}

function fakeSlack({ includeDialog = false, missingRootTs = '' } = {}) {
  const calls = [];
  const replies = []; // Parameters for every conversations.replies call.
  const roots = [
    {
      ts: MINE,
      thread_ts: MINE,
      user: 'U9',
      text: 'TAP-1 mine',
      reply_count: 2,
      latest_reply: '1793190300.000300',
    },
    {
      ts: THEIRS,
      thread_ts: THEIRS,
      user: 'U2',
      text: 'TAP-2 theirs',
      reply_count: 4,
      latest_reply: '1793190400.000400',
    },
    {
      ts: OTHER,
      thread_ts: OTHER,
      user: 'U1',
      text: 'TAP-3 theirs',
      reply_count: 2,
      latest_reply: '1793190700.000700',
    },
  ];
  const mentions = [
    // Three matches in one thread, distinct ts, same permalink thread_ts.
    {
      ts: '1793190250.000200',
      user: 'U1',
      channel: { id: 'C1', name: 'ezat_claudio' },
      text: 'hey <@U9> look',
      permalink: `https://team.slack.com/archives/C1/p1793190250000200?thread_ts=${THEIRS}&cid=C1`,
    },
    {
      ts: '1793190260.000600',
      user: 'U2',
      channel: { id: 'C1', name: 'ezat_claudio' },
      text: 'later <@U9>',
      permalink: `https://team.slack.com/archives/C1/p1793190260000600?thread_ts=${THEIRS}&cid=C1`,
    },
    {
      ts: '1793190270.000700',
      user: 'U1',
      channel: { id: 'C1', name: 'ezat_claudio' },
      text: 'third <@U9> ping',
      permalink: `https://team.slack.com/archives/C1/p1793190270000700?thread_ts=${THEIRS}&cid=C1`,
    },
    // One match in another thread, which is also in the history page.
    {
      ts: '1793190650.000800',
      user: 'U2',
      channel: { id: 'C1', name: 'ezat_claudio' },
      text: 'other <@U9> thread',
      permalink: `https://team.slack.com/archives/C1/p1793190650000800?thread_ts=${OTHER}&cid=C1`,
    },
  ];
  const threads = {
    [MINE]: [
      roots[0],
      { ts: '1793190150.000100', thread_ts: MINE, user: 'U9', text: 'An earlier reply' },
      { ts: '1793190300.000300', thread_ts: MINE, user: 'U1', text: 'Latest reply' },
    ],
    [THEIRS]: [
      roots[1],
      ...mentions.slice(0, 3).map((mention) => ({ ...mention, thread_ts: THEIRS })),
      { ts: '1793190400.000400', thread_ts: THEIRS, user: 'U9', text: 'Latest reply' },
    ],
    [OTHER]: [
      roots[2],
      { ...mentions[3], thread_ts: OTHER },
      { ts: '1793190700.000700', thread_ts: OTHER, user: 'U1', text: 'Latest reply' },
    ],
  };
  // The conversation a ticket glyph opens: one root authored by the signed-in
  // user that names Patrick, and two replies from him. Its timestamps are real
  // Slack ones, because `thread()` rejects anything that is not.
  const dialogTs = '1793192214.548389';
  const dialog = [
    {
      ts: dialogTs,
      thread_ts: dialogTs,
      user: 'U9',
      text: 'TAP-1765: CS migration pre-check see thread for details <@U1>',
      reply_count: 2,
      latest_reply: '1793192567.000300',
    },
    {
      ts: '1793192474.000200',
      thread_ts: dialogTs,
      user: 'U1',
      text: 'Looking at it now.',
    },
    {
      ts: '1793192567.000300',
      thread_ts: dialogTs,
      user: 'U1',
      text: 'Done — *Sent using* Slack',
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
    'conversations.history': (url) => ({
      ok: true,
      messages: [
        ...(missingRootTs
          ? [{ ts: missingRootTs, thread_ts: missingRootTs, user: 'U9', reply_count: 0 }]
          : []),
        ...(includeDialog ? [dialog[0]] : []),
        roots[2],
        { ts: '1793190500.000500', user: 'U1', text: 'no replies here' },
        roots[1],
        roots[0],
      ].filter((message) => {
        const oldest = url.searchParams.get('oldest');
        if (!oldest) return true;
        const comparison = slackMicros(message.ts) - slackMicros(oldest);
        return (
          comparison > 0n || (comparison === 0n && url.searchParams.get('inclusive') === 'true')
        );
      }),
    }),
    'search.messages': (url) => {
      const query = url.searchParams.get('query') || '';
      // The one-result channel lookup is separate from the bounded list searches.
      if (url.searchParams.get('count') === '1')
        return {
          ok: true,
          messages: { total: 1, matches: [{ channel: { id: 'C1', name: 'ezat_claudio' } }] },
        };
      if (!query.includes('<@')) return { ok: true, messages: { total: 0, matches: [] } };
      return { ok: true, messages: { total: mentions.length, matches: mentions } };
    },
    'conversations.replies': (url) => {
      const params = Object.fromEntries(url.searchParams);
      replies.push(params);
      const thread = params.ts === dialogTs ? dialog : threads[params.ts];
      if (!thread) return { ok: false, error: 'thread_not_found' };
      const inclusive = params.inclusive === 'true';
      const filtered = thread.filter((message) => {
        const time = slackMicros(message.ts);
        if (params.oldest) {
          const oldest = slackMicros(params.oldest);
          if (time < oldest || (!inclusive && time === oldest)) return false;
        }
        if (params.latest) {
          const latest = slackMicros(params.latest);
          if (time > latest || (!inclusive && time === latest)) return false;
        }
        return true;
      });
      const offset = params.cursor ? Number(params.cursor.replace('reply-', '')) : 0;
      const limit = Number(params.limit || 100);
      const next = offset + limit < filtered.length ? `reply-${offset + limit}` : '';
      return {
        ok: true,
        messages: filtered.slice(offset, offset + limit),
        has_more: Boolean(next),
        response_metadata: { next_cursor: next },
      };
    },
  };
  const fetchImpl = async (url) => {
    const method = String(url).split('/api/')[1].split('?')[0];
    calls.push(method);
    const handler = routes[method];
    return new Response(JSON.stringify(handler ? handler(new URL(url)) : { ok: false }));
  };
  return { fetchImpl, calls, replies, dialogTs };
}

async function primeDialogRoot(integration, ts) {
  const result = await integration.threads();
  assert.equal(result.available, true, 'the shared list is available');
  assert.ok(
    [...result.started, ...result.mentions].some((row) => row.ts === ts),
    'the eligible dialog root is present in the shared list',
  );
  await settle();
}

test('threads list only my threads and group mentions by their thread', async (t) => {
  const slack = fakeSlack();
  const { paths, integration } = setup(t, { fetchImpl: slack.fetchImpl, now: () => FIXTURE_NOW });
  writeSession(paths);

  const result = await integration.threads();
  assert.equal(result.available, true);
  assert.deepEqual(result.channel, { id: 'C1', name: 'ezat_claudio' });
  assert.equal(result.enriched, false, 'the rows are served before the reply flags');

  assert.equal(result.started.length, 1, 'a plain message is not a thread');
  const mine = result.started[0];
  assert.equal(mine.ts, MINE);
  assert.equal(mine.text, 'TAP-1 mine');
  assert.equal(mine.replyCount, 2);

  assert.deepEqual(
    result.mentions.map((row) => row.ts),
    [OTHER, THEIRS],
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

test('mention grouping collapses four matches into two threads without treating matches as roots', async (t) => {
  const slack = fakeSlack();
  const { paths, integration } = setup(t, { fetchImpl: slack.fetchImpl, now: () => FIXTURE_NOW });
  writeSession(paths);

  const result = await integration.threads();
  const tss = result.mentions.map((row) => row.ts);
  assert.deepEqual(tss, [OTHER, THEIRS]);
  assert.equal(new Set(tss).size, tss.length, 'no thread appears twice');
  assert.equal(
    result.mentions.find((row) => row.ts === THEIRS).text,
    'third @jommari ping',
    'the newest mention of a thread is its preview',
  );

  // Both threads are in the history page. Candidate scans and enrichment must
  // read their roots, never mistake individual match timestamps for roots.
  await settle();
  const looked = slack.replies.map((entry) => entry.ts);
  for (const ts of [
    '1793190250.000200',
    '1793190260.000600',
    '1793190270.000700',
    '1793190650.000800',
  ])
    assert.ok(!looked.includes(ts), `${ts} belongs to a thread the history page already has`);
  assert.ok(slack.replies.length > 0, 'the listed threads are still read for their last reply');
  assert.ok(
    slack.replies.every((entry) => [MINE, THEIRS, OTHER].includes(entry.ts)),
    'reply reads always target a verified root',
  );
});

test('the channel is resolved by search, so conversations.list is never paged', async (t) => {
  const slack = fakeSlack();
  const { paths, integration } = setup(t, { fetchImpl: slack.fetchImpl, now: () => FIXTURE_NOW });
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
    now: () => FIXTURE_NOW,
  });
  writeSession(paths);

  const result = await integration.threads();
  assert.deepEqual(result.channel, { id: 'C1', name: 'ezat_claudio' });
  assert.ok(slack.calls.includes('conversations.list'));
  await settle();
});

test('a snapshot past its TTL is served immediately and revalidated once', async (t) => {
  let clock = FIXTURE_NOW;
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
  assert.equal(stale.stale, true, 'the old snapshot is labelled while refresh is in flight');
  assert.ok(!stale.partialReasons.includes('refresh_failed'), 'a pending refresh is not a failure');

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
      const target = new URL(url);
      if (
        target.pathname.endsWith('/conversations.history') ||
        (target.pathname.endsWith('/search.messages') && target.searchParams.get('count') !== '1')
      )
        throw new Error('offline');
      return slack.fetchImpl(url);
    },
    now: () => FIXTURE_NOW,
  });
  writeSession(paths);

  const first = await integration.threads();
  assert.equal(first.available, true);
  assert.deepEqual(first.started, []);
  assert.equal(first.partial, true);
  assert.ok(first.partialReasons.includes('history_unavailable'));
  assert.ok(first.continuation);
  const afterFailure = slack.calls.length;
  assert.ok(afterFailure > 0);

  const second = await integration.threads();
  assert.equal(second.available, true);
  assert.deepEqual(second.started, []);
  assert.equal(second.partial, true);
  assert.ok(second.partialReasons.includes('history_unavailable'));
  assert.equal(slack.calls.length, afterFailure, 'nothing is asked inside the backoff window');
});

test('a failed background refresh removes unconfirmed rows until recovery', async (t) => {
  let clock = FIXTURE_NOW;
  let offline = false;
  let offlineRequests = 0;
  const slack = fakeSlack();
  const { paths, integration } = setup(t, {
    fetchImpl: async (url) => {
      if (offline) {
        offlineRequests++;
        throw new Error('offline');
      }
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
  assert.equal((await integration.threads()).available, true, 'the pending refresh is nonblocking');
  await settle();
  const after = await integration.threads();
  assert.equal(after.available, true);
  assert.deepEqual(after.started, []);
  assert.deepEqual(after.mentions, []);
  assert.equal(after.partial, true);
  assert.ok(after.partialReasons.includes('refresh_failed'));
  const attempts = offlineRequests;
  await integration.threads();
  assert.equal(offlineRequests, attempts, 'a failed refresh respects its retry backoff');

  offline = false;
  clock += 60_001;
  const recovered = await integration.threads();
  await settle();
  assert.equal(recovered.available, true);
  assert.equal(recovered.started[0].ts, good.started[0].ts);
});

test('disconnect stops a late refresh from repopulating the cache', async (t) => {
  let clock = FIXTURE_NOW;
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
  assert.equal((await integration.threads()).available, true, 'the initial snapshot must load');
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

// A fake that answers `conversations.replies` from a scripted page list,
// selecting each subsequent page by the cursor returned by the previous one.
function pagedSlack(pages, root) {
  const calls = [];
  const fetchImpl = async (url) => {
    const target = new URL(url);
    const method = target.pathname.split('/').pop();
    calls.push({ method, params: Object.fromEntries(target.searchParams) });
    if (method === 'auth.test')
      return new Response(
        JSON.stringify({
          ok: true,
          user: 'jommari',
          user_id: 'U9',
          team: 'TeamPathwise',
          team_id: 'T1',
        }),
      );
    if (method === 'search.messages' && target.searchParams.get('count') === '1')
      return new Response(
        JSON.stringify({
          ok: true,
          messages: { total: 1, matches: [{ channel: { id: 'C1', name: 'ezat_claudio' } }] },
        }),
      );
    if (method === 'search.messages')
      return new Response(JSON.stringify({ ok: true, messages: { total: 0, matches: [] } }));
    if (method === 'conversations.history')
      return new Response(JSON.stringify({ ok: true, messages: [root] }));
    if (method === 'users.list')
      return new Response(
        JSON.stringify({ ok: true, members: [{ id: 'U1', real_name: 'Patrick Rivera' }] }),
      );
    if (method === 'conversations.replies') {
      const cursor = target.searchParams.get('cursor');
      const preceding = cursor ? pages.findIndex((page) => page.cursor === cursor) : -1;
      if (cursor && (preceding < 0 || preceding + 1 >= pages.length))
        return new Response(JSON.stringify({ ok: false, error: 'invalid_cursor' }));
      const page = pages[preceding + 1];
      return new Response(
        JSON.stringify({
          ok: true,
          messages: page.messages,
          has_more: Boolean(page.cursor),
          response_metadata: { next_cursor: page.cursor || '' },
        }),
      );
    }
    return new Response(JSON.stringify({ ok: false }));
  };
  return { fetchImpl, calls };
}

test('a ticket thread comes back as the exact dialog shape', async (t) => {
  const clock = FIXTURE_NOW;
  const slack = fakeSlack({ includeDialog: true });
  const { paths, integration } = setup(t, { fetchImpl: slack.fetchImpl, now: () => clock });
  writeSession(paths);

  assert.deepEqual(await integration.thread(slack.dialogTs), { available: false });
  assert.equal(slack.calls.length, 0, 'an unverified root never reaches Slack');
  await primeDialogRoot(integration, slack.dialogTs);
  const beforeDialog = slack.replies.length;
  const result = await integration.thread(slack.dialogTs);
  assert.equal(result.available, true);
  const { thread } = result;
  assert.equal(thread.ts, slack.dialogTs);
  assert.equal(
    thread.url,
    `https://app.slack.com/client/T1/C1/thread/C1-${slack.dialogTs}`,
    'the link opens this thread in the workspace',
  );
  assert.deepEqual(thread.channel, { id: 'C1', name: 'ezat_claudio' });
  assert.equal(thread.replyCount, 2, 'every message except the root is a reply');
  assert.equal(thread.truncated, false);
  assert.equal(thread.updatedAt, new Date(clock).toISOString());

  assert.deepEqual(
    thread.messages.map((message) => message.ts),
    [slack.dialogTs, '1793192474.000200', '1793192567.000300'],
    'Slack order: root first, then oldest to newest',
  );
  const [root, reply] = thread.messages;
  assert.deepEqual(root.author, { id: 'U9', name: 'You' }, 'the signed-in user reads as You');
  assert.equal(reply.author.name, 'Patrick Rivera');
  assert.equal(
    root.text,
    'TAP-1765: CS migration pre-check see thread for details @Patrick Rivera',
    'the mention is resolved to a name in the plain form',
  );
  assert.match(root.mrkdwn, /<@U1>/, 'the raw text keeps Slack’s own mention syntax');
  assert.equal(root.mrkdwn, 'TAP-1765: CS migration pre-check see thread for details <@U1>');
  assert.equal(thread.messages[2].text, 'Done — Sent using Slack', 'emphasis is plain text only');

  assert.deepEqual(thread.names, { U9: 'You', U1: 'Patrick Rivera' });
  assert.equal('U2' in thread.names, false, 'only the ids this thread actually names travel');
  assert.equal(thread.messages[0].at, new Date(1793192214 * 1000).toISOString());

  const dialogCall = slack.replies.slice(beforeDialog).find((entry) => entry.ts === slack.dialogTs);
  assert.equal(dialogCall.limit, '200', 'the whole conversation is read in one generous page');
});

test('a thread opened twice in a minute is served from cache', async (t) => {
  let clock = FIXTURE_NOW;
  const slack = fakeSlack({ includeDialog: true });
  const { paths, integration } = setup(t, { fetchImpl: slack.fetchImpl, now: () => clock });
  writeSession(paths);
  await primeDialogRoot(integration, slack.dialogTs);

  assert.equal((await integration.thread(slack.dialogTs)).available, true);
  const before = slack.calls.length;
  const cached = await integration.thread(slack.dialogTs);
  assert.equal(cached.available, true);
  assert.equal(slack.calls.length, before, 'reopening the dialog asks Slack nothing');

  clock += 60_001;
  await integration.thread(slack.dialogTs);
  assert.ok(slack.calls.length > before, 'past the minute the conversation is read again');
});

test('a malformed ts is refused before Slack is asked anything', async (t) => {
  const slack = fakeSlack();
  const { paths, integration } = setup(t, { fetchImpl: slack.fetchImpl });
  writeSession(paths);

  for (const ts of ['abc', '', undefined, '1793192214', '1793192214.1'])
    assert.deepEqual(await integration.thread(ts), { available: false });
  assert.equal(slack.calls.length, 0, 'a bad ts never reaches the network');
});

test('a thread Slack refuses to open degrades to not available', async (t) => {
  const ts = '1793199999.000001';
  const slack = fakeSlack({ missingRootTs: ts });
  const { paths, integration } = setup(t, { fetchImpl: slack.fetchImpl, now: () => FIXTURE_NOW });
  writeSession(paths);
  await primeDialogRoot(integration, ts);
  const beforeDialog = slack.replies.length;

  // Slack listed the root, but now refuses the conversation as unavailable.
  const result = await integration.thread(ts);
  assert.deepEqual(result, { available: false });
  assert.equal('thread' in result, false);
  assert.ok(slack.replies.slice(beforeDialog).some((entry) => entry.ts === ts));
});

test('disconnect clears the thread cache', async (t) => {
  const slack = fakeSlack({ includeDialog: true });
  const { paths, integration } = setup(t, { fetchImpl: slack.fetchImpl, now: () => FIXTURE_NOW });
  writeSession(paths);
  await primeDialogRoot(integration, slack.dialogTs);

  assert.equal((await integration.thread(slack.dialogTs)).available, true);
  const before = slack.calls.length;
  assert.equal((await integration.thread(slack.dialogTs)).available, true);
  assert.equal(slack.calls.length, before, 'the second open is cached');

  integration.disconnect();
  assert.deepEqual(
    await integration.thread(slack.dialogTs),
    { available: false },
    'without a session there is nothing to open',
  );
  assert.equal(slack.calls.length, before, 'and Slack is not asked');

  writeSession(paths);
  assert.deepEqual(await integration.thread(slack.dialogTs), { available: false });
  assert.equal(slack.calls.length, before, 'a new session cannot reuse the old verified root');
  await primeDialogRoot(integration, slack.dialogTs);
  const beforeReopen = slack.calls.length;
  assert.equal((await integration.thread(slack.dialogTs)).available, true);
  assert.ok(slack.calls.length > beforeReopen, 'the conversation is read again after reconnecting');
});

test('a long thread is read page by page and keeps Slack order', async (t) => {
  const ts = '1793193000.000001';
  const slack = pagedSlack(
    [
      {
        messages: [
          { ts, thread_ts: ts, user: 'U9', text: 'root' },
          { ts: '1793193010.000100', thread_ts: ts, user: 'U1', text: 'first page reply' },
        ],
        cursor: 'page-2',
      },
      {
        messages: [
          { ts: '1793193020.000200', thread_ts: ts, user: 'U1', text: 'second page reply' },
        ],
        cursor: '',
      },
    ],
    {
      ts,
      thread_ts: ts,
      user: 'U9',
      text: 'root',
      reply_count: 2,
      latest_reply: '1793193020.000200',
    },
  );
  const { paths, integration } = setup(t, { fetchImpl: slack.fetchImpl, now: () => FIXTURE_NOW });
  writeSession(paths);
  await primeDialogRoot(integration, ts);
  const beforeDialog = slack.calls.length;

  const result = await integration.thread(ts);
  assert.equal(result.available, true);
  assert.equal(result.thread.truncated, false);
  assert.deepEqual(
    result.thread.messages.map((message) => message.text),
    ['root', 'first page reply', 'second page reply'],
  );

  const reads = slack.calls
    .slice(beforeDialog)
    .filter((entry) => entry.method === 'conversations.replies');
  assert.equal(reads.length, 2, 'the cursor buys exactly one more page');
  assert.equal(reads[0].params.cursor, undefined);
  assert.equal(reads[1].params.cursor, 'page-2');
  assert.equal(reads[1].params.limit, '200');
});

test('a thread with more than three pages is flagged as truncated', async (t) => {
  const ts = '1793193000.000001';
  const page = (n) => ({
    messages: [
      {
        ts: n === 1 ? ts : `17931930${n}0.00000${n}`,
        thread_ts: ts,
        user: n === 1 ? 'U9' : 'U1',
        text: `page ${n}`,
      },
    ],
    cursor: `page-${n + 1}`,
  });
  const slack = pagedSlack([page(1), page(2), page(3)], {
    ts,
    thread_ts: ts,
    user: 'U9',
    text: 'page 1',
    reply_count: 3,
    latest_reply: '1793193040.000004',
  });
  const { paths, integration } = setup(t, { fetchImpl: slack.fetchImpl, now: () => FIXTURE_NOW });
  writeSession(paths);
  await primeDialogRoot(integration, ts);
  const beforeDialog = slack.calls.length;

  const result = await integration.thread(ts);
  assert.equal(result.available, true);
  assert.equal(result.thread.truncated, true, 'a cursor still remained after the third page');
  assert.equal(
    slack.calls.slice(beforeDialog).filter((entry) => entry.method === 'conversations.replies')
      .length,
    3,
    'paging stops at three pages',
  );
  assert.equal(result.thread.replyCount, 2);
});

// --- the session watcher's reader: any channel, one thread, to the end -----------------------

const WATCH_CHANNEL = 'C0OTHER001';
const WATCH_THREAD_TS = '1793200000.000100';
const WATCH_TEXT_SENTINEL = 'sentinel-body-';
const WATCH_NEWEST = { user: 'U4', ts: '1793200449.000549' };

const jsonResponse = (body, init) => new Response(JSON.stringify(body), init);

const authAccepted = () =>
  jsonResponse({ ok: true, user: 'jommari', user_id: 'U9', team: 'TeamPathwise', team_id: 'T1' });

// Answers each Slack method from `routes[method](params, callNumber)` and records
// every call, so a test can say which methods were asked and with what.
function recordingSlack(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    const target = new URL(url);
    const method = target.pathname.split('/').pop();
    const params = Object.fromEntries(target.searchParams);
    calls.push({ method, params });
    const route = routes[method];
    if (!route) return jsonResponse({ ok: false, error: 'unknown_method' });
    return route(params, calls.filter((entry) => entry.method === method).length);
  };
  const named = (method) => calls.filter((entry) => entry.method === method);
  return { fetchImpl, calls, named };
}

function watchMessage(index) {
  return {
    ts: `${1793200000 + index}.${String(100 + index).padStart(6, '0')}`,
    thread_ts: WATCH_THREAD_TS,
    user: index === 449 ? WATCH_NEWEST.user : ['U1', 'U2', 'U3'][index % 3],
    text: `${WATCH_TEXT_SENTINEL}${index}`,
  };
}

const watchThread = Array.from({ length: 450 }, (_, index) => watchMessage(index));

const watchPages = {
  first: { messages: watchThread.slice(0, 200), next: 'cursor-page-2' },
  'cursor-page-2': { messages: watchThread.slice(200, 400), next: 'cursor-page-3' },
  'cursor-page-3': { messages: watchThread.slice(400), next: '' },
};

function watchRepliesPage(params) {
  const page = watchPages[params.cursor || 'first'];
  if (params.channel !== WATCH_CHANNEL || params.ts !== WATCH_THREAD_TS || !page)
    return jsonResponse({ ok: false, error: 'thread_not_found' });
  return jsonResponse({
    ok: true,
    messages: page.messages,
    has_more: Boolean(page.next),
    response_metadata: { next_cursor: page.next },
  });
}

// Every page is full and names a next one, however far the reader goes.
function endlessRepliesPage(params, callNumber) {
  const messages = Array.from({ length: 200 }, (_, index) => ({
    ts: `${1793200000 + callNumber * 1000 + index}.${String(index + 1).padStart(6, '0')}`,
    thread_ts: WATCH_THREAD_TS,
    user: 'U1',
    text: `${WATCH_TEXT_SENTINEL}endless-${callNumber}-${index}`,
  }));
  return jsonResponse({
    ok: true,
    messages,
    has_more: true,
    response_metadata: { next_cursor: `cursor-${callNumber + 1}` },
  });
}

async function readWatched(integration, overrides = {}) {
  let result;
  await assert.doesNotReject(async () => {
    result = await integration.lastInThread({
      channelId: WATCH_CHANNEL,
      threadTs: WATCH_THREAD_TS,
      asOfTs: '1793300000.000000',
      ...overrides,
    });
  }, 'a read never throws at the watcher');
  return result;
}

test('watch reader pages a 450-message thread in another channel to the end', async (t) => {
  const slack = recordingSlack({
    'auth.test': authAccepted,
    'conversations.replies': watchRepliesPage,
  });
  const { paths, integration } = setup(t, { fetchImpl: slack.fetchImpl });
  writeSession(paths);

  const result = await readWatched(integration, { asOfTs: '1793300000.000000' });
  assert.equal(result.ok, true);
  assert.equal(result.me, 'U9', 'the signed-in user id comes from auth.test');
  assert.deepEqual(result.last, WATCH_NEWEST, 'the newest author and ts, from the last page');
  assert.equal(result.asOf, WATCH_NEWEST.ts, 'nothing is newer than the bound');

  const reads = slack.named('conversations.replies');
  assert.equal(reads.length, 3, 'three pages, no more');
  for (const read of reads) {
    assert.equal(read.params.channel, WATCH_CHANNEL, 'the given channel, not the hard-wired one');
    assert.equal(read.params.ts, WATCH_THREAD_TS);
  }
  assert.ok(!reads[0].params.cursor, 'the first page starts without a cursor');
  assert.equal(reads[1].params.cursor, 'cursor-page-2');
  assert.equal(reads[2].params.cursor, 'cursor-page-3');
});

test('watch reader asks Slack only auth.test and conversations.replies', async (t) => {
  const slack = recordingSlack({
    'auth.test': authAccepted,
    'conversations.replies': watchRepliesPage,
  });
  const { paths, integration } = setup(t, { fetchImpl: slack.fetchImpl });
  writeSession(paths);

  assert.equal((await readWatched(integration)).ok, true);
  const methods = [...new Set(slack.calls.map((entry) => entry.method))].sort();
  assert.deepEqual(methods, ['auth.test', 'conversations.replies']);
});

test('watch reader returns no message text', async (t) => {
  const slack = recordingSlack({
    'auth.test': authAccepted,
    'conversations.replies': watchRepliesPage,
  });
  const { paths, integration } = setup(t, { fetchImpl: slack.fetchImpl });
  writeSession(paths);

  const result = await readWatched(integration);
  assert.equal(result.ok, true);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(WATCH_TEXT_SENTINEL));
});

test('watch reader reports the newest ts at or before asOfTs', async (t) => {
  const cases = [
    { label: 'after everything', asOfTs: '1793300000.000000', asOf: '1793200449.000549' },
    { label: 'exactly on a message', asOfTs: '1793200399.000499', asOf: '1793200399.000499' },
    { label: 'between two messages', asOfTs: '1793200250.999999', asOf: '1793200250.000350' },
    { label: 'a microsecond short of one', asOfTs: '1793200250.000349', asOf: '1793200249.000349' },
    { label: 'before the root', asOfTs: '1793199999.999999', asOf: null },
  ];
  for (const { label, asOfTs, asOf } of cases) {
    const slack = recordingSlack({
      'auth.test': authAccepted,
      'conversations.replies': watchRepliesPage,
    });
    const { paths, integration } = setup(t, { fetchImpl: slack.fetchImpl });
    writeSession(paths);

    const result = await readWatched(integration, { asOfTs });
    assert.equal(result.ok, true, label);
    assert.equal(result.asOf, asOf, label);
    assert.deepEqual(result.last, WATCH_NEWEST, `${label}: the newest message is unaffected`);
  }
});

test('watch reader gives up on a thread past the page ceiling', async (t) => {
  const slack = recordingSlack({
    'auth.test': authAccepted,
    'conversations.replies': endlessRepliesPage,
  });
  const { paths, integration } = setup(t, { fetchImpl: slack.fetchImpl });
  writeSession(paths);

  const result = await readWatched(integration);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'too_long');
  assert.equal('last' in result, false, 'never a guess at the newest message');
  assert.ok(
    slack.named('conversations.replies').length <= 20,
    'at most twenty pages are ever requested',
  );
});

// --- reader failures: every class is a result, never an exception ------------------------------

const RETRY_AFTER_SECONDS = 30;
const FAILURE_CHANNEL = 'C024BE91L';
const FAILURE_THREAD_TS = '1793192214.548389';

const rateLimited = (body) =>
  new Response(body, { status: 429, headers: { 'Retry-After': String(RETRY_AFTER_SECONDS) } });
const slackError = (error) => jsonResponse({ ok: false, error });
const oneReply = () =>
  jsonResponse({
    ok: true,
    messages: [{ ts: FAILURE_THREAD_TS, thread_ts: FAILURE_THREAD_TS, user: 'U1', text: 'x' }],
    response_metadata: { next_cursor: '' },
  });

// `answer` is how the failing call responds; the other call succeeds.
function failingAt(location, answer) {
  return recordingSlack({
    'auth.test': location === 'auth.test' ? answer : authAccepted,
    'conversations.replies': location === 'conversations.replies' ? answer : oneReply,
  });
}

async function readFailure(t, slack) {
  const { paths, integration } = setup(t, { fetchImpl: slack.fetchImpl });
  writeSession(paths);
  const result = await readWatched(integration, {
    channelId: FAILURE_CHANNEL,
    threadTs: FAILURE_THREAD_TS,
    asOfTs: '1793192474.000200',
  });
  assert.equal(result.ok, false);
  assert.equal('last' in result, false, 'a failed read never carries a newest message');
  return result;
}

test('reader failure: HTTP 429 with Retry-After is rate_limited with the delay', async (t) => {
  const bodies = ['', JSON.stringify({ ok: false, error: 'ratelimited' })];
  for (const location of ['conversations.replies', 'auth.test']) {
    for (const body of bodies) {
      const result = await readFailure(
        t,
        failingAt(location, () => rateLimited(body)),
      );
      const label = `${location} with body ${JSON.stringify(body)}`;
      assert.equal(result.reason, 'rate_limited', label);
      assert.equal(result.retryAfterSeconds, RETRY_AFTER_SECONDS, label);
    }
  }
});

test('reader failure: a ratelimited answer in a 200 body is rate_limited', async (t) => {
  for (const location of ['conversations.replies', 'auth.test']) {
    const result = await readFailure(
      t,
      failingAt(location, () => slackError('ratelimited')),
    );
    assert.equal(result.reason, 'rate_limited', location);
  }
});

test('reader failure: invalid_auth and token_revoked are session_rejected', async (t) => {
  for (const location of ['auth.test', 'conversations.replies']) {
    for (const error of ['invalid_auth', 'token_revoked']) {
      const result = await readFailure(
        t,
        failingAt(location, () => slackError(error)),
      );
      assert.equal(result.reason, 'session_rejected', `${error} from ${location}`);
    }
  }
});

test('reader failure: no stored session is not_connected without any Slack call', async (t) => {
  const { integration, calls } = setup(t);
  const result = await readWatched(integration, {
    channelId: FAILURE_CHANNEL,
    threadTs: FAILURE_THREAD_TS,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_connected');
  assert.equal('last' in result, false);
  assert.equal(calls.length, 0, 'a disconnected reader never touches Slack');
});

test('reader failure: a network error is unavailable', async (t) => {
  const unreachable = () => {
    throw new Error('offline');
  };
  const everything = recordingSlack({
    'auth.test': unreachable,
    'conversations.replies': unreachable,
  });
  assert.equal((await readFailure(t, everything)).reason, 'unavailable', 'nothing answers');
  const repliesOnly = failingAt('conversations.replies', unreachable);
  assert.equal(
    (await readFailure(t, repliesOnly)).reason,
    'unavailable',
    'auth.test answers and the thread read fails',
  );
});

const PER_THREAD_ERRORS = [
  'thread_not_found',
  'channel_not_found',
  'not_in_channel',
  'missing_scope',
];

test('reader failure: an error of one thread is thread_unreadable, never unavailable', async (t) => {
  for (const error of PER_THREAD_ERRORS) {
    const result = await readFailure(
      t,
      failingAt('conversations.replies', () => slackError(error)),
    );
    assert.equal(result.reason, 'thread_unreadable', error);
  }
});

test('reader failure: a forged but well-formed link is thread_unreadable', async (t) => {
  const slack = recordingSlack({
    'auth.test': authAccepted,
    'conversations.replies': watchRepliesPage,
  });
  const { paths, integration } = setup(t, { fetchImpl: slack.fetchImpl });
  writeSession(paths);

  const result = await readWatched(integration, { threadTs: '9999999999.999999' });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'thread_unreadable');
  assert.equal('last' in result, false, 'a failed read never carries a newest message');
});

test('reader failure: an HTTP 5xx from either call is unavailable', async (t) => {
  for (const location of ['auth.test', 'conversations.replies']) {
    for (const status of [500, 503]) {
      const result = await readFailure(
        t,
        failingAt(location, () => new Response('upstream failure', { status })),
      );
      assert.equal(result.reason, 'unavailable', `HTTP ${status} from ${location}`);
    }
  }
});

// --- the key the watch list files a thread under, handed out with every thread ---------------

// The fakes above use short ids that the link parser rightly refuses, so the key parity checks
// run against workspace and channel ids shaped like Slack's own.
function realShapedSlack({ teamId, channelId, ts }) {
  const root = { ts, thread_ts: ts, user: 'U9', text: 'TAP-1: invented root', reply_count: 0 };
  const answers = {
    'auth.test': {
      ok: true,
      user: 'example_user',
      user_id: 'U9',
      team: 'Example Workspace',
      ...(teamId && { team_id: teamId }),
    },
    'search.messages': {
      ok: true,
      messages: { total: 1, matches: [{ channel: { id: channelId, name: 'example_channel' } }] },
    },
    'users.list': { ok: true, members: [{ id: 'U1', real_name: 'Sam Example' }] },
    'conversations.history': { ok: true, messages: [root] },
    'conversations.replies': {
      ok: true,
      messages: [root],
      response_metadata: {},
    },
  };
  const fetchImpl = async (url) => {
    const target = new URL(url);
    const method = target.pathname.split('/').pop();
    if (method === 'search.messages' && target.searchParams.get('count') !== '1')
      return new Response(JSON.stringify({ ok: true, messages: { total: 0, matches: [] } }));
    return new Response(JSON.stringify(answers[method] ?? { ok: false }));
  };
  return { fetchImpl };
}

test('thread watch key: the thread read carries the key derived from its own link', async (t) => {
  const ts = '1793192214.548389';
  const slack = realShapedSlack({ teamId: 'T0EXAMPLE1', channelId: 'C0EXAMPLE1', ts });
  const { paths, integration } = setup(t, { fetchImpl: slack.fetchImpl, now: () => FIXTURE_NOW });
  writeSession(paths);
  await primeDialogRoot(integration, ts);

  const { thread } = await integration.thread(ts);
  assert.equal(
    thread.url,
    'https://app.slack.com/client/T0EXAMPLE1/C0EXAMPLE1/thread/C0EXAMPLE1-1793192214.548389',
  );
  assert.equal(thread.watchKey, 'C0EXAMPLE1:1793192214.548389');
  assert.equal(parseSlackLink(thread.url).key, thread.watchKey);
});

test('thread watch key: a thread read without a workspace id has no link and an empty key', async (t) => {
  const ts = '1793192214.548389';
  const slack = realShapedSlack({ teamId: '', channelId: 'C0EXAMPLE1', ts });
  const { paths, integration } = setup(t, { fetchImpl: slack.fetchImpl, now: () => FIXTURE_NOW });
  writeSession(paths, { teamId: '' });
  await primeDialogRoot(integration, ts);

  const result = await integration.thread(ts);
  assert.equal(result.available, true);
  assert.equal(result.thread.url, '');
  assert.equal(result.thread.watchKey, '');
});

test('thread watch key: every started and mentions row carries the key of its own thread', async (t) => {
  const slack = fakeSlack();
  const { paths, integration } = setup(t, { fetchImpl: slack.fetchImpl, now: () => FIXTURE_NOW });
  writeSession(paths);

  const result = await integration.threads();
  assert.deepEqual(
    result.started.map((row) => row.watchKey),
    [`C1:${MINE}`],
  );
  assert.deepEqual(
    result.mentions.map((row) => row.watchKey),
    [`C1:${OTHER}`, `C1:${THEIRS}`],
  );
  await settle();
});
