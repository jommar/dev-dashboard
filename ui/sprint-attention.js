// sprint-attention.js — which sprint tickets need the product owner's attention, and why.
// Pure: no DOM, no storage, no backend imports. Reasons come only from Jira fields, the Claude
// ticket map and the reply state of the Slack threads that name the ticket, never from comment,
// description or message text.
import { jiraStatusKind } from './jira-status.js';
import { TICKET_KEY } from './needs-you.js';

export const ATTENTION_REASONS = Object.freeze([
  Object.freeze({ id: 'claude-waiting', label: 'Claude waiting' }),
  Object.freeze({ id: 'groom-open', label: 'Groom: open questions' }),
  Object.freeze({ id: 'slack-reply', label: 'Slack reply owed' }),
  Object.freeze({ id: 'jira-blocked', label: 'Blocked' }),
  Object.freeze({ id: 'unassigned', label: 'Unassigned' }),
  Object.freeze({ id: 'no-estimate', label: 'No estimate' }),
  Object.freeze({ id: 'not-groomed', label: 'Not groomed' }),
]);

const REASON_INDEX = Object.fromEntries(ATTENTION_REASONS.map(({ id }, index) => [id, index]));
const SIDE_SESSIONS = ['groom', 'review', 'specReview', 'e2e', 'reviewRequest'];
const OPEN_GROOM_VERDICTS = ['NEEDS_INFO', 'BLOCKED'];

const isWaiting = (entry) =>
  entry?.state === 'waiting' || SIDE_SESSIONS.some((side) => entry?.[side]?.state === 'waiting');

const hasOpenGroom = (entry) =>
  entry?.groom?.state === 'done' && OPEN_GROOM_VERDICTS.includes(entry.groom.verdict);

// Finished: a done-kind status, or any status Jira files under Done (Rejected and Duplicate have
// other kinds in the shared table, which My Tickets and the bot bar keep).
export const isFinished = (ticket) =>
  jiraStatusKind(ticket.status) === 'done' || ticket.statusCategory === 'Done';

const hasNotStarted = (ticket) => {
  const kind = jiraStatusKind(ticket.status);
  return kind === 'queued' || (kind === 'unknown' && ticket.statusCategory === 'To Do');
};

const hasNoGroomRecord = (entry) => !entry || entry.groom?.state === 'none';

// The reasons read from Claude's session state. They need a Claude answer: before one, "no session"
// and "unknown" look alike.
export const CLAUDE_REASONS = Object.freeze(['claude-waiting', 'groom-open', 'not-groomed']);

// `slackLinks` are the ticket's Slack threads; only a known reply owed (`needsReply: true`) counts.
export function attentionReasons(ticket, entry, { claudeLoaded, slackLinks = [] }) {
  if (isFinished(ticket)) return [];
  const fires = {
    'claude-waiting': isWaiting(entry),
    'groom-open': hasOpenGroom(entry),
    'slack-reply': slackLinks.some((thread) => thread?.needsReply === true),
    'jira-blocked': jiraStatusKind(ticket.status) === 'attention',
    unassigned: ticket.assignee == null,
    'no-estimate': ticket.storyPoints == null,
    'not-groomed': hasNoGroomRecord(entry) && hasNotStarted(ticket),
  };
  return ATTENTION_REASONS.map(({ id }) => id).filter(
    (id) => fires[id] && (claudeLoaded || !CLAUDE_REASONS.includes(id)),
  );
}

export function sprintSummary(tickets, reasonsByKey) {
  const reasons = Object.fromEntries(ATTENTION_REASONS.map(({ id }) => [id, 0]));
  let points = 0;
  let donePoints = 0;
  let unestimated = 0;
  for (const ticket of tickets) {
    if (ticket.storyPoints == null) unestimated += 1;
    else {
      points += ticket.storyPoints;
      if (isFinished(ticket)) donePoints += ticket.storyPoints;
    }
    for (const id of reasonsByKey[ticket.key] ?? []) reasons[id] += 1;
  }
  return { count: tickets.length, points, donePoints, unestimated, reasons };
}

// OR across the selected reasons; no selection lets every ticket through.
export const matchesReasons = (ids, selected) =>
  selected.length === 0 || ids.some((id) => selected.includes(id));

export function attentionOrder(tickets, reasonsByKey) {
  const reasonsOf = (ticket) => reasonsByKey[ticket.key] ?? [];
  return tickets
    .filter((ticket) => reasonsOf(ticket).length > 0)
    .sort((a, b) => {
      const [aReasons, bReasons] = [reasonsOf(a), reasonsOf(b)];
      return (
        REASON_INDEX[aReasons[0]] - REASON_INDEX[bReasons[0]] ||
        bReasons.length - aReasons.length ||
        a.key.localeCompare(b.key, undefined, { numeric: true })
      );
    });
}

// The cap is global: groom sessions already working anywhere count against it.
export const GROOM_BATCH_MAX = 5;

export function groomCandidates(tickets, reasonsByKey, byTicket) {
  const working = Object.values(byTicket ?? {}).filter(
    (entry) => entry?.groom?.state === 'working',
  ).length;
  const room = Math.max(0, GROOM_BATCH_MAX - working);
  return tickets
    .map((ticket) => ticket.key)
    .filter((key) => TICKET_KEY.test(key) && (reasonsByKey[key] ?? []).includes('not-groomed'))
    .slice(0, room);
}

// A groom already running is skipped and the batch goes on; any other refusal stops the rest.
export function groomOutcome(result) {
  if (result?.ok) return { outcome: 'started', words: 'Started', stop: false };
  if (result?.code === 'CLAUDE_REFUSED' && result.errors?.[0] === 'session_running') {
    return { outcome: 'skipped', words: 'Skipped (already grooming)', stop: false };
  }
  return { outcome: 'failed', words: 'Failed', stop: true };
}
