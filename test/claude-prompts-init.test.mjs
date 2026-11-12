// claude-prompts-init.test.mjs — the starter prompt files: `npm run claude:prompts` writes the nine
// built-in messages (placeholders intact) into the prompts folder, never over a file that is there.
// Every test runs in a temp folder; the dashboard's real `prompts` folder is only ever looked at.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ANSWERS_TEMPLATE,
  APPROVE_TEMPLATE,
  REREVIEW_TEMPLATE,
  REVIEW_TEMPLATE,
  SPEC_REVIEW_TEMPLATE,
  E2E_TEMPLATE,
  EARLIER_ID,
  IMPLEMENT,
  IMPLEMENT_TEMPLATE,
  INVESTIGATE,
  GROOM,
  GROOM_TEMPLATE,
  INVESTIGATE_TEMPLATE,
  KEY,
  answeredMap,
  groomPrompt,
  implementPrompt,
  launchRecord,
  launcherEnvironment,
  listed,
  question,
  recordingFs,
  renderTemplate,
  routingEnvironment,
  seedPlanned,
  statusFile,
} from './claude-launcher-fixture.mjs';

// The starter files, in the order they are reported.
const STARTERS = [
  ['investigate.md', INVESTIGATE_TEMPLATE],
  ['implement.md', IMPLEMENT_TEMPLATE],
  ['answers.md', ANSWERS_TEMPLATE],
  ['approve.md', APPROVE_TEMPLATE],
  ['rereview.md', REREVIEW_TEMPLATE],
  ['groom.md', GROOM_TEMPLATE],
  ['review.md', REVIEW_TEMPLATE],
  ['spec-review.md', SPEC_REVIEW_TEMPLATE],
  ['e2e.md', E2E_TEMPLATE],
];

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-prompts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function initPrompts(options) {
  const module = await import('../backend/claude-prompts-init.mjs');
  assert.equal(typeof module.initPrompts, 'function', 'the module exports initPrompts');
  return module.initPrompts(options);
}

// What is in a folder: each file's bytes and modification time.
const snapshot = (dir) =>
  Object.fromEntries(
    fs
      .readdirSync(dir)
      .sort()
      .map((name) => [
        name,
        {
          text: fs.readFileSync(path.join(dir, name), 'utf8'),
          mtime: fs.statSync(path.join(dir, name)).mtimeMs,
        },
      ]),
  );

test('scenario 130: it creates the prompts folder and writes the nine built-in texts, placeholders intact', async (t) => {
  const dir = path.join(tempRoot(t), 'nested', 'prompts');

  const result = await initPrompts({ dir, fs });

  assert.deepEqual(
    result,
    STARTERS.map(([name]) => ({ name, path: path.join(dir, name), status: 'wrote' })),
    'one report per file, in order',
  );
  assert.deepEqual(fs.readdirSync(dir).sort(), [
    'answers.md',
    'approve.md',
    'e2e.md',
    'groom.md',
    'implement.md',
    'investigate.md',
    'rereview.md',
    'review.md',
    'spec-review.md',
  ]);
  for (const [name, template] of STARTERS) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    assert.equal(text.trim(), template, `${name} is the built-in text`);
  }
  for (const placeholder of ['{KEY}', '{SLUG}', '{STATUS_FILE}'])
    assert.ok(fs.readFileSync(path.join(dir, 'investigate.md'), 'utf8').includes(placeholder));
  for (const placeholder of ['{CHANGE}', '{QUESTION_IDS}'])
    assert.ok(fs.readFileSync(path.join(dir, 'answers.md'), 'utf8').includes(placeholder));
  for (const placeholder of ['{KEY}', '{SLUG}'])
    assert.ok(fs.readFileSync(path.join(dir, 'groom.md'), 'utf8').includes(placeholder));
  assert.ok(fs.readFileSync(path.join(dir, 'review.md'), 'utf8').includes('{KEY}'));
  assert.ok(fs.readFileSync(path.join(dir, 'spec-review.md'), 'utf8').includes('{PR}'));
  for (const placeholder of ['{KEY}', '{SLUG}', '{PORT}'])
    assert.ok(fs.readFileSync(path.join(dir, 'e2e.md'), 'utf8').includes(placeholder));
});

test('scenario 131: a file that is already there is kept as it is, and only the missing ones are written', async (t) => {
  const dir = path.join(tempRoot(t), 'prompts');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'investigate.md'), 'my own investigate prompt for {KEY}\n');
  fs.writeFileSync(path.join(dir, 'answers.md'), '');
  const longAgo = new Date('2020-01-01T00:00:00Z');
  for (const name of ['investigate.md', 'answers.md'])
    fs.utimesSync(path.join(dir, name), longAgo, longAgo);
  const before = snapshot(dir);

  const result = await initPrompts({ dir, fs });

  assert.deepEqual(
    result.map(({ name, status }) => [name, status]),
    [
      ['investigate.md', 'kept'],
      ['implement.md', 'wrote'],
      ['answers.md', 'kept'],
      ['approve.md', 'wrote'],
      ['rereview.md', 'wrote'],
      ['groom.md', 'wrote'],
      ['review.md', 'wrote'],
      ['spec-review.md', 'wrote'],
      ['e2e.md', 'wrote'],
    ],
  );
  const after = snapshot(dir);
  assert.deepEqual(after['investigate.md'], before['investigate.md'], 'bytes and time unchanged');
  assert.deepEqual(after['answers.md'], before['answers.md'], 'even an empty file is not replaced');
  assert.equal(after['implement.md'].text.trim(), IMPLEMENT_TEMPLATE);
});

test('scenario 131: a second run changes nothing and reports every file as kept', async (t) => {
  const dir = path.join(tempRoot(t), 'prompts');
  await initPrompts({ dir, fs });
  fs.writeFileSync(path.join(dir, 'implement.md'), 'edited by the user\n');
  const before = snapshot(dir);

  const result = await initPrompts({ dir, fs });

  assert.deepEqual(
    result,
    STARTERS.map(([name]) => ({ name, path: path.join(dir, name), status: 'kept' })),
  );
  assert.deepEqual(snapshot(dir), before);
});

test('scenario 132: it works through the fs it is given and touches nothing outside the folder', async (t) => {
  const root = tempRoot(t);
  const dir = path.join(root, 'prompts');
  const recorder = recordingFs(fs);

  await initPrompts({ dir, fs: recorder.fs });

  assert.ok(recorder.calls.length > 0, 'the given fs was used');
  const paths = recorder.calls.flatMap(({ args }) => args.filter((arg) => typeof arg === 'string'));
  assert.ok(
    paths.filter((arg) => path.isAbsolute(arg)).every((arg) => arg.startsWith(root)),
    'every path it touched is inside the temp folder',
  );
});

// A copy of the dashboard's backend in a temp folder, so that the script can be run for real and
// finds its prompts folder inside the copy. The real `prompts` folder is never touched.
function dashboardCopy(t) {
  const root = tempRoot(t);
  const copy = path.join(root, 'dashboard');
  fs.mkdirSync(copy);
  for (const name of ['backend', 'ui'])
    fs.cpSync(new URL(`../${name}`, import.meta.url), path.join(copy, name), { recursive: true });
  fs.copyFileSync(new URL('../package.json', import.meta.url), path.join(copy, 'package.json'));
  fs.symlinkSync(
    fileURLToPath(new URL('../node_modules', import.meta.url)),
    path.join(copy, 'node_modules'),
  );
  return { copy, home: path.join(root, 'home') };
}

const runNode = ({ copy, home }, args) =>
  spawnSync(process.execPath, args, {
    cwd: copy,
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  });

test('scenario 133: importing the module does not run it', (t) => {
  const dashboard = dashboardCopy(t);

  const result = runNode(dashboard, [
    '--input-type=module',
    '-e',
    "await import('./backend/claude-prompts-init.mjs');",
  ]);

  assert.equal(result.status, 0, `the module imports: ${result.stderr}`);
  assert.equal(result.stdout, '', 'it prints nothing');
  assert.equal(fs.existsSync(path.join(dashboard.copy, 'prompts')), false, 'it writes nothing');
});

test('scenario 133: run as a script it writes the starter files and prints one line for each', (t) => {
  const dashboard = dashboardCopy(t);
  const prompts = path.join(dashboard.copy, 'prompts');
  const lines = (status) =>
    STARTERS.map(([name]) => `${status} ${path.join(prompts, name)}`).join('\n') + '\n';

  const first = runNode(dashboard, ['backend/claude-prompts-init.mjs']);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, lines('wrote'));
  for (const [name, template] of STARTERS)
    assert.equal(fs.readFileSync(path.join(prompts, name), 'utf8').trim(), template);

  const second = runNode(dashboard, ['backend/claude-prompts-init.mjs']);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, lines('kept'));
});

test('scenario 134: package.json has the claude:prompts script', () => {
  const { scripts } = JSON.parse(
    fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  assert.equal(scripts['claude:prompts'], 'node backend/claude-prompts-init.mjs');
});

test('scenario 135: the starter files give the same launch prompts as no files at all', async (t) => {
  const env = await launcherEnvironment(t);
  await initPrompts({ dir: env.promptsDir, fs });

  await env.launcher.launch({ key: KEY, phase: INVESTIGATE });
  assert.equal(
    env.cli.launches()[0].args.at(-1),
    renderTemplate(INVESTIGATE_TEMPLATE, { statusPath: env.statusPath() }),
    'investigate',
  );

  const implement = await launcherEnvironment(t);
  await initPrompts({ dir: implement.promptsDir, fs });
  seedPlanned(implement);
  await implement.launcher.launch({ key: KEY, phase: IMPLEMENT });
  assert.equal(
    implement.cli.launches()[0].args.at(-1),
    implementPrompt(KEY, implement.statusPath()),
    'implement',
  );
});

test('scenario 135: the starter answers file gives the same message as no file at all', async (t) => {
  const env = await routingEnvironment(t);
  await initPrompts({ dir: env.promptsDir, fs });
  const questions = [question('q1', 'first answer'), question('q2')];
  env.seed(KEY, {
    status: statusFile({ investigate: true, questions }),
    launch: { [INVESTIGATE]: launchRecord({ answered: answeredMap(questions) }) },
  });
  env.writePlan();
  env.fake.setListing([listed({ id: EARLIER_ID })]);

  await env.launcher.answer({ key: KEY, answers: { q2: 'second answer' } });

  assert.equal(
    env.fake.resumes()[0].notice,
    renderTemplate(ANSWERS_TEMPLATE, {
      statusPath: env.statusPath(),
      questionIds: ['q1', 'q2'],
      change: 'answers',
    }),
  );
});

test("scenario 136: the starter files are in the store's file format, so the store reads them back and a save changes nothing", async (t) => {
  const { createPromptStore, promptFileText } = await import('../backend/claude-prompts.mjs');
  assert.equal(typeof promptFileText, 'function', 'the store exports promptFileText');
  const dir = path.join(tempRoot(t), 'prompts');

  await initPrompts({ dir, fs });

  for (const [name, template] of STARTERS)
    assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), promptFileText(template), name);
  const store = createPromptStore({ promptsDir: dir, fs });
  assert.deepEqual(
    (await store.list()).map(({ name, source, text }) => [`${name}.md`, source, text]),
    STARTERS.map(([name, template]) => [name, 'custom', template]),
    'read back as custom, with the built-in text',
  );
  const before = snapshot(dir);
  for (const [name, template] of STARTERS) await store.write(name.replace(/\.md$/, ''), template);
  for (const [name] of STARTERS)
    assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), before[name].text, name);
});

test('scenario 203: the starter groom file gives the same groom prompt as no file at all', async (t) => {
  const env = await launcherEnvironment(t);
  await initPrompts({ dir: env.promptsDir, fs });

  await env.launcher.launch({ key: KEY, phase: GROOM });

  assert.equal(env.cli.launches()[0].args.at(-1), groomPrompt(KEY));
});
