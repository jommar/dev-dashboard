import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchTicketPrs, prsByTicket, summarizeChecks } from '../backend/ticket-prs.mjs';

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

// `pullRequests` maps `repo#number` to `{ reviews, rollup }`. `forbidden` lists
// the keys whose check rollup GitHub refuses with a FORBIDDEN error entry.
function stubGithub(t, options = {}) {
  const { login = 'me', items = [], total = items.length, pullRequests = {} } = options;
  const forbidden = new Set(options.forbidden || []);
  const calls = [];
  const graphql = [];
  const unexpected = [];
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = String(input);
    const call = { url, init };
    calls.push(call);
    if (url.endsWith('/user')) return options.user ? options.user(call) : reply({ login });
    if (url.includes('/search/issues')) {
      return options.search ? options.search(call) : reply({ total_count: total, items });
    }
    if (url.endsWith('/graphql')) {
      call.aliases = aliasesOf(JSON.parse(init.body).query);
      call.index = graphql.length;
      graphql.push(call);
      if (options.graphql) {
        const override = await options.graphql(call);
        if (override) return override;
      }
      const data = {};
      const errors = [];
      for (const [alias, key] of call.aliases) {
        const spec = pullRequests[key] || {};
        data[alias] = {
          pullRequest: {
            reviewDecision: null,
            reviews: { nodes: spec.reviews || [] },
            commits: {
              nodes: [
                {
                  commit: { statusCheckRollup: forbidden.has(key) ? null : (spec.rollup ?? null) },
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
  });
  return { calls, graphql, unexpected };
}

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
  assert.deepEqual(result, {
    available: true,
    login: 'me',
    total: 0,
    truncated: false,
    byTicket: {},
  });
});

test('a poll costs one /user, one search and one 15 s guarded GraphQL POST per 50 PRs', async (t) => {
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
  assert.equal(stub.calls.length, 5, '1 /user + 1 search + 3 GraphQL');
  assert.equal(stub.calls.filter((call) => call.url.endsWith('/user')).length, 1);
  const searches = stub.calls.filter((call) => call.url.includes('/search/issues'));
  assert.equal(searches.length, 1);
  const search = decodeURIComponent(searches[0].url);
  assert.match(search, /author:me/);
  assert.doesNotMatch(search, /-author:/, 'my PRs only');

  assert.equal(stub.graphql.length, 3);
  assert.deepEqual(
    stub.graphql.map((call) => call.aliases.size).sort((a, b) => b - a),
    [50, 50, 20],
  );
  const covered = stub.graphql.flatMap((call) => [...call.aliases.values()]);
  assert.equal(new Set(covered).size, 120, 'every PR is read exactly once');
  for (const call of stub.graphql) {
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.redirect, 'error');
    assert.ok(call.init.signal instanceof AbortSignal, 'a timeout signal');
    assert.equal(authorizationOf(call.init), `Bearer ${TOKEN}`);
    const { query } = JSON.parse(call.init.body);
    for (const field of [
      'statusCheckRollup',
      'commits(last: 1)',
      'contexts(first: 100)',
      'reviews(last: 100)',
    ]) {
      assert.ok(query.includes(field), `the query reads ${field}`);
    }
  }
  assert.ok(timeouts.filter((ms) => ms === 15_000).length >= 3, 'each POST has a 15 s timeout');
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
  const text = JSON.stringify(result);
  for (const bad of ['javascript:', 'http://', 'evil.example']) {
    assert.ok(!text.includes(bad), `the result never carries "${bad}"`);
  }
});
