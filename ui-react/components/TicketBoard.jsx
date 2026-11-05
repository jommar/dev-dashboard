// TicketBoard.jsx — My Tickets as a kanban: one column per status, in workflow
// order (ui/ticket-board.js). Each card carries its Jira key, priority, points and
// age, its Slack chips, and one line per open PR with CI, review and draft state.
// Every glyph is inline SVG and every state is also a word, so nothing is carried
// by colour alone.
import { useMemo, useRef } from 'react';
import { slug, timeAgo } from '../../ui/dom.js';
import { inSprints } from '../../ui/home-data.js';
import { boardColumns, ciSummaryText, reviewText } from '../../ui/ticket-board.js';
import { canonicalTicketKey, normalizeTicketKey } from '../../ui/slack-ticket-links.js';
import { usePreservedInteraction } from '../hooks/usePreservedInteraction.js';
import { SlackThreadLinks } from './SlackThreadLink.jsx';

// Jira priority names mapped to a chevron step: two up, one up, bars, one down,
// two down. The shape carries the level; the name is in the label.
const PRIORITY_STEP = new Map([
  ['highest', 2],
  ['high', 1],
  ['medium', 0],
  ['low', -1],
  ['lowest', -2],
]);

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
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <PriorityGlyph step={step} />
      </svg>
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
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {CI_GLYPHS.get(state) ?? CI_GLYPHS.get('none')}
    </svg>
  );
}

function PrLine({ ticketKey, pr }) {
  const name = `${pr.repo.split('/').pop()} #${pr.number}`;
  const ciState = pr.ci ? pr.ci.state : 'unknown';
  const ciText = ciSummaryText(pr.ci);
  const review = reviewText(pr.review);
  return (
    <a
      className="my-tickets-pr"
      href={pr.url}
      target="_blank"
      rel="noopener noreferrer"
      data-testid={`my-tickets-pr-${ticketKey}-${slug(pr.repo)}-${pr.number}`}
      data-ci-state={ciState}
      data-tooltip={ciText}
      aria-label={`${name}${pr.draft ? ', draft' : ''}, ${review}, ${ciText}`}
    >
      <span className="my-tickets-pr-ci">
        <CiGlyph state={ciState} />
      </span>
      <span className="my-tickets-pr-name">{name}</span>
      <span className="my-tickets-pr-review">{review}</span>
      {pr.draft && <span className="my-tickets-pr-draft">Draft</span>}
    </a>
  );
}

function TicketCard({ ticket, jiraBase, currentSprints, prs = [], slackLinks = [], onOpenThread }) {
  const key = slug(ticket.key);
  const testId = (name) => `my-tickets-item${name ? `-${name}` : ''}-${key}`;
  const inCurrentSprint = currentSprints ? inSprints(ticket, currentSprints) : false;
  const updated = timeAgo(ticket.updated);
  return (
    <article
      className="my-tickets-card"
      data-in-current-sprint={inCurrentSprint ? 'true' : undefined}
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
        <SlackThreadLinks links={slackLinks} onOpen={onOpenThread} />
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
          const titleId = `my-tickets-column-title-${id}`;
          return (
            <section
              className="my-tickets-column"
              role="group"
              key={column.status}
              data-jira-status-kind={column.kind}
              data-testid={`my-tickets-column-${id}`}
              aria-labelledby={titleId}
            >
              {/* A div, not a header: the dashboard's `.card header` rule would lay this out as a page header. */}
              <div className="my-tickets-column-head" data-testid={`my-tickets-column-head-${id}`}>
                <h3 className="my-tickets-column-title" id={titleId}>
                  {column.status}
                </h3>
                <span
                  className="my-tickets-column-count"
                  data-testid={`my-tickets-column-count-${id}`}
                >
                  {column.tickets.length}
                </span>
              </div>
              <ul className="my-tickets-column-body" data-testid={`my-tickets-column-body-${id}`}>
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
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
