// pr-status-filter.test.mjs — github.filterPrsByTicketStatus is the seam that decides
// which ticketed PR groups survive into "Your open PRs" and "needing
// approval"; the case-insensitive match and the Unticketed exemption are
// pinned here rather than eyeballed against the live Jira/GitHub responses.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as github from '../backend/github.mjs';
import * as jira from '../backend/jira.mjs';

// github.mjs and jira.mjs exist today but do not yet export the symbols under
// test, so these are imported as namespaces (not destructured) — a missing
// export then surfaces as a per-test failure instead of an import-time crash
// that would take the whole file down.

const pr = (number, tickets) => ({
  number,
  repo: 'org/repo',
  title: `pr ${number}`,
  owner: 'dev',
  url: `https://github.com/org/repo/pull/${number}`,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  draft: false,
  labels: [],
  tickets,
});

test('jira.CODE_REVIEW_STATUS and jira.READY_FOR_CODE_REVIEW_STATUS are the exact Jira status names', () => {
  assert.equal(jira.CODE_REVIEW_STATUS, 'Code Review');
  assert.equal(jira.READY_FOR_CODE_REVIEW_STATUS, 'Ready For Code Review');
});

test('a PR with no ticket always passes, regardless of statuses', () => {
  const unticketed = pr(1, []);
  const result = github.filterPrsByTicketStatus([unticketed], {}, 'Code Review');
  assert.deepEqual(result, [unticketed]);

  // Even a populated but unrelated statuses map changes nothing.
  const result2 = github.filterPrsByTicketStatus([unticketed], { 'ABC-1': 'Done' }, 'Code Review');
  assert.deepEqual(result2, [unticketed]);
});

test('a ticketed PR passes when its status matches the target case-insensitively', () => {
  const ticketed = pr(2, ['ABC-1']);
  const result = github.filterPrsByTicketStatus(
    [ticketed],
    { 'ABC-1': 'code review' },
    'Code Review',
  );
  assert.deepEqual(result, [ticketed]);
});

test('a ticketed PR is dropped when its status does not match, is missing, or is null', () => {
  const mismatched = pr(3, ['ABC-2']);
  const missing = pr(4, ['ABC-3']);
  const nullStatus = pr(5, ['ABC-4']);
  const statuses = { 'ABC-2': 'In Progress', 'ABC-4': null };
  const result = github.filterPrsByTicketStatus(
    [mismatched, missing, nullStatus],
    statuses,
    'Code Review',
  );
  assert.deepEqual(result, []);
});

test('filterPrsByTicketStatus composes on top of an already-narrowed list', () => {
  // Simulates the shape filterPrsNeedingApprovals hands off: a flat PR array
  // already reduced to below-threshold PRs, before the status filter runs.
  const mismatched = pr(6, ['ABC-5']);
  const unticketed = pr(7, []);
  const preFiltered = [mismatched, unticketed];
  const statuses = { 'ABC-5': 'In Progress' };
  const result = github.filterPrsByTicketStatus(
    preFiltered,
    statuses,
    jira.READY_FOR_CODE_REVIEW_STATUS,
  );
  assert.deepEqual(result, [unticketed]);
});
