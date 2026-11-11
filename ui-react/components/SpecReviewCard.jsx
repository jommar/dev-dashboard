// SpecReviewCard.jsx — one open ezat-specs spec PR on the Spec review lane. Its keys are Jira links,
// its title is the PR link, and its Claude icon opens the panel's spec-review dialog (the card
// starts nothing itself). Presentational only: the panel owns the feed and the dialog.
import { ClaudeIcon } from './ClaudeIcon.jsx';

export function SpecReviewCard({ spec, jiraBase, onOpenClaude }) {
  const [firstKey] = spec.keys;
  return (
    <article className="board-card spec-review-card" data-testid={`prs-spec-${spec.number}`}>
      <div className="board-card-top">
        {spec.keys.map((key) => (
          <a
            key={key}
            className="jira-link review-ticket-key"
            href={`${jiraBase || ''}${key}`}
            target="_blank"
            rel="noopener noreferrer"
            data-testid={`prs-spec-key-${spec.number}-${key}`}
          >
            {key}
          </a>
        ))}
        {spec.draft && (
          <span className="board-chip" data-tone="warn">
            Draft
          </span>
        )}
        <span className="board-card-stat" data-testid={`prs-spec-age-${spec.number}`}>
          <span aria-hidden="true">{spec.ageDays} d</span>
          <span className="sr-only">{`${spec.ageDays} days old`}</span>
        </span>
      </div>
      <div className="board-card-links">
        <ClaudeIcon
          ticketKey={firstKey}
          onOpen={() => onOpenClaude(spec)}
          label={`Claude spec review for ${firstKey}`}
          testId={`prs-spec-claude-icon-${spec.number}`}
          tooltip={false}
        />
      </div>
      <p className="board-card-summary">
        <a
          href={spec.url}
          target="_blank"
          rel="noopener noreferrer"
          data-testid={`prs-spec-pr-${spec.number}`}
        >
          #{spec.number} {spec.title}
        </a>
      </p>
      <div className="review-ticket-meta">
        <p className="review-ticket-assignee" data-testid={`prs-spec-author-${spec.number}`}>
          Author: <span className="review-ticket-assignee-name">{spec.author || 'Unknown'}</span>
        </p>
        <p className="review-ticket-assignee" data-testid={`prs-spec-reviews-${spec.number}`}>
          {spec.reviewsByOthers} review{spec.reviewsByOthers === 1 ? '' : 's'}
        </p>
      </div>
    </article>
  );
}
