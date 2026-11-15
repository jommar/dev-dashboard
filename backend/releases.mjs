// releases.mjs — Jira fix-version tickets with the merge state of their GitHub
// PRs, read from Jira alone: project versions, a JQL search, and the dev-status
// summary/detail endpoints. GitHub is queried only to resolve linked PR authors;
// "merged" is still Jira's copy of GitHub's state and can lag a fresh merge.
import { jiraConfig } from './jira.mjs';
import { jiraGet, lookUpPullRequests, resetPullRequestCaches } from './dev-status.mjs';
import { collectCappedJiraIssues } from './jira-search.mjs';
import { fetchPrOwners } from './github.mjs';
import {
  orderVersions,
  defaultVersionId,
  resolveVersion,
  resolveVersionByName,
  buildReleaseTicketsJql,
  ownsPr,
  classifyPr,
  rollUpTicket,
} from './release-model.mjs';

export { parseReleasesArgs, formatReleaseText } from './release-model.mjs';

// Per-instance like SPRINT_FIELD; checked when a request runs, not at import,
// so a bad value cannot stop the server or every module that imports it.
export const RELEASES_PROJECT_KEY = (process.env.JIRA_RELEASES_PROJECT || 'TAP').trim();
const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const SEARCH_PAGE_SIZE = 50;
const MAX_TICKETS = 100;
const PR_CACHE_TTL_MS = 60_000;
const SEARCH_FIELDS = 'summary,status,priority,issuetype,updated,assignee';

export function resetReleaseCaches() {
  resetPullRequestCaches();
}

function projectKey() {
  if (!PROJECT_KEY_PATTERN.test(RELEASES_PROJECT_KEY))
    throw new Error('JIRA_RELEASES_PROJECT is not a valid Jira project key');
  return RELEASES_PROJECT_KEY;
}

// Same paging and cap rules as fetchMyTickets: exactly MAX_TICKETS matches is a
// complete answer, one more is a truncation.
async function fetchTicketIssues(cfg, jql) {
  const { items: issues, truncated } = await collectCappedJiraIssues({
    maxIssues: MAX_TICKETS,
    mapIssue: (issue) => (issue && typeof issue.key === 'string' ? issue : null),
    fetchPage: (nextPageToken) => {
      const url = new URL(`${cfg.baseUrl}/rest/api/3/search/jql`);
      url.searchParams.set('jql', jql);
      url.searchParams.set('fields', SEARCH_FIELDS);
      url.searchParams.set('maxResults', String(SEARCH_PAGE_SIZE));
      if (nextPageToken) url.searchParams.set('nextPageToken', nextPageToken);
      return jiraGet(cfg, url, 'search');
    },
  });
  return { issues, truncated };
}

const keyParts = (key) => {
  const [, prefix = key, number = '0'] = /^(.*)-(\d+)$/.exec(key) || [];
  return [prefix, Number(number)];
};

const byTicketKey = (a, b) => {
  const [prefixA, numberA] = keyParts(a.ticket.key);
  const [prefixB, numberB] = keyParts(b.ticket.key);
  return prefixA === prefixB ? numberA - numberB : prefixA < prefixB ? -1 : 1;
};

function mapTicket(issue) {
  const fields = issue.fields || {};
  return {
    key: issue.key,
    summary: typeof fields.summary === 'string' ? fields.summary : '',
    status: fields.status?.name ?? null,
    issueType: fields.issuetype?.name ?? null,
    priority: fields.priority?.name ?? null,
    assignee: fields.assignee?.displayName ?? null,
    updated: fields.updated ?? null,
  };
}

function chooseVersion(versions, { versionId, versionName }) {
  if (versionName != null) return resolveVersionByName(versionName, versions);
  const id = versionId ?? defaultVersionId(versions);
  return id === null ? null : resolveVersion(id, versions);
}

export async function fetchRelease({
  versionId,
  versionName,
  mine = true,
  refresh = false,
  snapshot,
} = {}) {
  const cfg = jiraConfig(snapshot);
  if (!cfg) throw new Error('Jira is not configured in Settings.');
  const versionsUrl = new URL(
    `${cfg.baseUrl}/rest/api/3/project/${encodeURIComponent(projectKey())}/versions`,
  );
  const versions = orderVersions(await jiraGet(cfg, versionsUrl, 'versions'));
  const scope = mine ? 'mine' : 'all';
  const chosen = chooseVersion(versions, { versionId, versionName });
  if (!chosen) return { versions, version: null, scope, total: 0, truncated: false, tickets: [] };
  const { issues, truncated } = await fetchTicketIssues(
    cfg,
    buildReleaseTicketsJql({ versionId: chosen.id, mine }),
  );
  const entries = issues
    .map((issue) => ({
      issueId: /^\d+$/.test(String(issue.id)) ? String(issue.id) : null,
      ticket: mapTicket(issue),
    }))
    .sort(byTicketKey);
  const outcomes = await lookUpPullRequests(cfg, entries, { refresh, ttlMs: PR_CACHE_TTL_MS });
  const tickets = entries.map((entry) => {
    const { prs: linked = [], error } = outcomes.get(entry);
    const prs = linked
      .filter((pr) => ownsPr(entry.ticket.key, { name: pr.title, source: { branch: pr.head } }))
      .map((pr) => ({ ...pr, countsAsMerged: classifyPr(pr) }));
    return {
      ...entry.ticket,
      mergeState: rollUpTicket(prs, error ? 'unavailable' : 'ok'),
      prsStatus: error ? 'unavailable' : 'ok',
      ...(error ? { prsError: error } : {}),
      prs,
    };
  });
  const owners = await fetchPrOwners(
    tickets.flatMap((ticket) => ticket.prs),
    { snapshot },
  );
  for (const ticket of tickets) {
    ticket.prs = ticket.prs.map((pr) => ({
      ...pr,
      owner: owners[`${pr.repo}#${pr.number}`] ?? null,
    }));
  }
  return {
    versions,
    version: {
      id: chosen.id,
      name: chosen.name,
      released: chosen.released,
      releaseDate: chosen.releaseDate,
    },
    scope,
    total: tickets.length,
    truncated,
    tickets,
  };
}
