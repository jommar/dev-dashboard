import { memo } from 'react';
import { DashboardTooltip } from './Primitives.jsx';

const STATUSES = [
  { key: 'done', label: 'Completed' },
  { key: 'inProgress', label: 'In progress' },
  { key: 'notStarted', label: 'Not started' },
];
const GRID_INTERVALS = 4;
const sprintIdentity = (entry) => String(entry.sprint.id ?? entry.sprint.name);

export const formatPoints = (value) => +value.toFixed(1);

function scaleFor(series) {
  const highest = Math.max(...series.map((entry) => entry.points), 1);
  const magnitude = 10 ** Math.floor(Math.log10(highest / GRID_INTERVALS));
  return Math.ceil(highest / GRID_INTERVALS / magnitude) * magnitude * GRID_INTERVALS;
}

export const TeamVelocityChart = memo(function TeamVelocityChart({
  team,
  personLabel,
  series,
  scaleSeries,
  teamAverage,
  personLine,
  isTeamView,
}) {
  const maximum = scaleFor(scaleSeries);
  const ticks = Array.from(
    { length: GRID_INTERVALS + 1 },
    (_, index) => maximum * (1 - index / GRID_INTERVALS),
  );
  const viewAverage = series.length
    ? series.reduce((sum, entry) => sum + entry.points, 0) / series.length
    : 0;
  const lines = [];
  if (isTeamView) {
    lines.push({
      id: 'team',
      label: team,
      average: teamAverage,
      active: !personLine,
    });
  }
  if (personLine) {
    lines.push({
      id: personLine.id,
      label: personLine.label,
      average: personLine.average,
      active: true,
    });
  }

  return (
    <figure
      className="home-velocity-chart"
      data-testid="home-velocity-chart"
      aria-labelledby="home-velocity-chart-title"
    >
      <figcaption className="home-velocity-chart-head">
        <div>
          <h3 id="home-velocity-chart-title">Sprint history · story points</h3>
          <p className="home-velocity-chart-context">
            {team} · {personLabel}
          </p>
        </div>
        <span>
          {formatPoints(viewAverage)} avg / sprint · {series.length}{' '}
          {series.length === 1 ? 'sprint' : 'sprints'} · oldest to newest
        </span>
      </figcaption>
      <ul className="home-velocity-legend" aria-label="Sprint status legend">
        {STATUSES.map(({ key, label }) => (
          <li key={key}>
            <span className="home-velocity-swatch" data-status={key} aria-hidden="true" />
            {label}
          </li>
        ))}
        {lines.length > 0 && (
          <li>
            <span className="home-velocity-swatch" data-status="average" aria-hidden="true" />
            Avg / sprint
          </li>
        )}
      </ul>
      <div
        className="home-velocity-scroll"
        data-testid="home-velocity-scroll"
        role="region"
        aria-label={`${team}, ${personLabel} sprint history; scroll to see more sprints`}
        tabIndex={0}
      >
        <div className="home-velocity-plot" style={{ '--sprint-count': series.length }}>
          <div
            className="home-velocity-axis"
            data-testid="home-velocity-axis"
            aria-label="Story points, starting at zero"
          >
            {ticks.map((tick, index) => (
              <span key={index} style={{ top: `${(index / GRID_INTERVALS) * 100}%` }}>
                {Number(tick.toPrecision(12))}
              </span>
            ))}
          </div>
          <div className="home-velocity-grid" aria-hidden="true">
            {ticks.map((_, index) => (
              <span key={index} style={{ top: `${(index / GRID_INTERVALS) * 100}%` }} />
            ))}
          </div>
          <div className="home-velocity-columns">
            {series.map((entry) => (
              <DashboardTooltip
                key={sprintIdentity(entry)}
                title={`${entry.sprint.name} (${entry.sprint.state})\n${entry.byStatus.done} done · ${entry.byStatus.inProgress} in progress · ${entry.byStatus.notStarted} not started · ${entry.count} issues${entry.unestimated ? `, ${entry.unestimated} unestimated` : ''}`}
              >
                <div className="home-velocity-column">
                  <span className="home-velocity-bar-space" aria-hidden="true">
                    <span
                      className="home-velocity-stack"
                      data-testid="home-velocity-stack"
                      style={{ height: `${(entry.points / maximum) * 100}%` }}
                    >
                      <span className="home-velocity-total" data-testid="home-velocity-total">
                        {entry.points}
                      </span>
                      {STATUSES.map(({ key }) => (
                        <span
                          key={key}
                          className="home-velocity-segment"
                          data-status={key}
                          style={{
                            height: `${entry.points ? (entry.byStatus[key] / entry.points) * 100 : 0}%`,
                          }}
                        />
                      ))}
                    </span>
                  </span>
                  <span className="home-velocity-sprint-label">{entry.sprint.name}</span>
                  <span className="home-velocity-sprint-state">{entry.sprint.state}</span>
                </div>
              </DashboardTooltip>
            ))}
          </div>
          {lines.length > 0 && (
            <div className="home-velocity-averages" data-has-active="true" aria-hidden="true">
              {lines.map((line) => {
                const ratio = Math.min(1, Math.max(0, line.average / maximum));
                return (
                  <div
                    key={line.id}
                    className="home-velocity-avg-line"
                    data-testid="home-velocity-avg-line"
                    data-active={line.active ? 'true' : undefined}
                    data-low={ratio < 0.12 ? 'true' : undefined}
                    style={{ top: `${(1 - ratio) * 100}%` }}
                  >
                    <span className="home-velocity-avg-rule" />
                    {line.active && (
                      <span
                        className="home-velocity-avg-label"
                        data-testid="home-velocity-avg-label"
                      >
                        {line.label} · {formatPoints(line.average)} avg
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </figure>
  );
});
