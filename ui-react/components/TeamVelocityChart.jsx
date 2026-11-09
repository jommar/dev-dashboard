import { memo, useLayoutEffect, useRef, useState } from 'react';

const STATUSES = [
  { key: 'done', label: 'Completed' },
  { key: 'inProgress', label: 'In progress' },
  { key: 'notStarted', label: 'Not started' },
];
const GRID_INTERVALS = 4;
const sprintIdentity = (entry) => String(entry.sprint.id ?? entry.sprint.name);

function scaleFor(series) {
  const highest = Math.max(...series.map((entry) => entry.points), 1);
  const magnitude = 10 ** Math.floor(Math.log10(highest / GRID_INTERVALS));
  const interval = Math.ceil(highest / GRID_INTERVALS / magnitude) * magnitude;
  return interval * GRID_INTERVALS;
}

function endLabel(endDate) {
  if (!endDate) return 'End date unavailable';
  const date = new Date(endDate);
  return Number.isFinite(date.getTime())
    ? `Ends ${date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`
    : 'End date unavailable';
}

export const TeamVelocityChart = memo(function TeamVelocityChart({
  team,
  personLabel,
  series,
  scaleSeries,
}) {
  const [expanded, setExpanded] = useState(false);
  const [inspection, setInspection] = useState(null);
  const selected = inspection?.id;
  const selectedHeading = useRef(null);
  useLayoutEffect(() => {
    if (!inspection || !selectedHeading.current) return;
    selectedHeading.current.focus({ preventScroll: true });
    selectedHeading.current.closest('li').scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
      behavior: 'instant',
    });
  }, [inspection]);
  const maximum = scaleFor(scaleSeries);
  const ticks = Array.from(
    { length: GRID_INTERVALS + 1 },
    (_, index) => maximum * (1 - index / GRID_INTERVALS),
  );

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
          {series.length} {series.length === 1 ? 'sprint' : 'sprints'} · oldest to newest
        </span>
      </figcaption>
      <ul className="home-velocity-legend" aria-label="Sprint status legend">
        {STATUSES.map(({ key, label }) => (
          <li key={key}>
            <span className="home-velocity-swatch" data-status={key} aria-hidden="true" />
            {label}
          </li>
        ))}
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
              <button
                type="button"
                className="home-velocity-column"
                key={sprintIdentity(entry)}
                aria-label={`${entry.sprint.name}: ${entry.points} story points. Inspect sprint details.`}
                aria-pressed={selected === sprintIdentity(entry)}
                aria-expanded={expanded}
                aria-controls="home-velocity-details"
                onClick={() => {
                  setInspection({ id: sprintIdentity(entry) });
                  setExpanded(true);
                }}
              >
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
                <span className="home-velocity-sprint-label">
                  {entry.sprint.name.replace(`${team} `, '')}
                </span>
                <span className="home-velocity-sprint-state">{entry.sprint.state}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
      <details
        className="home-velocity-details"
        id="home-velocity-details"
        open={expanded}
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary>
          Inspect sprint data <span>Exact points, status and estimation coverage</span>
        </summary>
        <ol data-testid="home-velocity-data">
          {series.map((entry) => (
            <li key={sprintIdentity(entry)} data-selected={selected === sprintIdentity(entry)}>
              <div className="home-velocity-detail-title">
                <h4 ref={selected === sprintIdentity(entry) ? selectedHeading : null} tabIndex={-1}>
                  {entry.sprint.name}
                </h4>
                <span>
                  {entry.sprint.state} · {endLabel(entry.sprint.endDate)}
                </span>
              </div>
              <dl>
                <div>
                  <dt>Total story points</dt>
                  <dd>{entry.points}</dd>
                </div>
                {STATUSES.map(({ key, label }) => (
                  <div key={key}>
                    <dt>{label}</dt>
                    <dd>{entry.byStatus[key]}</dd>
                  </div>
                ))}
                <div>
                  <dt>Issue memberships</dt>
                  <dd>{entry.count}</dd>
                </div>
                <div>
                  <dt>Of these, unestimated</dt>
                  <dd>{entry.unestimated}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ol>
      </details>
    </figure>
  );
});
