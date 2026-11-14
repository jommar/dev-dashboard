// slack-feed.mjs — the Slack Activity list behind the edge drawer, read-only.
//
// One `activity.feed` page (ids only) is split into Mentions, Threads and Reactions, then each row
// is hydrated with one `conversations.replies` per message and one `conversations.info` per
// channel, inside a fixed per-request budget. Every request goes through the injected `call`
// seam, so rate limits, timeouts and upstream health are the integration's own. Nothing here
// marks anything read, and nothing logs message text.

import { cleanText, person, slackTimestamp, threadLinkFields } from './slack-model.mjs';

const FEED_TYPES = 'at_user,at_channel,keyword,thread_v2,message_reaction';
const FEED_LIMIT = 30;
const HYDRATE_BUDGET = 24;
const INFO_BUDGET = 10;
const CONCURRENCY = 5;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_LIMIT = 200;
// A row Slack would not give is not asked again for this long, so an unreadable one costs no call per open.
const MISS_TTL_MS = 60 * 1000;
const TEXT_LIMIT = 280;
const PARENT_LIMIT = 140;
const MENTION_KINDS = { at_user: 'mention', at_channel: 'channel', keyword: 'keyword' };
const UNAVAILABLE = { available: false, reason: 'unavailable' };

// The unread count of the mention types only, from `client.counts`' `activity_v2`.
export function mentionUnread(activityV2) {
  return ['at_user', 'at_channel', 'keyword'].reduce(
    (sum, type) =>
      sum + (activityV2?.[type] > 0 && Number.isFinite(activityV2[type]) ? activityV2[type] : 0),
    0,
  );
}

function entryOf(item) {
  const feedTs = item?.feed_ts;
  const id = String(item?.key ?? '');
  if (!id) return null;
  const base = { id, unread: item?.is_unread === true, feedTs };
  const type = item?.item?.type;
  if (MENTION_KINDS[type] || type === 'message_reaction') {
    const { channel, ts, thread_ts: threadTs } = item.item.message || {};
    if (!channel || !ts) return null;
    return type === 'message_reaction'
      ? {
          ...base,
          kind: 'reaction',
          channel,
          ts,
          cacheKey: `${channel}:${ts}`,
          reaction: {
            user: item.item.reaction?.user,
            name: String(item.item.reaction?.name ?? ''),
          },
        }
      : { ...base, kind: MENTION_KINDS[type], channel, ts, threadTs, cacheKey: `${channel}:${ts}` };
  }
  if (type === 'thread_v2') {
    const thread = item.item.bundle_info?.payload?.thread_entry || {};
    if (!thread.channel_id || !thread.thread_ts || !thread.latest_ts) return null;
    return {
      ...base,
      kind: 'thread',
      channel: thread.channel_id,
      ts: thread.latest_ts,
      threadTs: thread.thread_ts,
      replies: Number(thread.unread_msg_count) || 0,
      cacheKey: `thread:${thread.channel_id}:${thread.latest_ts}`,
    };
  }
  return null;
}

// Splits one activity page into the three tabs, newest first as Slack sent it. Mention kinds
// collapse to one row per message; a thread whose newest reply is already a mention row is dropped.
export function feedRows(items) {
  const mentions = new Map();
  const threads = [];
  const reactions = [];
  for (const entry of (Array.isArray(items) ? items : []).map(entryOf)) {
    if (!entry) continue;
    if (entry.kind === 'thread') threads.push(entry);
    else if (entry.kind === 'reaction') reactions.push(entry);
    else {
      const earlier = mentions.get(entry.cacheKey);
      if (earlier) earlier.unread ||= entry.unread;
      else mentions.set(entry.cacheKey, entry);
    }
  }
  return {
    mentions: [...mentions.values()],
    threads: threads.filter((row) => !mentions.has(`${row.channel}:${row.ts}`)),
    reactions,
  };
}

const clamp = (text, limit) => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);

// Message text for the browser: a user, channel or user group this reply cannot name becomes a word, never an id.
function plainText(text, names, limit) {
  const named = String(text ?? '')
    .replace(/<@([^>|]+)>/g, (token, id) => (names[id] ? token : '@someone'))
    .replace(/<#[^>|]+>/g, '#channel')
    .replace(/<!subteam\^[^>|]*(?:\|([^>]*))?>/g, (token, label) => label || '@group');
  return clamp(cleanText(named, names), limit);
}

function channelDescription(info, names) {
  if (info.is_im) return { name: names[info.user] || '', type: 'dm' };
  const name = String(info.name ?? '');
  if (info.is_mpim) return { name, type: 'group' };
  return { name, type: info.is_private ? 'private' : 'channel' };
}

export function createSlackFeed({ call, session, verify, users, now, isCurrent, generation }) {
  const messages = new Map(); // cacheKey -> { at, value }
  const channels = new Map(); // channel id -> { at, value }
  const misses = new Map(); // cacheKey or channel id -> { at, value: true }, kept MISS_TTL_MS
  let inflight = null; // { gen, promise }

  function fresh(cache, key, ttl = CACHE_TTL_MS) {
    const hit = cache.get(key);
    return hit && now() - hit.at < ttl ? hit.value : undefined;
  }
  const missed = (key) => fresh(misses, key, MISS_TTL_MS) === true;

  function remember(cache, key, value) {
    cache.delete(key);
    cache.set(key, { at: now(), value });
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  }

  async function pool(list, work, stopped) {
    let next = 0;
    const worker = async () => {
      while (next < list.length && !stopped()) await work(list[next++]);
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));
  }

  // Reads what the budget allows, in priority order. Returns the flags the page reports.
  async function hydrate(credentials, entries, gen) {
    const flags = new Set();
    let limited = false;
    const stopped = () => limited || !isCurrent(gen);
    const readInto = async (cache, key, ask, shape) => {
      try {
        const payload = await ask();
        if (!isCurrent(gen)) return;
        const value = payload?.ok ? shape(payload) : undefined;
        if (value !== undefined) remember(cache, key, value);
        else {
          flags.add('unreadable');
          remember(misses, key, true);
        }
      } catch (error) {
        if (error?.message === 'rate_limited') {
          limited = true;
          flags.add('rate_limited');
        } else flags.add('unreadable');
      }
    };

    const wantedMessages = new Map();
    for (const entry of entries) {
      if (fresh(messages, entry.cacheKey) !== undefined) continue;
      if (missed(entry.cacheKey)) flags.add('unreadable');
      else wantedMessages.set(entry.cacheKey, entry);
    }
    const messageReads = [...wantedMessages.values()];
    if (messageReads.length > HYDRATE_BUDGET) flags.add('budget');
    await pool(
      messageReads.slice(0, HYDRATE_BUDGET),
      (entry) =>
        readInto(
          messages,
          entry.cacheKey,
          () =>
            call(
              'conversations.replies',
              entry.kind === 'thread'
                ? {
                    channel: entry.channel,
                    ts: entry.threadTs,
                    oldest: entry.ts,
                    inclusive: true,
                    limit: 2,
                  }
                : { channel: entry.channel, ts: entry.ts, inclusive: true, limit: 1 },
              credentials,
            ),
          (payload) => {
            const [first, ...rest] = payload.messages || [];
            const last = rest.length ? rest[rest.length - 1] : first;
            if (!first || last?.ts !== entry.ts) return undefined;
            return entry.kind === 'thread'
              ? { user: last.user, text: last.text, parentText: first.text }
              : { user: first.user, text: first.text };
          },
        ),
      stopped,
    );

    const unknown = [
      ...new Set(entries.map((entry) => entry.channel).filter((id) => !fresh(channels, id))),
    ];
    const wantedChannels = unknown.filter((id) => !missed(id));
    if (wantedChannels.length < unknown.length) flags.add('unreadable');
    if (wantedChannels.length > INFO_BUDGET) flags.add('budget');
    await pool(
      wantedChannels.slice(0, INFO_BUDGET),
      (id) =>
        readInto(
          channels,
          id,
          () => call('conversations.info', { channel: id }, credentials),
          (payload) => (payload.channel ? { ...payload.channel } : undefined),
        ),
      stopped,
    );
    return flags;
  }

  function publicRow(entry, { teamId, me, names }) {
    const message = fresh(messages, entry.cacheKey);
    const info = fresh(channels, entry.channel);
    const nameOf = (id) => {
      const name = person(id, me, names).name;
      return name === id ? '' : name;
    };
    const row = {
      id: entry.id,
      kind: entry.kind,
      unread: entry.unread,
      at: slackTimestamp(entry.feedTs),
      url: threadLinkFields({
        teamId,
        channelId: entry.channel,
        ts: entry.threadTs || entry.ts,
      }).url,
      hydrated: Boolean(message),
      channel: info ? channelDescription(info, names) : { name: '', type: 'channel' },
      author: message ? nameOf(message.user) : '',
      text: message ? plainText(message.text, names, TEXT_LIMIT) : '',
    };
    if (entry.kind === 'thread') {
      row.replies = entry.replies;
      row.parentText = message ? plainText(message.parentText, names, PARENT_LIMIT) : '';
    }
    if (entry.kind === 'reaction')
      row.reaction = { by: nameOf(entry.reaction.user), name: entry.reaction.name };
    return row;
  }

  async function read(credentials, gen) {
    const identity = await verify(credentials, gen);
    if (!isCurrent(gen)) return UNAVAILABLE;
    if (!identity.connected) return { available: false, reason: 'disconnected' };
    const payload = await call(
      'activity.feed',
      { types: FEED_TYPES, mode: 'chrono_reads_and_unreads', limit: FEED_LIMIT },
      credentials,
    );
    if (!isCurrent(gen) || !payload?.ok) return UNAVAILABLE;
    const split = feedRows(payload.items);
    const ordered = [...split.mentions, ...split.threads, ...split.reactions];
    const names = await users(credentials, gen).catch(() => ({}));
    const flags = await hydrate(credentials, ordered, gen);
    if (!isCurrent(gen)) return UNAVAILABLE;
    const context = { teamId: identity.teamId, me: identity.userId, names };
    const rows = (list) => list.map((entry) => publicRow(entry, context));
    return {
      available: true,
      updatedAt: new Date(now()).toISOString(),
      partial: ['budget', 'rate_limited', 'unreadable'].filter((flag) => flags.has(flag)),
      mentions: rows(split.mentions),
      threads: rows(split.threads),
      reactions: rows(split.reactions),
    };
  }

  // Never throws: no session is `disconnected`, any other failure is `unavailable`. Concurrent
  // reads of one session share a promise.
  function feed() {
    const credentials = session();
    if (!credentials) return Promise.resolve({ available: false, reason: 'disconnected' });
    const gen = generation();
    if (inflight?.gen === gen) return inflight.promise;
    const promise = read(credentials, gen)
      .catch(() => UNAVAILABLE)
      .finally(() => {
        if (inflight?.promise === promise) inflight = null;
      });
    inflight = { gen, promise };
    return promise;
  }

  function clear() {
    messages.clear();
    channels.clear();
    misses.clear();
    inflight = null;
  }

  return { feed, clear };
}
