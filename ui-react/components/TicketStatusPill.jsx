import { jiraStatusKind } from '../../ui/jira-status.js';
import { DashboardTooltip, Pill } from './Primitives.jsx';

export function TicketStatusPill({ status, testId }) {
  return (
    <DashboardTooltip title={status} describeChild>
      <Pill
        className="ticket-status"
        data-jira-status-kind={jiraStatusKind(status)}
        data-testid={testId}
      >
        {status}
      </Pill>
    </DashboardTooltip>
  );
}
