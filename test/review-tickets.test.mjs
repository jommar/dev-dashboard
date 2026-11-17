import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as github from '../backend/github.mjs';
import * as review from '../backend/review.mjs';
import { fetchTicketPrs } from '../backend/ticket-prs.mjs';
import { resetPullRequestCaches } from '../backend/dev-status.mjs';
import { assertNoSecrets, githubToken, jiraToken } from './settings-fixture.mjs';
import {
  API,
  aliasesOf,
  issue,
  issueId,
  linkedPr,
  openDetail,
  opinion,
  queueLoader,
  reviewPage,
  snapshot,
  stubQueue,
} from './review-queue-fixture.mjs';

// The shared dev-status lookup keeps a module-level cache, so every test starts from an empty one.
beforeEach(() => resetPullRequestCaches());

const ids = (prs) => prs.map((pr) => `${pr.repo}#${pr.number}`).sort();
const reviewLoader = () => {
  assert.equal(
    typeof review.fetchQueueReviewData,
    'function',
    'queue-specific review normalization is exported',
  );
  return review.fetchQueueReviewData;
};
const pr = (number, repo = 'ExampleOrg/app') => ({ repo, number });

test('queue forwards only the assignee display name and normalizes missing names', async (t) => {
  const fetchReviewTickets = await queueLoader();
  stubQueue(t, {
    jira: ({ url }) => {
      assert.ok(url.searchParams.get('fields').split(',').includes('assignee'));
      return Response.json({
        issues: [
          issue('DEMO-1', {
            assignee: { displayName: '  Alex Example  ', accountId: 'private-id' },
          }),
          issue('DEMO-2', { assignee: null }),
          issue('DEMO-3', { assignee: { displayName: '   ' } }),
          issue('DEMO-4'),
        ],
        isLast: true,
      });
    },
  });
  const data = await fetchReviewTickets({ snapshot: snapshot() });
  assert.deepEqual(
    data.tickets.map(({ assignee }) => assignee),
    ['Alex Example', null, null, null],
  );
  assert.ok(!JSON.stringify(data).includes('private-id'));
});

test('all-author discovery has its own export without changing legacy author-mode search', () => {
  assert.equal(typeof github.fetchAllOpenPRs, 'function');
  assert.equal(typeof github.fetchOpenPRs, 'function');
});

test('queue is Jira-first: PRs come from Jira dev-status links in any repository, canonical and deduplicated by full PR identity', async (t) => {
  const fetchReviewTickets = await queueLoader();
  const canonical = ['TAP', '900001'].join('-');
  const alias = ['TRIPS', '900001'].join('-');
  const reviewedIds = [];
  const stub = stubQueue(t, {
    issues: [issue(alias), issue(alias), issue('DEMO-2'), issue('DEMO-3')],
    linked: [
      linkedPr('ExampleOrg/app', 7, [alias, 'DEMO-2']),
      linkedPr('ExampleOrg/app', 8, [canonical]),
      linkedPr('OtherOrg/tools', 7, [canonical]),
      linkedPr('ExampleOrg/specs', 7, [canonical]),
    ],
    details: {
      'ExampleOrg/app#8': openDetail({ isDraft: true, author: { login: 'other-author' } }),
    },
    graphql: ({ init }) => {
      assert.equal(init.method, 'POST');
      const { query } = JSON.parse(init.body);
      assert.match(query, /^\s*query\b/);
      assert.doesNotMatch(query, /mutation|statusCheckRollup|reviewThreads|\bcomments\s*\(/);
      return Response.json({
        data: Object.fromEntries(
          aliasesOf(query).map(([name, id]) => {
            reviewedIds.push(id);
            return [
              name,
              { pullRequest: reviewPage([opinion('third-party', 'APPROVED')], 'REVIEW_REQUIRED') },
            ];
          }),
        ),
      });
    },
  });
  const data = await fetchReviewTickets({ snapshot: snapshot() });
  assert.deepEqual(Object.keys(data).sort(), ['prCoverage', 'tickets', 'total', 'updatedAt']);
  assert.equal(data.total, 3);
  assert.deepEqual(
    data.tickets.map((ticket) => ticket.key),
    ['DEMO-2', 'DEMO-3', canonical],
  );
  const byKey = Object.fromEntries(data.tickets.map((ticket) => [ticket.key, ticket]));
  assert.equal(byKey[canonical].summary, `Jira summary for ${alias}`, 'Jira owns the summary');
  assert.deepEqual(ids(byKey[canonical].prs), [
    'ExampleOrg/app#7',
    'ExampleOrg/app#8',
    'ExampleOrg/specs#7',
    'OtherOrg/tools#7',
  ]);
  assert.deepEqual(ids(byKey['DEMO-2'].prs), ['ExampleOrg/app#7']);
  assert.deepEqual(byKey['DEMO-3'].prs, [], 'eligible no-PR ticket stays visible');
  const draft = byKey[canonical].prs.find(
    (entry) => entry.number === 8 && entry.repo.endsWith('app'),
  );
  assert.equal(draft.draft, true);
  assert.equal(draft.owner, 'other-author', 'the PR author comes from GitHub');
  assert.equal(
    byKey['DEMO-2'].prs[0].owner,
    'current-github-user',
    'PR authors never gate Jira membership',
  );
  assert.deepEqual(Object.keys(byKey['DEMO-2'].prs[0]).sort(), [
    'draft',
    'number',
    'owner',
    'repo',
    'review',
    'title',
    'updatedAt',
    'url',
  ]);
  assert.equal(byKey['DEMO-2'].prs[0].review.state, 'approved');
  assert.deepEqual([...new Set(reviewedIds)].sort(), [
    'ExampleOrg/app#7',
    'ExampleOrg/app#8',
    'ExampleOrg/specs#7',
    'OtherOrg/tools#7',
  ]);
  assert.equal(reviewedIds.length, 4, 'one review load per deduplicated eligible PR');
  assert.deepEqual(data.prCoverage, {
    available: true,
    complete: true,
    repos: ['ExampleOrg/app', 'ExampleOrg/specs', 'OtherOrg/tools'],
    reasons: [],
  });
  assert.ok(Number.isFinite(Date.parse(data.updatedAt)));
  assert.ok(stub.timeouts.length >= stub.calls.length);
  assert.ok(stub.timeouts.every((ms) => ms === 15_000));
  assert.deepEqual(
    stub.unexpected,
    [],
    'no /user, repository listing, search, CI or comment calls',
  );
  assert.ok(
    stub.calls.every(({ url }) => !url.pathname.startsWith('/repos/')),
    'watched repositories are never listed',
  );
  assertNoSecrets(data);
});

test('a failed Jira dev-status lookup keeps the other tickets and marks discovery incomplete', async (t) => {
  const fetchReviewTickets = await queueLoader();
  const stub = stubQueue(t, {
    issues: [issue('DEMO-1'), issue('DEMO-2')],
    linked: [linkedPr('ExampleOrg/app', 7, ['DEMO-1'])],
    devStatus: ({ url }) =>
      url.searchParams.get('issueId') === issueId('DEMO-2')
        ? Response.json({ message: jiraToken }, { status: 503 })
        : undefined,
  });
  const result = await fetchReviewTickets({ snapshot: snapshot() });
  assert.equal(result.total, 2);
  const byKey = Object.fromEntries(result.tickets.map((ticket) => [ticket.key, ticket]));
  assert.deepEqual(ids(byKey['DEMO-1'].prs), ['ExampleOrg/app#7']);
  assert.deepEqual(byKey['DEMO-2'].prs, []);
  assert.equal(result.prCoverage.available, true);
  assert.equal(result.prCoverage.complete, false);
  assert.ok(result.prCoverage.reasons.length > 0);
  assert.deepEqual(stub.unexpected, []);
  assertNoSecrets(result);
});

test('every Jira dev-status lookup failing leaves discovery unavailable but keeps the Jira queue', async (t) => {
  const fetchReviewTickets = await queueLoader();
  stubQueue(t, {
    issues: [issue('DEMO-1'), issue('DEMO-2')],
    linked: [linkedPr('ExampleOrg/app', 7, ['DEMO-1'])],
    devStatus: () => Response.json({ message: jiraToken }, { status: 503 }),
  });
  const result = await fetchReviewTickets({ snapshot: snapshot() });
  assert.equal(result.total, 2);
  assert.ok(result.tickets.every((ticket) => ticket.prs.length === 0));
  assert.equal(result.prCoverage.available, false);
  assert.equal(result.prCoverage.complete, false);
  assert.ok(result.prCoverage.reasons.length > 0);
  assertNoSecrets(result);
});

test('a failed GitHub state read cannot tell which linked PRs are open, so none is shown and discovery is unavailable', async (t) => {
  const fetchReviewTickets = await queueLoader();
  stubQueue(t, {
    linked: [linkedPr('ExampleOrg/app', 7, ['DEMO-1'])],
    detail: () => Response.json({ message: githubToken }, { status: 503 }),
  });
  const result = await fetchReviewTickets({ snapshot: snapshot() });
  assert.equal(result.total, 1);
  assert.deepEqual(result.tickets[0].prs, []);
  assert.equal(result.prCoverage.available, false);
  assert.equal(result.prCoverage.complete, false);
  assertNoSecrets(result);
});

test('a ticket without a numeric Jira id cannot be looked up, so discovery is incomplete', async (t) => {
  const fetchReviewTickets = await queueLoader();
  stubQueue(t, {
    issues: [issue('DEMO-1'), { ...issue('DEMO-2'), id: undefined }],
    linked: [linkedPr('ExampleOrg/app', 7, ['DEMO-1'])],
  });
  const result = await fetchReviewTickets({ snapshot: snapshot() });
  assert.equal(result.total, 2);
  assert.equal(result.prCoverage.available, true);
  assert.equal(result.prCoverage.complete, false);
});

test('missing GitHub credentials retains the Jira queue but cannot certify empty PR discovery', async (t) => {
  const fetchReviewTickets = await queueLoader();
  const stub = stubQueue(t);
  const result = await fetchReviewTickets({ snapshot: snapshot({ credentials: { jiraToken } }) });
  assert.equal(result.total, 1);
  assert.deepEqual(result.tickets[0].prs, []);
  assert.equal(result.prCoverage.available, false);
  assert.equal(result.prCoverage.complete, false);
  assert.ok(result.prCoverage.reasons.length > 0);
  assert.equal(
    stub.calls.every(({ url }) => url.pathname === '/rest/api/3/search/jql'),
    true,
  );
});

test('canonical Jira queue is sorted by updated descending, then key for ties', async (t) => {
  const fetchReviewTickets = await queueLoader();
  stubQueue(t, {
    issues: [
      issue('DEMO-1', { updated: '2026-10-01T00:00:00Z' }),
      issue('DEMO-3', { updated: '2026-11-02T00:00:00Z' }),
      issue('DEMO-2', { updated: '2026-11-02T00:00:00Z' }),
    ],
  });
  const result = await fetchReviewTickets({ snapshot: snapshot() });
  assert.deepEqual(
    result.tickets.map((ticket) => ticket.key),
    ['DEMO-2', 'DEMO-3', 'DEMO-1'],
  );
});

test('closed, merged and declined linked PRs do not become active review work or synthetic Jira cards', async (t) => {
  const fetchReviewTickets = await queueLoader();
  const reviewedIds = [];
  stubQueue(t, {
    issues: [issue('DEMO-1'), issue('DEMO-2')],
    linked: [
      linkedPr('ExampleOrg/app', 7, ['DEMO-1']),
      linkedPr('ExampleOrg/app', 8, ['DEMO-1']),
      linkedPr('ExampleOrg/app', 9, ['DEMO-2']),
      linkedPr('ExampleOrg/app', 10, ['DEMO-1'], { state: 'DECLINED' }),
    ],
    details: {
      'ExampleOrg/app#8': openDetail({ state: 'CLOSED' }),
      'ExampleOrg/app#9': openDetail({ state: 'MERGED', mergedAt: '2026-11-02T00:00:00Z' }),
    },
    graphql: ({ init }) =>
      Response.json({
        data: Object.fromEntries(
          aliasesOf(JSON.parse(init.body).query).map(([alias, id]) => {
            reviewedIds.push(id);
            return [alias, { pullRequest: reviewPage() }];
          }),
        ),
      }),
  });
  const result = await fetchReviewTickets({ snapshot: snapshot() });
  assert.equal(result.total, 2);
  assert.deepEqual(
    result.tickets.map((ticket) => ticket.key),
    ['DEMO-1', 'DEMO-2'],
  );
  assert.deepEqual(ids(result.tickets[0].prs), ['ExampleOrg/app#7']);
  assert.deepEqual(result.tickets[1].prs, []);
  assert.deepEqual(reviewedIds, ['ExampleOrg/app#7']);
  assert.equal(result.prCoverage.complete, true);
});

test('one unreadable PR affects only its tickets, not discovery completeness or unrelated reviews', async (t) => {
  const fetchReviewTickets = await queueLoader();
  stubQueue(t, {
    issues: [issue('DEMO-1'), issue('DEMO-2')],
    linked: [linkedPr('ExampleOrg/app', 7, ['DEMO-1']), linkedPr('ExampleOrg/app', 8, ['DEMO-2'])],
    graphql: ({ init }) =>
      Response.json({
        data: Object.fromEntries(
          aliasesOf(JSON.parse(init.body).query)
            .filter(([, id]) => id.endsWith('#8'))
            .map(([alias]) => [
              alias,
              { pullRequest: reviewPage([opinion('other-reviewer', 'APPROVED')]) },
            ]),
        ),
      }),
  });
  const result = await fetchReviewTickets({ snapshot: snapshot() });
  assert.equal(result.prCoverage.complete, true);
  const byKey = Object.fromEntries(result.tickets.map((ticket) => [ticket.key, ticket]));
  assert.equal(byKey['DEMO-1'].prs[0].review.complete, false);
  assert.equal(byKey['DEMO-1'].prs[0].review.state, 'unknown');
  assert.equal(byKey['DEMO-2'].prs[0].review.complete, true);
  assert.equal(byKey['DEMO-2'].prs[0].review.state, 'approved');
});

test('a later Jira failure rejects the queue rather than returning an apparently complete prefix', async (t) => {
  const fetchReviewTickets = await queueLoader();
  let page = 0;
  stubQueue(t, {
    jira: () =>
      ++page === 1
        ? Response.json({ issues: [issue()], isLast: false, nextPageToken: 'next' })
        : Response.json({ message: 'Synthetic unavailable' }, { status: 503 }),
  });
  await assert.rejects(() => fetchReviewTickets({ snapshot: snapshot() }));
});

for (const [name, decision, nodes, expected, approvers, requesters] of [
  [
    'third-party null-decision fallback',
    null,
    [opinion('third-party', 'APPROVED')],
    'approved',
    ['third-party'],
    [],
  ],
  [
    'threshold-free individual approval',
    'REVIEW_REQUIRED',
    [opinion('third-party', 'APPROVED')],
    'approved',
    ['third-party'],
    [],
  ],
  ['overall approval', 'APPROVED', [], 'approved', [], []],
  [
    'overall standing request',
    'CHANGES_REQUESTED',
    [opinion('third-party', 'APPROVED')],
    'changes_requested',
    ['third-party'],
    [],
  ],
  [
    'standing reviewer request veto',
    'APPROVED',
    [opinion('alice', 'CHANGES_REQUESTED'), opinion('bob', 'APPROVED', 2)],
    'changes_requested',
    ['bob'],
    ['alice'],
  ],
  [
    'superseded approval',
    null,
    [opinion('alice', 'APPROVED'), opinion('alice', 'CHANGES_REQUESTED', 2)],
    'changes_requested',
    [],
    ['alice'],
  ],
  [
    'request resolved by approval',
    null,
    [opinion('alice', 'CHANGES_REQUESTED'), opinion('alice', 'APPROVED', 2)],
    'approved',
    ['alice'],
    [],
  ],
  [
    'comments and pending are not actionable',
    null,
    [opinion('alice', 'COMMENTED'), opinion('bob', 'PENDING', 2)],
    'awaiting',
    [],
    [],
  ],
]) {
  test(`queue review evidence: ${name}`, async (t) => {
    const fetchQueueReviewData = reviewLoader();
    stubQueue(t, {
      graphql: ({ init }) =>
        Response.json({
          data: Object.fromEntries(
            aliasesOf(JSON.parse(init.body).query).map(([alias]) => [
              alias,
              { pullRequest: reviewPage(nodes, decision) },
            ]),
          ),
        }),
    });
    const result = (await fetchQueueReviewData([pr(7)], { snapshot: snapshot() })).reviews[
      'ExampleOrg/app#7'
    ];
    assert.deepEqual(result, {
      complete: true,
      state: expected,
      approvers,
      changesRequesters: requesters,
      reviewDecision: decision,
    });
  });
}

test('dismissed approval cannot count or resurrect an older superseded opinion', async (t) => {
  const fetchQueueReviewData = reviewLoader();
  const nodes = [
    opinion('alice', 'APPROVED'),
    opinion('alice', 'CHANGES_REQUESTED', 2),
    opinion('alice', 'DISMISSED', 3),
  ];
  stubQueue(t, {
    graphql: () => Response.json({ data: { a0: { pullRequest: reviewPage(nodes) } } }),
  });
  const result = (await fetchQueueReviewData([pr(7)], { snapshot: snapshot() })).reviews[
    'ExampleOrg/app#7'
  ];
  assert.notEqual(result.state, 'approved');
  assert.deepEqual(result.approvers, []);
});

test('approval after the first 100 reviews is counted only after complete advancing pagination', async (t) => {
  const fetchQueueReviewData = reviewLoader();
  const queries = [];
  stubQueue(t, {
    graphql: ({ init }) => {
      const { query } = JSON.parse(init.body);
      queries.push(query);
      const page =
        queries.length === 1
          ? reviewPage(
              Array.from({ length: 100 }, () => opinion('commenter', 'COMMENTED')),
              null,
              { hasNextPage: true, endCursor: 'review-next' },
            )
          : reviewPage([opinion('later-reviewer', 'APPROVED', 2)]);
      return Response.json({
        data: Object.fromEntries(aliasesOf(query).map(([alias]) => [alias, { pullRequest: page }])),
      });
    },
  });
  const result = (await fetchQueueReviewData([pr(7)], { snapshot: snapshot() })).reviews[
    'ExampleOrg/app#7'
  ];
  assert.equal(queries.length, 2);
  assert.match(queries[1], /after:\s*"review-next"/);
  assert.equal(result.complete, true);
  assert.equal(result.state, 'approved');
  assert.deepEqual(result.approvers, ['later-reviewer']);
});

for (const [name, bad] of [
  ['missing alias', () => ({})],
  [
    'missing pageInfo',
    () => ({ a0: { pullRequest: { reviewDecision: 'APPROVED', reviews: { nodes: [] } } } }),
  ],
  ['missing reviews', () => ({ a0: { pullRequest: { reviewDecision: 'APPROVED' } } })],
  [
    'unreadable author',
    () => ({
      a0: {
        pullRequest: reviewPage([{ ...opinion('alice', 'APPROVED'), author: null }], 'APPROVED'),
      },
    }),
  ],
  [
    'unreadable date',
    () => ({
      a0: {
        pullRequest: reviewPage(
          [{ ...opinion('alice', 'APPROVED'), submittedAt: 'unreadable' }],
          'APPROVED',
        ),
      },
    }),
  ],
]) {
  test(`review ${name} is unknown only for the affected PR, never masked by overall APPROVED`, async (t) => {
    const fetchQueueReviewData = reviewLoader();
    stubQueue(t, {
      graphql: () =>
        Response.json({
          data: { ...bad(), a1: { pullRequest: reviewPage([opinion('bob', 'APPROVED')]) } },
        }),
    });
    const result = (await fetchQueueReviewData([pr(7), pr(8)], { snapshot: snapshot() })).reviews;
    assert.equal(result['ExampleOrg/app#7'].complete, false);
    assert.equal(result['ExampleOrg/app#7'].state, 'unknown');
    assert.equal(result['ExampleOrg/app#8'].complete, true);
    assert.equal(result['ExampleOrg/app#8'].state, 'approved');
  });
}

test('a GraphQL error on an otherwise approved alias still makes only that PR unknown', async (t) => {
  const fetchQueueReviewData = reviewLoader();
  stubQueue(t, {
    graphql: () =>
      Response.json({
        data: {
          a0: { pullRequest: reviewPage([opinion('alice', 'APPROVED')], 'APPROVED') },
          a1: { pullRequest: reviewPage([opinion('bob', 'APPROVED')]) },
        },
        errors: [{ message: githubToken, path: ['a0', 'pullRequest', 'reviews'] }],
      }),
  });
  const result = await fetchQueueReviewData([pr(7), pr(8)], { snapshot: snapshot() });
  assert.equal(result.reviews['ExampleOrg/app#7'].state, 'unknown');
  assert.equal(result.reviews['ExampleOrg/app#7'].complete, false);
  assert.equal(result.reviews['ExampleOrg/app#8'].state, 'approved');
  assert.equal(result.reviews['ExampleOrg/app#8'].complete, true);
  assertNoSecrets(result);
});

for (const failure of ['repeated cursor', 'missing cursor', 'failed later page']) {
  test(`review ${failure} cannot publish approved evidence from an incomplete history`, async (t) => {
    const fetchQueueReviewData = reviewLoader();
    let calls = 0;
    stubQueue(t, {
      graphql: () => {
        calls += 1;
        assert.ok(calls <= 3, 'review pagination terminates');
        if (calls > 1 && failure === 'failed later page') return Response.json({}, { status: 503 });
        return Response.json({
          data: {
            a0: {
              pullRequest: reviewPage([opinion('alice', 'APPROVED')], 'APPROVED', {
                hasNextPage: true,
                endCursor: calls > 1 && failure === 'missing cursor' ? null : 'same-cursor',
              }),
            },
          },
        });
      },
    });
    const result = (await fetchQueueReviewData([pr(7)], { snapshot: snapshot() })).reviews[
      'ExampleOrg/app#7'
    ];
    assert.equal(result.complete, false);
    assert.equal(result.state, 'unknown');
    assert.ok(calls >= 2 && calls <= 3);
  });
}

test('review GraphQL is read-only, timeout-bounded, serial and batched to at most 50 unique eligible PRs', async (t) => {
  const fetchQueueReviewData = reviewLoader();
  const sizes = [];
  const stub = stubQueue(t, {
    graphql: ({ init }) => {
      const { query } = JSON.parse(init.body);
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'error');
      assert.ok(init.signal instanceof AbortSignal);
      assert.match(query, /^\s*query\b/);
      assert.doesNotMatch(query, /mutation/);
      const aliases = aliasesOf(query);
      sizes.push(aliases.length);
      return Response.json({
        data: Object.fromEntries(aliases.map(([alias]) => [alias, { pullRequest: reviewPage() }])),
      });
    },
  });
  const result = await fetchQueueReviewData(
    Array.from({ length: 101 }, (_, index) => pr(index + 1)),
    { snapshot: snapshot() },
  );
  assert.equal(Object.keys(result.reviews).length, 101);
  assert.ok(sizes.length >= 3);
  assert.ok(sizes.every((size) => size > 0 && size <= 50));
  assert.equal(stub.maxInFlight, 1);
  assert.equal(stub.timeouts.length, sizes.length);
  assert.ok(stub.timeouts.every((ms) => ms === 15_000));
});

test('new queue reads and the legacy own-author scope never share an in-flight result', async (t) => {
  const fetchReviewTickets = await queueLoader();
  const seen = [];
  const config = snapshot({
    github: { api: API, org: 'ExampleOrg', repos: ['app'], maxResults: 17 },
  });
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    seen.push(url.pathname);
    if (url.pathname === '/user') return Response.json({ login: 'me' });
    if (url.pathname === '/rest/api/3/search/jql')
      return Response.json({ issues: [{ ...issue(), id: '10010' }], isLast: true });
    if (url.pathname === '/rest/dev-status/latest/issue/summary')
      return Response.json({
        summary: { pullrequest: { overall: { count: 0 }, byInstanceType: {} } },
      });
    assert.fail(`Unexpected mocked path ${url.pathname}`);
  });
  const [queue, own] = await Promise.all([
    fetchReviewTickets({ snapshot: config }),
    fetchTicketPrs({ snapshot: config }),
  ]);
  assert.equal(queue.total, 1);
  assert.equal(own.total, 0);
  assert.deepEqual(own.byTicket, {});
  assert.ok(
    seen.includes('/rest/dev-status/latest/issue/summary'),
    'both reads asked Jira dev-status for the ticket',
  );
  assert.ok(!seen.includes('/search/issues'), 'no GitHub search is made');
  assert.ok(
    seen.every((path) => !path.startsWith('/repos/')),
    'no watched repository is listed',
  );
});

test('same-revision configurations remain isolated and every upstream read uses its captured snapshot', async (t) => {
  const fetchReviewTickets = await queueLoader();
  const configs = ['first', 'second'].map((name) =>
    snapshot({
      github: {
        api: `https://${name}.github.example.invalid`,
        org: 'ExampleOrg',
        repos: [name],
        maxResults: 17,
      },
      jira: { ...snapshot().jira, baseUrl: `https://${name}.jira.example.invalid` },
      credentials: { githubToken: `synthetic-${name}-github`, jiraToken: `synthetic-${name}-jira` },
    }),
  );
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = new URL(input);
    const name = url.hostname.split('.')[0];
    calls.push({ url, init });
    const authorization = init.headers.Authorization;
    if (url.pathname === '/rest/api/3/search/jql') {
      assert.equal(
        authorization,
        `Basic ${Buffer.from(`qa@example.invalid:synthetic-${name}-jira`).toString('base64')}`,
      );
      return Response.json({
        issues: [issue(name === 'first' ? 'DEMO-1' : 'DEMO-2')],
        isLast: true,
      });
    }
    if (url.pathname === '/rest/dev-status/latest/issue/summary') {
      assert.equal(
        authorization,
        `Basic ${Buffer.from(`qa@example.invalid:synthetic-${name}-jira`).toString('base64')}`,
      );
      return Response.json({
        summary: { pullrequest: { overall: { count: 0 }, byInstanceType: {} } },
      });
    }
    assert.fail(`Unexpected mocked path ${url.pathname}`);
  });
  const results = await Promise.all(
    configs.map((config) => fetchReviewTickets({ snapshot: config })),
  );
  assert.deepEqual(
    results.map((result) => result.tickets.map((ticket) => ticket.key)),
    [['DEMO-1'], ['DEMO-2']],
  );
  const queueReads = (host) =>
    calls.filter(({ url }) => url.hostname === host && url.pathname === '/rest/api/3/search/jql')
      .length;
  await fetchReviewTickets({ snapshot: configs[0] });
  assert.equal(queueReads('first.jira.example.invalid'), 2, 'no result cache');
  await Promise.all([
    fetchReviewTickets({ snapshot: configs[0] }),
    fetchReviewTickets({ snapshot: configs[0] }),
  ]);
  assert.equal(queueReads('first.jira.example.invalid'), 4, 'no shared in-flight cache');
  for (const result of results)
    assertNoSecrets(
      result,
      configs.flatMap((config) => Object.values(config.credentials)),
    );
});
