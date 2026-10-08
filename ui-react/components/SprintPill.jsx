import { sprintDay } from '../../ui/domain-helpers.js';

export function SprintPill({ sprint, testId }) {
  const state = sprint ? sprint.state : 'none';
  const label = sprint ? sprint.name : 'No sprint';
  const range = sprint
    ? [sprintDay(sprint.startDate), sprintDay(sprint.endDate)].filter(Boolean).join(' – ')
    : '';
  const title = sprint ? [sprint.state, range].filter(Boolean).join(' · ') : 'Not in a sprint';
  return (
    <span
      className="pill ticket-sprint"
      data-sprint-state={state}
      data-tooltip={title}
      data-testid={testId}
    >
      {label}
    </span>
  );
}
