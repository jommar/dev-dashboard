// dev-status.mjs — the one Jira dev-status lookup: a ticket's linked pull requests
// (summary -> instance key, then detail). Releases and My Tickets both read it;
// the cache holds every linked PR, so each caller applies its own filter.
import { authorization } from './jira.mjs';
import { upstreamFetch, upstreamError } from './upstream.mjs';
import { normalizeDevStatusPr } from './release-model.mjs';

const CALL_TIMEOUT_MS = 15_000;
const DEV_STATUS_CONCURRENCY = 4;
const MAX_DISCOVERY_FAILURES = 3;
const INSTANCE_KEY_PATTERN = /^[\w.-]+$/;

// Dev-status needs the full instance key ("applicationType=GitHub" answers 200
// with nothing), so it is read from a summary and remembered per Jira origin.
const instanceKeys = new Map();
// Successful per-ticket lookups only, so a Jira hiccup is retried on the next
// load instead of being served for a minute. Keyed by origin and issue id so a
// Settings change cannot reuse another instance's answers.
const lookupCache = new Map();

export function resetPullRequestCaches() {
  instanceKeys.clear();
  lookupCache.clear();
}

const cacheKey = (cfg, issueId) => `${cfg.baseUrl} ${issueId}`;

function readCachedPullRequests(cfg, issueId, ttlMs) {
  const cached = lookupCache.get(cacheKey(cfg, issueId));
  if (!cached || Date.now() - cached.storedAt >= ttlMs) return null;
  return cached.prs;
}

export async function jiraGet(cfg, url, label) {
  const res = await upstreamFetch('jira', url, {
    redirect: 'error',
    headers: { Accept: 'application/json', Authorization: authorization(cfg.email, cfg.token) },
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!res.ok) throw upstreamError('jira', res, `jira ${label} failed: ${res.status}`);
  return res.json();
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

// Every linked PR, normalized and deduped; ownership is the caller's call.
function linkedPullRequests(rawPullRequests) {
  const seen = new Set();
  const prs = [];
  for (const raw of rawPullRequests) {
    if (!raw || typeof raw !== 'object') continue;
    const pr = normalizeDevStatusPr(raw);
    const identity = pr.url ?? `${pr.repo}#${pr.number}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    prs.push(pr);
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
export async function lookUpPullRequests(cfg, entries, { refresh, ttlMs }) {
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
    const cached = refresh ? null : readCachedPullRequests(cfg, entry.issueId, ttlMs);
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
        succeed(entry, linkedPullRequests(probe.raw));
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
        succeed(entry, linkedPullRequests(raw));
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
