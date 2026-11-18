// question-options.js — reads the lettered options a session writes inline into a question
// ("... (a) first; (b) second (recommended); (c) other.") so the dialog can show them as choices.
// Pure and display-only: status.json keeps its shape and the answer stays free text. A question that
// does not read cleanly as a lettered list parses to null and keeps its plain textarea.

// A marker is "(a)" at the start or after whitespace, so "TAP-12(a)" or a "(b)" in a code sample is
// not one. Letters must run a, b, c ... in order from "a", or the whole question is left alone.
const MARKER = /(?:^|\s)\(([a-z])\)\s+/g;
const RECOMMENDED = /\s*\(recommended\)/i;
// What sits between two options: "first; (b)", "first, or (b)", "first. (b)".
const TRAILING = /[\s;,.]*(?:\bor\b)?[\s;,.]*$/i;

/** @returns {{ stem: string, options: { letter: string, text: string, recommended: boolean, other: boolean }[] } | null} */
export function parseOptions(question) {
  const text = String(question ?? '');
  const marks = [...text.matchAll(MARKER)];
  if (marks.length < 2) return null;
  if (!marks.every((mark, index) => mark[1] === String.fromCharCode(97 + index))) return null;
  const stem = text.slice(0, marks[0].index).trim();
  if (!stem) return null;
  const options = marks.map((mark, index) => {
    const start = mark.index + mark[0].length;
    const end = index + 1 < marks.length ? marks[index + 1].index : text.length;
    const raw = text.slice(start, end);
    const recommended = RECOMMENDED.test(raw);
    const clean = raw.replace(RECOMMENDED, '').replace(TRAILING, '').trim();
    return { letter: mark[1], text: clean, recommended, other: /^other\b/i.test(clean) };
  });
  if (options.some(({ text: label }) => !label)) return null;
  return { stem, options };
}

/** The answer an option writes: its letter and words, never the "(recommended)" tag. */
export const optionAnswer = ({ letter, text }) => `(${letter}) ${text}`;

// "(b) ...", "b) ...", "b." and a bare "b" name option b; "A new approach" does not name a.
const LEADING_LETTER = /^(?:\(([a-z])\)|([a-z])(?:[).:]|$))/i;

// The letter an answer names outright ("(b) ...", "b."), whether or not an option has it.
function namedLetter(answer, options) {
  const match = LEADING_LETTER.exec(String(answer ?? '').trim());
  const letter = (match?.[1] ?? match?.[2])?.toLowerCase();
  return options.some((option) => option.letter === letter) ? letter : null;
}

/** The letter of the option an answer picks, else null. A written-in answer picks "other" when there is one. */
export function chosenLetter(answer, options) {
  if (!String(answer ?? '').trim()) return null;
  return namedLetter(answer, options) ?? options.find(({ other }) => other)?.letter ?? null;
}

/** The box after "Other" is picked: a pick of another option is dropped, anything written in is kept. */
export function answerForOther(answer, options) {
  const letter = namedLetter(answer, options);
  return letter && !options.find((option) => option.letter === letter).other ? '' : answer;
}
