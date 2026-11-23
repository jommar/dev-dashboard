// release-scripts.mjs — hybrid GitHub GraphQL + selective REST detection of runnable scripts,
// Knex database migrations, and Portage-backend Prisma schema edits across linked release PRs.
// Never throws upstream failures to the board; degrades to `{ available: false }` or partial data.
import { captureConfiguration } from './settings.mjs';
import { headers, postGraphql, pullRequestQuery } from './github-api.mjs';
import { classifyResponse, upstreamFetch } from './upstream.mjs';
import { runWithLimit } from './jira-search.mjs';

const GRAPHQL_BATCH_SIZE = 50;
const REST_CONCURRENCY = 4;
const REST_FILES_PER_PAGE = 100;
const MERGED_TTL_MS = 30 * 60_000;
const OPEN_TTL_MS = 5 * 60_000;
const CACHE_LIMIT = 500;

const PACKAGE_JSON = /(?:^|\/)package\.json$/;
const KNEX_MIGRATION = /^setup\/knex\/migrations\/(?:admin\/)?[^/]+\.js$/i;
const PRISMA_MIGRATION = /^prisma\/migrations\/.+/;
const TRACKER_SCRIPT = /^setup\/scripts\/.+\.(?:js|mjs|cjs|sh)$/i;
const TRACKER_SCRIPT_LIB = /(?:^|\/)lib\//i;
const FRONTEND_SCRIPT = /^scripts\/.+/;
const PRISMA_SCHEMA = /^libs\/client\/prisma\/.+\.prisma$/i;

const prCache = new Map();
const inFlight = new Map();

export function resetReleaseScriptsCache() {
  prCache.clear();
  inFlight.clear();
}

function baseName(filePath) {
  const index = filePath.lastIndexOf('/');
  return index >= 0 ? filePath.slice(index + 1) : filePath;
}

function repoShortName(repo) {
  const index = typeof repo === 'string' ? repo.indexOf('/') : -1;
  return index >= 0 ? repo.slice(index + 1) : String(repo || '');
}

function isDeleted(file) {
  return String(file?.changeType || '').toUpperCase() === 'DELETED';
}

function isPackageJson(filePath) {
  return typeof filePath === 'string' && PACKAGE_JSON.test(filePath);
}

// Classifies a PR's changed file paths (from GraphQL `files.nodes`) into direct signals.
// Ignores `DELETED` files and shared `lib/` helpers under `TravelTracker/setup/scripts/`.
export function detectPrFileSignals(repo, files) {
  const name = repoShortName(repo);
  const signals = [];
  for (const file of files || []) {
    if (!file || typeof file.path !== 'string' || !file.path || isDeleted(file)) continue;
    const filePath = file.path.replace(/^\.?\//, '');
    if (
      (name === 'TravelTracker' && KNEX_MIGRATION.test(filePath)) ||
      (name === 'Portage-backend' && PRISMA_MIGRATION.test(filePath))
    ) {
      signals.push({ kind: 'migration', label: baseName(filePath), path: filePath });
    } else if (
      name === 'TravelTracker' &&
      TRACKER_SCRIPT.test(filePath) &&
      !TRACKER_SCRIPT_LIB.test(filePath.slice('setup/scripts/'.length))
    ) {
      signals.push({ kind: 'script', label: baseName(filePath), path: filePath });
    } else if (name === 'Portage-frontend' && FRONTEND_SCRIPT.test(filePath)) {
      signals.push({ kind: 'script', label: baseName(filePath), path: filePath });
    } else if (name === 'Portage-backend' && PRISMA_SCHEMA.test(filePath)) {
      signals.push({ kind: 'prisma-schema', label: baseName(filePath), path: filePath });
    }
  }
  return signals;
}

// Counts `{` and `}` outside quoted JSON string literals on a single line.
function braceDelta(line) {
  let delta = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') delta += 1;
    else if (ch === '}') delta -= 1;
  }
  return delta;
}

function scriptEntry(line) {
  const match = /^\s*"([^"]+)"\s*:\s*(.*)$/.exec(line);
  if (!match) return null;
  const value = match[2].trim().replace(/,$/, '').trim();
  return { name: match[1], key: `${match[1]}\0${value}` };
}

// Extracts added or modified `"scripts"` entry names from a unified diff of `package.json`.
// Ignores dependency/version/other-section edits, removed lines, and comma-only rewrites.
export function parsePackageScriptsPatch(patch) {
  if (typeof patch !== 'string' || !patch) return [];
  const names = [];
  const seen = new Set();
  const removed = new Set();
  let inScripts = false;
  let depth = 0;

  for (const raw of patch.split('\n')) {
    if (raw.startsWith('@@')) {
      inScripts = /"scripts"\s*:\s*\{/.test(raw);
      depth = inScripts ? 1 : 0;
      removed.clear();
      continue;
    }
    if (raw.startsWith('+++') || raw.startsWith('---')) continue;
    const prefix = raw[0];
    const line = prefix === '+' || prefix === '-' || prefix === ' ' ? raw.slice(1) : raw;

    if (!inScripts) {
      if (prefix !== '-' && /^\s*"scripts"\s*:\s*\{/.test(line)) {
        const delta = braceDelta(line);
        if (delta > 0) {
          inScripts = true;
          depth = delta;
          removed.clear();
        }
      }
      continue;
    }

    if (prefix === '-' && depth === 1) {
      const entry = scriptEntry(line);
      if (entry) removed.add(entry.key);
    } else if (prefix === '+' && depth === 1) {
      const entry = scriptEntry(line);
      if (entry && !removed.has(entry.key) && !seen.has(entry.name)) {
        seen.add(entry.name);
        names.push(entry.name);
      }
    }

    if (prefix !== '-') {
      depth += braceDelta(line);
      if (depth <= 0) {
        inScripts = false;
        depth = 0;
        removed.clear();
      }
    }
  }
  return names;
}

function cacheKey(api, pr) {
  return `${api}|${pr.repo}#${pr.number}`;
}

function flightKeyOf(key, pr) {
  return `${key}|${pr.state ?? ''}|${pr.updatedAt ?? ''}`;
}

function readCached(key, pr, nowMs) {
  const entry = prCache.get(key);
  if (!entry) return null;
  if (entry.state !== (pr.state ?? null)) {
    prCache.delete(key);
    return null;
  }
  const ttl = pr.state === 'merged' ? MERGED_TTL_MS : OPEN_TTL_MS;
  if (nowMs - entry.cachedAt >= ttl) {
    prCache.delete(key);
    return null;
  }
  if (pr.state !== 'merged' && entry.updatedAt !== (pr.updatedAt ?? null)) {
    prCache.delete(key);
    return null;
  }
  return entry;
}

function writeCached(key, pr, signals, truncated, nowMs) {
  if (prCache.has(key)) prCache.delete(key);
  else if (prCache.size >= CACHE_LIMIT) prCache.delete(prCache.keys().next().value);
  prCache.set(key, {
    signals,
    truncated,
    cachedAt: nowMs,
    updatedAt: pr.updatedAt ?? null,
    state: pr.state ?? null,
  });
}

async function fetchPackageScripts(captured, pr, nowMs) {
  const [owner, repoName] = pr.repo.split('/');
  const url = `${captured.github.api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/pulls/${pr.number}/files?per_page=${REST_FILES_PER_PAGE}`;
  const res = await upstreamFetch('github', url, {
    headers: headers(captured.credentials.githubToken),
    redirect: 'error',
  });
  if (!res.ok) {
    const { kind } = classifyResponse(res.status, res.headers, nowMs);
    return { ok: false, stop: kind === 'rate_limit' || kind === 'auth', signals: [] };
  }
  const files = await res.json();
  if (!Array.isArray(files)) return { ok: false, stop: false, signals: [] };
  const signals = [];
  for (const file of files) {
    if (!file || file.status === 'removed' || !isPackageJson(file.filename)) continue;
    for (const scriptName of parsePackageScriptsPatch(file.patch)) {
      signals.push({
        kind: 'script',
        label: `npm run ${scriptName}`,
        path: file.filename,
        repo: pr.repo,
        prNumber: pr.number,
      });
    }
  }
  return { ok: true, stop: false, truncated: files.length >= REST_FILES_PER_PAGE, signals };
}

function createDeferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  let settled = false;
  return {
    promise,
    settle(value) {
      if (settled) return;
      settled = true;
      resolve(value);
    },
  };
}

function withPrMeta(signals, pr) {
  return signals.map((signal) => ({ ...signal, repo: pr.repo, prNumber: pr.number }));
}

export async function fetchReleaseScripts(prs, { snapshot, now = () => Date.now() } = {}) {
  const captured = captureConfiguration(snapshot);
  const nowMs = now();
  const updatedAt = new Date(nowMs).toISOString();

  if (!captured.credentials.githubToken) {
    return { available: false, reason: 'unconfigured', truncated: false, byTicket: {}, updatedAt };
  }

  const list = Array.isArray(prs) ? prs : [];
  if (!list.length) {
    return { available: true, truncated: false, byTicket: {}, updatedAt };
  }

  // Deduplicate PRs while keeping ticket -> prKeys association.
  const uniquePrs = new Map();
  const ticketPrKeys = new Map();
  for (const item of list) {
    if (!item || typeof item.repo !== 'string' || !Number.isSafeInteger(item.number)) continue;
    const id = `${item.repo}#${item.number}`;
    if (!uniquePrs.has(id)) uniquePrs.set(id, item);
    if (typeof item.ticket === 'string' && item.ticket) {
      if (!ticketPrKeys.has(item.ticket)) ticketPrKeys.set(item.ticket, new Set());
      ticketPrKeys.get(item.ticket).add(id);
    }
  }

  const signalsByPr = new Map();
  const uncached = [];
  const awaited = [];
  let truncated = false;
  let anySucceeded = false;

  for (const [id, pr] of uniquePrs.entries()) {
    const key = cacheKey(captured.github.api, pr);
    const cached = readCached(key, pr, nowMs);
    if (cached) {
      signalsByPr.set(id, cached.signals);
      if (cached.truncated) truncated = true;
      anySucceeded = true;
      continue;
    }
    const flightKey = flightKeyOf(key, pr);
    const pending = inFlight.get(flightKey);
    if (pending) {
      awaited.push({ id, promise: pending });
      continue;
    }
    const deferred = createDeferred();
    inFlight.set(flightKey, deferred.promise);
    uncached.push({ id, pr, key, flightKey, deferred });
  }

  let graphqlFailed = false;
  try {
    // Phase 1: batched GraphQL files(first: 100).
    const needsRest = [];
    for (let offset = 0; offset < uncached.length; offset += GRAPHQL_BATCH_SIZE) {
      const batch = uncached.slice(offset, offset + GRAPHQL_BATCH_SIZE);
      let json;
      try {
        const res = await postGraphql(
          captured,
          pullRequestQuery(
            batch.map((entry) => entry.pr),
            () => ' files(first: 100) { pageInfo { hasNextPage } nodes { path changeType } } ',
          ),
        );
        if (!res.ok) {
          graphqlFailed = true;
          truncated = true;
          break;
        }
        json = await res.json();
      } catch {
        graphqlFailed = true;
        truncated = true;
        break;
      }

      if (!json || !json.data || typeof json.data !== 'object') {
        graphqlFailed = true;
        truncated = true;
        break;
      }

      anySucceeded = true;
      for (const [index, entry] of batch.entries()) {
        const { id, pr, key, deferred } = entry;
        const filesConn = json.data[`a${index}`]?.pullRequest?.files;
        if (!filesConn) {
          truncated = true;
          deferred.settle({ ok: false, signals: [], truncated: true });
          continue;
        }
        const nodes = Array.isArray(filesConn.nodes) ? filesConn.nodes : [];
        const prTruncated = Boolean(filesConn.pageInfo?.hasNextPage);
        if (prTruncated) truncated = true;
        const direct = withPrMeta(detectPrFileSignals(pr.repo, nodes), pr);
        const touchesPkg = nodes.some(
          (node) => node && !isDeleted(node) && isPackageJson(node.path),
        );
        if (touchesPkg) {
          needsRest.push({ id, pr, key, deferred, direct, prTruncated });
        } else {
          signalsByPr.set(id, direct);
          writeCached(key, pr, direct, prTruncated, nowMs);
          deferred.settle({ ok: true, signals: direct, truncated: prTruncated });
        }
      }
    }

    // Phase 2: selective REST /pulls/{n}/files only for PRs touching package.json.
    if (needsRest.length) {
      let stopped = false;
      await runWithLimit(
        needsRest,
        REST_CONCURRENCY,
        async ({ id, pr, key, deferred, direct, prTruncated }) => {
          try {
            const rest = await fetchPackageScripts(captured, pr, nowMs);
            if (rest.stop) stopped = true;
            if (!rest.ok) {
              truncated = true;
              signalsByPr.set(id, direct);
              deferred.settle({ ok: false, signals: direct, truncated: true });
              return;
            }
            const combined = [...direct, ...rest.signals];
            const entryTruncated = prTruncated || rest.truncated;
            if (entryTruncated) truncated = true;
            signalsByPr.set(id, combined);
            writeCached(key, pr, combined, entryTruncated, nowMs);
            deferred.settle({ ok: true, signals: combined, truncated: entryTruncated });
          } catch (error) {
            const kind = error?.upstream?.kind;
            if (kind === 'rate_limit' || kind === 'auth') stopped = true;
            truncated = true;
            signalsByPr.set(id, direct);
            deferred.settle({ ok: false, signals: direct, truncated: true });
          }
        },
        () => stopped,
      );
      if (stopped) {
        for (const { id, deferred, direct } of needsRest) {
          if (!signalsByPr.has(id)) {
            truncated = true;
            signalsByPr.set(id, direct);
            deferred.settle({ ok: false, signals: direct, truncated: true });
          }
        }
      }
    }
  } finally {
    for (const entry of uncached) {
      entry.deferred.settle({ ok: false, failed: true, signals: [], truncated: true });
      if (inFlight.get(entry.flightKey) === entry.deferred.promise) {
        inFlight.delete(entry.flightKey);
      }
    }
  }

  let anyFailed = graphqlFailed;
  if (awaited.length) {
    const results = await Promise.all(awaited.map(({ promise }) => promise));
    for (let i = 0; i < awaited.length; i += 1) {
      const result = results[i];
      if (result.failed) {
        anyFailed = true;
        truncated = true;
      } else {
        signalsByPr.set(awaited[i].id, result.signals);
        if (result.truncated) truncated = true;
        anySucceeded = true;
      }
    }
  }

  if (!anySucceeded && anyFailed) {
    return { available: false, reason: 'unavailable', truncated: false, byTicket: {}, updatedAt };
  }

  const byTicket = {};
  for (const [ticket, prKeys] of ticketPrKeys.entries()) {
    const items = [];
    const seen = new Set();
    for (const id of prKeys) {
      for (const signal of signalsByPr.get(id) || []) {
        const dedupeKey = `${signal.kind}|${signal.repo}|${signal.prNumber}|${signal.path}|${signal.label}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        items.push(signal);
      }
    }
    if (items.length) byTicket[ticket] = items;
  }

  return { available: true, truncated, byTicket, updatedAt };
}
