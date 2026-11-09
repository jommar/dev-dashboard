import { ticketPrefix } from './work-filters.js';

const REVIEW_LANES = [
  { id: 'to-review', label: 'To Review' },
  { id: 'reviewing', label: 'Reviewing' },
  { id: 'reviewed', label: 'Reviewed' },
];

export const hasCompletePrCoverage = (prCoverage) =>
  prCoverage?.available === true && prCoverage.complete === true;

export function queueReviewState(review) {
  if (!review?.complete || !['approved', 'changes_requested', 'awaiting'].includes(review.state))
    return 'unknown';
  if (
    review.state === 'changes_requested' ||
    review.reviewDecision === 'CHANGES_REQUESTED' ||
    review.changesRequesters?.length
  )
    return 'changes_requested';
  if (
    review.state === 'approved' ||
    review.reviewDecision === 'APPROVED' ||
    review.approvers?.length
  )
    return 'approved';
  return 'awaiting';
}

export function reviewProgress(ticket, prCoverage) {
  const prs = ticket.prs || [];
  const states = prs.map((pr) => queueReviewState(pr.review));
  if (!hasCompletePrCoverage(prCoverage) || states.includes('unknown')) return 'to-review';
  if (prs.length && prs.every((pr, index) => !pr.draft && states[index] === 'approved'))
    return 'reviewed';
  if (states.some((state) => state === 'approved' || state === 'changes_requested'))
    return 'reviewing';
  return 'to-review';
}

export function filterReviewTickets(tickets = [], filters = {}) {
  const search = (filters.search || '').trim().toLowerCase();
  return tickets.filter((ticket) => {
    const prs = ticket.prs || [];
    const text = [
      ticket.key,
      ticket.summary,
      ...prs.flatMap((pr) => [pr.title, pr.repo, pr.number]),
    ];
    return (
      (!filters.prefix || ticketPrefix(ticket.key) === filters.prefix) &&
      (!search ||
        text.some((value) =>
          String(value ?? '')
            .toLowerCase()
            .includes(search),
        )) &&
      (!filters.repo || prs.some((pr) => pr.repo === filters.repo)) &&
      (!filters.review || prs.some((pr) => queueReviewState(pr.review) === filters.review))
    );
  });
}

export function reviewColumns(tickets = [], prCoverage, filters = {}) {
  if (!tickets.length) return [];
  const progress = new Map(tickets.map((ticket) => [ticket, reviewProgress(ticket, prCoverage)]));
  const shown = filterReviewTickets(tickets, filters);
  return REVIEW_LANES.map((lane) => ({
    ...lane,
    tickets: shown.filter((ticket) => progress.get(ticket) === lane.id),
  }));
}
