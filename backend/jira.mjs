// jira.mjs — fetch Jira ticket statuses for the tickets referenced by the open
// PRs, via the Jira Cloud REST API (v3). Zero external deps (global fetch, Node
// >= 20.18). Auth is HTTP Basic with <email>:<api-token> (Atlassian Cloud), read
// from env/.env via JIRA_BASE_URL + JIRA_EMAIL + JIRA_TOKEN — the same
// convention as the repo's other Jira clients. Status is <issue>.fields.status.name.
//
// Every surface (UI card, /api/prs) reads the same shape so nothing re-parses
// Jira's JSON. If no Jira credentials are configured, fetchTicketStatuses
// resolves to {} rather than throwing, so PRs are never blocked by a missing
// token.
import { captureConfiguration } from './settings.mjs';
import { collectCappedJiraIssues } from './jira-search.mjs';
import { allSprints } from '../ui/sprint-data.js';
import { isTicketKey } from './claude-ticket-state.mjs';

export { allSprints } from '../ui/sprint-data.js';

export function jiraConfig(snapshot) {
  const captured = captureConfiguration(snapshot);
  const { email, sprintField, pointsField } = captured.jira;
  const baseUrl = (captured.jira.baseUrl || '').replace(/\/+$/, '');
  const token = captured.credentials.jiraToken;
  if (!baseUrl || !email || !token) return null;
  return { baseUrl, email, token, sprintField, pointsField };
}

export function authorization(email, token) {
  const b64 = Buffer.from(`${email}:${token}`, 'utf8').toString('base64');
  return `Basic ${b64}`;
}

// Map ticket key -> its current Jira status name. Unknown/missing keys and any
// transport failure also come back as {} so callers never see a hard failure.
export async function fetchTicketStatuses(keys, { snapshot } = {}) {
  return (await fetchTicketMetadata(keys, { snapshot })).statuses;
}

// `strict` makes a Jira failure throw instead of reading as "no tickets", for a caller that must tell
// the two apart (fetchActiveSprintKeys).
export async function fetchTicketMetadata(keys, { snapshot, strict = false } = {}) {
  const cfg = jiraConfig(snapshot);
  const empty = { statuses: {}, sprints: {} };
  if (!cfg) return empty;
  const unique = [...new Set(keys)].filter(Boolean);
  if (!unique.length) return empty;

  const jql = `key in (${unique.map((k) => `"${k}"`).join(',')})`;
  // NOTE: the legacy GET /rest/api/3/search was removed by Atlassian (410
  // Gone, CHANGE-2046); the supported replacement is /rest/api/3/search/jql.
  const url = new URL(`${cfg.baseUrl}/rest/api/3/search/jql`);
  url.searchParams.set('jql', jql);
  url.searchParams.set('fields', ['status', cfg.sprintField].filter(Boolean).join(','));
  url.searchParams.set('maxResults', String(unique.length));

  try {
    const res = await fetch(url, {
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: authorization(cfg.email, cfg.token),
      },
    });
    if (!res.ok) {
      if (strict) throw new Error(`jira search failed: ${res.status}`);
      return empty;
    }
    const data = await res.json();

    const statuses = {};
    const sprints = {};
    for (const issue of data.issues || []) {
      statuses[issue.key] = issue.fields?.status?.name ?? null;
      sprints[issue.key] = mapSprints(issue.fields?.[cfg.sprintField])[0] || null;
    }
    return { statuses, sprints };
  } catch (error) {
    if (strict) throw error;
    return empty;
  }
}

// Which of `keys` are in a sprint Jira calls active, and each ticket's current status name. The bot
// bar asks this on every screen, so a ticket's answer is kept for ACTIVE_SPRINT_TTL_MS (sprint
// membership changes rarely) and only keys with no fresh answer go to Jira, ACTIVE_SPRINT_CHUNK at a
// time in one search each. "Active" is the rule `activeSprints` and My Tickets use (`state ===
// 'active'`), read from the ticket's most relevant sprint (`mapSprints` puts an active one first); a
// ticket Jira does not return is not in one. Resolves `{ available: true, keys, statuses }` (`keys`
// the subset, sorted; `statuses` a key -> status name object holding only the tickets whose status
// Jira reported), or `{ available: false, reason, keys: [], statuses: {} }` when Jira is not
// configured or a search failed: never a guess for a ticket it could not place.
export const ACTIVE_SPRINT_TTL_MS = 5 * 60 * 1000;
export const ACTIVE_SPRINT_MAX_KEYS = 200;
const ACTIVE_SPRINT_CHUNK = 50;
const activeSprintAnswers = new Map();

export function clearActiveSprintAnswers() {
  activeSprintAnswers.clear();
}

export async function fetchActiveSprintKeys(keys, { snapshot, now = Date.now() } = {}) {
  const cfg = jiraConfig(snapshot);
  if (!cfg) return { available: false, reason: 'jira_not_configured', keys: [], statuses: {} };
  const wanted = [...new Set((Array.isArray(keys) ? keys : []).filter(isTicketKey))]
    .sort()
    .slice(0, ACTIVE_SPRINT_MAX_KEYS);
  const cacheKey = (key) => `${cfg.baseUrl} ${cfg.sprintField} ${key}`;
  const fresh = (key) => {
    const answer = activeSprintAnswers.get(cacheKey(key));
    return answer && now - answer.at < ACTIVE_SPRINT_TTL_MS;
  };
  const missing = wanted.filter((key) => !fresh(key));
  try {
    for (let i = 0; i < missing.length; i += ACTIVE_SPRINT_CHUNK) {
      const chunk = missing.slice(i, i + ACTIVE_SPRINT_CHUNK);
      const { sprints, statuses } = await fetchTicketMetadata(chunk, { snapshot, strict: true });
      for (const key of chunk)
        activeSprintAnswers.set(cacheKey(key), {
          at: now,
          active: sprints[key]?.state === 'active',
          status: statuses[key] ?? null,
        });
    }
  } catch {
    return { available: false, reason: 'jira_unavailable', keys: [], statuses: {} };
  }
  const statuses = {};
  for (const key of wanted) {
    const status = activeSprintAnswers.get(cacheKey(key))?.status;
    if (typeof status === 'string') statuses[key] = status;
  }
  return {
    available: true,
    keys: wanted.filter((key) => activeSprintAnswers.get(cacheKey(key))?.active),
    statuses,
  };
}

// Exact Jira status names the two PR-list filters match against (see
// github.mjs's filterPrsByTicketStatus) — same literal-constant convention as
// UAT_PROMOTE_STATUS further down this file.
export const CODE_REVIEW_STATUS = 'Code Review';
export const READY_FOR_CODE_REVIEW_STATUS = 'Ready For Code Review';

// ── My tickets (assignee = currentUser()) ────────────────────────────
// JQL + mapping + grouping for the "My Tickets" view (UI tab, /api/my-tickets,
// CLI `my-tickets`). Unlike fetchTicketStatuses (which must never break PRs),
// fetchMyTickets throws on missing credentials so the server can answer 401
// and the UI/CLI can render a "Jira not configured" state.

// Sprint is a Greenhopper custom field, so its id is instance-specific
// (customfield_10020 on pathwise.atlassian.net). Override per-instance with
// JIRA_SPRINT_FIELD rather than editing this file; an id that does not exist
// simply comes back absent, which degrades to "no sprint" everywhere.
export const SPRINT_FIELD = (process.env.JIRA_SPRINT_FIELD || 'customfield_10020').trim();

// Story points is likewise per-instance. Note this instance uses
// customfield_10058 ("Story Points") and leaves the Jira Cloud default
// customfield_10016 ("Story point estimate") empty on every issue, so the
// common default would silently produce an all-zero bar. Override with
// JIRA_POINTS_FIELD; an id that does not exist simply comes back absent,
// which degrades to "unestimated" everywhere rather than to zero.
export const POINTS_FIELD = (process.env.JIRA_POINTS_FIELD || 'customfield_10058').trim();
// Joined by filter, not by template: JIRA_POINTS_FIELD= (set but empty) would
// otherwise emit a trailing comma and Jira 400s the whole query.
export const MY_TICKETS_FIELDS = [
  'summary',
  'status',
  'priority',
  'issuetype',
  'updated',
  'created',
  SPRINT_FIELD,
  POINTS_FIELD,
]
  .filter(Boolean)
  .join(',');
export const MY_TICKETS_PAGE_SIZE = 50;
export const MY_TICKETS_MAX_ISSUES = 200;

// Ordered by recency, not by status. Nothing downstream consumes this order —
// groupTicketsByStatus re-sorts every group — so the ORDER BY only decides
// which tickets fall off the MY_TICKETS_MAX_ISSUES cap. Sorting by status name
// dropped them alphabetically, i.e. To Do first (Done < In Progress < To Do),
// which biased every derived total toward "finished". Stalest-first is the
// honest direction to lose tickets in.
export function buildMyTicketsJql({ includeDone = false } = {}) {
  const base = 'assignee = currentUser()';
  const scope = includeDone ? '' : ' AND statusCategory != Done';
  return `${base}${scope} ORDER BY updated DESC`;
}

export function buildReviewTicketsJql() {
  return `assignee IS NOT EMPTY AND assignee != currentUser() AND status = "${READY_FOR_CODE_REVIEW_STATUS}" ORDER BY updated DESC`;
}

export async function fetchReviewReadyTickets({ snapshot } = {}) {
  const cfg = jiraConfig(snapshot);
  if (!cfg) throw new Error('Jira is not configured.');
  const tickets = new Map();
  const cursors = new Set();
  let nextPageToken = null;
  for (;;) {
    const url = new URL(`${cfg.baseUrl}/rest/api/3/search/jql`);
    url.searchParams.set('jql', buildReviewTicketsJql());
    url.searchParams.set(
      'fields',
      ['summary', 'status', 'priority', 'assignee', 'updated', 'created', cfg.sprintField]
        .filter(Boolean)
        .join(','),
    );
    url.searchParams.set('maxResults', String(MY_TICKETS_PAGE_SIZE));
    if (nextPageToken) url.searchParams.set('nextPageToken', nextPageToken);
    const res = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: authorization(cfg.email, cfg.token),
      },
    });
    if (!res.ok) throw new Error('Jira review search failed.');
    const data = await res.json();
    if (!Array.isArray(data?.issues) || typeof data.isLast !== 'boolean')
      throw new Error('Invalid Jira review pagination.');
    for (const issue of data.issues) {
      const ticket = mapTicketIssue(issue, cfg);
      if (!ticket || !ticket.key.trim()) throw new Error('Invalid Jira review ticket.');
      const assignee = issue.fields?.assignee?.displayName;
      ticket.assignee = typeof assignee === 'string' ? assignee.trim() || null : null;
      if (!tickets.has(ticket.key)) tickets.set(ticket.key, ticket);
    }
    if (data.isLast) {
      if (data.nextPageToken) throw new Error('Invalid Jira review pagination.');
      return [...tickets.values()];
    }
    const cursor = data.nextPageToken;
    if (typeof cursor !== 'string' || !cursor.trim() || cursors.has(cursor) || !data.issues.length)
      throw new Error('Invalid Jira review pagination.');
    cursors.add(cursor);
    nextPageToken = cursor;
  }
}

// ── Promote-to-UAT tickets (assignee = currentUser(), status = literal) ──
// Feeds the "PR merge candidates to ops/development" section: tickets the
// current user owns that have reached the Promote-to-UAT gate, cross-referenced
// against open PRs elsewhere. Fetch/mapping mirrors fetchMyTickets exactly —
// same config/auth helpers, same unconfigured-throw behavior, single page,
// capped well above what one assignee in one status could ever produce.
export const UAT_PROMOTE_STATUS = 'Promote to UAT';
export const UAT_PROMOTE_FIELDS = 'summary,status';
export const UAT_PROMOTE_MAX_ISSUES = 100;

export function buildUatPromoteJql() {
  return `assignee = currentUser() AND status = "${UAT_PROMOTE_STATUS}" ORDER BY updated DESC`;
}

export async function fetchUatPromoteTickets({ snapshot } = {}) {
  const cfg = jiraConfig(snapshot);
  if (!cfg) {
    throw new Error('no JIRA_BASE_URL, JIRA_EMAIL, or JIRA_TOKEN in environment — will not prompt');
  }
  const url = new URL(`${cfg.baseUrl}/rest/api/3/search/jql`);
  url.searchParams.set('jql', buildUatPromoteJql());
  url.searchParams.set('fields', [UAT_PROMOTE_FIELDS, cfg.sprintField].filter(Boolean).join(','));
  url.searchParams.set('maxResults', String(UAT_PROMOTE_MAX_ISSUES));
  const res = await fetch(url, {
    redirect: 'error',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: authorization(cfg.email, cfg.token),
    },
  });
  if (!res.ok) {
    throw new Error(`jira search failed: ${res.status}`);
  }
  const data = await res.json();
  const tickets = [];
  for (const issue of data.issues || []) {
    if (!issue || typeof issue !== 'object' || typeof issue.key !== 'string') continue;
    const fields = issue.fields || {};
    tickets.push({
      key: issue.key,
      summary: typeof fields.summary === 'string' ? fields.summary : '',
      status: fields.status?.name ?? null,
      sprint: mapSprints(fields[cfg.sprintField])[0] || null,
    });
  }
  return tickets;
}

export function isJiraConfigured({ snapshot } = {}) {
  return jiraConfig(snapshot) !== null;
}

// Jira returns the sprint custom field as an array of expanded sprint objects
// (a ticket carried across sprints lists every one it has been in), and as
// null/absent when the ticket is in no sprint or the field id is wrong. Order
// active -> future -> closed, then latest end date first, so the head of the
// list is the sprint worth showing.
const SPRINT_STATE_ORDER = { active: 0, future: 1, closed: 2 };

export function mapSprints(raw) {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  const mapped = [];
  for (const s of list) {
    if (!s || typeof s !== 'object' || typeof s.name !== 'string' || !s.name) continue;
    mapped.push({
      id: s.id ?? null,
      name: s.name,
      state: typeof s.state === 'string' ? s.state : 'unknown',
      startDate: typeof s.startDate === 'string' ? s.startDate || null : null,
      endDate: typeof s.endDate === 'string' ? s.endDate || null : null,
    });
  }
  const rank = (s) => SPRINT_STATE_ORDER[s.state] ?? 3;
  const endsAt = (s) => {
    const t = Date.parse(s.endDate);
    return Number.isFinite(t) ? t : 0;
  };
  mapped.sort((a, b) => rank(a) - rank(b) || endsAt(b) - endsAt(a));
  return mapped;
}

// The sprints of every ticket, deduped by id, keeping only the ones Jira calls
// active — i.e. the sprint(s) you are actually working right now. A single user
// can legitimately span several (one per board).
export function activeSprints(tickets) {
  const byId = new Map();
  for (const t of tickets || []) {
    for (const s of t?.sprints || []) {
      if (s.state !== 'active') continue;
      const key = s.id ?? s.name;
      if (!byId.has(key)) byId.set(key, s);
    }
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// null, not 0, when the field is absent, non-numeric or negative: "nobody
// estimated this" and "estimated at zero" must stay distinguishable, and a
// string here means the configured field id is wrong rather than that the
// ticket is worth "3".
export function storyPointsOf(raw) {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null;
}

function mapTicketIssue(issue, cfg) {
  if (!issue || typeof issue !== 'object' || typeof issue.key !== 'string') return null;
  const fields = issue.fields || {};
  const status = fields.status || {};
  const sprints = mapSprints(fields[cfg.sprintField]);
  return {
    key: issue.key,
    summary: typeof fields.summary === 'string' ? fields.summary : '',
    status: typeof status.name === 'string' ? status.name : 'Unknown',
    statusCategory: status.statusCategory?.name || 'Unknown',
    issueType: fields.issuetype?.name || null,
    priority: fields.priority?.name || null,
    updated: fields.updated || null,
    created: fields.created || null,
    // sprints is every sprint the ticket has been in (sorted); sprint is the
    // one to show — active, else the upcoming one, else the last it was in.
    sprints,
    sprint: sprints[0] || null,
    storyPoints: storyPointsOf(fields[cfg.pointsField]),
  };
}

// Group tickets by statusCategory (fixed To Do → In Progress → Done order,
// unknown categories alphabetical after), each group sorted by status name
// ASC then updated DESC. Also returns a flat groupsByStatus map (status name
// ASC) so callers can render sub-headers without re-sorting.
export function groupTicketsByStatus(tickets) {
  const CATEGORY_ORDER = ['To Do', 'In Progress', 'Done'];
  const byCategory = {};
  const byStatus = {};
  for (const t of tickets || []) {
    if (!t || !t.key) continue;
    const cat = t.statusCategory || 'Unknown';
    const st = t.status || 'Unknown';
    (byCategory[cat] ||= []).push(t);
    (byStatus[st] ||= []).push(t);
  }
  const byUpdatedDesc = (a, b) => {
    const ta = Date.parse(a.updated);
    const tb = Date.parse(b.updated);
    const na = Number.isFinite(ta) ? ta : 0;
    const nb = Number.isFinite(tb) ? tb : 0;
    return nb - na;
  };
  for (const list of Object.values(byCategory)) {
    list.sort((a, b) => String(a.status).localeCompare(String(b.status)) || byUpdatedDesc(a, b));
  }
  for (const list of Object.values(byStatus)) {
    list.sort(byUpdatedDesc);
  }
  const orderedCategory = {};
  for (const c of CATEGORY_ORDER) {
    if (byCategory[c]) orderedCategory[c] = byCategory[c];
  }
  for (const c of Object.keys(byCategory).sort((a, b) => a.localeCompare(b))) {
    if (!orderedCategory[c]) orderedCategory[c] = byCategory[c];
  }
  const orderedStatus = {};
  for (const s of Object.keys(byStatus).sort((a, b) => a.localeCompare(b))) {
    orderedStatus[s] = byStatus[s];
  }
  return { groupsByCategory: orderedCategory, groupsByStatus: orderedStatus };
}

export async function fetchMyTickets({ includeDone = false, snapshot } = {}) {
  const cfg = jiraConfig(snapshot);
  if (!cfg) {
    throw new Error('no JIRA_BASE_URL, JIRA_EMAIL, or JIRA_TOKEN in environment — will not prompt');
  }
  const jql = buildMyTicketsJql({ includeDone });
  const { items: tickets, truncated } = await collectCappedJiraIssues({
    maxIssues: MY_TICKETS_MAX_ISSUES,
    mapIssue: (issue) => mapTicketIssue(issue, cfg),
    fetchPage: async (nextPageToken) => {
      const url = new URL(`${cfg.baseUrl}/rest/api/3/search/jql`);
      url.searchParams.set('jql', jql);
      url.searchParams.set(
        'fields',
        [
          'summary',
          'status',
          'priority',
          'issuetype',
          'updated',
          'created',
          cfg.sprintField,
          cfg.pointsField,
        ]
          .filter(Boolean)
          .join(','),
      );
      url.searchParams.set('maxResults', String(MY_TICKETS_PAGE_SIZE));
      if (nextPageToken) url.searchParams.set('nextPageToken', nextPageToken);
      const res = await fetch(url, {
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: authorization(cfg.email, cfg.token),
        },
      });
      if (!res.ok) {
        throw new Error(`jira search failed: ${res.status}`);
      }
      return res.json();
    },
  });
  const { groupsByCategory, groupsByStatus } = groupTicketsByStatus(tickets);
  return {
    total: tickets.length,
    // True when the MY_TICKETS_MAX_ISSUES cap left tickets unfetched. Every
    // derived total is then a floor, not a total — the UI has to say so rather
    // than report a confidently wrong number.
    truncated,
    tickets,
    groupsByCategory,
    groupsByStatus,
    activeSprints: activeSprints(tickets),
    allSprints: allSprints(tickets),
    includeDone: !!includeDone,
  };
}
