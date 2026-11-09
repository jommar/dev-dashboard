import { useCallback, useMemo, useRef, useState } from 'react';
import { BoardNote, BoardPanel, BoardSection, BoardState } from '../components/BoardShell.jsx';
import { Button } from '../components/Primitives.jsx';
import { TeamVelocityChart } from '../components/TeamVelocityChart.jsx';
import { useDashboardApi } from '../hooks/useDashboardApi.js';
import {
  readVelocityTeam,
  writeVelocityTeam,
  readVelocitySnapshot,
  writeVelocitySnapshot,
  validateVelocitySnapshot,
} from '../../ui/home-velocity.js';

const NO_PEOPLE = Object.freeze([]);
const RESERVED_PERSON_LABELS = new Set(['Everyone', 'Unassigned', 'Unknown assignee']);

function comparisonPeople(people) {
  const sorted = [...people].sort(
    (a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id),
  );
  const totals = new Map();
  const reserved = new Set([
    ...RESERVED_PERSON_LABELS,
    ...sorted.map((person) => person.displayName),
  ]);
  const used = new Set();
  for (const person of sorted)
    totals.set(person.displayName, (totals.get(person.displayName) || 0) + 1);
  return sorted.map((person) => {
    let label = person.displayName;
    if (totals.get(label) > 1 || RESERVED_PERSON_LABELS.has(label)) {
      let ordinal = 1;
      do {
        label = `${person.displayName} (${ordinal++})`;
      } while (reserved.has(label) || used.has(label));
    }
    used.add(label);
    const byStatus = { done: 0, inProgress: 0, notStarted: 0 };
    for (const entry of person.series)
      for (const status of Object.keys(byStatus)) byStatus[status] += entry.byStatus[status];
    return {
      ...person,
      label,
      points: person.series.reduce((total, entry) => total + entry.points, 0),
      byStatus,
    };
  });
}

function PersonBreakdown({ people, personId, sprintCount, onSelect }) {
  const maximum = Math.max(0, ...people.map((person) => person.points)) || 1;
  return (
    <section
      className="home-velocity-people"
      data-testid="home-velocity-people"
      aria-labelledby="home-velocity-people-title"
    >
      <div className="home-velocity-people-head">
        <h3 id="home-velocity-people-title">People</h3>
        <span>
          Total points · {sprintCount} displayed {sprintCount === 1 ? 'sprint' : 'sprints'}
        </span>
      </div>
      <ul className="home-velocity-people-list">
        {people.map((person) => (
          <li key={person.id}>
            <button
              type="button"
              data-testid="home-velocity-person-row"
              aria-pressed={personId === person.id}
              aria-label={`${person.label}: ${person.points} total points; ${person.byStatus.done} completed, ${person.byStatus.inProgress} in progress, ${person.byStatus.notStarted} not started`}
              title={`${person.byStatus.done} completed, ${person.byStatus.inProgress} in progress, ${person.byStatus.notStarted} not started points`}
              onClick={() => onSelect(person.id)}
            >
              <span className="home-velocity-person-name">{person.label}</span>
              <strong>{person.points}</strong>
              <span
                className="home-velocity-person-meter"
                data-testid="home-velocity-person-meter"
                aria-hidden="true"
              >
                {Object.entries(person.byStatus).map(([status, points]) => (
                  <span
                    key={status}
                    className="home-velocity-segment"
                    data-status={status}
                    style={{ width: `${(points / maximum) * 100}%` }}
                  />
                ))}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p>
        Bars share the same point scale across people. Carried issues count in each sprint
        membership, not as unique delivered work. Alphabetical, not a performance ranking.
      </p>
    </section>
  );
}

export function HomePanel({ active }) {
  const api = useDashboardApi();
  const [selection, setSelection] = useState(() => ({ team: readVelocityTeam(), person: '' }));
  const [data, setData] = useState(() => readVelocitySnapshot());
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState('');
  const [saveFailed, setSaveFailed] = useState(false);
  const inFlight = useRef(false);
  const generate = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setFailure('');
    try {
      const snapshot = validateVelocitySnapshot(await api.getTeamVelocity());
      if (!snapshot)
        throw new Error('The velocity response is invalid. Generate a new snapshot to try again');
      setData(snapshot);
      setSaveFailed(!writeVelocitySnapshot(snapshot));
      setSelection((current) => {
        const board = snapshot.boards.find((entry) => entry.name === current.team);
        return board?.people.some((person) => person.id === current.person)
          ? current
          : { ...current, person: '' };
      });
    } catch (error) {
      setFailure(error.message);
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [api]);
  const { team, person: personId } = selection;
  const boards = data?.boards;
  const teams = useMemo(() => {
    const names = (boards || []).map((board) => board.name);
    return names.includes(team) ? names : [team, ...names];
  }, [boards, team]);
  const selected = boards?.find((board) => board.name === team);
  const people = useMemo(() => comparisonPeople(selected?.people || NO_PEOPLE), [selected]);
  const chosenPerson = people.find((person) => person.id === personId);
  const choosePerson = (id) => setSelection((current) => ({ ...current, person: id }));
  const generated = data && new Date(data.updatedAt).toLocaleString();
  const meta = data ? (
    <time dateTime={data.updatedAt}>Generated {generated}</time>
  ) : (
    'Not generated'
  );
  const chart = useMemo(
    () =>
      selected?.series.length ? (
        <TeamVelocityChart
          key={team}
          team={team}
          personLabel={chosenPerson?.label || 'Everyone'}
          series={chosenPerson?.series || selected.series}
          scaleSeries={selected.series}
        />
      ) : null,
    [selected, team, chosenPerson],
  );

  return (
    <BoardPanel id="home" active={active} busy={loading}>
      <BoardSection
        name="home"
        title="Velocity"
        meta={meta}
        controls={
          <>
            <label className="home-velocity-team-field">
              Team
              <select
                data-testid="home-velocity-team"
                value={team}
                onChange={(event) => {
                  setSelection({ team: event.target.value, person: '' });
                  writeVelocityTeam(event.target.value);
                }}
              >
                {teams.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label className="home-velocity-team-field">
              Person
              <select
                data-testid="home-velocity-person"
                value={personId}
                onChange={(event) => choosePerson(event.target.value)}
              >
                <option value="">Everyone</option>
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.label}
                  </option>
                ))}
              </select>
            </label>
            <Button data-testid="home-refresh" disabled={loading} onClick={generate}>
              {data ? 'Refresh' : 'Generate velocity'}
            </Button>
          </>
        }
        notes={
          <>
            {data && failure && (
              <BoardNote testId="home-velocity-stale">
                Generation failed: {failure}. Showing the last successful snapshot ({generated});
                velocity may be stale.
              </BoardNote>
            )}
            {saveFailed && (
              <BoardNote testId="home-velocity-save-warning">
                Could not save velocity in this browser; this update may not survive reload.
              </BoardNote>
            )}
          </>
        }
      >
        <div className="board-pane home-velocity-pane">
          {!data ? (
            loading ? (
              <BoardState
                kind="loading"
                label={`Loading velocity for ${team}…`}
                testId="home-velocity-loading"
              />
            ) : failure ? (
              <BoardState kind="error" testId="home-velocity-error">
                <span role="alert">
                  Could not generate velocity for {team}: {failure}. Use Generate velocity to retry.
                </span>
              </BoardState>
            ) : (
              <BoardState testId="home-velocity-no-snapshot">
                No saved velocity snapshot. Generate velocity to load team sprint history.
              </BoardState>
            )
          ) : (
            <>
              {loading && (
                <p className="home-velocity-refreshing" role="status">
                  Generating a new snapshot… Current data remains available.
                </p>
              )}
              {chart || (
                <BoardState testId="home-velocity-empty">
                  <span role="status">No velocity history for {team}.</span>
                </BoardState>
              )}
              {!!people.length && (
                <PersonBreakdown
                  people={people}
                  personId={personId}
                  sprintCount={selected.series.length}
                  onSelect={choosePerson}
                />
              )}
              <div className="home-velocity-notes">
                <p data-testid="home-velocity-methodology">
                  Source: Jira. Current status and estimates apply to each active or closed sprint
                  membership. Teams derive from sprint names. This is not a sprint-close snapshot.
                  Attribution uses the current assignee at generation, not historical ownership.
                  Name fallback may merge same-name people and changes on rename. Unestimated counts
                  are sprint memberships, not unique issues; a zero estimate is still estimated.
                </p>
                <p data-testid="home-velocity-coverage">
                  History completeness is not verified.
                  {data.coverage.possibleTruncation &&
                    ` The ${data.coverage.maxIssuesPerQuery.toLocaleString()}-issue query limit may have been reached; some history may be missing.`}
                </p>
              </div>
            </>
          )}
        </div>
      </BoardSection>
    </BoardPanel>
  );
}
