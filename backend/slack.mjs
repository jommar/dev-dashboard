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
import { randomUUID } from 'node:crypto';
import { withoutSecrets } from './config.mjs';
import { classifyError, upstreamHealth } from './upstream.mjs';
import { readTokenFile, stageTokenFile } from './credentials.mjs';
import { createSlackBoard, eligibleRoot } from './slack-board.mjs';
import {
  buildThreadMessages,
  compareSlackTs,
  mentionedUserIds,
  person,
  threadLinkFields,
} from './slack-model.mjs';

const API_URL = 'https://app.slack.com/api';
const STATUS_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 8_000;

// The channel whose threads the Slack tab lists, and the budgets that keep one
// refresh to a predictable number of calls.
const CHANNEL_NAME = 'ezat_claudio';
const USERS_TTL_MS = 10 * 60 * 1000;
const PENDING_TTL_MS = 60_000;

// One conversation opened from a ticket glyph. A thread fits in one 200-message
// page almost always; the other two pages are the ceiling, so a huge thread
// says so instead of paging Slack forever. Each answer is reused for a minute,
// because the dialog is reopened far more often than the thread changes.
const THREAD_TTL_MS = 60_000;
const THREAD_PAGES = 3;
const THREAD_LIMIT = 200;
const THREAD_TS = /^\d{10,}\.\d{4,}$/;
const THREAD_CACHE_LIMIT = 20;

// The session watcher reads a thread in any channel to its newest message, so
// it pages further than the dialog does; past this many pages it gives up
// instead of guessing at the newest message.
const WATCH_PAGES = 20;
const REJECTED_SESSION_ERRORS = new Set(['invalid_auth', 'token_revoked']);
const UNREADABLE_THREAD_ERRORS = new Set([
  'thread_not_found',
  'channel_not_found',
  'not_in_channel',
  'missing_scope',
]);

function retryAfterOf(res) {
  const seconds = Number(res.headers.get('retry-after'));
  return seconds > 0 ? { retryAfterSeconds: seconds } : {};
}

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
  let sessionKey = null;

  function session() {
    const file = readTokenFile(paths.session, fs);
    const credentials = !file.token || file.unsafe ? null : parseSession(file.token);
    const key = credentials ? JSON.stringify(credentials) : null;
    if (key !== sessionKey) {
      sessionKey = key;
      clearCaches();
    }
    return credentials;
  }

  function send(method, params, credentials) {
    const url = new URL(`${API_URL}/${method}`);
    for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, value);
    const pending = fetchImpl(url.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credentials.token}`,
        Cookie: `d=${credentials.cookie}`,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // A side branch: the caller still awaits `pending` itself, so no await ticks are added.
    pending?.catch?.((error) => upstreamHealth.recordFailure('slack', classifyError(error)));
    return pending;
  }

  // What an answer says about Slack's health: a 200 can still carry a rate limit or a rejected session.
  function recordAnswer(res, payload) {
    if (payload?.error === 'ratelimited') upstreamHealth.recordResponse('slack', 429, res.headers);
    else if (REJECTED_SESSION_ERRORS.has(payload?.error))
      upstreamHealth.recordResponse('slack', 401, res.headers);
    else upstreamHealth.recordResponse('slack', res.status, res.headers);
  }

  async function call(method, params, credentials) {
    if ((rateLimits.get(method) || 0) > now()) throw new Error('rate_limited');
    const gen = generation;
    const res = await send(method, params, credentials);
    const payload = await res.json().catch(() => null);
    recordAnswer(res, payload);
    if (res.status === 429 || payload?.error === 'ratelimited') {
      const seconds = retryAfterOf(res).retryAfterSeconds || 60;
      if (isCurrent(gen))
        rateLimits.set(method, Math.max(rateLimits.get(method) || 0, now() + seconds * 1000));
      throw new Error('rate_limited');
    }
    if (!res.ok) {
      if (
        method === 'conversations.replies' &&
        (res.status === 401 || res.status === 403) &&
        payload?.ok === false &&
        (REJECTED_SESSION_ERRORS.has(payload.error) || UNREADABLE_THREAD_ERRORS.has(payload.error))
      )
        return payload;
      throw new Error('unavailable');
    }
    return payload;
  }

  async function verify(credentials, gen = generation) {
    if (!isCurrent(gen)) return { connected: false, verified: false };
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
    if (isCurrent(gen)) cached = { at: now(), value };
    return value;
  }

  async function status() {
    const credentials = session();
    if (!credentials) return { connected: false, connecting: Boolean(child) };
    const gen = generation;
    const identity = await verify(credentials, gen);
    if (!isCurrent(gen)) return { connected: false, connecting: Boolean(child) };
    return {
      ...identity,
      connecting: Boolean(child),
      sessionVersion,
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
  let pendingCache = null;
  let generation = 0; // bumped by disconnect(), so a late refresh cannot write back.
  // Random and process-local, not derived from credentials. A restart or any
  // detected session replacement produces a different browser-visible value.
  let sessionVersion = randomUUID();
  const threadCache = new Map(); // thread ts -> { at, value }, one dialog per thread
  const rateLimits = new Map();
  const board = createSlackBoard({
    call,
    session,
    verify,
    channel,
    users,
    now,
    isCurrent,
    generation: () => generation,
  });

  function clearCaches() {
    generation += 1;
    sessionVersion = randomUUID();
    cached = null;
    pendingCache = null;
    usersCache = null;
    channelCache = null;
    threadCache.clear();
    board.clear();
    rateLimits.clear();
  }

  function isCurrent(gen) {
    return Boolean(session()) && gen === generation;
  }

  async function paged(credentials, method, params, pages, select, gen = generation) {
    const out = [];
    let cursor = '';
    for (let page = 0; page < pages; page++) {
      if (!isCurrent(gen)) break;
      const payload = await call(method, { ...params, ...(cursor ? { cursor } : {}) }, credentials);
      if (!isCurrent(gen)) break;
      if (!payload?.ok) throw new Error('Slack page unavailable');
      out.push(...(select(payload) || []));
      cursor = payload.response_metadata?.next_cursor || '';
      if (!cursor) break;
    }
    return out;
  }

  async function users(credentials, gen = generation) {
    if (!isCurrent(gen)) throw new Error('Session changed');
    if (usersCache && now() - usersCache.at < USERS_TTL_MS) return usersCache.value;
    const members = await paged(
      credentials,
      'users.list',
      { limit: 200 },
      5,
      (p) => p.members,
      gen,
    );
    const value = {};
    for (const member of members)
      value[member.id] =
        member.profile?.display_name || member.real_name || member.name || member.id;
    if (isCurrent(gen)) usersCache = { at: now(), value };
    return value;
  }

  // Search is asked first: this private channel never appears in
  // `conversations.list` (ten paged calls, ~3 s), while `in:<name>` names it in
  // one call (~0.35 s). The list scan stays as the fallback for a channel
  // search cannot see.
  async function channel(credentials, gen = generation) {
    if (!isCurrent(gen)) return null;
    if (channelCache && now() - channelCache.at < USERS_TTL_MS) return channelCache.value;
    let found = null;
    const payload = await call(
      'search.messages',
      { query: `in:${CHANNEL_NAME}`, count: 1 },
      credentials,
    ).catch(() => null);
    if (!isCurrent(gen)) return null;
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
        gen,
      );
      found = channels.find((entry) => entry.name === CHANNEL_NAME) || null;
    }
    if (isCurrent(gen)) channelCache = { at: now(), value: found };
    return found;
  }

  const threads = board.threads;

  // --- one thread, in full ------------------------------------------------
  // The ticket glyph opens a dialog, so this is the only Slack call path a
  // click triggers. The `ts` arrives from the browser, so it is validated
  // before any credential is read, and every answer is either a thread or
  // "unavailable" — never an exception out of the HTTP surface.

  async function thread(ts) {
    const key = typeof ts === 'string' ? ts.trim() : '';
    if (!THREAD_TS.test(key) || !eligibleRoot(key, now())) return { available: false };
    const credentials = session();
    if (!credentials || !board.isVerifiedRoot(key)) return { available: false };
    const gen = generation;
    const hit = threadCache.get(key);
    if (hit && now() - hit.at < THREAD_TTL_MS) return hit.value;
    try {
      const identity = await verify(credentials, gen);
      if (!isCurrent(gen) || !board.isVerifiedRoot(key) || !identity.connected || !identity.userId)
        return { available: false };
      const me = identity.userId;
      const teamId = identity.teamId || credentials.teamId || '';
      const target = await channel(credentials, gen);
      if (!target) return { available: false };

      const messages = [];
      let cursor = '';
      let truncated = false;
      for (let page = 0; page < THREAD_PAGES; page++) {
        if (!isCurrent(gen) || !board.isVerifiedRoot(key)) return { available: false };
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
        if (
          !isCurrent(gen) ||
          !board.isVerifiedRoot(key) ||
          !payload?.ok ||
          !Array.isArray(payload.messages)
        )
          return { available: false };
        if (
          page === 0 &&
          (payload.messages[0]?.ts !== key ||
            (payload.messages[0]?.thread_ts && payload.messages[0].thread_ts !== key))
        )
          return { available: false };
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
      const members = await users(credentials, gen).catch(() => ({}));
      if (!isCurrent(gen) || !board.isVerifiedRoot(key)) return { available: false };
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
          ...threadLinkFields({ teamId, channelId: target.id, ts: key }),
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

  // --- one thread, any channel, to its newest message ---------------------
  // The session watcher's only Slack read. Unlike the calls above it must tell
  // a rate limit from a rejected session from a thread it cannot read, so each
  // failure is a reason the watcher can act on, and none of them throws. Only
  // the newest author and ts leave this function, never message text.

  async function readSlack(method, params, credentials) {
    let res;
    try {
      res = await send(method, params, credentials);
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
    const payload = await res.json().catch(() => null);
    recordAnswer(res, payload);
    if (res.status === 429 || payload?.error === 'ratelimited')
      return { ok: false, reason: 'rate_limited', ...retryAfterOf(res) };
    if (REJECTED_SESSION_ERRORS.has(payload?.error))
      return { ok: false, reason: 'session_rejected' };
    if (UNREADABLE_THREAD_ERRORS.has(payload?.error))
      return { ok: false, reason: 'thread_unreadable' };
    if (!res.ok || !payload?.ok) return { ok: false, reason: 'unavailable' };
    return { ok: true, payload };
  }

  async function lastInThread({ channelId, threadTs, asOfTs } = {}) {
    try {
      const credentials = session();
      if (!credentials) return { ok: false, reason: 'not_connected' };
      const identity = await readSlack('auth.test', {}, credentials);
      if (!identity.ok) return identity;
      const me = identity.payload.user_id;
      if (!me) return { ok: false, reason: 'unavailable' };

      let last = null;
      let asOf = null;
      let cursor = '';
      for (let page = 0; page < WATCH_PAGES; page++) {
        const answer = await readSlack(
          'conversations.replies',
          { channel: channelId, ts: threadTs, limit: THREAD_LIMIT, ...(cursor ? { cursor } : {}) },
          credentials,
        );
        if (!answer.ok) return answer;
        for (const message of answer.payload.messages || []) {
          if (!last || compareSlackTs(message.ts, last.ts) >= 0)
            last = { ...(message.user ? { user: message.user } : {}), ts: message.ts };
          const withinBound = !asOfTs || compareSlackTs(message.ts, asOfTs) <= 0;
          if (withinBound && (!asOf || compareSlackTs(message.ts, asOf) > 0)) asOf = message.ts;
        }
        cursor = answer.payload.response_metadata?.next_cursor || '';
        if (!cursor) {
          // A last page that still says "more" means Slack stopped handing out pages.
          if (answer.payload.has_more) break;
          return last ? { ok: true, me, last, asOf } : { ok: false, reason: 'unavailable' };
        }
      }
      return { ok: false, reason: 'too_long' };
    } catch {
      return { ok: false, reason: 'unavailable' };
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
    const gen = generation;
    if (pendingCache && now() - pendingCache.at < PENDING_TTL_MS) return pendingCache.value;
    try {
      const identity = await verify(credentials, gen);
      if (!isCurrent(gen) || !identity.connected) return { available: false };
      const target = await channel(credentials, gen);
      if (!isCurrent(gen) || !target) return { available: false };
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
      if (!isCurrent(gen)) return { available: false };
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
          env: { ...withoutSecrets(process.env), SLACK_PROFILE_DIR: paths.profile },
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
    sessionKey = null;
    clearCaches();
    return { ok: true };
  }

  function writeSession(contents) {
    const temporary = stageTokenFile(paths.session, JSON.stringify(contents, null, 2) + '\n', fs);
    fs.renameSync(temporary, paths.session);
    session();
  }

  return {
    paths,
    status,
    threads,
    thread,
    lastInThread,
    pending,
    connect,
    disconnect,
    writeSession,
  };
}

export const slackIntegration = createSlackIntegration();
