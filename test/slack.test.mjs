// slack.test.mjs — the Slack integration must never throw at the dashboard:
// every missing, rejected or unreachable session resolves to "not connected".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createSlackIntegration, slackPaths } from '../backend/slack.mjs';

function setup(t, { fetchImpl, spawnImpl } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = slackPaths(home);
  fs.mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  const calls = [];
  const spawned = [];
  const integration = createSlackIntegration({
    paths,
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

function fakeSlack() {
  const calls = [];
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
        // plain message, not a thread
        { ts: '500.0005', user: 'U1', text: 'no replies here' },
      ],
    }),
    'search.messages': () => ({
      ok: true,
      messages: {
        total: 1,
        matches: [
          {
            ts: '250.0002',
            thread_ts: '200.0002',
            user: 'U1',
            channel: { id: 'C1', name: 'ezat_claudio' },
            text: 'hey <@U9> look',
          },
        ],
      },
    }),
    'conversations.replies': (url) => {
      const ts = url.searchParams.get('ts');
      if (ts === '100.0001')
        return {
          ok: true,
          messages: [
            { ts, user: 'U9' },
            { ts: '300.0003', user: 'U1' },
          ],
        };
      if (ts === '200.0002')
        return {
          ok: true,
          messages: [
            { ts, user: 'U2' },
            { ts: '400.0004', user: 'U9' },
          ],
        };
      return { ok: false, error: 'thread_not_found' };
    },
  };
  const fetchImpl = async (url) => {
    const method = String(url).split('/api/')[1].split('?')[0];
    calls.push(method);
    const handler = routes[method];
    return new Response(JSON.stringify(handler ? handler(new URL(url)) : { ok: false }));
  };
  return { fetchImpl, calls };
}

test('threads list only my threads and only grouped mentions, newest activity first', async (t) => {
  const slack = fakeSlack();
  const { paths, integration } = setup(t, { fetchImpl: slack.fetchImpl });
  writeSession(paths);

  const result = await integration.threads();
  assert.equal(result.available, true);
  assert.deepEqual(result.channel, { id: 'C1', name: 'ezat_claudio' });

  assert.equal(result.started.length, 1, 'a plain message is not a thread');
  const mine = result.started[0];
  assert.equal(mine.ts, '100.0001');
  assert.equal(mine.text, 'TAP-1 mine');
  assert.equal(mine.replyCount, 2);
  assert.equal(mine.needsReply, true, 'Patrick spoke last, so a reply is owed');
  assert.equal(mine.latestReplyBy.name, 'Patrick Rivera');

  assert.equal(result.mentions.length, 1);
  const mention = result.mentions[0];
  assert.equal(mention.ts, '200.0002', 'the mention resolves to its thread root');
  assert.equal(mention.text, 'hey @jommari look');
  assert.equal(mention.author.name, 'Patrick Rivera');
  assert.equal(mention.needsReply, false, 'my reply is the newest message');

  const before = slack.calls.length;
  await integration.threads();
  assert.equal(slack.calls.length, before, 'the result is cached between refreshes');
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
