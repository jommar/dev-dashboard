// spec-reviews.test.mjs — the spec-review feed: which open ezat-specs PRs are listed, how a code PR
// hides one, what a failed lookup answers, and how many GitHub calls a load costs. `fetch` is a
// local GraphQL double, so nothing leaves the machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchSpecReviews, resetSpecReviewCache } from '../backend/spec-reviews.mjs';
import { API, snapshot } from './review-queue-fixture.mjs';

const NOW = Date.parse('2026-11-11T12:00:00Z');
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const SPEC_REPO = 'ezat-specs';
const CODE_REPOS = ['Portage-backend', 'Portage-frontend', 'TravelTracker'];
const TOP_LEVEL = ['available', 'total', 'specs', 'hasMore', 'updatedAt'];
const VIEWER = 'viewer-user';
const HEAD = 'oid-head';
const OLD_HEAD = 'oid-earlier';

// A submitted review node: who wrote it and the commit it was made on. GitHub lists them oldest first.
const review = (login, oid) => ({ author: { login }, commit: { oid } });

// A node of the spec query's answer: GitHub's own field names. `reviewers` are other people's
// reviews on an earlier commit; `reviews` are explicit nodes, appended in the order given.
const spec = (
  number,
  title,
  {
    author = 'alice',
    daysAgo = 1,
    reviewers = [],
    reviews = [],
    requestedReviewers = [],
    draft = false,
    head = HEAD,
    state = 'OPEN',
    labels = ['spec'],
  } = {},
) => ({
  number,
  __typename: 'PullRequest',
  title,
  url: `https://github.com/TransActComm/${SPEC_REPO}/pull/${number}`,
  isDraft: draft,
  createdAt: new Date(NOW - daysAgo * DAY_MS - 5 * 3_600_000).toISOString(),
  author: { login: author },
  headRefOid: head,
  state,
  labels: {
    nodes: labels.map((name) => ({ name })),
    pageInfo: { hasNextPage: false, endCursor: null },
  },
  reviews: { nodes: [...reviewers.map((login) => review(login, OLD_HEAD)), ...reviews] },
  reviewRequests: {
    nodes: requestedReviewers.map((requestedReviewer) => ({ requestedReviewer })),
    pageInfo: { hasNextPage: false, endCursor: null },
  },
});

// A node of the code-PR query's answer. `state` is what the double filters on, never selected.
const code = (title, headRefName, state = 'OPEN') => ({ title, headRefName, state });

const directlyRequested = (node) =>
  node.reviewRequests?.nodes.some(
    ({ requestedReviewer }) =>
      requestedReviewer?.__typename === 'User' && requestedReviewer.login === VIEWER,
  );

function searchSelections(query, variables = {}) {
  const selections = [];
  for (const [, name, args] of query.matchAll(/\b(requested|others)\s*:\s*search\(([^)]*)\)/g)) {
    const readArg = (key) => {
      const value = args.match(
        new RegExp(`\\b${key}\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|\\$\\w+|\\d+|\\w+)`),
      )?.[1];
      if (!value) return null;
      if (value.startsWith('$')) return variables[value.slice(1)];
      if (value.startsWith('"')) return JSON.parse(value);
      if (value === 'null') return null;
      return /^\d+$/.test(value) ? Number(value) : value;
    };
    selections.push({
      name,
      first: readArg('first'),
      after: readArg('after'),
      text: readArg('query'),
      type: readArg('type'),
    });
  }
  return selections;
}

function selectedConnection(query, name) {
  const match = new RegExp(`\\b${name}\\s*\\([^)]*\\)\\s*\\{`).exec(query);
  assert.ok(match, `the query selects ${name}`);
  const start = match.index + match[0].length;
  let depth = 1;
  for (let index = start; index < query.length; index += 1) {
    if (query[index] === '{') depth += 1;
    if (query[index] === '}') depth -= 1;
    if (depth === 0) return query.slice(start, index);
  }
  assert.fail(`unclosed ${name} selection`);
}

// Explicit pools model GitHub's search index, not eligibility: stale membership, closed and
// coded hits are deliberately returned. Only the network's first/cursor window is applied here.
function githubDouble(
  t,
  {
    specs = [],
    requested,
    others,
    codeByRepo = {},
    pagingRepo,
    codeReply,
    specReply,
    specPageInfo,
    viewer = { login: VIEWER },
  } = {},
) {
  const reply = { spec: specReply, code: codeReply };
  const posts = [];
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    assert.equal(String(input), `${API}/graphql`, 'only the GraphQL endpoint is called');
    assert.equal(init.method, 'POST');
    const { query, variables } = JSON.parse(init.body);
    if (query.includes(SPEC_REPO) || /\b(requested|others)\s*:\s*search\(/.test(query)) {
      const selections = searchSelections(query, variables);
      const post = { kind: 'spec', query, selections };
      posts.push(post);
      if (reply.spec) return reply.spec(post);
      assert.ok(
        selections.length,
        'spec discovery uses aliased GraphQL searches, not a repository scan',
      );
      const data = { viewer };
      for (const selection of selections) {
        const { name, first, after } = selection;
        assert.equal(selection.type, 'ISSUE');
        assert.ok(Number.isInteger(first) && first > 0 && first <= 100, 'a bounded candidate page');
        const pool =
          name === 'requested'
            ? (requested ?? specs.filter(directlyRequested))
            : (others ?? specs.filter((node) => !directlyRequested(node)));
        let offset = 0;
        if (after != null) {
          assert.match(after, new RegExp(`^${name}:\\d+$`), 'cursor belongs to this connection');
          offset = Number(after.split(':')[1]);
        }
        const nodes = pool.slice(offset, offset + first);
        const end = offset + nodes.length;
        data[name] = {
          issueCount: pool.length,
          nodes,
          pageInfo: specPageInfo ?? {
            hasNextPage: end < pool.length,
            endCursor: nodes.length ? `${name}:${end}` : null,
          },
        };
      }
      return Response.json({ data });
    }
    posts.push({ kind: 'code', query });
    if (reply.code) return reply.code();
    const asked = (query.match(/states\s*:\s*\[([^\]]*)\]/)?.[1] ?? '')
      .split(',')
      .map((state) => state.trim())
      .filter(Boolean);
    const data = {};
    const alias =
      /([A-Za-z_]\w*)\s*:\s*repository\(\s*owner\s*:\s*"TransActComm"\s*,\s*name\s*:\s*"([^"]+)"\s*\)/g;
    for (const [, name, repo] of query.matchAll(alias)) {
      const nodes = (codeByRepo[repo] ?? []).filter(
        ({ state }) => !asked.length || asked.includes(state),
      );
      data[name] = {
        pullRequests: {
          nodes,
          pageInfo:
            repo === pagingRepo
              ? { hasNextPage: true, endCursor: `cursor-${posts.length}` }
              : { hasNextPage: false, endCursor: null },
        },
      };
    }
    assert.ok(Object.keys(data).length > 0, 'the code-PR query names its repositories');
    return Response.json({ data });
  });
  return { posts, reply, count: (kind) => posts.filter((post) => post.kind === kind).length };
}

function startAt(t, now = NOW) {
  t.mock.timers.enable({ apis: ['Date'], now });
  resetSpecReviewCache();
  t.after(() => resetSpecReviewCache());
}

const load = (limit = 3) => fetchSpecReviews({ snapshot: snapshot(), limit });
const numbers = (result) => result.specs.map(({ number }) => number);

test('1. a keyed, uncoded spec is listed with its card data', async (t) => {
  startAt(t);
  githubDouble(t, {
    specs: [
      spec(321, '[TAP-100] Trip export spec', {
        author: 'alice',
        daysAgo: 3,
        reviewers: ['bob', 'bob', 'alice'],
      }),
    ],
  });
  const result = await load();
  assert.deepEqual(Object.keys(result).sort(), [...TOP_LEVEL].sort());
  assert.equal(result.available, true);
  assert.equal(result.total, 1);
  assert.equal(result.hasMore, false);
  assert.ok(Number.isFinite(Date.parse(result.updatedAt)));
  assert.deepEqual(result.specs, [
    {
      number: 321,
      title: '[TAP-100] Trip export spec',
      url: `https://github.com/TransActComm/${SPEC_REPO}/pull/321`,
      author: 'alice',
      draft: false,
      keys: ['TAP-100'],
      ageDays: 3,
      reviewsByOthers: 2,
      review: 'none',
      reviewRequested: false,
    },
  ]);
});

test('2. a spec with no ticket key is hidden', async (t) => {
  startAt(t);
  githubDouble(t, {
    specs: [spec(322, 'Spec process: review checklist'), spec(321, '[TAP-100] Trip export spec')],
  });
  const result = await load();
  assert.deepEqual(numbers(result), [321]);
  assert.equal(result.total, 1);
});

test('3. an open code PR naming the key in its title hides the spec', async (t) => {
  startAt(t);
  githubDouble(t, {
    specs: [spec(321, '[TAP-100] Trip export spec')],
    codeByRepo: { 'Portage-backend': [code('[TAP-100] Add export', 'feature/export')] },
  });
  const result = await load();
  assert.equal(result.available, true);
  assert.deepEqual(result.specs, []);
});

test('4. a merged code PR naming the key only in its branch hides the spec', async (t) => {
  startAt(t);
  githubDouble(t, {
    specs: [spec(321, '[TRIPS-200] Trip export spec')],
    codeByRepo: { TravelTracker: [code('Fix export', 'TRIPS-200-fix-export', 'MERGED')] },
  });
  const result = await load();
  assert.equal(result.available, true);
  assert.deepEqual(result.specs, []);
});

test('5. a closed, unmerged code PR does not hide the spec', async (t) => {
  startAt(t);
  const github = githubDouble(t, {
    specs: [spec(321, '[TAP-100] Trip export spec')],
    codeByRepo: { 'Portage-frontend': [code('[TAP-100] Abandoned', 'TAP-100-try', 'CLOSED')] },
  });
  const result = await load();
  assert.deepEqual(numbers(result), [321]);
  const [scan] = github.posts.filter(({ kind }) => kind === 'code');
  assert.match(scan.query, /states\s*:\s*\[\s*(?:OPEN\s*,\s*MERGED|MERGED\s*,\s*OPEN)\s*\]/);
  assert.doesNotMatch(scan.query, /CLOSED/);
  for (const repo of CODE_REPOS) assert.ok(scan.query.includes(`"${repo}"`), `asks ${repo}`);
});

test('6. a multi-key spec is hidden when any key is coded', async (t) => {
  startAt(t);
  githubDouble(t, {
    specs: [spec(331, '[TAP-3][TAP-4] Other spec'), spec(330, '[TAP-1][TAP-2] Shared spec')],
    codeByRepo: { 'Portage-backend': [code('[TAP-2] Part two', 'part-two', 'MERGED')] },
  });
  const result = await load();
  assert.deepEqual(numbers(result), [331]);
  assert.deepEqual(result.specs[0].keys, ['TAP-3', 'TAP-4']);
});

for (const [label, codeReply] of [
  ['HTTP 500', () => new Response('upstream down', { status: 500 })],
  ['a 200 with errors', () => Response.json({ errors: [{ message: 'synthetic failure' }] })],
]) {
  test(`7. a failed code-PR lookup lists nothing (${label}) and is not cached`, async (t) => {
    startAt(t);
    const github = githubDouble(t, {
      specs: [spec(321, '[TAP-100] Trip export spec')],
      codeReply,
    });
    const first = await load();
    assert.equal(first.available, false);
    assert.equal(first.total, 0);
    assert.deepEqual(first.specs, []);
    assert.ok(Number.isFinite(Date.parse(first.updatedAt)));
    assert.equal(github.count('code'), 1);
    const second = await load();
    assert.equal(second.available, false);
    assert.equal(github.count('code'), 2, 'the next load asks the code-PR query again');
  });
}

test('18. a cold load is two POSTs, a warm one is one, an expired one is two again', async (t) => {
  startAt(t);
  const github = githubDouble(t, { specs: [spec(321, '[TAP-100] Trip export spec')] });
  await load();
  assert.equal(github.posts.length, 2, 'cold: spec query plus one code-PR page');
  t.mock.timers.tick(MINUTE_MS);
  await load();
  assert.equal(github.posts.length, 3, 'within ten minutes: the spec query only');
  assert.equal(github.count('code'), 1);
  t.mock.timers.tick(10 * MINUTE_MS);
  await load();
  assert.equal(github.posts.length, 5, 'after ten minutes: both again');
  assert.equal(github.count('code'), 2);
});

test('18. a repo that keeps paging stops at ten pages without failing the load', async (t) => {
  startAt(t);
  const github = githubDouble(t, {
    specs: [spec(321, '[TAP-100] Trip export spec')],
    pagingRepo: 'TravelTracker',
  });
  const result = await load();
  assert.equal(github.count('code'), 10);
  assert.equal(github.posts.length, 11);
  assert.equal(result.available, true);
  assert.deepEqual(numbers(result), [321]);
});

for (const [label, specReply] of [
  ['HTTP 500', () => new Response('upstream down', { status: 500 })],
  ['a 200 with errors', () => Response.json({ errors: [{ message: 'synthetic failure' }] })],
]) {
  test(`a failed spec query lists nothing (${label}) and caches nothing`, async (t) => {
    startAt(t);
    const github = githubDouble(t, {
      specs: [spec(321, '[TAP-100] Trip export spec')],
      specReply,
    });
    const failed = await load();
    assert.equal(failed.available, false);
    assert.equal(failed.total, 0);
    assert.deepEqual(failed.specs, []);
    assert.equal(github.count('code'), 0, 'the code-PR scan is not reached');
    github.reply.spec = null;
    const recovered = await load();
    assert.equal(recovered.available, true);
    assert.deepEqual(numbers(recovered), [321]);
  });
}

test('no GitHub token gives an unavailable feed without a request', async (t) => {
  startAt(t);
  const github = githubDouble(t, { specs: [spec(321, '[TAP-100] Trip export spec')] });
  const result = await fetchSpecReviews({
    snapshot: snapshot({ credentials: { githubToken: '', jiraToken: '' } }),
  });
  assert.equal(result.available, false);
  assert.equal(result.total, 0);
  assert.deepEqual(result.specs, []);
  assert.deepEqual(github.posts, []);
});

test('a next requested page without a cursor gives an unavailable feed', async (t) => {
  startAt(t);
  githubDouble(t, {
    specs: [
      spec(321, '[TAP-100] Trip export spec', {
        requestedReviewers: [{ __typename: 'User', login: VIEWER }],
      }),
    ],
    specPageInfo: { hasNextPage: true, endCursor: null },
  });
  const result = await load();
  assert.equal(result.available, false);
  assert.deepEqual(result.specs, []);
});

test('two loads at once share one code-PR scan', async (t) => {
  startAt(t);
  const github = githubDouble(t, { specs: [spec(321, '[TAP-100] Trip export spec')] });
  const [first, second] = await Promise.all([load(), load()]);
  assert.equal(first.available, true);
  assert.deepEqual(numbers(second), [321]);
  assert.equal(github.count('code'), 1);
});

test('reviews by others count only submitted reviews, never pending ones', async (t) => {
  startAt(t);
  // The double returns what it is given, as GitHub would after the states filter: three submitted.
  const github = githubDouble(t, {
    specs: [spec(321, '[TAP-100] Trip export spec', { reviewers: ['bob', 'carol', 'alice'] })],
  });
  const result = await load();
  assert.equal(result.specs[0].reviewsByOthers, 2);
  const [first] = github.posts;
  const states = first.query.match(/reviews\([^)]*states\s*:\s*\[([^\]]*)\]/)?.[1];
  assert.ok(states, 'the spec query filters reviews by state');
  assert.doesNotMatch(states, /PENDING/);
});

// The viewer's own review state of a spec: whether they have a submitted review on the head commit.
const reviewOf = async (t, node, options = {}) => {
  startAt(t);
  githubDouble(t, { specs: [node], ...options });
  const result = await load();
  assert.equal(result.available, true);
  return result.specs[0].review;
};

test('19. a spec the viewer has not reviewed is none', async (t) => {
  const node = spec(321, '[TAP-100] Trip export spec');
  assert.equal(await reviewOf(t, node), 'none');
});

test('20. a viewer review on the head commit is current, however many earlier ones it follows', async (t) => {
  const node = spec(321, '[TAP-100] Trip export spec', {
    reviews: [review(VIEWER, OLD_HEAD), review(VIEWER, HEAD)],
  });
  assert.equal(await reviewOf(t, node), 'current');
});

test('21. a viewer review only on an earlier commit is stale', async (t) => {
  const node = spec(321, '[TAP-100] Trip export spec', {
    reviews: [review(VIEWER, OLD_HEAD)],
    head: 'oid-moved-on',
  });
  assert.equal(await reviewOf(t, node), 'stale');
});

test('22. another user reviewing the head commit leaves the viewer at none', async (t) => {
  const node = spec(321, '[TAP-100] Trip export spec', { reviews: [review('bob', HEAD)] });
  startAt(t);
  githubDouble(t, { specs: [node] });
  const result = await load();
  assert.equal(result.specs[0].review, 'none');
  assert.equal(result.specs[0].reviewsByOthers, 1, 'the count of others is unchanged');
});

for (const [label, viewer] of [
  ['no viewer at all', null],
  ['a viewer without a login', { login: null }],
]) {
  test(`23. ${label} fails closed rather than claiming all requested specs are known`, async (t) => {
    startAt(t);
    githubDouble(t, {
      viewer,
      specs: [
        spec(322, '[TAP-101] Other spec', {
          reviews: [review(VIEWER, HEAD)],
          requestedReviewers: [{ __typename: 'User', login: VIEWER }],
        }),
        spec(321, '[TAP-100] Trip export spec', { reviews: [review(VIEWER, OLD_HEAD)] }),
      ],
    });
    const result = await load();
    assert.equal(result.available, false);
    assert.equal(result.total, 0);
    assert.equal(result.hasMore, false);
    assert.deepEqual(result.specs, []);
  });
}

test('24. the spec query asks for the viewer, the head commit and each review commit', async (t) => {
  startAt(t);
  const github = githubDouble(t, { specs: [spec(321, '[TAP-100] Trip export spec')] });
  await load();
  const [first] = github.posts;
  assert.match(first.query, /viewer\s*\{\s*login\s*\}/);
  assert.match(first.query, /\bheadRefOid\b/);
  assert.match(first.query, /commit\s*\{\s*oid\s*\}/);
  assert.match(first.query, /reviews\(\s*last\s*:\s*100\b/, 'the newest reviews are the ones seen');
});

test('the spec query asks for direct User review requests', async (t) => {
  startAt(t);
  const github = githubDouble(t, { specs: [spec(321, '[TAP-100] Trip export spec')] });
  await load();
  assert.match(
    github.posts[0].query,
    /reviewRequests\(\s*first\s*:\s*100\s*\)\s*\{\s*nodes\s*\{\s*requestedReviewer\s*\{\s*__typename\s*\.\.\.\s*on\s*User\s*\{\s*login\s*\}/,
  );
});

test('a direct User request is true independently of none, current or stale review state', async (t) => {
  startAt(t);
  githubDouble(t, {
    specs: [
      spec(323, '[TAP-102] Unreviewed spec', {
        requestedReviewers: [{ __typename: 'User', login: VIEWER }],
      }),
      spec(322, '[TAP-101] Current review spec', {
        reviews: [review(VIEWER, HEAD)],
        requestedReviewers: [
          { __typename: 'User', login: 'bob' },
          { __typename: 'User', login: VIEWER },
        ],
      }),
      spec(321, '[TAP-100] Stale review spec', {
        reviews: [review(VIEWER, OLD_HEAD)],
        requestedReviewers: [{ __typename: 'User', login: VIEWER }],
      }),
    ],
  });
  const result = await load();
  assert.equal(result.available, true);
  assert.deepEqual(
    result.specs.map(({ review, reviewRequested }) => ({ review, reviewRequested })),
    [
      { review: 'none', reviewRequested: true },
      { review: 'current', reviewRequested: true },
      { review: 'stale', reviewRequested: true },
    ],
  );
  assert.ok(!JSON.stringify(result).includes(VIEWER), 'the feed does not expose the viewer login');
  assert.ok(!('reviewRequests' in result.specs[0]), 'the feed does not expose request lists');
});

test('other users, Teams and empty requests are false even after a viewer review', async (t) => {
  startAt(t);
  githubDouble(t, {
    specs: [
      spec(323, '[TAP-102] Other user request', {
        reviews: [review(VIEWER, HEAD)],
        requestedReviewers: [{ __typename: 'User', login: 'bob' }],
      }),
      spec(322, '[TAP-101] Team request', {
        reviews: [review(VIEWER, HEAD)],
        requestedReviewers: [{ __typename: 'Team', login: VIEWER }],
      }),
      spec(321, '[TAP-100] No requests', { reviews: [review(VIEWER, HEAD)] }),
    ],
  });
  const result = await load();
  assert.equal(result.available, true);
  assert.deepEqual(numbers(result), [323, 322, 321]);
  assert.deepEqual(
    result.specs.map(({ review, reviewRequested }) => ({ review, reviewRequested })),
    Array.from({ length: 3 }, () => ({ review: 'current', reviewRequested: false })),
  );
});

test('review requests are fresh on a warm fetch while the code-key scan stays cached', async (t) => {
  startAt(t);
  const node = spec(321, '[TAP-100] Trip export spec', {
    reviews: [review(VIEWER, OLD_HEAD)],
    requestedReviewers: [{ __typename: 'User', login: VIEWER }],
  });
  const github = githubDouble(t, { specs: [node] });
  const first = await load();
  assert.equal(first.specs[0].reviewRequested, true);
  node.reviewRequests.nodes = [];
  const second = await load();
  assert.equal(second.specs[0].reviewRequested, false);
  assert.equal(second.specs[0].review, 'stale');
  assert.equal(github.count('spec'), 2);
  assert.equal(github.count('code'), 1);
});

const mine = (number, options = {}) =>
  spec(number, `[TAP-${number}] Requested spec`, {
    requestedReviewers: [{ __typename: 'User', login: VIEWER }],
    ...options,
  });
const recent = (number, daysAgo = 1, options = {}) =>
  spec(number, `[TRIPS-${number}] Other spec`, {
    daysAgo,
    ...options,
  });
const assertUnavailable = (result, reason) => {
  assert.deepEqual(result, {
    available: false,
    total: 0,
    specs: [],
    hasMore: false,
    updatedAt: new Date(NOW).toISOString(),
    ...(reason ? { reason } : {}),
  });
};

test('paging: requested completeness rejects an in-page duplicate despite a matching raw count', async (t) => {
  startAt(t);
  const first = mine(1);
  const github = githubDouble(t, {
    requested: [first, structuredClone(first), mine(2)],
  });
  const result = await load();
  assert.equal(
    github.count('spec'),
    1,
    'the requested search reports three matches on one final page',
  );
  assert.equal(result.available, false, 'three raw hits with only two unique PRs are incomplete');
  assertUnavailable(result);
});

test('paging: requested completeness rejects partial overlap across advancing pages', async (t) => {
  startAt(t);
  const firstPage = Array.from({ length: 100 }, (_, index) =>
    mine(index + 1, { daysAgo: index + 1 }),
  );
  const github = githubDouble(t, {
    requested: [...firstPage, structuredClone(firstPage[99]), mine(101, { daysAgo: 101 })],
  });
  const result = await load();
  assert.equal(
    github.count('spec'),
    2,
    'both requested pages are fetched before declaring completeness',
  );
  assert.deepEqual(
    github.posts
      .filter(({ kind }) => kind === 'spec')
      .map(({ selections }) => selections.find(({ name }) => name === 'requested').after),
    [null, 'requested:100'],
  );
  assert.equal(result.available, false, '102 raw hits with only 101 unique PRs are incomplete');
  assertUnavailable(result);
});

test('paging: all requested specs precede exactly the three newest eligible others', async (t) => {
  startAt(t);
  githubDouble(t, {
    requested: [
      mine(401, { daysAgo: 1, draft: true }),
      mine(402, { daysAgo: 2, reviews: [review(VIEWER, HEAD)] }),
      mine(403, { daysAgo: 3, reviews: [review(VIEWER, OLD_HEAD)] }),
      mine(99, { daysAgo: 90 }),
      mine(404, { daysAgo: 91, state: 'CLOSED' }),
      mine(405, { daysAgo: 92, labels: [] }),
      mine(406, { daysAgo: 93 }),
    ],
    others: [
      spec(900, 'Process without a ticket key', { daysAgo: 0 }),
      recent(899, 0.1),
      recent(898, 0.2, { state: 'CLOSED' }),
      recent(897, 0.3, { labels: ['not-spec'] }),
      recent(501, 1),
      recent(502, 2),
      recent(503, 3),
      recent(504, 4),
      recent(505, 5),
    ],
    codeByRepo: { 'Portage-backend': [code('[TRIPS-899][TAP-406] Already implemented', 'coded')] },
  });
  const result = await load();
  assert.equal(result.available, true);
  assert.deepEqual(numbers(result), [401, 402, 403, 99, 501, 502, 503]);
  assert.equal(result.total, 7);
  assert.equal(result.hasMore, true);
  assert.deepEqual(
    result.specs.map(({ reviewRequested }) => reviewRequested),
    [true, true, true, true, false, false, false],
  );
  assert.deepEqual(
    result.specs.slice(0, 3).map(({ review }) => review),
    ['none', 'current', 'stale'],
  );
  assert.equal(result.specs[0].draft, true);
});

test('paging: expanded prefixes fill past filtered, duplicate and promoted hits and prove exact end', async (t) => {
  startAt(t);
  const withdrawn = recent(210, 8);
  const firstOther = recent(11, 1);
  const github = githubDouble(t, {
    requested: [withdrawn, mine(201, { daysAgo: 10 })],
    others: [
      spec(900, 'No ticket key', { daysAgo: 0 }),
      recent(899, 0.1),
      firstOther,
      structuredClone(firstOther),
      recent(12, 2),
      mine(202, { daysAgo: 2.5 }),
      recent(13, 3),
      recent(14, 4),
      recent(15, 5),
      recent(16, 6),
    ],
    codeByRepo: { TravelTracker: [code('TRIPS-899 implemented', 'coded', 'MERGED')] },
  });
  for (const [limit, expected, hasMore] of [
    [3, [202, 201, 11, 12, 13], true],
    [6, [202, 201, 11, 12, 13, 14, 15, 16], true],
    [9, [202, 201, 11, 12, 13, 14, 15, 16, 210], false],
  ]) {
    const before = github.posts.length;
    const result = await load(limit);
    assert.equal(result.available, true);
    assert.deepEqual(numbers(result), expected);
    assert.equal(result.total, expected.length);
    assert.equal(result.hasMore, hasMore);
    assert.equal(new Set(numbers(result)).size, result.total);
    const posts = github.posts.slice(before).filter(({ kind }) => kind === 'spec');
    assert.deepEqual(posts[0].selections.map(({ name, first }) => [name, first]).sort(), [
      ['others', limit + 1],
      ['requested', 100],
    ]);
    for (const post of posts.slice(1))
      assert.deepEqual(
        post.selections.map(({ name }) => name),
        ['others'],
        'complete requested connection is not re-fetched on continuation',
      );
    if (limit === 3) assert.ok(posts.length > 1, 'filtered default must fetch another page');
    if (limit === 3) {
      const calls = github.posts.slice(before);
      const codeIndex = calls.findIndex(({ kind }) => kind === 'code');
      const continuation = calls.findIndex(({ selections = [] }) =>
        selections.some(({ after }) => after),
      );
      assert.ok(
        codeIndex >= 0 && codeIndex < continuation,
        'cold code keys are obtained before selecting continuation work',
      );
    }
  }
  assert.equal(
    github.count('code'),
    1,
    'only the existing code-key cache is shared across windows',
  );
});

test('paging: complete requested pagination and fail closed on incomplete or search-limited discovery', async (t) => {
  await t.test(
    '101 requested matches include an old eligible mine beyond the first page',
    async (t) => {
      startAt(t);
      const requested = Array.from({ length: 101 }, (_, index) =>
        mine(1001 + index, { daysAgo: index + 1 }),
      );
      const others = [recent(1), recent(2, 2), recent(3, 3), recent(4, 4)];
      const github = githubDouble(t, { requested, others });
      const result = await load();
      assert.equal(result.available, true);
      assert.equal(result.total, 104);
      assert.deepEqual(numbers(result).slice(98), [1099, 1100, 1101, 1, 2, 3]);
      assert.equal(result.hasMore, true);
      const posts = github.posts.filter(({ kind }) => kind === 'spec');
      assert.equal(posts.length, 2);
      assert.deepEqual(
        posts[1].selections.map(({ name, first, after }) => [name, first, after]),
        [['requested', 100, 'requested:100']],
      );
      others.unshift(
        ...[301, 302, 303, 304].map((number) => spec(number, 'No ticket key', { daysAgo: 0 })),
      );
      const before = github.posts.length;
      const filtered = await load();
      assert.equal(filtered.available, true);
      assert.equal(filtered.total, 104);
      assert.deepEqual(numbers(filtered).slice(98), [1099, 1100, 1101, 1, 2, 3]);
      assert.equal(filtered.hasMore, true);
      const batched = github.posts.slice(before).filter(({ kind }) => kind === 'spec');
      assert.equal(batched.length, 2);
      assert.deepEqual(
        batched[1].selections.map(({ name }) => name).sort(),
        ['others', 'requested'],
        'both unfinished connections share the continuation POST',
      );
      assert.equal(github.count('code'), 1);
    },
  );

  const page = (
    nodes,
    issueCount = nodes.length,
    pageInfo = { hasNextPage: false, endCursor: null },
  ) => ({ nodes, issueCount, pageInfo });
  const response = (requested, others = page([])) =>
    Response.json({ data: { viewer: { login: VIEWER }, requested, others } });
  const firstRequestedPage = Array.from({ length: 100 }, (_, index) => mine(index + 1));
  for (const [label, options, reason] of [
    [
      'requested count exceeds the 1000-match ceiling',
      {
        requested: Array.from({ length: 1001 }, (_, index) =>
          mine(index + 1, { daysAgo: index + 1 }),
        ),
      },
      'search_limit',
    ],
    ['inconsistent requested count', { specReply: () => response(page([mine(1)], 2)) }],
    [
      'nonadvancing requested cursor',
      {
        specReply: () =>
          response(
            page(firstRequestedPage, 200, { hasNextPage: true, endCursor: 'requested:100' }),
          ),
      },
    ],
    [
      'later requested page fails',
      {
        specReply: ({ selections }) =>
          selections.some(({ after }) => after)
            ? new Response('upstream down', { status: 500 })
            : response(
                page(firstRequestedPage, 101, { hasNextPage: true, endCursor: 'requested:100' }),
              ),
      },
    ],
    ['missing request connection', { requested: [{ ...mine(1), reviewRequests: undefined }] }],
    [
      'truncated request connection',
      {
        requested: [
          {
            ...mine(1),
            reviewRequests: {
              nodes: [],
              pageInfo: { hasNextPage: true, endCursor: 'hidden-user' },
            },
          },
        ],
      },
    ],
    [
      'truncated label connection',
      {
        requested: [
          {
            ...mine(1),
            labels: {
              nodes: [{ name: 'spec' }],
              pageInfo: { hasNextPage: true, endCursor: 'hidden-label' },
            },
          },
        ],
      },
    ],
    ['unusable creation timestamp', { requested: [{ ...mine(1), createdAt: 'not-a-date' }] }],
    ['contradictory live copies', { requested: [mine(1)], others: [recent(1)] }],
    [
      'filtered others exceed the observable search ceiling',
      { others: Array.from({ length: 1001 }, (_, index) => spec(index + 1, 'No ticket key')) },
      'search_limit',
    ],
  ]) {
    await t.test(label, async (t) => {
      startAt(t);
      const github = githubDouble(t, options);
      assertUnavailable(await load(), reason);
      if (label === 'later requested page fails')
        assert.equal(
          github.count('spec'),
          2,
          'the failure occurs only after following requested pagination',
        );
      const examined = github.posts
        .flatMap(({ selections = [] }) => selections)
        .filter(({ name }) => name === 'others')
        .reduce((count, { first }) => count + first, 0);
      assert.ok(examined <= 1000, 'at most 1000 other candidates are requested');
    });
  }
  await t.test(
    'a proven small prefix can succeed despite more than 1000 other matches',
    async (t) => {
      startAt(t);
      githubDouble(t, {
        others: Array.from({ length: 1200 }, (_, index) => recent(index + 1, index + 1)),
      });
      const result = await load();
      assert.equal(result.available, true);
      assert.deepEqual(numbers(result), [1, 2, 3]);
      assert.equal(result.hasMore, true);
    },
  );
  await t.test('empty searches have a proven end even at limit 1000', async (t) => {
    startAt(t);
    githubDouble(t);
    const result = await load(1000);
    assert.equal(result.available, true);
    assert.deepEqual(numbers(result), []);
    assert.equal(result.hasMore, false);
  });
  await t.test(
    '1000 eligible others at a proven end are not an artificial truncation',
    async (t) => {
      startAt(t);
      githubDouble(t, {
        others: Array.from({ length: 1000 }, (_, index) => recent(index + 1, index + 1)),
      });
      const result = await load(1000);
      assert.equal(result.available, true);
      assert.equal(result.total, 1000);
      assert.deepEqual(numbers(result).slice(-3), [998, 999, 1000]);
      assert.equal(result.hasMore, false);
    },
  );
});

test('paging: invalid direct counts fail before any GitHub work', async (t) => {
  startAt(t);
  const github = githubDouble(t);
  for (const limit of [
    '',
    '03',
    '+3',
    '-3',
    '3.0',
    '3e0',
    ' 3 ',
    '0',
    '1001',
    0,
    -1,
    1.5,
    1001,
    NaN,
    null,
    true,
    [],
    {},
  ]) {
    await assert.rejects(
      fetchSpecReviews({ snapshot: snapshot(), limit }),
      { code: 'INVALID_SPEC_LIMIT' },
      `reject ${String(limit)}`,
    );
  }
  assert.deepEqual(github.posts, [], 'validation precedes spec and code integrations');
});

test('paging: a warm default batches selective searches and stops after four other candidates', async (t) => {
  startAt(t);
  const github = githubDouble(t, {
    requested: [mine(90, { daysAgo: 90 })],
    others: Array.from({ length: 100 }, (_, index) => recent(500 + index, index + 1)),
  });
  await load();
  const before = github.posts.length;
  const result = await load();
  assert.equal(result.available, true);
  assert.deepEqual(numbers(result), [90, 500, 501, 502]);
  assert.equal(result.hasMore, true);
  const posts = github.posts.slice(before);
  assert.equal(posts.length, 1, 'one warm spec POST, no code scan or full-feed paging');
  assert.deepEqual(
    posts[0].selections.map(({ name, first, after }) => [name, first, after]).sort(),
    [
      ['others', 4, null],
      ['requested', 100, null],
    ],
  );
  for (const selection of posts[0].selections) {
    const qualifiers = selection.text.split(/\s+/).sort();
    assert.deepEqual(
      qualifiers,
      [
        'repo:TransActComm/ezat-specs',
        'is:pr',
        'is:open',
        'label:spec',
        'sort:created-desc',
        selection.name === 'requested' ? 'user-review-requested:@me' : '-user-review-requested:@me',
      ].sort(),
    );
  }
  assert.match(posts[0].query, /\.\.\.\s*on\s*PullRequest\s*\{/);
  assert.match(posts[0].query, /\bissueCount\b/);
  assert.match(posts[0].query, /\bstate\b/);
  assert.match(posts[0].query, /\blabels\s*\(/);
  assert.match(selectedConnection(posts[0].query, 'labels'), /\bnodes\s*\{\s*name\s*\}/);
  for (const field of ['labels', 'reviewRequests']) {
    const selection = selectedConnection(posts[0].query, field);
    assert.match(selection, /\bpageInfo\s*\{/);
    assert.match(selection, /\bhasNextPage\b/);
    assert.match(selection, /\bendCursor\b/);
  }
  assert.equal(github.count('code'), 1);
  const changedRevision = await fetchSpecReviews({
    snapshot: snapshot({ revision: 'another-revision' }),
  });
  assert.equal(changedRevision.available, true);
  assert.deepEqual(numbers(changedRevision), [90, 500, 501, 502]);
  assert.equal(
    github.count('code'),
    2,
    'a captured configuration revision invalidates the code-key cache',
  );
});
