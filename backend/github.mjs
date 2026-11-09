// github.mjs — fetch the authenticated user's open pull requests across the
// transAct repos, via the public GitHub REST API. Zero external deps (global
// fetch, Node >= 20.18). Token comes from process.env.GH_TOKEN or
// GITHUB_TOKEN. Every surface (UI card, /api/prs, CLI `prs`) reads the same
// shape so nothing has to re-parse GitHub's JSON.
//
// We do two calls per refresh: GET /user to learn the login, then the search
// API for `is:pr is:open author:<login> repo:org/repo ...`. The login is
// required because the search API has no `author:@me`; it also means the fetch
// never has to be told whose PRs to show.
import { captureConfiguration } from './settings.mjs';

function headers(tokenStr) {
  return {
    Authorization: `Bearer ${tokenStr}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'dev-dashboard',
  };
}

async function getLogin(tokenStr, config) {
  const res = await fetch(`${config.api}/user`, {
    headers: headers(tokenStr),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`github /user failed: ${res.status}`);
  const data = await res.json();
  return data.login;
}

function pullRequestAuthorsQuery(prs) {
  const aliases = prs.map((pr, index) => {
    const [owner, repo] = pr.repo.split('/');
    return (
      `a${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) {\n` +
      `pullRequest(number: ${pr.number}) { author { login } }\n}`
    );
  });
  return `query {\n${aliases.join('\n')}\n}`;
}

// Jira's dev-status author name is not a reliable GitHub identity. Resolve the
// actual login for a batch of linked PRs with one GitHub GraphQL request.
export async function fetchPrOwners(prs, { snapshot } = {}) {
  const captured = captureConfiguration(snapshot);
  const tokenStr = captured.credentials.githubToken;
  const validPrs = [
    ...new Map(
      (prs || [])
        .filter(
          (pr) =>
            pr &&
            typeof pr.repo === 'string' &&
            /^[^/]+\/[^/]+$/.test(pr.repo) &&
            Number.isSafeInteger(pr.number) &&
            pr.number > 0,
        )
        .map((pr) => [`${pr.repo}#${pr.number}`, pr]),
    ).values(),
  ];
  if (!tokenStr || !validPrs.length) return {};

  try {
    const owners = {};
    for (let offset = 0; offset < validPrs.length; offset += 50) {
      const batch = validPrs.slice(offset, offset + 50);
      const res = await fetch(`${captured.github.api}/graphql`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${tokenStr}`,
          'Content-Type': 'application/json',
          Accept: 'application/vnd.github+json',
          'User-Agent': 'dev-dashboard',
        },
        body: JSON.stringify({ query: pullRequestAuthorsQuery(batch) }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue;
      const json = await res.json();
      if (!json.data || json.errors) continue;
      for (const [index, pr] of batch.entries()) {
        const login = json.data[`a${index}`]?.pullRequest?.author?.login;
        if (typeof login === 'string' && login) owners[`${pr.repo}#${pr.number}`] = login;
      }
    }
    return owners;
  } catch {
    return {};
  }
}

// Derive a lightweight {owner, repo} from a GitHub URL.
function parseRepoUrl(url) {
  const m = typeof url === 'string' ? url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)/) : null;
  if (!m) return { owner: '', repo: '' };
  return { owner: m[1], repo: m[2] };
}

// Extract ticket prefix(es) like [TAP-1665], [TRIPS-1665] (titles from before 2026-10-27), [PRT-1543], or bare PRT-1221
// from a PR title. Returns the tags in title order (uppercased, deduped).
function extractTickets(title) {
  const tags = [];
  const seen = new Set();
  const regexes = [/\b([A-Za-z]+-\d+)\b/g];
  for (const re of regexes) {
    let m;
    while ((m = re.exec(title)) !== null) {
      const tag = m[1].toUpperCase();
      if (!seen.has(tag)) {
        seen.add(tag);
        tags.push(tag);
      }
    }
  }
  return tags;
}

function mapItem(item) {
  if (!item || typeof item !== 'object') return null;
  const { owner, repo } = parseRepoUrl(item.html_url);
  if (!owner || !repo || !Number.isSafeInteger(item.number) || item.number < 1) return null;
  if (
    typeof item.html_url !== 'string' ||
    !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+(?:$|[?#])/.test(item.html_url)
  )
    return null;
  return {
    number: item.number,
    title: item.title,
    owner: item.user?.login || null,
    repo: `${owner}/${repo}`,
    url: item.html_url,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    draft: !!item.draft,
    labels: (item.labels || []).map((l) => l.name),
    tickets: extractTickets(item.title),
  };
}

export async function fetchOpenPRs({ mine = true, snapshot } = {}) {
  const captured = captureConfiguration(snapshot);
  const GITHUB = captured.github;
  const tokenStr = captured.credentials.githubToken;
  if (!tokenStr) {
    throw new Error('no GH_TOKEN (or GITHUB_TOKEN) in environment — will not prompt');
  }
  const login = await getLogin(tokenStr, GITHUB);
  const q = ['is:pr', 'is:open'];
  q.push(`${mine ? '' : '-'}author:${login}`);
  for (const repo of GITHUB.repos) q.push(`repo:${GITHUB.org}/${repo}`);
  const query = q.join(' ');

  const url =
    `${GITHUB.api}/search/issues?q=${encodeURIComponent(query)}` +
    `&sort=updated&order=desc&per_page=${GITHUB.maxResults}`;

  const res = await fetch(url, {
    headers: headers(tokenStr),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`github search failed: ${res.status}`);
  }
  const data = await res.json();
  const prs = (data.items || []).map(mapItem).filter(Boolean);
  return {
    login,
    total: data.total_count,
    prs,
    groups: groupByTicket(prs),
  };
}

export const PR_DISCOVERY_UNAVAILABLE = 'GitHub discovery unavailable';
export const PR_DISCOVERY_INCOMPLETE = 'GitHub discovery incomplete';
const OPEN_PRS_PAGE_SIZE = 100;

function nextOpenPrPage(link, current) {
  if (!link) return null;
  let next = null;
  for (const entry of link.split(',')) {
    const match = entry.trim().match(/^<([^>]+)>;\s*rel="([^"]+)"$/);
    if (!match) throw new Error('Invalid GitHub pagination.');
    if (!match[2].split(/\s+/).includes('next')) continue;
    if (next) throw new Error('Invalid GitHub pagination.');
    next = new URL(match[1]);
  }
  if (!next) return null;
  const page = Number(next.searchParams.get('page'));
  const size = next.searchParams.get('per_page');
  if (
    next.origin !== current.origin ||
    next.pathname.toLowerCase() !== current.pathname.toLowerCase() ||
    next.username ||
    next.password ||
    next.hash ||
    next.searchParams.get('state') !== 'open' ||
    !Number.isSafeInteger(page) ||
    page !== Number(current.searchParams.get('page')) + 1 ||
    (size !== null && size !== String(OPEN_PRS_PAGE_SIZE)) ||
    [...next.searchParams.keys()].some(
      (key) =>
        !['state', 'per_page', 'page'].includes(key) || next.searchParams.getAll(key).length !== 1,
    )
  )
    throw new Error('Invalid GitHub pagination.');
  next.searchParams.set('per_page', String(OPEN_PRS_PAGE_SIZE));
  return next;
}

export async function fetchAllOpenPRs({ snapshot } = {}) {
  const config = captureConfiguration(snapshot);
  const reposByIdentity = new Map();
  for (const name of config.github.repos) {
    const repo = `${config.github.org}/${name}`;
    const identity = repo.toLowerCase();
    if (!reposByIdentity.has(identity)) reposByIdentity.set(identity, repo);
  }
  const repos = [...reposByIdentity.values()];
  const token = config.credentials.githubToken;
  const prs = new Map();
  if (!token)
    return {
      prs: [],
      prCoverage: { available: false, complete: false, repos, reasons: [PR_DISCOVERY_UNAVAILABLE] },
    };
  let complete = true;
  let available = repos.length === 0;
  for (const repo of repos) {
    const repoIdentity = repo.toLowerCase();
    const pages = new Set();
    let url = new URL(`${config.github.api}/repos/${repo}/pulls`);
    url.searchParams.set('state', 'open');
    url.searchParams.set('per_page', String(OPEN_PRS_PAGE_SIZE));
    url.searchParams.set('page', '1');
    try {
      while (url) {
        const res = await fetch(url, {
          headers: headers(token),
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error('GitHub discovery failed.');
        const items = await res.json();
        if (!Array.isArray(items)) throw new Error('Invalid GitHub discovery page.');
        const page = JSON.stringify(items.map((item) => item?.number));
        if (pages.has(page)) throw new Error('Repeated GitHub discovery page.');
        pages.add(page);
        available = true;
        for (const item of items) {
          if (item?.state === 'closed' || item?.merged_at) continue;
          if (!item || item.state !== 'open' || typeof item.title !== 'string') {
            complete = false;
            continue;
          }
          const pr = mapItem({ ...item, labels: [] });
          if (
            !pr ||
            pr.repo.toLowerCase() !== repoIdentity ||
            new URL(pr.url).pathname.toLowerCase() !== `/${repoIdentity}/pull/${pr.number}`
          ) {
            complete = false;
            continue;
          }
          if (typeof item.draft !== 'boolean') complete = false;
          pr.owner = typeof pr.owner === 'string' ? pr.owner : null;
          prs.set(`${repoIdentity}#${pr.number}`, pr);
        }
        const next = nextOpenPrPage(res.headers.get('link'), url);
        if (next && !items.length) throw new Error('Invalid GitHub discovery page.');
        url = next;
      }
    } catch {
      complete = false;
    }
  }
  return {
    prs: [...prs.values()],
    prCoverage: {
      available,
      complete,
      repos,
      reasons: complete ? [] : [available ? PR_DISCOVERY_INCOMPLETE : PR_DISCOVERY_UNAVAILABLE],
    },
  };
}

// The base branch a PR targets. The search API used by fetchOpenPRs returns an
// issue-shaped payload with no base/head ref, so this is a separate per-PR
// call to the pull request endpoint — used sparingly, only for PRs already
// narrowed down to a small candidate set.
export async function fetchPrBase(repoFull, number, { snapshot } = {}) {
  const captured = captureConfiguration(snapshot);
  const GITHUB = captured.github;
  const tokenStr = captured.credentials.githubToken;
  if (!tokenStr) {
    throw new Error('no GH_TOKEN (or GITHUB_TOKEN) in environment — will not prompt');
  }
  const res = await fetch(`${GITHUB.api}/repos/${repoFull}/pulls/${number}`, {
    headers: headers(tokenStr),
    redirect: 'error',
  });
  if (!res.ok) {
    throw new Error(`github pull fetch failed: ${res.status}`);
  }
  const data = await res.json();
  return data.base?.ref ?? null;
}

// Group PRs by their primary (first) ticket prefix. Unticketed PRs collect under
// a stable 'Unticketed' key so they never vanish. Groups are sorted by the
// recency of their most recently updated PR (newest group first), so both the
// UI and CLI surface the active work at the top.
export function groupByTicket(prs) {
  const groups = {};
  for (const p of prs) {
    const key = p.tickets[0] || 'Unticketed';
    (groups[key] ||= []).push(p);
  }
  return Object.keys(groups)
    .sort((a, b) => recency(groups[b]) - recency(groups[a]))
    .reduce((out, key) => {
      out[key] = groups[key];
      return out;
    }, {});
}

// Keep only PRs whose ticket status matches targetStatus (case-insensitive).
// A PR with no ticket (grouped under 'Unticketed') always passes — there is
// no status to check against, and hiding untracked work would lose
// visibility into it. A ticketed PR with a missing/null status (Jira
// unconfigured, or the ticket wasn't found) is treated the same as "not
// confirmed in the target status": dropped.
export function filterPrsByTicketStatus(prs, statuses, targetStatus) {
  const target = String(targetStatus).toLowerCase();
  return prs.filter((p) => {
    const key = p.tickets[0];
    if (!key) return true;
    const status = statuses[key];
    return typeof status === 'string' && status.toLowerCase() === target;
  });
}

function recency(prs) {
  // Latest updatedAt (ISO string) among the group; unparseable dates sort old.
  let max = 0;
  for (const p of prs) {
    const t = Date.parse(p.updatedAt);
    if (Number.isFinite(t) && t > max) max = t;
  }
  return max;
}

// Convenience for error surfaces: a stable message without the token in it.
export function authError(e) {
  const msg = e && e.message ? e.message : String(e);
  return msg === 'no GH_TOKEN (or GITHUB_TOKEN) in environment — will not prompt' ? msg : msg;
}
