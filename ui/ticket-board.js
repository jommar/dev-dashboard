// ticket-board.js — DOM-free ordering and wording for the My Tickets board.
// No backend imports and no DOM access: this ships in the browser bundle.
import { jiraStatusKind } from './components/pr-card.js';

// Workflow bands, left to right: attention first so blocked work is visible
// without scrolling, Done last.
const BANDS = ['attention', 'queued', 'active', 'done'];

// Ranks inside each band, lower-cased and in workflow order. A status listed
// here sorts by its rank whatever Jira's category says for it.
const RANKED = {
  attention: ['blocked', 'impediment', 'rejected', 'active incident', 'cs escalation'],
  queued: [
    'backlog',
    'parking lot',
    'needs definition',
    'needs grooming',
    'asynchronous grooming',
    'discovery',
    'open',
    'to do',
    'selected for development',
    'ready for scheduling',
    'scheduled',
    'assigned',
    'duplicate',
  ],
  active: [
    'in progress',
    'work in progress',
    'in development',
    'reopened',
    'pending',
    'ready for code review',
    'code review',
    'in review',
    'awaiting merge',
    'ready for testing',
    'testing in progress',
    'testing',
    'qa',
    'in remediation',
    'stakeholder sign off',
    'impact',
    'promote to uat',
    'ready for delivery',
    'delivery',
  ],
  done: [
    'hardening in uat',
    'ready for deployment',
    'deployed',
    'remediated',
    'resolved',
    'complete',
    'done',
    'closed',
  ],
};
const RANK = new Map(
  BANDS.flatMap((band) =>
    RANKED[band].map((name, index) => [name, { band: BANDS.indexOf(band), rank: index }]),
  ),
);

// Where a status without a rank goes: its colour band if Jira's colour map knows
// it, otherwise its Jira category (To Do queued, Done done, anything else active).
function bandOf(status, category) {
  const kind = jiraStatusKind(status);
  if (kind !== 'unknown') return BANDS.indexOf(kind);
  const name = String(category ?? '')
    .trim()
    .toLowerCase();
  if (name === 'to do') return BANDS.indexOf('queued');
  if (name === 'done') return BANDS.indexOf('done');
  return BANDS.indexOf('active');
}

function placeOf(status, category) {
  const ranked = RANK.get(status.trim().toLowerCase());
  if (ranked) return ranked;
  return { band: bandOf(status, category), rank: Infinity };
}

// Band, then rank (unranked statuses after the ranked ones), then name A to Z.
function comparePlaces(a, b) {
  if (a.place.band !== b.place.band) return a.place.band - b.place.band;
  if (a.place.rank !== b.place.rank) return a.place.rank < b.place.rank ? -1 : 1;
  return a.status.localeCompare(b.status);
}

// One column per status present, in workflow order. Tickets keep their input
// order inside a column, and the input is never mutated.
export function boardColumns(tickets = []) {
  const columns = new Map();
  for (const ticket of tickets) {
    const status = ticket.status || 'Unknown';
    const column = columns.get(status);
    if (column) column.tickets.push(ticket);
    else
      columns.set(status, {
        status,
        place: placeOf(status, ticket.statusCategory),
        tickets: [ticket],
      });
  }
  return [...columns.values()].sort(comparePlaces).map(({ status, tickets: list }) => ({
    status,
    kind: jiraStatusKind(status),
    tickets: list,
  }));
}

const FAILING_NAMES_SHOWN = 3;

// The CI line as words: the state, the counts, and at most three failing checks. A
// count is printed only when its bucket is non-empty: the state comes from the whole
// rollup while the counts come from the first page of checks, so an empty bucket
// would print a ratio the data does not support.
export function ciSummaryText(ci) {
  if (!ci) return 'CI status unavailable';
  const total = ci.passed + ci.failed + ci.pending;
  if (ci.state === 'none') return 'No CI checks';
  if (ci.state === 'passing') {
    return ci.passed > 0 ? `CI passing (${ci.passed} of ${total})` : 'CI passing';
  }
  if (ci.state === 'pending') {
    return ci.pending > 0 ? `CI pending (${ci.pending} of ${total} running)` : 'CI pending';
  }
  if (ci.state === 'failing') {
    const failing = Array.isArray(ci.failing) ? ci.failing : [];
    const names = failing.slice(0, FAILING_NAMES_SHOWN).join(', ');
    const more =
      failing.length > FAILING_NAMES_SHOWN ? ` +${failing.length - FAILING_NAMES_SHOWN} more` : '';
    const head = names ? `CI failing: ${names}${more}` : 'CI failing';
    return ci.failed > 0 ? `${head} (${ci.failed} of ${total} failed)` : head;
  }
  return 'CI status unavailable';
}

const REVIEW_WORDS = new Map([
  ['approved', 'approved'],
  ['changes_requested', 'changes requested'],
  ['awaiting', 'awaiting'],
]);

// The review state in words. Unreadable review data reads as unknown, never throws.
export function reviewText(review) {
  return REVIEW_WORDS.get(review?.state) ?? 'review unknown';
}
