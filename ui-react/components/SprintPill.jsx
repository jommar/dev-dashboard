import { sprintDay } from '../../ui/domain-helpers.js';
import { DashboardTooltip } from './Primitives.jsx';

export function SprintPill({ sprint, testId }) {
  const state = sprint ? sprint.state : 'none';
  const label = sprint ? sprint.name : 'No sprint';
  const range = sprint
    ? [sprintDay(sprint.startDate), sprintDay(sprint.endDate)].filter(Boolean).join(' – ')
    : '';
  const title = sprint ? [sprint.state, range].filter(Boolean).join(' · ') : 'Not in a sprint';
  return (
    <DashboardTooltip title={title} describeChild>
      <span className="pill ticket-sprint" data-sprint-state={state} data-testid={testId}>
        {label}
      </span>
    </DashboardTooltip>
  );
}
