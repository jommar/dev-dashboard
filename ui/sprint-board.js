// sprint-board.js — the Sprint tab's team and sprint choice, its column order and its session chips.
// Pure: storage is passed in (localStorage by default). Its key is its own, never Home's velocity key.
import { isFinished } from './sprint-attention.js';

export const SPRINT_BOARD_POLL_MS = 60_000;
export const DEFAULT_SPRINT_TEAM = 'Nexus';

const STORAGE_KEY = 'dev-dashboard.sprint-board';
const DEFAULT_CHOICE = Object.freeze({ team: DEFAULT_SPRINT_TEAM, sprint: null });
const validTeam = (team) => typeof team === 'string' && team.trim().length > 0;
const validSprint = (sprint) => Number.isSafeInteger(sprint) && sprint > 0;

export function readSprintChoice(storage) {
  try {
    const saved = JSON.parse((storage ?? globalThis.localStorage).getItem(STORAGE_KEY));
    if (saved?.version !== 1 || !validTeam(saved.team)) return { ...DEFAULT_CHOICE };
    return { team: saved.team, sprint: validSprint(saved.sprint) ? saved.sprint : null };
  } catch {
    return { ...DEFAULT_CHOICE };
  }
}

export function writeSprintChoice({ team, sprint }, storage) {
  try {
    (storage ?? globalThis.localStorage).setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 1, team, sprint }),
    );
  } catch {
    // The choice still holds in memory when storage is denied.
  }
}

// The saved team, else Nexus, else the first team.
export const pickTeam = (teams, saved) =>
  teams.find(({ name }) => name === saved) ??
  teams.find(({ name }) => name === DEFAULT_SPRINT_TEAM) ??
  teams[0] ??
  null;

const activeSprintId = (team) => team.sprints.find(({ state }) => state === 'active')?.id;

// The active sprint is stored as no sprint, so the choice follows the team across a rollover; only
// another sprint is pinned by its id.
export function sprintChoice(team, sprintId) {
  const activeId = activeSprintId(team);
  return { team: team.name, sprint: sprintId === activeId ? null : sprintId };
}

// A sprint pinned while it was future stops being pinned once it is active, so the next rollover
// moves the choice on instead of leaving it on a closed sprint. An unchanged choice is returned as is.
export function settledChoice(team, choice) {
  return choice.sprint !== null && choice.sprint === activeSprintId(team)
    ? { ...choice, sprint: null }
    : choice;
}

// Sprints arrive active, future nearest first, then closed newest first, so the first of a state is the one to fall back on.
export const pickSprint = (sprints, savedId) =>
  sprints.find(({ id }) => id === savedId) ??
  sprints.find(({ state }) => state === 'active') ??
  sprints.find(({ state }) => state === 'future') ??
  sprints.find(({ state }) => state === 'closed') ??
  null;

// The shared board order puts Rejected among the blocked and Duplicate among the queued; on the
// Sprint tab a finished column that is not done-kind goes last instead, the order otherwise kept.
export function finishedColumnsLast(columns) {
  const moved = (column) => column.kind !== 'done' && column.tickets.every(isFinished);
  return [...columns.filter((column) => !moved(column)), ...columns.filter(moved)];
}

export const UNASSIGNED_ASSIGNEE = '__unassigned__';

const assigneeOf = (ticket) => String(ticket?.assignee ?? '').trim();

// Distinct assignees in the sprint: alphabetical case-insensitive, Unassigned last when present.
export function sprintAssignees(tickets = []) {
  const names = new Map();
  let hasUnassigned = false;
  for (const ticket of tickets) {
    const name = assigneeOf(ticket);
    if (!name) hasUnassigned = true;
    else if (!names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
  }
  const list = [...names.values()]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    .map((name) => ({ value: name, label: name }));
  if (hasUnassigned) list.push({ value: UNASSIGNED_ASSIGNEE, label: 'Unassigned' });
  return list;
}

export function matchesAssignee(ticket, selected) {
  if (!selected) return true;
  const name = assigneeOf(ticket);
  if (selected === UNASSIGNED_ASSIGNEE) return !name;
  return name.toLowerCase() === selected.toLowerCase();
}

const SIDE_PHASES = ['groom', 'review', 'specReview', 'e2e', 'reviewRequest'];

// The words of ui/session-phases.js, keyed the way an entry names its sessions, plus spec review,
// which that table does not list. Kept here because importing that module from the lazy Sprint
// screen splits it, and its importers, out of the first-paint bundle into chunks of their own,
// which costs more gzip than the budget has left.
const SESSION_CHIP_WORDS = {
  'investigate-and-plan': 'Investigate and plan',
  'implement-plan': 'Implement plan',
  review: 'Code review',
  specReview: 'Spec review',
  groom: 'Groom ticket',
  e2e: 'E2E check',
  reviewRequest: 'Request code review',
};
export const sessionChipWords = (phase) => SESSION_CHIP_WORDS[phase] ?? phase;

// One chip per session the ticket has: the workflow phase first, then the side sessions.
export function sessionChips(entry) {
  if (!entry) return [];
  const chips = [];
  if (entry.phase && entry.state !== 'none') chips.push({ phase: entry.phase, state: entry.state });
  for (const phase of SIDE_PHASES) {
    const state = entry[phase]?.state;
    if (state && state !== 'none') chips.push({ phase, state });
  }
  return chips;
}
