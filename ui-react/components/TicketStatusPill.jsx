import { jiraStatusKind } from '../../ui/jira-status.js';
import { Pill } from './Primitives.jsx';

export function TicketStatusPill({ status, testId }) {
  return (
    <Pill
      className="ticket-status"
      data-jira-status-kind={jiraStatusKind(status)}
      data-tooltip={status}
      data-testid={testId}
    >
      {status}
    </Pill>
  );
}
