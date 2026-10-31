// slack-link.mjs — a pasted Slack link becomes one thread key, or a reason code.
//
// Pure and defensive: the text comes from a browser form and the result ends up in a notice
// line, so the normalized link is rebuilt from validated parts only (host, ids, timestamps),
// never echoed from the input.

const CHANNEL_ID = /^[CDG][A-Z0-9]{8,}$/;
const TEAM_ID = /^[A-Z][A-Z0-9]{8,}$/;
const MESSAGE_SEGMENT = /^p(\d{10})(\d{6})$/;
const SLACK_TS = /^\d{10}\.\d{6}$/;

const reject = (reason) => ({ reason });

const thread = (channelId, threadTs, link) => ({
  key: `${channelId}:${threadTs}`,
  channelId,
  threadTs,
  link,
});

const isSlackHost = ({ hostname, port }) =>
  port === '' && (hostname === 'slack.com' || hostname.endsWith('.slack.com'));

// `/archives/<channel>/p<seconds><micro6>`: a reply names its parent in `thread_ts`, a top-level
// message is its own thread.
function archiveThread(host, segments, searchParams) {
  const [channelId, messageSegment] = segments;
  if (segments.length !== 2 || !CHANNEL_ID.test(channelId) || !messageSegment)
    return reject('not_a_thread_link');
  const message = MESSAGE_SEGMENT.exec(messageSegment);
  if (!message) return reject('invalid_timestamp');
  const [, seconds, micro] = message;
  const parentTs = searchParams.get('thread_ts');
  if (parentTs !== null && !SLACK_TS.test(parentTs)) return reject('invalid_timestamp');
  const query = parentTs === null ? '' : `?thread_ts=${parentTs}`;
  return thread(
    channelId,
    parentTs ?? `${seconds}.${micro}`,
    `https://${host}/archives/${channelId}/p${seconds}${micro}${query}`,
  );
}

// `/client/<team>/<channel>/thread/<channel>-<threadTs>`: the form the dashboard hands out.
function appThread(host, segments) {
  const [teamId, channelId, kind, threadSegment] = segments;
  if (
    segments.length !== 4 ||
    kind !== 'thread' ||
    !TEAM_ID.test(teamId) ||
    !CHANNEL_ID.test(channelId)
  )
    return reject('not_a_thread_link');
  const parts = threadSegment.split('-');
  if (parts.length !== 2 || parts[0] !== channelId) return reject('not_a_thread_link');
  const [, threadTs] = parts;
  if (!SLACK_TS.test(threadTs)) return reject('invalid_timestamp');
  return thread(
    channelId,
    threadTs,
    `https://${host}/client/${teamId}/${channelId}/thread/${channelId}-${threadTs}`,
  );
}

export function parseSlackLink(text) {
  if (typeof text !== 'string') return reject('not_a_link');
  const trimmed = text.trim();
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return reject('not_a_link');
  }
  if (/\s/.test(trimmed)) return reject('extra_text');
  if (url.protocol !== 'https:') return reject('not_https');
  if (url.username || url.password) return reject('credentials_not_allowed');
  if (!isSlackHost(url)) return reject('not_slack_host');
  const [, root, ...segments] = url.pathname.split('/');
  if (root === 'archives') return archiveThread(url.hostname, segments, url.searchParams);
  if (root === 'client') return appThread(url.hostname, segments);
  return reject('not_a_thread_link');
}
