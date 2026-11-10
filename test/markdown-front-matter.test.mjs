// markdown-front-matter.test.mjs — the front-matter split the Markdown viewer relies on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitFrontMatter } from '../ui/markdown-front-matter.js';

test('a flat key: value block is split off and the body keeps its first line', () => {
  const result = splitFrontMatter(
    '---\nkind: plan\nslug: tap-1\nstatus: DONE\ncreated: 2026-11-08T20:51:53Z\n---\n# Title\n\ntext',
  );
  assert.deepEqual(result.fields, [
    ['kind', 'plan'],
    ['slug', 'tap-1'],
    ['status', 'DONE'],
    ['created', '2026-11-08T20:51:53Z'],
  ]);
  assert.equal(result.body, '# Title\n\ntext');
});

test('CRLF, a BOM and quoted values are handled', () => {
  const result = splitFrontMatter(
    `${String.fromCharCode(0xfeff)}---\r\ntitle: "Quoted: yes"\r\n---\r\nbody`,
  );
  assert.deepEqual(result.fields, [['title', 'Quoted: yes']]);
  assert.equal(result.body, 'body');
});

test('text without front matter is returned untouched', () => {
  for (const text of ['# Title\n', 'no block', '', '--- not a block\nkind: x\n---\n'])
    assert.deepEqual(splitFrontMatter(text), { fields: [], body: text });
});

test('a block that is not flat key: value, or has no fields, stays in the text', () => {
  for (const text of [
    '---\nkind: plan\n  nested: value\n---\nbody',
    '---\n- a\n- b\n---\nbody',
    '---\nkind: plan\nnot a field\n---\nbody',
    '---\n\n---\nbody',
    `---\n${Array.from({ length: 21 }, (_, i) => `k${i}: v`).join('\n')}\n---\nbody`,
  ])
    assert.deepEqual(splitFrontMatter(text), { fields: [], body: text }, text.slice(0, 30));
});

test('a rule later in the file is not front matter, and a non-string is empty', () => {
  const text = '# Title\n\n---\nkind: plan\n---\n';
  assert.deepEqual(splitFrontMatter(text), { fields: [], body: text });
  assert.deepEqual(splitFrontMatter(undefined), { fields: [], body: '' });
});
