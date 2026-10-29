// slack-ticket-links.js — DOM-free matching between Jira tickets and the Slack
// threads whose subject names them. No backend imports: this ships in the
// browser bundle.
//
// Threads are named "<KEY>: <subject>", so the opening text is the only place a
// ticket key is trustworthy. Two rules follow from that, both deliberate:
//
// - TRIPS becomes TAP. Jira renamed the project, so threads written before the
//   rename still say "TRIPS-2165" for what is now TAP-2165. Folding both
//   spellings onto one key is what lets those older threads match today's ticket.
// - Only a key that STARTS the text counts. A thread that mentions a ticket
//   mid-sentence ("follow-up to TAP-12") is not about that ticket, and linking on
//   it would attach an unrelated conversation to the ticket's row.

const FULL_KEY = /^(?:TAP|TRIPS)-(\d+)$/i;
const THREAD_KEY = /^\s*(?:TAP|TRIPS)-(\d+)\b/i;

// A key of this project becomes "TAP-<number>"; anything else (another project,
// a bare number, a non-string) becomes "".
export function normalizeTicketKey(value) {
  if (typeof value !== 'string') return '';
  const match = value.trim().match(FULL_KEY);
  return match ? `TAP-${match[1]}` : '';
}

// The ticket a thread belongs to, or "" when its text does not open with a key.
export function ticketKeyFromThread(text) {
  if (typeof text !== 'string') return '';
  const match = text.match(THREAD_KEY);
  return match ? normalizeTicketKey(match[0]) : '';
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

// Every thread grouped under its ticket key, each group newest activity first.
// A thread without a key or without a link has nowhere to go and is skipped.
export function threadsByTicket(started) {
  const byTicket = new Map();
  if (!Array.isArray(started)) return byTicket;
  for (const thread of started) {
    const key = ticketKeyFromThread(thread?.text);
    if (!key || !thread.url) continue;
    // Fresh arrays hold the caller's thread objects: neither the list nor the
    // threads themselves are touched.
    const bucket = byTicket.get(key);
    if (bucket) bucket.push(thread);
    else byTicket.set(key, [thread]);
  }
  for (const bucket of byTicket.values()) bucket.sort(newestFirst);
  return byTicket;
}
