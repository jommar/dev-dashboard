import { slug, timeAgo } from '../../ui/dom.js';
import { jiraStatusKind } from '../../ui/components/pr-card.js';

const DEVELOPMENT_BASE = 'ops/development';
const SAFE_LINK_RE = /^https:\/\//i;
const GROUP_TITLES = {
  open: 'Open',
  partial: 'Partially merged',
  'no-pr': 'No PRs',
  unavailable: 'PRs unavailable',
  merged: 'Merged',
};

function ReleasePrRow({ pr }) {
  const suffix = `${pr.repo}-${pr.number}`;
  const testId = (name) => `release-pr-${name}-${suffix}`;
  const mismatch = pr.state === 'merged' && pr.base !== DEVELOPMENT_BASE;
  const title = pr.title || '';
  return (
    <div
      className="pr-item release-pr"
      data-pr-state={pr.state}
      data-testid={`release-pr-${suffix}`}
    >
      <span className="pr-title">
        {pr.url && SAFE_LINK_RE.test(pr.url) ? (
          <a href={pr.url} target="_blank" rel="noopener noreferrer" data-testid={testId('link')}>
            {title}
          </a>
        ) : (
          <span data-testid={testId('title')}>{title}</span>
        )}
      </span>
      <div className="pr-meta">
        <span
          className="pill release-pr-state"
          data-pr-state={pr.state}
          data-testid={testId('state')}
        >
          {pr.state}
        </span>
        <span className="pr-num" data-testid={testId('num')}>
          {pr.repo} #{pr.number}
        </span>
        <span
          className="pill release-pr-base"
          data-base-match={mismatch ? 'false' : undefined}
          data-tooltip={
            mismatch ? `Merged into a branch other than ${DEVELOPMENT_BASE}` : undefined
          }
          data-testid={testId('base')}
        >
          {pr.base}
        </span>
        {pr.head && (
          <span className="release-pr-head" data-testid={testId('head')}>
            {pr.head}
          </span>
        )}
        {pr.updatedAt && (
          <span className="updated" data-testid={testId('updated')}>
            {timeAgo(pr.updatedAt)}
          </span>
        )}
      </div>
    </div>
  );
}

function ReleaseTicketCard({ ticket, jiraBase }) {
  const key = slug(ticket.key);
  const kind = jiraStatusKind(ticket.status);
  const meta = [ticket.priority, ticket.issueType, ticket.assignee].filter(Boolean).join(' · ');
  return (
    <article
      className="ticket-card release-ticket"
      data-jira-status-kind={kind}
      data-merge-state={ticket.mergeState}
      data-testid={`release-ticket-${key}`}
    >
      <div className="pr-group-head">
        <a
          className="jira-link"
          href={`${jiraBase || ''}${ticket.key}`}
          target="_blank"
          rel="noopener noreferrer"
          data-testid={`release-ticket-link-${key}`}
        >
          {ticket.key}
        </a>
        <span
          className="pill ticket-status"
          data-jira-status-kind={kind}
          data-tooltip={ticket.status}
          data-testid={`release-ticket-status-${key}`}
        >
          {ticket.status}
        </span>
      </div>
      <div className="release-ticket-summary" data-testid={`release-ticket-summary-${key}`}>
        {ticket.summary || ''}
      </div>
      {meta && (
        <div className="release-ticket-meta" data-testid={`release-ticket-meta-${key}`}>
          {meta}
        </div>
      )}
      {ticket.prsStatus === 'unavailable' ? (
        <div
          className="release-ticket-note"
          data-state="unavailable"
          data-error={ticket.prsError || undefined}
          data-testid={`release-ticket-note-${key}`}
        >
          PRs unavailable{ticket.prsError ? ` (${ticket.prsError})` : ''}
        </div>
      ) : !ticket.prs.length ? (
        <div className="release-ticket-note" data-testid={`release-ticket-note-${key}`}>
          No linked PRs
        </div>
      ) : (
        <div className="pr-items">
          {ticket.prs.map((pr) => (
            <ReleasePrRow key={`${pr.repo}#${pr.number}`} pr={pr} />
          ))}
        </div>
      )}
    </article>
  );
}

function ReleaseTicketRow({ ticket, jiraBase }) {
  const key = slug(ticket.key);
  const kind = jiraStatusKind(ticket.status);
  const meta = [ticket.priority, ticket.issueType, ticket.assignee].filter(Boolean).join(' · ');
  return (
    <li
      className="release-row"
      data-jira-status-kind={kind}
      data-merge-state={ticket.mergeState}
      data-testid={`release-row-${key}`}
    >
      <a
        className="jira-link"
        href={`${jiraBase || ''}${ticket.key}`}
        target="_blank"
        rel="noopener noreferrer"
        data-testid={`release-row-link-${key}`}
      >
        {ticket.key}
      </a>
      <span className="release-row-summary" data-testid={`release-row-summary-${key}`}>
        {ticket.summary || ''}
      </span>
      <span
        className="pill ticket-status"
        data-jira-status-kind={kind}
        data-tooltip={ticket.status}
        data-testid={`release-row-status-${key}`}
      >
        {ticket.status}
      </span>
      {meta && (
        <span className="release-row-meta" data-testid={`release-row-meta-${key}`}>
          {meta}
        </span>
      )}
      <span className="release-row-prs" data-testid={`release-row-prs-${key}`}>
        {ticket.prsStatus === 'unavailable' ? (
          <span className="release-row-note" data-state="unavailable">
            PRs unavailable{ticket.prsError ? ` (${ticket.prsError})` : ''}
          </span>
        ) : !ticket.prs.length ? (
          <span className="release-row-note">No linked PRs</span>
        ) : (
          ticket.prs.map((pr) => (
            <span
              className="release-row-pr"
              data-pr-state={pr.state}
              key={`${pr.repo}#${pr.number}`}
              data-testid={`release-row-pr-${pr.repo}-${pr.number}`}
            >
              <span className="pill release-pr-state" data-pr-state={pr.state}>
                {pr.state}
              </span>
              {pr.url && SAFE_LINK_RE.test(pr.url) ? (
                <a href={pr.url} target="_blank" rel="noopener noreferrer">
                  {pr.repo} #{pr.number}
                </a>
              ) : (
                <span>
                  {pr.repo} #{pr.number}
                </span>
              )}
            </span>
          ))
        )}
      </span>
    </li>
  );
}

export function ReleaseGroups({ groups, jiraBase, view = 'cards' }) {
  if (!groups.length)
    return (
      <div className="pr-empty" data-testid="releases-empty">
        No tickets in this release.
      </div>
    );
  return groups.map(({ state, tickets }) => (
    <section
      className="release-group"
      data-state={state}
      data-view={view}
      data-testid={`releases-group-${state}`}
      key={state}
    >
      <h3 className="release-group-head">
        {GROUP_TITLES[state] ?? state}
        <span className="pr-count" data-testid={`releases-group-count-${state}`}>
          {tickets.length}
        </span>
      </h3>
      {view === 'list' ? (
        <ul className="release-rows">
          {tickets.map((ticket) => (
            <ReleaseTicketRow key={ticket.key} ticket={ticket} jiraBase={jiraBase} />
          ))}
        </ul>
      ) : (
        <div className="release-ticket-groups">
          {tickets.map((ticket) => (
            <ReleaseTicketCard key={ticket.key} ticket={ticket} jiraBase={jiraBase} />
          ))}
        </div>
      )}
    </section>
  ));
}
