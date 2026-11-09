// claude-prompts.test.mjs — the prompt store: the one module that knows the four prompt files
// (`investigate.md`, `implement.md`, `answers.md`, `groom.md` in the prompts folder). It reads them under the
// rules the launcher already uses (a missing file is the built-in text, a file that cannot be used
// is `unusable`), lists them for the editor, writes one whole or not at all, and removes one.
//
// Every test runs over a temp folder and an `fs` passed in. The dashboard's own `prompts` folder
// is never read or written here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ANSWERS_TEMPLATE,
  BAD_PROMPT_FILES,
  GROOM_TEMPLATE,
  INVESTIGATE_TEMPLATE,
  PROMPT_MAX_CHARS,
  PROMPT_NAMES,
  fsChanges,
  promptEntry,
  recordingFs,
} from './claude-launcher-fixture.mjs';

const NAMES = PROMPT_NAMES;
const entry = promptEntry;

// The store over a temp prompts folder (`folder` is its path under the temp root, so a test can
// ask for one several levels down that does not exist yet) and a recording `fs`.
async function promptStore(t, { folder = 'prompts' } = {}) {
  const { createPromptStore } = await import('../backend/claude-prompts.mjs');
  assert.equal(typeof createPromptStore, 'function', 'the module exports createPromptStore');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-prompts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const promptsDir = path.join(root, folder);
  const recorder = recordingFs(fs);
  const store = createPromptStore({ promptsDir, fs: recorder.fs });
  const file = (name) => path.join(promptsDir, `${name}.md`);
  return {
    root,
    promptsDir,
    recorder,
    store,
    file,
    put(name, text) {
      fs.mkdirSync(promptsDir, { recursive: true });
      fs.writeFileSync(file(name), text);
    },
    bytes: (name) => fs.readFileSync(file(name), 'utf8'),
    files: () => (fs.existsSync(promptsDir) ? fs.readdirSync(promptsDir).sort() : null),
  };
}

// ---- list and read ----

test('scenario 140: with no files and no folder every prompt is the built-in text, and nothing is created', async (t) => {
  const p = await promptStore(t);

  const list = await p.store.list();

  assert.deepEqual(
    list,
    NAMES.map((name) => entry(name, 'default')),
    'four entries, in this order, each with its label, placeholders and the built-in text',
  );
  assert.equal(fs.existsSync(p.promptsDir), false, 'listing creates no folder');
  assert.deepEqual(fsChanges(p.recorder), [], 'and changes nothing');
});

test('scenario 140: a file that is usable is custom with its trimmed text, placeholders left as written', async (t) => {
  const p = await promptStore(t);
  p.put(
    'investigate',
    '\n  Work on {KEY} ({SLUG}) with $& and {NOPE}.\n\n  Second {STATUS_FILE}\t \n\n',
  );
  p.put('answers', 'only {CHANGE}');

  const list = await p.store.list();

  assert.deepEqual(list, [
    entry(
      'investigate',
      'custom',
      'Work on {KEY} ({SLUG}) with $& and {NOPE}.\n\n  Second {STATUS_FILE}',
    ),
    entry('implement', 'default'),
    entry('answers', 'custom', 'only {CHANGE}'),
    entry('groom', 'default'),
  ]);
});

test('scenario 140: a file with no {STATUS_FILE} is still custom, the store never judges the text', async (t) => {
  const p = await promptStore(t);
  p.put('implement', 'Do the work and say hello.');

  assert.deepEqual(
    await p.store.read('implement'),
    entry('implement', 'custom', 'Do the work and say hello.'),
  );
});

for (const { label, arrange } of BAD_PROMPT_FILES) {
  test(`scenario 141: ${label} is unusable, shown with the built-in text, and its neighbours are not affected`, async (t) => {
    const p = await promptStore(t);
    fs.mkdirSync(p.promptsDir, { recursive: true });
    for (const name of NAMES) arrange(p.file(name));

    const list = await p.store.list();
    assert.deepEqual(
      list,
      NAMES.map((name) => entry(name, 'unusable')),
      'every one of the four',
    );
    for (const name of NAMES)
      assert.deepEqual(await p.store.read(name), entry(name, 'unusable'), `read ${name}`);

    // Only two of them are bad: the others keep their own source.
    fs.rmSync(p.file('implement'), { recursive: true, force: true });
    fs.rmSync(p.file('answers'), { recursive: true, force: true });
    p.put('answers', 'fine {KEY}');
    assert.deepEqual(
      (await p.store.list()).map(({ name, source }) => [name, source]),
      [
        ['investigate', 'unusable'],
        ['implement', 'default'],
        ['answers', 'custom'],
        ['groom', 'unusable'],
      ],
    );
  });
}

test('scenario 141: a file of exactly 20 000 characters is custom, the limit is on the trimmed text', async (t) => {
  const p = await promptStore(t);
  const exact = 'x'.repeat(PROMPT_MAX_CHARS);
  p.put('investigate', exact);
  p.put('implement', `\n\n   ${exact}\n\n   `);
  p.put('answers', `${exact}x`);

  const [investigate, implement, answers] = await p.store.list();

  assert.equal(investigate.source, 'custom');
  assert.equal(investigate.text, exact);
  assert.equal(implement.source, 'custom', 'padding around it does not count');
  assert.equal(implement.text, exact);
  assert.equal(answers.source, 'unusable', 'one character more is too long');
  assert.equal(answers.text, ANSWERS_TEMPLATE);
});

test('scenario 142: read gives the entry that list gives, and both look at the files every time', async (t) => {
  const p = await promptStore(t);
  p.put('implement', 'first');

  const list = await p.store.list();
  for (const [index, name] of NAMES.entries())
    assert.deepEqual(await p.store.read(name), list[index], name);

  p.put('implement', '  second  ');
  assert.deepEqual(await p.store.read('implement'), entry('implement', 'custom', 'second'));
  assert.equal((await p.store.list())[1].text, 'second');

  fs.rmSync(p.file('implement'));
  assert.deepEqual(await p.store.read('implement'), entry('implement', 'default'));

  fs.mkdirSync(p.file('implement'));
  assert.equal((await p.store.read('implement')).source, 'unusable');
});

test('scenario 142: a store with no folder given reads the dashboard prompts folder through the fs it is given', async () => {
  const { createPromptStore, CLAUDE_PROMPTS_DIR } = await import('../backend/claude-prompts.mjs');
  // A stand-in for the disk where nothing exists: no call reaches a real file.
  const calls = [];
  const noFiles = new Proxy(
    {},
    {
      get:
        (_target, method) =>
        (...args) => {
          calls.push({ method: String(method), args });
          if (method === 'existsSync') return false;
          throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
        },
    },
  );

  const list = await createPromptStore({ fs: noFiles }).list();

  assert.deepEqual(
    list,
    NAMES.map((name) => entry(name, 'default')),
  );
  const paths = new Set(
    calls.flatMap(({ args }) =>
      args.filter((arg) => typeof arg === 'string' && path.isAbsolute(arg)),
    ),
  );
  for (const name of NAMES)
    assert.ok(paths.has(path.join(CLAUDE_PROMPTS_DIR, `${name}.md`)), `it looked for ${name}.md`);
  assert.ok(
    [...paths].every(
      (arg) => arg === CLAUDE_PROMPTS_DIR || arg.startsWith(CLAUDE_PROMPTS_DIR + path.sep),
    ),
    'and only inside the prompts folder',
  );
});

// ---- names are a fixed list ----

const BAD_NAMES = [
  'constructor',
  '__proto__',
  'toString',
  'hasOwnProperty',
  'Investigate',
  'investigate.md',
  'Groom',
  'groom.md',
  'investigate/',
  '../investigate',
  'investigate/../answers',
  '..%2Finvestigate',
  '/etc/passwd',
  'investigate\0',
  '',
  undefined,
  null,
  7,
];

test('scenario 143: only the four names are known, anything else is refused before any file is looked at', async (t) => {
  const p = await promptStore(t);
  // Where `../investigate` would land if a name were put into a path.
  const sentinel = path.join(p.root, 'investigate.md');
  fs.writeFileSync(sentinel, 'outside the prompts folder');
  p.recorder.clearCalls();

  for (const name of BAD_NAMES) {
    const label = JSON.stringify(name) ?? String(name);
    await assert.rejects(async () => p.store.read(name), `read ${label}`);
    await assert.rejects(async () => p.store.write(name, 'text'), `write ${label}`);
    await assert.rejects(async () => p.store.remove(name), `remove ${label}`);
  }

  assert.deepEqual(p.recorder.calls, [], 'no file was looked at, let alone changed');
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'outside the prompts folder');
  assert.equal(fs.existsSync(p.promptsDir), false);
});

// ---- write ----

test('scenario 144: write keeps the trimmed text and one newline, and answers with the entry', async (t) => {
  const p = await promptStore(t);
  const text = '\n\t  First {KEY} line $&\n\n    indented {STATUS_FILE}\n  last\r\n\n\n  ';

  for (const name of NAMES) {
    const saved = await p.store.write(name, text);

    assert.deepEqual(
      saved,
      entry(name, 'custom', 'First {KEY} line $&\n\n    indented {STATUS_FILE}\n  last'),
    );
    assert.equal(p.bytes(name), 'First {KEY} line $&\n\n    indented {STATUS_FILE}\n  last\n');
    assert.deepEqual(await p.store.read(name), saved, 'and read gives the same');
  }
  assert.deepEqual(p.files(), ['answers.md', 'groom.md', 'implement.md', 'investigate.md']);
});

test('scenario 144: writing the text it gave back leaves the file as it was', async (t) => {
  const p = await promptStore(t);
  const first = await p.store.write('investigate', '  text {KEY}  \n\n');
  const before = p.bytes('investigate');

  const again = await p.store.write('investigate', first.text);

  assert.deepEqual(again, first);
  assert.equal(p.bytes('investigate'), before);
  assert.equal(before, 'text {KEY}\n', 'exactly one newline');
});

test('scenario 144: a text with no {STATUS_FILE} is saved, the store never refuses on content', async (t) => {
  const p = await promptStore(t);

  const saved = await p.store.write('answers', 'No placeholders at all.');

  assert.equal(saved.source, 'custom');
  assert.equal(p.bytes('answers'), 'No placeholders at all.\n');
});

test('scenario 145: write makes the prompts folder, however deep, and puts nothing else in it', async (t) => {
  const p = await promptStore(t, { folder: path.join('one', 'two', 'prompts') });
  assert.equal(fs.existsSync(p.promptsDir), false);

  await p.store.write('implement', 'text');

  assert.deepEqual(p.files(), ['implement.md'], 'the file, no other prompt and no temp file');
});

test('scenario 145: write adds to a folder that already holds files and leaves them alone', async (t) => {
  const p = await promptStore(t);
  p.put('investigate', 'mine');
  fs.writeFileSync(path.join(p.promptsDir, 'notes.txt'), 'not a prompt');

  await p.store.write('answers', 'new');

  assert.deepEqual(p.files(), ['answers.md', 'investigate.md', 'notes.txt']);
  assert.equal(p.bytes('investigate'), 'mine');
  assert.equal(fs.readFileSync(path.join(p.promptsDir, 'notes.txt'), 'utf8'), 'not a prompt');
});

const WRITE_CALLS = new Set([
  'writeFileSync',
  'appendFileSync',
  'openSync',
  'copyFileSync',
  'createWriteStream',
  'truncateSync',
  'writeSync',
]);

test('scenario 146: write is staged beside the file and renamed into place, never written to directly', async (t) => {
  const p = await promptStore(t);
  p.put('investigate', 'old');
  p.recorder.clearCalls();

  await p.store.write('investigate', 'new');

  const target = p.file('investigate');
  const renames = p.recorder.calls.filter(({ method }) => method === 'renameSync');
  assert.equal(renames.length, 1, 'one rename');
  const [from, to] = renames[0].args;
  assert.equal(to, target, 'onto the file');
  assert.notEqual(from, target);
  assert.equal(path.dirname(from), p.promptsDir, 'from a temp file in the same folder');
  const direct = p.recorder.calls.filter(
    ({ method, args }) => WRITE_CALLS.has(method) && args[0] === target,
  );
  assert.deepEqual(direct, [], 'nothing writes to the file itself');
  assert.deepEqual(p.files(), ['investigate.md'], 'no temp file is left');
});

test('scenario 146: a write that cannot be put in place leaves the old file whole and no temp file behind', async (t) => {
  const p = await promptStore(t);
  p.put('investigate', 'old text\n');
  p.put('answers', 'neighbour\n');
  p.recorder.failOn(
    'renameSync',
    () => true,
    Object.assign(new Error('disk full'), { code: 'ENOSPC' }),
  );

  await assert.rejects(async () => p.store.write('investigate', 'new text'));

  assert.equal(p.bytes('investigate'), 'old text\n', 'the old text is untouched');
  assert.equal(p.bytes('answers'), 'neighbour\n');
  assert.deepEqual(p.files(), ['answers.md', 'investigate.md'], 'no temp file');
  assert.deepEqual(await p.store.read('investigate'), entry('investigate', 'custom', 'old text'));
});

const NOT_TEXT = [123, null, undefined, {}, ['text'], true, () => 'text'];

test('scenario 147: a text that is not a string, is empty after trim, or is over 20 000 after trim is refused and nothing is written', async (t) => {
  const p = await promptStore(t);
  const bad = [
    ...NOT_TEXT,
    '',
    '   \n\t  ',
    'x'.repeat(PROMPT_MAX_CHARS + 1),
    `  \n${'x'.repeat(PROMPT_MAX_CHARS + 1)}\n  `,
  ];
  p.recorder.clearCalls();

  for (const text of bad)
    await assert.rejects(
      async () => p.store.write('investigate', text),
      `${typeof text} ${String(text).slice(0, 12)}`,
    );

  assert.deepEqual(fsChanges(p.recorder), [], 'no file, folder or temp file is written');
  assert.equal(fs.existsSync(p.promptsDir), false);

  p.put('investigate', 'kept\n');
  for (const text of ['', 'x'.repeat(PROMPT_MAX_CHARS + 1)])
    await assert.rejects(async () => p.store.write('investigate', text));
  assert.equal(p.bytes('investigate'), 'kept\n', 'an old file is not damaged by a refused write');
  assert.deepEqual(p.files(), ['investigate.md']);
});

test('scenario 147: a text of exactly 20 000 characters is saved, with or without padding around it', async (t) => {
  const p = await promptStore(t);
  const exact = 'y'.repeat(PROMPT_MAX_CHARS);

  const plain = await p.store.write('investigate', exact);
  const padded = await p.store.write('implement', `\n   ${exact}  \n\n`);

  assert.equal(plain.text.length, PROMPT_MAX_CHARS);
  assert.equal(padded.text, exact);
  assert.equal(p.bytes('investigate'), `${exact}\n`);
  assert.equal(p.bytes('implement'), `${exact}\n`);
  assert.equal((await p.store.read('investigate')).source, 'custom', 'and it reads back as usable');
});

for (const { label, arrange } of BAD_PROMPT_FILES.filter(({ label }) => label !== 'a folder')) {
  test(`scenario 148: saving over ${label} replaces it`, async (t) => {
    const p = await promptStore(t);
    fs.mkdirSync(p.promptsDir, { recursive: true });
    arrange(p.file('implement'));
    assert.equal((await p.store.read('implement')).source, 'unusable');

    const saved = await p.store.write('implement', 'a good text');

    assert.deepEqual(saved, entry('implement', 'custom', 'a good text'));
    assert.equal(fs.lstatSync(p.file('implement')).isFile(), true, 'a regular file now');
    assert.equal(p.bytes('implement'), 'a good text\n');
    assert.deepEqual(p.files(), ['implement.md']);
  });
}

test('scenario 148: saving over a folder fails, and the folder with what is in it stays', async (t) => {
  const p = await promptStore(t);
  fs.mkdirSync(p.file('investigate'), { recursive: true });
  fs.writeFileSync(path.join(p.file('investigate'), 'keep.txt'), 'kept');

  await assert.rejects(async () => p.store.write('investigate', 'a good text'));

  assert.equal(fs.statSync(p.file('investigate')).isDirectory(), true);
  assert.equal(fs.readFileSync(path.join(p.file('investigate'), 'keep.txt'), 'utf8'), 'kept');
  assert.deepEqual(p.files(), ['investigate.md'], 'no temp file is left beside it');
});

// ---- remove ----

test('scenario 149: remove deletes the file and answers with the built-in entry, the others stay', async (t) => {
  const p = await promptStore(t);
  p.put('investigate', 'one');
  p.put('implement', 'two');

  const removed = await p.store.remove('investigate');

  assert.deepEqual(removed, entry('investigate', 'default'));
  assert.deepEqual(p.files(), ['implement.md'], 'the folder stays, the other file stays');
  assert.equal(p.bytes('implement'), 'two');
  assert.deepEqual(await p.store.read('investigate'), entry('investigate', 'default'));

  await p.store.remove('implement');
  assert.deepEqual(p.files(), [], 'an empty folder is left in place');
});

test('scenario 149: removing what is not there is fine, whether the file or the whole folder is missing', async (t) => {
  const p = await promptStore(t);

  assert.deepEqual(await p.store.remove('answers'), entry('answers', 'default'), 'no folder');
  assert.equal(fs.existsSync(p.promptsDir), false, 'and none is made');

  p.put('investigate', 'x');
  assert.deepEqual(await p.store.remove('answers'), entry('answers', 'default'), 'no file');
  assert.deepEqual(p.files(), ['investigate.md']);
});

for (const { label, arrange } of BAD_PROMPT_FILES.filter(({ label }) => label !== 'a folder')) {
  test(`scenario 149: ${label} can be removed, which is the way back to the built-in text`, async (t) => {
    const p = await promptStore(t);
    fs.mkdirSync(p.promptsDir, { recursive: true });
    arrange(p.file('answers'));

    const removed = await p.store.remove('answers');

    assert.deepEqual(removed, entry('answers', 'default'));
    assert.deepEqual(p.files(), []);
  });
}

test('scenario 149: a folder where the file should be is not removed, and what is in it stays', async (t) => {
  const p = await promptStore(t);
  fs.mkdirSync(p.file('implement'), { recursive: true });
  fs.writeFileSync(path.join(p.file('implement'), 'keep.txt'), 'kept');

  await assert.rejects(async () => p.store.remove('implement'));

  assert.equal(fs.readFileSync(path.join(p.file('implement'), 'keep.txt'), 'utf8'), 'kept');
  assert.equal((await p.store.read('implement')).source, 'unusable');
});

test('scenario 149: a file that cannot be removed is an error and is still there', async (t) => {
  const p = await promptStore(t);
  p.put('investigate', 'stay\n');
  const stuck = Object.assign(new Error('not permitted'), { code: 'EPERM' });
  for (const method of ['rmSync', 'unlinkSync'])
    p.recorder.failOn(method, (args) => String(args[0]).endsWith('investigate.md'), stuck, {
      once: false,
    });

  await assert.rejects(async () => p.store.remove('investigate'));

  assert.equal(p.bytes('investigate'), 'stay\n');
});

// ---- a NUL byte ----

test('scenario 150: a text with a NUL byte is refused as INVALID_PROMPT and nothing is written', async (t) => {
  const p = await promptStore(t);
  p.recorder.clearCalls();

  for (const text of ['before\0after', '\0', 'text\0'])
    await assert.rejects(
      async () => p.store.write('investigate', text),
      { code: 'INVALID_PROMPT' },
      JSON.stringify(text),
    );

  assert.deepEqual(fsChanges(p.recorder), [], 'no file, folder or temp file is written');
  assert.equal(fs.existsSync(p.promptsDir), false);
  p.put('investigate', 'kept\n');
  await assert.rejects(async () => p.store.write('investigate', 'a\0b'), {
    code: 'INVALID_PROMPT',
  });
  assert.equal(p.bytes('investigate'), 'kept\n', 'an old file is not damaged by the refusal');
});

test('scenario 150: a file that contains a NUL byte is unusable, shown with the built-in text', async (t) => {
  const p = await promptStore(t);
  p.put('investigate', 'a text with a \0 in it\n');
  p.put('implement', '\0');
  p.put('answers', 'a fine text');

  assert.deepEqual(await p.store.list(), [
    entry('investigate', 'unusable'),
    entry('implement', 'unusable'),
    entry('answers', 'custom', 'a fine text'),
    entry('groom', 'default'),
  ]);
  assert.deepEqual(await p.store.read('investigate'), entry('investigate', 'unusable'));
});

// ---- links ----

// A prompts folder whose copy of `answers.md` is where the links lead.
function linkedFolder(p) {
  const behind = path.join(p.root, 'behind');
  fs.mkdirSync(path.join(behind, 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(behind, 'prompts', 'answers.md'), 'kept {KEY}\n');
  return behind;
}
const keptBehind = (behind) => ({
  names: fs.readdirSync(path.join(behind, 'prompts')),
  text: fs.readFileSync(path.join(behind, 'prompts', 'answers.md'), 'utf8'),
});

test('scenario 151: a prompts folder that is a symlink is read, but not saved to or reset, and nothing behind it changes', async (t) => {
  const p = await promptStore(t);
  const behind = linkedFolder(p);
  fs.symlinkSync(path.join(behind, 'prompts'), p.promptsDir);

  assert.deepEqual(
    await p.store.read('answers'),
    entry('answers', 'custom', 'kept {KEY}'),
    'it is read through the link',
  );
  await assert.rejects(async () => p.store.write('investigate', 'new'), 'a save is refused');
  await assert.rejects(async () => p.store.remove('answers'), 'a reset is refused');

  assert.deepEqual(keptBehind(behind), { names: ['answers.md'], text: 'kept {KEY}\n' });
});

test('scenario 151: a symlink above the prompts folder is refused the same way', async (t) => {
  const p = await promptStore(t, { folder: path.join('link', 'prompts') });
  const behind = linkedFolder(p);
  fs.symlinkSync(behind, path.join(p.root, 'link'));

  assert.deepEqual(await p.store.read('answers'), entry('answers', 'custom', 'kept {KEY}'));
  await assert.rejects(async () => p.store.write('investigate', 'new'), 'a save is refused');
  await assert.rejects(async () => p.store.remove('answers'), 'a reset is refused');

  assert.deepEqual(keptBehind(behind), { names: ['answers.md'], text: 'kept {KEY}\n' });
});

test('scenario 152: a prompt file that is a symlink to a file is followed on read', async (t) => {
  const p = await promptStore(t);
  const target = path.join(p.root, 'shared-prompt.md');
  fs.writeFileSync(target, '\n  shared {KEY}  \n');
  fs.mkdirSync(p.promptsDir);
  fs.symlinkSync(target, p.file('implement'));

  const expected = entry('implement', 'custom', 'shared {KEY}');
  assert.deepEqual(await p.store.read('implement'), expected);
  assert.deepEqual((await p.store.list())[1], expected);
});

// ---- the file format ----

test('scenario 153: the store exports the file format, trimmed text and one newline, and write puts exactly that in the file', async (t) => {
  const { promptFileText } = await import('../backend/claude-prompts.mjs');
  assert.equal(typeof promptFileText, 'function', 'the module exports promptFileText');
  const texts = [
    'text',
    '  \n\ttext with  gaps  \n\n  ',
    'first\n\n    indented {STATUS_FILE}\n  last\n\n\n',
    'already\n',
  ];

  assert.equal(promptFileText('text'), 'text\n');
  assert.equal(promptFileText('  \n\ttext with  gaps  \n\n  '), 'text with  gaps\n');
  assert.equal(promptFileText('a\n\n  b\n'), 'a\n\n  b\n');
  const p = await promptStore(t);
  for (const [index, text] of texts.entries()) {
    const name = NAMES[index % NAMES.length];
    await p.store.write(name, text);
    assert.equal(p.bytes(name), promptFileText(text), JSON.stringify(text));
  }
});

// ---- the groom prompt, the fourth name ----

test('scenario 200: the names are investigate, implement, answers and groom, in that order', async () => {
  const { PROMPT_NAMES: names, PROMPT_TEMPLATES } = await import('../backend/claude-prompts.mjs');

  assert.deepEqual(names, ['investigate', 'implement', 'answers', 'groom']);
  assert.deepEqual(Object.keys(PROMPT_TEMPLATES), names);
  assert.equal(PROMPT_TEMPLATES.groom, GROOM_TEMPLATE, 'the built-in text, word for word');
});

test('scenario 200: the groom entry has its label and only {KEY} and {SLUG} as placeholders', async (t) => {
  const p = await promptStore(t);

  const groom = await p.store.read('groom');

  assert.deepEqual(groom, {
    name: 'groom',
    label: 'Groom ticket prompt',
    source: 'default',
    text: GROOM_TEMPLATE,
    placeholders: ['{KEY}', '{SLUG}'],
  });
  assert.deepEqual((await p.store.list())[3], groom, 'the fourth entry of the list');
  assert.ok(!groom.text.includes('{STATUS_FILE}'), 'the built-in text has no status file');
  assert.ok(groom.text.includes('`groom-ticket` skill'), 'it runs the groom-ticket skill');
  assert.ok(groom.text.includes('.orchestrator/{SLUG}/groom.md'), 'and names its deliverable');
  assert.ok(
    groom.text.includes(
      'until the user tells you to write in a later message of this session. Write no file ' +
        'except `.orchestrator/{SLUG}/groom.md` and scratch files under `.orchestrator/{SLUG}/`, ' +
        'and do not edit the skill itself.',
    ),
    'it may write only its deliverable and scratch files, and never the skill',
  );
});

test('scenario 202: the investigate text asks for lettered options inside each question, and nothing else changed', async (t) => {
  const p = await promptStore(t);

  const { text } = await p.store.read('investigate');

  assert.equal(text, INVESTIGATE_TEMPLATE);
  const paragraphs = text.split('\n\n');
  assert.equal(paragraphs.length, 5, 'the same five paragraphs');
  const questions = paragraphs.find((paragraph) => paragraph.startsWith('Questions:'));
  assert.ok(questions.includes('its options inline as (a) ..., (b) ..., (c) ...'));
  assert.ok(questions.includes('Always put lettered options (a, b, c) inside the question text'));
  assert.ok(questions.includes('under 450 characters'));
  assert.ok(questions.includes('Do not change the shape of the array or add keys.'));
  assert.ok(!questions.includes('best-guess default'), 'the old wording is gone');
});
