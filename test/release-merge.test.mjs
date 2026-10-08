import test from 'node:test';
import assert from 'node:assert/strict';

async function model(...names) {
  const mod = await import('../backend/release-model.mjs');
  for (const name of names)
    assert.equal(typeof mod[name], 'function', `release-model.mjs must export ${name}`);
  return mod;
}

const featureBranch = 'DEMO-1058/mileage-rate-fix';
const candidate = (state, base, head = featureBranch) => ({ state, base, head });

test('a merged PR into ops/development from a feature branch counts as merged', async () => {
  const { classifyPr } = await model('classifyPr');
  assert.equal(classifyPr(candidate('merged', 'ops/development')), true);
});

test('an open, unknown or declined PR does not count as merged', async () => {
  const { classifyPr } = await model('classifyPr');
  for (const state of ['open', 'unknown', 'declined']) {
    assert.equal(classifyPr(candidate(state, 'ops/development')), false, state);
  }
});

test('a PR merged into any base other than ops/development does not count', async () => {
  const { classifyPr } = await model('classifyPr');
  assert.equal(classifyPr(candidate('merged', 'ops/qa')), false);
  assert.equal(classifyPr(candidate('merged', 'ops/uat')), false);
});

test('a PR merged into ops/development from an ops branch does not count', async () => {
  const { classifyPr } = await model('classifyPr');
  assert.equal(classifyPr(candidate('merged', 'ops/development', 'ops/qa')), false);
  assert.equal(classifyPr(candidate('merged', 'ops/development', 'ops/uat')), false);
});

const counted = (state, base, head = featureBranch, countsAsMerged = false) => ({
  state,
  base,
  head,
  countsAsMerged,
});
const mergedToDevelopment = counted('merged', 'ops/development', featureBranch, true);
const mergedToDevelopmentAgain = counted(
  'merged',
  'ops/development',
  'DEMO-1058/second-repo',
  true,
);
const openOnDevelopment = counted('open', 'ops/development');
const unknownOnDevelopment = counted('unknown', 'ops/development');
const mergedToQa = counted('merged', 'ops/qa');
const declinedPr = counted('declined', 'ops/development');
const promotionIntoDevelopment = counted('merged', 'ops/development', 'ops/qa');

test('every PR merged into ops/development from a feature branch rolls up to merged', async () => {
  const { rollUpTicket } = await model('rollUpTicket');
  assert.equal(rollUpTicket([mergedToDevelopment], 'ok'), 'merged');
  assert.equal(rollUpTicket([mergedToDevelopment, mergedToDevelopmentAgain], 'ok'), 'merged');
});

test('one counted PR plus an open PR, or plus one merged into ops/qa, rolls up to partial', async () => {
  const { rollUpTicket } = await model('rollUpTicket');
  assert.equal(rollUpTicket([mergedToDevelopment, openOnDevelopment], 'ok'), 'partial');
  assert.equal(rollUpTicket([mergedToDevelopment, mergedToQa], 'ok'), 'partial');
});

test('only open, unknown or non-development PRs roll up to open', async () => {
  const { rollUpTicket } = await model('rollUpTicket');
  assert.equal(rollUpTicket([openOnDevelopment], 'ok'), 'open');
  assert.equal(rollUpTicket([unknownOnDevelopment], 'ok'), 'open');
  assert.equal(rollUpTicket([mergedToQa], 'ok'), 'open');
  assert.equal(rollUpTicket([openOnDevelopment, unknownOnDevelopment, mergedToQa], 'ok'), 'open');
});

test('no PRs, or only declined PRs, roll up to no-pr', async () => {
  const { rollUpTicket } = await model('rollUpTicket');
  assert.equal(rollUpTicket([], 'ok'), 'no-pr');
  assert.equal(rollUpTicket([declinedPr], 'ok'), 'no-pr');
  assert.equal(rollUpTicket([declinedPr, declinedPr], 'ok'), 'no-pr');
});

test('a failed lookup rolls up to unavailable whatever PRs came with it', async () => {
  const { rollUpTicket } = await model('rollUpTicket');
  assert.equal(rollUpTicket([], 'unavailable'), 'unavailable');
  assert.equal(rollUpTicket([mergedToDevelopment], 'unavailable'), 'unavailable');
});

test('a merged PR from an ops branch into ops/development does not count towards the roll-up', async () => {
  const { rollUpTicket } = await model('rollUpTicket');
  assert.equal(rollUpTicket([promotionIntoDevelopment], 'ok'), 'open');
  assert.equal(rollUpTicket([mergedToDevelopment, promotionIntoDevelopment], 'ok'), 'partial');
});

test('declined PRs never change the roll-up result', async () => {
  const { rollUpTicket } = await model('rollUpTicket');
  assert.equal(rollUpTicket([mergedToDevelopment, declinedPr], 'ok'), 'merged');
  assert.equal(rollUpTicket([mergedToDevelopment, openOnDevelopment, declinedPr], 'ok'), 'partial');
  assert.equal(rollUpTicket([openOnDevelopment, declinedPr], 'ok'), 'open');
});
