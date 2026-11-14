// claude-verdict.js — how the one-line outcome of a finished e2e check or groom session is shown.
// Pure, and the only place the words and tones live. The values mirror the closed enums in
// `backend/claude-artifacts.mjs` (a test pins that they agree); anything outside them is no verdict.

export const VERDICT_WORDS = Object.freeze({
  PASS: 'Pass',
  FAIL: 'Fail',
  PARTIAL: 'Partial',
  BLOCKED: 'Blocked',
  READY: 'Ready',
  NEEDS_INFO: 'Needs info',
});

// The tone is a colour hint only: the word is always shown beside it.
export const VERDICT_TONE = Object.freeze({
  PASS: 'good',
  FAIL: 'bad',
  PARTIAL: 'caution',
  BLOCKED: 'bad',
  READY: 'good',
  NEEDS_INFO: 'caution',
});

// The words for `value`, or null for anything that is not one of the enum values.
export const verdictWord = (value) =>
  typeof value === 'string' && Object.hasOwn(VERDICT_WORDS, value) ? VERDICT_WORDS[value] : null;
