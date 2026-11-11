// spec-reviews.mjs — the Spec review lane's feed. It lists the open `spec`-labelled PRs of
// TransActComm/ezat-specs whose title names a TAP or TRIPS ticket, unless a code PR of that ticket
// (title or head branch) is open or merged in Portage-backend, Portage-frontend or TravelTracker.
//
// The code-PR keys come from one GraphQL scan, kept ten minutes per settings revision; the spec query
// is never cached. A failed query answers unavailable and caches nothing, so a coded spec is never
// listed because a lookup failed.

import { captureConfiguration } from './settings.mjs';
import { postGraphql } from './github-api.mjs';

const ORG = 'TransActComm';
const SPEC_REPO = 'ezat-specs';
const SPEC_LABEL = 'spec';
const CODE_REPOS = ['Portage-backend', 'Portage-frontend', 'TravelTracker'];
const PAGE_SIZE = 100;
const SPEC_PAGE_LIMIT = 3;
const CODE_PAGE_LIMIT = 10;
const CACHE_TTL_MS = 10 * 60_000;
const DAY_MS = 86_400_000;
const KEY_PATTERN = /(TAP|TRIPS)-[0-9]+/g;

// The URL of one ezat-specs pull request, as the spec review prompt names it.
export const specPrUrl = (pr) => `https://github.com/${ORG}/${SPEC_REPO}/pull/${pr}`;

const keysIn = (text) => text.match(KEY_PATTERN) ?? [];
const login = (actor) => actor?.login ?? null;
const after = (cursor) => (cursor ? `, after: ${JSON.stringify(cursor)}` : '');
const unavailable = () => ({
  available: false,
  total: 0,
  specs: [],
  updatedAt: new Date().toISOString(),
});

// One page of the open spec PRs, newest first, with the fields a card shows.
const specQuery = (cursor) => `query {
  repository(owner: "${ORG}", name: "${SPEC_REPO}") {
    pullRequests(first: ${PAGE_SIZE}, states: [OPEN], labels: ["${SPEC_LABEL}"], orderBy: {field: CREATED_AT, direction: DESC}${after(cursor)}) {
      nodes { number title url isDraft createdAt author { login } reviews(first: 100, states: [APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED]) { nodes { author { login } } } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

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

// Every open spec PR, in pages of 100 (three pages at most). Null when a page failed.
async function scanSpecs(config) {
  const nodes = [];
  let cursor;
  for (let page = 0; page < SPEC_PAGE_LIMIT; page += 1) {
    const data = await graphqlData(await postGraphql(config, specQuery(cursor)));
    const found = data?.repository?.pullRequests;
    if (!Array.isArray(found?.nodes)) return null;
    nodes.push(...found.nodes);
    if (!found.pageInfo?.hasNextPage) break;
    if (!found.pageInfo.endCursor) return null;
    cursor = found.pageInfo.endCursor;
  }
  return nodes;
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

// The card data of one spec node. Its keys are the title's, in title order and without repeats.
function toSpec(node) {
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
  };
}

// The Spec review feed. Never throws: a failure answers unavailable with no specs.
export async function fetchSpecReviews({ snapshot } = {}) {
  try {
    const config = captureConfiguration(snapshot);
    if (!config.credentials.githubToken) return unavailable();
    const nodes = await scanSpecs(config);
    if (!nodes) return unavailable();
    const coded = await codedKeys(config);
    if (!coded) return unavailable();
    const specs = nodes
      .map(toSpec)
      .filter(({ keys }) => keys.length > 0 && !keys.some((key) => coded.has(key)))
      .sort((a, b) => b.number - a.number);
    return { available: true, total: specs.length, specs, updatedAt: new Date().toISOString() };
  } catch {
    return unavailable();
  }
}
