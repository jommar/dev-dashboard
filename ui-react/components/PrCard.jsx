import { slug, timeAgo } from '../../ui/dom.js';
import { jiraStatusKind } from '../../ui/components/pr-card.js';
import { SprintPill } from './SprintPill.jsx';

export function PrItem({ pr, variant = 'pr-open', approval }) {
  const state = pr.draft ? 'draft' : 'open';
  const itemSuffix = `${pr.repo}-${pr.number}`;
  const testId = (name) => `${variant}-${name}-${itemSuffix}`;
  const reviewState = pr.reviews?.state;
  const reviewBadge = !pr.reviews ? null : pr.reviews.state === 'approved' ? (
    <span
      className="pill review-badge approved"
      data-review-state="approved"
      data-tooltip={`Approved by @${pr.reviews.approvers.join(', @')}`}
      data-testid={testId('review-approved')}
    >
      approved
    </span>
  ) : pr.reviews.state === 'changes_requested' ? (
    <span
      className="pill review-badge changes"
      data-review-state="changes-requested"
      data-tooltip={`Changes requested by @${pr.reviews.changesRequesters.join(', @')}`}
      data-testid={testId('review-changes')}
    >
      changes requested
    </span>
  ) : (
    <span
      className="pill review-badge pending"
      data-review-state="awaiting"
      data-tooltip="Awaiting review"
      data-testid={testId('review-pending')}
    >
      awaiting
    </span>
  );
  return (
    <div
      className="pr-item"
      data-pr-state={state}
      data-review-state={reviewState?.replace('_', '-')}
      data-testid={`${variant}-${itemSuffix}`}
    >
      <span className="pr-title">
        <a
          href={pr.url}
          target="_blank"
          rel="noopener noreferrer"
          data-testid={testId('title-link')}
        >
          {(pr.title || '').replace(/^(\[[A-Z0-9-]+\]\s*)+/i, '')}
        </a>
      </span>
      <div className="pr-meta">
        <span
          className={`pill ${pr.draft ? 'draft' : 'state'}`}
          data-pr-state={state}
          data-testid={testId(pr.draft ? 'draft' : 'state')}
        >
          {state}
        </span>
        {pr.owner && (
          <span className="pr-owner" data-testid={testId('owner')}>
            @{pr.owner}
          </span>
        )}
        <span className="pr-num" data-testid={testId('num')}>
          {pr.repo} #{pr.number}
        </span>
        {reviewBadge}
        {approval && (
          <span className="pr-approval-count" data-testid={testId('count')}>
            {approval.current} / {approval.required} approvals
          </span>
        )}
        <span className="updated" data-testid={testId('updated')}>
          {timeAgo(pr.updatedAt)}
        </span>
        <button
          type="button"
          className="btn subtle icon-btn view-diff"
          data-repo={pr.repo}
          data-number={pr.number}
          data-tooltip="View diff vs origin/ops/development"
          aria-label="View diff vs origin/ops/development"
          data-testid={`${variant}-view-diff-${itemSuffix}`}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
      </div>
    </div>
  );
}

export const PrCard = PrItem;

export function TicketPrCard({
  ticket,
  prs,
  jiraBase,
  ticketStatus,
  sprint,
  variant = 'pr-open',
  required = 1,
}) {
  const approval = variant === 'pr-approval';
  const key = slug(ticket);
  const statusKind = ticket === 'Unticketed' || !ticketStatus ? null : jiraStatusKind(ticketStatus);
  const ordered = prs.slice().sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return (
    <article
      className={`ticket-card${approval ? ' pr-approval-ticket' : ''}${variant === 'pr-draft' ? ' pr-draft-ticket' : ''}`}
      data-jira-status-kind={statusKind || undefined}
      data-testid={`${variant}-ticket-${key}`}
    >
      <div className="pr-group-head" data-testid={`${variant}-group-${key}`}>
        {ticket === 'Unticketed' ? (
          'Unticketed'
        ) : /^[A-Z]+-\d+$/.test(ticket) ? (
          <a
            className="jira-link"
            href={`${jiraBase}${ticket}`}
            target="_blank"
            rel="noopener noreferrer"
            data-testid={`${variant}-group-link-${key}`}
          >
            {ticket}
          </a>
        ) : (
          ticket
        )}
        {ticketStatus && (
          <span
            className="pill ticket-status"
            data-jira-status-kind={jiraStatusKind(ticketStatus)}
            data-tooltip={ticketStatus}
            data-testid={`${variant}-ticket-status-${key}`}
          >
            {ticketStatus}
          </span>
        )}
        {sprint && ticket !== 'Unticketed' && (
          <SprintPill sprint={sprint} testId={`${variant}-ticket-sprint-${key}`} />
        )}
        <span className="pr-count" data-testid={`${variant}-group-count-${key}`}>
          {prs.length}
        </span>
      </div>
      <div className="pr-items">
        {ordered.map((pr) => {
          const approvals = new Set(pr.reviews?.approvers || []).size;
          return (
            <PrItem
              key={`${pr.repo}#${pr.number}`}
              pr={pr}
              variant={variant}
              approval={approval ? { current: approvals, required } : undefined}
            />
          );
        })}
      </div>
    </article>
  );
}
