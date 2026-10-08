// my-tickets-card.js — markup for one Jira ticket row and one statusCategory
// section (with status-name sub-groups). Status rail/tint reuses the shared
// jiraStatusKind mapping from pr-card.js so colors stay consistent.
import { esc, slug, timeAgo } from '../dom.js';
import { inSprints } from '../home-data.js';
import { jiraStatusKind } from './pr-card.js';
import { sprintPillHtml } from './sprint-pill.js';

// `options` exists so Home's sprint drill-down can reuse this exact row: it
// adds a points pill, drops the sprint pill (every row there is already in the
// sprint being expanded) and re-prefixes the testids — both panels are in the
// DOM at once, so a shared prefix would make every ticket testid ambiguous.
// Defaults reproduce the My Tickets rendering byte for byte, so the two views
// can never drift.
export function ticketRowHtml(t, jiraBase, options = {}) {
  const {
    extraMeta = '',
    showSprint = true,
    testIdPrefix = 'my-tickets-item',
    currentSprints = null,
  } = options;
  const key = slug(t.key);
  const tid = (name) => esc(name ? `${testIdPrefix}-${name}-${key}` : `${testIdPrefix}-${key}`);
  const kind = jiraStatusKind(t.status);
  const meta = [t.priority, t.issueType].filter(Boolean).map(esc).join(' · ');
  // currentSprints is the payload's activeSprints (one per board the user spans).
  // Left null by Home's drill-down, whose rows are all in the sprint being
  // expanded — highlighting them there would be noise.
  const inCurrent = currentSprints ? inSprints(t, currentSprints) : false;
  return (
    `<div class="my-ticket" data-jira-status-kind="${kind}"${inCurrent ? ' data-in-current-sprint="true"' : ''} data-testid="${tid()}">` +
    `<span class="my-ticket-key"><a class="jira-link" href="${esc((jiraBase || '') + t.key)}" target="_blank" data-testid="${tid('link')}">${esc(t.key)}</a></span>` +
    `<span class="my-ticket-summary" data-testid="${tid('summary')}">${esc(t.summary || '')}</span>` +
    '<div class="my-ticket-meta">' +
    `<span class="pill ticket-status" data-jira-status-kind="${kind}" data-tooltip="${esc(t.status)}" data-testid="${tid('status')}">${esc(t.status)}</span>` +
    (showSprint ? sprintPillHtml(t.sprint, `my-tickets-item-sprint-${key}`) : '') +
    extraMeta +
    (meta ? `<span class="my-ticket-sub" data-testid="${tid('sub')}">${meta}</span>` : '') +
    (t.updated
      ? `<span class="updated" data-testid="${tid('updated')}">${esc(timeAgo(t.updated))}</span>`
      : '') +
    '</div>' +
    '</div>'
  );
}

export function myTicketsCategoryHtml(category, tickets, jiraBase, currentSprints = null) {
  const catKey = slug(category);
  // Tickets arrive sorted by status name; sub-group without re-sorting.
  const byStatus = {};
  for (const t of tickets) (byStatus[t.status || 'Unknown'] ||= []).push(t);
  const sameStatus = Object.keys(byStatus).length === 1 && Object.keys(byStatus)[0] === category;
  const groups = Object.entries(byStatus)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([status, list]) => {
      const stKey = slug(status);
      const kind = jiraStatusKind(status);
      const rows = list.map((t) => ticketRowHtml(t, jiraBase, { currentSprints })).join('');
      return (
        `<div class="my-ticket-status-group" data-jira-status-kind="${kind}" data-testid="my-tickets-status-${catKey}-${stKey}">` +
        `<div class="my-ticket-status-head"${sameStatus ? ' hidden' : ''} data-testid="my-tickets-status-head-${catKey}-${stKey}">${esc(status)}` +
        `<span class="pr-count" data-testid="my-tickets-status-count-${catKey}-${stKey}">${list.length}</span></div>` +
        `<div class="my-ticket-rows">${rows}</div>` +
        '</div>'
      );
    })
    .join('');
  return (
    `<section class="my-ticket-category" data-testid="my-tickets-category-${catKey}">` +
    `<h4 class="my-ticket-category-head" data-testid="my-tickets-category-head-${catKey}">${esc(category)}` +
    `<span class="pr-count" data-testid="my-tickets-category-count-${catKey}">${tickets.length}</span></h4>` +
    `<div class="my-ticket-groups">${groups}</div>` +
    '</section>'
  );
}

export function myTicketsHtml(groupsByCategory, jiraBase, currentSprints = null) {
  const entries = Object.entries(groupsByCategory || {});
  if (!entries.length)
    return '<div class="pr-empty" data-testid="my-tickets-empty">No tickets assigned to you.</div>';
  return entries
    .map(([cat, list]) => myTicketsCategoryHtml(cat, list, jiraBase, currentSprints))
    .join('');
}
