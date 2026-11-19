import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file) => fs.readFileSync(new URL(`../ui-react/${file}`, import.meta.url), 'utf8');

// The source of `export function <name>` up to its closing brace at column 0.
function functionSource(source, name) {
  const start = source.indexOf(`export function ${name}(`);
  assert.ok(start > -1, `${name} is exported`);
  const end = source.indexOf('\n}\n', start);
  return source.slice(start, end + 3);
}

// Every flat `selector { body }` rule in a sheet (a rule inside @media is found without its media).
function rules(css) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selector: selector.replace(/\/\*[\s\S]*?\*\//g, '').trim(),
    body,
  }));
}

// The text between the braces of the first block that starts with `head`.
function blockAfter(css, head) {
  const at = head instanceof RegExp ? css.search(head) : css.indexOf(head);
  const open = css.indexOf('{', at);
  assert.ok(at > -1 && open > -1, `${head} exists`);
  let depth = 0;
  for (let at = open; at < css.length; at += 1) {
    if (css[at] === '{') depth += 1;
    if (css[at] === '}' && (depth -= 1) === 0) return css.slice(open + 1, at);
  }
  return assert.fail(`${head} is closed`);
}

const emptyAttr = /\[data-empty=(['"])true\1\]/;

test('BoardColumn marks an empty column with data-empty from its count and its children, and takes only the copyKeys prop', () => {
  const source = functionSource(read('components/BoardShell.jsx'), 'BoardColumn');
  assert.match(
    source.split('\n')[0],
    /\{ id, label, count, testIdPrefix, kind, hint, copyKeys, children \}/,
    'copyKeys is the one prop beyond the heading ones',
  );
  assert.match(source, /data-empty=/, 'the section carries data-empty');
  assert.match(source, /Number\(count\) === 0/, 'an empty column has a count of 0');
  assert.match(
    source,
    /Children\.toArray\(children\)\.length === 0/,
    'and no children, so a lane holding only a Load more item is not empty',
  );
  assert.match(source, /\?\s*'true'\s*:\s*undefined/, 'the attribute is absent when not empty');
  assert.match(
    read('components/BoardShell.jsx').split('\n').slice(0, 12).join('\n'),
    /import \{[^}]*\bChildren\b[^}]*\} from 'react'/,
    'Children comes from react',
  );
  assert.match(source, /<h3\b/, 'the heading stays rendered for a rail');
  assert.match(source, /<ul className="board-column-body"/, 'the list stays in the DOM');
});

test('board.css sizes columns by width and turns an empty column beside a populated one into a 44px rail', () => {
  const css = read('styles/board.css');
  const all = rules(css);
  const track = all.find(({ selector }) => selector === '.board-track');
  assert.match(track.body, /grid-auto-columns:\s*max-content/, 'the track sizes to its columns');
  assert.doesNotMatch(track.body, /grid-auto-columns:\s*280px/);
  const column = all.find(({ selector }) => selector === '.board-column');
  assert.match(column.body, /width:\s*280px/, 'a full column is 280px');
  assert.match(
    blockAfter(css, /@media \(max-width: 599px\)[^{]*\{\s*\.board-track/),
    /\.board-column\s*\{[^}]*width:\s*82vw/,
    'and 82vw on a phone',
  );
  const rail = all.filter(
    ({ selector }) =>
      emptyAttr.test(selector) && /:has\(\s*>\s*\.board-column:not\(/.test(selector),
  );
  assert.ok(rail.length > 0, 'a rule applies only while the track has a non-empty column');
  const railBody = rail.map(({ body }) => body).join('\n');
  assert.match(railBody, /width:\s*44px/, 'the rail is 44px wide');
  assert.match(
    railBody,
    /scroll-snap-align:\s*end/,
    'a rail snaps to the end, so the last rail is reachable under mandatory snap',
  );
  assert.match(
    all.find(({ selector }) => emptyAttr.test(selector) && /\.board-column-title/.test(selector))
      ?.body ?? '',
    /writing-mode:\s*vertical-rl/,
    'the title is written vertically',
  );
  const hidden = all.find(
    ({ selector }) => emptyAttr.test(selector) && /\.board-column-body/.test(selector),
  );
  assert.match(hidden?.body ?? '', /display:\s*none/, 'a rail hides its list');
  assert.doesNotMatch(
    rail.map(({ body }) => body).join('\n'),
    /transition/,
    'no width transition on the rail',
  );
});

test('BoardNote keeps role=status, its test id and its text, and adds a chip with a measured toggle', () => {
  const source = functionSource(read('components/BoardShell.jsx'), 'BoardNote');
  assert.match(
    source.split('\n')[0],
    /\{ testId, defaultOpen = false, children \}/,
    'defaultOpen is the one new prop, closed by default',
  );
  assert.match(source, /<p\b[^>]*className="board-note"/, 'still the amber board-note paragraph');
  assert.match(source, /role="status"/);
  assert.match(source, /data-testid=\{testId\}/);
  assert.match(source, /data-open=/, 'the open state is on the note');
  assert.match(source, /aria-hidden/, 'the warning glyph is decorative');
  assert.match(
    source,
    /<span\b[^>]*className="board-note-text"[^>]*\bid=|<span\b[^>]*\bid=[^>]*className="board-note-text"/,
    'the text span has an id for aria-controls',
  );
  const toggle = source.match(/<button\b[\s\S]*?<\/button>|<button\b[\s\S]*?\/>/)?.[0] ?? '';
  assert.match(toggle, /type="button"/);
  assert.match(toggle, /className="board-note-toggle"/);
  assert.match(toggle, /Show full note/);
  assert.match(toggle, /Collapse note/);
  assert.match(toggle, /aria-expanded=/);
  assert.match(toggle, /aria-controls=/);
  assert.doesNotMatch(
    toggle.replace(/aria-label=\{[^}]*\}/, ''),
    />\s*[A-Za-z]/,
    'the toggle has no text content',
  );
  assert.match(source, /scrollWidth\s*>\s*[\w.]*clientWidth/, 'overflow is measured on the span');
  assert.match(source, /useLayoutEffect\(/);
  assert.match(source, /new ResizeObserver\(/);
  assert.match(source, /\.disconnect\(\)/, 'the observer is disconnected on unmount');
  assert.match(
    read('components/BoardShell.jsx').split('\n').slice(0, 12).join('\n'),
    /import \{[^}]*\buseLayoutEffect\b[^}]*\} from 'react'/,
  );
});

test('board.css draws a note as an amber one-line chip that wraps when open', () => {
  const all = rules(read('styles/board.css'));
  const text = all.find(({ selector }) => selector === '.board-note-text');
  assert.match(text?.body ?? '', /white-space:\s*nowrap/, 'collapsed text is one line');
  assert.match(text?.body ?? '', /overflow:\s*hidden/);
  assert.match(text?.body ?? '', /text-overflow:\s*ellipsis/);
  const open = all.find(
    ({ selector }) => /\.board-note/.test(selector) && /data-open=(['"])true\1/.test(selector),
  );
  assert.match(open?.body ?? '', /white-space:\s*(normal|pre-wrap)/, 'open text wraps');
  assert.ok(
    all.some(({ selector }) => selector === '.board-note-toggle'),
    'the toggle is styled',
  );
});

const LINKED_NOTES = {
  'MyTicketsPanel.jsx': 'my-tickets-slack-coverage',
  'SprintPanel.jsx': 'sprint-board-slack-coverage',
};

test('only the Slack coverage notes, which carry a link, start open', () => {
  for (const [file, testId] of Object.entries(LINKED_NOTES))
    assert.ok(
      new RegExp(
        `<BoardNote\\b(?=[^>]*\\btestId="${testId}")(?=[^>]*\\bdefaultOpen\\b)[^>]*>`,
      ).test(read(`panels/${file}`)),
      `${file}: the note that carries a link starts open`,
    );
  for (const file of fs.readdirSync(new URL('../ui-react/panels/', import.meta.url))) {
    const source = read(`panels/${file}`);
    const opened = [...source.matchAll(/<BoardNote\b([^>]*)>/g)].filter(([, props]) =>
      /\bdefaultOpen\b/.test(props),
    );
    const expected = file in LINKED_NOTES ? 1 : 0;
    assert.equal(opened.length, expected, `${file} opens ${expected} note(s) by default`);
  }
});

test('BoardColumn puts the copy-keys button before the title, only for a lane that lists keys, and the tooltip lists them', () => {
  const file = read('components/BoardShell.jsx');
  const source = functionSource(file, 'BoardColumn');
  const button = source.indexOf('<CopyKeysButton');
  assert.ok(button > -1, 'the lane renders the copy button');
  assert.ok(
    button < source.indexOf('<DashboardTooltip title={hint}'),
    'the button comes before the heading',
  );
  assert.match(source, /keys\.length > 0 &&/, 'no keys, no button (an empty rail has none)');
  assert.match(source, /new Set\(/, 'a key shared by two cards is listed and copied once');
  const copy = file.slice(
    file.indexOf('function CopyKeysButton'),
    file.indexOf('export function BoardColumn'),
  );
  assert.match(copy, /keys\.join\('\\n'\)/, 'copied one per line');
  assert.match(copy, /keys\.map\(\(key\) =>/, 'the tooltip lists every key');
  for (const panel of [
    'components/TicketBoard.jsx',
    'panels/SprintPanel.jsx',
    'panels/PrsPanel.jsx',
  ])
    assert.match(read(panel), /copyKeys=\{/, `${panel} passes its lane's keys`);
});
