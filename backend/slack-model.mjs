// slack-model.mjs — pure shaping rules for the Slack thread lists.
//
// Slack hands back its own mrkdwn (`<@U123>`, `<#C123|general>`,
// `<https://x|label>`), epoch-string timestamps and a `thread_ts === ts` marker
// for "this message is a thread root". Everything here is DOM-free and
// side-effect-free so it can be tested without a browser or a network.

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
  return Number.isSafeInteger(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : '';
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

export function person(id, me, users) {
  if (!id) return { id: '', name: '' };
  if (id === me) return { id, name: 'You' };
  return { id, name: users[id] || id };
}

// One list entry from a thread root. `mention` is set for the mentions list, and
// describes the message that named the user rather than the thread starter.
export function buildThread({ root, mention, channelId, teamId, me, users }) {
  const activity = root.latest_reply || root.ts;
  const source = mention || root;
  return {
    ts: root.ts,
    url: threadUrl({ teamId, channelId, ts: root.ts }),
    text: cleanText(source.text, users),
    author: person(source.user, me, users),
    starter: person(root.user, me, users),
    replyCount: root.reply_count || 0,
    activityAt: slackTimestamp(activity),
    latestReplyBy: null,
    needsReply: null,
  };
}

export function sortByActivity(threads) {
  return [...threads].sort((a, b) => Date.parse(b.activityAt) - Date.parse(a.activityAt));
}

// The last message of a fetched thread decides whether the user owes a reply,
// which is the only signal this view exists to answer.
export function applyLastReply(thread, last, me, users) {
  if (!last) return thread;
  thread.latestReplyBy = person(last.user, me, users);
  thread.needsReply = Boolean(last.user) && last.user !== me;
  return thread;
}
