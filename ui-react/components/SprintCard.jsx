// SprintCard.jsx — one ticket of the Sprint tab: its Jira key, type, points, summary, assignee and
// status, a chip per Claude session that exists, the groom verdict once a groom finished, and a chip
// per attention reason. Its Groom button opens the ticket's Claude dialog; it launches nothing itself.
import { memo } from 'react';
import { VERDICT_TONE, verdictWord } from '../../ui/claude-verdict.js';
import { ATTENTION_REASONS } from '../../ui/sprint-attention.js';
import { sessionChipWords, sessionChips } from '../../ui/sprint-board.js';

const REASON_LABELS = Object.fromEntries(ATTENTION_REASONS.map(({ id, label }) => [id, label]));

function SprintCardView({ ticket, jiraBase, entry, reasons, onGroom }) {
  const chips = entry ? sessionChips(entry) : [];
  const verdict = entry?.groom?.state === 'done' ? entry.groom.verdict : null;
  const verdictText = verdictWord(verdict);
  return (
    <article className="board-card sprint-board-card" data-testid={`sprint-card-${ticket.key}`}>
      <div className="board-card-top">
        <a
          className="jira-link"
          href={`${jiraBase || ''}${ticket.key}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          {ticket.key}
        </a>{' '}
        {ticket.issueType && <span className="board-card-stat">{ticket.issueType}</span>}{' '}
        <span className="board-card-stat">
          {Number.isFinite(ticket.storyPoints) ? `${ticket.storyPoints} pt` : 'No estimate'}
        </span>{' '}
        <button
          type="button"
          className="sprint-board-card-groom"
          aria-label={`Groom ${ticket.key}`}
          aria-haspopup="dialog"
          data-testid={`sprint-card-${ticket.key}-groom`}
          onClick={() => onGroom(ticket.key)}
        >
          Groom
        </button>
      </div>
      <p className="board-card-summary">{ticket.summary || ''}</p>
      <p className="sprint-board-card-line">
        <span>{ticket.assignee || 'Unassigned'}</span>
        <span aria-hidden="true">·</span>
        <span>{ticket.status}</span>
      </p>
      {(chips.length > 0 || verdictText) && (
        <ul className="sprint-board-chips" aria-label="Claude sessions">
          {chips.map((chip) => (
            <li
              key={chip.phase}
              className="board-chip sprint-board-session"
              data-state={chip.state}
            >
              {sessionChipWords(chip.phase)}: {chip.state}
            </li>
          ))}
          {verdictText && (
            <li className="board-chip sprint-board-verdict" data-tone={VERDICT_TONE[verdict]}>
              Groom verdict: {verdictText}
            </li>
          )}
        </ul>
      )}
      {reasons.length > 0 && (
        <ul className="sprint-board-chips" aria-label="Needs attention">
          {reasons.map((id) => (
            <li key={id} className="board-chip sprint-board-reason" data-reason={id}>
              {REASON_LABELS[id]}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

export const SprintCard = memo(SprintCardView);
