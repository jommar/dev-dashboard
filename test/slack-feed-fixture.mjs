// slack-feed-fixture.mjs — a synthetic Slack for the Activity feed tests: a scripted `fetchImpl` that
// answers auth.test, users.list, activity.feed, conversations.replies and conversations.info from
// plain data, and records every method with its parameters. Every id, name and text is made up.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSlackIntegration, slackPaths } from '../backend/slack.mjs';

export const ME = 'U0EXAMPLEME';
export const ALEX = 'U0EXAMPLE1';
export const SAM = 'U0EXAMPLE2';
export const TEAM = 'T0EXAMPLE';
export const NOW_MS = 1_793_201_000_000;
const BASE_SECONDS = 1_793_190_000;

// A Slack timestamp `n` seconds after the base, unique per `n` and per `micro`.
export const tsOf = (n, micro = 100) => `${BASE_SECONDS + n}.${String(micro).padStart(6, '0')}`;

// Activity items, in the envelope the web client's `activity.feed` returns.
export function mentionItem({
  key,
  type = 'at_user',
  channel,
  ts,
  threadTs,
  feedTs = ts,
  unread = false,
  author = ALEX,
}) {
  return {
    key,
    feed_ts: feedTs,
    is_unread: unread,
    item: {
      type,
      message: {
        ts,
        channel,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        author_user_id: author,
      },
    },
  };
}

export function threadItem({
  key,
  channel,
  threadTs,
  latestTs,
  feedTs = latestTs,
  unreadCount = 1,
  unread = true,
}) {
  return {
    key,
    feed_ts: feedTs,
    is_unread: unread,
    item: {
      type: 'thread_v2',
      bundle_info: {
        payload: {
          thread_entry: {
            channel_id: channel,
            thread_ts: threadTs,
            latest_ts: latestTs,
            unread_msg_count: unreadCount,
          },
        },
      },
    },
  };
}

export function reactionItem({ key, channel, ts, feedTs = ts, by = ALEX, name = 'eyes', unread }) {
  return {
    key,
    feed_ts: feedTs,
    is_unread: unread ?? false,
    item: { type: 'message_reaction', message: { ts, channel }, reaction: { user: by, name } },
  };
}

// `messages` is keyed `<channel>:<ts>`. A thread request (one with `oldest`) answers the parent
// (`ts`) and the message at `oldest`; any other answers the one message at `ts`.
export function createFeedSlack({ items = [], messages = {}, channels = {}, activityV2 } = {}) {
  const calls = [];
  let intercept = null;

  function answer(method, params) {
    if (method === 'auth.test')
      return Response.json({
        ok: true,
        user: 'me-example',
        user_id: ME,
        team: 'Team',
        team_id: TEAM,
      });
    if (method === 'users.list')
      return Response.json({
        ok: true,
        members: [
          { id: ME, real_name: 'Me Example', name: 'me' },
          { id: ALEX, real_name: 'Alex Example', name: 'alex' },
          { id: SAM, real_name: 'Sam Sample', name: 'sam' },
        ],
      });
    if (method === 'activity.feed') return Response.json({ ok: true, items });
    if (method === 'client.counts')
      return Response.json({ ok: true, channels: [], activity_v2: activityV2 ?? {} });
    if (method === 'conversations.info') {
      const id = params.channel;
      return Response.json({
        ok: true,
        channel: channels[id] ?? { id, name: `room-${id.toLowerCase()}`, is_private: false },
      });
    }
    if (method === 'conversations.replies') {
      const found = (ts) => messages[`${params.channel}:${ts}`];
      const wanted = params.oldest ? [found(params.ts), found(params.oldest)] : [found(params.ts)];
      if (wanted.some((message) => !message))
        return Response.json({ ok: false, error: 'not_found' });
      return Response.json({ ok: true, messages: wanted, has_more: false });
    }
    return Response.json({ ok: false, error: 'unknown_method' });
  }

  async function fetchImpl(input) {
    const url = new URL(input);
    const method = url.pathname.split('/').pop();
    const params = Object.fromEntries(url.searchParams);
    calls.push({ method, params });
    const scripted = intercept?.({ method, params, index: calls.length - 1 });
    return scripted ?? answer(method, params);
  }

  return {
    calls,
    fetchImpl,
    answer,
    methods: () => calls.map((call) => call.method),
    paramsOf: (method) => calls.filter((call) => call.method === method).map((call) => call.params),
    count: (method) => calls.filter((call) => call.method === method).length,
    script(handler) {
      intercept = handler;
    },
  };
}

// The real integration over a scripted Slack, with a session file the test can write (a different `token` is another account) and a clock that is fixed unless given.
export function connectedFeed(t, slackOptions = {}, now = () => NOW_MS) {
  const slack = createFeedSlack(slackOptions);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-feed-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = slackPaths(home);
  fs.mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  const integration = createSlackIntegration({
    paths,
    fetchImpl: slack.fetchImpl,
    now,
  });
  const writeSession = (token = 'xoxc-synthetic') =>
    fs.writeFileSync(
      paths.session,
      JSON.stringify({
        token,
        cookie: 'xoxd-synthetic',
        teamId: TEAM,
        teamDomain: 'example',
        savedAt: '2026-01-01T00:00:00.000Z',
      }),
      { mode: 0o600 },
    );
  return { slack, integration, paths, writeSession };
}
