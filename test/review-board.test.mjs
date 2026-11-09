import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { deepFreeze } from '../e2e/deep-freeze.mjs';

const selectorUrl = new URL('../ui/review-board.js', import.meta.url);
const selectors = existsSync(selectorUrl) ? await import(selectorUrl) : {};
const selector = (name) => {
  assert.equal(typeof selectors[name], 'function', `${name} is a public review-board selector`);
  return selectors[name];
};

const COVERAGE = deepFreeze({
  available: true,
  complete: true,
  repos: ['ExampleOrg/frontend', 'ExampleOrg/backend'],
  reasons: [],
});
const LANES = [
  { id: 'to-review', label: 'To Review' },
  { id: 'reviewing', label: 'Reviewing' },
  { id: 'reviewed', label: 'Reviewed' },
];
const pr = (state = 'awaiting', extra = {}) => ({
  repo: 'ExampleOrg/frontend',
  number: 17,
  title: 'Update the filter layout',
  url: 'https://github.com/ExampleOrg/frontend/pull/17',
  owner: 'another-developer',
  draft: false,
  updatedAt: '2026-11-09T10:00:00Z',
  review: {
    complete: state !== 'unknown',
    state,
    approvers: state === 'approved' ? ['third-party-reviewer'] : [],
    changesRequesters: state === 'changes_requested' ? ['other-reviewer'] : [],
    reviewDecision: null,
  },
  ...extra,
});
const ticket = (key, prs = [], extra = {}) => ({
  key,
  summary: `Summary of ${key}`,
  status: 'Ready For Code Review',
  statusCategory: 'In Progress',
  priority: 'Medium',
  updated: '2026-11-09T10:00:00Z',
  created: '2026-11-01T10:00:00Z',
  sprint: null,
  sprints: [],
  prs,
  ...extra,
});
const APPROVED = pr('approved');
const BACKEND_PENDING = pr('awaiting', { repo: 'ExampleOrg/backend', title: 'Persist settings' });
const MIXED = ticket('ABC-101', [APPROVED, BACKEND_PENDING]);
const NO_PR = ticket('ABC-102');

test('the DOM-free review-board module exposes all three selectors without import-only failures', () => {
  assert.ok(existsSync(selectorUrl), 'ui/review-board.js exists');
  for (const name of ['reviewProgress', 'filterReviewTickets', 'reviewColumns']) selector(name);
  const source = readFileSync(selectorUrl, 'utf8');
  assert.doesNotMatch(source, /\b(?:document|window)\./);
  assert.doesNotMatch(source, /backend\//);
});

test('reviewProgress implements the complete three-lane truth table from every active PR', () => {
  const progress = selector('reviewProgress');
  const table = [
    ['no linked open PRs', [], 'to-review'],
    ['awaiting review', [pr()], 'to-review'],
    ['draft without activity', [pr('awaiting', { draft: true })], 'to-review'],
    ['comment-only normalized evidence', [pr('awaiting')], 'to-review'],
    ['pending-only normalized evidence', [pr('awaiting')], 'to-review'],
    ['approval by a third party', [APPROVED], 'reviewed'],
    [
      'all approved across repos, including same-number PRs',
      [APPROVED, pr('approved', { repo: 'ExampleOrg/backend' })],
      'reviewed',
    ],
    ['approved frontend and awaiting backend', MIXED.prs, 'reviewing'],
    ['standing request without approval', [pr('changes_requested')], 'reviewing'],
    ['approval and standing request', [APPROVED, pr('changes_requested')], 'reviewing'],
    ['approved draft never completes', [pr('approved', { draft: true })], 'reviewing'],
    ['approved PR and unreviewed draft', [APPROVED, pr('awaiting', { draft: true })], 'reviewing'],
    ['draft with standing request', [pr('changes_requested', { draft: true })], 'reviewing'],
    [
      'REVIEW_REQUIRED does not veto current individual approval',
      [{ ...APPROVED, review: { ...APPROVED.review, reviewDecision: 'REVIEW_REQUIRED' } }],
      'reviewed',
    ],
    [
      'overall APPROVED does not require an individual approval count',
      [{ ...APPROVED, review: { ...APPROVED.review, approvers: [], reviewDecision: 'APPROVED' } }],
      'reviewed',
    ],
    [
      'CI failure is not a review-progress gate',
      [pr('approved', { ci: { state: 'failing' } })],
      'reviewed',
    ],
  ];
  for (const [name, prs, expected] of table) {
    assert.equal(progress(ticket('ABC-103', prs), COVERAGE), expected, name);
  }
});

test('unavailable or incomplete repository discovery outranks approvals, requests and empty PR lists', () => {
  const progress = selector('reviewProgress');
  for (const coverage of [
    { ...COVERAGE, available: false, complete: false, reasons: ['github_unavailable'] },
    { ...COVERAGE, complete: false, reasons: ['repository_incomplete'] },
  ]) {
    for (const prs of [[], [APPROVED], [pr('changes_requested')], MIXED.prs]) {
      assert.equal(progress(ticket('ABC-104', prs), coverage), 'to-review');
    }
  }
});

test('an incomplete or missing individual review prevents completion without poisoning other tickets', () => {
  const progress = selector('reviewProgress');
  for (const review of [
    { ...APPROVED.review, complete: false },
    pr('unknown').review,
    null,
    undefined,
  ]) {
    const unreadable = { ...APPROVED, repo: 'ExampleOrg/backend', review };
    assert.equal(progress(ticket('ABC-105', [APPROVED, unreadable]), COVERAGE), 'to-review');
  }
  assert.equal(progress(ticket('ABC-106', [APPROVED]), COVERAGE), 'reviewed');
});

test('reviewColumns returns three fixed ordered columns and ticket counts, retaining input order', () => {
  const columns = selector('reviewColumns');
  const done = ticket('ABC-107', [APPROVED]);
  const secondUnreviewed = ticket('ABC-108', [pr()]);
  assert.deepEqual(columns([done, NO_PR, MIXED, secondUnreviewed], COVERAGE), [
    { ...LANES[0], tickets: [NO_PR, secondUnreviewed] },
    { ...LANES[1], tickets: [MIXED] },
    { ...LANES[2], tickets: [done] },
  ]);
  assert.deepEqual(columns([done], COVERAGE), [
    { ...LANES[0], tickets: [] },
    { ...LANES[1], tickets: [] },
    { ...LANES[2], tickets: [done] },
  ]);
  assert.deepEqual(columns([], COVERAGE), []);
});

test('default and cleared filters include PR-free tickets as original whole ticket objects', () => {
  const filter = selector('filterReviewTickets');
  const rows = [MIXED, NO_PR];
  for (const filters of [undefined, {}, { search: '', repo: '', review: '' }]) {
    const result = filter(rows, filters);
    assert.deepEqual(result, rows);
    assert.equal(result[0], MIXED);
    assert.equal(result[0].prs, MIXED.prs);
    assert.equal(result[1], NO_PR);
  }
});

test('retired saved Section values never select tickets or assign progress', () => {
  const filter = selector('filterReviewTickets');
  const columns = selector('reviewColumns');
  for (const section of ['open', 'draft', 'approval', 'uat', 'reviewed']) {
    assert.deepEqual(filter([NO_PR, MIXED], { section }), [NO_PR, MIXED]);
    assert.deepEqual(
      columns([NO_PR, MIXED], COVERAGE, { section }),
      columns([NO_PR, MIXED], COVERAGE),
    );
  }
});

test('any matching PR selects its entire ticket without removing lines or manufacturing Reviewed', () => {
  const filter = selector('filterReviewTickets');
  const columns = selector('reviewColumns');
  for (const filters of [
    { repo: APPROVED.repo },
    { repo: BACKEND_PENDING.repo },
    { review: 'approved' },
    { review: 'awaiting' },
    { search: APPROVED.title },
    { search: BACKEND_PENDING.title },
  ]) {
    const result = filter([MIXED, NO_PR], filters);
    assert.deepEqual(result, [MIXED], JSON.stringify(filters));
    assert.equal(result[0].prs, MIXED.prs);
    assert.deepEqual(columns([MIXED, NO_PR], COVERAGE, filters), [
      { ...LANES[0], tickets: [] },
      { ...LANES[1], tickets: [MIXED] },
      { ...LANES[2], tickets: [] },
    ]);
  }
});

test('search covers Jira key/summary and every PR title/repository/number case-insensitively', () => {
  const filter = selector('filterReviewTickets');
  for (const search of [
    'abc-101',
    'SUMMARY OF ABC-101',
    'persist SETTINGS',
    'exampleorg/BACKEND',
    '17',
  ]) {
    assert.deepEqual(filter([MIXED, NO_PR], { search }), [MIXED], search);
  }
  assert.deepEqual(filter([MIXED, NO_PR], { search: NO_PR.key.toLowerCase() }), [NO_PR]);
});

test('PR-free tickets match All but never a specific PR repository or review filter', () => {
  const filter = selector('filterReviewTickets');
  assert.deepEqual(filter([NO_PR]), [NO_PR]);
  for (const review of ['approved', 'changes_requested', 'awaiting', 'unknown']) {
    assert.deepEqual(filter([NO_PR], { review }), [], review);
  }
  assert.deepEqual(filter([NO_PR], { repo: APPROVED.repo }), []);
});

test('unknown review filters include incomplete evidence, not its stale approved state', () => {
  const filter = selector('filterReviewTickets');
  const incomplete = ticket('ABC-109', [
    { ...APPROVED, review: { ...APPROVED.review, complete: false } },
  ]);
  const unknown = ticket('ABC-110', [pr('unknown')]);
  assert.deepEqual(filter([MIXED, NO_PR, incomplete, unknown], { review: 'unknown' }), [
    incomplete,
    unknown,
  ]);
  assert.deepEqual(filter([incomplete], { review: 'approved' }), []);
});

test('search/repository/review criteria combine without turning filters into progress', () => {
  const filter = selector('filterReviewTickets');
  assert.deepEqual(
    filter([MIXED, NO_PR], { search: MIXED.key, repo: APPROVED.repo, review: 'approved' }),
    [MIXED],
  );
  assert.deepEqual(filter([MIXED, NO_PR], { search: NO_PR.key, repo: APPROVED.repo }), []);
  assert.deepEqual(filter([MIXED], { repo: 'ExampleOrg/not-watched' }), []);
  assert.deepEqual(filter([MIXED], { review: 'changes_requested' }), []);
});

test('incomplete discovery keeps every eligible ticket and known PR in To Review through filters', () => {
  const columns = selector('reviewColumns');
  const coverage = { ...COVERAGE, complete: false, reasons: ['repository_incomplete'] };
  assert.deepEqual(columns([MIXED, NO_PR], coverage), [
    { ...LANES[0], tickets: [MIXED, NO_PR] },
    { ...LANES[1], tickets: [] },
    { ...LANES[2], tickets: [] },
  ]);
  const filtered = columns([MIXED, NO_PR], coverage, { review: 'approved' });
  assert.deepEqual(filtered[0].tickets, [MIXED]);
  assert.equal(filtered[0].tickets[0].prs, MIXED.prs);
  assert.deepEqual(
    columns([MIXED, NO_PR], coverage, { search: 'no such ticket' }),
    LANES.map((lane) => ({ ...lane, tickets: [] })),
  );
});

test('successive snapshots move progress automatically in both directions with no stored lane', () => {
  const progress = selector('reviewProgress');
  const done = ticket(MIXED.key, [APPROVED]);
  const requested = ticket(MIXED.key, [
    APPROVED,
    pr('changes_requested', { repo: 'ExampleOrg/backend' }),
  ]);
  assert.equal(progress(done, COVERAGE), 'reviewed');
  assert.equal(progress(MIXED, COVERAGE), 'reviewing');
  assert.equal(progress(requested, COVERAGE), 'reviewing');
  assert.equal(progress(ticket(MIXED.key, [pr()]), COVERAGE), 'to-review');
  assert.equal(progress(structuredClone(done), COVERAGE), 'reviewed');
});

test('selectors are DOM-free pure projections of frozen inputs and default empty lists', () => {
  const progress = selector('reviewProgress');
  const filter = selector('filterReviewTickets');
  const columns = selector('reviewColumns');
  const rows = deepFreeze(structuredClone([MIXED, NO_PR]));
  const before = structuredClone(rows);
  const filters = Object.freeze({ repo: APPROVED.repo, section: 'uat' });
  progress(rows[0], COVERAGE);
  filter(rows, filters);
  columns(rows, COVERAGE, filters);
  assert.deepEqual(rows, before);
  assert.deepEqual(filter(), []);
  assert.deepEqual(columns(undefined, COVERAGE), []);
});

test('ticket prefix matches exact ticket keys AND existing filters without changing lanes or PR identities', () => {
  const filter = selector('filterReviewTickets');
  const columns = selector('reviewColumns');
  const rows = deepFreeze([
    ticket('ALPHA-1', [APPROVED, BACKEND_PENDING]),
    ticket('ALPHA-2'),
    ticket('ALPHAX-3', [pr('approved', { title: 'ALPHA-999 unrelated title key' })]),
    ticket('BETA-4'),
  ]);
  const before = structuredClone(rows);
  assert.deepEqual(filter(rows, { prefix: 'ALPHA' }), rows.slice(0, 2));
  assert.deepEqual(filter(rows, { prefix: 'BETA' }), [rows[3]], 'PR-free tickets match prefix');
  assert.deepEqual(filter(rows, { prefix: 'GAMMA' }), []);
  assert.deepEqual(filter(rows, { prefix: '' }), rows, 'All restores every ticket');
  const filters = Object.freeze({
    prefix: 'ALPHA',
    search: BACKEND_PENDING.title,
    repo: APPROVED.repo,
    review: 'approved',
  });
  const result = filter(rows, filters);
  assert.deepEqual(result, [rows[0]]);
  assert.equal(result[0], rows[0]);
  assert.equal(result[0].prs, rows[0].prs, 'all PR lines retain their identities');
  assert.deepEqual(filter(rows, { ...filters, prefix: 'BETA' }), []);
  assert.deepEqual(columns(rows, COVERAGE, filters), [
    { ...LANES[0], tickets: [] },
    { ...LANES[1], tickets: [rows[0]] },
    { ...LANES[2], tickets: [] },
  ]);
  assert.deepEqual(
    columns(rows, { ...COVERAGE, complete: false }, filters),
    LANES.map((lane, index) => ({ ...lane, tickets: index === 0 ? [rows[0]] : [] })),
    'prefix cannot override incomplete-data precedence',
  );
  assert.deepEqual(rows, before);
});
