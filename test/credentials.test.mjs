// credentials.test.mjs — `writeFileAtomic(file, contents, fs = node fs)`, the one place a state
// file is written as temp file, fsync, rename. It is synchronous, creates the folder (mode 700) and
// the file (mode 600), and takes the `fs` to use as its third argument so a caller's injected `fs`
// sees every call.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordingFs } from './slack-watch-fixture.mjs';

async function loadWriter() {
  const credentials = await import('../backend/credentials.mjs');
  assert.equal(
    typeof credentials.writeFileAtomic,
    'function',
    'credentials.mjs exports writeFileAtomic',
  );
  return credentials.writeFileAtomic;
}

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'credentials-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'state');
  return { root, directory, file: path.join(directory, 'data.json') };
}

const modeOf = (file) => fs.statSync(file).mode & 0o777;

test('scenario 57: writeFileAtomic writes the contents to a new folder (700) and file (600), no temp left', async (t) => {
  const writeFileAtomic = await loadWriter();
  const { directory, file } = workspace(t);

  writeFileAtomic(file, '{"a":1}\n');

  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}\n');
  assert.equal(modeOf(directory), 0o700, 'folder mode');
  assert.equal(modeOf(file), 0o600, 'file mode');
  assert.deepEqual(fs.readdirSync(directory), ['data.json'], 'no temp file is left');
});

test('scenario 58: writeFileAtomic replaces a file by writing a sibling temp file, fsync, rename', async (t) => {
  const writeFileAtomic = await loadWriter();
  const { directory, file } = workspace(t);
  const recorder = recordingFs(fs);
  writeFileAtomic(file, 'old contents that are the longer of the two\n', recorder.fs);
  recorder.clearCalls();

  writeFileAtomic(file, 'new\n', recorder.fs);

  assert.equal(fs.readFileSync(file, 'utf8'), 'new\n', 'replaced whole');
  assert.equal(modeOf(file), 0o600, 'still 600');
  assert.deepEqual(fs.readdirSync(directory), ['data.json'], 'no temp file is left');
  const writes = recorder.calls.filter(({ method }) =>
    ['writeFileSync', 'fsyncSync', 'renameSync'].includes(method),
  );
  assert.deepEqual(
    writes.map(({ method }) => method),
    ['writeFileSync', 'fsyncSync', 'renameSync'],
    'temp written, fsynced, renamed',
  );
  const [written, , renamed] = writes;
  assert.notEqual(String(written.args[0]), file, 'the target is never written in place');
  assert.equal(
    String(renamed.args[0]),
    String(written.args[0]),
    'the temp file is what is renamed',
  );
  assert.equal(String(renamed.args[1]), file, 'onto the target');
  assert.equal(path.dirname(String(renamed.args[0])), directory, 'beside the target');
});

for (const method of ['fsyncSync', 'renameSync']) {
  test(`scenario 59: a failing ${method} leaves the original file, removes the temp file and rethrows`, async (t) => {
    const writeFileAtomic = await loadWriter();
    const { directory, file } = workspace(t);
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.writeFileSync(file, 'original\n', { mode: 0o600 });
    const recorder = recordingFs(fs);
    const failure = Object.assign(new Error('synthetic failure'), { code: 'EIO' });
    recorder.failOn(method, () => true, failure);

    assert.throws(
      () => writeFileAtomic(file, 'new\n', recorder.fs),
      (error) => error === failure,
    );

    assert.equal(fs.readFileSync(file, 'utf8'), 'original\n', 'the original bytes are on disk');
    assert.deepEqual(fs.readdirSync(directory), ['data.json'], 'the temp file is removed');
  });
}

test('scenario 60: writeFileAtomic refuses a symlinked folder and writes nothing', async (t) => {
  const writeFileAtomic = await loadWriter();
  const { root } = workspace(t);
  const real = path.join(root, 'real');
  fs.mkdirSync(real);
  fs.symlinkSync(real, path.join(root, 'link'));

  assert.throws(() => writeFileAtomic(path.join(root, 'link', 'data.json'), 'x'));

  assert.deepEqual(fs.readdirSync(real), []);
});

// The point of the shared helper is that no caller keeps its own copy of the temp-and-rename write.
const IMPORTS_WRITER =
  /import\s*\{[^}]*\bwriteFileAtomic\b[^}]*\}\s*from\s*['"]\.\/credentials\.mjs['"]/;

for (const backendFile of ['claude-launcher.mjs', 'slack-watch-store.mjs']) {
  test(`scenario 61: ${backendFile} writes through writeFileAtomic and keeps no temp-and-rename of its own`, () => {
    const source = fs.readFileSync(new URL(`../backend/${backendFile}`, import.meta.url), 'utf8');
    assert.ok(IMPORTS_WRITER.test(source), `${backendFile} imports writeFileAtomic`);
    assert.ok(!/\bstageTokenFile\b/.test(source), `${backendFile} stages no temp file itself`);
    assert.ok(!/\brenameSync\b/.test(source), `${backendFile} renames nothing itself`);
  });
}
