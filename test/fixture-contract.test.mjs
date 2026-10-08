import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { apiResponse } from '../e2e/data.js';

const cases = [
  [null, 'third\nfourth'],
  ['', 'third\nfourth'],
  ['0', 'first\nsecond\nthird\nfourth'],
  ['00', 'first\nsecond\nthird\nfourth'],
  ['1', 'fourth'],
  ['01', 'fourth'],
  ['2', 'third\nfourth'],
  ['3', 'second\nthird\nfourth'],
  ['4', 'first\nsecond\nthird\nfourth'],
  ['9007199254740991', 'first\nsecond\nthird\nfourth'],
  ['9007199254740992', 'third\nfourth'],
  ['9007199254740993', 'third\nfourth'],
  ['-0', 'third\nfourth'],
  ['-1', 'third\nfourth'],
  ['+1', 'third\nfourth'],
  ['1e2', 'third\nfourth'],
  ['0x10', 'third\nfourth'],
  ['1.0', 'third\nfourth'],
  ['1.5', 'third\nfourth'],
  ['1tail', 'third\nfourth'],
  [' 1', 'fourth'],
  ['1 ', 'fourth'],
  ['1\n', 'fourth'],
  [' 0 ', 'first\nsecond\nthird\nfourth'],
  ['\t0\r\n', 'first\nsecond\nthird\nfourth'],
  ['\t3\r\n', 'second\nthird\nfourth'],
  [' 9007199254740991 ', 'first\nsecond\nthird\nfourth'],
  [' 9007199254740992 ', 'third\nfourth'],
  [' 1 0 ', 'third\nfourth'],
  [' +1 ', 'third\nfourth'],
  [' -0 ', 'third\nfourth'],
  ['\t\r\n', 'third\nfourth'],
  [' ', 'third\nfourth'],
  ['Infinity', 'third\nfourth'],
  ['NaN', 'third\nfourth'],
  ['١', 'third\nfourth'],
];

for (const [value, expected] of cases) {
  test(`fixture log grammar for ${JSON.stringify(value)}`, () => {
    const url = new URL('http://fixture.invalid/api/logs/api');
    if (value !== null) url.searchParams.set('lines', value);
    const data = { config: { defaultTailLines: 2 }, logs: { api: 'first\nsecond\nthird\nfourth' } };
    assert.deepEqual(apiResponse(url, 'GET', data), { contentType: 'text/plain', body: expected });
  });
}

test('screenshot setup resolves within the owning workspace at alternate roots', async () => {
  const source = await readFile(new URL('../e2e/visual.spec.js', import.meta.url), 'utf8');
  const initializer = source.match(/^const screenshots = (.+);$/m)?.[1];
  assert.ok(initializer, 'The screenshot setup must have an inspectable initializer');
  for (const root of ['/ezat', '/home/runner/work/dashboard', '/workspaces/team workspace']) {
    const specURL = pathToFileURL(`${root}/dev-dashboard/e2e/visual.spec.js`).href;
    const actual = runInNewContext(initializer.replaceAll('import.meta.url', 'specURL'), {
      URL,
      fileURLToPath,
      specURL,
    });
    assert.equal(actual, `${root}/docs/dev-dashboard-redesign/verification/screenshots`);
  }
});
