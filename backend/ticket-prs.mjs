// ticket-prs.mjs — the signed-in user's open PRs keyed by every ticket they name,
// each with its review state, CI summary and review-thread counts. One search, then
// one GraphQL batch per 50 PRs for review and CI, then one per 50 PRs for the
// comment counts. The batches are sent one after another, so a poll never holds two
// GitHub requests open. Never throws: a failed search gives { available: false }, and
// a failed batch or an unreadable field only blanks that PR's review, CI or comments,
// so the My Tickets board never waits on or fails because of this data.
import { captureConfiguration } from './settings.mjs';
import { fetchOpenPRs } from './github.mjs';
import { headers, summarizeReviews } from './review.mjs';
import { canonicalTicketKey } from '../ui/slack-ticket-links.js';

const BATCH_SIZE = 50;
const TIMEOUT_MS = 15_000;
// Review threads read per PR. A PR with more reports `truncated`, so its counts are partial.
const THREAD_CAP = 50;
// Logins of the Copilot reviewer, lower-cased and without a trailing `[bot]`. GitHub's docs name
// `copilot-pull-request-reviewer[bot]`; the bare `copilot` is unverified. The docs do not state
// the account type, so the match is by login alone. A wrong login shows that PR's threads under
// `other` and never fails the batch.
const COPILOT_LOGINS = new Set(['copilot-pull-request-reviewer', 'copilot']);
const ROLLUP_STATE = new Map([
  ['SUCCESS', 'passing'],
  ['FAILURE', 'failing'],
  ['ERROR', 'failing'],
]);
const PASSED_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const FAILED_CONCLUSIONS = new Set([
  'FAILURE',
  'TIMED_OUT',
  'CANCELLED',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
  'STALE',
]);
const FAILED_STATUSES = new Set(['FAILURE', 'ERROR']);
const CI_PATH_SEGMENTS = new Set(['commits', 'statusCheckRollup']);
// The last 100 reviews, and whether older ones exist outside that window.
const REVIEWS_FIELD =
  'reviews(last: 100) { nodes { state submittedAt author { login } } pageInfo { hasPreviousPage } }';
const CHECKS_FIELD =
  'commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes { __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state } } } } } } }';
const DETAIL_SELECTION = `${REVIEWS_FIELD}\n  ${CHECKS_FIELD}`;
// The conversation comment count, and each review thread with its resolution and the author of
// its first comment, which decides the bucket the thread counts under.
const COMMENTS_SELECTION = `comments(first: 1) { totalCount } reviewThreads(first: ${THREAD_CAP}) { totalCount nodes { isResolved comments(first: 1) { totalCount nodes { author { __typename login } } } } }`;

function unavailable() {
  return { available: false, login: null, total: 0, truncated: false, byTicket: {} };
}

// One check or status context as passed, failed or pending. A CheckRun is
// pending until it completes, and an unrecognised conclusion is never a pass.
function outcomeOf(node) {
  if (node.__typename === 'StatusContext') {
    if (node.state === 'SUCCESS') return 'passed';
    return FAILED_STATUSES.has(node.state) ? 'failed' : 'pending';
  }
  if (node.status !== 'COMPLETED') return 'pending';
  if (PASSED_CONCLUSIONS.has(node.conclusion)) return 'passed';
  return FAILED_CONCLUSIONS.has(node.conclusion) ? 'failed' : 'pending';
}

// The CI state from a commit's status check rollup, with counts over its contexts.
export function summarizeChecks(rollup) {
  if (!rollup) return { state: 'none', passed: 0, failed: 0, pending: 0, failing: [] };
  const summary = {
    state: ROLLUP_STATE.get(rollup.state) ?? 'pending',
    passed: 0,
    failed: 0,
    pending: 0,
    failing: [],
  };
  // Two jobs can share a name; the count stays per check, the names are listed once.
  const failing = new Set();
  for (const node of rollup.contexts?.nodes ?? []) {
    if (!node) continue;
    const outcome = outcomeOf(node);
    if (outcome === 'passed') summary.passed += 1;
    else if (outcome === 'pending') summary.pending += 1;
    else {
      summary.failed += 1;
      failing.add(node.__typename === 'StatusContext' ? node.context : node.name);
    }
  }
  summary.failing = [...failing];
  return summary;
}

// A review list that cannot be read, or that may have older reviews outside the window (an older
// change request could still stand there), is unknown rather than approved. A window that does not
// say whether older reviews exist is unreadable in the same way.
function reviewOf(reviews) {
  if (!Array.isArray(reviews?.nodes) || reviews.pageInfo?.hasPreviousPage !== false) return null;
  const { state, approvers } = summarizeReviews(reviews.nodes);
  return { state: state || 'awaiting', approvals: approvers.length };
}

// GitHub reports a field it will not show as an error entry on that field's path.
// A missing rollup with such an entry is unreadable, which is not the same as no CI.
function refusedCi(errors, alias) {
  return errors.some(
    (error) =>
      error?.path?.[0] === alias && error.path.some((segment) => CI_PATH_SEGMENTS.has(segment)),
  );
}

function ciOf(commits, alias, errors) {
  if (!Array.isArray(commits?.nodes)) return null;
  const rollup = commits.nodes[0]?.commit?.statusCheckRollup;
  if (!rollup && refusedCi(errors, alias)) return null;
  return summarizeChecks(rollup);
}

function detailOf(json, alias) {
  const pr = json?.data?.[alias]?.pullRequest;
  if (!pr) return { review: null, ci: null };
  const errors = Array.isArray(json.errors) ? json.errors : [];
  return { review: reviewOf(pr.reviews), ci: ciOf(pr.commits, alias, errors) };
}

const emptyBucket = () => ({ threads: 0, unresolved: 0, comments: 0 });

// The bucket of a thread, from the author of its first comment. A deleted account (null
// author) and a thread with no readable first comment are `other`.
function bucketOf(author) {
  const login = String(author?.login ?? '')
    .toLowerCase()
    .replace(/\[bot\]$/, '');
  if (COPILOT_LOGINS.has(login)) return 'copilot';
  return author?.__typename === 'User' ? 'human' : 'other';
}

// Review threads by who started them, with counts over the threads read, and the conversation
// comment count. Null when the PR's thread or conversation counts cannot be read.
export function summarizeThreads(pullRequest) {
  const nodes = pullRequest?.reviewThreads?.nodes;
  const threads = pullRequest?.reviewThreads?.totalCount;
  const conversation = pullRequest?.comments?.totalCount;
  if (!Array.isArray(nodes) || !Number.isInteger(threads) || !Number.isInteger(conversation)) {
    return null;
  }
  const summary = {
    human: emptyBucket(),
    copilot: emptyBucket(),
    other: emptyBucket(),
    conversation,
    threads,
    truncated: threads > nodes.length,
  };
  for (const thread of nodes) {
    if (!thread) continue;
    const bucket = summary[bucketOf(thread.comments?.nodes?.[0]?.author)];
    bucket.threads += 1;
    if (!thread.isResolved) bucket.unresolved += 1;
    const comments = thread.comments?.totalCount;
    bucket.comments += Number.isInteger(comments) ? comments : 0;
  }
  return summary;
}

// The comment counts of one PR alias. An error entry on the alias means the counts may be
// partial, so the PR gets null rather than counts that look complete.
function commentsOf(json, alias) {
  const errors = Array.isArray(json?.errors) ? json.errors : [];
  if (errors.some((error) => error?.path?.[0] === alias)) return null;
  return summarizeThreads(json?.data?.[alias]?.pullRequest);
}

// One alias per PR, so each PR's failure stays inside its own alias.
function batchQuery(batch, selection) {
  const aliases = batch.map((pr, index) => {
    const [owner, name] = pr.repo.split('/');
    return (
      `a${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {\n` +
      `pullRequest(number: ${pr.number}) {\n  ${selection}\n}\n}`
    );
  });
  return `query {\n${aliases.join('\n')}\n}`;
}

// The parsed response, or null when the request failed or returned no data.
async function postBatch(batch, selection, config) {
  try {
    const res = await fetch(`${config.github.api}/graphql`, {
      method: 'POST',
      redirect: 'error',
      headers: headers(config.credentials.githubToken),
      body: JSON.stringify({ query: batchQuery(batch, selection) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.data ? json : null;
  } catch {
    return null;
  }
}

// The query interpolates owner, name and number, so only PRs of this exact shape are sent.
const queryable = (pr) =>
  /^[^/]+\/[^/]+$/.test(pr.repo) && Number.isSafeInteger(pr.number) && pr.number > 0;

// One result per PR, in input order, from one selection read in batches of BATCH_SIZE PRs, one
// POST at a time. `readAlias(json, alias)` reads a queried PR from its batch (json is null when
// the batch failed), and `blank()` is the result of a PR that is not queried.
async function readLane(prs, config, selection, readAlias, blank) {
  const results = prs.map(() => blank());
  const indexes = prs.flatMap((pr, index) => (queryable(pr) ? [index] : []));
  for (let offset = 0; offset < indexes.length; offset += BATCH_SIZE) {
    const slice = indexes.slice(offset, offset + BATCH_SIZE);
    const json = await postBatch(
      slice.map((index) => prs[index]),
      selection,
      config,
    );
    slice.forEach((prIndex, alias) => {
      results[prIndex] = readAlias(json, `a${alias}`);
    });
  }
  return results;
}

// Review and CI for each PR, in input order. A PR that is not queried, or whose
// batch failed, gets null for both.
function readDetails(prs, config) {
  return readLane(prs, config, DETAIL_SELECTION, detailOf, () => ({ review: null, ci: null }));
}

// Comment counts for each PR, in input order, from a batch of their own: a failure here never
// touches review or CI. A PR that is not queried, or whose batch failed, gets null.
function readComments(prs, config) {
  return readLane(prs, config, COMMENTS_SELECTION, commentsOf, () => null);
}

const newestFirst = (a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);

// Every PR under each ticket it names (TRIPS folded onto TAP), newest update first.
// A PR that names one key twice is listed once, and the tickets list is left out.
export function prsByTicket(prs) {
  const byTicket = {};
  for (const pr of [...prs].sort(newestFirst)) {
    const { tickets, ...entry } = pr;
    for (const key of new Set((tickets || []).map((tag) => canonicalTicketKey(tag)))) {
      (byTicket[key] ||= []).push(entry);
    }
  }
  return byTicket;
}

async function loadTicketPrs(config) {
  try {
    const found = await fetchOpenPRs({ mine: true, snapshot: config });
    const details = await readDetails(found.prs, config);
    const comments = await readComments(found.prs, config);
    const entries = found.prs.map((pr, index) => ({
      repo: pr.repo,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      draft: pr.draft,
      updatedAt: pr.updatedAt,
      tickets: pr.tickets,
      ...details[index],
      comments: comments[index],
    }));
    const total = Number.isFinite(found.total) ? found.total : found.prs.length;
    return {
      available: true,
      login: found.login,
      total,
      truncated: total > found.prs.length,
      byTicket: prsByTicket(entries),
    };
  } catch {
    return unavailable();
  }
}

// Concurrent calls for one settings revision share one upstream load. The entry is
// dropped when the load settles, so nothing is cached and a Refresh reaches GitHub.
const inFlight = new Map();

// The signed-in user's open PRs with review and CI state, keyed by ticket.
export function fetchTicketPrs({ snapshot } = {}) {
  let config;
  try {
    config = captureConfiguration(snapshot);
  } catch {
    return Promise.resolve(unavailable());
  }
  const key = config.revision ?? '';
  if (!inFlight.has(key)) {
    const pending = loadTicketPrs(config).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return inFlight.get(key);
}
