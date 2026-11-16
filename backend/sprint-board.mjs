// Whole-team sprint reads for the Sprint tab: which sprints each team has (Jira's Agile board and
// sprint lists, or an issue scan when those are refused), and every ticket in one sprint whoever it
// is assigned to. Read-only, bounded and cached briefly so the tab's poll and a Refresh do not turn
// into sustained Jira load.
import { jiraConfig, authorization, mapSprints, mapTicketIssue, ticketFields } from './jira.mjs';
import { collectCappedJiraIssues, runWithLimit } from './jira-search.mjs';
import { boardOf } from './team-velocity.mjs';
import { classifyResponse, upstreamFetch, upstreamError } from './upstream.mjs';

export const SPRINT_ID = /^[1-9]\d{0,9}$/;

const PAGE_SIZE = 100;
const SPRINT_SCAN_MAX_ISSUES = 300;
const SPRINT_TICKETS_MAX_ISSUES = 200;
const CLOSED_SPRINTS_PER_TEAM = 3;
const SPRINT_LIST_TTL_MS = 5 * 60_000;
const SPRINT_TICKETS_TTL_MS = 30_000;
const SPRINT_TICKETS_MAX_ENTRIES = 20;
const LISTED_STATES = ['active', 'future', 'closed'];
// Agile discovery bounds: one board-list page of 50 covers the 20-board cap, and a board's sprints
// cost one open page plus at most CLOSED_PAGES_MAX closed pages (two when Jira sends `total`).
const AGILE_PAGE_SIZE = 50;
const BOARDS_MAX = 20;
const CLOSED_PAGES_MAX = 4;
const BOARD_CONCURRENCY = 3;
// A board list refused with these falls back to the issue scan; any other failure is the reply.
const AGILE_FALLBACK_STATUSES = [401, 403, 404];
// A board whose sprints are refused with these is skipped and the list marked truncated.
const BOARD_SKIP_STATUSES = [400, 403, 404];

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

function agileGet(cfg, path, params) {
  const url = new URL(`${cfg.baseUrl}${path}`);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
  return upstreamFetch('jira', url, {
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
    headers: { Accept: 'application/json', Authorization: authorization(cfg.email, cfg.token) },
  });
}

const rateLimited = (res) => classifyResponse(res.status, res.headers).kind === 'rate_limit';

// One page of an Agile list, or null when Jira refuses that board in a way that only skips it.
async function agilePage(cfg, path, params) {
  const res = await agileGet(cfg, path, params);
  if (res.ok) return res.json();
  if (BOARD_SKIP_STATUSES.includes(res.status) && !rateLimited(res)) return null;
  throw upstreamError('jira', res, `jira sprint list failed: ${res.status}`);
}

const valuesOf = (page) => (Array.isArray(page?.values) ? page.values : []);

// The scrum boards, at most BOARDS_MAX, from one page; null when Jira refuses the list in a way the
// scan can cover.
async function scrumBoards(cfg) {
  const res = await agileGet(cfg, '/rest/agile/1.0/board', {
    type: 'scrum',
    startAt: 0,
    maxResults: AGILE_PAGE_SIZE,
  });
  if (!res.ok) {
    if (AGILE_FALLBACK_STATUSES.includes(res.status) && !rateLimited(res)) return null;
    throw upstreamError('jira', res, `jira board list failed: ${res.status}`);
  }
  const body = await res.json();
  const boards = valuesOf(body);
  return {
    boards: boards.slice(0, BOARDS_MAX),
    truncated: body.isLast === false || boards.length > BOARDS_MAX,
  };
}

// The closed sprints past the first page, which holds the oldest. With a `total` only the last page
// is read; without one the pages are read forward, at most CLOSED_PAGES_MAX in all.
async function newerClosed(page, first) {
  const total = Number(first.total);
  if (Number.isInteger(total) && total > AGILE_PAGE_SIZE) {
    const last = await page('closed', Math.max(AGILE_PAGE_SIZE, total - AGILE_PAGE_SIZE));
    return last ? { sprints: valuesOf(last), truncated: false } : { sprints: [], truncated: true };
  }
  const sprints = [];
  let startAt = valuesOf(first).length;
  for (let pages = 1; pages < CLOSED_PAGES_MAX && startAt > 0; pages += 1) {
    const next = await page('closed', startAt);
    if (!next) return { sprints, truncated: true };
    const values = valuesOf(next);
    sprints.push(...values);
    if (next.isLast !== false) return { sprints, truncated: false };
    if (values.length === 0) break;
    startAt += values.length;
  }
  return { sprints, truncated: true };
}

// One board's open sprints and its newest closed ones (Jira lists closed sprints oldest first). A
// refused board is skipped.
async function boardSprints(cfg, boardId) {
  const path = `/rest/agile/1.0/board/${boardId}/sprint`;
  const page = (state, startAt) =>
    agilePage(cfg, path, { state, startAt, maxResults: AGILE_PAGE_SIZE });
  // One request at a time per board, so BOARD_CONCURRENCY is also the most Jira requests at once.
  const open = await page('active,future', 0);
  const closed = open && (await page('closed', 0));
  if (!closed) return { sprints: [], truncated: true };
  const sprints = [...valuesOf(open), ...valuesOf(closed)];
  let truncated = open.isLast === false;
  if (closed.isLast === false) {
    const newer = await newerClosed(page, closed);
    sprints.push(...newer.sprints);
    truncated ||= newer.truncated;
  }
  return { sprints, truncated };
}

async function agileSprintList(cfg) {
  const listed = await scrumBoards(cfg);
  if (!listed) return null;
  const sprints = [];
  let truncated = listed.truncated;
  // A board id goes into a path, so it must be a positive integer like a sprint id.
  const ids = listed.boards.map((board) => board?.id).filter((id) => SPRINT_ID.test(String(id)));
  // The first failure is the reply, so the other workers start no further board.
  let failed = false;
  await runWithLimit(
    ids,
    BOARD_CONCURRENCY,
    async (id) => {
      try {
        const read = await boardSprints(cfg, id);
        sprints.push(...read.sprints);
        truncated ||= read.truncated;
      } catch (error) {
        failed = true;
        throw error;
      }
    },
    () => failed,
  );
  return { sprints, truncated };
}

// The fallback when the Agile API is not available: sprints read off the issues of open and closed
// sprints, capped, so a busy site lists only the sprints of the issues it reached.
async function scannedSprintList(cfg) {
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
    sprints: [...open.items, ...closed.items].flat(),
    truncated: open.truncated || closed.truncated,
  };
}

export function fetchSprintList({ snapshot, now = Date.now() } = {}) {
  const cfg = configured(snapshot);
  return cachedRead(
    sprintLists,
    `${cfg.baseUrl} ${cfg.email} ${cfg.sprintField}`,
    { ttlMs: SPRINT_LIST_TTL_MS, now },
    async () => {
      const { sprints, truncated } = (await agileSprintList(cfg)) ?? (await scannedSprintList(cfg));
      return { teams: teamsOf(sprints), truncated, updatedAt: new Date().toISOString() };
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
