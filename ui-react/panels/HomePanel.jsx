import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Menu, MenuItem } from '@mui/material';
import { BoardNote, BoardPanel, BoardSection, BoardState } from '../components/BoardShell.jsx';
import { Button, DashboardTooltip } from '../components/Primitives.jsx';
import { TeamVelocityChart, formatPoints } from '../components/TeamVelocityChart.jsx';
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
const STATUS_KEYS = ['done', 'inProgress', 'notStarted'];

const sprintIdentity = (entry) => {
  const number = entry.sprint.name.match(/\bsprint\s+(\d+)\b/i);
  return number ? `Sprint ${Number(number[1])}` : entry.sprint.name;
};

const sprintWindow = (series, sprintIds) =>
  sprintIds.length ? series.filter((entry) => sprintIds.includes(sprintIdentity(entry))) : series;

const emptyEntry = (sprint) => ({
  sprint,
  points: 0,
  count: 0,
  unestimated: 0,
  byStatus: { done: 0, inProgress: 0, notStarted: 0 },
});

function addEntry(target, source) {
  target.points += source.points;
  target.count += source.count;
  target.unestimated += source.unestimated;
  for (const status of STATUS_KEYS) target.byStatus[status] += source.byStatus[status];
}

function combineBoards(boards, sprintIds) {
  if (!boards.length) return { series: [], people: NO_PEOPLE };
  if (boards.length === 1) {
    return {
      series: sprintWindow(boards[0].series, sprintIds),
      people: boards[0].people,
    };
  }
  const bySprint = new Map();
  for (const board of boards) {
    for (const entry of sprintWindow(board.series, sprintIds)) {
      const id = sprintIdentity(entry);
      let bucket = bySprint.get(id);
      if (!bucket) {
        bucket = emptyEntry({
          id,
          name: id,
          state: entry.sprint.state,
          endDate: entry.sprint.endDate,
        });
        bySprint.set(id, bucket);
      } else {
        if (entry.sprint.state === 'active') bucket.sprint.state = 'active';
        if (
          entry.sprint.endDate &&
          (!bucket.sprint.endDate || entry.sprint.endDate > bucket.sprint.endDate)
        ) {
          bucket.sprint.endDate = entry.sprint.endDate;
        }
      }
      addEntry(bucket, entry);
    }
  }
  const series = [...bySprint.values()].sort(
    (a, b) =>
      (a.sprint.endDate || '').localeCompare(b.sprint.endDate || '') ||
      a.sprint.name.localeCompare(b.sprint.name, undefined, { numeric: true }),
  );
  const indexBySprint = new Map(series.map((entry, index) => [entry.sprint.id, index]));
  const peopleById = new Map();
  for (const board of boards) {
    for (const person of board.people) {
      let merged = peopleById.get(person.id);
      if (!merged) {
        merged = {
          id: person.id,
          displayName: person.displayName,
          series: series.map((entry) => emptyEntry(entry.sprint)),
        };
        peopleById.set(person.id, merged);
      }
      for (const entry of sprintWindow(person.series, sprintIds)) {
        const index = indexBySprint.get(sprintIdentity(entry));
        if (index !== undefined) addEntry(merged.series[index], entry);
      }
    }
  }
  return { series, people: [...peopleById.values()] };
}

function comparisonPeople(people, sprintIds) {
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
  return sorted
    .map((person) => {
      let label = person.displayName;
      if (totals.get(label) > 1 || RESERVED_PERSON_LABELS.has(label)) {
        let ordinal = 1;
        do {
          label = `${person.displayName} (${ordinal++})`;
        } while (reserved.has(label) || used.has(label));
      }
      used.add(label);
      const series = sprintWindow(person.series, sprintIds);
      const byStatus = { done: 0, inProgress: 0, notStarted: 0 };
      for (const entry of series)
        for (const status of STATUS_KEYS) byStatus[status] += entry.byStatus[status];
      const points = series.reduce((total, entry) => total + entry.points, 0);
      return {
        ...person,
        series,
        label,
        points,
        average: series.length ? points / series.length : 0,
        byStatus,
      };
    })
    .filter((person) => !sprintIds.length || person.series.some((entry) => entry.count > 0))
    .sort(
      (a, b) => b.points - a.points || a.label.localeCompare(b.label) || a.id.localeCompare(b.id),
    );
}

function combinePeopleSeries(chosenPeople, baseSeries) {
  if (!chosenPeople.length) return baseSeries;
  if (chosenPeople.length === 1) return chosenPeople[0].series;
  return baseSeries.map((base, index) => {
    const entry = emptyEntry(base.sprint);
    for (const person of chosenPeople) {
      if (person.series[index]) addEntry(entry, person.series[index]);
    }
    return entry;
  });
}

function reconcileSelection(boards, current) {
  const availableSprints = new Set(
    boards.flatMap((board) => board.series.map((entry) => sprintIdentity(entry))),
  );
  const sprints = current.sprints.filter((id) => availableSprints.has(id));
  const eligible = sprints.length
    ? boards.filter((board) => sprintWindow(board.series, sprints).length)
    : boards;
  const eligibleNames = new Set(eligible.map((board) => board.name));
  let teams = current.teams.filter((name) => !sprints.length || eligibleNames.has(name));
  if (current.teams.length && !teams.length && eligible.length) teams = [eligible[0].name];
  const activeBoards = teams.length
    ? eligible.filter((board) => teams.includes(board.name))
    : eligible;
  const { people: mergedPeople } = combineBoards(activeBoards, sprints);
  const validPeople = new Set(comparisonPeople(mergedPeople, sprints).map((entry) => entry.id));
  const people = current.people.filter((id) => validPeople.has(id));
  return { teams, sprints, people };
}

function toggleValue(list, value) {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

function MultiSelect({ label, testId, allLabel, options, selected, onChange }) {
  const [anchor, setAnchor] = useState(null);
  const labelId = useId();
  const listId = useId();
  const open = Boolean(anchor);
  const summary =
    selected.length === 0
      ? allLabel
      : selected.length === 1
        ? (options.find((option) => option.value === selected[0])?.label ?? selected[0])
        : `${selected.length} selected`;

  return (
    <div className="home-velocity-team-field">
      <span id={labelId}>{label}</span>
      <button
        type="button"
        className="home-velocity-select"
        data-testid={testId}
        data-values={selected.join(',')}
        aria-labelledby={labelId}
        aria-haspopup="menu"
        aria-expanded={open ? 'true' : 'false'}
        aria-controls={open ? listId : undefined}
        onClick={(event) => setAnchor(event.currentTarget)}
      >
        <span className="home-velocity-select-text">{summary}</span>
        <span className="home-velocity-select-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      <Menu
        anchorEl={anchor}
        open={open}
        onClose={() => setAnchor(null)}
        slotProps={{
          list: {
            id: listId,
            'aria-labelledby': labelId,
            className: 'home-velocity-menu',
          },
        }}
      >
        <MenuItem
          className="home-velocity-menu-item"
          data-testid={`${testId}-all`}
          onClick={() => {
            onChange([]);
            setAnchor(null);
          }}
        >
          <input type="checkbox" readOnly tabIndex={-1} checked={selected.length === 0} />
          <span>{allLabel}</span>
        </MenuItem>
        {options.map((option) => (
          <MenuItem
            key={option.value}
            className="home-velocity-menu-item"
            data-testid={`${testId}-option`}
            data-value={option.value}
            onClick={() => onChange(toggleValue(selected, option.value))}
          >
            <input
              type="checkbox"
              readOnly
              tabIndex={-1}
              checked={selected.includes(option.value)}
            />
            <span>{option.label}</span>
          </MenuItem>
        ))}
      </Menu>
    </div>
  );
}

function PersonBreakdown({
  people,
  personIds,
  hoveredPersonId,
  sprintCount,
  sprintLabel,
  onToggle,
  onHover,
}) {
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
          Total points ·{' '}
          {sprintLabel || `${sprintCount} displayed ${sprintCount === 1 ? 'sprint' : 'sprints'}`}
        </span>
      </div>
      <ul className="home-velocity-people-list">
        {people.map((person) => {
          const avg = formatPoints(person.average);
          const enter = () => onHover(person.id);
          const leave = () => onHover('');
          return (
            <li key={person.id}>
              <DashboardTooltip
                title={`${person.byStatus.done} completed, ${person.byStatus.inProgress} in progress, ${person.byStatus.notStarted} not started points`}
              >
                <button
                  type="button"
                  data-testid="home-velocity-person-row"
                  aria-pressed={personIds.includes(person.id)}
                  data-hovered={hoveredPersonId === person.id ? 'true' : undefined}
                  aria-label={`${person.label}: ${person.points} total points (${avg} avg per sprint); ${person.byStatus.done} completed, ${person.byStatus.inProgress} in progress, ${person.byStatus.notStarted} not started`}
                  onClick={() => onToggle(person.id)}
                  onMouseEnter={enter}
                  onMouseLeave={leave}
                  onFocus={enter}
                  onBlur={leave}
                >
                  <span className="home-velocity-person-name">{person.label}</span>
                  <span className="home-velocity-person-values">
                    <strong>{person.points}</strong>
                    <span
                      className="home-velocity-person-avg"
                      data-testid="home-velocity-person-avg"
                    >
                      {avg}/sprint
                    </span>
                  </span>
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
              </DashboardTooltip>
            </li>
          );
        })}
      </ul>
      <p>
        Bars share the same point scale across people. Carried issues count in each sprint
        membership, not as unique delivered work. Sorted by total points, highest first.
      </p>
    </section>
  );
}

export function HomePanel({ active }) {
  const api = useDashboardApi();
  const [selection, setSelection] = useState(() => ({
    teams: [readVelocityTeam()],
    people: [],
    sprints: [],
  }));
  const [data, setData] = useState(() => readVelocitySnapshot());
  const primaryTeam = selection.teams[0] || '';
  const previousTeam = useRef(primaryTeam);
  useEffect(() => {
    if (primaryTeam && previousTeam.current !== primaryTeam) {
      writeVelocityTeam(primaryTeam);
      previousTeam.current = primaryTeam;
    }
  }, [primaryTeam]);
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
      setSelection((current) => reconcileSelection(snapshot.boards, current));
    } catch (error) {
      setFailure(error.message);
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [api]);

  const { teams: selectedTeams, people: selectedPeopleIds, sprints: selectedSprints } = selection;
  const boards = data?.boards;
  const sprints = useMemo(
    () =>
      [...new Set((boards || []).flatMap((board) => board.series.map(sprintIdentity)))].sort(
        (a, b) => b.localeCompare(a, undefined, { numeric: true }),
      ),
    [boards],
  );
  const teams = useMemo(() => {
    const names = (boards || [])
      .filter(
        (board) => !selectedSprints.length || sprintWindow(board.series, selectedSprints).length,
      )
      .map((board) => board.name);
    if (selectedSprints.length) return names;
    const missing = selectedTeams.filter((name) => !names.includes(name));
    return [...missing, ...names];
  }, [boards, selectedTeams, selectedSprints]);

  const selectedBoards = useMemo(() => {
    const eligible = (boards || []).filter(
      (board) => !selectedSprints.length || sprintWindow(board.series, selectedSprints).length,
    );
    return selectedTeams.length
      ? eligible.filter((board) => selectedTeams.includes(board.name))
      : eligible;
  }, [boards, selectedTeams, selectedSprints]);

  const [hoveredPersonId, setHoveredPersonId] = useState('');
  const { series, people: rawPeople } = useMemo(
    () => combineBoards(selectedBoards, selectedSprints),
    [selectedBoards, selectedSprints],
  );
  const people = useMemo(
    () => comparisonPeople(rawPeople, selectedSprints),
    [rawPeople, selectedSprints],
  );
  const chosenPeople = useMemo(
    () => people.filter((person) => selectedPeopleIds.includes(person.id)),
    [people, selectedPeopleIds],
  );
  const viewSeries = useMemo(
    () => combinePeopleSeries(chosenPeople, series),
    [chosenPeople, series],
  );

  const teamLabel =
    selectedTeams.length === 0
      ? 'All teams'
      : selectedTeams.length === 1
        ? selectedTeams[0]
        : `${selectedTeams.length} teams`;
  const personLabel =
    chosenPeople.length === 0
      ? 'Everyone'
      : chosenPeople.length === 1
        ? chosenPeople[0].label
        : `${chosenPeople.length} people`;
  const teamAverage = series.length
    ? series.reduce((sum, entry) => sum + entry.points, 0) / series.length
    : 0;
  const hoveredPerson = people.find(
    (person) =>
      person.id === hoveredPersonId && person.id !== 'unassigned' && person.id !== 'unknown',
  );
  const groupLine = useMemo(() => {
    if (!chosenPeople.length) return null;
    if (chosenPeople.length === 1) {
      const only = chosenPeople[0];
      return only.id === 'unassigned' || only.id === 'unknown' ? null : only;
    }
    const avg = viewSeries.length
      ? viewSeries.reduce((sum, entry) => sum + entry.points, 0) / viewSeries.length
      : 0;
    return { id: 'group', label: personLabel, average: avg };
  }, [chosenPeople, viewSeries, personLabel]);

  const togglePerson = (id) =>
    setSelection((current) => ({ ...current, people: toggleValue(current.people, id) }));
  const generated = data && new Date(data.updatedAt).toLocaleString();
  const meta = data ? (
    <time dateTime={data.updatedAt}>Generated {generated}</time>
  ) : (
    'Not generated'
  );
  const chart = useMemo(
    () =>
      series.length ? (
        <TeamVelocityChart
          key={selectedTeams.join('|')}
          team={teamLabel}
          personLabel={personLabel}
          series={viewSeries}
          scaleSeries={series}
          teamAverage={teamAverage}
          personLine={hoveredPerson || groupLine}
          isTeamView={!chosenPeople.length}
        />
      ) : null,
    [
      series,
      selectedTeams,
      teamLabel,
      personLabel,
      viewSeries,
      teamAverage,
      hoveredPerson,
      groupLine,
      chosenPeople.length,
    ],
  );

  const sprintOptions = useMemo(
    () => sprints.map((name) => ({ value: name, label: name })),
    [sprints],
  );
  const teamOptions = useMemo(() => teams.map((name) => ({ value: name, label: name })), [teams]);
  const personOptions = useMemo(
    () => people.map((person) => ({ value: person.id, label: person.label })),
    [people],
  );

  return (
    <BoardPanel id="home" active={active} busy={loading}>
      <BoardSection
        name="home"
        title="Velocity"
        meta={meta}
        controls={
          <>
            <MultiSelect
              label="Sprint"
              testId="home-velocity-sprint"
              allLabel="All displayed sprints"
              options={sprintOptions}
              selected={selectedSprints}
              onChange={(nextSprints) =>
                setSelection((current) =>
                  reconcileSelection(boards || [], { ...current, sprints: nextSprints }),
                )
              }
            />
            <MultiSelect
              label="Team"
              testId="home-velocity-team"
              allLabel="All teams"
              options={teamOptions}
              selected={selectedTeams}
              onChange={(nextTeams) =>
                setSelection((current) => ({
                  ...current,
                  teams: nextTeams,
                  people: [],
                }))
              }
            />
            <MultiSelect
              label="Person"
              testId="home-velocity-person"
              allLabel="Everyone"
              options={personOptions}
              selected={selectedPeopleIds}
              onChange={(nextPeople) =>
                setSelection((current) => ({ ...current, people: nextPeople }))
              }
            />
            <Button
              className={data ? undefined : 'primary'}
              data-testid="home-refresh"
              disabled={loading}
              onClick={generate}
            >
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
                label={`Loading velocity for ${teamLabel}…`}
                testId="home-velocity-loading"
              />
            ) : failure ? (
              <BoardState kind="error" testId="home-velocity-error">
                <span role="alert">
                  Could not generate velocity for {teamLabel}: {failure}. Use Generate velocity to
                  retry.
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
                  <span role="status">No velocity history for {teamLabel}.</span>
                </BoardState>
              )}
              {!!people.length && (
                <PersonBreakdown
                  people={people}
                  personIds={selectedPeopleIds}
                  hoveredPersonId={hoveredPersonId}
                  sprintCount={series.length}
                  sprintLabel={selectedSprints.length === 1 ? selectedSprints[0] : undefined}
                  onToggle={togglePerson}
                  onHover={setHoveredPersonId}
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
