// format-tokens.js — how a token count and a usage tally read on screen. Tokens only, no currency.

// 950 -> "950", 1234 -> "1.2k", 1200000 -> "1.2M"; an incomplete tally (`complete: false`) is a lower
// bound, so it is prefixed "at least ".
export function formatTokens(count, { complete = true } = {}) {
  const scaled = (value, unit) => `${Number(value.toFixed(1))}${unit}`;
  let text;
  if (count < 1000) text = String(Math.round(count));
  else if (count < 999_950) text = scaled(count / 1000, 'k');
  else text = scaled(count / 1_000_000, 'M');
  return complete ? text : `at least ${text}`;
}

// The sum of `{ tokens, complete }` tallies (the usage route's per-session answers) as
// `{ total, complete }`: every token kind counts, and one incomplete tally makes the sum incomplete.
export function sumUsage(usages) {
  let total = 0;
  let complete = true;
  for (const usage of usages) {
    total += Object.values(usage.tokens).reduce((sum, value) => sum + value, 0);
    if (!usage.complete) complete = false;
  }
  return { total, complete };
}

// "~1.2M tokens", or "at least 1.2M tokens" when the tally is a lower bound.
export const tokensLabel = ({ total, complete }) =>
  `${complete ? '~' : ''}${formatTokens(total, { complete })} tokens`;
