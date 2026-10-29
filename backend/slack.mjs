// slack.mjs — optional Slack integration backed by a browser session token.
//
// Slack's public OAuth flow requires registering a Slack app, which this
// dashboard deliberately avoids. Instead the user signs in once through
// `slack-connect.mjs`, which captures the same credentials the Slack web client
// uses (`xoxc-` token from localStorage plus the `d` session cookie) and writes
// them to ~/.config/slack/session.json (mode 600).
//
// Silent by design: no function here throws out of the HTTP surface. Missing,
// expired or rejected credentials all resolve to `connected: false`, so every
// other panel renders exactly as before and the Slack tab just offers a connect
// button.
//
// Unofficial surface: these are the web client's own credentials, not a
// supported API token. Slack can rotate them at any time, and `status()` treats
// a rejected token as "not connected" so a rot just means signing in again.

import fsDefault from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as spawnDefault } from 'node:child_process';
import { readTokenFile, stageTokenFile } from './credentials.mjs';
import {
  applyLastReply,
  buildThread,
  buildThreadMessages,
  mentionedUserIds,
  person,
  sortByActivity,
  threadKey,
  threadUrl,
} from './slack-model.mjs';

const API_URL = 'https://app.slack.com/api';
const STATUS_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 8_000;

// The channel whose threads the Slack tab lists, and the budgets that keep one
// refresh to a predictable number of calls.
const CHANNEL_NAME = 'ezat_claudio';
const USERS_TTL_MS = 10 * 60 * 1000;
const THREADS_TTL_MS = 5 * 60 * 1000;
const PENDING_TTL_MS = 60_000;
const FAILURE_BACKOFF_MS = 60_000;
const HISTORY_PAGES = 3;
const SEARCH_PAGES = 2;
const SECTION_LIMIT = 25;
const ENRICH_CONCURRENCY = 5;

// One conversation opened from a ticket glyph. A thread fits in one 200-message
// page almost always; the other two pages are the ceiling, so a huge thread
// says so instead of paging Slack forever. Each answer is reused for a minute,
// because the dialog is reopened far more often than the thread changes.
const THREAD_TTL_MS = 60_000;
const THREAD_PAGES = 3;
const THREAD_LIMIT = 200;
const THREAD_TS = /^\d{10,}\.\d{4,}$/;
const THREAD_CACHE_LIMIT = 20;

export function slackPaths(home = os.homedir()) {
  const directory = path.join(home, '.config/slack');
  return {
    directory,
    session: path.join(directory, 'session.json'),
    log: path.join(directory, 'connect.log'),
    profile: path.join(directory, 'browser-profile'),
  };
}

function parseSession(text) {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value.token !== 'string' || !value.token.startsWith('xoxc-')) return null;
    if (typeof value.cookie !== 'string' || !value.cookie.startsWith('xoxd-')) return null;
    return {
      token: value.token,
      cookie: value.cookie,
      teamId: typeof value.teamId === 'string' ? value.teamId : '',
      teamDomain: typeof value.teamDomain === 'string' ? value.teamDomain : '',
      savedAt: typeof value.savedAt === 'string' ? value.savedAt : '',
    };
  } catch {
    return null;
  }
}

export function createSlackIntegration({
  paths = slackPaths(),
  fs = fsDefault,
  fetchImpl = (...args) => fetch(...args),
  spawnImpl = spawnDefault,
  now = () => Date.now(),
} = {}) {
  let cached = null; // { at, value } — at most one Slack call per minute.
  let child = null;

  function session() {
    const file = readTokenFile(paths.session, fs);
    if (!file.token || file.unsafe) return null;
    return parseSession(file.token);
  }

  async function call(method, params, credentials) {
    const url = new URL(`${API_URL}/${method}`);
    for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, value);
    const res = await fetchImpl(url.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credentials.token}`,
        Cookie: `d=${credentials.cookie}`,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return res.json();
  }

  async function verify(credentials) {
    if (cached && now() - cached.at < STATUS_TTL_MS) return cached.value;
    let value;
    try {
      const payload = await call('auth.test', {}, credentials);
      value = payload?.ok
        ? {
            connected: true,
            verified: true,
            user: payload.user || '',
            userId: payload.user_id || '',
            team: payload.team || '',
            teamId: payload.team_id || credentials.teamId || '',
          }
        : { connected: false, verified: true, reason: payload?.error || 'unknown' };
    } catch {
      // Slack unreachable: keep the session, but say we could not confirm it.
      value = {
        connected: true,
        verified: false,
        user: '',
        userId: '',
        team: '',
        teamId: credentials.teamId,
      };
    }
    cached = { at: now(), value };
    return value;
  }

  async function status() {
    const credentials = session();
    if (!credentials) return { connected: false, connecting: Boolean(child) };
    return {
      ...(await verify(credentials)),
      connecting: Boolean(child),
      savedAt: credentials.savedAt,
      teamDomain: credentials.teamDomain,
    };
  }

  // --- thread lists -------------------------------------------------------
  // Two questions, one refresh: threads the user started in CHANNEL_NAME, and
  // threads where the user was mentioned. Both are ordered by latest activity,
  // and carry a "needs a reply" flag when the last message is not theirs.
  //
  // The rows and the flags are read in two stages, because they cost very
  // different amounts: `loadRows` answers the lists in a handful of calls, while
  // the flags need one `conversations.replies` per listed thread. The rows are
  // served as soon as they exist and the flags are filled in behind the
  // response, so a cold tab paints immediately instead of waiting for the
  // slow half.

  let usersCache = null;
  let channelCache = null;
  let threadsCache = null; // { at, value } — served even when `at` is past the TTL.
  let pendingCache = null;
  let refreshInFlight = null; // at most one background refresh at a time.
  let retryAt = 0; // backoff deadline after a load that produced nothing.
  let generation = 0; // bumped by disconnect(), so a late refresh cannot write back.
  const lastReplyCache = new Map(); // "<thread ts>:<activity ts>" -> last message
  const threadCache = new Map(); // thread ts -> { at, value }, one dialog per thread

  async function paged(credentials, method, params, pages, select) {
    const out = [];
    let cursor = '';
    for (let page = 0; page < pages; page++) {
      const payload = await call(method, { ...params, ...(cursor ? { cursor } : {}) }, credentials);
      if (!payload?.ok) break;
      out.push(...(select(payload) || []));
      cursor = payload.response_metadata?.next_cursor || '';
      if (!cursor) break;
    }
    return out;
  }

  async function users(credentials) {
    if (usersCache && now() - usersCache.at < USERS_TTL_MS) return usersCache.value;
    const members = await paged(credentials, 'users.list', { limit: 200 }, 5, (p) => p.members);
    const value = {};
    for (const member of members)
      value[member.id] =
        member.profile?.display_name || member.real_name || member.name || member.id;
    usersCache = { at: now(), value };
    return value;
  }

  // Search is asked first: this private channel never appears in
  // `conversations.list` (ten paged calls, ~3 s), while `in:<name>` names it in
  // one call (~0.35 s). The list scan stays as the fallback for a channel
  // search cannot see.
  async function channel(credentials) {
    if (channelCache && now() - channelCache.at < USERS_TTL_MS) return channelCache.value;
    let found = null;
    const payload = await call(
      'search.messages',
      { query: `in:${CHANNEL_NAME}`, count: 1 },
      credentials,
    ).catch(() => null);
    const match = payload?.messages?.matches?.[0];
    if (match?.channel?.id)
      found = { id: match.channel.id, name: match.channel.name || CHANNEL_NAME };
    if (!found) {
      const channels = await paged(
        credentials,
        'conversations.list',
        { types: 'public_channel,private_channel', exclude_archived: true, limit: 200 },
        10,
        (p) => p.channels,
      );
      found = channels.find((entry) => entry.name === CHANNEL_NAME) || null;
    }
    channelCache = { at: now(), value: found };
    return found;
  }

  async function history(credentials, channelId) {
    const messages = await paged(
      credentials,
      'conversations.history',
      { channel: channelId, limit: 200 },
      HISTORY_PAGES,
      (p) => p.messages,
    );
    return [...new Map(messages.map((message) => [message.ts, message])).values()];
  }

  async function searchMentions(credentials, userId) {
    const matches = [];
    for (let page = 1; page <= SEARCH_PAGES; page++) {
      const payload = await call(
        'search.messages',
        {
          query: `in:${CHANNEL_NAME} <@${userId}>`,
          count: 100,
          page,
          sort: 'timestamp',
          sort_dir: 'desc',
        },
        credentials,
      );
      if (!payload?.ok) break;
      matches.push(...(payload.messages?.matches || []));
      if (matches.length >= (payload.messages?.total || 0)) break;
    }
    return matches;
  }

  // Slack answers `limit=1` with the root plus the newest message and nothing
  // else, which is exactly "who spoke last" — with far less payload than the
  // limit=100 call it replaces.
  async function lastMessage(credentials, channelId, ts) {
    const payload = await call(
      'conversations.replies',
      { channel: channelId, ts, limit: 1 },
      credentials,
    );
    const messages = payload?.ok ? payload.messages || [] : [];
    return messages.length ? messages[messages.length - 1] : null;
  }

  // Only the listed threads are fetched, five at a time (Slack rate-limits
  // higher fan-out), and a thread is not fetched again until its latest
  // activity changes.
  async function markLastReplies(credentials, channelId, me, users_, list) {
    const queue = [...list];
    const worker = async () => {
      while (queue.length) {
        const thread = queue.shift();
        const key = `${thread.ts}:${thread.activityAt}`;
        if (lastReplyCache.has(key)) {
          applyLastReply(thread, lastReplyCache.get(key), me, users_);
          continue;
        }
        const last = await lastMessage(credentials, channelId, thread.ts).catch(() => null);
        if (!last) continue;
        if (lastReplyCache.size > 500) lastReplyCache.clear();
        lastReplyCache.set(key, last);
        applyLastReply(thread, last, me, users_);
      }
    };
    await Promise.all(Array.from({ length: Math.min(ENRICH_CONCURRENCY, list.length) }, worker));
  }

  // Everything except the reply flags. Returns null when the session cannot be
  // used, so the caller can back off instead of asking again immediately.
  async function loadRows(credentials) {
    const identity = await verify(credentials);
    if (!identity.connected || !identity.userId) return null;
    const me = identity.userId;
    const teamId = identity.teamId || credentials.teamId || '';
    const target = await channel(credentials);
    if (!target) return null;
    const [members, messages, matches] = await Promise.all([
      users(credentials),
      history(credentials, target.id),
      searchMentions(credentials, me),
    ]);
    // Mention text renders the signed-in user by name, not by raw id.
    const names = { ...members, [me]: identity.user || 'you' };

    const roots = messages.filter((message) => message.thread_ts === message.ts);
    const rootByTs = new Map(roots.map((message) => [message.ts, message]));

    const started = roots
      .filter((root) => root.user === me)
      .map((root) => buildThread({ root, channelId: target.id, teamId, me, users: names }));

    // Matches carry no `thread_ts`, so `threadKey` groups them by the thread
    // their permalink points at: many matches, one row per thread. Only the
    // newest mention of a thread becomes its preview.
    const newestMention = new Map();
    for (const match of matches) {
      const key = threadKey(match);
      if (!key) continue;
      const previous = newestMention.get(key);
      if (!previous || Number(match.ts) > Number(previous.ts)) newestMention.set(key, match);
    }
    const mentioned = [];
    for (const [ts, match] of newestMention) {
      let root = rootByTs.get(ts);
      if (!root) {
        // Only a thread the history page missed reaches this lookup, so it is
        // one or two calls rather than one per match.
        const payload = await call(
          'conversations.replies',
          { channel: target.id, ts, limit: 1 },
          credentials,
        ).catch(() => null);
        root = payload?.ok ? payload.messages?.[0] : null;
      }
      if (!root) continue;
      mentioned.push(
        buildThread({ root, mention: match, channelId: target.id, teamId, me, users: names }),
      );
    }
    // Defensive: one row per thread root, even if two matches grouped apart.
    const mentions = [...new Map(mentioned.map((thread) => [thread.ts, thread])).values()];

    return {
      me,
      channelId: target.id,
      names,
      value: {
        available: true,
        channel: { id: target.id, name: target.name },
        started: sortByActivity(started).slice(0, SECTION_LIMIT),
        mentions: sortByActivity(mentions).slice(0, SECTION_LIMIT),
        updatedAt: new Date(now()).toISOString(),
        enriched: false,
      },
    };
  }

  // One background task: either fills in the flags of a snapshot the caller has
  // already been handed, or re-reads everything once the snapshot is stale.
  // Failure is silent and backs off, and a disconnect mid-flight wins.
  function refresh(credentials, snapshot = null) {
    if (refreshInFlight) return refreshInFlight;
    const gen = generation;
    const task = (async () => {
      try {
        if (!snapshot) {
          snapshot = await loadRows(credentials);
          if (gen !== generation) return;
          if (!snapshot) {
            retryAt = now() + FAILURE_BACKOFF_MS;
            return;
          }
          threadsCache = { at: now(), value: snapshot.value };
        }
        await markLastReplies(credentials, snapshot.channelId, snapshot.me, snapshot.names, [
          ...snapshot.value.started,
          ...snapshot.value.mentions,
        ]);
        if (gen !== generation) return;
        snapshot.value.enriched = true;
        threadsCache = { at: now(), value: snapshot.value };
        retryAt = 0;
      } catch {
        retryAt = now() + FAILURE_BACKOFF_MS;
      }
    })();
    // The body never rejects; `finally` only clears the single-flight guard.
    const guarded = task.finally(() => {
      if (refreshInFlight === guarded) refreshInFlight = null;
    });
    refreshInFlight = guarded;
    return guarded;
  }

  async function threads() {
    const credentials = session();
    if (!credentials) return { available: false };
    // A snapshot is served immediately, even past its TTL: re-reading it is the
    // background task's job, and a blocking refresh is what made this tab slow.
    if (threadsCache) {
      const stale = now() - threadsCache.at >= THREADS_TTL_MS;
      const needsFlags = !threadsCache.value.enriched;
      // One attempt at a time, and none inside a failure backoff.
      if ((stale || needsFlags) && now() >= retryAt) refresh(credentials);
      return threadsCache.value;
    }
    if (now() < retryAt) return { available: false };
    const gen = generation;
    try {
      const snapshot = await loadRows(credentials);
      // A disconnect while the rows were being read wins over this answer.
      if (gen !== generation) return { available: false };
      if (!snapshot) {
        retryAt = now() + FAILURE_BACKOFF_MS;
        return { available: false };
      }
      threadsCache = { at: now(), value: snapshot.value };
      retryAt = 0;
      // Rows first: the tab paints now and the reply flags land a moment later.
      refresh(credentials, snapshot);
      return snapshot.value;
    } catch {
      retryAt = now() + FAILURE_BACKOFF_MS;
      return { available: false };
    }
  }

  // --- one thread, in full ------------------------------------------------
  // The ticket glyph opens a dialog, so this is the only Slack call path a
  // click triggers. The `ts` arrives from the browser, so it is validated
  // before any credential is read, and every answer is either a thread or
  // "unavailable" — never an exception out of the HTTP surface.

  async function thread(ts) {
    const key = typeof ts === 'string' ? ts.trim() : '';
    if (!THREAD_TS.test(key)) return { available: false };
    const hit = threadCache.get(key);
    if (hit && now() - hit.at < THREAD_TTL_MS) return hit.value;
    const credentials = session();
    if (!credentials) return { available: false };
    try {
      const identity = await verify(credentials);
      if (!identity.connected || !identity.userId) return { available: false };
      const me = identity.userId;
      const teamId = identity.teamId || credentials.teamId || '';
      const target = await channel(credentials);
      if (!target) return { available: false };

      const messages = [];
      let cursor = '';
      let truncated = false;
      for (let page = 0; page < THREAD_PAGES; page++) {
        const payload = await call(
          'conversations.replies',
          {
            channel: target.id,
            ts: key,
            limit: THREAD_LIMIT,
            ...(cursor ? { cursor } : {}),
          },
          credentials,
        );
        if (!payload?.ok) return { available: false };
        messages.push(...(payload.messages || []));
        cursor = payload.response_metadata?.next_cursor || '';
        if (!cursor) {
          // `has_more` without a cursor means Slack stopped handing out pages.
          if (payload.has_more) truncated = true;
          break;
        }
        if (page === THREAD_PAGES - 1) truncated = true;
      }

      // Names cover the thread's authors and whoever it mentions — nobody else,
      // since users.list is workspace-wide and this dialog is one conversation.
      const members = await users(credentials);
      const names = {};
      for (const id of [
        ...messages.map((message) => message.user).filter(Boolean),
        ...mentionedUserIds(messages.map((message) => message.text)),
      ])
        names[id] = person(id, me, members).name;

      const value = {
        available: true,
        thread: {
          ts: key,
          url: threadUrl({ teamId, channelId: target.id, ts: key }),
          channel: { id: target.id, name: target.name },
          replyCount: Math.max(0, messages.length - 1),
          truncated,
          updatedAt: new Date(now()).toISOString(),
          names,
          messages: buildThreadMessages(messages, { me, users: names }),
        },
      };
      if (threadCache.size >= THREAD_CACHE_LIMIT) threadCache.clear();
      threadCache.set(key, { at: now(), value });
      return value;
    } catch {
      return { available: false };
    }
  }

  // --- unread badge -------------------------------------------------------
  // The badge wants one number, not a thread list: `client.counts` reports the
  // channel's unread mention count and whether anything is unread at all. It is
  // a web-client-only method, so everything here is parsed defensively and any
  // surprise resolves to "nothing to show" rather than an error.

  async function pending() {
    const credentials = session();
    if (!credentials) return { available: false };
    if (pendingCache && now() - pendingCache.at < PENDING_TTL_MS) return pendingCache.value;
    try {
      const identity = await verify(credentials);
      if (!identity.connected) return { available: false };
      const target = await channel(credentials);
      if (!target) return { available: false };
      const payload = await call('client.counts', { include_all_channels: 'true' }, credentials);
      if (!payload?.ok) return { available: false };
      const channels = Array.isArray(payload.channels) ? payload.channels : [];
      const entry = channels.find((item) => item?.id === target.id);
      if (!entry) return { available: false };
      const value = {
        available: true,
        channel: {
          id: target.id,
          name: target.name,
          mentions: Number(entry.mention_count) || 0,
          unread: entry.has_unreads === true,
        },
        mentionsTotal: Number(payload.activity_v2?.at_user) || 0,
        updatedAt: new Date(now()).toISOString(),
      };
      pendingCache = { at: now(), value };
      return value;
    } catch {
      return { available: false };
    }
  }

  // Opens a browser for the user to sign in. The child process owns the
  // Playwright profile and writes the session file itself, so no credential
  // ever passes through this process or its logs.
  function connect() {
    if (child) return { ok: true, connecting: true };
    fs.mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
    let log = 'ignore';
    try {
      log = fs.openSync(paths.log, 'a', 0o600);
    } catch {
      /* Logging is best effort; the sign-in window still works without it. */
    }
    try {
      const spawned = spawnImpl(
        process.execPath,
        [new URL('./slack-connect.mjs', import.meta.url).pathname],
        {
          detached: true,
          stdio: ['ignore', log, log],
          env: { ...process.env, SLACK_PROFILE_DIR: paths.profile },
        },
      );
      child = spawned;
      spawned.once?.('exit', () => {
        child = null;
        cached = null;
      });
      spawned.unref?.();
      return { ok: true, connecting: true };
    } catch {
      child = null;
      return { ok: false, connecting: false };
    } finally {
      if (typeof log === 'number') {
        try {
          fs.closeSync(log);
        } catch {}
      }
    }
  }

  function disconnect() {
    try {
      fs.rmSync(paths.session, { force: true });
    } catch {
      /* An unreadable session already means "not connected". */
    }
    // Anything already in flight belongs to the session being dropped: the
    // generation bump stops it writing its snapshot back afterwards.
    generation += 1;
    refreshInFlight = null;
    retryAt = 0;
    cached = null;
    threadsCache = null;
    pendingCache = null;
    usersCache = null;
    channelCache = null;
    lastReplyCache.clear();
    threadCache.clear();
    return { ok: true };
  }

  function writeSession(contents) {
    const temporary = stageTokenFile(paths.session, JSON.stringify(contents, null, 2) + '\n', fs);
    fs.renameSync(temporary, paths.session);
  }

  return { paths, status, threads, thread, pending, connect, disconnect, writeSession };
}

export const slackIntegration = createSlackIntegration();
