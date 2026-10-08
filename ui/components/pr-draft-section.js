import { ticketCardHtml } from './pr-card.js';

export function prDraftSectionHtml(data, jiraBase) {
  const count = (data.draftPrs || []).length;
  const heading =
    `<h3 class="pr-section-heading">Your draft PRs` +
    `<span class="pr-approval-count-total" data-testid="pr-draft-count">${count}</span></h3>`;
  let body;
  if (data.prsAvailable === false) {
    body = '<div class="pr-error">GitHub is unavailable. Refresh to try again.</div>';
  } else if (!count) {
    body = '<div class="pr-empty">No draft PRs.</div>';
  } else {
    body = `<div class="pr-draft-groups">${Object.entries(data.draftGroups || {})
      .map(([ticket, prs]) =>
        ticketCardHtml(ticket, prs, data.ticketStatuses?.[ticket], jiraBase, {
          variant: 'pr-draft',
          sprint: data.ticketSprints?.[ticket],
        }),
      )
      .join('')}</div>`;
  }
  return `<section class="pr-draft-section" data-testid="pr-draft-section">${heading}${body}</section>`;
}
