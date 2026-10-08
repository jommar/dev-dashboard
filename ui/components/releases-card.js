// releases-card.js — markup for the Releases tab: one PR row, one ticket card,
// one merge-state group and the version picker options. Every value that comes
// from Jira or GitHub is third-party text and goes through esc().
import { esc, slug, timeAgo } from '../dom.js';
import { jiraStatusKind } from './pr-card.js';

const DEVELOPMENT_BASE = 'ops/development';
const SAFE_LINK_RE = /^https:\/\//i;

const GROUP_TITLES = {
  open: 'Open',
  partial: 'Partially merged',
  'no-pr': 'No PRs',
  unavailable: 'PRs unavailable',
  merged: 'Merged',
};

export function releasePrRowHtml(pr) {
  const suffix = `${esc(pr.repo)}-${esc(pr.number)}`;
  const testId = (name) => `release-pr-${name}-${suffix}`;
  const baseMismatch = pr.state === 'merged' && pr.base !== DEVELOPMENT_BASE;
  const title = esc(pr.title || '');
  const titleHtml =
    pr.url && SAFE_LINK_RE.test(pr.url)
      ? `<a href="${esc(pr.url)}" target="_blank" rel="noopener noreferrer" data-testid="${testId('link')}">${title}</a>`
      : `<span data-testid="${testId('title')}">${title}</span>`;
  const baseAttributes = baseMismatch
    ? ` data-base-match="false" data-tooltip="Merged into a branch other than ${DEVELOPMENT_BASE}"`
    : '';
  return (
    `<div class="pr-item release-pr" data-pr-state="${esc(pr.state)}" data-testid="release-pr-${suffix}">` +
    `<span class="pr-title">${titleHtml}</span>` +
    '<div class="pr-meta">' +
    `<span class="pill release-pr-state" data-pr-state="${esc(pr.state)}" data-testid="${testId('state')}">${esc(pr.state)}</span>` +
    (pr.owner
      ? `<span class="pr-owner" data-testid="${testId('owner')}">@${esc(pr.owner)}</span>`
      : '') +
    `<span class="pr-num" data-testid="${testId('num')}">${esc(pr.repo)} #${esc(pr.number)}</span>` +
    `<span class="pill release-pr-base"${baseAttributes} data-testid="${testId('base')}">${esc(pr.base)}</span>` +
    (pr.head
      ? `<span class="release-pr-head" data-testid="${testId('head')}">${esc(pr.head)}</span>`
      : '') +
    (pr.updatedAt
      ? `<span class="updated" data-testid="${testId('updated')}">${esc(timeAgo(pr.updatedAt))}</span>`
      : '') +
    '</div>' +
    '</div>'
  );
}

function prListHtml(ticket) {
  if (ticket.prsStatus === 'unavailable') {
    const reason = ticket.prsError ? esc(ticket.prsError) : null;
    return `<div class="release-ticket-note" data-state="unavailable"${reason ? ` data-error="${reason}"` : ''} data-testid="release-ticket-note-${slug(ticket.key)}">PRs unavailable${reason ? ` (${reason})` : ''}</div>`;
  }
  if (!ticket.prs.length) {
    return `<div class="release-ticket-note" data-testid="release-ticket-note-${slug(ticket.key)}">No linked PRs</div>`;
  }
  return `<div class="pr-items">${ticket.prs.map(releasePrRowHtml).join('')}</div>`;
}

export function releaseTicketCardHtml(ticket, jiraBase) {
  const key = slug(ticket.key);
  const kind = jiraStatusKind(ticket.status);
  const meta = [ticket.priority, ticket.issueType, ticket.assignee]
    .filter(Boolean)
    .map(esc)
    .join(' · ');
  return (
    `<article class="ticket-card release-ticket" data-jira-status-kind="${kind}" data-merge-state="${esc(ticket.mergeState)}" data-testid="release-ticket-${key}">` +
    '<div class="pr-group-head">' +
    `<a class="jira-link" href="${esc((jiraBase || '') + ticket.key)}" target="_blank" rel="noopener noreferrer" data-testid="release-ticket-link-${key}">${esc(ticket.key)}</a>` +
    `<span class="pill ticket-status" data-jira-status-kind="${kind}" data-tooltip="${esc(ticket.status)}" data-testid="release-ticket-status-${key}">${esc(ticket.status)}</span>` +
    '</div>' +
    `<div class="release-ticket-summary" data-testid="release-ticket-summary-${key}">${esc(ticket.summary || '')}</div>` +
    (meta
      ? `<div class="release-ticket-meta" data-testid="release-ticket-meta-${key}">${meta}</div>`
      : '') +
    prListHtml(ticket) +
    '</article>'
  );
}

export function releaseGroupHtml(state, tickets, jiraBase) {
  return (
    `<section class="release-group" data-state="${esc(state)}" data-testid="releases-group-${esc(state)}">` +
    `<h3 class="release-group-head">${esc(GROUP_TITLES[state] ?? state)}` +
    `<span class="pr-count" data-testid="releases-group-count-${esc(state)}">${tickets.length}</span></h3>` +
    `<div class="release-ticket-groups">${tickets.map((ticket) => releaseTicketCardHtml(ticket, jiraBase)).join('')}</div>` +
    '</section>'
  );
}

function optionGroupHtml(label, versions, selectedId) {
  if (!versions.length) return '';
  const options = versions
    .map(
      (version) =>
        `<option value="${esc(version.id)}"${version.id === selectedId ? ' selected' : ''}>${esc(version.name)}</option>`,
    )
    .join('');
  return `<optgroup label="${label}">${options}</optgroup>`;
}

export function versionOptionsHtml(versions, selectedId) {
  return (
    optionGroupHtml(
      'Unreleased',
      versions.filter((version) => !version.released),
      selectedId,
    ) +
    optionGroupHtml(
      'Released',
      versions.filter((version) => version.released),
      selectedId,
    )
  );
}
