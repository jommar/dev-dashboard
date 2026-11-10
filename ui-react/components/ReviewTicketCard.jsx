import { useLayoutEffect, useRef } from 'react';
import { slug } from '../../ui/dom.js';
import { hasCompletePrCoverage, queueReviewState } from '../../ui/review-board.js';
import { reviewText } from '../../ui/ticket-board.js';
import { TicketLaunchers } from './TicketLaunchers.jsx';
import { DiffViewer } from './DiffViewer.jsx';

export function ReviewTicketCard({
  ticket,
  jiraBase,
  prCoverage,
  linksByTicket,
  onOpenThread,
  onOpenClaude,
}) {
  const cardRef = useRef(null);
  const prs = ticket.prs || [];
  const discoveryComplete = hasCompletePrCoverage(prCoverage);
  const reviewIncomplete = prs.some((pr) => queueReviewState(pr.review) === 'unknown');

  // A lane change remounts the card. Restore only a lost card action, never unrelated focus.
  useLayoutEffect(() => {
    const card = cardRef.current;
    return () => {
      const focused = document.activeElement;
      if (!card.contains(focused)) return;
      const panel = card.closest('[data-testid="panel-prs"]');
      const testId = focused.dataset.testid;
      queueMicrotask(() => {
        if (focused.isConnected || !panel?.isConnected || panel.hidden) return;
        if (document.activeElement !== document.body) return;
        const target =
          (testId && panel.querySelector(`[data-testid="${CSS.escape(testId)}"]`)) ||
          panel.querySelector('[data-testid="prs-board"]');
        target?.focus({ preventScroll: true });
      });
    };
  }, []);

  return (
    <article
      ref={cardRef}
      className="board-card review-ticket-card"
      data-testid={`prs-ticket-${ticket.key}`}
    >
      <div className="board-card-top">
        <a
          className="jira-link review-ticket-key"
          href={`${jiraBase || ''}${ticket.key}`}
          target="_blank"
          rel="noopener noreferrer"
          data-testid={`prs-ticket-link-${ticket.key}`}
        >
          {ticket.key}
        </a>
        <span className="board-card-stat">
          {prs.length} {discoveryComplete ? '' : 'known '}PR{prs.length === 1 ? '' : 's'}
        </span>
      </div>
      <TicketLaunchers
        ticketKey={ticket.key}
        testId={`prs-ticket-actions-${ticket.key}`}
        linksByTicket={linksByTicket}
        onOpenThread={onOpenThread}
        claudeProps={{
          testId: `prs-claude-icon-${ticket.key}`,
          label: `Claude code review for ${ticket.key}`,
          tooltip: false,
        }}
        onOpenClaude={onOpenClaude}
      />
      <p className="board-card-summary" title={ticket.summary}>
        {ticket.summary}
      </p>
      <div className="review-ticket-meta">
        <p className="review-ticket-assignee" data-testid={`prs-ticket-assignee-${ticket.key}`}>
          Assignee:{' '}
          <span className={ticket.assignee ? 'review-ticket-assignee-name' : undefined}>
            {ticket.assignee || 'Unassigned'}
          </span>
        </p>
        {ticket.sprint?.name && <p className="review-ticket-sprint">{ticket.sprint.name}</p>}
      </div>
      {!discoveryComplete || reviewIncomplete ? (
        <p className="review-ticket-warning" data-testid={`prs-ticket-warning-${ticket.key}`}>
          {!discoveryComplete
            ? 'PR discovery unavailable or incomplete. Review status is unknown.'
            : 'Review status unavailable or incomplete.'}
        </p>
      ) : null}
      {prs.length ? (
        <ul className="review-ticket-prs">
          {prs.map((pr) => {
            const state = queueReviewState(pr.review);
            const label = `${pr.repo} #${pr.number}`;
            const id = `${ticket.key}-${slug(pr.repo)}-${pr.number}`;
            return (
              <li
                key={`${pr.repo}#${pr.number}`}
                className="review-ticket-pr"
                data-review-state={state}
              >
                <a
                  className="review-ticket-pr-link"
                  href={pr.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`${label}, ${pr.title}${pr.draft ? ', draft' : ''}, ${reviewText({ state })}`}
                  title={`${label}: ${pr.title}`}
                  data-testid={`prs-pr-${id}`}
                >
                  <span className="review-ticket-pr-name">{label}</span>
                  <span className="review-ticket-pr-state" data-review-state={state}>
                    {reviewText({ state })}
                  </span>
                </a>
                {pr.draft && (
                  <span className="board-chip" data-tone="warn">
                    Draft
                  </span>
                )}
                <DiffViewer repo={pr.repo} number={pr.number} testId={`prs-diff-${id}`} />
              </li>
            );
          })}
        </ul>
      ) : discoveryComplete ? (
        <p className="review-ticket-empty">No linked open PRs</p>
      ) : null}
    </article>
  );
}
