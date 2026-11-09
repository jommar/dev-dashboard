import { createHash } from 'node:crypto';
import { captureConfiguration } from './settings.mjs';
import {
  fetchTeamIssues,
  buildTeamBoards,
  boardSeries,
  DEFAULT_KEEP_SPRINTS,
  TEAM_VELOCITY_MAX_ISSUES,
} from './team-velocity.mjs';

function issueIdentity(issue) {
  const key = issue?.key;
  if (typeof key === 'string' && key.trim()) return `key:${key}`;
  const id = issue?.id;
  if (id != null && String(id).trim()) return `id:${id}`;
  return Symbol();
}

function retainLaterIssue(previous, candidate) {
  const previousUpdated = Date.parse(previous?.fields?.updated);
  const candidateUpdated = Date.parse(candidate?.fields?.updated);
  return (
    !Number.isFinite(previousUpdated) ||
    !Number.isFinite(candidateUpdated) ||
    candidateUpdated >= previousUpdated
  );
}

function normalizeIssues(issues, sprintField) {
  const unique = new Map();
  for (const issue of issues) {
    const identity = issueIdentity(issue);
    if (!unique.has(identity) || retainLaterIssue(unique.get(identity), issue))
      unique.set(identity, issue);
  }
  return [...unique.values()].map((issue) => {
    const fields = issue?.fields || {};
    const memberships = fields[sprintField];
    const seen = new Set();
    const sprints = (Array.isArray(memberships) ? memberships : []).filter((sprint) => {
      if (!sprint || !sprint.name) return false;
      const identity = String(sprint.id ?? sprint.name);
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
    return { ...issue, fields: { ...fields, [sprintField]: sprints } };
  });
}

function serializeEntry(entry) {
  const { id, name, state, endDate } = entry.sprint;
  const { done, inProgress, notStarted } = entry.byStatus;
  return {
    sprint: { id, name, state, endDate },
    points: entry.points,
    count: entry.count,
    unestimated: entry.unestimated,
    byStatus: { done, inProgress, notStarted },
  };
}

function personIdentity(assignee) {
  if (assignee == null) return { id: 'unassigned', displayName: 'Unassigned' };
  const hasName = typeof assignee.displayName === 'string' && assignee.displayName.trim();
  const displayName = hasName ? assignee.displayName : 'Unknown assignee';
  if (typeof assignee.accountId === 'string' && assignee.accountId.trim()) {
    const digest = createHash('sha256').update(`accountId:${assignee.accountId}`).digest('hex');
    return { id: `person:${digest}`, displayName };
  }
  if (hasName) {
    const digest = createHash('sha256').update(`displayName:${displayName}`).digest('hex');
    return { id: `name:${digest}`, displayName };
  }
  return { id: 'unknown', displayName };
}

function partitionPeople(issues) {
  const people = new Map();
  for (const issue of issues) {
    const identity = personIdentity(issue.fields.assignee);
    if (!people.has(identity.id))
      people.set(identity.id, { ...identity, labelIssue: issue, issues: [] });
    const person = people.get(identity.id);
    person.issues.push(issue);
    if (retainLaterIssue(person.labelIssue, issue)) {
      person.displayName = identity.displayName;
      person.labelIssue = issue;
    }
  }
  return people;
}

function buildPeopleByTeam(issues, snapshot) {
  const peopleByTeam = new Map();
  for (const { id, displayName, issues: personIssues } of partitionPeople(issues).values()) {
    const teams = buildTeamBoards(personIssues, { snapshot });
    for (const [name, bySprint] of teams) {
      if (!peopleByTeam.has(name)) peopleByTeam.set(name, []);
      peopleByTeam.get(name).push({ id, displayName, bySprint });
    }
  }
  return peopleByTeam;
}

function alignPeople(people, teamSeries) {
  return people
    .map(({ id, displayName, bySprint }) => ({
      id,
      displayName,
      series: teamSeries.map(({ sprint }) => {
        const entry = bySprint.get(String(sprint.id ?? sprint.name));
        return serializeEntry({
          ...(entry || {
            points: 0,
            count: 0,
            unestimated: 0,
            byStatus: { done: 0, inProgress: 0, notStarted: 0 },
          }),
          sprint,
        });
      }),
    }))
    .filter(({ series }) => series.some(({ count }) => count > 0))
    .sort(
      (left, right) =>
        left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id),
    );
}

export function buildHomeVelocity(issues, { snapshot } = {}) {
  const captured = captureConfiguration(snapshot);
  const normalized = normalizeIssues(issues, captured.jira.sprintField);
  const teams = buildTeamBoards(normalized, { snapshot: captured });
  const peopleByTeam = buildPeopleByTeam(normalized, captured);
  const boards = [...teams.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, bySprint]) => {
      const series = boardSeries(bySprint, DEFAULT_KEEP_SPRINTS).map(serializeEntry);
      return { name, series, people: alignPeople(peopleByTeam.get(name), series) };
    });
  return {
    boards,
    keep: DEFAULT_KEEP_SPRINTS,
    coverage: {
      completeness: 'unknown',
      possibleTruncation: issues.length >= TEAM_VELOCITY_MAX_ISSUES,
      maxIssuesPerQuery: TEAM_VELOCITY_MAX_ISSUES,
    },
  };
}

export async function fetchHomeVelocity({ snapshot } = {}) {
  const captured = captureConfiguration(snapshot);
  const issues = await fetchTeamIssues({ snapshot: captured });
  const aggregate = buildHomeVelocity(issues, { snapshot: captured });
  return { ...aggregate, updatedAt: new Date().toISOString() };
}
