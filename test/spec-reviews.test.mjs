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
const TOP_LEVEL = ['available', 'total', 'specs', 'updatedAt'];
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
  { author = 'alice', daysAgo = 1, reviewers = [], reviews = [], draft = false, head = HEAD } = {},
) => ({
  number,
  title,
  url: `https://github.com/TransActComm/${SPEC_REPO}/pull/${number}`,
  isDraft: draft,
  createdAt: new Date(NOW - daysAgo * DAY_MS - 5 * 3_600_000).toISOString(),
  author: { login: author },
  headRefOid: head,
  reviews: { nodes: [...reviewers.map((login) => review(login, OLD_HEAD)), ...reviews] },
});

// A node of the code-PR query's answer. `state` is what the double filters on, never selected.
const code = (title, headRefName, state = 'OPEN') => ({ title, headRefName, state });

// Answers `POST <api>/graphql` from the query text. A query naming the specs repo is the spec
// query (answer under `data.repository`); any other is the code-PR scan, one alias per repo in the
// form `<alias>: repository(owner: "TransActComm", name: "<repo>")`, answered per alias. A node
// whose `state` the query does not ask for is left out, as GitHub would. `pagingRepo` never runs out
// of pages. `codeReply` replaces the answer to every code-PR query. The spec answer carries the
// signed-in `viewer` beside `repository`; `viewer: null` is an answer without one.
function githubDouble(
  t,
  {
    specs = [],
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
    const { query } = JSON.parse(init.body);
    if (query.includes(SPEC_REPO)) {
      posts.push({ kind: 'spec', query });
      if (reply.spec) return reply.spec();
      return Response.json({
        data: {
          viewer,
          repository: {
            pullRequests: {
              nodes: specs,
              pageInfo: specPageInfo ?? { hasNextPage: false, endCursor: null },
            },
          },
        },
      });
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

const load = () => fetchSpecReviews({ snapshot: snapshot() });
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

test('a next spec page without a cursor gives an unavailable feed', async (t) => {
  startAt(t);
  githubDouble(t, {
    specs: [spec(321, '[TAP-100] Trip export spec')],
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
  test(`23. ${label} makes every spec none and does not throw`, async (t) => {
    startAt(t);
    githubDouble(t, {
      viewer,
      specs: [
        spec(322, '[TAP-101] Other spec', { reviews: [review(VIEWER, HEAD)] }),
        spec(321, '[TAP-100] Trip export spec', { reviews: [review(VIEWER, OLD_HEAD)] }),
      ],
    });
    const result = await load();
    assert.equal(result.available, true);
    assert.deepEqual(
      result.specs.map(({ review: state }) => state),
      ['none', 'none'],
    );
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
