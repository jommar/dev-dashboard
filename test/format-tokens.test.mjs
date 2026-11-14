// format-tokens.test.mjs — how token counts and usage tallies read on screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTokens, sumUsage, tokensLabel } from '../ui/format-tokens.js';

test('formatTokens: plain below a thousand, k and M with one decimal above', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(950), '950');
  assert.equal(formatTokens(1000), '1k');
  assert.equal(formatTokens(1234), '1.2k');
  assert.equal(formatTokens(999_949), '999.9k');
  assert.equal(formatTokens(999_950), '1M', 'never 1000k');
  assert.equal(formatTokens(1_200_000), '1.2M');
  assert.equal(formatTokens(2_000_000), '2M');
});

test('formatTokens: an incomplete tally is a lower bound and says so', () => {
  assert.equal(formatTokens(1234, { complete: false }), 'at least 1.2k');
  assert.equal(formatTokens(950, { complete: false }), 'at least 950');
});

test('sumUsage adds every token kind of every tally, and one incomplete tally makes it incomplete', () => {
  const tally = (input, complete = true) => ({
    tokens: { input, output: 1, cacheRead: 10, cacheCreation: 100 },
    complete,
  });
  assert.deepEqual(sumUsage([tally(1), tally(2)]), { total: 225, complete: true });
  assert.deepEqual(sumUsage([tally(1), tally(2, false)]), { total: 225, complete: false });
  assert.deepEqual(sumUsage([]), { total: 0, complete: true });
});

test('tokensLabel: "~1.2M tokens", or "at least 1.2M tokens" for a lower bound', () => {
  assert.equal(tokensLabel({ total: 1_200_000, complete: true }), '~1.2M tokens');
  assert.equal(tokensLabel({ total: 1_200_000, complete: false }), 'at least 1.2M tokens');
});
