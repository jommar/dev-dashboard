import test from 'node:test';
import assert from 'node:assert/strict';
import { DIFF_TMP_NS, getOriginDiff, parsePrNumber, parseRepoRef } from '../diff.mjs';
import { prItemHtml } from '../ui/components/pr-card.js';

test('copy diff accepts only configured repositories and positive PR numbers', () => {
  assert.equal(parseRepoRef('TransActComm/Portage-backend'), 'Portage-backend');
  assert.equal(parseRepoRef('TransActComm/Portage-frontend'), 'Portage-frontend');
  assert.equal(parseRepoRef('TransActComm/TravelTracker'), 'TravelTracker');
  assert.throws(() => parseRepoRef('../TravelTracker'), /unknown repo/);
  assert.throws(() => parseRepoRef('Other/TravelTracker'), /unknown repo/);

  assert.equal(parsePrNumber('123'), 123);
  for (const value of ['', '0', '-1', '1/../../HEAD', '1.5']) {
    assert.throws(() => parsePrNumber(value), /invalid PR number/);
  }
});

test('copy diff fetches base and PR head, diffs their merge base, then cleans up', async () => {
  const calls = [];
  const runner = async (dir, args) => {
    calls.push({ dir, args });
    if (args[0] === 'rev-parse') {
      return args.at(-1) === 'origin/ops/development' ? 'base-sha\n' : 'head-sha\n';
    }
    if (args[0] === 'diff') return 'diff --git a/a.js b/a.js\n';
    return '';
  };

  const result = await getOriginDiff({ repo: 'TransActComm/TravelTracker', number: 42 }, runner, {
    dir: '/tmp/TravelTracker',
  });

  assert.equal(result.repo, 'TransActComm/TravelTracker');
  assert.equal(result.number, 42);
  assert.equal(result.baseSha, 'base-sha');
  assert.equal(result.headSha, 'head-sha');
  assert.equal(result.diff, 'diff --git a/a.js b/a.js\n');

  const tempRef = calls[1].args.at(-1).split(':')[1];
  assert.match(tempRef, new RegExp(`^${DIFF_TMP_NS}42-`));
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      [
        'fetch',
        '--no-tags',
        'origin',
        '+refs/heads/ops/development:refs/remotes/origin/ops/development',
      ],
      ['fetch', '--no-tags', 'origin', `pull/42/head:${tempRef}`],
      ['rev-parse', '--verify', 'origin/ops/development'],
      ['rev-parse', '--verify', tempRef],
      ['diff', '--no-color', '--no-ext-diff', `origin/ops/development...${tempRef}`, '--'],
      ['update-ref', '-d', tempRef],
    ],
  );
});

test('copy diff cleans up its temporary ref when git diff fails', async () => {
  const calls = [];
  const runner = async (_dir, args) => {
    calls.push(args);
    if (args[0] === 'rev-parse') return 'sha\n';
    if (args[0] === 'diff') throw new Error('diff failed');
    return '';
  };

  await assert.rejects(
    getOriginDiff({ repo: 'TransActComm/Portage-frontend', number: 7 }, runner, {
      dir: '/tmp/Portage-frontend',
    }),
    /diff failed/,
  );
  assert.equal(calls.at(-1)[0], 'update-ref');
  assert.deepEqual(calls.at(-1).slice(1, 3), ['-d', calls[1].at(-1).split(':')[1]]);
});

test('PR card renders an accessible diff viewer button', () => {
  const html = prItemHtml(
    { repo: 'TransActComm/TravelTracker', number: 99 },
    { variant: 'pr-open' },
  );
  assert.match(html, /class="[^"]*\bview-diff\b[^"]*"/);
  assert.match(html, /data-repo="TransActComm\/TravelTracker"/);
  assert.match(html, /data-number="99"/);
  assert.match(html, /aria-label="View diff vs origin\/ops\/development"/);
  assert.match(html, /data-testid="pr-open-view-diff-TransActComm\/TravelTracker-99"/);
  assert.doesNotMatch(html, /class="[^"]*copy-diff/);
});
