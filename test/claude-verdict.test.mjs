// claude-verdict.test.mjs — the one-line outcome a finished e2e check or groom session writes first
// in its report: read as a closed enum, bounded, cached, never logged, and attached to the ticket
// entry only when that session is done. Real temp directories; no `claude` ever starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VERDICT_FILES,
  createClaudeArtifacts,
  parseVerdict,
} from '../backend/claude-artifacts.mjs';
import { VERDICT_TONE, VERDICT_WORDS, verdictWord } from '../ui/claude-verdict.js';
import {
  E2E,
  GROOM,
  GROOM_NAME,
  KEY,
  SLUG,
  e2eEntry,
  e2eRecord,
  launchRecord,
  launcherEnvironment,
  listed,
} from './claude-launcher-fixture.mjs';

const KEY_LOWER = KEY.toLowerCase();

function workspace(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, 'pathwise', '.orchestrator', KEY_LOWER);
  fs.mkdirSync(dir, { recursive: true });
  return { home, dir };
}

const parse = (name, head) => parseVerdict(name, Buffer.from(head));

test('verdict: e2e values', () => {
  for (const [head, value] of [
    ['Verdict: PASS\nbody', 'PASS'],
    ['Verdict: FAIL\n', 'FAIL'],
    ['Verdict: PARTIAL', 'PARTIAL'],
    ['Verdict: BLOCKED: login expired\nmore', 'BLOCKED'],
  ])
    assert.equal(parse('e2e.md', head), value, head);
  assert.equal(typeof parse('e2e.md', 'Verdict: BLOCKED: login expired'), 'string');
});

test('verdict: groom values', () => {
  for (const value of ['READY', 'NEEDS_INFO', 'BLOCKED'])
    assert.equal(parse('groom.md', `Readiness: ${value}\n`), value);
  assert.equal(parse('groom.md', 'Verdict: READY'), null, 'the e2e label in a groom file');
  assert.equal(parse('e2e.md', 'Readiness: PASS'), null, 'the groom label in an e2e file');
  assert.equal(parse('groom.md', 'Readiness: PASS'), null, 'a value of the other file');
  assert.equal(parse('02-plan.md', 'Verdict: PASS'), null, 'a file that has no verdict');
});

test('verdict: closed enum', () => {
  for (const head of [
    'Verdict: pass',
    'Verdict: MAYBE',
    'Verdict: PASSED',
    'Verdict: PASS_ISH',
    'Verdict:',
    'Verdict',
    '',
    '   \n\n  ',
    'Summary first\nVerdict: PASS',
    'Verdict: PASS\0',
    '\0Verdict: PASS',
  ])
    assert.equal(parse('e2e.md', head), null, JSON.stringify(head));
  assert.equal(parse('groom.md', 'Readiness: NEEDS'), null);
  assert.equal(parse('groom.md', 'Readiness: NEEDS_INFORMATION'), null);
  assert.equal(parseVerdict('e2e.md', undefined), null);
  assert.equal(parseVerdict('e2e.md', 42), null);
});

test('verdict: decoration', () => {
  assert.equal(parse('e2e.md', '# Verdict: PASS'), 'PASS');
  assert.equal(parse('e2e.md', '**Verdict: FAIL**'), 'FAIL');
  assert.equal(parse('e2e.md', '> Verdict: PARTIAL'), 'PARTIAL');
  assert.equal(
    parse('e2e.md', '\n\n  Verdict: PASS\nVerdict: FAIL'),
    'PASS',
    'first non-empty line',
  );
  assert.equal(parse('groom.md', '## **Readiness: READY**'), 'READY');
  assert.equal(parse('e2e.md', 'Verdict:PASS'), 'PASS');
});

test('verdict: safe and cached', (t) => {
  const { home, dir } = workspace(t);
  const opens = [];
  const spy = new Proxy(fs, {
    get(target, property) {
      const value = target[property];
      if (typeof value !== 'function') return value;
      return (...args) => {
        if (property === 'openSync' || property === 'readFileSync')
          opens.push({ method: property, file: String(args[0]) });
        return value.apply(target, args);
      };
    },
  });
  const artifacts = createClaudeArtifacts({ home, fs: spy });

  // A symlinked file, a folder named like the file, a link out of the root, a missing file.
  fs.writeFileSync(path.join(home, 'outside.md'), 'Verdict: PASS\n');
  fs.symlinkSync(path.join(home, 'outside.md'), path.join(dir, 'e2e.md'));
  assert.equal(artifacts.verdict(KEY, 'e2e.md'), null, 'symlinked file');
  fs.rmSync(path.join(dir, 'e2e.md'));
  fs.mkdirSync(path.join(dir, 'e2e.md'));
  assert.equal(artifacts.verdict(KEY, 'e2e.md'), null, 'folder');
  fs.rmdirSync(path.join(dir, 'e2e.md'));
  assert.equal(artifacts.verdict(KEY, 'e2e.md'), null, 'missing');
  assert.equal(artifacts.verdict(KEY, 'groom.md'), null, 'missing groom');

  const other = path.join(home, 'pathwise', '.orchestrator', 'tap-2');
  const outside = path.join(home, 'elsewhere');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'e2e.md'), 'Verdict: PASS\n');
  fs.symlinkSync(outside, other);
  assert.equal(artifacts.verdict('TAP-2', 'e2e.md'), null, 'ticket folder linking outside');

  // Names that are not a verdict file, and keys that are not tickets, are never opened.
  assert.equal(artifacts.verdict(KEY, '02-plan.md'), null);
  assert.equal(artifacts.verdict('../x', 'e2e.md'), null);
  assert.equal(artifacts.verdict(KEY, '../e2e.md'), null);
  assert.equal(opens.length, 0, 'none of the refused reads opened a file');

  // A 2 MiB report still gives its verdict, from its first bytes only.
  const file = path.join(dir, 'e2e.md');
  fs.writeFileSync(file, `Verdict: FAIL\n${'x'.repeat(2 * 1024 * 1024)}`);
  assert.equal(artifacts.verdict(KEY, 'e2e.md'), 'FAIL');
  assert.deepEqual(
    opens.map((open) => open.method),
    ['openSync'],
    'one bounded open, never a whole-file read',
  );

  // The same mtime and size opens nothing; a changed file is read again.
  const stamp = fs.statSync(file);
  assert.equal(artifacts.verdict(KEY, 'e2e.md'), 'FAIL');
  assert.equal(opens.length, 1, 'cached');
  fs.writeFileSync(file, `Verdict: PASS\n${'x'.repeat(2 * 1024 * 1024)}`);
  fs.utimesSync(file, stamp.atime, new Date(stamp.mtimeMs + 5_000));
  assert.equal(artifacts.verdict(KEY, 'e2e.md'), 'PASS');
  assert.equal(opens.length, 2, 'changed mtime reads again');
});

test('verdict: never throws', (t) => {
  const { home, dir } = workspace(t);
  fs.writeFileSync(path.join(dir, 'e2e.md'), 'Verdict: PASS\n');
  const broken = new Proxy(fs, {
    get(target, property) {
      if (property === 'openSync') return () => assert.fail('boom');
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  assert.equal(createClaudeArtifacts({ home, fs: broken }).verdict(KEY, 'e2e.md'), null);
});

test('verdict: enum parity', () => {
  const backend = new Set(Object.values(VERDICT_FILES).flatMap(({ values }) => values));
  assert.deepEqual([...Object.keys(VERDICT_WORDS)].sort(), [...backend].sort());
  assert.deepEqual([...Object.keys(VERDICT_TONE)].sort(), [...backend].sort());
  for (const value of backend) assert.equal(verdictWord(value), VERDICT_WORDS[value]);
  for (const bad of ['pass', 'MAYBE', '<b>x', '', null, undefined, 3, {}, '__proto__', 'toString'])
    assert.equal(verdictWord(bad), null, String(bad));
  assert.equal(VERDICT_WORDS.NEEDS_INFO, 'Needs info');
  for (const tone of Object.values(VERDICT_TONE))
    assert.ok(['good', 'caution', 'bad'].includes(tone));
  const source = fs.readFileSync(
    fileURLToPath(new URL('../backend/claude-artifacts.mjs', import.meta.url)),
    'utf8',
  );
  assert.doesNotMatch(source, /from ['"]\.\.\/ui\//, 'the backend imports nothing from ui/');
});

// ---- the entry ----

const groomRecord = () => launchRecord({ name: GROOM_NAME, id: 'cccc0003' });
const groomEntry = (extra = {}) => listed({ id: 'cccc0003', name: GROOM_NAME, ...extra });

function writeReport(env, name, text) {
  const dir = path.join(env.home, 'pathwise', '.orchestrator', SLUG);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), text);
}

test('verdict: entry', async (t) => {
  const env = await launcherEnvironment(t);
  env.seed(KEY, { launch: { [GROOM]: groomRecord(), [E2E]: e2eRecord() } });
  env.cli.setListing([groomEntry({ state: 'done' }), e2eEntry({ state: 'done' })]);
  writeReport(env, 'groom.md', 'Readiness: NEEDS_INFO\n\nbody');
  writeReport(env, 'e2e.md', 'Verdict: FAIL\n\nbody');

  const { tickets } = await env.launcher.list();
  assert.equal(tickets[KEY].groom.verdict, 'NEEDS_INFO');
  assert.equal(tickets[KEY].e2e.verdict, 'FAIL');
  assert.equal(tickets[KEY].groom.state, 'done');

  // Not done, or an odd or missing file: no `verdict` key, the entry as it was. The failed row has
  // valid reports on disk (a stale one from an earlier run), so it proves the `done` gate.
  for (const [label, entries, e2e, groom] of [
    ['working', [groomEntry({ state: 'working', pid: 1 }), e2eEntry({ state: 'working', pid: 2 })]],
    [
      'failed',
      [groomEntry({ state: 'failed' }), e2eEntry({ state: 'failed' })],
      'Verdict: PASS',
      'Readiness: READY',
    ],
    ['odd', [groomEntry({ state: 'done' }), e2eEntry({ state: 'done' })], 'Verdict: MAYBE', 'x'],
    ['missing', [groomEntry({ state: 'done' }), e2eEntry({ state: 'done' })], null, null],
  ]) {
    env.cli.setListing(entries);
    for (const name of ['e2e.md', 'groom.md'])
      fs.rmSync(path.join(env.pathwise, '.orchestrator', SLUG, name), { force: true });
    if (e2e !== undefined && e2e !== null) writeReport(env, 'e2e.md', e2e);
    if (groom !== undefined && groom !== null) writeReport(env, 'groom.md', groom);
    const entry = (await env.launcher.list()).tickets[KEY];
    assert.equal('verdict' in entry.groom, false, `${label} groom`);
    assert.equal('verdict' in entry.e2e, false, `${label} e2e`);
  }
});

test('verdict: poll cost and log', async (t) => {
  const env = await launcherEnvironment(t);
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args);
  t.after(() => {
    console.error = original;
  });
  // A ticket with no done groom or e2e (a working groom, an e2e never run): no verdict file opened.
  writeReport(env, 'groom.md', 'Readiness: READY\n');
  writeReport(env, 'e2e.md', 'Verdict: PASS\n');
  env.seed(KEY, { launch: { [GROOM]: groomRecord() } });
  env.cli.setListing([groomEntry({ state: 'working', pid: 9 })]);
  env.recorder.clearCalls();
  await env.launcher.list();
  const opened = env.recorder.calls.filter(
    ({ method, args }) =>
      ['openSync', 'readFileSync'].includes(method) && /(e2e|groom)\.md$/.test(String(args[0])),
  );
  assert.deepEqual(opened, [], 'no verdict file was opened');

  env.cli.setListing([groomEntry({ state: 'done' })]);
  await env.launcher.list();
  assert.deepEqual(logged, [], 'nothing about a verdict is logged');
});
