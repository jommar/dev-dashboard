// slack-ticket-links.js — DOM-free matching between Jira tickets and the Slack
// threads whose subject names them. No backend imports: this ships in the
// browser bundle.
//
// Only the opening key or comma-separated list of keys names a thread; later
// mentions do not. TRIPS keys fold onto TAP so older threads match renamed tickets.

const FULL_KEY = /^(?:TAP|TRIPS)-(\d+)$/i;
const THREAD_KEY = /^\s*(?:TAP|TRIPS)-(\d+)\b/i;
const NEXT_KEY = /^\s*,\s*([A-Z][A-Z0-9_]*-\d+)\b/i;

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

// The ticket a thread belongs to, or "" when its text does not open with a key.
export function ticketKeyFromThread(text) {
  if (typeof text !== 'string') return '';
  const match = text.match(THREAD_KEY);
  return match ? normalizeTicketKey(match[0]) : '';
}

function ticketKeysFromThread(text) {
  const keys = new Set();
  if (typeof text !== 'string') return keys;
  const first = text.match(THREAD_KEY);
  if (!first) return keys;
  keys.add(normalizeTicketKey(first[0]));
  let remaining = text.slice(first[0].length);
  while (true) {
    const match = remaining.match(NEXT_KEY);
    if (!match) break;
    const key = normalizeTicketKey(match[1]);
    if (key) keys.add(key);
    remaining = remaining.slice(match[0].length);
  }
  return keys;
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
    const keys =
      thread.subjectText === undefined
        ? [ticketKeyFromThread(thread.text)]
        : ticketKeysFromThread(thread.subjectText);
    for (const key of keys) {
      if (!key) continue;
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
