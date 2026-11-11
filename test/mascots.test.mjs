// The SVG mascots: every test loops over MASCOTS, so a new registry entry is covered with no edit
// here. Only the initial order of the first five is pinned, in one separate assertion.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

const repo = fileURLToPath(new URL('../', import.meta.url));
const readUi = (file) => fs.readFileSync(`${repo}ui-react/${file}`, 'utf8');
const STATES = ['working', 'waiting', 'done', 'failed'];
const FACINGS = ['left', 'right'];

let server;
let MASCOTS;
before(async () => {
  server = await createServer({
    configFile: false,
    root: repo,
    appType: 'custom',
    server: { middlewareMode: true },
    logLevel: 'error',
  });
  ({ MASCOTS } = await server.ssrLoadModule('/ui-react/components/mascots/index.js'));
});
after(() => server?.close());

const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));
const withoutComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const classesIn = (markup) =>
  [...markup.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/));
// A mascot's namespace is the `bot-<slug>` root class its component renders.
const slugOf = ({ Component }) =>
  render(Component, { state: 'working' }).match(/^<svg[^>]*class="bot-([a-z0-9]+)[ "]/)?.[1];

// The sheet is one block per mascot, each opened by a `/* mascot: <slug> ... */` marker.
const blocks = () => {
  const parts = readUi('styles/mascots.css').split(/\/\* mascot: ([a-z0-9]+)[^\n]*\*\//);
  const found = new Map();
  for (let i = 1; i < parts.length; i += 2) {
    assert.ok(!found.has(parts[i]), `mascots.css has one block for ${parts[i]}`);
    found.set(parts[i], parts[i + 1]);
  }
  return found;
};

test('the registry starts with the five original mascots, in order', () => {
  assert.deepEqual(
    MASCOTS.slice(0, 5).map(({ id, name }) => [id, name]),
    [
      ['dux', 'Dux'],
      ['wick', 'Wick'],
      ['glim', 'Glim'],
      ['pinch', 'Pinch'],
      ['pinch-crab', 'Pinch (screen)'],
    ],
  );
});

test('registry entries are well formed with unique ids, names and namespaces', () => {
  assert.ok(MASCOTS.length > 0);
  for (const entry of MASCOTS) {
    assert.match(entry.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `id ${entry.id} is a lowercase slug`);
    assert.ok(entry.name, `${entry.id} has a name`);
    assert.ok(entry.Component, `${entry.id} has a component`);
    assert.ok(slugOf(entry), `${entry.id} renders a bot-<slug> root class`);
  }
  for (const key of ['id', 'name']) {
    const values = MASCOTS.map((entry) => entry[key]);
    assert.equal(new Set(values).size, values.length, `${key}s are unique`);
  }
  // One-word slugs, so no namespace can be a hyphenated prefix of another (bot-pinch vs bot-pinch-x).
  const slugs = MASCOTS.map(slugOf);
  assert.equal(new Set(slugs).size, slugs.length, `namespaces are unique: ${slugs}`);
});

test('every mascot renders each state and facing as a named image with no native tooltip', () => {
  for (const entry of MASCOTS) {
    const { id, Component } = entry;
    const slug = slugOf(entry);
    for (const state of STATES)
      for (const facing of FACINGS) {
        const html = render(Component, { state, facing });
        const pose = state === 'waiting' ? 'idle' : state;
        assert.match(html, /^<svg /, `${id} renders only the svg`);
        assert.match(html, /role="img"/, `${id} ${state} is an image`);
        const name = html.match(/aria-label="([^"]+)"/)?.[1];
        assert.ok(name, `${id} ${state} has an accessible name`);
        // No <title>/<desc> child and no title attribute: the browser would show them as a native tooltip.
        assert.doesNotMatch(
          html,
          /<title|<desc|\stitle=/,
          `${id} ${state} has no native tooltip source`,
        );
        assert.ok(name.includes(state), `${id} default label names the state: ${name}`);
        const root = html.match(/^<svg[^>]*class="([^"]*)"/)[1].split(/\s+/);
        assert.deepEqual(root.slice(0, 3), [
          `bot-${slug}`,
          `bot-${slug}--${pose}`,
          `bot-${slug}--${facing}`,
        ]);
      }
    assert.match(
      render(Component, { state: 'done', label: 'Custom name' }),
      /aria-label="Custom name"/,
    );
    assert.match(render(Component, { state: 'done' }), /--right/, `${id} faces right by default`);
  }
});

test('the stylesheet has exactly one namespaced block per mascot and they share nothing', () => {
  const sheet = blocks();
  assert.deepEqual([...sheet.keys()].sort(), MASCOTS.map(slugOf).sort(), 'one block per mascot');
  const owners = new Map();
  const claim = (kind, name, slug) => {
    const key = `${kind} ${name}`;
    assert.ok(!owners.has(key), `${key} is used by ${owners.get(key)} and ${slug}`);
    owners.set(key, slug);
  };
  for (const [slug, block] of sheet) {
    const css = withoutComments(block);
    const prefix = `bot-${slug}`;
    const selectors = [...css.matchAll(/([^{}]+)\{/g)]
      .map((m) => m[1].trim())
      .filter((s) => !s.startsWith('@'));
    for (const name of new Set(
      [...selectors.join(',').matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]),
    )) {
      assert.match(name, new RegExp(`^${prefix}(?:-|$)`), `.${name} is namespaced ${prefix}`);
      claim('class', name, slug);
    }
    const keyframes = [...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]);
    assert.ok(keyframes.length > 0, `${slug} has keyframes`);
    for (const name of keyframes) {
      assert.match(name, new RegExp(`^${prefix}-`), `@keyframes ${name} is namespaced`);
      claim('keyframes', name, slug);
    }
    for (const name of new Set([...css.matchAll(/(?<![\w-])(--[\w-]+)\s*:/g)].map((m) => m[1]))) {
      assert.match(name, new RegExp(`^--${prefix}-`), `${name} is namespaced`);
      claim('property', name, slug);
    }
    // Animation names all resolve to a keyframe of the same block.
    for (const [, value] of css.matchAll(/animation(?:-name)?\s*:([^;}]+)/g))
      for (const [token] of value.matchAll(new RegExp(`(?<![\\w-])${prefix}-[\\w-]+`, 'g')))
        assert.ok(keyframes.includes(token), `${token} is a keyframe of ${slug}`);
    // The dashboard is dark-only, so there is one palette (the dark one) and no scheme split.
    assert.doesNotMatch(css, /prefers-color-scheme/, `${slug} has no light/dark split`);
    assert.equal(css.match(/:root\s*\{/g)?.length, 1, `${slug} has one :root palette`);
    assert.match(
      css,
      /@media\s*\(prefers-reduced-motion:\s*reduce\)/,
      `${slug} has reduced motion`,
    );
    // Palette hex values live only in :root token blocks; rules read tokens.
    const outsideRoot = css.replace(/:root\s*\{[^}]*\}/g, '');
    assert.doesNotMatch(outsideRoot, /#[0-9a-f]{3,8}\b/i, `${slug} rules read tokens, not hex`);
  }
});

test('every class a mascot renders is namespaced and styled by its own block', () => {
  const sheet = blocks();
  for (const entry of MASCOTS) {
    const slug = slugOf(entry);
    const css = sheet.get(slug);
    const rendered = new Set(
      STATES.flatMap((state) =>
        FACINGS.flatMap((facing) =>
          classesIn(render(entry.Component, { state, facing, moving: true })),
        ),
      ),
    );
    for (const name of rendered) {
      assert.match(name, new RegExp(`^bot-${slug}(?:-|$)`), `${name} is namespaced`);
      if (/--(?:left|right|moving|walk)$/.test(name) && !css.includes(`.${name}`)) continue; // optional hooks
      assert.ok(css.includes(`.${name}`), `${name} has a rule in the ${slug} block`);
    }
  }
});

test('the mascot sheet is imported once, after the shared board sheet', () => {
  const root = readUi('styles.css');
  const at = (sheet) => root.search(new RegExp(`@import ['"]\\./styles/${sheet}\\.css['"]`));
  assert.ok(at('mascots') > at('board'), 'mascots.css loads after board.css');
  assert.equal(root.match(/styles\/mascots\.css/g).length, 1);
});

// ---- hover / focus reactions -------------------------------------------------------------------

const STATE_NAMES = ['working', 'idle', 'done', 'failed'];
const REACTS = /:hover|:focus-visible/;

// Splits a selector list on its top-level commas (`:is(a, b)` stays whole).
const splitList = (selector) => {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of selector) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else current += ch;
  }
  return [...parts, current.trim()].filter(Boolean);
};

// Every style rule of a block with the media context it sits in: 'none', 'no-preference' or 'reduce'.
const rulesOf = (css, context = 'none') => {
  const rules = [];
  let at = 0;
  while (at < css.length) {
    const open = css.indexOf('{', at);
    if (open < 0) break;
    let depth = 1;
    let close = open + 1;
    for (; depth > 0 && close < css.length; close += 1) {
      if (css[close] === '{') depth += 1;
      if (css[close] === '}') depth -= 1;
    }
    const head = css.slice(at, open).trim();
    const body = css.slice(open + 1, close - 1);
    if (head.startsWith('@media')) {
      const next = /no-preference/.test(head)
        ? 'no-preference'
        : /reduce/.test(head)
          ? 'reduce'
          : 'none';
      rules.push(...rulesOf(body, next));
    } else if (!head.startsWith('@')) rules.push({ context, selector: head, body });
    at = close;
  }
  return rules;
};
const declarations = (body) =>
  body
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => d.slice(0, d.indexOf(':')).trim());
const withoutNot = (selector) => selector.replace(/:not\([^)]*\)/g, '');
const statesIn = (selector) =>
  new Set(STATE_NAMES.filter((state) => new RegExp(`--${state}(?![\\w-])`).test(selector)));
const targetClass = (selector) => {
  const stripped = withoutNot(selector).replace(/:is\([^)]*\)/g, '');
  return [...stripped.matchAll(/\.([\w-]+)/g)].pop()?.[1];
};
// The states a rule applies in: those it names (minus any :not), or all four when it names none.
const appliesIn = (selector) => {
  const named = statesIn(withoutNot(selector));
  const excluded = statesIn([...selector.matchAll(/:not\(([^)]*)\)/g)].map((m) => m[1]).join(' '));
  return new Set((named.size ? [...named] : STATE_NAMES).filter((state) => !excluded.has(state)));
};
const animates = (body) => declarations(body).some((name) => /^animation(-name)?$/.test(name));
// True when the rule's animation names a keyframe (a bare timing such as `1.8s ease-out` plays nothing).
const namesKeyframe = (body, keyframes) =>
  keyframes.some((name) =>
    new RegExp(`animation(?:-name)?\\s*:[^;}]*(?<![\\w-])${name}(?![\\w-])`).test(body),
  );

test('every mascot reacts to hover and focus, with a still cue under reduced motion', () => {
  const sheet = blocks();
  for (const entry of MASCOTS) {
    const slug = slugOf(entry);
    const rules = rulesOf(withoutComments(sheet.get(slug)));
    const reacting = rules.filter((rule) => REACTS.test(rule.selector));
    const motion = reacting.filter((rule) => rule.context === 'no-preference');
    assert.ok(
      motion.some((rule) => /:hover/.test(rule.selector) && /:focus-visible/.test(rule.selector)),
      `${slug} reacts to :hover and :focus-visible inside prefers-reduced-motion: no-preference`,
    );
    // Outside no-preference a reaction may only be a still cue: opacity or filter, nothing that moves.
    const still = reacting.filter((rule) => rule.context !== 'no-preference');
    assert.ok(still.length > 0, `${slug} has a hover cue that survives reduced motion`);
    for (const rule of still)
      for (const name of declarations(rule.body))
        assert.ok(
          ['opacity', 'filter'].includes(name),
          `${slug}: "${rule.selector}" is outside no-preference, so it may not set ${name}`,
        );
  }
});

test('a hover animation never replaces the animation a state runs on the same group', () => {
  const sheet = blocks();
  for (const entry of MASCOTS) {
    const slug = slugOf(entry);
    const css = withoutComments(sheet.get(slug));
    const keyframes = [...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]);
    const rules = rulesOf(css);
    // group class -> states in which a non-hover rule animates it
    const running = new Map();
    for (const rule of rules.filter(
      (r) => !REACTS.test(r.selector) && namesKeyframe(r.body, keyframes),
    ))
      for (const selector of splitList(rule.selector)) {
        const group = targetClass(selector);
        const states = running.get(group) ?? new Set();
        for (const state of appliesIn(selector)) states.add(state);
        running.set(group, states);
      }
    for (const rule of rules.filter((r) => REACTS.test(r.selector) && animates(r.body)))
      for (const selector of splitList(rule.selector)) {
        const group = targetClass(selector);
        const clash = [...appliesIn(selector)].filter((state) => running.get(group)?.has(state));
        assert.deepEqual(
          clash,
          [],
          `${slug}: hover "${selector}" would replace the ${group} state animation`,
        );
      }
  }
});
