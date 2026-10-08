import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MERGE_STATE_ORDER,
  groupByMergeState,
  parseStoredSelection,
  serializeSelection,
  summarizeRelease,
} from '../ui/releases-data.js';
import { MERGE_STATE_ORDER as SERVER_MERGE_STATE_ORDER } from '../release-model.mjs';

const pr = (number, over = {}) => ({
  repo: 'example/api',
  number,
  title: `Change ${number}`,
  url: `https://github.com/example/api/pull/${number}`,
  state: 'open',
  base: 'ops/development',
  head: `DEMO-${number}/work`,
  updatedAt: '2026-10-06T12:00:00Z',
  countsAsMerged: false,
  ...over,
});

const mergedPr = (number) => pr(number, { state: 'merged', countsAsMerged: true });

const ticket = (key, mergeState, prs = []) => ({
  key,
  summary: `${key} summary`,
  status: 'In Progress',
  issueType: 'Story',
  priority: 'Medium',
  assignee: null,
  updated: '2026-10-06T12:00:00Z',
  mergeState,
  prsStatus: mergeState === 'unavailable' ? 'unavailable' : 'ok',
  prs,
});

const keysByState = (groups) =>
  groups.map(({ state, tickets }) => [state, tickets.map(({ key }) => key)]);

test('groups follow open, partial, no-pr, unavailable, merged and omit empty groups', () => {
  const groups = groupByMergeState([
    ticket('DEMO-1058', 'merged'),
    ticket('DEMO-476', 'open'),
    ticket('DEMO-9', 'partial'),
    ticket('DEMO-1884', 'unavailable'),
    ticket('DEMO-120', 'merged'),
  ]);
  assert.deepEqual(keysByState(groups), [
    ['open', ['DEMO-476']],
    ['partial', ['DEMO-9']],
    ['unavailable', ['DEMO-1884']],
    ['merged', ['DEMO-120', 'DEMO-1058']],
  ]);
});

test('every one of the five states keeps its fixed place when all are present', () => {
  const groups = groupByMergeState([
    ticket('DEMO-5', 'merged'),
    ticket('DEMO-4', 'unavailable'),
    ticket('DEMO-3', 'no-pr'),
    ticket('DEMO-2', 'partial'),
    ticket('DEMO-1', 'open'),
  ]);
  assert.deepEqual(
    groups.map(({ state }) => state),
    ['open', 'partial', 'no-pr', 'unavailable', 'merged'],
  );
});

test('tickets inside a group sort by the number in the key, not by text', () => {
  const groups = groupByMergeState([
    ticket('DEMO-1398', 'open'),
    ticket('DEMO-476', 'open'),
    ticket('DEMO-1000', 'open'),
    ticket('DEMO-98', 'open'),
  ]);
  assert.deepEqual(keysByState(groups), [
    ['open', ['DEMO-98', 'DEMO-476', 'DEMO-1000', 'DEMO-1398']],
  ]);
});

test('an empty release has no groups', () => {
  assert.deepEqual(groupByMergeState([]), []);
});

test('the summary counts tickets per state and PRs in total and counting as merged', () => {
  const summary = summarizeRelease([
    ticket('DEMO-1', 'merged', [mergedPr(1), mergedPr(2)]),
    ticket('DEMO-2', 'partial', [mergedPr(3), pr(4)]),
    // Merged into another base: it is a listed PR, but it does not count as merged.
    ticket('DEMO-3', 'open', [pr(5), pr(6, { state: 'merged', base: 'ops/qa' })]),
    ticket('DEMO-4', 'open', [pr(7)]),
    ticket('DEMO-5', 'no-pr'),
    ticket('DEMO-6', 'unavailable'),
    ticket('DEMO-7', 'merged', [mergedPr(8)]),
  ]);
  assert.deepEqual(summary, {
    tickets: { total: 7, open: 2, partial: 1, 'no-pr': 1, unavailable: 1, merged: 2 },
    prs: { total: 8, merged: 4 },
  });
});

test('the summary of an empty release is all zeros', () => {
  assert.deepEqual(summarizeRelease([]), {
    tickets: { total: 0, open: 0, partial: 0, 'no-pr': 0, unavailable: 0, merged: 0 },
    prs: { total: 0, merged: 0 },
  });
});

test('the merge-state order is the one the server uses', () => {
  assert.deepEqual([...MERGE_STATE_ORDER], ['open', 'partial', 'no-pr', 'unavailable', 'merged']);
  assert.deepEqual([...MERGE_STATE_ORDER], [...SERVER_MERGE_STATE_ORDER]);
});

for (const [stored, expected] of [
  [null, null],
  ['{bad', null],
  ['{"version":2}', null],
  ['{"versionId":"abc"}', null],
  ['{"version":1,"versionId":"18741"}', '18741'],
]) {
  test(`stored selection ${JSON.stringify(stored)} reads as ${JSON.stringify(expected)}`, () => {
    assert.equal(parseStoredSelection(stored), expected);
  });
}

for (const versionId of ['abc', '18741 OR project = X', '', '-1', '0x1']) {
  test(`a stored version id of ${JSON.stringify(versionId)} is not trusted`, () => {
    assert.equal(parseStoredSelection(JSON.stringify({ version: 1, versionId })), null);
  });
}

test('a chosen version serializes to a versioned record that reads back', () => {
  const stored = serializeSelection('18741');
  assert.deepEqual(JSON.parse(stored), { version: 1, versionId: '18741' });
  assert.equal(parseStoredSelection(stored), '18741');
});
