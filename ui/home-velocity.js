const STORAGE_KEY = 'dev-dashboard.home-velocity';
const DEFAULT_TEAM = 'Nexus';
const validTeam = (team) => typeof team === 'string' && team.trim().length > 0;
const SNAPSHOT_KEY = 'dev-dashboard.home-velocity.snapshot';
const SNAPSHOT_VERSION = 2;
const KEEP_SPRINTS = 8;
const PERSON_ID = /^(?:(?:person|name):[a-f0-9]{64}|unassigned|unknown)$/;
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonnegativeNumber = (value) => Number.isFinite(value) && value >= 0;
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const SPRINT_FIELDS = ['id', 'name', 'state', 'endDate'];
const POINT_TOLERANCE = 1e-9;

function pointsMatch(left, right) {
  return (
    Number.isFinite(left) &&
    Number.isFinite(right) &&
    Math.abs(left - right) <= POINT_TOLERANCE * Math.max(1, Math.abs(left), Math.abs(right))
  );
}

export function readVelocityTeam(storage) {
  try {
    const saved = JSON.parse((storage ?? globalThis.localStorage).getItem(STORAGE_KEY));
    return saved?.version === 1 && validTeam(saved.team) ? saved.team : DEFAULT_TEAM;
  } catch {
    return DEFAULT_TEAM;
  }
}

export function writeVelocityTeam(team, storage) {
  if (!validTeam(team)) return;
  try {
    (storage ?? globalThis.localStorage).setItem(STORAGE_KEY, JSON.stringify({ version: 1, team }));
  } catch {
    // The explicit choice remains usable in memory when storage is denied.
  }
}

function projectSeries(value) {
  if (!Array.isArray(value) || value.length > KEEP_SPRINTS) return null;
  const identities = new Set();
  const series = [];
  for (const entry of value) {
    if (!isRecord(entry) || !isRecord(entry.sprint) || !isRecord(entry.byStatus)) return null;
    const { id, name, state, endDate } = entry.sprint;
    const { points, count, unestimated } = entry;
    const { done, inProgress, notStarted } = entry.byStatus;
    if (
      !(id === null || typeof id === 'string' || Number.isFinite(id)) ||
      !validTeam(name) ||
      !['active', 'closed'].includes(state) ||
      !(endDate === null || typeof endDate === 'string') ||
      ![points, done, inProgress, notStarted].every(isNonnegativeNumber) ||
      !isCount(count) ||
      !isCount(unestimated) ||
      unestimated > count ||
      !pointsMatch(done + inProgress + notStarted, points)
    )
      return null;
    const identity = String(id ?? name);
    if (identities.has(identity)) return null;
    identities.add(identity);
    series.push({
      sprint: { id, name, state, endDate },
      points,
      count,
      unestimated,
      byStatus: { done, inProgress, notStarted },
    });
  }
  return series;
}

function projectBoard(value) {
  if (!isRecord(value) || !validTeam(value.name) || !Array.isArray(value.people)) return null;
  const series = projectSeries(value.series);
  if (!series) return null;
  const people = [];
  const identities = new Set();
  for (const person of value.people) {
    if (
      !isRecord(person) ||
      typeof person.id !== 'string' ||
      !PERSON_ID.test(person.id) ||
      identities.has(person.id) ||
      !validTeam(person.displayName)
    )
      return null;
    const personSeries = projectSeries(person.series);
    if (
      !personSeries ||
      personSeries.length !== series.length ||
      personSeries.some((entry, index) =>
        SPRINT_FIELDS.some((field) => entry.sprint[field] !== series[index].sprint[field]),
      )
    )
      return null;
    identities.add(person.id);
    people.push({ id: person.id, displayName: person.displayName, series: personSeries });
  }
  for (const [index, entry] of series.entries()) {
    for (const field of ['count', 'unestimated']) {
      if (people.reduce((sum, person) => sum + person.series[index][field], 0) !== entry[field])
        return null;
    }
    const points = people.reduce((sum, person) => sum + person.series[index].points, 0);
    if (!pointsMatch(points, entry.points)) return null;
    for (const status of Object.keys(entry.byStatus)) {
      const points = people.reduce((sum, person) => sum + person.series[index].byStatus[status], 0);
      if (!pointsMatch(points, entry.byStatus[status])) return null;
    }
  }
  return { name: value.name, series, people };
}

export function validateVelocitySnapshot(value) {
  if (
    !isRecord(value) ||
    !Array.isArray(value.boards) ||
    value.keep !== KEEP_SPRINTS ||
    !isRecord(value.coverage) ||
    value.coverage.completeness !== 'unknown' ||
    typeof value.coverage.possibleTruncation !== 'boolean' ||
    !Number.isSafeInteger(value.coverage.maxIssuesPerQuery) ||
    value.coverage.maxIssuesPerQuery <= 0 ||
    typeof value.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.updatedAt))
  )
    return null;
  const boards = value.boards.map(projectBoard);
  if (
    boards.some((board) => !board) ||
    new Set(boards.map((board) => board.name)).size !== boards.length
  )
    return null;
  return {
    boards,
    keep: KEEP_SPRINTS,
    coverage: {
      completeness: 'unknown',
      possibleTruncation: value.coverage.possibleTruncation,
      maxIssuesPerQuery: value.coverage.maxIssuesPerQuery,
    },
    updatedAt: value.updatedAt,
  };
}

export function readVelocitySnapshot(storage) {
  try {
    const record = JSON.parse((storage ?? globalThis.localStorage).getItem(SNAPSHOT_KEY));
    return record?.version === SNAPSHOT_VERSION ? validateVelocitySnapshot(record.snapshot) : null;
  } catch {
    return null;
  }
}

export function writeVelocitySnapshot(snapshot, storage) {
  const projected = validateVelocitySnapshot(snapshot);
  if (!projected) return false;
  try {
    (storage ?? globalThis.localStorage).setItem(
      SNAPSHOT_KEY,
      JSON.stringify({ version: SNAPSHOT_VERSION, snapshot: projected }),
    );
    return true;
  } catch {
    return false;
  }
}
