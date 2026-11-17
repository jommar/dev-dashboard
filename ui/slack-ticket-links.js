// slack-ticket-links.js — DOM-free matching between Jira tickets and the Slack
// threads whose subject names them. No backend imports: this ships in the
// browser bundle.
//
// The one rule that ties a Slack thread to tickets: every ticket key on the thread's subject line
// (the first line of its opening message) names the thread, however the line is formatted. The
// ticket boards' chips and the thread dialog's title both read `threadTicketKeys`. TRIPS keys fold
// onto TAP so older threads match renamed tickets.

const FULL_KEY = /^(?:TAP|TRIPS)-(\d+)$/i;
// A key inside a slug: bounded by "-" or the string's edge on both sides, so TAP-1234 is not
// TAP-123 and STAP-123 or laptap-123 is no key at all.
const KEY_IN_SLUG = /(?:^|-)(?:tap|trips)-(\d+)(?=-|$)/g;

// A key of this project becomes "TAP-<number>"; anything else (another project,
// a bare number, a non-string) becomes "".
export function normalizeTicketKey(value) {
  if (typeof value !== 'string') return '';
  const match = value.trim().match(FULL_KEY);
  return match ? `TAP-${match[1]}` : '';
}

// The key a ticket is known by everywhere on the board: TAP and TRIPS fold to TAP,
// any other project key is kept as typed (trimmed), and a non-string gives "".
export function canonicalTicketKey(value) {
  return normalizeTicketKey(value) || (typeof value === 'string' ? value.trim() : '');
}

// Every ticket key a line names, wherever it sits. The line is slugified first (lower case, each
// run of anything but a letter or digit becomes one "-"), which drops the formatting Slack leaves
// in a subject (_italics_, ~strike~, [brackets], emoji, link syntax, odd hyphens, "TAP 123").
function ticketKeysIn(text) {
  const keys = new Set();
  if (typeof text !== 'string') return keys;
  const slug = text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
  for (const match of slug.matchAll(KEY_IN_SLUG)) keys.add(`TAP-${match[1]}`);
  return keys;
}

// A thread's subject: the first line the list kept as `subjectText`, or, for a row that carries
// only its text, that text's first non-empty line.
function subjectOf(thread) {
  if (thread?.subjectText !== undefined) return thread.subjectText;
  const text = thread?.text;
  if (typeof text !== 'string') return '';
  return text.split(/\r\n|[\r\n\u2028\u2029]/).find((line) => line.trim()) ?? '';
}

// The tickets a thread names, in the order they appear, each once ("" never): an empty list for a
// thread whose subject names none.
export function threadTicketKeys(thread) {
  return [...ticketKeysIn(subjectOf(thread))];
}

// ISO-8601 strings already sort chronologically as text, so the string itself is
// the sort key; "" marks a missing or unparseable activityAt.
function activityKey(thread) {
  const value = thread?.activityAt;
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : '';
}

// Newest activity first, an unknown activity last, and ties left in input order
// (sort is stable), so equal timestamps keep the order the server sent.
function newestFirst(a, b) {
  const left = activityKey(a);
  const right = activityKey(b);
  if (left === right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return left < right ? 1 : -1;
}

// Every thread grouped under its ticket keys, each group newest activity first.
// A thread without a key or without a link has nowhere to go and is skipped.
export function threadsByTicket(started) {
  const byTicket = new Map();
  if (!Array.isArray(started)) return byTicket;
  for (const thread of started) {
    if (!thread?.url) continue;
    for (const key of threadTicketKeys(thread)) {
      // Fresh arrays hold the caller's thread objects: neither the list nor the
      // threads themselves are touched.
      const bucket = byTicket.get(key);
      if (bucket) bucket.push(thread);
      else byTicket.set(key, [thread]);
    }
  }
  for (const bucket of byTicket.values()) bucket.sort(newestFirst);
  return byTicket;
}
