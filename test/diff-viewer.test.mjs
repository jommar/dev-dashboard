import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseUnifiedDiff,
  MAX_RENDER_BYTES,
  MAX_RENDER_ROWS,
  MAX_LINE_LENGTH,
} from '../ui/components/diff-viewer.js';

test('unified parser tracks both line numbers across context, edits and multiple hunks', () => {
  const { rows, truncated } = parseUnifiedDiff(
    [
      'diff --git a/sample.js b/sample.js',
      '--- a/sample.js',
      '+++ b/sample.js',
      '@@ -4,2 +7,3 @@ example',
      ' unchanged',
      '-old',
      '+new',
      '+extra',
      '@@ -20 +30 @@',
      '-second old',
      '+second new',
      '',
    ].join('\n'),
  );
  assert.equal(truncated, false);
  assert.deepEqual(
    rows.map(({ type, oldLine, newLine }) => [type, oldLine, newLine]),
    [
      ['file', null, null],
      ['meta', null, null],
      ['meta', null, null],
      ['hunk', null, null],
      ['context', 4, 7],
      ['deletion', 5, null],
      ['addition', null, 8],
      ['addition', null, 9],
      ['hunk', null, null],
      ['deletion', 20, null],
      ['addition', null, 30],
    ],
  );
});

test('zero-count hunks handle added and deleted files without inventing opposite numbers', () => {
  const { rows } = parseUnifiedDiff(
    [
      'diff --git a/new b/new',
      '--- /dev/null',
      '+++ b/new',
      '@@ -0,0 +1,2 @@',
      '+one',
      '+two',
      'diff --git a/old b/old',
      '--- a/old',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-one',
      '-two',
    ].join('\n'),
  );
  assert.deepEqual(
    rows.filter((row) => row.type === 'addition').map((row) => [row.oldLine, row.newLine]),
    [
      [null, 1],
      [null, 2],
    ],
  );
  assert.deepEqual(
    rows.filter((row) => row.type === 'deletion').map((row) => [row.oldLine, row.newLine]),
    [
      [1, null],
      [2, null],
    ],
  );
});

test('file-looking source lines inside hunks remain edits and file boundaries reset counters', () => {
  const { rows } = parseUnifiedDiff(
    [
      '@@ -2 +3 @@',
      '--- source content',
      '+++ source content',
      'diff --git a/other b/other',
      '--- a/other',
      '+++ b/other',
    ].join('\n'),
  );
  assert.deepEqual(rows.slice(1, 3), [
    { type: 'deletion', text: '--- source content', oldLine: 2, newLine: null },
    { type: 'addition', text: '+++ source content', oldLine: null, newLine: 3 },
  ]);
  assert.deepEqual(
    rows.slice(3).map((row) => row.type),
    ['file', 'meta', 'meta'],
  );
});

test('binary, rename and no-newline notices preserve literal content without advancing counters', () => {
  const notices = [
    'similarity index 100%',
    'rename from old.txt',
    'rename to new.txt',
    'Binary files a/image.png and b/image.png differ',
    'GIT binary patch',
  ];
  const { rows } = parseUnifiedDiff(
    [
      ...notices,
      '@@ -1 +1 @@',
      '-old',
      '\\ No newline at end of file',
      '+<script>alert("literal")</script>',
      '\\ No newline at end of file',
    ].join('\n'),
  );
  assert.deepEqual(
    rows.slice(0, notices.length).map((row) => row.text),
    notices,
  );
  assert.ok(
    rows
      .slice(0, notices.length)
      .every((row) => row.type === 'notice' && row.oldLine === null && row.newLine === null),
  );
  assert.deepEqual(
    rows.find((row) => row.type === 'addition'),
    {
      type: 'addition',
      text: '+<script>alert("literal")</script>',
      oldLine: null,
      newLine: 1,
    },
  );
  assert.equal(rows.filter((row) => row.type === 'notice').length, notices.length + 2);
});

test('empty, header-only and unfamiliar patches remain honest literal output', () => {
  assert.deepEqual(parseUnifiedDiff(''), { rows: [], truncated: false });
  const raw = 'diff --git a/file b/file\nold mode 100644\nnew mode 100755\nunknown <tag> & text\n';
  const result = parseUnifiedDiff(raw);
  assert.equal(result.truncated, false);
  assert.equal(result.rows.map((row) => row.text).join('\n') + '\n', raw);
  assert.ok(result.rows.every((row) => row.oldLine === null && row.newLine === null));
});

test('row cap is exact and reports truncation only when content was omitted', () => {
  const rows = Array.from({ length: MAX_RENDER_ROWS }, () => 'metadata');
  const exact = parseUnifiedDiff(rows.join('\n') + '\n');
  assert.equal(exact.rows.length, MAX_RENDER_ROWS);
  assert.equal(exact.truncated, false);
  const overflow = parseUnifiedDiff(rows.join('\n') + '\nOMITTED\n');
  assert.equal(overflow.rows.length, MAX_RENDER_ROWS);
  assert.equal(overflow.truncated, true);
  assert.ok(!overflow.rows.some((row) => row.text.includes('OMITTED')));
});

test('individual huge lines and total byte size have bounded preview allocation', () => {
  const line = parseUnifiedDiff('x'.repeat(MAX_LINE_LENGTH + 1));
  assert.equal(line.truncated, true);
  assert.ok(line.rows[0].text.startsWith('x'.repeat(MAX_LINE_LENGTH)));
  assert.ok(line.rows[0].text.length < MAX_LINE_LENGTH + 100);
  const raw = ('x'.repeat(1000) + '\n').repeat(Math.ceil(MAX_RENDER_BYTES / 1000) + 1);
  const parsed = parseUnifiedDiff(raw);
  assert.equal(parsed.truncated, true);
  assert.ok(parsed.rows.map((row) => row.text).join('\n').length <= MAX_RENDER_BYTES);
  const unicode = parseUnifiedDiff(('\u00e9'.repeat(1000) + '\n').repeat(200));
  assert.equal(unicode.truncated, true);
  assert.ok(unicode.rows.length < 200);
});
