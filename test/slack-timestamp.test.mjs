import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSlackTs } from '../ui/slack-timestamp.js';
import { eligibleSlackRoot } from '../ui/slack-activity.js';
import { compareSlackTs, shouldWake, validSlackTs } from '../backend/slack-model.mjs';

test('Slack timestamp parsing preserves seconds and one to six fractional digits', () => {
  for (const [input, seconds, micros] of [
    ['0.0', 0n, 0n],
    ['00001.1', 1n, 100000n],
    ['12.01', 12n, 10000n],
    ['12.001', 12n, 1000n],
    ['12.0001', 12n, 100n],
    ['12.00001', 12n, 10n],
    ['12.000001', 12n, 1n],
    ['99999999999999999999.999999', 99999999999999999999n, 999999n],
  ]) {
    assert.deepEqual(parseSlackTs(input), [seconds, micros], input);
    assert.equal(validSlackTs(input), true, input);
  }
});

test('strict Slack timestamp parsing rejects malformed and non-string values', () => {
  for (const input of [
    '',
    '1',
    '1.',
    '.1',
    '-1.1',
    '+1.1',
    '1.0000000',
    '1.1 ',
    null,
    undefined,
    1.5,
  ]) {
    assert.equal(parseSlackTs(input), null, String(input));
    assert.equal(validSlackTs(input), false, String(input));
    assert.equal(eligibleSlackRoot(input, 2000), false, String(input));
  }
});

test('backend comparison and watcher retain coercion, ordering and invalid-input behavior', () => {
  const stringLike = { toString: () => '1.000001' };
  assert.equal(compareSlackTs(1.5, '1.499999'), 1);
  assert.equal(compareSlackTs(stringLike, '01.000001'), 0);
  assert.equal(compareSlackTs('999999999.999999', '1000000000.000000'), -1);
  assert.equal(validSlackTs(stringLike), false);
  assert.equal(eligibleSlackRoot(stringLike, 2000), false);
  assert.equal(shouldWake({ user: 'U1', ts: 1.5 }, 'U9', '1.499999'), true);
  assert.equal(shouldWake({ user: 'U1', ts: stringLike }, 'U9', null), true);
  assert.equal(shouldWake({ user: 'U1', ts: 'invalid' }, 'U9', null), false);
  assert.throws(() => compareSlackTs('invalid', '1.0'), TypeError);
});
