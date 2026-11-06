// slack-model.mjs — pure shaping rules for the Slack thread lists and the one
// conversation the ticket dialog opens.
//
// Slack hands back its own mrkdwn (`<@U123>`, `<#C123|general>`,
// `<https://x|label>`), epoch-string timestamps and a `thread_ts === ts` marker
// for "this message is a thread root". Everything here is DOM-free and
// side-effect-free so it can be tested without a browser or a network.

import { threadWatchKey } from './slack-link.mjs';
import { parseSlackTs } from '../ui/slack-timestamp.js';

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

// Slack epoch string ("1793222863.750299") to ISO. Anything unparseable becomes
// an empty string so callers sort it last instead of crashing.
export function slackTimestamp(ts) {
  const seconds = Number(String(ts ?? '').split('.')[0]);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return '';
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

// List activity keeps the fractional millisecond in its ISO representation;
// activityTs retains the remaining microseconds for deterministic ordering.
function activityTimestamp(ts) {
  if (!validSlackTs(ts)) return '';
  const whole = slackTimestamp(ts);
  if (!whole) return '';
  const fraction = String(ts).split('.')[1].padEnd(6, '0');
  const date = new Date(Date.parse(whole) + Number(fraction.slice(0, 3)));
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

// Mrkdwn to plain text: mentions and channels become names, links become their
// label (or the URL), broadcast tokens become @channel/@here, entities decode.
export function cleanText(text, users = {}) {
  const raw = String(text ?? '');
  const out = raw
    .replace(/<@([^>|]+)(?:\|([^>]+))?>/g, (_, id, label) => `@${label || users[id] || id}`)
    .replace(/<#([^>|]+)(?:\|([^>]+))?>/g, (_, id, label) => `#${label || id}`)
    .replace(/<!(channel|here|everyone)(?:\|([^>]+))?>/g, (_, name) => `@${name}`)
    .replace(/<(https?:\/\/[^>|]+)(?:\|([^>]+))?>/g, (_, url, label) => label || url)
    // The dashboard renders plain text, so drop emphasis markers rather than
    // showing the asterisks literally.
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1');
  return decodeEntities(out).replace(/\s+/g, ' ').trim();
}

// Canonical web link to a thread. app.slack.com works for any workspace the
// signed-in user belongs to, and needs no permalink lookup per message.
export function threadUrl({ teamId, channelId, ts }) {
  if (!teamId || !channelId || !ts) return '';
  return `https://app.slack.com/client/${teamId}/${channelId}/thread/${channelId}-${ts}`;
}

// A thread's link and the key its watch entry is filed under, derived from the same ids so the
// key is empty exactly when there is no link.
export function threadLinkFields({ teamId, channelId, ts }) {
  const url = threadUrl({ teamId, channelId, ts });
  return { url, watchKey: url ? threadWatchKey(channelId, ts) : '' };
}

// Every message that belongs to the same thread maps to the same key.
//
// `search.messages` matches carry no `thread_ts` (a whole page of them can omit
// it), but their permalink always names the thread it belongs to, so the
// `thread_ts` query parameter is the grouping signal. A message with neither is
// its own thread. A malformed permalink must not throw: it just falls back.
export function threadKey(message) {
  if (!message) return '';
  if (message.thread_ts) return String(message.thread_ts);
  if (typeof message.permalink === 'string' && message.permalink) {
    try {
      const thread = new URL(message.permalink).searchParams.get('thread_ts');
      if (thread) return thread;
    } catch {
      // Not a URL: fall through to the message's own timestamp.
    }
  }
  return message.ts ? String(message.ts) : '';
}

export function person(id, me, users) {
  if (!id) return { id: '', name: '' };
  if (id === me) return { id, name: 'You' };
  return { id, name: users[id] || id };
}

// One list entry from a thread root. `mention` is set for the mentions list, and
// describes the message that named the user rather than the thread starter.
export function buildThread({ root, mention, channelId, teamId, me, users }) {
  const activity = root.reply_count ? root.latest_reply : root.ts;
  const source = mention || root;
  const subjectLine = String(root.text ?? '')
    .split(/\r\n|[\r\n\u2028\u2029]/)
    .find((line) => line.trim());
  return {
    ts: root.ts,
    ...threadLinkFields({ teamId, channelId, ts: root.ts }),
    text: cleanText(source.text, users),
    subjectText: cleanText(subjectLine, users),
    author: person(source.user, me, users),
    starter: person(root.user, me, users),
    replyCount: root.reply_count || 0,
    activityAt: activityTimestamp(activity),
    activityTs: validSlackTs(activity) ? activity : null,
    latestReplyBy: null,
    needsReply: null,
  };
}

// Every id named as `<@U…>` anywhere in the given texts, in first-seen order.
// Used to name only the people a thread actually talks about, rather than
// carrying the whole workspace directory along with one conversation.
export function mentionedUserIds(texts) {
  const ids = [];
  for (const text of texts || []) {
    for (const match of String(text ?? '').matchAll(/<@([^>|]+)/g)) {
      const id = match[1].trim();
      if (id && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

// One conversation, message by message, root first. `text` is the plain form a
// reader sees and `mrkdwn` the raw Slack text, so a richer renderer can still
// use the formatting the plain form drops.
export function buildThreadMessages(messages, { me, users } = {}) {
  return (messages || []).map((message) => ({
    ts: String(message.ts ?? ''),
    at: slackTimestamp(message.ts),
    author: person(message.user, me, users),
    text: cleanText(message.text, users),
    mrkdwn: String(message.text ?? ''),
  }));
}

export function sortByActivity(threads) {
  return [...threads].sort((a, b) => {
    const aTs = validSlackTs(a.activityTs);
    const bTs = validSlackTs(b.activityTs);
    if (aTs && bTs)
      return compareSlackTs(b.activityTs, a.activityTs) || String(a.ts).localeCompare(String(b.ts));
    if (aTs || bTs) return aTs ? -1 : 1;
    const aTime = Date.parse(a.activityAt);
    const bTime = Date.parse(b.activityAt);
    if (Number.isFinite(aTime) || Number.isFinite(bTime))
      return (
        (Number.isFinite(bTime) ? bTime : -Infinity) -
          (Number.isFinite(aTime) ? aTime : -Infinity) || String(a.ts).localeCompare(String(b.ts))
      );
    return String(a.ts).localeCompare(String(b.ts));
  });
}

// A message is not mine when a person other than the user wrote it. A bot message has no
// `user`, so it is never one the user owes a reply to and never one to wake a session for.
export function isNotMine(message, me) {
  return Boolean(message?.user) && message.user !== me;
}

// The last message of a fetched thread decides whether the user owes a reply,
// which is the only signal this view exists to answer.
export function applyLastReply(thread, last, me, users) {
  if (!last) return thread;
  thread.latestReplyBy = person(last.user, me, users);
  thread.needsReply = isNotMine(last, me);
  return thread;
}

// A Slack ts is "<seconds>.<micro6>": two integers, compared as such, never as a float or text.
function slackTsParts(ts) {
  return parseSlackTs(String(ts ?? ''));
}

export function validSlackTs(ts) {
  return typeof ts === 'string' && Boolean(slackTsParts(ts));
}

export function compareSlackTs(a, b) {
  const [aSeconds, aMicro] = slackTsParts(a);
  const [bSeconds, bMicro] = slackTsParts(b);
  return aSeconds > bSeconds
    ? 1
    : aSeconds < bSeconds
      ? -1
      : aMicro > bMicro
        ? 1
        : aMicro < bMicro
          ? -1
          : 0;
}

function isNewerTs(ts, referenceTs) {
  if (!slackTsParts(ts)) return false;
  return !slackTsParts(referenceTs) || compareSlackTs(ts, referenceTs) > 0;
}

// A thread wakes a session when its newest message is not the user's and is strictly newer
// than the last one already notified; an equal or older ts is an edit or a deleted newest message.
export function shouldWake(last, me, lastNotifiedTs) {
  return isNotMine(last, me) && isNewerTs(last.ts, lastNotifiedTs);
}

// How many sessions the watch store has attached to one thread. `links` is the store's map keyed
// by the watch key every thread row carries, so a row with no key, or a key with no entry, has none.
function attachedCount(links, watchKey) {
  if (!links || !watchKey || !Object.hasOwn(links, watchKey)) return 0;
  const { sessionIds } = links[watchKey] ?? {};
  return Array.isArray(sessionIds) ? sessionIds.length : 0;
}

// The thread lists with `attachedSessions` on every row of `started`, the threads the My Tickets
// cards link to. The rows are copied, so the input (the Slack integration's cached listing) is left
// alone; `mentions` and every other field come through as they were. An unavailable result passes
// through unchanged.
export function withAttachedSessions(result, links) {
  if (!result?.available) return result;
  const started = (result.started ?? []).map((row) => ({
    ...row,
    attachedSessions: attachedCount(links, row.watchKey),
  }));
  return { ...result, started };
}
