// pr-open-section.js — "Your open PRs": the static shell (heading, refresh
// button, live countdown, and the #prs-list container) that pr-panel.js
// mounts once, plus the list body — ticket cards / empty / unavailable
// states — rebuilt on every poll tick.
import { ticketCardHtml } from './pr-card.js';
import { spinnerHtml } from './spinner.js';

export function prOpenSectionShellHtml() {
  return (
    `<section class="pr-open-section" data-testid="pr-open-section">` +
    `<h3 class="pr-section-heading" data-testid="open-prs-title">` +
    `<span class="section-label">Your open PRs</span>` +
    `<span id="prs-meta" class="pr-open-count" data-testid="prs-meta" role="status">loading…</span>` +
    `<button id="prs-refresh" class="btn" data-testid="prs-refresh">Refresh</button>` +
    `<span id="prs-next" class="pr-next" data-testid="prs-next"></span>` +
    `</h3>` +
    `<div id="prs-list" class="pr-open-groups" data-testid="prs-list">${spinnerHtml({ label: 'Loading pull requests…', testId: 'prs-loading' })}</div>` +
    '</section>'
  );
}

export function prOpenListHtml(data, jiraBase) {
  if (data.prsAvailable === false) {
    return '<div class="pr-error" data-testid="prs-unavailable">GitHub is unavailable. Refresh to try again.</div>';
  }
  const groups = Object.entries(data.groups)
    .map(([ticket, prs]) => [ticket, prs.filter((pr) => !pr.draft)])
    .filter(([, prs]) => prs.length);
  if (!groups.length) {
    return '<div class="pr-empty">No open PRs.</div>';
  }
  const statuses = data.ticketStatuses || {};
  return groups
    .map(([ticket, prs]) =>
      ticketCardHtml(ticket, prs, statuses[ticket], jiraBase, {
        variant: 'pr-open',
        sprint: data.ticketSprints?.[ticket],
      }),
    )
    .join('');
}
