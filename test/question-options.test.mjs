import { test } from 'node:test';
import assert from 'node:assert/strict';

// Loaded inside each test so a missing module fails that test alone, by name.
const load = () => import('../ui/question-options.js');

const SAMPLE =
  'Invoice totals after row edits? (a) Refresh right away (recommended); (b) leave for a follow-up, ' +
  'header updates only on reopen; (c) other.';

test('parseOptions splits the stem from lettered options and tags the recommended one', async () => {
  const { parseOptions } = await load();
  const parsed = parseOptions(SAMPLE);
  assert.equal(parsed.stem, 'Invoice totals after row edits?');
  assert.deepEqual(
    parsed.options.map(({ letter, text, recommended, other }) => [
      letter,
      text,
      recommended,
      other,
    ]),
    [
      ['a', 'Refresh right away', true, false],
      ['b', 'leave for a follow-up, header updates only on reopen', false, false],
      ['c', 'other', false, true],
    ],
  );
});

test('parseOptions handles ", or" joins and a final full stop', async () => {
  const { parseOptions } = await load();
  const { options } = parseOptions('Which one? (a) First, (b) Second, or (c) Third.');
  assert.deepEqual(
    options.map(({ text }) => text),
    ['First', 'Second', 'Third'],
  );
});

test('parseOptions leaves anything that is not a clean lettered list alone', async () => {
  const { parseOptions } = await load();
  assert.equal(parseOptions('Which repo owns the fix?'), null);
  assert.equal(parseOptions('Only one? (a) lonely'), null);
  assert.equal(parseOptions('Out of order? (b) one; (a) two'), null);
  assert.equal(parseOptions('Starts at b? (b) one; (c) two'), null);
  assert.equal(parseOptions('Repeats? (a) one; (b) two; (c) three; (a) again'), null);
  assert.equal(parseOptions('(a) one; (b) two'), null);
  assert.equal(parseOptions('Glued? TAP-12(a) one; (b) two'), null);
  assert.equal(parseOptions('Empty option? (a) ; (b) two'), null);
  assert.equal(parseOptions(null), null);
});

test('an option writes its letter and words, without the recommended tag', async () => {
  const { parseOptions, optionAnswer } = await load();
  const [first] = parseOptions(SAMPLE).options;
  assert.equal(optionAnswer(first), '(a) Refresh right away');
});

test('chosenLetter reads the pick back from the answer text', async () => {
  const { parseOptions, chosenLetter } = await load();
  const { options } = parseOptions(SAMPLE);
  assert.equal(chosenLetter('', options), null);
  assert.equal(chosenLetter('(b) leave for a follow-up', options), 'b');
  assert.equal(chosenLetter('B.', options), 'b');
  assert.equal(chosenLetter('a', options), 'a');
  // "A new approach" is words, not option a: it is a written-in answer, so it reads as Other.
  assert.equal(chosenLetter('A new approach', options), 'c');
  assert.equal(chosenLetter('hold on, do TAP-2537 first', options), 'c');
});

test('a written-in answer selects nothing when there is no Other option', async () => {
  const { parseOptions, chosenLetter } = await load();
  const { options } = parseOptions('Which? (a) one; (b) two');
  assert.equal(chosenLetter('something else', options), null);
  assert.equal(chosenLetter('(b) two', options), 'b');
});

test('every option round-trips: the answer it writes selects it', async () => {
  const { parseOptions, chosenLetter, optionAnswer } = await load();
  for (const option of parseOptions(SAMPLE).options) {
    const { options } = parseOptions(SAMPLE);
    assert.equal(chosenLetter(optionAnswer(option), options), option.letter);
  }
});

test('answerForOther drops a letter pick and keeps written-in words', async () => {
  const { parseOptions, answerForOther } = await load();
  const { options } = parseOptions(SAMPLE);
  assert.equal(answerForOther('(a) Refresh right away', options), '');
  assert.equal(answerForOther('hold on, do TAP-2537 first', options), 'hold on, do TAP-2537 first');
  assert.equal(answerForOther('', options), '');
  assert.equal(answerForOther('(c) other: ask Sam', options), '(c) other: ask Sam');
});
