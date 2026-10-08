// pr-card.js — markup for one PR row and one ticket group card.
import { esc, slug, timeAgo } from '../dom.js';
import { sprintPillHtml } from './sprint-pill.js';

const TICKET_RE = /^[A-Z]+-\d+$/;

const JIRA_STATUS_KIND = {
  // Queued (muted): early backlog / not yet in flight.
  'to do': 'queued',
  open: 'queued',
  backlog: 'queued',
  'selected for development': 'queued',
  'parking lot': 'queued',
  'needs definition': 'queued',
  'needs grooming': 'queued',
  'asynchronous grooming': 'queued',
  assigned: 'queued',
  scheduled: 'queued',
  'ready for scheduling': 'queued',
  discovery: 'queued',
  duplicate: 'queued',
  // Active (accent): in flight plus review/test/merge gates. Jira files
  // several of these under the "To Do" category (e.g. Ready For Code Review,
  // Ready For Testing, Awaiting Merge), so they are listed explicitly.
  'in progress': 'active',
  'work in progress': 'active',
  pending: 'active',
  'in development': 'active',
  'in review': 'active',
  'ready for code review': 'active',
  'ready for testing': 'active',
  'testing in progress': 'active',
  testing: 'active',
  qa: 'active',
  'awaiting merge': 'active',
  'stakeholder sign off': 'active',
  'promote to uat': 'active',
  delivery: 'active',
  'ready for delivery': 'active',
  impact: 'active',
  'in remediation': 'active',
  reopened: 'active',
  // Done (green): terminal success states.
  done: 'done',
  complete: 'done',
  deployed: 'done',
  closed: 'done',
  resolved: 'done',
  remediated: 'done',
  'hardening in uat': 'done',
  'ready for deployment': 'done',
  // Attention (red): blocked / negative terminal / escalation states.
  blocked: 'attention',
  impediment: 'attention',
  rejected: 'attention',
  'active incident': 'attention',
  'cs escalation': 'attention',
};

function jiraStatusKind(status) {
  return JIRA_STATUS_KIND[String(status).trim().toLowerCase()] || 'unknown';
}

export { jiraStatusKind };

export function viewDiffButtonHtml(p, variant) {
  const itemSuffix = `${esc(p.repo)}-${esc(p.number)}`;
  return (
    `<button type="button" class="btn subtle icon-btn view-diff" data-repo="${esc(p.repo)}" data-number="${esc(p.number)}"` +
    ` data-tooltip="View diff vs origin/ops/development" aria-label="View diff vs origin/ops/development"` +
    ` data-testid="${variant}-view-diff-${itemSuffix}">` +
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">' +
    '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"></path><circle cx="12" cy="12" r="3"></circle>' +
    '</svg></button>'
  );
}

function reviewBadge(rv, variant, itemSuffix) {
  if (!rv) return '';
  if (rv.state === 'approved') {
    return `<span class="pill review-badge approved" data-review-state="approved" data-tooltip="${esc('Approved by @' + rv.approvers.join(', @'))}" data-testid="${variant}-review-approved-${itemSuffix}">approved</span>`;
  }
  if (rv.state === 'changes_requested') {
    return `<span class="pill review-badge changes" data-review-state="changes-requested" data-tooltip="${esc('Changes requested by @' + rv.changesRequesters.join(', @'))}" data-testid="${variant}-review-changes-${itemSuffix}">changes requested</span>`;
  }
  return `<span class="pill review-badge pending" data-review-state="awaiting" data-tooltip="Awaiting review" data-testid="${variant}-review-pending-${itemSuffix}">awaiting</span>`;
}

export function prItemHtml(p, options = {}) {
  const { variant = 'pr-open', approval } = options;
  const prState = p.draft ? 'draft' : 'open';
  const itemSuffix = `${esc(p.repo)}-${esc(p.number)}`;
  const testId = (name) => `${variant}-${name}-${itemSuffix}`;
  const state = p.draft
    ? `<span class="pill draft" data-pr-state="draft" data-testid="${testId('draft')}">draft</span>`
    : `<span class="pill state" data-pr-state="open" data-testid="${testId('state')}">open</span>`;
  const reviewState = p.reviews && p.reviews.state;
  const itemTestId = `${variant}-${esc(p.repo)}-${esc(p.number)}`;
  const approvalMeta = approval
    ? `<span class="pr-approval-count" data-testid="${testId('count')}">${approval.current} / ${approval.required} approvals</span>`
    : '';
  // The ticket key is already the group heading, so strip it from the title.
  const title = esc((p.title || '').replace(/^(\[[A-Z0-9-]+\]\s*)+/i, ''));
  return (
    `<div class="pr-item" data-pr-state="${prState}"${reviewState ? ` data-review-state="${esc(reviewState.replace('_', '-'))}"` : ''} data-testid="${itemTestId}">` +
    `<span class="pr-title"><a href="${esc(p.url)}" target="_blank" data-testid="${testId('title-link')}">${title}</a></span>` +
    '<div class="pr-meta">' +
    state +
    (p.owner
      ? `<span class="pr-owner" data-testid="${testId('owner')}">@${esc(p.owner)}</span>`
      : '') +
    `<span class="pr-num" data-testid="${testId('num')}">${esc(p.repo)} #${p.number}</span>` +
    reviewBadge(p.reviews || null, variant, itemSuffix) +
    approvalMeta +
    `<span class="updated" data-testid="${testId('updated')}">${esc(timeAgo(p.updatedAt))}</span>` +
    viewDiffButtonHtml(p, variant) +
    '</div>' +
    '</div>'
  );
}

export function ticketCardHtml(ticket, prs, ticketStatus, jiraBase, options = {}) {
  const { variant = 'pr-open', required = 1, sprint } = options;
  const isApproval = variant === 'pr-approval';
  const statusKind = ticketStatus ? jiraStatusKind(ticketStatus) : null;
  const key = slug(ticket);
  const label =
    ticket === 'Unticketed'
      ? 'Unticketed'
      : TICKET_RE.test(ticket)
        ? `<a class="jira-link" href="${esc(jiraBase + ticket)}" target="_blank" data-testid="${variant}-group-link-${key}">${esc(ticket)}</a>`
        : esc(ticket);
  const status = ticketStatus
    ? `<span class="pill ticket-status" data-jira-status-kind="${statusKind}" data-tooltip="${esc(ticketStatus)}" data-testid="${variant}-ticket-status-${key}">${esc(ticketStatus)}</span>`
    : '';
  // Newest-first within a group (the server sorts too; this is cheap insurance).
  const items = prs
    .slice()
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .map((pr) => {
      if (!isApproval) return prItemHtml(pr, { variant });
      const current = new Set((pr.reviews && pr.reviews.approvers) || []).size;
      return prItemHtml(pr, { variant, approval: { current, required } });
    })
    .join('');
  // The approval variant keeps its modifier class for the boxed inner style;
  // the open variant stays flat. Visuals unchanged, one builder for both.
  return (
    `<article class="ticket-card${isApproval ? ' pr-approval-ticket' : ''}${variant === 'pr-draft' ? ' pr-draft-ticket' : ''}"${statusKind ? ` data-jira-status-kind="${statusKind}"` : ''} data-testid="${variant}-ticket-${key}">` +
    `<div class="pr-group-head" data-testid="${variant}-group-${key}">${label}${status}` +
    (sprint && ticket !== 'Unticketed'
      ? sprintPillHtml(sprint, `${variant}-ticket-sprint-${key}`)
      : '') +
    `<span class="pr-count" data-testid="${variant}-group-count-${key}">${prs.length}</span></div>` +
    `<div class="pr-items">${items}</div>` +
    '</article>'
  );
}
