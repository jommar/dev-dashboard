import test from 'node:test';
import assert from 'node:assert/strict';
import * as releasesData from '../ui/releases-data.js';
import {
  MERGE_STATE_ORDER,
  groupByMergeState,
  parseStoredSelection,
  serializeSelection,
  summarizeRelease,
} from '../ui/releases-data.js';
import { MERGE_STATE_ORDER as SERVER_MERGE_STATE_ORDER } from '../backend/release-model.mjs';

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

const mergedPr = (number, over = {}) =>
  pr(number, { state: 'merged', countsAsMerged: true, ...over });

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

test('formatReleaseText formats deploy notes with repo rollup, hoisted scripts/migrations, mismatches, full titles, and compact PRs', () => {
  assert.equal(typeof releasesData.formatReleaseText, 'function', 'formatReleaseText is exported');
  const longSummary =
    'Show and add up staff benefits on invoices the same as old UI, including the Driver Benefits total without mid-word truncation';
  const data = {
    version: {
      id: '18741',
      name: 'EZAT | Sprint 19.0 | 10/09/26',
      released: false,
      releaseDate: '2026-10-09',
    },
    scope: 'all',
    total: 2,
    truncated: false,
    tickets: [
      {
        ...ticket('DEMO-100', 'open', [
          pr(101, { repo: 'TransActComm/TravelTracker', owner: 'dev1' }),
          pr(102, { repo: 'TransActComm/TravelTracker', state: 'declined' }),
        ]),
        summary: longSummary,
        status: 'In QA',
        assignee: 'Developer One',
      },
      {
        ...ticket('DEMO-200', 'merged', [
          mergedPr(201, { repo: 'TransActComm/Portage-backend' }),
          pr(55, {
            repo: 'TransActComm/ezat-data',
            state: 'merged',
            base: 'main',
            countsAsMerged: true,
          }),
        ]),
        status: 'In Progress',
        assignee: 'Colleague Two',
      },
    ],
  };

  const out = releasesData.formatReleaseText(data, {
    state: 'ready',
    truncated: true,
    byTicket: {
      'DEMO-100': [
        {
          kind: 'migration',
          label: '20260101_add.js',
          path: 'setup/knex/migrations/20260101_add.js',
          repo: 'TransActComm/TravelTracker',
          prNumber: 101,
        },
        {
          kind: 'script',
          label: 'backfill.js',
          path: 'setup/scripts/backfill.js',
          repo: 'TransActComm/TravelTracker',
          prNumber: 101,
        },
      ],
      'DEMO-200': [
        {
          kind: 'prisma-schema',
          label: 'client.prisma',
          path: 'libs/client/prisma/client/client.prisma',
          repo: 'TransActComm/Portage-backend',
          prNumber: 201,
        },
      ],
    },
  });

  // Full summary preserved, no mid-word cut.
  assert.ok(out.includes(longSummary));
  // Repo rollup lists app repos before companion repos and drops declined PRs.
  assert.ok(out.includes('== Repos touched'));
  assert.ok(out.includes('TravelTracker  0 merged, 1 open (#101)'));
  assert.ok(out.includes('Portage-backend  1 merged [clear]'));
  assert.ok(out.includes('ezat-data  1 merged [clear]'));
  assert.ok(!out.includes('#102'), 'declined PRs are omitted');
  // Scripts hoisted to top with truncation warning.
  assert.ok(out.includes('== Scripts & Migrations (3)'));
  assert.ok(out.includes('scan incomplete (truncated)'));
  assert.ok(
    out.includes('[Migration] TravelTracker#101 (DEMO-100)  setup/knex/migrations/20260101_add.js'),
  );
  assert.ok(out.includes('[Script] TravelTracker#101 (DEMO-100)  setup/scripts/backfill.js'));
  assert.ok(
    out.includes(
      '[Prisma schema] Portage-backend#201 (DEMO-200)  libs/client/prisma/client/client.prisma',
    ),
  );
  // Mismatches detected in both directions.
  assert.ok(out.includes('== Jira / GitHub Mismatches (2)'));
  assert.ok(out.includes('DEMO-100  Has open PRs, but Jira is "In QA" (Developer One)'));
  assert.ok(out.includes('DEMO-200  All PRs merged, but Jira is "In Progress" (Colleague Two)'));
  // Open PR shows owner, merged PRs compact on one line, no TransActComm/ prefix.
  assert.ok(out.includes('OPEN  TravelTracker#101 -> ops/development (@dev1)'));
  assert.ok(out.includes('merged: Portage-backend#201, ezat-data#55'));
  assert.ok(!out.includes('TransActComm/'));
});

test('formatReleaseSummary formats stakeholder Markdown grouped by Features vs Bug Fixes with clickable Jira links', () => {
  const data = {
    version: {
      id: '18741',
      name: 'EZAT | Sprint 19.0 | 10/09/26',
      released: false,
      releaseDate: '2026-10-09',
    },
    scope: 'all',
    total: 3,
    truncated: false,
    tickets: [
      {
        ...ticket('DEMO-300', 'merged', [mergedPr(1)]),
        summary: 'Minor cosmetic tweak',
        issueType: 'Defect',
        priority: 'P3 - Medium',
        status: 'Done',
        assignee: 'Alex',
      },
      {
        ...ticket('DEMO-100', 'open', [pr(2)]),
        summary: 'Critical invoice fix',
        issueType: 'Defect',
        priority: 'P1 - Critical',
        status: 'In QA',
        assignee: 'Sam',
      },
      {
        ...ticket('DEMO-200', 'merged', [mergedPr(3)]),
        summary: 'New staff benefits rollup',
        issueType: 'Story',
        priority: 'P2 - High',
        status: 'Ready for Release',
        assignee: 'Jommar',
      },
    ],
  };

  const out = releasesData.formatReleaseSummary(data, {
    jiraBase: 'https://example.atlassian.net/browse/',
    scripts: {
      byTicket: {
        'DEMO-200': [{ kind: 'migration', label: '001.js', path: 'setup/knex/migrations/001.js' }],
      },
    },
  });

  assert.ok(out.includes('## EZAT | Sprint 19.0 | 10/09/26'));
  assert.ok(out.includes('### Features & Improvements (1)'));
  assert.ok(out.includes('### Bug Fixes (2)'));
  assert.ok(
    out.includes(
      '- **[DEMO-200](https://example.atlassian.net/browse/DEMO-200)** (P2) — New staff benefits rollup — *Ready for Release · Jommar*',
    ),
  );
  // P1 bug sorts before P3 bug.
  assert.ok(out.indexOf('DEMO-100') < out.indexOf('DEMO-300'));
  // Deploy notes included, PR lines excluded.
  assert.ok(out.includes('### Deploy Notes (Scripts & Migrations)'));
  assert.ok(out.includes('`Migration` `setup/knex/migrations/001.js`'));
  assert.ok(!out.includes('ops/development'));
});

test('finishedColumnsLast moves non-done finished columns (Rejected, Duplicate) to the end after done columns', () => {
  assert.equal(
    typeof releasesData.finishedColumnsLast,
    'function',
    'finishedColumnsLast is exported',
  );
  const columns = [
    {
      id: 'rejected',
      label: 'Rejected',
      kind: 'attention',
      tickets: [{ key: 'DEMO-1', status: 'Rejected', statusCategory: 'Done' }],
    },
    {
      id: 'in-progress',
      label: 'In Progress',
      kind: 'active',
      tickets: [{ key: 'DEMO-2', status: 'In Progress', statusCategory: 'In Progress' }],
    },
    {
      id: 'done',
      label: 'Done',
      kind: 'done',
      tickets: [{ key: 'DEMO-3', status: 'Done', statusCategory: 'Done' }],
    },
  ];
  const ordered = releasesData.finishedColumnsLast(columns);
  assert.deepEqual(
    ordered.map(({ id }) => id),
    ['in-progress', 'done', 'rejected'],
  );
});

test('shortRepoName strips the owner prefix and tolerates bare or empty names', () => {
  assert.equal(releasesData.shortRepoName('TransActComm/Portage-backend'), 'Portage-backend');
  assert.equal(releasesData.shortRepoName('example/web'), 'web');
  assert.equal(releasesData.shortRepoName('standalone'), 'standalone');
  assert.equal(releasesData.shortRepoName(''), '');
  assert.equal(releasesData.shortRepoName(null), '');
});

test('prRollupLabel formats empty, single, partial, and all-merged PR lists', () => {
  assert.equal(releasesData.prRollupLabel([]), 'No PRs');
  assert.equal(releasesData.prRollupLabel(null), 'No PRs');
  assert.equal(releasesData.prRollupLabel([mergedPr(1)]), '1/1 PR merged');
  assert.equal(releasesData.prRollupLabel([pr(1)]), '0/1 PR merged');
  assert.equal(releasesData.prRollupLabel([mergedPr(1), mergedPr(2)]), 'All 2 PRs merged');
  assert.equal(releasesData.prRollupLabel([mergedPr(1), pr(2), pr(3)]), '1/3 PRs merged');
});

test('sortByAssignee groups tickets alphabetically by assignee with Unassigned last and key tie-break', () => {
  const input = [
    { key: 'TAP-2226', assignee: 'Patrick Rivera' },
    { key: 'TAP-1988', assignee: 'EJ Bringuela' },
    { key: 'TAP-3000', assignee: null },
    { key: 'TAP-1869', assignee: 'Patrick Rivera' },
    { key: 'TAP-1000', assignee: '' },
  ];
  assert.deepEqual(
    releasesData.sortByAssignee(input).map((t) => `${releasesData.assigneeLabel(t)}:${t.key}`),
    [
      'EJ Bringuela:TAP-1988',
      'Patrick Rivera:TAP-1869',
      'Patrick Rivera:TAP-2226',
      'Unassigned:TAP-1000',
      'Unassigned:TAP-3000',
    ],
  );
});

test('prMergedText pluralizes PR counts accurately', () => {
  assert.equal(releasesData.prMergedText({ merged: 0, total: 0 }), '0 of 0 PRs merged');
  assert.equal(releasesData.prMergedText({ merged: 1, total: 1 }), '1 of 1 PR merged');
  assert.equal(releasesData.prMergedText({ merged: 2, total: 5 }), '2 of 5 PRs merged');
});

test('formatScriptTarget avoids repeating the label when path already ends with it', () => {
  assert.equal(
    releasesData.formatScriptTarget({
      path: 'setup/scripts/backfill.js',
      label: 'backfill.js',
    }),
    'setup/scripts/backfill.js',
  );
  assert.equal(
    releasesData.formatScriptTarget({
      path: 'package.json',
      label: 'scripts.migrate',
    }),
    'package.json (scripts.migrate)',
  );
  assert.equal(releasesData.formatScriptTarget({ path: '', label: 'backfill.js' }), 'backfill.js');
  assert.equal(releasesData.formatScriptTarget({ path: 'a/b.js', label: '' }), 'a/b.js');
});
