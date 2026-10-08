// pr-uat-promote-section.js — "PR merge candidates to ops/development": open
// PRs for tickets the current user has moved to Promote to UAT. Filtered at
// Jira-query time (see uat-promote.mjs's UAT_PROMOTE_STATUS), not by the
// ticket-status filter the other two sections use — out of scope here.
import { ticketCardHtml } from './pr-card.js';

export function prUatPromoteSectionHtml(data, jiraBase) {
  const available = data.uatPromoteAvailable;
  const groups = data.uatPromoteGroups || {};
  const count = Number.isFinite(Number(data.uatPromoteTotal)) ? Number(data.uatPromoteTotal) : 0;
  const heading =
    `<h3 class="pr-section-heading" data-testid="pr-uat-promote-heading">` +
    `PR merge candidates to ops/development` +
    `<span class="pr-approval-count-total" data-testid="pr-uat-promote-count">${count}</span>` +
    '</h3>';

  let body;
  if (available === false || available === undefined) {
    body =
      '<div class="pr-approval-unavailable" data-testid="pr-uat-promote-unavailable">Promote-to-UAT data unavailable.</div>';
  } else if (!count) {
    body =
      '<div class="pr-approval-empty" data-testid="pr-uat-promote-empty">No PRs ready to merge to ops/development.</div>';
  } else {
    body = `<div class="pr-approval-groups">${Object.entries(groups)
      .map(([ticket, group]) =>
        ticketCardHtml(ticket, group.prs, group.ticket?.status, jiraBase, {
          variant: 'pr-uat-promote',
          sprint: group.ticket?.sprint,
        }),
      )
      .join('')}</div>`;
  }

  return `<section class="pr-approval-section" data-testid="pr-uat-promote-section">${heading}${body}</section>`;
}
