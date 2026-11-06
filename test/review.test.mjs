import test from 'node:test';
import assert from 'node:assert/strict';
import {
  approvalCount,
  fetchReviewData,
  filterPrsNeedingApprovals,
  summarizeReviews,
} from '../backend/review.mjs';
import { getMinPrApprover, parseMinPrApprover } from '../backend/config.mjs';
import { fetchOpenPRs } from '../backend/github.mjs';

test('MIN_PR_APPROVER accepts only positive integers', () => {
  assert.equal(parseMinPrApprover(undefined), 1);
  assert.equal(parseMinPrApprover(''), 1);
  assert.equal(parseMinPrApprover('0'), 1);
  assert.equal(parseMinPrApprover('-2'), 1);
  assert.equal(parseMinPrApprover('1.5'), 1);
  assert.equal(parseMinPrApprover('01'), 1);
  assert.equal(parseMinPrApprover(' 3 '), 3);
  assert.equal(parseMinPrApprover('999999999999999999999'), 1);
  assert.equal(parseMinPrApprover('2'), 2);
});

test('explicit MIN_PR_APPROVER takes precedence over .env', () => {
  const previous = process.env.MIN_PR_APPROVER;
  process.env.MIN_PR_APPROVER = '7';
  assert.equal(getMinPrApprover(), 7);
  if (previous === undefined) delete process.env.MIN_PR_APPROVER;
  else process.env.MIN_PR_APPROVER = previous;
});

test('review approval count uses each reviewer latest actionable review', () => {
  const summary = summarizeReviews([
    { state: 'APPROVED', submittedAt: '2026-01-01T00:00:00Z', author: { login: 'alice' } },
    { state: 'CHANGES_REQUESTED', submittedAt: '2026-01-02T00:00:00Z', author: { login: 'alice' } },
    { state: 'APPROVED', submittedAt: '2026-01-03T00:00:00Z', author: { login: 'bob' } },
    { state: 'APPROVED', submittedAt: '2026-01-04T00:00:00Z', author: { login: 'bob' } },
    { state: 'COMMENTED', submittedAt: '2026-01-05T00:00:00Z', author: { login: 'carol' } },
  ]);
  assert.deepEqual(summary.approvers, ['bob']);
  assert.deepEqual(summary.changesRequesters, ['alice']);
  assert.equal(summary.state, 'changes_requested');
});

const reviewNode = (login, state, day) => ({
  state,
  submittedAt: `2026-01-0${day}T00:00:00Z`,
  author: { login },
});
// A review by an author with no login (a deleted account), which no per-reviewer count can track.
const ghostNode = (state, day) => ({ ...reviewNode('ghost', state, day), author: null });
const IGNORED_STATES = ['COMMENTED', 'DISMISSED', 'PENDING'];

test('a standing change request outranks an approval submitted after it', () => {
  const summary = summarizeReviews([
    reviewNode('alice', 'CHANGES_REQUESTED', 1),
    reviewNode('bob', 'APPROVED', 2),
  ]);
  assert.equal(summary.state, 'changes_requested');
  assert.deepEqual(summary.approvers, ['bob']);
  assert.deepEqual(summary.changesRequesters, ['alice']);
});

test('a standing change request outranks an approval submitted before it', () => {
  const summary = summarizeReviews([
    reviewNode('bob', 'APPROVED', 1),
    reviewNode('alice', 'CHANGES_REQUESTED', 2),
  ]);
  assert.equal(summary.state, 'changes_requested');
  assert.deepEqual(summary.approvers, ['bob']);
  assert.deepEqual(summary.changesRequesters, ['alice']);
});

test('the order the reviews arrive in does not change a standing change request', () => {
  const reviews = [
    reviewNode('alice', 'CHANGES_REQUESTED', 1),
    reviewNode('bob', 'APPROVED', 2),
    reviewNode('carol', 'APPROVED', 3),
  ];
  for (const ordered of [reviews, [...reviews].reverse()]) {
    const summary = summarizeReviews(ordered);
    assert.equal(summary.state, 'changes_requested');
    assert.deepEqual(summary.approvers.sort(), ['bob', 'carol']);
    assert.deepEqual(summary.changesRequesters, ['alice']);
  }
});

test('approving after your own change request clears it', () => {
  const summary = summarizeReviews([
    reviewNode('alice', 'CHANGES_REQUESTED', 1),
    reviewNode('alice', 'APPROVED', 2),
  ]);
  assert.equal(summary.state, 'approved');
  assert.deepEqual(summary.approvers, ['alice']);
  assert.deepEqual(summary.changesRequesters, []);
});

test('with two change requests, one reviewer approving later leaves the other standing', () => {
  const summary = summarizeReviews([
    reviewNode('alice', 'CHANGES_REQUESTED', 1),
    reviewNode('bob', 'CHANGES_REQUESTED', 2),
    reviewNode('alice', 'APPROVED', 3),
  ]);
  assert.equal(summary.state, 'changes_requested');
  assert.deepEqual(summary.approvers, ['alice']);
  assert.deepEqual(summary.changesRequesters, ['bob']);
});

test('COMMENTED, DISMISSED and PENDING reviews neither set nor clear the state', () => {
  for (const state of IGNORED_STATES) {
    const afterRequest = summarizeReviews([
      reviewNode('alice', 'CHANGES_REQUESTED', 1),
      reviewNode('alice', state, 2),
      reviewNode('carol', state, 3),
    ]);
    assert.equal(afterRequest.state, 'changes_requested', state);
    assert.deepEqual(afterRequest.approvers, [], state);
    assert.deepEqual(afterRequest.changesRequesters, ['alice'], state);

    const afterApproval = summarizeReviews([
      reviewNode('bob', 'APPROVED', 1),
      reviewNode('bob', state, 2),
      reviewNode('carol', state, 3),
    ]);
    assert.equal(afterApproval.state, 'approved', state);
    assert.deepEqual(afterApproval.approvers, ['bob'], state);
    assert.deepEqual(afterApproval.changesRequesters, [], state);
  }
});

test('no actionable review gives a null state and no reviewers', () => {
  const onlyIgnored = IGNORED_STATES.map((state, i) => reviewNode('alice', state, i + 1));
  for (const nodes of [[], [null], onlyIgnored]) {
    assert.deepEqual(
      summarizeReviews(nodes),
      { state: null, approvers: [], changesRequesters: [] },
      JSON.stringify(nodes),
    );
  }
});

test('with no change request standing the newest actionable review sets the state', () => {
  const approved = summarizeReviews([
    reviewNode('alice', 'APPROVED', 1),
    reviewNode('bob', 'APPROVED', 2),
  ]);
  assert.equal(approved.state, 'approved');
  assert.deepEqual(approved.approvers, ['alice', 'bob']);
  assert.deepEqual(approved.changesRequesters, []);

  const unordered = summarizeReviews([
    reviewNode('bob', 'APPROVED', 2),
    reviewNode('alice', 'COMMENTED', 3),
    reviewNode('carol', 'APPROVED', 1),
  ]);
  assert.equal(unordered.state, 'approved');
});

test('reviews with no login keep the newest-wins state when no named reviewer is requesting changes', () => {
  const newerRequest = summarizeReviews([
    reviewNode('alice', 'APPROVED', 1),
    ghostNode('CHANGES_REQUESTED', 2),
  ]);
  assert.equal(newerRequest.state, 'changes_requested');
  assert.deepEqual(newerRequest.approvers, ['alice']);
  assert.deepEqual(newerRequest.changesRequesters, []);

  const olderRequest = summarizeReviews([
    ghostNode('CHANGES_REQUESTED', 1),
    reviewNode('alice', 'APPROVED', 2),
  ]);
  assert.equal(olderRequest.state, 'approved');
  assert.deepEqual(olderRequest.changesRequesters, []);

  const onlyApproval = summarizeReviews([ghostNode('APPROVED', 1)]);
  assert.equal(onlyApproval.state, 'approved');
  assert.deepEqual(onlyApproval.approvers, []);
});

test('approval filter is strict and excludes unavailable review data', () => {
  const prs = [
    { number: 1, reviews: { available: true, approvers: ['alice', 'alice'] } },
    { number: 2, reviews: { available: true, approvers: ['alice', 'bob'] } },
    { number: 3, reviews: { available: true, approvers: [] } },
    { number: 4, reviews: null },
  ];
  assert.equal(approvalCount(prs[0]), 1);
  assert.deepEqual(
    filterPrsNeedingApprovals(prs, 2).map((pr) => pr.number),
    [1, 3],
  );
});

test('review fetch distinguishes zero approvals from unavailable data', async () => {
  const previousToken = process.env.GH_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.GH_TOKEN = 'test-token';
  const prs = [{ repo: 'owner/repo', number: 1 }];
  try {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        data: { a0: { pullRequest: { reviewDecision: null, reviews: { nodes: [] } } } },
      }),
    });
    const zero = await fetchReviewData(prs);
    assert.equal(zero.available, true);
    assert.equal(zero.reviews['owner/repo#1'].available, true);
    assert.equal(zero.reviews['owner/repo#1'].approvers.length, 0);

    globalThis.fetch = async () => ({ ok: false, status: 500 });
    const unavailable = await fetchReviewData(prs);
    assert.equal(unavailable.available, false);
    assert.deepEqual(unavailable.reviews, {});
  } finally {
    if (previousToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousToken;
    globalThis.fetch = previousFetch;
  }
});

test('review fetch paginates review history before counting approvals', async () => {
  const previousToken = process.env.GH_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.GH_TOKEN = 'test-token';
  const prs = [{ repo: 'owner/repo', number: 1 }];
  let calls = 0;
  try {
    globalThis.fetch = async (_url, options) => {
      calls++;
      const body = JSON.parse(options.body);
      assert.match(body.query, calls === 1 ? /reviews\(first: 100\)/ : /after: "cursor-1"/);
      return {
        ok: true,
        json: async () => ({
          data: {
            a0: {
              pullRequest: {
                reviewDecision: 'APPROVED',
                reviews:
                  calls === 1
                    ? { pageInfo: { hasNextPage: true, endCursor: 'cursor-1' }, nodes: [] }
                    : {
                        pageInfo: { hasNextPage: false, endCursor: null },
                        nodes: [
                          {
                            state: 'APPROVED',
                            submittedAt: '2026-01-01T00:00:00Z',
                            author: { login: 'alice' },
                          },
                        ],
                      },
              },
            },
          },
        }),
      };
    };
    const result = await fetchReviewData(prs);
    assert.equal(calls, 2);
    assert.deepEqual(result.reviews['owner/repo#1'].approvers, ['alice']);
  } finally {
    if (previousToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousToken;
    globalThis.fetch = previousFetch;
  }
});

test('review fetch reads a standing change request as changes_requested beside a later approval', async () => {
  const previousToken = process.env.GH_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.GH_TOKEN = 'test-token';
  try {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        data: {
          a0: {
            pullRequest: {
              reviewDecision: null,
              reviews: {
                nodes: [
                  reviewNode('alice', 'CHANGES_REQUESTED', 1),
                  reviewNode('bob', 'APPROVED', 2),
                ],
              },
            },
          },
        },
      }),
    });
    const result = await fetchReviewData([{ repo: 'owner/repo', number: 1 }]);
    const summary = result.reviews['owner/repo#1'];
    assert.equal(summary.state, 'changes_requested');
    assert.deepEqual(summary.approvers, ['bob']);
    assert.deepEqual(summary.changesRequesters, ['alice']);
    assert.equal(summary.available, true);
  } finally {
    if (previousToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousToken;
    globalThis.fetch = previousFetch;
  }
});

test('review fetch marks missing pull requests unavailable', async () => {
  const previousToken = process.env.GH_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.GH_TOKEN = 'test-token';
  try {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ data: { a0: { pullRequest: null } } }),
    });
    const result = await fetchReviewData([{ repo: 'owner/repo', number: 1 }]);
    assert.equal(result.available, false);
    assert.deepEqual(result.reviews, {});
  } finally {
    if (previousToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousToken;
    globalThis.fetch = previousFetch;
  }
});

test('approval PR search excludes the authenticated user', async () => {
  const previousToken = process.env.GH_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.GH_TOKEN = 'test-token';
  try {
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/user')) {
        return { ok: true, json: async () => ({ login: 'my-login' }) };
      }
      assert.match(String(url), /\/search\/issues\?/);
      assert.match(decodeURIComponent(String(url)), /-author:my-login/);
      return {
        ok: true,
        json: async () => ({
          total_count: 1,
          items: [
            {
              number: 10,
              title: '[TRIPS-10] Shared PR',
              user: { login: 'review-owner' },
              html_url: 'https://github.com/TransActComm/Portage-backend/pull/10',
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
              draft: false,
              labels: [],
            },
          ],
        }),
      };
    };
    const result = await fetchOpenPRs({ mine: false });
    assert.equal(result.login, 'my-login');
    assert.deepEqual(Object.keys(result.groups), ['TRIPS-10']);
    assert.equal(result.prs[0].owner, 'review-owner');
  } finally {
    if (previousToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousToken;
    globalThis.fetch = previousFetch;
  }
});
