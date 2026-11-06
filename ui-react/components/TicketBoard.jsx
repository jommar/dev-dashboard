// TicketBoard.jsx — My Tickets as a kanban: one column per status, in workflow
// order (ui/ticket-board.js). Each card carries its Jira key, priority, points and
// age, its Slack chips, and one line per open PR with CI, review, review-comment
// and draft state. A card whose open PRs are all approved is marked green and
// sealed. Every glyph is inline SVG and every state is also a word, so nothing is
// carried by colour alone.
import { useMemo, useRef } from 'react';
import { slug, timeAgo } from '../../ui/dom.js';
import { inSprints } from '../../ui/home-data.js';
import {
  allPrsApproved,
  boardColumns,
  ciSummaryText,
  commentChips,
  commentSummaryText,
  reviewText,
} from '../../ui/ticket-board.js';
import { canonicalTicketKey, normalizeTicketKey } from '../../ui/slack-ticket-links.js';
import { usePreservedInteraction } from '../hooks/usePreservedInteraction.js';
import { SlackThreadLinks } from './SlackThreadLink.jsx';
import { BoardColumn } from './BoardShell.jsx';

// Jira priority names mapped to a chevron step: two up, one up, bars, one down,
// two down. The shape carries the level; the name is in the label.
const PRIORITY_STEP = new Map([
  ['highest', 2],
  ['high', 1],
  ['medium', 0],
  ['low', -1],
  ['lowest', -2],
]);

// The frame every glyph on the board shares: a 16-unit box drawn with a rounded stroke in the
// text colour. A glyph hides itself from assistive tech unless it sits inside something that
// already does (the comment chips).
function StrokeGlyph({ size = 14, strokeWidth = 1.8, ariaHidden = true, children }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={ariaHidden ? 'true' : undefined}
      focusable="false"
    >
      {children}
    </svg>
  );
}

function PriorityGlyph({ step }) {
  if (step > 0)
    return (
      <>
        {step > 1 && <path d="M3.5 7.5 8 3l4.5 4.5" />}
        <path d="M3.5 12.5 8 8l4.5 4.5" />
      </>
    );
  if (step < 0)
    return (
      <>
        <path d="M3.5 3.5 8 8l4.5-4.5" />
        {step < -1 && <path d="M3.5 8.5 8 13l4.5-4.5" />}
      </>
    );
  return <path d="M4 6.5h8M4 9.5h8" />;
}

function PriorityMark({ name, testId }) {
  const label = `Priority: ${name}`;
  const step = PRIORITY_STEP.get(String(name).trim().toLowerCase()) ?? 0;
  return (
    <span
      className="my-tickets-priority"
      role="img"
      aria-label={label}
      data-tooltip={label}
      data-testid={testId}
    >
      <StrokeGlyph>
        <PriorityGlyph step={step} />
      </StrokeGlyph>
    </span>
  );
}

// The CI glyph differs in shape for every state: a check, a cross, an open ring,
// and a short dash for no checks or an unreadable rollup.
const CI_GLYPHS = new Map([
  ['passing', <path key="p" d="M3.5 8.5 6.5 11.5 12.5 4.5" />],
  ['failing', <path key="f" d="M4.5 4.5l7 7m0-7-7 7" />],
  ['pending', <circle key="g" cx="8" cy="8" r="4" />],
  ['none', <path key="n" d="M4.5 8h7" />],
]);

function CiGlyph({ state }) {
  return <StrokeGlyph>{CI_GLYPHS.get(state) ?? CI_GLYPHS.get('none')}</StrokeGlyph>;
}

// The comment chips' author glyphs: a person for human threads, a four-point sparkle
// for Copilot's. Their outlines differ in shape, so the author reads without colour.
const COMMENT_GLYPHS = new Map([
  [
    'human',
    <>
      <circle key="head" cx="8" cy="5.5" r="2.6" />
      <path key="shoulders" d="M3.2 13.6c.7-2.4 2.6-3.6 4.8-3.6s4.1 1.2 4.8 3.6" />
    </>,
  ],
  [
    'copilot',
    <path
      key="sparkle"
      d="M8 2.2c.5 3 2.3 4.8 5.8 5.8-3.5.5-5.3 2.3-5.8 5.8-.5-3.5-2.3-5.3-5.8-5.8 3.5-1 5.3-2.8 5.8-5.8Z"
    />,
  ],
]);

// A review-comment chip: the author glyph, a check once every thread is resolved, and the
// count. The words are in its tooltip and in the PR line's accessible name.
function CommentChip({ ticketKey, repo, number, chip }) {
  return (
    <span
      className="my-tickets-pr-comments"
      data-testid={`my-tickets-pr-comments-${chip.author}-${ticketKey}-${slug(repo)}-${number}`}
      data-comment-state={chip.state}
      data-tooltip={chip.summary}
      aria-hidden="true"
    >
      <StrokeGlyph size={11} ariaHidden={false}>
        {COMMENT_GLYPHS.get(chip.author)}
      </StrokeGlyph>
      {chip.state === 'resolved' && (
        <StrokeGlyph size={11} ariaHidden={false}>
          <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
        </StrokeGlyph>
      )}
      {chip.text}
    </span>
  );
}

function PrLine({ ticketKey, pr }) {
  const name = `${pr.repo.split('/').pop()} #${pr.number}`;
  const ciState = pr.ci ? pr.ci.state : 'unknown';
  const ciText = ciSummaryText(pr.ci);
  const review = reviewText(pr.review);
  const chips = commentChips(pr.comments);
  const words = [
    `${name}${pr.draft ? ', draft' : ''}`,
    review,
    ciText,
    commentSummaryText(pr.comments),
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <a
      className="my-tickets-pr"
      href={pr.url}
      target="_blank"
      rel="noopener noreferrer"
      data-testid={`my-tickets-pr-${ticketKey}-${slug(pr.repo)}-${pr.number}`}
      data-ci-state={ciState}
      data-tooltip={ciText}
      aria-label={words}
    >
      <span className="my-tickets-pr-ci">
        <CiGlyph state={ciState} />
      </span>
      <span className="my-tickets-pr-name">{name}</span>
      <span className="my-tickets-pr-meta">
        <span className="my-tickets-pr-review">{review}</span>
        {chips.length > 0 && (
          <span className="my-tickets-pr-chips">
            {chips.map((chip) => (
              <CommentChip
                key={chip.author}
                ticketKey={ticketKey}
                repo={pr.repo}
                number={pr.number}
                chip={chip}
              />
            ))}
          </span>
        )}
      </span>
      {pr.draft && <span className="my-tickets-pr-draft">Draft</span>}
    </a>
  );
}

// The seal on a card whose open PRs are all approved: a check inside a circle, drawn
// apart from the CI check so the two greens do not read as one mark.
function ApprovedSeal({ testId }) {
  return (
    <span
      className="my-tickets-approved"
      role="img"
      aria-label="All PRs approved"
      data-tooltip="All PRs approved"
      data-testid={testId}
    >
      <StrokeGlyph strokeWidth={1.6}>
        <circle cx="8" cy="8" r="6.2" />
        <path d="M5.4 8.2 7.2 10l3.4-3.8" />
      </StrokeGlyph>
    </span>
  );
}

function TicketCard({ ticket, jiraBase, currentSprints, prs = [], slackLinks = [], onOpenThread }) {
  const key = slug(ticket.key);
  const testId = (name) => `my-tickets-item${name ? `-${name}` : ''}-${key}`;
  const inCurrentSprint = currentSprints ? inSprints(ticket, currentSprints) : false;
  const allApproved = allPrsApproved(prs);
  const updated = timeAgo(ticket.updated);
  return (
    <article
      className="my-tickets-card"
      data-in-current-sprint={inCurrentSprint ? 'true' : undefined}
      data-all-approved={allApproved ? 'true' : undefined}
      data-testid={testId()}
    >
      <div className="my-tickets-card-top">
        <a
          className="jira-link my-tickets-card-key"
          href={`${jiraBase || ''}${ticket.key}`}
          target="_blank"
          rel="noopener noreferrer"
          data-testid={testId('link')}
        >
          {ticket.key}
        </a>
        {allApproved && <ApprovedSeal testId={testId('approved')} />}
        {ticket.priority && <PriorityMark name={ticket.priority} testId={testId('priority')} />}
        {Number.isFinite(ticket.storyPoints) && (
          <span className="my-tickets-card-points" data-testid={testId('points')}>
            {ticket.storyPoints} pt
          </span>
        )}
        {updated && (
          <span className="my-tickets-card-updated" data-testid={testId('updated')}>
            {updated}
          </span>
        )}
        <SlackThreadLinks
          links={slackLinks}
          onOpen={(thread) => onOpenThread?.({ ...thread, selectedTicketKey: ticket.key })}
        />
      </div>
      <p className="my-tickets-card-summary" title={ticket.summary} data-testid={testId('summary')}>
        {ticket.summary || ''}
      </p>
      {prs.length > 0 && (
        <ul className="my-tickets-prs">
          {prs.map((pr) => (
            <li key={`${pr.repo}#${pr.number}`}>
              <PrLine ticketKey={key} pr={pr} />
            </li>
          ))}
        </ul>
      )}
      {inCurrentSprint ? (
        <span className="sr-only">In current sprint</span>
      ) : (
        ticket.sprint?.name && (
          <p className="my-tickets-card-sprint" data-testid={testId('sprint-label')}>
            {ticket.sprint.name}
          </p>
        )
      )}
    </article>
  );
}

export function TicketBoard({
  tickets,
  jiraBase,
  currentSprints,
  linksByTicket,
  prsByTicket,
  onOpenThread,
}) {
  const rootRef = useRef(null);
  // Board scrollLeft and column scrollTop survive the 90 s poll re-renders.
  usePreservedInteraction(rootRef);
  const columns = useMemo(() => boardColumns(tickets), [tickets]);
  return (
    <div className="my-tickets-frame" ref={rootRef}>
      <div
        className="my-tickets-board"
        role="region"
        aria-label="Ticket board"
        tabIndex={0}
        data-testid="my-tickets-board"
      >
        {columns.map((column) => {
          const id = slug(column.status);
          return (
            <BoardColumn
              key={column.status}
              id={id}
              label={column.status}
              count={column.tickets.length}
              testIdPrefix="my-tickets-column-"
              kind={column.kind}
            >
              {column.tickets.map((ticket) => (
                <li key={ticket.key}>
                  <TicketCard
                    ticket={ticket}
                    jiraBase={jiraBase}
                    currentSprints={currentSprints}
                    prs={prsByTicket[canonicalTicketKey(ticket.key)] || []}
                    slackLinks={linksByTicket.get(normalizeTicketKey(ticket.key)) || []}
                    onOpenThread={onOpenThread}
                  />
                </li>
              ))}
            </BoardColumn>
          );
        })}
      </div>
    </div>
  );
}
