// ticket-prs.mjs — the signed-in user's open and merged PRs keyed by the ticket Jira links them to,
// each with its review state, CI summary and review-thread counts. The My Tickets list
// gives the tickets, Jira dev-status the PRs linked to each (every linked PR counts), then
// one GraphQL batch per 50 PRs for author, state, review and CI, and one per 50 kept PRs
// for the comment counts. The GitHub batches are sent one after another, so a poll never
// holds two GitHub requests open. Never throws: a user that cannot be identified, a failed
// Jira read or a failed detail batch gives { available: false }, and a failed comment batch
// or an unreadable field only blanks that PR's comments, review or CI, so the My Tickets
// board never waits on or fails because of this data.
import { captureConfiguration } from './settings.mjs';
import { getLogin } from './github.mjs';
import { fetchMyTickets, jiraConfig } from './jira.mjs';
import { lookUpPullRequests } from './dev-status.mjs';
import { summarizeReviews } from './review.mjs';
import { postGraphql, pullRequestQuery } from './github-api.mjs';
import { canonicalTicketKey } from '../ui/slack-ticket-links.js';

const BATCH_SIZE = 50;
// The newest tickets asked about; more than this marks the answer truncated.
const TICKET_LOOKUP_CAP = 50;
// Longer than the board's 90 s poll, so a warm cache serves every second poll.
export const LOOKUP_TTL_MS = 120_000;
// Error types of a PR alias that GitHub will not show the token: dropped, never retried.
const UNREADABLE_ERRORS = new Set(['NOT_FOUND', 'FORBIDDEN']);
const GITHUB_PULL_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/;
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
const DETAIL_SELECTION = `state isDraft mergedAt author { login }\n  ${REVIEWS_FIELD}\n  ${CHECKS_FIELD}`;
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
  const { state, approvers, changesRequesters } = summarizeReviews(reviews.nodes);
  return { state: state || 'awaiting', approvals: approvers.length, approvers, changesRequesters };
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

// What one detail alias says about its PR. A failed batch is `failed`, because the author of
// its PRs is then unknown. A null alias that GitHub says is missing or forbidden is a PR that is
// not open and not the user's; any other error on it is a transient failure, so it fails the batch.
function detailOf(json, alias) {
  if (!json) return { failed: true };
  const pr = json.data?.[alias]?.pullRequest;
  const errors = Array.isArray(json.errors) ? json.errors : [];
  if (!pr) {
    const transient = errors.some(
      (error) => error?.path?.[0] === alias && !UNREADABLE_ERRORS.has(error.type),
    );
    return transient ? { failed: true } : { open: false };
  }
  return {
    open: pr.state === 'OPEN',
    merged: pr.state === 'MERGED',
    mergedAt: typeof pr.mergedAt === 'string' ? pr.mergedAt : null,
    draft: pr.isDraft === true,
    login: typeof pr.author?.login === 'string' ? pr.author.login : null,
    review: reviewOf(pr.reviews),
    ci: ciOf(pr.commits, alias, errors),
  };
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

// The parsed response, or null when the request failed or returned no data.
async function postBatch(batch, selection, config) {
  try {
    const res = await postGraphql(
      config,
      pullRequestQuery(batch, () => `\n  ${selection}\n`),
    );
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

// Open state, draft flag, author, review and CI for each PR, in input order.
export function readDetails(prs, config) {
  return readLane(prs, config, DETAIL_SELECTION, detailOf, () => ({ open: false }));
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

// The PRs Jira links to each ticket, once per PR, each remembering its ticket keys. Only a PR Jira
// calls declined is skipped here: any other state, a draft ("DRAFT" reads as unknown) and a
// merged one included, goes on to GitHub, which decides open, merged, draft and author.
// The repo and number are read from the PR's URL, and a PR without a GitHub pull URL is skipped.
export function linkedPrs(entries, outcomes) {
  const found = new Map();
  for (const entry of entries) {
    for (const pr of outcomes.get(entry).prs ?? []) {
      const match = GITHUB_PULL_URL.exec(pr.url);
      if (pr.state === 'declined' || !match) continue;
      const [, repo, digits] = match;
      const number = Number(digits);
      const id = `${repo}#${number}`;
      if (!found.has(id)) {
        found.set(id, {
          repo,
          number,
          title: pr.title,
          url: pr.url,
          updatedAt: pr.updatedAt,
          tickets: [],
        });
      }
      found.get(id).tickets.push(entry.ticket.key);
    }
  }
  return [...found.values()];
}

async function loadTicketPrs(config) {
  try {
    const token = config.credentials.githubToken;
    const jira = jiraConfig(config);
    if (!token || !jira) return unavailable();
    const login = await getLogin(token, config.github);
    const mine = await fetchMyTickets({ snapshot: config });
    const withId = mine.tickets.filter((ticket) => ticket.id);
    const entries = withId
      .slice(0, TICKET_LOOKUP_CAP)
      .map((ticket) => ({ issueId: ticket.id, ticket }));
    const outcomes = await lookUpPullRequests(jira, entries, {
      refresh: false,
      ttlMs: LOOKUP_TTL_MS,
    });
    const failed = entries.filter((entry) => outcomes.get(entry).error).length;
    if (entries.length && failed === entries.length) return unavailable();

    const linked = linkedPrs(entries, outcomes);
    const details = await readDetails(linked, config);
    if (details.some((detail) => detail.failed)) return unavailable();
    const mineOnly = linked.flatMap((pr, index) =>
      (details[index].open || details[index].merged) &&
      details[index].login?.toLowerCase() === login.toLowerCase()
        ? [{ pr, detail: details[index] }]
        : [],
    );
    // A merged PR is a slim line with no comment chips, so its threads are never read.
    const unmerged = mineOnly.filter(({ detail }) => !detail.merged);
    const unmergedComments = await readComments(
      unmerged.map(({ pr }) => pr),
      config,
    );
    const comments = new Map(unmerged.map(({ pr }, index) => [pr, unmergedComments[index]]));
    const prs = mineOnly.map(({ pr, detail }) => ({
      repo: pr.repo,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      draft: detail.draft,
      merged: detail.merged,
      mergedAt: detail.mergedAt,
      updatedAt: pr.updatedAt,
      tickets: pr.tickets,
      review: detail.review,
      ci: detail.ci,
      comments: comments.get(pr) ?? null,
    }));
    return {
      available: true,
      login,
      total: prs.length,
      truncated: mine.truncated || withId.length > TICKET_LOOKUP_CAP || failed > 0,
      byTicket: prsByTicket(prs),
    };
  } catch {
    return unavailable();
  }
}

// Concurrent calls for one settings revision share one upstream load. The entry is
// dropped when the load settles, so the result is not cached here. Jira dev-status has its own
// 120 s cache (LOOKUP_TTL_MS) that a Refresh does not bypass; the GitHub reads are always live.
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
