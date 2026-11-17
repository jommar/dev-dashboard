// slack-ticket-threads.mjs — the Slack threads that name a ticket, in any conversation the user
// can see. Read-only.
//
// The shared thread list (slack-board.mjs) reads one channel, so a thread anywhere else never
// reached a card. This asks Slack's own search instead, which already knows exactly what the signed
// in user can see: one `search.messages` per ticket key, workspace-wide. Search has no OR, so a
// request is bounded rather than batched: a few uncached keys per call (the rest on the next call),
// every answer cached per key, concurrent callers sharing one in-flight search, and a rate limit
// ends the request. A hit is kept only when it is a thread's opening message and the shared matching
// rule (`threadTicketKeys`, the same one the cards use) finds the key on its first line. Each kept
// root is then read once with `conversations.replies` for its reply count and newest activity.
//
// Every call goes through the injected `call`, so rate limits and upstream health are the
// integration's own. Nothing is written to Slack and nothing here logs message text.

import { eligibleSlackRoot, SLACK_WINDOW_MS } from '../ui/slack-activity.js';
import { threadTicketKeys } from '../ui/slack-ticket-links.js';
import { runWithLimit } from './jira-search.mjs';
import { searchRoot } from './slack-board.mjs';
import { buildThread, cleanText, sortByActivity, validSlackTs } from './slack-model.mjs';

const KEY_PATTERN = /^TAP-\d{1,9}$/;
const CHANNEL_ID = /^[CGD][A-Z0-9]{6,20}$/;
const MAX_KEYS = 80;
const SEARCH_BUDGET = 8;
const SEARCH_CONCURRENCY = 2;
const SEARCH_COUNT = 50;
const ROOT_BUDGET = 24;
const ROOT_CONCURRENCY = 4;
const KEY_TTL_MS = 15 * 60 * 1000;
// A search that failed is not asked again for this long, so one bad key cannot starve the budget.
const MISS_TTL_MS = 60 * 1000;
const ROOT_TTL_MS = 5 * 60 * 1000;
const KNOWN_TTL_MS = 30 * 60 * 1000;
const CACHE_LIMIT = 400;
const UNREADABLE_ROOT_ERRORS = new Set([
  'thread_not_found',
  'channel_not_found',
  'not_in_channel',
  'missing_scope',
]);
// A search match with no thread marker at all is a top-level message, which is a thread's root.
const ANY_ROOT = { get: () => ({ root: true }) };

function kindOf(channel) {
  if (channel.is_im || channel.id.startsWith('D')) return 'im';
  if (channel.is_mpim || String(channel.name ?? '').startsWith('mpdm-')) return 'mpim';
  return 'channel';
}

const KIND_NAMES = { im: 'Direct message', mpim: 'Group message' };

function channelOf(match) {
  const id = match?.channel?.id;
  if (typeof id !== 'string' || !CHANNEL_ID.test(id)) return null;
  const kind = kindOf({ ...match.channel, id });
  const name = kind === 'channel' ? String(match.channel.name ?? '') : KIND_NAMES[kind];
  return { id, name, kind };
}

function firstLine(text) {
  return (
    String(text ?? '')
      .split(/\r\n|[\r\n\u2028\u2029]/)
      .find((line) => line.trim()) ?? ''
  );
}

// The keys a caller asked for: well-formed, upper-cased, once each, at most MAX_KEYS.
export function ticketKeysOf(keys) {
  const out = new Set();
  for (const raw of Array.isArray(keys) ? keys : []) {
    const key = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
    if (KEY_PATTERN.test(key)) out.add(key);
    if (out.size >= MAX_KEYS) break;
  }
  return [...out];
}

export function createSlackTicketThreads({
  call,
  session,
  verify,
  users,
  now,
  isCurrent,
  generation,
}) {
  const keyCache = new Map(); // key -> { at, hits }
  const inflight = new Map(); // key -> Promise<hits | null>
  const missed = new Map(); // key -> when its search last failed
  const rootCache = new Map(); // "<channel>:<ts>" -> { at, root }
  const known = new Map(); // "<channel>:<ts>" -> { at, name }

  function clear() {
    keyCache.clear();
    missed.clear();
    inflight.clear();
    rootCache.clear();
    known.clear();
  }

  function remember(map, key, value) {
    if (map.size >= CACHE_LIMIT) map.delete(map.keys().next().value);
    map.set(key, value);
  }

  // A thread this module listed, so the dialog may read it. The channel is part of the identity: a
  // timestamp is only unique within one conversation.
  function isVerifiedRoot(channelId, ts) {
    const hit = known.get(`${channelId}:${ts}`);
    return Boolean(hit) && now() - hit.at < KNOWN_TTL_MS && eligibleSlackRoot(ts, now());
  }

  // Where a listed thread lives: its name and kind, for the dialog that opens it.
  function describe(channelId, ts) {
    const hit = known.get(`${channelId}:${ts}`);
    return { id: channelId, name: hit?.name ?? '', kind: hit?.kind ?? 'channel' };
  }

  const day = () => new Date(now() - SLACK_WINDOW_MS).toISOString().slice(0, 10);

  function toHit(match, key) {
    const channel = channelOf(match);
    if (!channel || !validSlackTs(match?.ts)) return null;
    // Only an opening message: a reply is part of a thread whose root, if it names the ticket, is a hit itself.
    if (searchRoot(match, channel.id, ANY_ROOT) !== match.ts) return null;
    if (!eligibleSlackRoot(match.ts, now())) return null;
    const subjectText = cleanText(firstLine(match.text), {});
    if (!threadTicketKeys({ subjectText }).includes(key)) return null;
    return { channel, ts: match.ts, user: match.user, text: String(match.text ?? '') };
  }

  // One key's hits, or null when the search failed (never cached, so it is asked again).
  function searchKey(key, credentials, gen, outcome) {
    if (inflight.has(key)) return inflight.get(key);
    const work = (async () => {
      let payload;
      try {
        payload = await call(
          'search.messages',
          {
            query: `${key} after:${day()}`,
            count: SEARCH_COUNT,
            sort: 'timestamp',
            sort_dir: 'desc',
          },
          credentials,
        );
      } catch (error) {
        if (error?.message === 'rate_limited') {
          outcome.reasons.add('rate_limited');
          outcome.stopped = true;
        } else {
          outcome.reasons.add('search_unavailable');
          remember(missed, key, now());
        }
        return null;
      }
      if (!isCurrent(gen)) return null;
      const matches = payload?.messages?.matches;
      if (!payload?.ok || !Array.isArray(matches)) {
        outcome.reasons.add('search_unavailable');
        remember(missed, key, now());
        return null;
      }
      if ((payload.messages.paging?.total ?? matches.length) > matches.length)
        outcome.reasons.add('search_truncated');
      const hits = matches.map((match) => toHit(match, key)).filter(Boolean);
      remember(keyCache, key, { at: now(), hits });
      return hits;
    })().finally(() => inflight.delete(key));
    inflight.set(key, work);
    return work;
  }

  async function readRoot(hit, credentials, gen, outcome) {
    const id = `${hit.channel.id}:${hit.ts}`;
    let payload;
    try {
      payload = await call(
        'conversations.replies',
        { channel: hit.channel.id, ts: hit.ts, limit: 1 },
        credentials,
      );
    } catch (error) {
      if (error?.message === 'rate_limited') {
        outcome.reasons.add('rate_limited');
        outcome.stopped = true;
      } else outcome.reasons.add('reply_unavailable');
      return;
    }
    if (!isCurrent(gen)) return;
    const root = payload?.messages?.[0];
    if (payload?.ok && root?.ts === hit.ts) remember(rootCache, id, { at: now(), root });
    else if (UNREADABLE_ROOT_ERRORS.has(payload?.error))
      remember(rootCache, id, { at: now(), root: null });
    else outcome.reasons.add('reply_unavailable');
  }

  // The threads that name any of `keys`, newest activity first, plus how much work is still left:
  // `remaining` is keys not searched yet and roots not read yet, so a caller can ask again.
  async function lookup(keys) {
    const credentials = session();
    if (!credentials) return { available: false };
    const gen = generation();
    const identity = await verify(credentials, gen);
    if (!isCurrent(gen) || !identity.connected || !identity.userId) return { available: false };
    const outcome = { reasons: new Set(), stopped: false };
    const wanted = ticketKeysOf(keys);

    const stale = wanted.filter((key) => {
      const hit = keyCache.get(key);
      if (hit && now() - hit.at < KEY_TTL_MS) return false;
      return !missed.has(key) || now() - missed.get(key) >= MISS_TTL_MS;
    });
    const searched = stale.slice(0, SEARCH_BUDGET);
    await runWithLimit(
      searched,
      SEARCH_CONCURRENCY,
      (key) => searchKey(key, credentials, gen, outcome),
      () => outcome.stopped,
    );
    if (!isCurrent(gen)) return { available: false };

    const hits = new Map();
    for (const key of wanted)
      for (const hit of keyCache.get(key)?.hits ?? []) hits.set(`${hit.channel.id}:${hit.ts}`, hit);

    const unread = [...hits].filter(([id]) => {
      const cached = rootCache.get(id);
      return !cached || now() - cached.at >= ROOT_TTL_MS;
    });
    await runWithLimit(
      unread.slice(0, ROOT_BUDGET),
      ROOT_CONCURRENCY,
      ([, hit]) => readRoot(hit, credentials, gen, outcome),
      () => outcome.stopped,
    );
    if (!isCurrent(gen)) return { available: false };

    const names = await users(credentials, gen).catch(() => ({}));
    if (!isCurrent(gen)) return { available: false };
    const teamId = identity.teamId || credentials.teamId || '';
    const threads = [];
    for (const [id, hit] of hits) {
      const root = rootCache.get(id)?.root ?? { ts: hit.ts, user: hit.user, text: hit.text };
      threads.push({
        ...buildThread({
          root,
          mention: null,
          channelId: hit.channel.id,
          teamId,
          me: identity.userId,
          users: names,
        }),
        channel: hit.channel,
      });
      remember(known, id, { at: now(), name: hit.channel.name, kind: hit.channel.kind });
    }

    const keysLeft = stale.length - searched.length;
    const rootsLeft = Math.max(0, unread.length - ROOT_BUDGET);
    const remaining = keysLeft + rootsLeft;
    if (remaining > 0) outcome.reasons.add('bounded_work_remaining');
    return {
      available: true,
      threads: sortByActivity(threads),
      updatedAt: new Date(now()).toISOString(),
      partial: outcome.reasons.size > 0,
      partialReasons: [...outcome.reasons],
      truncated: remaining > 0 || outcome.reasons.has('search_truncated'),
      remaining,
    };
  }

  return { lookup, isVerifiedRoot, describe, clear };
}
