// review.mjs — fetch pull-request review state (approved / changes requested)
// for the dashboard's open PRs via a single batched GitHub GraphQL query.
// Mirrors jira.mjs: zero deps, same token, degrades to {} on any failure so the
// PR list is never blocked by a review-fetch problem.
import { captureConfiguration } from './settings.mjs';

export function headers(tokenStr) {
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

// Newest actionable state from a review list: the newest APPROVED or CHANGES_REQUESTED
// review wins; COMMENTED / DISMISSED / PENDING are ignored. summarizeReviews uses it only
// when no reviewer has a change request standing.
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

// Summarise each reviewer's latest actionable review. A later change request therefore
// removes that reviewer from the approval count, and a change request that still stands
// (its reviewer has not approved since) makes the state changes_requested, whoever else
// approved later. With none standing, the newest actionable review sets the state.
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
    state: changesRequesters.length ? 'changes_requested' : latestState(nodes),
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

const QUEUE_REVIEW_BATCH_SIZE = 50;
const QUEUE_REVIEW_STATES = new Set([
  'APPROVED',
  'CHANGES_REQUESTED',
  'DISMISSED',
  'COMMENTED',
  'PENDING',
]);
const QUEUE_REVIEW_DECISIONS = new Set(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED', null]);

function unknownQueueReview() {
  return {
    complete: false,
    state: 'unknown',
    approvers: [],
    changesRequesters: [],
    reviewDecision: null,
  };
}

function summarizeQueueReviews(nodes, reviewDecision) {
  const opinions = new Map();
  for (const node of nodes) {
    if (!node || !QUEUE_REVIEW_STATES.has(node.state)) return unknownQueueReview();
    if (node.state === 'COMMENTED' || node.state === 'PENDING') continue;
    const login = node.author?.login;
    const time = typeof node.submittedAt === 'string' ? Date.parse(node.submittedAt) : NaN;
    if (typeof login !== 'string' || !login.trim() || !Number.isFinite(time))
      return unknownQueueReview();
    const key = login.toLowerCase();
    const previous = opinions.get(key);
    if (previous?.time === time && previous.state !== node.state) return unknownQueueReview();
    if (!previous || time > previous.time) opinions.set(key, { login, state: node.state, time });
  }
  const approvers = [];
  const changesRequesters = [];
  for (const opinion of opinions.values()) {
    if (opinion.state === 'APPROVED') approvers.push(opinion.login);
    if (opinion.state === 'CHANGES_REQUESTED') changesRequesters.push(opinion.login);
  }
  const requested = reviewDecision === 'CHANGES_REQUESTED' || changesRequesters.length > 0;
  const approved = reviewDecision === 'APPROVED' || approvers.length > 0;
  return {
    complete: true,
    state: requested ? 'changes_requested' : approved ? 'approved' : 'awaiting',
    approvers,
    changesRequesters,
    reviewDecision,
  };
}

async function postQueueReviews(pending, config) {
  try {
    const res = await fetch(`${config.github.api}/graphql`, {
      method: 'POST',
      redirect: 'error',
      headers: headers(config.credentials.githubToken),
      body: JSON.stringify({
        query: query(
          pending.map((entry) => entry.pr),
          Object.fromEntries(pending.map((entry, index) => [index, entry.cursor])),
        ),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.data && typeof json.data === 'object' ? json : null;
  } catch {
    return null;
  }
}

function readQueueReviewPage(json, alias, entry) {
  if (!json || (json.errors !== undefined && !Array.isArray(json.errors))) return false;
  const errors = json.errors || [];
  if (
    errors.some(
      (error) => !Array.isArray(error?.path) || !error.path.length || error.path[0] === alias,
    )
  )
    return false;
  const pr = json.data[alias]?.pullRequest;
  const page = pr?.reviews;
  if (
    !pr ||
    !QUEUE_REVIEW_DECISIONS.has(pr.reviewDecision) ||
    !Array.isArray(page?.nodes) ||
    typeof page.pageInfo?.hasNextPage !== 'boolean' ||
    (page.pageInfo.endCursor !== null && typeof page.pageInfo.endCursor !== 'string')
  )
    return false;
  if (entry.decision !== undefined && entry.decision !== pr.reviewDecision) return false;
  entry.decision = pr.reviewDecision;
  entry.nodes.push(...page.nodes);
  const cursor = page.pageInfo.endCursor;
  if (cursor !== null && (!cursor.trim() || entry.cursors.has(cursor))) return false;
  if (!page.pageInfo.hasNextPage) return true;
  if (cursor === null || !page.nodes.length) return false;
  entry.cursors.add(cursor);
  entry.cursor = cursor;
  return 'next';
}

export async function fetchQueueReviewData(prs, { snapshot } = {}) {
  const config = captureConfiguration(snapshot);
  const unique = new Map();
  for (const pr of prs || []) {
    if (
      pr &&
      typeof pr.repo === 'string' &&
      /^[^/]+\/[^/]+$/.test(pr.repo) &&
      validPrNumber(pr.number)
    )
      unique.set(`${pr.repo}#${pr.number}`, pr);
  }
  const reviews = Object.fromEntries([...unique.keys()].map((key) => [key, unknownQueueReview()]));
  if (!config.credentials.githubToken) return { reviews };
  const entries = [...unique].map(([key, pr]) => ({
    key,
    pr,
    cursor: null,
    cursors: new Set(),
    nodes: [],
    decision: undefined,
  }));
  for (let offset = 0; offset < entries.length; offset += QUEUE_REVIEW_BATCH_SIZE) {
    let pending = entries.slice(offset, offset + QUEUE_REVIEW_BATCH_SIZE);
    while (pending.length) {
      const json = await postQueueReviews(pending, config);
      const next = [];
      for (const [index, entry] of pending.entries()) {
        const verdict = readQueueReviewPage(json, `a${index}`, entry);
        if (verdict === 'next') next.push(entry);
        else if (verdict === true)
          reviews[entry.key] = summarizeQueueReviews(entry.nodes, entry.decision);
      }
      pending = next;
    }
  }
  return { reviews };
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
