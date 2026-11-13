// spec-reviews.mjs — the Spec review lane's feed. It lists the open `spec`-labelled PRs of
// TransActComm/ezat-specs whose title names a TAP or TRIPS ticket, unless a code PR of that ticket
// (title or head branch) is open or merged in Portage-backend, Portage-frontend or TravelTracker.
//
// The code-PR keys come from one GraphQL scan, kept ten minutes per settings revision; the spec query
// is never cached. A failed query answers unavailable and caches nothing, so a coded spec is never
// listed because a lookup failed.

import { isDeepStrictEqual } from 'node:util';
import { captureConfiguration } from './settings.mjs';
import { postGraphql } from './github-api.mjs';

const ORG = 'TransActComm';
const SPEC_REPO = 'ezat-specs';
const SPEC_LABEL = 'spec';
const CODE_REPOS = ['Portage-backend', 'Portage-frontend', 'TravelTracker'];
const PAGE_SIZE = 100;
const DEFAULT_SPEC_LIMIT = 3;
const SEARCH_MATCH_LIMIT = 1000;
const CODE_PAGE_LIMIT = 10;
const CACHE_TTL_MS = 10 * 60_000;
const DAY_MS = 86_400_000;
const KEY_PATTERN = /(TAP|TRIPS)-[0-9]+/g;

// The URL of one ezat-specs pull request, as the spec review prompt names it.
export const specPrUrl = (pr) => `https://github.com/${ORG}/${SPEC_REPO}/pull/${pr}`;

const keysIn = (text) => text.match(KEY_PATTERN) ?? [];
const login = (actor) => actor?.login ?? null;
const after = (cursor) => (cursor ? `, after: ${JSON.stringify(cursor)}` : '');
const unavailable = (reason) => ({
  available: false,
  total: 0,
  specs: [],
  hasMore: false,
  updatedAt: new Date().toISOString(),
  ...(reason ? { reason } : {}),
});

// Used by the HTTP route and direct module callers; validation stays outside upstream-failure handling.
export function parseSpecReviewLimit(value = DEFAULT_SPEC_LIMIT) {
  const limit = typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : value;
  if (
    typeof limit !== 'number' ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > SEARCH_MATCH_LIMIT
  )
    throw Object.assign(new Error('Invalid spec limit.'), {
      code: 'INVALID_SPEC_LIMIT',
      status: 400,
    });
  return limit;
}

// Search membership can lag current PR fields. Select live labels/requests, and reject incomplete
// nested connections rather than mistaking an unseen label or User request for absence.
const specPage = ({ name, first, cursor }) => {
  const reviewer =
    name === 'requested' ? 'user-review-requested:@me' : '-user-review-requested:@me';
  const query = `repo:${ORG}/${SPEC_REPO} is:pr is:open label:${SPEC_LABEL} ${reviewer} sort:created-desc`;
  return `${name}: search(type: ISSUE, query: ${JSON.stringify(query)}, first: ${first}${after(cursor)}) {
    issueCount
    nodes { ... on PullRequest {
      number title url isDraft createdAt state headRefOid author { login }
      labels(first: 100) { nodes { name } pageInfo { hasNextPage endCursor } }
      reviews(last: 100, states: [APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED]) { nodes { author { login } commit { oid } } }
      reviewRequests(first: 100) { nodes { requestedReviewer { __typename ... on User { login } } } pageInfo { hasNextPage endCursor } }
    } }
    pageInfo { hasNextPage endCursor }
  }`;
};
const specQuery = (searches) => `query { viewer { login } ${searches.map(specPage).join('\n')} }`;

const alias = (repo) => `r${CODE_REPOS.indexOf(repo)}`;

// One page of one code repo's OPEN and MERGED PRs, newest first, for the scan's single request.
const codePage = (repo, cursor) =>
  `${alias(repo)}: repository(owner: "${ORG}", name: "${repo}") { pullRequests(first: ${PAGE_SIZE}, states: [OPEN, MERGED], orderBy: {field: CREATED_AT, direction: DESC}${after(cursor)}) { nodes { title headRefName } pageInfo { hasNextPage endCursor } } }`;
const codeQuery = (repos, cursors) =>
  `query { ${repos.map((repo) => codePage(repo, cursors.get(repo))).join(' ')} }`;

// The data of one GraphQL answer, or null when the request failed or the answer carries errors.
async function graphqlData(res) {
  if (!res.ok) return null;
  const { data, errors } = await res.json();
  return errors || !data ? null : data;
}

const searchLimitError = () =>
  Object.assign(new Error('GitHub search limit.'), { code: 'SPEC_SEARCH_LIMIT' });

function specSearch(name, first) {
  return {
    name,
    first,
    examined: 0,
    count: null,
    complete: false,
    cursors: new Set(),
    numbers: new Set(),
  };
}

// Track each independent search's progress and honest end. Counts include search candidates, not
// eligible cards. Repeated pages/cursors cannot establish that every requested hit was observed.
function readSearchPage(search, found) {
  if (
    !Number.isSafeInteger(found?.issueCount) ||
    found.issueCount < 0 ||
    !Array.isArray(found.nodes)
  )
    return false;
  if (search.name === 'requested' && found.issueCount > SEARCH_MATCH_LIMIT)
    throw searchLimitError();
  const { nodes, issueCount, pageInfo } = found;
  if (search.count !== null && issueCount !== search.count) return false;
  const examined = search.examined + nodes.length;
  if (
    nodes.length > search.first ||
    examined > issueCount ||
    examined > SEARCH_MATCH_LIMIT ||
    typeof pageInfo?.hasNextPage !== 'boolean' ||
    (pageInfo.hasNextPage && (!nodes.length || examined >= issueCount)) ||
    (!pageInfo.hasNextPage && examined !== issueCount && examined !== SEARCH_MATCH_LIMIT)
  )
    return false;
  const cursor = pageInfo.endCursor;
  if (
    (pageInfo.hasNextPage && (typeof cursor !== 'string' || !cursor)) ||
    (cursor != null && (typeof cursor !== 'string' || !cursor || search.cursors.has(cursor))) ||
    (search.examined > 0 &&
      nodes.length > 0 &&
      nodes.every((node) => search.numbers.has(node?.number)))
  )
    return false;
  if (cursor) search.cursors.add(cursor);
  for (const node of nodes) search.numbers.add(node?.number);
  // Raw overlap cannot prove that every requested PR was observed before eligibility filtering.
  if (search.name === 'requested' && !pageInfo.hasNextPage && search.numbers.size !== issueCount)
    return false;
  search.count = issueCount;
  search.examined = examined;
  search.complete = !pageInfo.hasNextPage && examined === issueCount;
  search.cursor = cursor;
  return true;
}

function completeConnection(connection) {
  return Array.isArray(connection?.nodes) && connection.pageInfo?.hasNextPage === false;
}

function validSpecNode(node) {
  return (
    Number.isSafeInteger(node?.number) &&
    node.number > 0 &&
    typeof node.title === 'string' &&
    typeof node.createdAt === 'string' &&
    Number.isFinite(Date.parse(node.createdAt)) &&
    ['OPEN', 'CLOSED', 'MERGED'].includes(node.state) &&
    completeConnection(node.labels) &&
    node.labels.nodes.every((label) => typeof label?.name === 'string') &&
    completeConnection(node.reviewRequests) &&
    node.reviewRequests.nodes.every(
      (request) =>
        request?.requestedReviewer === null ||
        (typeof request?.requestedReviewer?.__typename === 'string' &&
          (request.requestedReviewer.__typename !== 'User' ||
            (typeof request.requestedReviewer.login === 'string' &&
              request.requestedReviewer.login.length > 0))),
    ) &&
    Array.isArray(node.reviews?.nodes)
  );
}

function isReviewRequested(node, viewer) {
  return Boolean(
    viewer &&
    node.reviewRequests.nodes.some(
      ({ requestedReviewer }) =>
        requestedReviewer?.__typename === 'User' && login(requestedReviewer) === viewer,
    ),
  );
}

const newestFirst = (a, b) =>
  Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.number - a.number;

function partitionSpecs(nodes, viewer, coded) {
  const requested = [];
  const others = [];
  for (const node of nodes) {
    const keys = keysIn(node.title);
    if (
      node.state !== 'OPEN' ||
      !node.labels.nodes.some(({ name }) => name === SPEC_LABEL) ||
      !keys.length ||
      keys.some((key) => coded.has(key))
    )
      continue;
    (isReviewRequested(node, viewer) ? requested : others).push(node);
  }
  return { requested: requested.sort(newestFirst), others: others.sort(newestFirst) };
}

// Complete mine on every load; stop others only after a usable prefix/lookahead or a proven end.
// All state here is local to this fetch. Only the existing code-key scan is cached.
async function scanSpecs(config, limit) {
  const searches = [
    specSearch('requested', PAGE_SIZE),
    specSearch('others', Math.min(PAGE_SIZE, limit + 1)),
  ];
  const othersSearch = searches[1];
  const nodes = new Map();
  let viewer = null;
  let coded;
  let groups;
  let pending = searches;
  while (pending.length) {
    const data = await graphqlData(await postGraphql(config, specQuery(pending)));
    const currentViewer = login(data?.viewer);
    if (typeof currentViewer !== 'string' || !currentViewer || (viewer && viewer !== currentViewer))
      return null;
    viewer = currentViewer;
    for (const search of pending) {
      const found = data[search.name];
      if (!readSearchPage(search, found)) return null;
      for (const node of found.nodes) {
        if (!validSpecNode(node)) return null;
        if (nodes.has(node.number) && !isDeepStrictEqual(nodes.get(node.number), node)) return null;
        nodes.set(node.number, node);
      }
      if (search.name === 'others' && found.nodes.length)
        othersSearch.oldestCreatedAt = Date.parse(found.nodes.at(-1).createdAt);
    }
    coded ??= await codedKeys(config);
    if (!coded) return null;
    groups = partitionSpecs(nodes.values(), viewer, coded);
    // Withdrawn requested hits may be older than unseen others. The search must reach the
    // lookahead's creation time before that pooled prefix is known to be the newest one.
    const lookahead = groups.others[limit];
    const othersReady =
      lookahead && othersSearch.oldestCreatedAt <= Date.parse(lookahead.createdAt);
    pending = searches.filter(
      (search) => !search.complete && (search.name === 'requested' || !othersReady),
    );
    for (const search of pending) {
      if (search.examined === SEARCH_MATCH_LIMIT) throw searchLimitError();
      search.first = Math.min(PAGE_SIZE, SEARCH_MATCH_LIMIT - search.examined);
    }
  }
  return { ...groups, viewer };
}

// The keys named by the OPEN and MERGED PRs of the code repos, in titles and head branches. A repo
// still paging after the page cap is cut short, which is not a failure. Null when a request failed.
async function scanCodeKeys(config) {
  const keys = new Set();
  const cursors = new Map();
  let pending = CODE_REPOS;
  for (let page = 0; page < CODE_PAGE_LIMIT && pending.length; page += 1) {
    const data = await graphqlData(await postGraphql(config, codeQuery(pending, cursors)));
    const next = [];
    for (const repo of pending) {
      const found = data?.[alias(repo)]?.pullRequests;
      if (!Array.isArray(found?.nodes)) return null;
      for (const pr of found.nodes) {
        for (const key of keysIn([pr.title, pr.headRefName].join(' '))) keys.add(key);
      }
      if (found.pageInfo?.hasNextPage) {
        if (!found.pageInfo.endCursor) return null;
        cursors.set(repo, found.pageInfo.endCursor);
        next.push(repo);
      }
    }
    pending = next;
  }
  return keys;
}

// The code-PR keys of the last complete scan and the scans in flight, each per settings revision.
let cached = null;
const scans = new Map();

// Forgets the cached keys and any scan in flight.
export function resetSpecReviewCache() {
  cached = null;
  scans.clear();
}

// Concurrent loads of one revision share one scan. Only a complete scan is kept, for ten minutes.
async function codedKeys(config) {
  const revision = config.revision ?? '';
  if (cached?.revision === revision && Date.now() < cached.expiresAt) return cached.keys;
  if (!scans.has(revision)) {
    scans.set(
      revision,
      scanCodeKeys(config)
        .then((keys) => {
          if (keys) cached = { revision, keys, expiresAt: Date.now() + CACHE_TTL_MS };
          return keys;
        })
        .finally(() => scans.delete(revision)),
    );
  }
  return scans.get(revision);
}

// The viewer's review state on a spec: `current` when their newest submitted review is on the head
// commit, `stale` when it is on an earlier one, `none` when they have no submitted review or the login
// or commit oid that would say which is missing.
function reviewState(node, viewer) {
  const mine = viewer ? node.reviews.nodes.filter((review) => login(review.author) === viewer) : [];
  const oid = mine.at(-1)?.commit?.oid;
  if (!oid || !node.headRefOid) return 'none';
  return oid === node.headRefOid ? 'current' : 'stale';
}

// The card data of one spec node. Its keys are the title's, in title order and without repeats.
function toSpec(node, viewer) {
  const author = login(node.author);
  return {
    number: node.number,
    title: node.title,
    url: node.url,
    author,
    draft: node.isDraft,
    keys: [...new Set(keysIn(node.title))],
    ageDays: Math.floor((Date.now() - Date.parse(node.createdAt)) / DAY_MS),
    reviewsByOthers: node.reviews.nodes.filter((review) => login(review.author) !== author).length,
    review: reviewState(node, viewer),
    reviewRequested: isReviewRequested(node, viewer),
  };
}

// Invalid counts throw before network work. Upstream failures answer unavailable with no specs.
export async function fetchSpecReviews({ snapshot, limit = DEFAULT_SPEC_LIMIT } = {}) {
  limit = parseSpecReviewLimit(limit);
  try {
    const config = captureConfiguration(snapshot);
    if (!config.credentials.githubToken) return unavailable();
    const scan = await scanSpecs(config, limit);
    if (!scan) return unavailable();
    const specs = [...scan.requested, ...scan.others.slice(0, limit)].map((node) =>
      toSpec(node, scan.viewer),
    );
    return {
      available: true,
      total: specs.length,
      specs,
      hasMore: scan.others.length > limit,
      updatedAt: new Date().toISOString(),
    };
  } catch (error) {
    return unavailable(error?.code === 'SPEC_SEARCH_LIMIT' ? 'search_limit' : undefined);
  }
}
