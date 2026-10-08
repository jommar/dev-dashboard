// pr-approval-section.js — "Open PRs needing approval": PRs below the
// approval threshold, already narrowed server-side to Ready For Code Review
// ticketed groups (Unticketed exempt), grouped by ticket.
import { ticketCardHtml } from './pr-card.js';

export function prApprovalSectionHtml(data, jiraBase) {
  const threshold = Number.isFinite(Number(data.approvalThreshold))
    ? Number(data.approvalThreshold)
    : 1;
  const approvalDataAvailable =
    data.approvalDataAvailable !== undefined
      ? data.approvalDataAvailable
      : data.reviewDataAvailable;
  const groups = data.approvalGroups || {};
  const needingApproval = data.prsNeedingApproval || data.prsNeedingApprovals || [];
  const count = Array.isArray(needingApproval) ? needingApproval.length : 0;
  const heading =
    `<h3 class="pr-section-heading" data-testid="pr-approval-heading">` +
    `Open PRs needing approval (${threshold} required)` +
    `<span class="pr-approval-count-total" data-testid="pr-approval-count">${count}</span>` +
    '</h3>';

  let body;
  if (approvalDataAvailable === false || approvalDataAvailable === undefined) {
    body =
      '<div class="pr-approval-unavailable" data-testid="pr-approval-unavailable">Review data unavailable.</div>';
  } else if (!count) {
    body =
      '<div class="pr-approval-empty" data-testid="pr-approval-empty">No open PRs below the approval threshold.</div>';
  } else {
    const statuses = data.approvalTicketStatuses || {};
    body = `<div class="pr-approval-groups">${Object.entries(groups)
      .map(([ticket, prs]) =>
        ticketCardHtml(ticket, prs, statuses[ticket], jiraBase, {
          variant: 'pr-approval',
          required: threshold,
          sprint: data.approvalTicketSprints?.[ticket],
        }),
      )
      .join('')}</div>`;
  }

  return `<section class="pr-approval-section" data-testid="pr-approval-section">${heading}${body}</section>`;
}
