import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Loaded inside each test so a missing module fails that test, not the whole file.
const checkouts = () => import('../backend/checkouts.mjs');

const SHA = (digit) => digit.repeat(40);

// `git worktree list --porcelain -z`: NUL-terminated attributes, an empty token ends a record.
const record = (...attributes) => `${attributes.join('\0')}\0\0`;

const PORCELAIN = [
  record('worktree /r/main', `HEAD ${SHA('a')}`, 'branch refs/heads/master'),
  record('worktree /r/.wt/b-feat', `HEAD ${SHA('b')}`, 'branch refs/heads/b-feat'),
  record('worktree /r/.wt/a fix', `HEAD ${SHA('c')}`, 'branch refs/heads/a-fix'),
  record('worktree /r/.wt/loose', `HEAD 9f8e7d6c${'0'.repeat(32)}`, 'detached'),
  record(
    'worktree /r/.wt/gone',
    `HEAD ${SHA('d')}`,
    'branch refs/heads/gone',
    'prunable gitdir file points to non-existent location',
  ),
  record('worktree /r/bare.git', 'bare'),
].join('');

test('checkout 1: lists main first, the rest by label, and skips bare and prunable records', async () => {
  const calls = [];
  const run = async (dir, args, options) => {
    calls.push({ dir, args, options });
    return PORCELAIN;
  };
  const { listWorktrees } = await checkouts();
  const worktrees = await listWorktrees('/r/main', { run });
  assert.deepEqual(worktrees, [
    { path: '/r/main', label: 'master', isMain: true },
    { path: '/r/.wt/loose', label: '9f8e7d6 (detached)', isMain: false },
    { path: '/r/.wt/a fix', label: 'a-fix', isMain: false },
    { path: '/r/.wt/b-feat', label: 'b-feat', isMain: false },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].dir, '/r/main');
  assert.deepEqual(calls[0].args, ['worktree', 'list', '--porcelain', '-z']);
});

test('checkout 1: a git failure throws WORKTREES_UNAVAILABLE with status 502', async () => {
  const run = async () => {
    throw new Error('git worktree failed: not a git repository');
  };
  const { listWorktrees } = await checkouts();
  await assert.rejects(
    listWorktrees('/r/main', { run }),
    (error) => error.code === 'WORKTREES_UNAVAILABLE' && error.status === 502,
  );
});

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-dashboard-checkouts-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, '.config', 'dev-dashboard', 'checkouts.json');
  return { home, file };
}

test('checkout 2: a set survives a new store and set to null removes the entry', async (t) => {
  const { createCheckoutStore } = await checkouts();
  const { home, file } = tempHome(t);
  const main = '/repos/Portage-backend';
  const worktree = '/repos/.worktrees/Portage-backend/x';
  assert.equal(createCheckoutStore({ home }).get(main), undefined);
  await createCheckoutStore({ home }).set(main, worktree);
  assert.equal(createCheckoutStore({ home }).get(main), worktree);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    version: 1,
    checkouts: { [main]: worktree },
  });
  await createCheckoutStore({ home }).set(main, null);
  assert.equal(createCheckoutStore({ home }).get(main), undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).checkouts, {});
});

test('checkout 2: a corrupt file reads as empty and the next set writes a valid file', async (t) => {
  const { createCheckoutStore } = await checkouts();
  const { home, file } = tempHome(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json');
  const store = createCheckoutStore({ home });
  assert.equal(store.get('/repos/Portage-backend'), undefined);
  await store.set('/repos/Portage-backend', '/repos/.worktrees/Portage-backend/x');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    version: 1,
    checkouts: { '/repos/Portage-backend': '/repos/.worktrees/Portage-backend/x' },
  });
});

test('checkout 2: an entry that is not an absolute path reads as undefined', async (t) => {
  const { createCheckoutStore } = await checkouts();
  const { home, file } = tempHome(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      checkouts: { '/repos/a': 'relative/x', '/repos/b': 7, '/repos/c': '/repos/.wt/c' },
    }),
  );
  const store = createCheckoutStore({ home });
  assert.equal(store.get('/repos/a'), undefined);
  assert.equal(store.get('/repos/b'), undefined);
  assert.equal(store.get('/repos/c'), '/repos/.wt/c');
});

test('checkout 1: lists real worktrees whose paths hold newlines and attribute-like text whole', async (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dev-dashboard-wt-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const main = path.join(base, 'main');
  const git = (cwd, ...args) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.com',
        '-c',
        'init.defaultBranch=master',
        ...args,
      ],
      { cwd, encoding: 'utf8' },
    );
  fs.mkdirSync(main);
  git(main, 'init');
  git(main, 'commit', '--allow-empty', '-m', 'first');
  const odd = [
    `${base}/trailing\n`,
    `${base}/spoof\nHEAD ${SHA('e')}`,
    `${base}/forge\nworktree ${base}/forged`,
    `${base}/block\n\nworktree ${base}/forged-block`,
  ];
  odd.forEach((dir, index) => git(main, 'worktree', 'add', '-b', `odd-${index}`, dir));
  const { listWorktrees } = await checkouts();
  const listed = (await listWorktrees(main)).map(({ path: found }) => found);
  assert.deepEqual([...listed].sort(), [main, ...odd].sort());
  for (const invented of [`${base}/trailing`, `${base}/spoof`, `${base}/forge`, `${base}/forged`])
    assert.equal(listed.includes(invented), false, invented);
});

test('checkout 1: the main entry is the one the directory points at, not the first record', async () => {
  const run = async () =>
    record('worktree /r/main', `HEAD ${SHA('a')}`, 'branch refs/heads/master') +
    record('worktree /r/.wt/linked', `HEAD ${SHA('b')}`, 'branch refs/heads/linked');
  const { listWorktrees } = await checkouts();
  assert.deepEqual(await listWorktrees('/r/.wt/linked', { run }), [
    { path: '/r/.wt/linked', label: 'linked', isMain: true },
    { path: '/r/main', label: 'master', isMain: false },
  ]);
});

test('checkout 1: a directory that is not a listed worktree root is WORKTREES_UNAVAILABLE', async () => {
  const run = async () =>
    record('worktree /r/main', `HEAD ${SHA('a')}`, 'branch refs/heads/master');
  const { listWorktrees } = await checkouts();
  await assert.rejects(
    listWorktrees('/r/main/ui', { run }),
    (error) => error.code === 'WORKTREES_UNAVAILABLE' && error.status === 502,
  );
});

// ---- matchWorktrees: which worktree of a repo belongs to a ticket ----

const wt = (label, extra = {}) => ({ path: `/r/.wt/${label}`, label, isMain: false, ...extra });
const MAIN_WT = { path: '/r/main', label: 'master', isMain: true };

test('matchWorktrees one: a single worktree branch naming the ticket is the match', async () => {
  const { matchWorktrees } = await checkouts();
  const result = matchWorktrees('TAP-14', [
    MAIN_WT,
    wt('tap-14-other'),
    wt('tap-145-x'),
    wt('tap-1454-fix'),
  ]);
  assert.deepEqual(result, { status: 'match', path: '/r/.wt/tap-14-other', label: 'tap-14-other' });
  // Case and a leading folder in the branch name do not matter; a longer word around it does.
  assert.equal(matchWorktrees('TAP-14', [MAIN_WT, wt('feature/TAP-14-x')]).status, 'match');
  assert.equal(matchWorktrees('TAP-14', [MAIN_WT, wt('xtap-14-x')]).status, 'none');
});

test('matchWorktrees ambiguous: two matches refuse, naming both and choosing neither', async () => {
  const { matchWorktrees } = await checkouts();
  const result = matchWorktrees('TAP-14', [MAIN_WT, wt('tap-14-b'), wt('tap-14-a')]);
  assert.deepEqual(result, { status: 'ambiguous', candidates: ['tap-14-a', 'tap-14-b'] });
  assert.equal('path' in result, false);
});

test('matchWorktrees none: the main checkout, a detached head and no hit never match', async () => {
  const { matchWorktrees } = await checkouts();
  assert.deepEqual(
    matchWorktrees('TAP-14', [
      { path: '/r/main', label: 'tap-14-main', isMain: true },
      wt('abc1234 (detached)', { path: '/r/.wt/tap-14-loose' }),
    ]),
    { status: 'none' },
  );
  assert.deepEqual(matchWorktrees('TAP-14', [MAIN_WT]), { status: 'none' });
  assert.deepEqual(matchWorktrees('TAP-14', []), { status: 'none' });
  for (const bad of ['x', '', null, undefined, 'tap-14', 'TAP-', 'TAP-14-x', 14])
    assert.deepEqual(matchWorktrees(bad, [wt('tap-14-x')]), { status: 'none' }, String(bad));
});

test('matchWorktrees alias: a TAP key also matches a pre-rename trips branch, and the reverse', async () => {
  const { matchWorktrees } = await checkouts();
  const trips = [MAIN_WT, wt('trips-1877-fix')];
  assert.equal(matchWorktrees('TAP-1877', trips).label, 'trips-1877-fix');
  assert.equal(matchWorktrees('TRIPS-1877', [MAIN_WT, wt('tap-1877-fix')]).label, 'tap-1877-fix');
  assert.equal(matchWorktrees('TAP-1877', [MAIN_WT, wt('tap-18770')]).status, 'none');
  assert.equal(matchWorktrees('TAP-1877', [MAIN_WT, wt('trips-18770')]).status, 'none');
  // Any other project key matches only itself.
  assert.equal(matchWorktrees('ABC-5', [MAIN_WT, wt('tap-5-x')]).status, 'none');
  assert.equal(matchWorktrees('ABC-5', [MAIN_WT, wt('abc-5-x')]).status, 'match');
  // The same branch under both spellings is one worktree, so one match (not ambiguous).
  assert.equal(matchWorktrees('TAP-1877', [MAIN_WT, wt('tap-1877-trips-1877')]).status, 'match');
});
