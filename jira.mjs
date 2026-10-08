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

export async function fetchTicketMetadata(keys, { snapshot } = {}) {
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
    if (!res.ok) return empty;
    const data = await res.json();

    const statuses = {};
    const sprints = {};
    for (const issue of data.issues || []) {
      statuses[issue.key] = issue.fields?.status?.name ?? null;
      sprints[issue.key] = mapSprints(issue.fields?.[cfg.sprintField])[0] || null;
    }
    return { statuses, sprints };
  } catch {
    return empty;
  }
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

// Every sprint found on the fetched tickets, deduped by id — the selector
// source for Home's Sprint block. Active first (name A→Z, same order as
// activeSprints), then future nearest-first, then closed most-recent-first so
// "previous sprint" is the head of the closed run. Unknown states sort last.
export function allSprints(tickets) {
  const byId = new Map();
  for (const t of tickets || []) {
    for (const s of t?.sprints || []) {
      if (!s || typeof s.name !== 'string' || !s.name) continue;
      const key = s.id ?? s.name;
      if (!byId.has(key)) byId.set(key, s);
    }
  }
  const endsAt = (s) => {
    const t = Date.parse(s.endDate);
    return Number.isFinite(t) ? t : 0;
  };
  return [...byId.values()].sort((a, b) => {
    const ra = SPRINT_STATE_ORDER[a.state] ?? 3;
    const rb = SPRINT_STATE_ORDER[b.state] ?? 3;
    if (ra !== rb) return ra - rb;
    if (a.state === 'future' || b.state === 'future') {
      // Nearest upcoming first; missing dates sort last within the group.
      const ea = endsAt(a) || Number.MAX_SAFE_INTEGER;
      const eb = endsAt(b) || Number.MAX_SAFE_INTEGER;
      if (ea !== eb) return ea - eb;
    } else if (endsAt(a) !== endsAt(b)) {
      return endsAt(b) - endsAt(a);
    }
    return String(a.name).localeCompare(String(b.name));
  });
}

// null, not 0, when the field is absent, non-numeric or negative: "nobody
// estimated this" and "estimated at zero" must stay distinguishable, and a
// string here means the configured field id is wrong rather than that the
// ticket is worth "3".
function storyPointsOf(raw) {
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
  const tickets = [];
  let truncated = false;
  let nextPageToken = null;
  for (;;) {
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
    const data = await res.json();
    const issues = data.issues || [];
    for (const [i, issue] of issues.entries()) {
      const mapped = mapTicketIssue(issue, cfg);
      if (mapped) tickets.push(mapped);
      if (tickets.length >= MY_TICKETS_MAX_ISSUES) {
        // Only a real truncation if something was actually left behind —
        // exactly MY_TICKETS_MAX_ISSUES matching issues is a complete answer.
        truncated = i < issues.length - 1 || !(data.isLast || !data.nextPageToken);
        break;
      }
    }
    if (tickets.length >= MY_TICKETS_MAX_ISSUES) break;
    if (data.isLast || !data.nextPageToken) break;
    nextPageToken = data.nextPageToken;
  }
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
