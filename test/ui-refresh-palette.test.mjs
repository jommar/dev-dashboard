import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../ui-react/', import.meta.url));
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

// The declarations of the first `:root { ... }` block.
const rootBlock = (css) => /:root\s*\{([^}]*)\}/.exec(stripComments(css))?.[1] ?? '';

// Custom properties declared in a block, name -> trimmed value.
const declarations = (block) =>
  Object.fromEntries(
    [...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [
      name,
      value.replace(/\s+/g, ' ').trim(),
    ]),
  );

// Every rule's selector and body, for the flat (non-nested) rules the sheets use.
const rules = (css) =>
  [...stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selector: selector.trim(),
    body,
  }));

// The body of every rule whose selector list contains `selector` exactly.
const bodiesFor = (css, selector) =>
  rules(css)
    .filter((rule) => rule.selector.split(',').some((part) => part.trim() === selector))
    .map((rule) => rule.body)
    .join('\n');

const sheets = () => {
  const dir = path.join(root, 'styles');
  return [
    'styles.css',
    ...fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.css'))
      .map((name) => `styles/${name}`),
  ];
};

// The palette values the refresh adopts; tokens.css is the only place they are written.
// --red is held by contrast alone: the spec value (#fb7185) is 4.44:1 under the 12% danger tint on
// --panel2, so the coder may lift it (about #fc8191) or cut the tint; theme.js follows whatever it is.
const PALETTE = {
  '--bg': '#0a0b0d',
  '--panel': '#181b20',
  '--panel2': '#262b33',
  '--border': '#363c46',
  '--border-strong': '#6f7681',
  '--text': '#c9cdd4',
  '--strong': '#f1f2f4',
  '--muted': '#a1a8b2',
  '--accent': '#67e8f9',
  '--accent-fill': '#22d3ee',
  '--support': '#b8aef6',
  '--green': '#34d399',
  '--amber': '#fbbf24',
  '--status-active': '#60a5fa',
  '--phase-implement': '#2dd4bf',
};

const tokens = () => declarations(rootBlock(read('styles/tokens.css')));

test('the palette is declared once, in tokens.css, and the other files follow it', () => {
  const declared = tokens();
  for (const [name, value] of Object.entries(PALETTE))
    assert.equal(declared[name]?.toLowerCase(), value, `tokens.css ${name} is ${value}`);
  assert.match(declared['--red'] ?? '', /^#[0-9a-f]{6}$/i, 'tokens.css --red is a hex colour');

  // Moved in from styles.css so tokens.css is the single source.
  for (const name of ['--accent-hover', '--track', '--grid', '--font-display', '--font-text'])
    assert.ok(declared[name], `tokens.css declares ${name}`);
  assert.ok(declared['--font-mono'], 'tokens.css declares --font-mono');
  assert.equal(declared['--sans'], 'var(--font-text)');
  assert.equal(declared['--mono'], 'var(--font-mono)');
  assert.match(declared['--shadow'], /rgba\(255, 255, 255, 0\.05\)/);
  assert.match(declared['--shadow'], /rgba\(255, 255, 255, 0\.04\)/);

  // styles.css keeps the seven aliases and no colour or font of its own.
  const aliases = declarations(rootBlock(read('styles.css')));
  assert.deepEqual(aliases, {
    '--panel-2': 'var(--panel2)',
    '--fg': 'var(--text)',
    '--fg-strong': 'var(--strong)',
    '--fg-muted': 'var(--muted)',
    '--ok': 'var(--green)',
    '--bad': 'var(--red)',
    '--warn': 'var(--amber)',
  });

  // theme.js literals and the theme-color meta equal the tokens.
  const theme = read('theme.js');
  const themeColour = (pattern) => pattern.exec(theme)?.[1]?.toLowerCase();
  assert.equal(themeColour(/default:\s*'(#[0-9a-f]{6})'/i), PALETTE['--bg'], 'theme background');
  assert.equal(themeColour(/paper:\s*'(#[0-9a-f]{6})'/i), PALETTE['--panel'], 'theme paper');
  assert.equal(themeColour(/primary:\s*\{\s*main:\s*'(#[0-9a-f]{6})'/i), PALETTE['--accent']);
  assert.equal(themeColour(/success:\s*\{\s*main:\s*'(#[0-9a-f]{6})'/i), PALETTE['--green']);
  assert.equal(
    themeColour(/error:\s*\{\s*main:\s*'(#[0-9a-f]{6})'/i),
    declared['--red'].toLowerCase(),
  );
  assert.equal(themeColour(/warning:\s*\{\s*main:\s*'(#[0-9a-f]{6})'/i), PALETTE['--amber']);
  assert.equal(themeColour(/primary:\s*'(#[0-9a-f]{6})'/i), PALETTE['--strong'], 'text.primary');
  assert.equal(themeColour(/secondary:\s*'(#[0-9a-f]{6})'/i), PALETTE['--muted'], 'text.secondary');
  assert.equal(themeColour(/divider:\s*'(#[0-9a-f]{6})'/i), PALETTE['--border'], 'divider');
  assert.match(read('index.html'), /<meta name="theme-color" content="#0a0b0d"/i);
});

// WCAG relative luminance and contrast ratio.
const channel = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
// `fg` over `bg` at `alpha` (0..1), as a hex colour.
const mix = (fg, bg, alpha) => {
  const part = (i) =>
    Math.round(
      parseInt(fg.slice(i, i + 2), 16) * alpha + parseInt(bg.slice(i, i + 2), 16) * (1 - alpha),
    )
      .toString(16)
      .padStart(2, '0');
  return `#${part(1)}${part(3)}${part(5)}`;
};

test('contrast: every text pair 4.5:1, every edge 3:1', () => {
  const t = tokens();
  for (const name of [...Object.keys(PALETTE), '--red'])
    assert.match(t[name] ?? '', /^#[0-9a-f]{6}$/i, `tokens.css declares ${name} as a hex colour`);
  const v = (name) => t[name].toLowerCase();
  const surfaces = ['--bg', '--panel', '--panel2'];

  const failures = [];
  const need = (label, fg, bg, floor) => {
    const got = ratio(fg, bg);
    if (got < floor) failures.push(`${label}: ${got.toFixed(2)} < ${floor}`);
  };

  // Text on every surface.
  for (const surface of surfaces) {
    for (const name of [
      '--text',
      '--strong',
      '--muted',
      '--accent',
      '--support',
      '--green',
      '--red',
      '--amber',
      '--status-active',
      '--phase-implement',
    ])
      need(`${name} on ${surface}`, v(name), v(surface), 4.5);
    // Edges, rings and icons.
    need(`--border-strong on ${surface}`, v('--border-strong'), v(surface), 3);
    need(`--accent ring on ${surface}`, v('--accent'), v(surface), 3);
    need(`--support ring on ${surface}`, v('--support'), v(surface), 3);
  }

  // Muted text on the card hover and approved tints (e2e pins >= 4.5 for the approved card).
  need('--muted on panel2 + green 13%', v('--muted'), mix(v('--green'), v('--panel2'), 0.13), 4.5);
  need('--muted on panel2 + accent 8%', v('--muted'), mix(v('--accent'), v('--panel2'), 0.08), 4.5);

  // Tinted chips: Claude chip and danger hover.
  need(
    '--support on panel2 + support 20%',
    v('--support'),
    mix(v('--support'), v('--panel2'), 0.2),
    4.5,
  );
  need(
    '--red on panel2 + red 12% (danger hover)',
    v('--red'),
    mix(v('--red'), v('--panel2'), 0.12),
    4.5,
  );
  need(
    '--red on panel2 + red 10% (state pill)',
    v('--red'),
    mix(v('--red'), v('--panel2'), 0.1),
    4.5,
  );

  // Labels on fills.
  for (const fill of ['--accent-fill', '--accent', '--amber', '--support'])
    need(`--bg label on ${fill}`, v('--bg'), v(fill), 4.5);

  // The danger border (red 60% over --border-strong) is a component edge.
  const dangerBorder = mix(v('--red'), v('--border-strong'), 0.6);
  for (const surface of surfaces) need(`danger border on ${surface}`, dangerBorder, v(surface), 3);

  assert.deepEqual(failures, []);
});

test('no stylesheet but tokens.css writes a hex colour', () => {
  const allowed = new Set(['styles/tokens.css', 'styles/mascots.css', 'styles/posters.css']);
  const offenders = [];
  for (const file of sheets()) {
    if (allowed.has(file)) continue;
    const hits = stripComments(read(file)).match(/#[0-9a-fA-F]{3,8}\b/g);
    if (hits) offenders.push(`${file}: ${[...new Set(hits)].join(' ')}`);
  }
  assert.deepEqual(offenders, []);
});

test('cyan only for interaction: keys, status kind and the page wash do not read --accent', () => {
  const prs = read('styles/prs.css');
  const myTickets = read('styles/my-tickets.css');
  const home = read('styles/home.css');
  const styles = read('styles.css');

  const reads = (body, name) => new RegExp(`var\\(${name}\\b`).test(body);

  // Ticket keys are bright neutral.
  assert.match(bodiesFor(prs, '.jira-link'), /color:\s*var\(--strong\)/);
  assert.match(bodiesFor(prs, '.review-ticket-key'), /color:\s*var\(--strong\)/);
  assert.match(bodiesFor(prs, '.review-ticket-assignee-name'), /color:\s*var\(--strong\)/);
  assert.match(bodiesFor(prs, '.jira-link:hover'), /text-decoration:\s*underline/);

  // Kind `active` is its own colour wherever the kind is mapped.
  const kindActive = [
    [myTickets, ".board-column[data-jira-status-kind='active']"],
    [prs, ".ticket-card[data-jira-status-kind='active']"],
    [home, ".action-ticket-meta .pill[data-jira-status-kind='active']"],
  ];
  for (const [css, selector] of kindActive) {
    const body = bodiesFor(css, selector);
    assert.match(body, /--jira-status-color:\s*var\(--status-active\)/, selector);
    assert.ok(!reads(body, '--accent'), `${selector} does not read --accent`);
  }

  // The page wash is neutral.
  const wash = bodiesFor(styles, 'body');
  assert.ok(wash.includes('radial-gradient'), 'body keeps its top wash');
  assert.ok(!reads(wash, '--accent'), 'the body wash does not read --accent');
  assert.match(wash, /color-mix\(in srgb, var\(--strong\) 3%, transparent\)/);
});

test('no readable text under 12px (palette sheets)', () => {
  // posters.css is art; settings.css and releases.css are not restyled; shell.css and base.css have
  // their own guards beside the slices that edit them.
  const skipped = new Set([
    'styles/posters.css',
    'styles/settings.css',
    'styles/releases.css',
    'styles/shell.css',
    'styles/base.css',
  ]);
  const offenders = [];
  for (const file of sheets()) {
    if (skipped.has(file)) continue;
    for (const [, size] of stripComments(read(file)).matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g))
      if (Number(size) < 12) offenders.push(`${file}: ${size}px`);
  }
  assert.deepEqual(offenders, []);
});
