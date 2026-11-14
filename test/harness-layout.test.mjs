// harness-layout.test.mjs — the layout and the import rule of backend/harness, read from source text:
// the two Claude files moved into the adapter and left nothing behind, only the registry reaches an
// adapter, an adapter reaches no dashboard domain module (so the registry has no import cycle), and no
// generic module spells the Claude binary, its command text or a tool name.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backend = fileURLToPath(new URL('../backend/', import.meta.url));
const harnessDir = path.join(backend, 'harness');
const adapterDir = path.join(harnessDir, 'claude-code');

const sourceFiles = (directory) =>
  fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? sourceFiles(path.join(directory, entry.name))
        : entry.name.endsWith('.mjs')
          ? [path.join(directory, entry.name)]
          : [],
    );
const rel = (file) => path.relative(backend, file);

// Code lines only: a comment line may name the Claude CLI and its tools, and a moved file keeps
// its prose.
const codeOf = (file) =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join('\n');

// Every module specifier a file imports, static or dynamic.
const specifiersOf = (file) =>
  [...codeOf(file).matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g)].map(
    (match) => match[1],
  );

test('the harness directory has the registry, the shape check, the generic helpers and the adapter files', () => {
  for (const file of ['index', 'contract', 'session-entry', 'session-lock'])
    assert.ok(fs.existsSync(path.join(harnessDir, `${file}.mjs`)), `backend/harness/${file}.mjs`);
  for (const file of ['index', 'sessions', 'chat-items', 'cli', 'usage', 'spec-review'])
    assert.ok(
      fs.existsSync(path.join(adapterDir, `${file}.mjs`)),
      `backend/harness/claude-code/${file}.mjs`,
    );
});

test('the two Claude files moved: nothing is left at their old paths', () => {
  for (const old of ['claude-sessions.mjs', 'claude-chat-items.mjs'])
    assert.ok(!fs.existsSync(path.join(backend, old)), `backend/${old} no longer exists`);
});

test('no file outside the adapter imports from it, except the registry', () => {
  const importers = [];
  for (const file of sourceFiles(backend)) {
    if (file.startsWith(adapterDir + path.sep)) continue;
    if (specifiersOf(file).some((specifier) => /(^|\/)claude-code\//.test(specifier)))
      importers.push(rel(file));
  }
  assert.deepEqual(importers, ['harness/index.mjs']);
});

test('an adapter file imports only Node built-ins, config, the log, the watch store, the generic helpers and its own files', () => {
  const allowed = new Set(
    ['config.mjs', 'claude-log.mjs', 'slack-watch-store.mjs'].map((file) =>
      path.join(backend, file),
    ),
  );
  const generic = ['contract', 'session-entry', 'session-lock'].map((file) =>
    path.join(harnessDir, `${file}.mjs`),
  );
  generic.forEach((file) => allowed.add(file));
  const files = sourceFiles(adapterDir);
  assert.ok(files.length > 0, 'the adapter directory has files');
  for (const file of files)
    for (const specifier of specifiersOf(file)) {
      const label = `${rel(file)} imports ${specifier}`;
      if (!specifier.startsWith('.')) {
        const name = specifier.replace(/^node:/, '').split('/')[0];
        assert.ok(builtinModules.includes(name), `${label}: a Node built-in`);
        continue;
      }
      const target = path.resolve(path.dirname(file), specifier);
      assert.ok(
        target.startsWith(adapterDir + path.sep) || allowed.has(target),
        `${label}: not an allowed import for an adapter`,
      );
    }
});

test('no generic module spells the claude binary, its command text or a toolkit tool name', () => {
  const generic = sourceFiles(backend).filter((file) => !file.startsWith(adapterDir + path.sep));
  const forbidden = {
    "a 'claude' spawn or execFile binary": /\b(?:spawn|execFile)\w*\(\s*['"`]claude['"`]/,
    "a `BIN = 'claude'` constant": /\bBIN\s*=\s*['"`]claude['"`]/,
    'an mcp__ tool name': /mcp__/,
    'a `claude attach` command': /claude attach/,
    'a `claude --resume` command': /claude --resume/,
  };
  for (const file of generic) {
    const code = codeOf(file);
    for (const [what, pattern] of Object.entries(forbidden))
      assert.ok(!pattern.test(code), `${rel(file)} contains ${what}`);
  }
});

test('the shared prompt module takes harness words from the adapter and spells none of them', () => {
  const file = path.join(backend, 'claude-prompts.mjs');
  assert.ok(!/question tool/.test(codeOf(file)), 'no literal ask word');
  assert.ok(!/` skill\b/.test(codeOf(file)), 'no named skill introduced by a literal noun');
  assert.deepEqual(
    specifiersOf(file).filter((specifier) => /harness/.test(specifier)),
    [],
    'it imports no adapter or registry: the harness is passed in',
  );
});
