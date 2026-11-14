import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const base = read('ui-react/styles/base.css');
const services = read('ui-react/styles/services.css');

// Top-level rules of a flat sheet as { selectors, body, at } (nested @media blocks are skipped over).
const rules = (css) =>
  [
    ...css
      .replace(/\/\*[\s\S]*?\*\//g, (comment) => ' '.repeat(comment.length))
      .matchAll(/(?<=^|\})\s*([^{}@]+)\{([^{}]*)\}/g),
  ].map((match) => ({
    selectors: match[1].split(',').map((selector) => selector.trim()),
    body: match[2],
    at: match.index,
  }));
const ruleFor = (css, selector) => rules(css).find(({ selectors }) => selectors.includes(selector));

// The opening tag of the <Button> that carries a test id.
const buttonTag = (source, testId) => {
  const at = source.indexOf(testId);
  assert.notEqual(at, -1, `${testId} is in the source`);
  const open = source.lastIndexOf('<Button', at);
  assert.notEqual(open, -1, `${testId} sits on a <Button>`);
  return source.slice(open).match(/<Button[\s\S]*?[^=]>/)[0];
};

test('neutral default comes before primary, subtle and danger in base.css', () => {
  const neutral = ruleFor(base, '.btn.MuiButton-outlined');
  assert.ok(neutral, 'a .btn.MuiButton-outlined rule beats MUI outlined colour');
  assert.match(neutral.body, /color:\s*var\(--text\)/);
  assert.match(neutral.body, /border-color:\s*var\(--border-strong\)/);
  assert.match(neutral.body, /background-color:\s*transparent/);
  for (const later of ['.btn.primary', '.btn.subtle', '.btn.danger']) {
    const rule = ruleFor(base, later);
    assert.ok(rule, `${later} exists`);
    assert.ok(
      neutral.at < rule.at,
      `.btn.MuiButton-outlined comes before ${later} (same specificity)`,
    );
  }
  const hover = ruleFor(base, '.btn.MuiButton-outlined:hover');
  assert.ok(hover, 'a hover rule for the neutral button');
  assert.match(hover.body, /border-color:\s*var\(--accent\)/);
  assert.match(
    hover.body,
    /background-color:\s*color-mix\(in srgb, var\(--accent\) 8%, transparent\)/,
  );
  const plain = ruleFor(base, '.btn');
  assert.match(plain.body, /border:\s*1px solid var\(--border-strong\)/);
  assert.match(plain.body, /background:\s*transparent/);
  assert.match(base, /@media \(hover: none\)\s*\{\s*\.btn\s*\{\s*min-height:\s*44px;/);
});

test('danger button is a red label on a red-tinted edge with its own hover and disabled look', () => {
  const danger = ruleFor(base, '.btn.danger');
  assert.ok(danger, '.btn.danger');
  assert.match(danger.body, /(^|[\s;])color:\s*var\(--red\)/);
  assert.match(
    danger.body,
    /border-color:\s*color-mix\(in srgb, var\(--red\) 60%, var\(--border-strong\)\)/,
  );
  const hover = ruleFor(base, '.btn.danger:hover');
  assert.ok(hover, '.btn.danger:hover');
  assert.match(hover.body, /color-mix\(in srgb, var\(--red\) 12%/);
  const disabled = ruleFor(base, '.btn.danger:disabled');
  assert.ok(disabled, '.btn.danger:disabled');
  assert.match(disabled.body, /border-color:\s*var\(--border\)/);
  assert.match(disabled.body, /color:\s*var\(--text\)/);
});

test('call sites carry their button class: primary, danger, and Home Refresh only before data', () => {
  const home = read('ui-react/panels/HomePanel.jsx');
  const homeTag = buttonTag(home, 'data-testid="home-refresh"');
  assert.match(homeTag, /primary/);
  assert.match(homeTag, /\bdata\b/, 'the fill depends on whether data has loaded');
  assert.doesNotMatch(homeTag, /className="primary"/, 'never unconditional');

  for (const [file, testId] of [
    ['ui-react/panels/DevtoolsPanel.jsx', 'data-testid="devtools-launch"'],
    ['ui-react/panels/ChatPanel.jsx', 'data-testid="chat-send"'],
    ['ui-react/panels/SlackPanel.jsx', 'data-testid="slack-connect"'],
  ])
    assert.match(buttonTag(read(file), testId), /className="primary"/, `${testId} is primary`);

  const card = read('ui-react/components/ServiceCard.jsx');
  const controls = card.slice(
    card.indexOf('export function ServiceControlButtons'),
    card.indexOf('export function ServiceCard('),
  );
  assert.match(controls, /start primary/, 'Start all is "start primary"');

  for (const [file, testId] of [
    ['ui-react/panels/SlackPanel.jsx', 'data-testid="slack-disconnect"'],
    ['ui-react/components/DevtoolsTile.jsx', 'data-testid={`devtools-remove-${id}`}'],
    ['ui-react/components/SlackWatchCard.jsx', 'data-testid={`slack-watch-remove-${entry.key}`}'],
  ])
    assert.match(buttonTag(read(file), testId), /className="danger"/, `${testId} is danger`);
});

test('cyan only for interaction: ports and Start all', () => {
  assert.match(ruleFor(services, '.service-port').body, /(^|[\s;])color:\s*var\(--text\)/);
  assert.doesNotMatch(
    ruleFor(base, '.btn.start')?.body ?? '',
    /color:\s*var\(--accent\)/,
    '.btn.start no longer paints accent text',
  );
  const start = ruleFor(services, '#panel-services .btn.start:not(:disabled)');
  assert.doesNotMatch(
    start?.body ?? '',
    /(^|[\s;])color:/,
    'a colour on Start all would paint accent text over the primary fill',
  );
});

test('no readable text under 12px (base.css)', () => {
  const small = [...base.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].filter(
    ([, size]) => Number(size) < 12,
  );
  assert.deepEqual(
    small.map(([text]) => text),
    [],
  );
});
