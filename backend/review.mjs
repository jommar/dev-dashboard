// review.mjs — fetch pull-request review state (approved / changes requested)
// for the dashboard's open PRs via a single batched GitHub GraphQL query.
// Mirrors jira.mjs: zero deps, same token, degrades to {} on any failure so the
// PR list is never blocked by a review-fetch problem.
import { captureConfiguration } from './settings.mjs';
import { postGraphql, pullRequestQuery } from './github-api.mjs';
export { headers } from './github-api.mjs';

function validPrNumber(value) {
  return Number.isSafeInteger(value) && value > 0;
}

// One pullRequest per alias, so a single POST covers every PR page. Each field
// stays on a separate line so GraphQL tokens cannot be merged accidentally.
function query(prs, cursors = {}) {
  return pullRequestQuery(prs, (_, i) => {
    const after = cursors[i] ? `, after: ${JSON.stringify(cursors[i])}` : '';
    return (
      '\n  reviewDecision\n' +
      `  reviews(first: 100${after}) { pageInfo { hasNextPage endCursor } nodes { state submittedAt author { login } } }\n`
    );
  });
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
      const res = await postGraphql(captured, query(prs, cursors));
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
const QUEUE_COMMENT_MAX_PAGES = 10;
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
    viewerReview: 'none',
  };
}

function summarizeQueueReviews(nodes, reviewDecision, viewerLogin = null, viewerCommented = false) {
  const opinions = new Map();
  const reviewCommenters = new Set();
  for (const node of nodes) {
    if (!node || !QUEUE_REVIEW_STATES.has(node.state)) return unknownQueueReview();
    if (node.state === 'COMMENTED') {
      const commenter = node.author?.login;
      if (typeof commenter === 'string' && commenter.trim())
        reviewCommenters.add(commenter.trim().toLowerCase());
      continue;
    }
    if (node.state === 'PENDING') continue;
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
  let viewerReview = 'none';
  if (viewerLogin) {
    if (opinions.get(viewerLogin)?.state === 'APPROVED') viewerReview = 'approved';
    else if (reviewCommenters.has(viewerLogin) || viewerCommented) viewerReview = 'commented';
  }
  return {
    complete: true,
    state: requested ? 'changes_requested' : approved ? 'approved' : 'awaiting',
    approvers,
    changesRequesters,
    reviewDecision,
    viewerReview,
  };
}

function queueQuery(pending) {
  const body = pullRequestQuery(
    pending.map((entry) => entry.pr),
    (_, index) => {
      const entry = pending[index];
      let selection = '\n';
      if (!entry.reviewsDone) {
        const after = entry.cursor ? `, after: ${JSON.stringify(entry.cursor)}` : '';
        selection +=
          '  reviewDecision\n' +
          `  reviews(first: 100${after}) { pageInfo { hasNextPage endCursor } nodes { state submittedAt author { login } } }\n`;
      }
      if (!entry.commentsDone) {
        const after = entry.commentCursor ? `, after: ${JSON.stringify(entry.commentCursor)}` : '';
        selection += `  comments(first: 100${after}) { pageInfo { hasNextPage endCursor } nodes { author { login } } }\n`;
      }
      return selection;
    },
  );
  return body.replace(/^query \{\n/, 'query {\nviewer { login }\n');
}

async function postQueueReviews(pending, config) {
  try {
    const res = await postGraphql(config, queueQuery(pending));
    if (!res.ok) return null;
    const json = await res.json();
    return json?.data && typeof json.data === 'object' ? json : null;
  } catch {
    return null;
  }
}

function isCommentsError(error, alias) {
  return (
    Array.isArray(error?.path) &&
    error.path[0] === alias &&
    error.path[1] === 'pullRequest' &&
    error.path[2] === 'comments'
  );
}

function readQueueReviewPage(json, alias, entry, viewerLogin) {
  if (!json || (json.errors !== undefined && !Array.isArray(json.errors))) {
    if (!entry.reviewsDone) return false;
    entry.commentsDone = true;
    return true;
  }
  const errors = json.errors || [];
  const hasGlobalError = errors.some((error) => !Array.isArray(error?.path) || !error.path.length);
  const hasReviewError =
    hasGlobalError ||
    errors.some((error) => error.path[0] === alias && !isCommentsError(error, alias));
  const hasCommentError = hasGlobalError || errors.some((error) => error.path[0] === alias);
  const pr = json.data[alias]?.pullRequest;

  if (!entry.reviewsDone) {
    if (hasReviewError || !pr) return false;
    const page = pr.reviews;
    if (
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
    if (page.pageInfo.hasNextPage) {
      if (cursor === null || !page.nodes.length) return false;
      entry.cursors.add(cursor);
      entry.cursor = cursor;
    } else {
      entry.reviewsDone = true;
    }
  }

  if (!entry.commentsDone) {
    if (!viewerLogin || hasCommentError || !pr) {
      entry.commentsDone = true;
    } else {
      const page = pr.comments;
      if (
        page === undefined ||
        !Array.isArray(page?.nodes) ||
        typeof page.pageInfo?.hasNextPage !== 'boolean' ||
        (page.pageInfo.endCursor !== null && typeof page.pageInfo.endCursor !== 'string')
      ) {
        entry.commentsDone = true;
      } else {
        entry.commentPages += 1;
        for (const node of page.nodes) {
          const login = node?.author?.login;
          if (typeof login === 'string' && login.trim().toLowerCase() === viewerLogin) {
            entry.viewerCommented = true;
            break;
          }
        }
        const cursor = page.pageInfo.endCursor;
        if (
          !entry.viewerCommented &&
          entry.commentPages < QUEUE_COMMENT_MAX_PAGES &&
          page.pageInfo.hasNextPage &&
          cursor !== null &&
          cursor.trim() &&
          !entry.commentCursors.has(cursor) &&
          page.nodes.length
        ) {
          entry.commentCursors.add(cursor);
          entry.commentCursor = cursor;
        } else {
          entry.commentsDone = true;
        }
      }
    }
  }

  return !entry.reviewsDone || !entry.commentsDone ? 'next' : true;
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
    reviewsDone: false,
    commentCursor: null,
    commentCursors: new Set(),
    commentPages: 0,
    viewerCommented: false,
    commentsDone: false,
  }));
  let viewerLogin = null;
  for (let offset = 0; offset < entries.length; offset += QUEUE_REVIEW_BATCH_SIZE) {
    let pending = entries.slice(offset, offset + QUEUE_REVIEW_BATCH_SIZE);
    while (pending.length) {
      const json = await postQueueReviews(pending, config);
      const login = json?.data?.viewer?.login;
      if (typeof login === 'string' && login.trim()) viewerLogin = login.trim().toLowerCase();
      const next = [];
      for (const [index, entry] of pending.entries()) {
        const verdict = readQueueReviewPage(json, `a${index}`, entry, viewerLogin);
        if (verdict === 'next') next.push(entry);
        else if (verdict === true)
          reviews[entry.key] = summarizeQueueReviews(
            entry.nodes,
            entry.decision,
            viewerLogin,
            entry.viewerCommented,
          );
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
