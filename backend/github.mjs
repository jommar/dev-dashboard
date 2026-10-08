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
  const res = await fetch(`${config.api}/user`, { headers: headers(tokenStr), redirect: 'error' });
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

// Extract ticket prefix(es) like [TRIPS-1665], [PRT-1543], or bare PRT-1221
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

  const res = await fetch(url, { headers: headers(tokenStr), redirect: 'error' });
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
