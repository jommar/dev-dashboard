import { inSprints } from '../../ui/home-data.js';
import { slug, timeAgo } from '../../ui/dom.js';
import { jiraStatusKind } from '../../ui/components/pr-card.js';
import { SprintPill } from './SprintPill.jsx';

export function WorkTicketRow({
  ticket,
  jiraBase,
  showSprint = true,
  testIdPrefix = 'my-tickets-item',
  currentSprints = null,
  extraMeta,
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
      </span>
      <span className="my-ticket-summary" data-testid={testId('summary')}>
        {ticket.summary || ''}
      </span>
      <div className="my-ticket-meta">
        <span
          className="pill ticket-status"
          data-jira-status-kind={kind}
          data-tooltip={ticket.status}
          data-testid={testId('status')}
        >
          {ticket.status}
        </span>
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

export function MyTicketsGroups({ groups, jiraBase, currentSprints }) {
  const entries = Object.entries(groups || {});
  if (!entries.length)
    return (
      <div className="pr-empty" data-testid="my-tickets-empty">
        No tickets assigned to you.
      </div>
    );
  return entries.map(([category, tickets]) => {
    const categoryKey = slug(category);
    const byStatus = {};
    for (const ticket of tickets) (byStatus[ticket.status || 'Unknown'] ||= []).push(ticket);
    const sameStatus = Object.keys(byStatus).length === 1 && Object.keys(byStatus)[0] === category;
    return (
      <section
        className="my-ticket-category"
        data-testid={`my-tickets-category-${categoryKey}`}
        key={category}
      >
        <h4
          className="my-ticket-category-head"
          data-testid={`my-tickets-category-head-${categoryKey}`}
        >
          {category}
          <span className="pr-count" data-testid={`my-tickets-category-count-${categoryKey}`}>
            {tickets.length}
          </span>
        </h4>
        <div className="my-ticket-groups">
          {Object.entries(byStatus)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([status, list]) => {
              const statusKey = slug(status);
              const kind = jiraStatusKind(status);
              return (
                <div
                  className="my-ticket-status-group"
                  data-jira-status-kind={kind}
                  data-testid={`my-tickets-status-${categoryKey}-${statusKey}`}
                  key={status}
                >
                  <div
                    className="my-ticket-status-head"
                    hidden={sameStatus}
                    data-testid={`my-tickets-status-head-${categoryKey}-${statusKey}`}
                  >
                    {status}
                    <span
                      className="pr-count"
                      data-testid={`my-tickets-status-count-${categoryKey}-${statusKey}`}
                    >
                      {list.length}
                    </span>
                  </div>
                  <div className="my-ticket-rows">
                    {list.map((ticket) => (
                      <WorkTicketRow
                        key={ticket.key}
                        ticket={ticket}
                        jiraBase={jiraBase}
                        currentSprints={currentSprints}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
        </div>
      </section>
    );
  });
}
