// Whole-team sprint reads for the Sprint tab: which sprints each team has, and every ticket in
// one sprint whoever it is assigned to. Read-only Jira searches, cached briefly so the tab's
// poll and a Refresh do not turn into sustained Jira load.
import { jiraConfig, authorization, mapSprints, mapTicketIssue, ticketFields } from './jira.mjs';
import { collectCappedJiraIssues } from './jira-search.mjs';
import { boardOf } from './team-velocity.mjs';
import { upstreamFetch, upstreamError } from './upstream.mjs';

export const SPRINT_ID = /^[1-9]\d{0,9}$/;

const PAGE_SIZE = 100;
const SPRINT_SCAN_MAX_ISSUES = 300;
const SPRINT_TICKETS_MAX_ISSUES = 200;
const CLOSED_SPRINTS_PER_TEAM = 3;
const SPRINT_LIST_TTL_MS = 5 * 60_000;
const SPRINT_TICKETS_TTL_MS = 30_000;
const SPRINT_TICKETS_MAX_ENTRIES = 20;
const LISTED_STATES = ['active', 'future', 'closed'];

const sprintLists = new Map();
const sprintTickets = new Map();

export function clearSprintBoardCaches() {
  sprintLists.clear();
  sprintTickets.clear();
}

// Concurrent readers share one in-flight promise; a failed read is forgotten so the next one asks again.
function cachedRead(cache, key, { ttlMs, maxEntries = Infinity, now }, load) {
  const hit = cache.get(key);
  if (hit && now - hit.at < ttlMs) return hit.promise;
  cache.delete(key);
  const entry = { at: now, promise: load() };
  cache.set(key, entry);
  if (cache.size > maxEntries) cache.delete(cache.keys().next().value);
  entry.promise.catch(() => {
    if (cache.get(key) === entry) cache.delete(key);
  });
  return entry.promise;
}

function configured(snapshot) {
  const cfg = jiraConfig(snapshot);
  if (!cfg) throw new Error('Jira is not configured.');
  return cfg;
}

function searchCapped(cfg, { jql, fields, maxIssues, mapIssue }) {
  return collectCappedJiraIssues({
    maxIssues,
    mapIssue,
    fetchPage: async (nextPageToken) => {
      const url = new URL(`${cfg.baseUrl}/rest/api/3/search/jql`);
      url.searchParams.set('jql', jql);
      url.searchParams.set('fields', fields.filter(Boolean).join(','));
      url.searchParams.set('maxResults', String(PAGE_SIZE));
      if (nextPageToken) url.searchParams.set('nextPageToken', nextPageToken);
      const res = await upstreamFetch('jira', url, {
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: {
          Accept: 'application/json',
          Authorization: authorization(cfg.email, cfg.token),
        },
      });
      if (!res.ok) throw upstreamError('jira', res, `jira search failed: ${res.status}`);
      return res.json();
    },
  });
}

// Nearest first: dated sprints by start date, then undated ones in the order Jira created them.
const startsAt = (sprint) => {
  const time = Date.parse(sprint.startDate);
  return Number.isFinite(time) ? time : Infinity;
};
const byNearestStart = (a, b) => startsAt(a) - startsAt(b) || a.id - b.id;

function teamsOf(sprints) {
  const seen = new Set();
  const byTeam = new Map();
  for (const sprint of mapSprints(sprints)) {
    if (!Number.isInteger(sprint.id) || sprint.id < 1 || seen.has(sprint.id)) continue;
    if (!LISTED_STATES.includes(sprint.state)) continue;
    seen.add(sprint.id);
    const name = boardOf(sprint.name);
    if (!byTeam.has(name)) byTeam.set(name, []);
    byTeam.get(name).push(sprint);
  }
  return [...byTeam.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, list]) => ({
      name,
      sprints: [
        ...list.filter((sprint) => sprint.state === 'active'),
        ...list.filter((sprint) => sprint.state === 'future').sort(byNearestStart),
        ...list.filter((sprint) => sprint.state === 'closed').slice(0, CLOSED_SPRINTS_PER_TEAM),
      ],
    }));
}

export function fetchSprintList({ snapshot, now = Date.now() } = {}) {
  const cfg = configured(snapshot);
  return cachedRead(
    sprintLists,
    `${cfg.baseUrl} ${cfg.email} ${cfg.sprintField}`,
    { ttlMs: SPRINT_LIST_TTL_MS, now },
    async () => {
      const scan = (jql) =>
        searchCapped(cfg, {
          jql,
          fields: [cfg.sprintField],
          maxIssues: SPRINT_SCAN_MAX_ISSUES,
          mapIssue: (issue) => mapSprints(issue?.fields?.[cfg.sprintField]),
        });
      const [open, closed] = await Promise.all([
        scan('sprint in openSprints() ORDER BY updated DESC'),
        scan('sprint in closedSprints() ORDER BY updated DESC'),
      ]);
      return {
        teams: teamsOf([...open.items, ...closed.items].flat()),
        truncated: open.truncated || closed.truncated,
        updatedAt: new Date().toISOString(),
      };
    },
  );
}

// The id goes into JQL, so it is checked here as well as in the route.
export function fetchSprintTickets(sprintId, { snapshot, now = Date.now() } = {}) {
  if (!SPRINT_ID.test(String(sprintId)))
    throw Object.assign(new Error('Invalid sprint.'), { code: 'INVALID_SPRINT', status: 400 });
  const cfg = configured(snapshot);
  return cachedRead(
    sprintTickets,
    `${cfg.baseUrl} ${cfg.email} ${sprintId}`,
    { ttlMs: SPRINT_TICKETS_TTL_MS, maxEntries: SPRINT_TICKETS_MAX_ENTRIES, now },
    async () => {
      const { items: tickets, truncated } = await searchCapped(cfg, {
        jql: `sprint = ${sprintId} ORDER BY updated DESC`,
        fields: [...ticketFields(cfg), 'assignee'],
        maxIssues: SPRINT_TICKETS_MAX_ISSUES,
        mapIssue: (issue) => {
          const ticket = mapTicketIssue(issue, cfg);
          return ticket && { ...ticket, assignee: issue.fields?.assignee?.displayName || null };
        },
      });
      return {
        sprint: Number(sprintId),
        total: tickets.length,
        truncated,
        tickets,
        updatedAt: new Date().toISOString(),
      };
    },
  );
}
