// review.mjs — fetch pull-request review state (approved / changes requested)
// for the dashboard's open PRs via a single batched GitHub GraphQL query.
// Mirrors jira.mjs: zero deps, same token, degrades to {} on any failure so the
// PR list is never blocked by a review-fetch problem.
import { captureConfiguration } from './settings.mjs';

function headers(tokenStr) {
  return {
    Authorization: `Bearer ${tokenStr}`,
    'Content-Type': 'application/json',
    Accept: 'application/vnd.github+json',
    'User-Agent': 'dev-dashboard',
  };
}

function validPrNumber(value) {
  return Number.isSafeInteger(value) && value > 0;
}

// One pullRequest per alias, so a single POST covers every PR page. Each field
// stays on a separate line so GraphQL tokens cannot be merged accidentally.
function query(prs, cursors = {}) {
  const aliases = prs.map((p, i) => {
    const [owner, repo] = p.repo.split('/');
    const after = cursors[i] ? `, after: ${JSON.stringify(cursors[i])}` : '';
    return (
      `a${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) {\n` +
      `pullRequest(number: ${p.number}) {\n` +
      '  reviewDecision\n' +
      `  reviews(first: 100${after}) { pageInfo { hasNextPage endCursor } nodes { state submittedAt author { login } } }\n` +
      '}\n}'
    );
  });
  return `query {\n${aliases.join('\n')}\n}`;
}

// Latest actionable state from an ordered review list: the newest APPROVED or
// CHANGES_REQUESTED review wins; COMMENTED / DISMISSED / PENDING are ignored.
function latestState(reviews) {
  let state = null;
  let latest = 0;
  for (const r of reviews) {
    if (!r) continue;
    if (r.state !== 'APPROVED' && r.state !== 'CHANGES_REQUESTED') continue;
    const t = Date.parse(r.submittedAt);
    if (Number.isFinite(t) && t >= latest) {
      latest = t;
      state = r.state === 'APPROVED' ? 'approved' : 'changes_requested';
    }
  }
  return state;
}

// Summarise each reviewer's latest actionable review. A later change request
// therefore removes that reviewer from the approval count.
export function summarizeReviews(nodes) {
  const latestByReviewer = new Map();
  for (const n of nodes || []) {
    if (!n) continue;
    if (n.state !== 'APPROVED' && n.state !== 'CHANGES_REQUESTED') continue;
    const login = n && n.author && n.author.login;
    const submittedAt = Date.parse(n.submittedAt);
    if (!login || !Number.isFinite(submittedAt)) continue;
    const previous = latestByReviewer.get(login);
    if (!previous || submittedAt >= previous.submittedAt) {
      latestByReviewer.set(login, {
        submittedAt,
        state: n.state,
      });
    }
  }

  const approvers = [];
  const changesRequesters = [];
  for (const [login, review] of latestByReviewer) {
    if (review.state === 'APPROVED') approvers.push(login);
    else changesRequesters.push(login);
  }

  return {
    state: latestState(nodes),
    approvers,
    changesRequesters,
  };
}

// Returns a map keyed `${repo}#${number}` -> review summary (or null when the PR
// had no resolvable reviews). Never throws: callers just lose badges on failure.
export async function fetchReviews(prs, options) {
  return (await fetchReviewData(prs, options)).reviews;
}

export async function fetchReviewData(prs, { snapshot } = {}) {
  const captured = captureConfiguration(snapshot);
  const tokenStr = captured.credentials.githubToken;
  const GRAPHQL = `${captured.github.api}/graphql`;
  if (!tokenStr || !prs) return { available: false, reviews: {} };
  if (!prs.every((pr) => pr && validPrNumber(pr.number))) {
    return { available: false, reviews: {} };
  }
  if (prs.length === 0) return { available: true, reviews: {} };
  try {
    const nodesByPr = prs.map(() => []);
    const reviewDecisions = prs.map(() => null);
    const cursors = {};
    const pending = new Set(prs.map((_, i) => i));
    while (pending.size) {
      const res = await fetch(GRAPHQL, {
        method: 'POST',
        redirect: 'error',
        headers: headers(tokenStr),
        body: JSON.stringify({ query: query(prs, cursors) }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return { available: false, reviews: {} };
      const json = await res.json();
      if (!json.data || json.errors) return { available: false, reviews: {} };
      for (const i of pending) {
        const pr = json.data[`a${i}`]?.pullRequest;
        if (!pr) return { available: false, reviews: {} };
        const page = pr.reviews || {};
        reviewDecisions[i] = pr.reviewDecision || null;
        nodesByPr[i].push(...(page.nodes || []));
        if (page.pageInfo?.hasNextPage) {
          if (!page.pageInfo.endCursor) return { available: false, reviews: {} };
          cursors[i] = page.pageInfo.endCursor;
        } else {
          pending.delete(i);
        }
      }
    }
    const reviews = prs.reduce((out, p, i) => {
      out[`${p.repo}#${p.number}`] = {
        ...summarizeReviews(nodesByPr[i]),
        reviewDecision: reviewDecisions[i],
        available: true,
      };
      return out;
    }, {});
    return { available: true, reviews };
  } catch {
    return { available: false, reviews: {} };
  }
}

export function approvalCount(pr) {
  return new Set((pr && pr.reviews && pr.reviews.approvers) || []).size;
}

export function filterPrsNeedingApprovals(prs, threshold) {
  return (prs || []).filter((pr) => {
    if (!pr || !pr.reviews || pr.reviews.available === false) return false;
    return approvalCount(pr) < threshold;
  });
}

export async function enrichOpenPRs(prs, options) {
  const result = await fetchReviewData(prs, options);
  for (const pr of prs || []) {
    pr.reviews = result.reviews[`${pr.repo}#${pr.number}`] || null;
  }
  return result;
}
