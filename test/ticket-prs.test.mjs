import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchTicketPrs,
  prsByTicket,
  summarizeChecks,
  summarizeThreads,
} from '../backend/ticket-prs.mjs';
import { allPrsApproved } from '../ui/ticket-board.js';
import { deepFreeze } from '../e2e/deep-freeze.mjs';

const TOKEN = 'synthetic-ticket-prs-token-that-must-not-leak';
const API = 'https://api.github.example.invalid';
const snapshot = (overrides = {}) => ({
  github: { api: API, org: 'ExampleOrg', repos: ['app'], maxResults: 50 },
  credentials: { githubToken: TOKEN },
  ...overrides,
});

const run = (name, status, conclusion) => ({ __typename: 'CheckRun', name, status, conclusion });
const statusContext = (context, state) => ({ __typename: 'StatusContext', context, state });
const rollup = (state, nodes) => ({ state, contexts: { nodes } });
const review = (login, state, submittedAt) => ({ state, submittedAt, author: { login } });
const ZERO = { passed: 0, failed: 0, pending: 0, failing: [] };

test('summarizeChecks maps no rollup to none with zero counts', () => {
  for (const input of [null, undefined]) {
    assert.deepEqual(summarizeChecks(input), { state: 'none', ...ZERO });
  }
});

test('summarizeChecks reads SUCCESS as passing and counts passed, neutral and skipped checks', () => {
  assert.deepEqual(
    summarizeChecks(
      rollup('SUCCESS', [
        run('build', 'COMPLETED', 'SUCCESS'),
        run('docs', 'COMPLETED', 'NEUTRAL'),
        run('e2e', 'COMPLETED', 'SKIPPED'),
        statusContext('ci/legacy', 'SUCCESS'),
      ]),
    ),
    { state: 'passing', passed: 4, failed: 0, pending: 0, failing: [] },
  );
});

test('summarizeChecks reads FAILURE as failing and lists failed names in input order', () => {
  assert.deepEqual(
    summarizeChecks(
      rollup('FAILURE', [
        run('lint', 'COMPLETED', 'FAILURE'),
        run('build', 'COMPLETED', 'SUCCESS'),
        statusContext('ci/legacy', 'ERROR'),
        run('slow', 'IN_PROGRESS', null),
        run('timeout', 'COMPLETED', 'TIMED_OUT'),
        statusContext('ci/queue', 'PENDING'),
      ]),
    ),
    {
      state: 'failing',
      passed: 1,
      failed: 3,
      pending: 2,
      failing: ['lint', 'ci/legacy', 'timeout'],
    },
  );
});

test('summarizeChecks counts every failing conclusion and reads ERROR as failing', () => {
  const summary = summarizeChecks(
    rollup('ERROR', [
      run('cancelled', 'COMPLETED', 'CANCELLED'),
      run('manual', 'COMPLETED', 'ACTION_REQUIRED'),
      run('startup', 'COMPLETED', 'STARTUP_FAILURE'),
      run('stale', 'COMPLETED', 'STALE'),
    ]),
  );
  assert.equal(summary.state, 'failing');
  assert.equal(summary.failed, 4);
  assert.deepEqual(summary.failing, ['cancelled', 'manual', 'startup', 'stale']);
});

test('summarizeChecks reads PENDING, EXPECTED, unknown and missing states as pending', () => {
  const nodes = [
    run('build', 'QUEUED', null),
    statusContext('ci/pending', 'PENDING'),
    statusContext('ci/expected', 'EXPECTED'),
    run('ok', 'COMPLETED', 'SUCCESS'),
  ];
  for (const state of ['PENDING', 'EXPECTED', 'SOMETHING_NEW', undefined]) {
    assert.deepEqual(summarizeChecks(rollup(state, nodes)), {
      state: 'pending',
      passed: 1,
      failed: 0,
      pending: 3,
      failing: [],
    });
  }
});

test('summarizeChecks tolerates a rollup without contexts', () => {
  assert.deepEqual(summarizeChecks({ state: 'FAILURE' }), { state: 'failing', ...ZERO });
  assert.deepEqual(summarizeChecks({ state: 'SUCCESS', contexts: { nodes: [] } }), {
    state: 'passing',
    ...ZERO,
  });
});

const pr = (repo, number, tickets, updatedAt) => ({
  repo,
  number,
  title: `Change ${number}`,
  url: `https://github.com/${repo}/pull/${number}`,
  draft: false,
  updatedAt,
  tickets,
});
const ids = (list) => list.map((item) => `${item.repo}#${item.number}`);

test('prsByTicket lists a PR under every ticket it names, newest first, TRIPS folded to TAP', () => {
  const first = pr('ExampleOrg/app', 1, ['TAP-1', 'TRIPS-2'], '2026-10-01T10:00:00Z');
  const second = pr('ExampleOrg/web', 2, ['TAP-1'], '2026-10-02T10:00:00Z');
  const none = pr('ExampleOrg/app', 3, [], '2026-10-03T10:00:00Z');
  const both = pr('ExampleOrg/app', 4, ['TAP-3', 'TRIPS-3'], '2026-10-04T10:00:00Z');
  const other = pr('ExampleOrg/app', 5, ['DEMO-7'], '2026-10-05T10:00:00Z');
  const input = [first, second, none, both, other];
  const before = structuredClone(input);
  const result = prsByTicket(input);

  assert.deepEqual(Object.keys(result).sort(), ['DEMO-7', 'TAP-1', 'TAP-2', 'TAP-3']);
  assert.deepEqual(ids(result['TAP-1']), ['ExampleOrg/web#2', 'ExampleOrg/app#1']);
  assert.deepEqual(ids(result['TAP-2']), ['ExampleOrg/app#1']);
  assert.deepEqual(ids(result['TAP-3']), ['ExampleOrg/app#4'], 'TAP-3 and TRIPS-3 are one key');
  assert.deepEqual(ids(result['DEMO-7']), ['ExampleOrg/app#5'], 'other projects keep their key');
  assert.ok(
    Object.values(result).every((list) => ids(list).every((id, i, all) => all.indexOf(id) === i)),
    'no PR repeats within a key',
  );
  assert.ok(!JSON.stringify(result).includes('"number":3'), 'the unticketed PR is absent');
  assert.deepEqual(input, before, 'the input is left alone');
});

test('prsByTicket of nothing is an empty map', () => {
  assert.deepEqual(Object.keys(prsByTicket([])), []);
});

// -- fetchTicketPrs against a stubbed GitHub ---------------------------------------------------

const searchItem = (number, title, updatedAt, extra = {}) => ({
  number,
  title,
  user: { login: 'me' },
  html_url: `https://github.com/ExampleOrg/app/pull/${number}`,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: updatedAt,
  draft: false,
  labels: [],
  ...extra,
});
const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

// The query text names each PR in an alias; the stub reads those aliases back
// instead of assuming their numbering, so batching and alias style stay free.
function aliasesOf(query) {
  const found = new Map();
  const alias =
    /\b([A-Za-z_]\w*)\s*:\s*repository\(\s*owner:\s*("(?:[^"\\]|\\.)*")\s*,\s*name:\s*("(?:[^"\\]|\\.)*")\s*\)\s*\{\s*pullRequest\(\s*number:\s*(\d+)\s*\)/g;
  for (const match of query.matchAll(alias)) {
    found.set(match[1], `${JSON.parse(match[2])}/${JSON.parse(match[3])}#${match[4]}`);
  }
  return found;
}

// The fields a query selects, as nested objects, so the stub can tell a field selected on the pull
// request from one of the same name nested deeper (a thread's `comments`). Arguments and aliases
// are skipped; only field names and braces matter.
function selectionOf(query) {
  const tokens = query.replace(/\([^)]*\)/g, ' ').match(/[A-Za-z_]\w*|[{}]/g) ?? [];
  let at = 0;
  const readSet = () => {
    const fields = {};
    let last;
    while (at < tokens.length) {
      const token = tokens[at++];
      if (token === '}') break;
      if (token === '{') fields[last] = readSet();
      else {
        last = token;
        fields[last] ??= {};
      }
    }
    return fields;
  };
  return readSet();
}

// `pullRequests` maps `repo#number` to `{ reviews, rollup, threads, conversation, threadTotal,
// reviewsPageInfo }`. `reviewsPageInfo` is the `pageInfo` of the reviews connection (default
// `{ hasPreviousPage: false }`); like GitHub, the detail batch answers it only when its query
// selects `reviews { pageInfo { hasPreviousPage } }`.
// `forbidden` lists the keys whose check rollup GitHub refuses with a FORBIDDEN error entry.
//
// The review-and-CI batches and the comment batches are two lanes. A GraphQL body that reads
// `reviewThreads` is a comment batch: it is logged in `threadQueries` (its own indexes), answered
// from each PR's `threads` (a list of `thread(...)`, default none), `conversation` (the PR
// conversation comment count, default 0) and `threadTotal` (the thread total GitHub reports,
// default the number of threads given), and shaped by `options.threadsGraphql(call)` (return a
// Response to override), `options.failingThreads` (keys whose alias GitHub refuses),
// `options.partialThreads` (keys whose alias keeps its data but carries an error entry) and
// `options.threadErrors` (extra error entries). Like GitHub, a comment batch answers a PR's
// conversation total only when its query selects `comments { totalCount }` on the pull request
// itself. Every other GraphQL body is a detail batch and
// keeps `graphql` and its indexes, so a comment batch can never shift `stub.graphql[n]`.
// `maxInFlight` is the most requests ever open at once.
function stubGithub(t, options = {}) {
  const { login = 'me', items = [], total = items.length, pullRequests = {} } = options;
  const forbidden = new Set(options.forbidden || []);
  const failingThreads = new Set(options.failingThreads || []);
  const partialThreads = new Set(options.partialThreads || []);
  const calls = [];
  const graphql = [];
  const threadQueries = [];
  const unexpected = [];
  const stub = { calls, graphql, threadQueries, unexpected, maxInFlight: 0 };
  let inFlight = 0;
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = String(input);
    const call = { url, init, seq: calls.length };
    calls.push(call);
    inFlight += 1;
    stub.maxInFlight = Math.max(stub.maxInFlight, inFlight);
    try {
      // One turn of the event loop, so two requests that were not sent one after another overlap.
      await new Promise((resolve) => setImmediate(resolve));
      if (url.endsWith('/user')) return options.user ? options.user(call) : reply({ login });
      if (url.includes('/search/issues')) {
        return options.search ? options.search(call) : reply({ total_count: total, items });
      }
      if (url.endsWith('/graphql')) {
        const { query } = JSON.parse(init.body);
        call.query = query;
        call.aliases = aliasesOf(query);
        if (query.includes('reviewThreads')) {
          call.index = threadQueries.length;
          threadQueries.push(call);
          if (options.threadsGraphql) {
            const override = await options.threadsGraphql(call);
            if (override) return override;
          }
          const data = {};
          const errors = [];
          const selected = selectionOf(query).query?.repository?.pullRequest ?? {};
          for (const [alias, key] of call.aliases) {
            const spec = pullRequests[key] || {};
            const nodes = spec.threads || [];
            if (failingThreads.has(key)) {
              data[alias] = { pullRequest: null };
              errors.push({
                type: 'INTERNAL',
                path: [alias, 'pullRequest', 'reviewThreads'],
                message: 'thread detail upstream',
              });
              continue;
            }
            data[alias] = {
              pullRequest: {
                ...(selected.comments?.totalCount === undefined
                  ? {}
                  : { comments: { totalCount: spec.conversation ?? 0 } }),
                reviewThreads: { totalCount: spec.threadTotal ?? nodes.length, nodes },
              },
            };
            if (partialThreads.has(key)) {
              errors.push({
                type: 'INTERNAL',
                path: [alias, 'pullRequest', 'reviewThreads', 'nodes', 0, 'comments'],
                message: 'partial thread detail upstream',
              });
            }
          }
          for (const extra of options.threadErrors || []) errors.push(extra);
          return reply(errors.length ? { data, errors } : { data });
        }
        call.index = graphql.length;
        graphql.push(call);
        if (options.graphql) {
          const override = await options.graphql(call);
          if (override) return override;
        }
        const data = {};
        const errors = [];
        const reviewFields = selectionOf(query).query?.repository?.pullRequest?.reviews ?? {};
        for (const [alias, key] of call.aliases) {
          const spec = pullRequests[key] || {};
          data[alias] = {
            pullRequest: {
              reviewDecision: null,
              reviews: {
                nodes: spec.reviews || [],
                ...(reviewFields.pageInfo?.hasPreviousPage === undefined
                  ? {}
                  : {
                      pageInfo:
                        'reviewsPageInfo' in spec
                          ? spec.reviewsPageInfo
                          : { hasPreviousPage: false },
                    }),
              },
              commits: {
                nodes: [
                  {
                    commit: {
                      statusCheckRollup: forbidden.has(key) ? null : (spec.rollup ?? null),
                    },
                  },
                ],
              },
            },
          };
          if (forbidden.has(key)) {
            errors.push({
              type: 'FORBIDDEN',
              path: [alias, 'pullRequest', 'commits', 'nodes', 0, 'commit', 'statusCheckRollup'],
              message: 'Resource not accessible by personal access token (upstream detail)',
            });
          }
        }
        for (const extra of options.errors || []) errors.push(extra);
        return reply(errors.length ? { data, errors } : { data });
      }
      unexpected.push(url);
      return reply({ message: 'unexpected request' }, 500);
    } finally {
      inFlight -= 1;
    }
  });
  return stub;
}

// A review thread as GitHub returns it: resolved or not, its comment total and its first comment's
// author (`author` null is a deleted account; `undefined` is a thread with no readable first comment).
const user = (login) => ({ __typename: 'User', login });
const bot = (login) => ({ __typename: 'Bot', login });
const thread = (author, isResolved, comments = 2) => ({
  isResolved,
  comments: {
    totalCount: author === undefined ? 0 : comments,
    nodes: author === undefined ? [] : [{ author }],
  },
});
const BUCKET_ZERO = { threads: 0, unresolved: 0, comments: 0 };
const ZERO_COMMENTS = {
  human: BUCKET_ZERO,
  copilot: BUCKET_ZERO,
  other: BUCKET_ZERO,
  conversation: 0,
  threads: 0,
  truncated: false,
};
const NO_REVIEW_OR_CI = [null, null];

const authorizationOf = (init) => new Headers(init.headers).get('authorization');
const UNAVAILABLE = { available: false, login: null, total: 0, truncated: false, byTicket: {} };

test('fetchTicketPrs gives each ticket its PRs with review state and a CI summary', async (t) => {
  const stub = stubGithub(t, {
    items: [
      searchItem(11, '[TAP-9001] Fix lint rules', '2026-10-06T12:00:00Z'),
      searchItem(12, '[TAP-9001][TRIPS-9002] Shared change', '2026-10-07T12:00:00Z', {
        draft: true,
      }),
      searchItem(13, 'No ticket named here', '2026-10-08T12:00:00Z'),
    ],
    pullRequests: {
      'ExampleOrg/app#11': {
        reviews: [
          review('bob', 'APPROVED', '2026-10-02T00:00:00Z'),
          review('alice', 'COMMENTED', '2026-10-03T00:00:00Z'),
        ],
        rollup: rollup('FAILURE', [
          run('lint', 'COMPLETED', 'FAILURE'),
          run('unit', 'COMPLETED', 'SUCCESS'),
          statusContext('ci/legacy', 'ERROR'),
        ]),
      },
      'ExampleOrg/app#12': {
        reviews: [review('carol', 'CHANGES_REQUESTED', '2026-10-02T00:00:00Z')],
        rollup: rollup('PENDING', [
          run('build', 'IN_PROGRESS', null),
          run('lint', 'COMPLETED', 'SUCCESS'),
        ]),
      },
    },
  });
  const result = await fetchTicketPrs({ snapshot: snapshot() });

  assert.deepEqual(stub.unexpected, []);
  assert.equal(result.available, true);
  assert.equal(result.login, 'me');
  assert.equal(result.total, 3);
  assert.equal(result.truncated, false);
  assert.deepEqual(Object.keys(result.byTicket).sort(), ['TAP-9001', 'TAP-9002']);

  const lint = {
    repo: 'ExampleOrg/app',
    number: 11,
    title: '[TAP-9001] Fix lint rules',
    url: 'https://github.com/ExampleOrg/app/pull/11',
    draft: false,
    updatedAt: '2026-10-06T12:00:00Z',
    review: { state: 'approved', approvals: 1 },
    ci: { state: 'failing', passed: 1, failed: 2, pending: 0, failing: ['lint', 'ci/legacy'] },
    comments: ZERO_COMMENTS,
  };
  const shared = {
    repo: 'ExampleOrg/app',
    number: 12,
    title: '[TAP-9001][TRIPS-9002] Shared change',
    url: 'https://github.com/ExampleOrg/app/pull/12',
    draft: true,
    updatedAt: '2026-10-07T12:00:00Z',
    review: { state: 'changes_requested', approvals: 0 },
    ci: { state: 'pending', passed: 1, failed: 0, pending: 1, failing: [] },
    comments: ZERO_COMMENTS,
  };
  assert.deepEqual([...result.byTicket['TAP-9001']], [shared, lint], 'newest update first');
  assert.deepEqual([...result.byTicket['TAP-9002']], [shared]);
});

test('fetchTicketPrs reads a PR with no reviews as awaiting and a PR with no checks as none', async (t) => {
  stubGithub(t, {
    items: [searchItem(21, '[TAP-1] Quiet change', '2026-10-06T12:00:00Z')],
    pullRequests: { 'ExampleOrg/app#21': { reviews: [], rollup: null } },
  });
  const result = await fetchTicketPrs({ snapshot: snapshot() });
  const [quiet] = result.byTicket['TAP-1'];
  assert.deepEqual(quiet.review, { state: 'awaiting', approvals: 0 });
  assert.deepEqual(quiet.ci, { state: 'none', ...ZERO });
});

test('fetchTicketPrs reads a standing change request as changes_requested beside another approval', async (t) => {
  stubGithub(t, {
    items: [
      searchItem(1, '[TAP-1] Approved after the request', '2026-10-06T12:00:00Z'),
      searchItem(2, '[TAP-2] Approved before the request', '2026-10-05T12:00:00Z'),
    ],
    pullRequests: {
      'ExampleOrg/app#1': {
        reviews: [
          review('alice', 'CHANGES_REQUESTED', '2026-10-02T00:00:00Z'),
          review('bob', 'APPROVED', '2026-10-03T00:00:00Z'),
        ],
      },
      'ExampleOrg/app#2': {
        reviews: [
          review('bob', 'APPROVED', '2026-10-02T00:00:00Z'),
          review('alice', 'CHANGES_REQUESTED', '2026-10-03T00:00:00Z'),
        ],
      },
    },
  });
  const result = await fetchTicketPrs({ snapshot: snapshot() });
  const [after] = result.byTicket['TAP-1'];
  const [before] = result.byTicket['TAP-2'];
  assert.deepEqual(after.review, { state: 'changes_requested', approvals: 1 });
  assert.deepEqual(before.review, { state: 'changes_requested', approvals: 1 });
});

test('a FORBIDDEN error on one PR check rollup nulls only that PR CI and keeps its review', async (t) => {
  stubGithub(t, {
    items: [
      searchItem(1, '[TAP-1] Readable', '2026-10-06T12:00:00Z'),
      searchItem(2, '[TAP-2] Token cannot read checks', '2026-10-05T12:00:00Z'),
      searchItem(3, '[TAP-3] No checks at all', '2026-10-04T12:00:00Z'),
    ],
    forbidden: ['ExampleOrg/app#2'],
    pullRequests: {
      'ExampleOrg/app#1': {
        reviews: [],
        rollup: rollup('SUCCESS', [run('build', 'COMPLETED', 'SUCCESS')]),
      },
      'ExampleOrg/app#2': {
        reviews: [review('bob', 'APPROVED', '2026-10-02T00:00:00Z')],
        rollup: rollup('SUCCESS', [run('build', 'COMPLETED', 'SUCCESS')]),
      },
    },
  });
  const result = await fetchTicketPrs({ snapshot: snapshot() });
  assert.equal(result.available, true);
  const [readable] = result.byTicket['TAP-1'];
  const [forbiddenPr] = result.byTicket['TAP-2'];
  const [quiet] = result.byTicket['TAP-3'];
  assert.equal(readable.ci.state, 'passing');
  assert.equal(forbiddenPr.ci, null, 'an unreadable CI is null, not none');
  assert.deepEqual(forbiddenPr.review, { state: 'approved', approvals: 1 });
  assert.equal(quiet.ci.state, 'none', 'a missing rollup without an error is none');
  assert.ok(!JSON.stringify(result).includes('upstream detail'), 'no upstream error text');
});

test('an unrelated GraphQL error entry drops nothing', async (t) => {
  stubGithub(t, {
    items: [searchItem(1, '[TAP-1] Change', '2026-10-06T12:00:00Z')],
    errors: [{ type: 'INTERNAL', message: 'something odd upstream' }],
    pullRequests: {
      'ExampleOrg/app#1': {
        reviews: [review('bob', 'APPROVED', '2026-10-02T00:00:00Z')],
        rollup: rollup('SUCCESS', [run('build', 'COMPLETED', 'SUCCESS')]),
      },
    },
  });
  const result = await fetchTicketPrs({ snapshot: snapshot() });
  const [change] = result.byTicket['TAP-1'];
  assert.deepEqual(change.review, { state: 'approved', approvals: 1 });
  assert.equal(change.ci.state, 'passing');
  assert.ok(!JSON.stringify(result).includes('something odd upstream'));
});

for (const [name, graphql] of [
  ['a non-OK response', () => reply({ message: `Bad credentials ${TOKEN}` }, 502)],
  [
    'a network error',
    () => {
      throw new Error(`socket hang up for ${TOKEN}`);
    },
  ],
  ['a body without data', () => reply({ errors: [{ message: 'schema went away' }] })],
]) {
  test(`${name} on the GraphQL batch lists the PRs with null review and CI`, async (t) => {
    stubGithub(t, {
      items: [
        searchItem(1, '[TAP-1] First', '2026-10-06T12:00:00Z'),
        searchItem(2, '[TAP-2] Second', '2026-10-05T12:00:00Z'),
      ],
      graphql,
    });
    const result = await fetchTicketPrs({ snapshot: snapshot() });
    assert.equal(result.available, true);
    assert.deepEqual(Object.keys(result.byTicket).sort(), ['TAP-1', 'TAP-2']);
    for (const list of Object.values(result.byTicket)) {
      for (const item of list) {
        assert.equal(item.review, null);
        assert.equal(item.ci, null);
      }
    }
    const text = JSON.stringify(result);
    for (const secret of [TOKEN, 'Bad credentials', 'socket hang up', 'schema went away']) {
      assert.ok(!text.includes(secret), `the result never carries "${secret}"`);
    }
  });
}

test('a failed batch leaves the PRs of the other batches intact', async (t) => {
  const items = Array.from({ length: 60 }, (_, i) =>
    searchItem(
      i + 1,
      `[TAP-${i + 1}] Change ${i + 1}`,
      `2026-10-06T12:${String(i).padStart(2, '0')}:00Z`,
    ),
  );
  const approved = {
    reviews: [review('bob', 'APPROVED', '2026-10-02T00:00:00Z')],
    rollup: rollup('SUCCESS', [run('build', 'COMPLETED', 'SUCCESS')]),
  };
  const pullRequests = Object.fromEntries(
    items.map((item) => [`ExampleOrg/app#${item.number}`, approved]),
  );
  const stub = stubGithub(t, {
    items,
    pullRequests,
    graphql: (call) => (call.index === 0 ? reply({ message: 'down' }, 503) : null),
  });
  const result = await fetchTicketPrs({ snapshot: snapshot() });
  assert.equal(stub.graphql.length, 2, '60 PRs take two batches');
  const failed = new Set(stub.graphql[0].aliases.values());
  const served = new Set(stub.graphql[1].aliases.values());
  assert.ok(failed.size > 0 && served.size > 0);
  for (const list of Object.values(result.byTicket)) {
    for (const item of list) {
      const key = `${item.repo}#${item.number}`;
      if (failed.has(key)) assert.deepEqual([item.review, item.ci], [null, null], key);
      else {
        assert.ok(served.has(key), `${key} was in a batch`);
        assert.equal(item.review.state, 'approved', key);
        assert.equal(item.ci.state, 'passing', key);
      }
    }
  }
});

test('fetchTicketPrs degrades to available false when the user, search or token is missing', async (t) => {
  const cases = [
    ['no token', {}, snapshot({ credentials: { githubToken: '' } })],
    ['a failing /user', { user: () => reply({ message: `no ${TOKEN}` }, 401) }, snapshot()],
    ['a failing search', { search: () => reply({ message: `no ${TOKEN}` }, 500) }, snapshot()],
    [
      'a network error',
      {
        search: () => {
          throw new Error(`offline ${TOKEN}`);
        },
      },
      snapshot(),
    ],
  ];
  for (const [name, options, snap] of cases) {
    const stub = stubGithub(t, {
      items: [searchItem(1, '[TAP-1] x', '2026-10-06T12:00:00Z')],
      ...options,
    });
    const result = await fetchTicketPrs({ snapshot: snap });
    assert.deepEqual(result, UNAVAILABLE, name);
    assert.equal(stub.graphql.length, 0, `${name}: no GraphQL request`);
    assert.ok(!JSON.stringify(result).includes(TOKEN), name);
    t.mock.restoreAll();
  }
});

test('total_count above the returned PRs marks the result truncated', async (t) => {
  const items = Array.from({ length: 50 }, (_, i) =>
    searchItem(i + 1, `[TAP-${i + 1}] Change`, '2026-10-06T12:00:00Z'),
  );
  stubGithub(t, { items, total: 60 });
  const cut = await fetchTicketPrs({ snapshot: snapshot() });
  assert.equal(cut.truncated, true);
  assert.equal(cut.total, 60);
  t.mock.restoreAll();

  stubGithub(t, { items: items.slice(0, 2), total: 2 });
  const whole = await fetchTicketPrs({ snapshot: snapshot() });
  assert.equal(whole.truncated, false);
  assert.equal(whole.total, 2);
});

test('no open PRs means no GraphQL request and an empty map', async (t) => {
  const stub = stubGithub(t, { items: [], total: 0 });
  const result = await fetchTicketPrs({ snapshot: snapshot() });
  assert.equal(stub.graphql.length, 0);
  assert.equal(stub.threadQueries.length, 0, 'no comment batch either');
  assert.deepEqual(result, {
    available: true,
    login: 'me',
    total: 0,
    truncated: false,
    byTicket: {},
  });
});

test('a poll costs one /user, one search, and per 50 PRs one detail POST and one comment POST, each guarded', async (t) => {
  const items = Array.from({ length: 120 }, (_, i) =>
    searchItem(i + 1, `[TAP-${i + 1}] Change ${i + 1}`, '2026-10-06T12:00:00Z'),
  );
  const timeouts = [];
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', (ms) => {
    timeouts.push(ms);
    return realTimeout(ms);
  });
  const stub = stubGithub(t, { items });
  const result = await fetchTicketPrs({ snapshot: snapshot() });

  assert.deepEqual(stub.unexpected, []);
  assert.equal(stub.calls.length, 8, '1 /user + 1 search + 3 detail + 3 comment POSTs');
  assert.equal(stub.calls.filter((call) => call.url.endsWith('/user')).length, 1);
  const searches = stub.calls.filter((call) => call.url.includes('/search/issues'));
  assert.equal(searches.length, 1);
  const search = decodeURIComponent(searches[0].url);
  assert.match(search, /author:me/);
  assert.doesNotMatch(search, /-author:/, 'my PRs only');

  assert.equal(stub.graphql.length, 3, 'three detail POSTs');
  assert.equal(stub.threadQueries.length, 3, 'three comment POSTs');
  assert.equal(stub.maxInFlight, 1, 'never two GitHub requests open at once');
  assert.ok(
    Math.max(...stub.graphql.map((call) => call.seq)) <
      Math.min(...stub.threadQueries.map((call) => call.seq)),
    'the comment POSTs follow the detail POSTs',
  );
  for (const lane of [stub.graphql, stub.threadQueries]) {
    assert.deepEqual(
      lane.map((call) => call.aliases.size).sort((a, b) => b - a),
      [50, 50, 20],
    );
    const covered = lane.flatMap((call) => [...call.aliases.values()]);
    assert.equal(new Set(covered).size, 120, 'every PR is read exactly once');
  }
  for (const call of [...stub.graphql, ...stub.threadQueries]) {
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.redirect, 'error');
    assert.ok(call.init.signal instanceof AbortSignal, 'a timeout signal');
    assert.equal(authorizationOf(call.init), `Bearer ${TOKEN}`);
  }
  for (const call of stub.graphql) {
    for (const field of [
      'statusCheckRollup',
      'commits(last: 1)',
      'contexts(first: 100)',
      'reviews(last: 100)',
    ]) {
      assert.ok(call.query.includes(field), `the detail query reads ${field}`);
    }
  }
  for (const call of stub.threadQueries) {
    for (const field of [
      'reviewThreads(first: 50)',
      'isResolved',
      'comments(first: 1)',
      'totalCount',
      '__typename',
      'login',
    ]) {
      assert.ok(call.query.includes(field), `the comment query reads ${field}`);
    }
    assert.ok(!call.query.includes('statusCheckRollup'), 'checks stay out of the comment query');
    assert.ok(!call.query.includes('reviews(last'), 'reviews stay out of the comment query');
  }
  assert.ok(timeouts.filter((ms) => ms === 15_000).length >= 6, 'each POST has a 15 s timeout');
  assert.ok(timeouts.every((ms) => ms <= 15_000));
  assert.equal(Object.keys(result.byTicket).length, 120);
  assert.ok(!JSON.stringify(result).includes(TOKEN), 'the token never reaches the result');
});

test('a PR under a non-TAP project key lands under that key as typed', async (t) => {
  stubGithub(t, {
    items: [searchItem(31, '[PRT-1543] Portal change', '2026-10-06T12:00:00Z')],
    pullRequests: {
      'ExampleOrg/app#31': {
        reviews: [review('bob', 'APPROVED', '2026-10-02T00:00:00Z')],
        rollup: rollup('SUCCESS', [run('build', 'COMPLETED', 'SUCCESS')]),
      },
    },
  });
  const result = await fetchTicketPrs({ snapshot: snapshot() });
  assert.deepEqual(Object.keys(result.byTicket), ['PRT-1543']);
  assert.deepEqual(ids(result.byTicket['PRT-1543']), ['ExampleOrg/app#31']);
});

test('a check name shared by two jobs is listed once while each job is still counted', () => {
  assert.deepEqual(
    summarizeChecks(
      rollup('FAILURE', [
        run('lint', 'COMPLETED', 'FAILURE'),
        run('lint', 'COMPLETED', 'TIMED_OUT'),
        statusContext('ci/legacy', 'ERROR'),
      ]),
    ),
    { state: 'failing', passed: 0, failed: 3, pending: 0, failing: ['lint', 'ci/legacy'] },
  );
});

// A fetch that only ends when its signal aborts, as a stalled GitHub connection does.
const neverAnswers = ({ init }) =>
  new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  });

test('a /user call that never answers ends as available false instead of hanging', async (t) => {
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', () => realTimeout(20));
  const stub = stubGithub(t, {
    items: [searchItem(1, '[TAP-1] x', '2026-10-06T12:00:00Z')],
    user: neverAnswers,
  });
  assert.deepEqual(await fetchTicketPrs({ snapshot: snapshot() }), UNAVAILABLE);
  assert.ok(stub.calls[0].init.signal instanceof AbortSignal, '/user has a timeout signal');
  assert.equal(stub.graphql.length, 0);
});

test('a search that never answers ends as available false instead of hanging', async (t) => {
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', () => realTimeout(20));
  const stub = stubGithub(t, {
    items: [searchItem(1, '[TAP-1] x', '2026-10-06T12:00:00Z')],
    search: neverAnswers,
  });
  assert.deepEqual(await fetchTicketPrs({ snapshot: snapshot() }), UNAVAILABLE);
  const [search] = stub.calls.filter((call) => call.url.includes('/search/issues'));
  assert.ok(search.init.signal instanceof AbortSignal, 'the search has a timeout signal');
  assert.equal(stub.graphql.length, 0);
});

const searches = (stub) => stub.calls.filter((call) => call.url.includes('/search/issues'));
const oneItem = [searchItem(1, '[TAP-1] x', '2026-10-06T12:00:00Z')];

test('concurrent calls for one revision share a single upstream fetch', async (t) => {
  const stub = stubGithub(t, { items: oneItem });
  const [first, second] = await Promise.all([
    fetchTicketPrs({ snapshot: snapshot({ revision: 7 }) }),
    fetchTicketPrs({ snapshot: snapshot({ revision: 7 }) }),
  ]);
  assert.equal(searches(stub).length, 1);
  assert.deepEqual(second, first);
});

test('concurrent calls for one revision share the comment batches as well', async (t) => {
  const stub = stubGithub(t, { items: oneItem });
  await Promise.all([
    fetchTicketPrs({ snapshot: snapshot({ revision: 7 }) }),
    fetchTicketPrs({ snapshot: snapshot({ revision: 7 }) }),
  ]);
  assert.equal(stub.graphql.length, 1);
  assert.equal(stub.threadQueries.length, 1, 'one load, one comment batch');
});

test('a call after the shared fetch settles starts a new upstream fetch', async (t) => {
  const stub = stubGithub(t, { items: oneItem });
  await fetchTicketPrs({ snapshot: snapshot({ revision: 7 }) });
  await fetchTicketPrs({ snapshot: snapshot({ revision: 7 }) });
  assert.equal(searches(stub).length, 2);
});

test('a different settings revision does not share an in-flight fetch', async (t) => {
  const stub = stubGithub(t, { items: oneItem });
  await Promise.all([
    fetchTicketPrs({ snapshot: snapshot({ revision: 8 }) }),
    fetchTicketPrs({ snapshot: snapshot({ revision: 9 }) }),
  ]);
  assert.equal(searches(stub).length, 2);
});

test('search items with a fractional or string number never reach the GraphQL query', async (t) => {
  const stub = stubGithub(t, {
    items: [
      searchItem(1, '[TAP-1] Real', '2026-10-06T12:00:00Z'),
      searchItem(2, '[TAP-2] Fractional', '2026-10-05T12:00:00Z', { number: 2.5 }),
      searchItem(3, '[TAP-3] String', '2026-10-04T12:00:00Z', { number: '3' }),
    ],
    pullRequests: { 'ExampleOrg/app#1': { reviews: [], rollup: null } },
  });
  const result = await fetchTicketPrs({ snapshot: snapshot() });
  assert.deepEqual(Object.keys(result.byTicket), ['TAP-1']);
  assert.deepEqual(
    stub.graphql.flatMap((call) => [...call.aliases.values()]),
    ['ExampleOrg/app#1'],
  );
  assert.deepEqual(
    stub.threadQueries.flatMap((call) => [...call.aliases.values()]),
    ['ExampleOrg/app#1'],
    'the comment query holds the same guard',
  );
});

test('search items whose URL is not a github.com pull page never reach the board', async (t) => {
  const stub = stubGithub(t, {
    items: [
      searchItem(1, '[TAP-1] Real', '2026-10-06T12:00:00Z'),
      searchItem(4, '[TAP-4] Scheme', '2026-10-05T12:00:00Z', {
        html_url: 'javascript:alert(1)',
      }),
      searchItem(5, '[TAP-5] Plain http', '2026-10-04T12:00:00Z', {
        html_url: 'http://github.com/ExampleOrg/app/pull/5',
      }),
      searchItem(6, '[TAP-6] Look-alike host', '2026-10-03T12:00:00Z', {
        html_url: 'https://github.com.evil.example/ExampleOrg/app/pull/6',
      }),
    ],
    pullRequests: { 'ExampleOrg/app#1': { reviews: [], rollup: null } },
  });
  const result = await fetchTicketPrs({ snapshot: snapshot() });
  assert.deepEqual(Object.keys(result.byTicket), ['TAP-1']);
  assert.deepEqual(
    stub.graphql.flatMap((call) => [...call.aliases.values()]),
    ['ExampleOrg/app#1'],
  );
  assert.deepEqual(
    stub.threadQueries.flatMap((call) => [...call.aliases.values()]),
    ['ExampleOrg/app#1'],
    'the comment query holds the same guard',
  );
  const text = JSON.stringify(result);
  for (const bad of ['javascript:', 'http://', 'evil.example']) {
    assert.ok(!text.includes(bad), `the result never carries "${bad}"`);
  }
});

// -- summarizeThreads buckets review threads by who started them -------------------------------------

const pullRequestOf = (threads, { conversation = 0, total } = {}) => ({
  comments: { totalCount: conversation },
  reviewThreads: { totalCount: total ?? threads.length, nodes: threads },
});

test('summarizeThreads buckets threads by their first comment author and sums unresolved and comments', () => {
  const input = pullRequestOf(
    [
      thread(user('alice'), false, 3),
      thread(user('bob'), true, 2),
      thread(bot('copilot-pull-request-reviewer[bot]'), false, 4),
      thread(bot('Copilot'), true, 6),
      thread(bot('dependabot'), false, 2),
      thread(null, true, 5),
    ],
    { conversation: 3 },
  );
  assert.deepEqual(summarizeThreads(input), {
    human: { threads: 2, unresolved: 1, comments: 5 },
    copilot: { threads: 2, unresolved: 1, comments: 10 },
    other: { threads: 2, unresolved: 1, comments: 7 },
    conversation: 3,
    threads: 6,
    truncated: false,
  });
});

test('summarizeThreads reads every Copilot reviewer login as Copilot, with or without [bot] and in any case', () => {
  for (const login of [
    'copilot-pull-request-reviewer[bot]',
    'copilot-pull-request-reviewer',
    'Copilot',
    'copilot',
    'copilot[bot]',
    'COPILOT-PULL-REQUEST-REVIEWER[BOT]',
  ]) {
    const summary = summarizeThreads(pullRequestOf([thread(bot(login), false, 2)]));
    assert.deepEqual(summary.copilot, { threads: 1, unresolved: 1, comments: 2 }, login);
    assert.deepEqual(summary.human, BUCKET_ZERO, login);
    assert.deepEqual(summary.other, BUCKET_ZERO, login);
  }
});

test('summarizeThreads reads a person as human and keeps look-alike logins out of the Copilot bucket', () => {
  for (const login of [
    'alice',
    'copilot-fan',
    'my-copilot',
    'copilots',
    'copilot-pull-request-reviewers',
  ]) {
    const summary = summarizeThreads(pullRequestOf([thread(user(login), true, 2)]));
    assert.deepEqual(summary.human, { threads: 1, unresolved: 0, comments: 2 }, login);
    assert.deepEqual(summary.copilot, BUCKET_ZERO, login);
  }
});

test('summarizeThreads files other bots, other account types, deleted accounts and unreadable first comments under other', () => {
  const others = [
    thread(bot('dependabot'), false, 2),
    thread(bot('github-actions'), true, 3),
    thread({ __typename: 'Mannequin', login: 'imported-user' }, false, 2),
    thread({ __typename: 'Organization', login: 'ExampleOrg' }, true, 2),
    thread(null, false, 4),
    thread(undefined, true),
  ];
  const summary = summarizeThreads(pullRequestOf(others));
  assert.deepEqual(summary.other, { threads: 6, unresolved: 3, comments: 13 });
  assert.deepEqual(summary.human, BUCKET_ZERO);
  assert.deepEqual(summary.copilot, BUCKET_ZERO);
  assert.equal(summary.threads, 6);
});

test('summarizeThreads counts resolved and unresolved threads from isResolved', () => {
  const summary = summarizeThreads(
    pullRequestOf([
      thread(user('alice'), true, 2),
      thread(user('alice'), true, 2),
      thread(user('alice'), false, 2),
      thread(user('alice'), false, 2),
      thread(user('alice'), false, 2),
    ]),
  );
  assert.deepEqual(summary.human, { threads: 5, unresolved: 3, comments: 10 });
});

test('summarizeThreads reports the thread total GitHub gives and marks a cut-off list truncated', () => {
  const read = Array.from({ length: 50 }, (_, i) => thread(user('alice'), i % 10 !== 0, 2));
  const cut = summarizeThreads(pullRequestOf(read, { total: 63 }));
  assert.equal(cut.threads, 63, 'the total, not the number read');
  assert.equal(cut.truncated, true);
  assert.deepEqual(
    cut.human,
    { threads: 50, unresolved: 5, comments: 100 },
    'counts cover the threads read',
  );

  const whole = summarizeThreads(pullRequestOf(read, { total: 50 }));
  assert.equal(whole.truncated, false, 'exactly the cap is not a cut-off');
  assert.equal(whole.threads, 50);

  const few = summarizeThreads(pullRequestOf(read.slice(0, 3)));
  assert.equal(few.truncated, false);
  assert.equal(few.threads, 3);
});

test('summarizeThreads of a PR with no threads and no conversation is all zeros', () => {
  assert.deepEqual(summarizeThreads(pullRequestOf([])), ZERO_COMMENTS);
  assert.equal(summarizeThreads(pullRequestOf([], { conversation: 4 })).conversation, 4);
});

test('summarizeThreads answers null for a pull request it cannot read', () => {
  for (const input of [
    null,
    undefined,
    {},
    { comments: { totalCount: 2 } },
    { reviewThreads: null },
    { reviewThreads: { totalCount: 2 } },
    { reviewThreads: { totalCount: 2, nodes: 'not a list' } },
  ]) {
    assert.equal(summarizeThreads(input), null, JSON.stringify(input));
  }
});

test('summarizeThreads skips a null thread node and still counts the others', () => {
  const input = pullRequestOf(
    [thread(user('alice'), false, 3), null, thread(bot('Copilot'), true, 2)],
    { conversation: 1 },
  );
  assert.deepEqual(summarizeThreads(input), {
    human: { threads: 1, unresolved: 1, comments: 3 },
    copilot: { threads: 1, unresolved: 0, comments: 2 },
    other: BUCKET_ZERO,
    conversation: 1,
    threads: 3,
    truncated: false,
  });
});

const NOT_A_COUNT = [1.5, '3', 'NaN', '', NaN, Infinity, -Infinity, null, undefined, true, [], {}];

test('summarizeThreads answers null for a conversation or thread total that is not an integer', () => {
  for (const value of NOT_A_COUNT) {
    const label = `${typeof value} ${String(value)}`;
    const badConversation = {
      comments: { totalCount: value },
      reviewThreads: { totalCount: 2, nodes: [] },
    };
    const badThreads = {
      comments: { totalCount: 2 },
      reviewThreads: { totalCount: value, nodes: [] },
    };
    assert.equal(summarizeThreads(badConversation), null, `conversation ${label}`);
    assert.equal(summarizeThreads(badThreads), null, `threads ${label}`);
  }
});

test('summarizeThreads counts a thread comment total that is not an integer as zero and keeps the thread', () => {
  for (const value of NOT_A_COUNT) {
    const label = `${typeof value} ${String(value)}`;
    const unreadable = {
      isResolved: false,
      comments: { totalCount: value, nodes: [{ author: user('alice') }] },
    };
    const summary = summarizeThreads(pullRequestOf([unreadable, thread(user('bob'), true, 4)]));
    assert.deepEqual(summary.human, { threads: 2, unresolved: 1, comments: 4 }, label);
    assert.equal(typeof summary.human.comments, 'number', label);
  }
  const whole = summarizeThreads(
    pullRequestOf([thread(user('alice'), false, 3), thread(user('bob'), true, 0)]),
  );
  assert.deepEqual(
    whole.human,
    { threads: 2, unresolved: 1, comments: 3 },
    'integers still add up',
  );
});

test('a thread comment total of text never reaches the result as text', async (t) => {
  const markup = '<img src=x onerror=alert(1)>';
  stubGithub(t, {
    items: [searchItem(1, '[TAP-1] Hostile total', '2026-10-06T12:00:00Z')],
    pullRequests: {
      'ExampleOrg/app#1': withThreads([
        thread(user('alice'), false, markup),
        thread(user('alice'), true, 2),
      ]),
    },
  });
  const result = await fetchTicketPrs({ snapshot: snapshot() });
  const [hostile] = result.byTicket['TAP-1'];
  assert.deepEqual(hostile.comments.human, { threads: 2, unresolved: 1, comments: 2 });
  assert.ok(!JSON.stringify(result).includes('<img'), 'no upstream text in the JSON');
});

test('summarizeThreads is pure: it leaves its input alone and answers fresh objects', () => {
  const input = deepFreeze(
    pullRequestOf([thread(user('alice'), false, 2), thread(bot('Copilot'), true, 3)], {
      conversation: 1,
    }),
  );
  const before = structuredClone(input);
  const first = summarizeThreads(input);
  const second = summarizeThreads(input);
  assert.deepEqual(input, before);
  assert.deepEqual(first, second);
  assert.notEqual(first, second);
  assert.notEqual(first.human, second.human);
});

// -- the comment lane of fetchTicketPrs ------------------------------------------------------------

const approvedPr = {
  reviews: [review('bob', 'APPROVED', '2026-10-02T00:00:00Z')],
  rollup: rollup('SUCCESS', [run('build', 'COMPLETED', 'SUCCESS')]),
};
const withThreads = (threads, extra = {}) => ({ ...approvedPr, threads, ...extra });
const REVIEW_AND_CI = {
  review: { state: 'approved', approvals: 1 },
  ci: { state: 'passing', passed: 1, failed: 0, pending: 0, failing: [] },
};

test('fetchTicketPrs gives each PR its comment counts beside its review and CI', async (t) => {
  const stub = stubGithub(t, {
    items: [
      searchItem(1, '[TAP-1] Talked about', '2026-10-06T12:00:00Z'),
      searchItem(2, '[TAP-2] Quiet', '2026-10-05T12:00:00Z'),
      searchItem(3, '[TAP-3] Long review', '2026-10-04T12:00:00Z'),
    ],
    pullRequests: {
      'ExampleOrg/app#1': withThreads(
        [
          thread(user('alice'), false, 3),
          thread(bot('copilot-pull-request-reviewer[bot]'), true, 2),
          thread(bot('dependabot'), false, 2),
        ],
        { conversation: 2 },
      ),
      'ExampleOrg/app#2': approvedPr,
      'ExampleOrg/app#3': withThreads(
        Array.from({ length: 50 }, () => thread(user('carol'), false, 2)),
        { threadTotal: 63 },
      ),
    },
  });
  const result = await fetchTicketPrs({ snapshot: snapshot() });
  assert.deepEqual(stub.unexpected, []);
  const [talked] = result.byTicket['TAP-1'];
  assert.deepEqual(talked.comments, {
    human: { threads: 1, unresolved: 1, comments: 3 },
    copilot: { threads: 1, unresolved: 0, comments: 2 },
    other: { threads: 1, unresolved: 1, comments: 2 },
    conversation: 2,
    threads: 3,
    truncated: false,
  });
  assert.deepEqual(talked.review, REVIEW_AND_CI.review);
  assert.deepEqual(talked.ci, REVIEW_AND_CI.ci);
  const [quiet] = result.byTicket['TAP-2'];
  assert.deepEqual(quiet.comments, ZERO_COMMENTS);
  const [long] = result.byTicket['TAP-3'];
  assert.equal(long.comments.threads, 63);
  assert.equal(long.comments.truncated, true);
  assert.deepEqual(long.comments.human, { threads: 50, unresolved: 50, comments: 100 });
});

for (const [name, threadsGraphql] of [
  ['a non-OK response', () => reply({ message: `Bad credentials ${TOKEN}` }, 502)],
  [
    'a network error',
    () => {
      throw new Error(`socket hang up for ${TOKEN}`);
    },
  ],
  ['a body without data', () => reply({ errors: [{ message: 'schema went away' }] })],
  [
    'a schema validation error',
    () =>
      reply({
        errors: [
          {
            type: 'GRAPHQL_VALIDATION_FAILED',
            message: `Field 'reviewThreads' doesn't exist ${TOKEN}`,
          },
        ],
      }),
  ],
]) {
  test(`${name} on the comment batch nulls comments and leaves review and CI alone`, async (t) => {
    stubGithub(t, {
      items: [
        searchItem(1, '[TAP-1] First', '2026-10-06T12:00:00Z'),
        searchItem(2, '[TAP-2] Second', '2026-10-05T12:00:00Z'),
      ],
      pullRequests: {
        'ExampleOrg/app#1': withThreads([thread(user('alice'), false, 2)]),
        'ExampleOrg/app#2': withThreads([thread(user('bob'), true, 2)]),
      },
      threadsGraphql,
    });
    const result = await fetchTicketPrs({ snapshot: snapshot() });
    assert.equal(result.available, true);
    assert.deepEqual(Object.keys(result.byTicket).sort(), ['TAP-1', 'TAP-2']);
    for (const list of Object.values(result.byTicket)) {
      for (const item of list) {
        assert.equal(item.comments, null);
        assert.deepEqual(item.review, REVIEW_AND_CI.review);
        assert.deepEqual(item.ci, REVIEW_AND_CI.ci);
      }
    }
    const text = JSON.stringify(result);
    for (const secret of [
      TOKEN,
      'Bad credentials',
      'socket hang up',
      'schema went away',
      "doesn't exist",
    ]) {
      assert.ok(!text.includes(secret), `the result never carries "${secret}"`);
    }
  });
}

test('a comment batch that never answers ends as null comments instead of hanging', async (t) => {
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', () => realTimeout(20));
  const stub = stubGithub(t, {
    items: [searchItem(1, '[TAP-1] Slow threads', '2026-10-06T12:00:00Z')],
    pullRequests: { 'ExampleOrg/app#1': withThreads([thread(user('alice'), false, 2)]) },
    threadsGraphql: neverAnswers,
  });
  const result = await fetchTicketPrs({ snapshot: snapshot() });
  assert.equal(result.available, true);
  const [slow] = result.byTicket['TAP-1'];
  assert.equal(slow.comments, null);
  assert.deepEqual(slow.review, REVIEW_AND_CI.review);
  assert.deepEqual(slow.ci, REVIEW_AND_CI.ci);
  assert.ok(
    stub.threadQueries[0].init.signal instanceof AbortSignal,
    'the comment POST has a timeout',
  );
});

test('an error entry on one comment alias nulls only that PR comments', async (t) => {
  stubGithub(t, {
    items: [
      searchItem(1, '[TAP-1] Readable', '2026-10-06T12:00:00Z'),
      searchItem(2, '[TAP-2] Refused', '2026-10-05T12:00:00Z'),
      searchItem(3, '[TAP-3] Readable too', '2026-10-04T12:00:00Z'),
    ],
    failingThreads: ['ExampleOrg/app#2'],
    pullRequests: {
      'ExampleOrg/app#1': withThreads([thread(user('alice'), false, 2)]),
      'ExampleOrg/app#2': withThreads([thread(user('bob'), true, 2)]),
      'ExampleOrg/app#3': withThreads([thread(bot('Copilot'), true, 2)]),
    },
  });
  const result = await fetchTicketPrs({ snapshot: snapshot() });
  const [first] = result.byTicket['TAP-1'];
  const [refused] = result.byTicket['TAP-2'];
  const [third] = result.byTicket['TAP-3'];
  assert.ok(first.comments && third.comments, 'comments is a field of every readable PR');
  assert.deepEqual(first.comments.human, { threads: 1, unresolved: 1, comments: 2 });
  assert.equal(refused.comments, null, 'an unreadable comment field is null, not zero');
  assert.deepEqual(third.comments.copilot, { threads: 1, unresolved: 0, comments: 2 });
  for (const item of [first, refused, third]) {
    assert.deepEqual(item.review, REVIEW_AND_CI.review);
    assert.deepEqual(item.ci, REVIEW_AND_CI.ci);
  }
  assert.ok(!JSON.stringify(result).includes('thread detail upstream'), 'no upstream error text');
});

test('an unrelated error entry on the comment batch drops nothing', async (t) => {
  stubGithub(t, {
    items: [searchItem(1, '[TAP-1] Change', '2026-10-06T12:00:00Z')],
    threadErrors: [{ type: 'INTERNAL', message: 'something odd upstream' }],
    pullRequests: { 'ExampleOrg/app#1': withThreads([thread(user('alice'), false, 2)]) },
  });
  const result = await fetchTicketPrs({ snapshot: snapshot() });
  const [change] = result.byTicket['TAP-1'];
  assert.ok(change.comments, 'comments is a field of the PR');
  assert.deepEqual(change.comments.human, { threads: 1, unresolved: 1, comments: 2 });
  assert.ok(!JSON.stringify(result).includes('something odd upstream'));
});

test('the conversation count comes from the comments total selected on the pull request itself', async (t) => {
  stubGithub(t, {
    items: [searchItem(1, '[TAP-1] Discussed', '2026-10-06T12:00:00Z')],
    pullRequests: {
      'ExampleOrg/app#1': withThreads([thread(user('alice'), false, 2)], { conversation: 7 }),
    },
  });
  const result = await fetchTicketPrs({ snapshot: snapshot() });
  const [discussed] = result.byTicket['TAP-1'];
  assert.ok(
    discussed.comments,
    'the comment query reads the conversation total, so comments is set',
  );
  assert.equal(discussed.comments.conversation, 7);
  assert.deepEqual(discussed.comments.human, { threads: 1, unresolved: 1, comments: 2 });
});

test('a null thread node in one PR leaves its other threads counted and no PR data blanked', async (t) => {
  stubGithub(t, {
    items: [
      searchItem(1, '[TAP-1] One thread unreadable', '2026-10-06T12:00:00Z'),
      searchItem(2, '[TAP-2] Plain', '2026-10-05T12:00:00Z'),
    ],
    pullRequests: {
      'ExampleOrg/app#1': withThreads([
        thread(user('alice'), false, 3),
        null,
        thread(bot('Copilot'), true, 2),
      ]),
      'ExampleOrg/app#2': withThreads([thread(user('bob'), true, 2)]),
    },
  });
  const result = await fetchTicketPrs({ snapshot: snapshot() });
  assert.equal(result.available, true, 'a null node never makes the whole result unavailable');
  const [holed] = result.byTicket['TAP-1'];
  const [plain] = result.byTicket['TAP-2'];
  assert.deepEqual(holed.comments.human, { threads: 1, unresolved: 1, comments: 3 });
  assert.deepEqual(holed.comments.copilot, { threads: 1, unresolved: 0, comments: 2 });
  assert.equal(holed.comments.threads, 3);
  assert.deepEqual(plain.comments.human, { threads: 1, unresolved: 0, comments: 2 });
  for (const item of [holed, plain]) {
    assert.deepEqual(item.review, REVIEW_AND_CI.review);
    assert.deepEqual(item.ci, REVIEW_AND_CI.ci);
  }
});

test('an error entry on a comment alias that still carries data nulls that PR comments only', async (t) => {
  stubGithub(t, {
    items: [
      searchItem(1, '[TAP-1] Readable', '2026-10-06T12:00:00Z'),
      searchItem(2, '[TAP-2] Partly refused', '2026-10-05T12:00:00Z'),
      searchItem(3, '[TAP-3] Readable too', '2026-10-04T12:00:00Z'),
    ],
    partialThreads: ['ExampleOrg/app#2'],
    pullRequests: {
      'ExampleOrg/app#1': withThreads([thread(user('alice'), false, 2)]),
      'ExampleOrg/app#2': withThreads([thread(user('bob'), true, 2)]),
      'ExampleOrg/app#3': withThreads([thread(bot('Copilot'), true, 2)]),
    },
  });
  const result = await fetchTicketPrs({ snapshot: snapshot() });
  const [first] = result.byTicket['TAP-1'];
  const [partial] = result.byTicket['TAP-2'];
  const [third] = result.byTicket['TAP-3'];
  assert.equal(partial.comments, null, 'counts that may be partial are null, not shown as whole');
  assert.deepEqual(first.comments.human, { threads: 1, unresolved: 1, comments: 2 });
  assert.deepEqual(third.comments.copilot, { threads: 1, unresolved: 0, comments: 2 });
  for (const item of [first, partial, third]) {
    assert.deepEqual(item.review, REVIEW_AND_CI.review);
    assert.deepEqual(item.ci, REVIEW_AND_CI.ci);
  }
  assert.ok(!JSON.stringify(result).includes('partial thread detail'), 'no upstream error text');
});

test('a non-integer conversation or thread total nulls only that PR comments', async (t) => {
  stubGithub(t, {
    items: [
      searchItem(1, '[TAP-1] Conversation total is text', '2026-10-06T12:00:00Z'),
      searchItem(2, '[TAP-2] Thread total is fractional', '2026-10-05T12:00:00Z'),
      searchItem(3, '[TAP-3] Readable', '2026-10-04T12:00:00Z'),
    ],
    pullRequests: {
      'ExampleOrg/app#1': withThreads([thread(user('alice'), false, 2)], { conversation: 'seven' }),
      'ExampleOrg/app#2': withThreads([thread(user('bob'), true, 2)], { threadTotal: 1.5 }),
      'ExampleOrg/app#3': withThreads([thread(user('carol'), false, 2)]),
    },
  });
  const result = await fetchTicketPrs({ snapshot: snapshot() });
  const [text] = result.byTicket['TAP-1'];
  const [fractional] = result.byTicket['TAP-2'];
  const [readable] = result.byTicket['TAP-3'];
  assert.equal(text.comments, null);
  assert.equal(fractional.comments, null);
  assert.deepEqual(readable.comments.human, { threads: 1, unresolved: 1, comments: 2 });
  for (const item of [text, fractional, readable]) {
    assert.deepEqual(item.review, REVIEW_AND_CI.review);
    assert.deepEqual(item.ci, REVIEW_AND_CI.ci);
  }
});

for (const [name, graphql] of [
  ['a non-OK response', () => reply({ message: `Bad credentials ${TOKEN}` }, 502)],
  [
    'a network error',
    () => {
      throw new Error(`socket hang up for ${TOKEN}`);
    },
  ],
  ['a body without data', () => reply({ errors: [{ message: 'schema went away' }] })],
]) {
  test(`${name} on the detail batch leaves comments filled`, async (t) => {
    stubGithub(t, {
      items: [
        searchItem(1, '[TAP-1] First', '2026-10-06T12:00:00Z'),
        searchItem(2, '[TAP-2] Second', '2026-10-05T12:00:00Z'),
      ],
      pullRequests: {
        'ExampleOrg/app#1': withThreads([thread(user('alice'), false, 2)]),
        'ExampleOrg/app#2': withThreads([thread(bot('Copilot'), true, 2)]),
      },
      graphql,
    });
    const result = await fetchTicketPrs({ snapshot: snapshot() });
    const [first] = result.byTicket['TAP-1'];
    const [second] = result.byTicket['TAP-2'];
    for (const item of [first, second]) assert.deepEqual([item.review, item.ci], NO_REVIEW_OR_CI);
    assert.ok(first.comments && second.comments, 'comments is a field of every PR');
    assert.deepEqual(first.comments.human, { threads: 1, unresolved: 1, comments: 2 });
    assert.deepEqual(second.comments.copilot, { threads: 1, unresolved: 0, comments: 2 });
    assert.ok(!JSON.stringify(result).includes(TOKEN));
  });
}

test('a failed comment batch leaves the PRs of the other comment batches intact', async (t) => {
  const items = Array.from({ length: 60 }, (_, i) =>
    searchItem(
      i + 1,
      `[TAP-${i + 1}] Change ${i + 1}`,
      `2026-10-06T12:${String(i).padStart(2, '0')}:00Z`,
    ),
  );
  const pullRequests = Object.fromEntries(
    items.map((item) => [
      `ExampleOrg/app#${item.number}`,
      withThreads([thread(user('alice'), false, 2)]),
    ]),
  );
  const stub = stubGithub(t, {
    items,
    pullRequests,
    threadsGraphql: (call) => (call.index === 0 ? reply({ message: 'down' }, 503) : null),
  });
  const result = await fetchTicketPrs({ snapshot: snapshot() });
  assert.equal(stub.threadQueries.length, 2, '60 PRs take two comment batches');
  assert.equal(stub.graphql.length, 2, 'and two detail batches');
  const failed = new Set(stub.threadQueries[0].aliases.values());
  const served = new Set(stub.threadQueries[1].aliases.values());
  assert.ok(failed.size > 0 && served.size > 0);
  for (const list of Object.values(result.byTicket)) {
    for (const item of list) {
      const key = `${item.repo}#${item.number}`;
      assert.deepEqual(item.review, REVIEW_AND_CI.review, `${key} review`);
      assert.deepEqual(item.ci, REVIEW_AND_CI.ci, `${key} ci`);
      if (failed.has(key)) assert.equal(item.comments, null, key);
      else {
        assert.ok(served.has(key), `${key} was in a batch`);
        assert.deepEqual(item.comments.human, { threads: 1, unresolved: 1, comments: 2 }, key);
      }
    }
  }
});

test('the comment batch carries the token in its header and never in its body', async (t) => {
  const stub = stubGithub(t, {
    items: [searchItem(1, '[TAP-1] Real', '2026-10-06T12:00:00Z')],
    pullRequests: { 'ExampleOrg/app#1': withThreads([thread(user('alice'), false, 2)]) },
  });
  await fetchTicketPrs({ snapshot: snapshot() });
  assert.equal(stub.threadQueries.length, 1);
  assert.ok(
    !stub.threadQueries[0].init.body.includes(TOKEN),
    'the token travels in the header only',
  );
  assert.equal(authorizationOf(stub.threadQueries[0].init), `Bearer ${TOKEN}`);
});

// -- the review window of fetchTicketPrs ------------------------------------------------------------

// The last 100 reviews, the most `reviews(last: 100)` returns: 99 plain comments and an approval.
const LAST_HUNDRED_REVIEWS = [
  ...Array.from({ length: 99 }, (_, i) =>
    review(`reviewer-${i}`, 'COMMENTED', '2026-10-03T00:00:00Z'),
  ),
  review('bob', 'APPROVED', '2026-10-05T00:00:00Z'),
];

test('a PR with older reviews than the 100 read has an unknown review, so it is never approved', async (t) => {
  const stub = stubGithub(t, {
    items: [searchItem(1, '[TAP-1] Long review history', '2026-10-06T12:00:00Z')],
    pullRequests: {
      'ExampleOrg/app#1': withThreads([thread(user('alice'), false, 2)], {
        reviews: LAST_HUNDRED_REVIEWS,
        reviewsPageInfo: { hasPreviousPage: true },
        conversation: 2,
      }),
    },
  });
  const result = await fetchTicketPrs({ snapshot: snapshot() });
  assert.deepEqual(stub.unexpected, []);
  const prs = result.byTicket['TAP-1'];
  const [long] = prs;
  assert.equal(long.review, null, 'an older change request may sit outside the window');
  assert.deepEqual(long.ci, REVIEW_AND_CI.ci, 'CI is read from its own field and stays');
  assert.deepEqual(long.comments.human, { threads: 1, unresolved: 1, comments: 2 });
  assert.equal(long.comments.conversation, 2);
  assert.equal(allPrsApproved(prs), false, 'the board never turns its card green on it');
});

test('a PR whose 100 reviews are all of its reviews keeps its review state', async (t) => {
  stubGithub(t, {
    items: [searchItem(1, '[TAP-1] Exactly the window', '2026-10-06T12:00:00Z')],
    pullRequests: {
      'ExampleOrg/app#1': withThreads([], {
        reviews: LAST_HUNDRED_REVIEWS,
        reviewsPageInfo: { hasPreviousPage: false },
      }),
    },
  });
  const result = await fetchTicketPrs({ snapshot: snapshot() });
  const prs = result.byTicket['TAP-1'];
  assert.deepEqual(prs[0].review, { state: 'approved', approvals: 1 });
  assert.equal(allPrsApproved(prs), true);
});

test('a review window that does not say whether older reviews exist reads as an unknown review', async (t) => {
  const pageInfos = [
    { hasPreviousPage: 'false' },
    { hasPreviousPage: 1 },
    { hasPreviousPage: null },
    {},
    null,
    'false',
  ];
  const stub = stubGithub(t, {
    items: pageInfos.map((_, i) =>
      searchItem(i + 1, `[TAP-${i + 1}] Unclear`, '2026-10-06T12:00:00Z'),
    ),
    pullRequests: Object.fromEntries(
      pageInfos.map((reviewsPageInfo, i) => [
        `ExampleOrg/app#${i + 1}`,
        withThreads([], { reviewsPageInfo }),
      ]),
    ),
  });
  const result = await fetchTicketPrs({ snapshot: snapshot() });
  assert.deepEqual(stub.unexpected, []);
  pageInfos.forEach((pageInfo, i) => {
    const [unclear] = result.byTicket[`TAP-${i + 1}`];
    assert.equal(unclear.review, null, JSON.stringify(pageInfo));
    assert.deepEqual(unclear.ci, REVIEW_AND_CI.ci, 'CI stays');
  });
});

test('the review lane selects whether older reviews exist than the 100 it reads', async (t) => {
  const stub = stubGithub(t, { items: oneItem });
  await fetchTicketPrs({ snapshot: snapshot() });
  assert.equal(stub.graphql.length, 1);
  const reviews = selectionOf(stub.graphql[0].query).query.repository.pullRequest.reviews;
  assert.ok(reviews.nodes, 'the reviews are selected');
  assert.ok(
    reviews.pageInfo?.hasPreviousPage,
    'reviews { pageInfo { hasPreviousPage } } is selected',
  );
  assert.ok(
    stub.graphql[0].query.includes('reviews(last: 100)'),
    'the window is still the last 100',
  );
});
