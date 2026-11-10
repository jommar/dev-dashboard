import { inSprints } from '../../ui/home-data.js';
import { slug, timeAgo } from '../../ui/dom.js';
import { jiraStatusKind } from '../../ui/jira-status.js';
import { SprintPill } from './SprintPill.jsx';
import { TicketStatusPill } from './TicketStatusPill.jsx';
import { SlackThreadLinks } from './SlackThreadLink.jsx';

export function WorkTicketRow({
  ticket,
  jiraBase,
  showSprint = true,
  testIdPrefix = 'my-tickets-item',
  currentSprints = null,
  extraMeta,
  slackLinks = [],
  onOpenThread,
}) {
  const key = slug(ticket.key);
  const testId = (name) => `${testIdPrefix}${name ? `-${name}` : ''}-${key}`;
  const kind = jiraStatusKind(ticket.status);
  const inCurrentSprint = currentSprints ? inSprints(ticket, currentSprints) : false;
  const meta = [ticket.priority, ticket.issueType].filter(Boolean).join(' · ');
  return (
    <div
      className="my-ticket"
      data-jira-status-kind={kind}
      data-in-current-sprint={inCurrentSprint ? 'true' : undefined}
      data-testid={testId()}
    >
      <span className="my-ticket-key">
        <a
          className="jira-link"
          href={`${jiraBase || ''}${ticket.key}`}
          target="_blank"
          rel="noopener noreferrer"
          data-testid={testId('link')}
        >
          {ticket.key}
        </a>
        <SlackThreadLinks links={slackLinks} onOpen={onOpenThread} />
      </span>
      <span className="my-ticket-summary" data-testid={testId('summary')}>
        {ticket.summary || ''}
      </span>
      <div className="my-ticket-meta">
        <TicketStatusPill status={ticket.status} testId={testId('status')} />
        {showSprint && (
          <SprintPill sprint={ticket.sprint} testId={`my-tickets-item-sprint-${key}`} />
        )}
        {extraMeta}
        {meta && (
          <span className="my-ticket-sub" data-testid={testId('sub')}>
            {meta}
          </span>
        )}
        {ticket.updated && (
          <span className="updated" data-testid={testId('updated')}>
            {timeAgo(ticket.updated)}
          </span>
        )}
      </div>
    </div>
  );
}
