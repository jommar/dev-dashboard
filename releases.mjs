// releases.mjs — Jira fix-version tickets with the merge state of their GitHub
// PRs, read from Jira alone: project versions, a JQL search, and the dev-status
// summary/detail endpoints. No GitHub call is made, so "merged" is Jira's copy of
// GitHub's state and can lag a fresh merge.
import { jiraConfig, authorization } from './jira.mjs';
import {
  orderVersions,
  defaultVersionId,
  resolveVersion,
  resolveVersionByName,
  buildReleaseTicketsJql,
  ownsPr,
  normalizeDevStatusPr,
  classifyPr,
  rollUpTicket,
} from './release-model.mjs';

export { parseReleasesArgs, formatReleaseText } from './release-model.mjs';

// Per-instance like SPRINT_FIELD; checked when a request runs, not at import,
// so a bad value cannot stop the server or every module that imports it.
export const RELEASES_PROJECT_KEY = (process.env.JIRA_RELEASES_PROJECT || 'TRIPS').trim();
const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const CALL_TIMEOUT_MS = 15_000;
const SEARCH_PAGE_SIZE = 50;
const MAX_TICKETS = 100;
const DEV_STATUS_CONCURRENCY = 4;
const MAX_DISCOVERY_FAILURES = 3;
const PR_CACHE_TTL_MS = 60_000;
const SEARCH_FIELDS = 'summary,status,priority,issuetype,updated,assignee';
const INSTANCE_KEY_PATTERN = /^[\w.-]+$/;

// Dev-status needs the full instance key ("applicationType=GitHub" answers 200
// with nothing), so it is read from a summary and remembered per Jira origin.
const instanceKeys = new Map();
// Successful per-ticket lookups only, so a Jira hiccup is retried on the next
// load instead of being served for a minute. Keyed by origin and issue id so a
// Settings change cannot reuse another instance's answers.
const lookupCache = new Map();

export function resetReleaseCaches() {
  instanceKeys.clear();
  lookupCache.clear();
}

const cacheKey = (cfg, issueId) => `${cfg.baseUrl} ${issueId}`;

function readCachedPullRequests(cfg, issueId) {
  const cached = lookupCache.get(cacheKey(cfg, issueId));
  if (!cached) return null;
  if (Date.now() - cached.storedAt >= PR_CACHE_TTL_MS) {
    lookupCache.delete(cacheKey(cfg, issueId));
    return null;
  }
  return cached.prs;
}

async function jiraGet(cfg, url, label) {
  const res = await fetch(url, {
    redirect: 'error',
    headers: { Accept: 'application/json', Authorization: authorization(cfg.email, cfg.token) },
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`jira ${label} failed: ${res.status}`);
  return res.json();
}

function projectKey() {
  if (!PROJECT_KEY_PATTERN.test(RELEASES_PROJECT_KEY))
    throw new Error('JIRA_RELEASES_PROJECT is not a valid Jira project key');
  return RELEASES_PROJECT_KEY;
}

// Same paging and cap rules as fetchMyTickets: exactly MAX_TICKETS matches is a
// complete answer, one more is a truncation.
async function fetchTicketIssues(cfg, jql) {
  const issues = [];
  let truncated = false;
  let nextPageToken = null;
  for (;;) {
    const url = new URL(`${cfg.baseUrl}/rest/api/3/search/jql`);
    url.searchParams.set('jql', jql);
    url.searchParams.set('fields', SEARCH_FIELDS);
    url.searchParams.set('maxResults', String(SEARCH_PAGE_SIZE));
    if (nextPageToken) url.searchParams.set('nextPageToken', nextPageToken);
    const data = await jiraGet(cfg, url, 'search');
    const page = data.issues || [];
    const lastPage = data.isLast || !data.nextPageToken;
    for (const [index, issue] of page.entries()) {
      if (issue && typeof issue.key === 'string') issues.push(issue);
      if (issues.length >= MAX_TICKETS) {
        truncated = index < page.length - 1 || !lastPage;
        break;
      }
    }
    if (issues.length >= MAX_TICKETS || lastPage) return { issues, truncated };
    nextPageToken = data.nextPageToken;
  }
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

async function fetchPullRequestSummary(cfg, issueId) {
  const url = new URL(`${cfg.baseUrl}/rest/dev-status/latest/issue/summary`);
  url.searchParams.set('issueId', issueId);
  const pullrequest = (await jiraGet(cfg, url, 'dev-status summary'))?.summary?.pullrequest;
  const instances = Object.entries(pullrequest?.byInstanceType || {});
  const [instanceKey] =
    instances.find(([, instance]) => instance?.name === 'GitHub') || instances[0] || [];
  return {
    count: Number(pullrequest?.overall?.count) || 0,
    instanceKey: INSTANCE_KEY_PATTERN.test(instanceKey) ? instanceKey : null,
  };
}

async function fetchRawPullRequests(cfg, issueId, instanceKey) {
  const url = new URL(`${cfg.baseUrl}/rest/dev-status/latest/issue/detail`);
  url.searchParams.set('issueId', issueId);
  url.searchParams.set('applicationType', instanceKey);
  url.searchParams.set('dataType', 'pullrequest');
  const data = await jiraGet(cfg, url, 'dev-status detail');
  return (data.detail || []).flatMap((entry) =>
    Array.isArray(entry?.pullRequests) ? entry.pullRequests : [],
  );
}

function ownedPullRequests(ticketKey, rawPullRequests) {
  const seen = new Set();
  const prs = [];
  for (const raw of rawPullRequests) {
    if (!raw || typeof raw !== 'object' || !ownsPr(ticketKey, raw)) continue;
    const pr = normalizeDevStatusPr(raw);
    const identity = pr.url ?? `${pr.repo}#${pr.number}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    prs.push({ ...pr, countsAsMerged: classifyPr(pr) });
  }
  return prs;
}

const failureOf = (error) => (error?.name === 'TimeoutError' ? 'timeout' : 'http');

async function runWithLimit(items, limit, work) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await work(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// One ticket's summary and, when it lists PRs, its detail: enough to learn the
// instance key and to tell "no PRs" from a key that no longer returns any.
async function probeTicket(cfg, entry) {
  const summary = await fetchPullRequestSummary(cfg, entry.issueId);
  if (summary.count === 0) return { prs: [] };
  if (!summary.instanceKey) return { error: 'instance-mismatch' };
  const raw = await fetchRawPullRequests(cfg, entry.issueId, summary.instanceKey);
  return raw.length ? { raw, instanceKey: summary.instanceKey } : { mismatch: true };
}

// Resolves each entry to { prs } or { error }; a failed lookup never spreads to
// its neighbours. Without a trusted instance key, tickets are probed one at a
// time in order until one reveals it, because every later lookup depends on it.
async function lookUpPullRequests(cfg, entries, { refresh }) {
  const outcomes = new Map();
  const fail = (entry, error) => outcomes.set(entry, { error });
  const succeed = (entry, prs) => {
    outcomes.set(entry, { prs });
    lookupCache.set(cacheKey(cfg, entry.issueId), { storedAt: Date.now(), prs });
  };
  const pending = [];
  for (const entry of entries) {
    if (entry.issueId === null) {
      fail(entry, 'http');
      continue;
    }
    const cached = refresh ? null : readCachedPullRequests(cfg, entry.issueId);
    if (cached) outcomes.set(entry, { prs: cached });
    else pending.push(entry);
  }

  // Returns the entries left to look up once a key is revealed; an exhausted or
  // aborted discovery settles every entry itself and returns none.
  const discoverInstanceKey = async (candidates) => {
    let waiting = [...candidates];
    let failures = 0;
    while (waiting.length) {
      const entry = waiting.shift();
      let probe;
      try {
        probe = await probeTicket(cfg, entry);
        failures = 0;
      } catch (error) {
        const failure = failureOf(error);
        fail(entry, failure);
        failures += 1;
        if (failures >= MAX_DISCOVERY_FAILURES) {
          for (const stranded of waiting) fail(stranded, failure);
          waiting = [];
        }
        continue;
      }
      if (probe.mismatch) {
        for (const stranded of [entry, ...waiting]) fail(stranded, 'instance-mismatch');
        waiting = [];
      } else if (probe.instanceKey) {
        instanceKeys.set(cfg.baseUrl, probe.instanceKey);
        succeed(entry, ownedPullRequests(entry.ticket.key, probe.raw));
        return waiting;
      } else if (probe.error) {
        fail(entry, probe.error);
      } else {
        succeed(entry, probe.prs);
      }
    }
    return [];
  };

  const lookUpWithKey = async (waiting, instanceKey) => {
    const empties = [];
    let foundPrs = false;
    await runWithLimit(waiting, DEV_STATUS_CONCURRENCY, async (entry) => {
      try {
        const raw = await fetchRawPullRequests(cfg, entry.issueId, instanceKey);
        if (!raw.length) {
          empties.push(entry);
          return;
        }
        foundPrs = true;
        succeed(entry, ownedPullRequests(entry.ticket.key, raw));
      } catch (error) {
        fail(entry, failureOf(error));
      }
    });
    return { empties, foundPrs };
  };

  const cachedKey = instanceKeys.get(cfg.baseUrl);
  if (!cachedKey) {
    const waiting = await discoverInstanceKey(pending);
    const { empties } = await lookUpWithKey(waiting, instanceKeys.get(cfg.baseUrl));
    for (const entry of empties) succeed(entry, []);
    return outcomes;
  }
  const { empties, foundPrs } = await lookUpWithKey(pending, cachedKey);
  if (foundPrs || !empties.length) {
    for (const entry of empties) succeed(entry, []);
    return outcomes;
  }
  // Every detail came back empty under a remembered key: Jira may have changed
  // the instance key, so ask the summaries before trusting "no PRs".
  instanceKeys.delete(cfg.baseUrl);
  const waiting = await discoverInstanceKey(empties);
  const rediscovered = instanceKeys.get(cfg.baseUrl);
  if (rediscovered) {
    for (const entry of (await lookUpWithKey(waiting, rediscovered)).empties) succeed(entry, []);
  }
  return outcomes;
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
  const outcomes = await lookUpPullRequests(cfg, entries, { refresh });
  const tickets = entries.map((entry) => {
    const { prs = [], error } = outcomes.get(entry);
    return {
      ...entry.ticket,
      mergeState: rollUpTicket(prs, error ? 'unavailable' : 'ok'),
      prsStatus: error ? 'unavailable' : 'ok',
      ...(error ? { prsError: error } : {}),
      prs,
    };
  });
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
