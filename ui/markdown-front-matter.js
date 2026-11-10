// markdown-front-matter.js — DOM-free split of a Markdown file's leading front matter from its body.
// The files an agent writes open with a flat block of `key: value` lines between two `---` lines
// (kind, slug, status, created). That block is shown as a metadata row, not as a rule and a
// paragraph. Only that flat shape counts: a block with anything else in it (nesting, lists, a line
// that is not `key: value`) is left in the text, so nothing is guessed at and nothing is lost.
// A byte-order mark some editors put first; built from its code point so it stays visible here.
const BOM = new RegExp(`^${String.fromCharCode(0xfeff)}`);
const BLOCK = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const LINE = /^([A-Za-z][\w.-]{0,40}):[ \t]*(.*?)[ \t]*$/;
const MAX_FIELDS = 20;

export function splitFrontMatter(text) {
  const source = typeof text === 'string' ? text.replace(BOM, '') : '';
  const match = BLOCK.exec(source);
  if (!match) return { fields: [], body: source };
  const lines = match[1].split(/\r?\n/).filter((line) => line.trim() !== '');
  const fields = [];
  for (const line of lines) {
    const parsed = LINE.exec(line);
    if (!parsed) return { fields: [], body: source };
    const value = parsed[2].replace(/^(["'])(.*)\1$/, '$2');
    fields.push([parsed[1], value]);
  }
  if (!fields.length || fields.length > MAX_FIELDS) return { fields: [], body: source };
  return { fields, body: source.slice(match[0].length) };
}
