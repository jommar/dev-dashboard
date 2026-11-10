import test from 'node:test';
import assert from 'node:assert/strict';
import { QUALITIES, isQuality, topQuality } from '../ui/screencast-quality.js';

test('there are two qualities, lowest first', () => {
  assert.deepEqual(QUALITIES, ['tile', 'full']);
  assert.equal(isQuality('tile'), true);
  assert.equal(isQuality('full'), true);
  for (const value of ['huge', '', 'FULL', undefined, null, 1, ['tile']])
    assert.equal(isQuality(value), false, String(value));
});

test('the quality of several viewers is the highest, and nobody means none', () => {
  assert.equal(topQuality([]), null);
  assert.equal(topQuality(new Set()), null);
  assert.equal(topQuality(['tile']), 'tile');
  assert.equal(topQuality(['full']), 'full');
  assert.equal(topQuality(['tile', 'tile']), 'tile');
  assert.equal(topQuality(['tile', 'full', 'tile']), 'full');
  assert.equal(topQuality(new Set(['full', 'tile'])), 'full');
  assert.equal(topQuality(['nonsense']), null, 'an unknown level is no viewer');
  assert.equal(topQuality(['nonsense', 'tile']), 'tile');
});
