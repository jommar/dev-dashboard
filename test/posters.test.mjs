// The SVG posters (the sign a bot carries with its ticket key): every test loops over POSTERS, so a
// new registry entry is covered with no edit here. Only the first five ids and names are pinned, in
// one separate assertion.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

const repo = fileURLToPath(new URL('../', import.meta.url));
const readUi = (file) => fs.readFileSync(`${repo}ui-react/${file}`, 'utf8');
const KEYS = ['AB-1', 'TAP-1451', 'TRIPS-12345'];

let server;
let POSTERS;
let posterFor;
before(async () => {
  server = await createServer({
    configFile: false,
    root: repo,
    appType: 'custom',
    server: { middlewareMode: true },
    logLevel: 'error',
  });
  ({ POSTERS } = await server.ssrLoadModule('/ui-react/components/posters/index.js'));
  ({ posterFor } = await server.ssrLoadModule('/ui-react/lib/poster-for.js'));
});
after(() => server?.close());

const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));
const withoutComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const classesIn = (markup) =>
  [...markup.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/));
// A poster's namespace is the `poster-<slug>` root class its component renders.
const slugOf = ({ Component }) =>
  render(Component, { text: 'TAP-1' }).match(/^<svg[^>]*class="poster-([a-z0-9]+)[ "]/)?.[1];

// The sheet is one block per poster, each opened by a `/* poster: <slug> ... */` marker.
const blocks = () => {
  const parts = readUi('styles/posters.css').split(/\/\* poster: ([a-z0-9]+)[^\n]*\*\//);
  const found = new Map();
  for (let i = 1; i < parts.length; i += 2) {
    assert.ok(!found.has(parts[i]), `posters.css has one block for ${parts[i]}`);
    found.set(parts[i], parts[i + 1]);
  }
  return found;
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

test('the registry starts with the five original posters, in order', () => {
  assert.deepEqual(
    POSTERS.slice(0, 5).map(({ id, name }) => [id, name]),
    [
      ['paper', 'First Class'],
      ['glow', 'Open Late'],
      ['pixel', 'Pixel Dialog'],
      ['craft', 'Picket Sign'],
      ['wild', 'Next Stop'],
    ],
  );
});

test('registry entries are well formed with unique ids, names and namespaces', () => {
  assert.ok(POSTERS.length > 0);
  for (const entry of POSTERS) {
    assert.match(entry.id, /^[a-z0-9]+$/, `id ${entry.id} is a one-word lowercase slug`);
    assert.ok(entry.name, `${entry.id} has a name`);
    assert.ok(entry.Component, `${entry.id} has a component`);
    assert.equal(slugOf(entry), entry.id, `${entry.id} renders a poster-<id> root class`);
  }
  for (const key of ['id', 'name']) {
    const values = POSTERS.map((entry) => entry[key]);
    assert.equal(new Set(values).size, values.length, `${key}s are unique`);
  }
  const slugs = POSTERS.map(slugOf);
  assert.equal(new Set(slugs).size, slugs.length, `namespaces are unique: ${slugs}`);
});

test('every poster renders a decorative svg with its ticket key and no native tooltip', () => {
  for (const entry of POSTERS) {
    const { id, Component } = entry;
    for (const text of KEYS)
      for (const moving of [false, true, undefined]) {
        const html = render(Component, { text, moving });
        assert.match(html, /^<svg /, `${id} renders only the svg`);
        assert.match(html, /aria-hidden="true"/, `${id} is hidden from assistive tech`);
        assert.match(html, /focusable="false"/, `${id} is not focusable`);
        assert.doesNotMatch(html, /role="img"|aria-label/, `${id} carries no name of its own`);
        // No <title>/<desc> child and no title attribute: the browser would show a native tooltip.
        assert.doesNotMatch(html, /<title|<desc|\stitle=/, `${id} has no native tooltip source`);
        // The key is one <text> node, fitted to the board whatever its length.
        const texts = [...html.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)];
        assert.equal(texts.length, 1, `${id} has one <text>`);
        assert.equal(texts[0][2], text, `${id} shows ${text}`);
        assert.match(texts[0][1], /textLength="[\d.]+"/, `${id} fits ${text} with textLength`);
        assert.match(texts[0][1], /lengthAdjust="spacingAndGlyphs"/);
        const root = html.match(/^<svg[^>]*class="([^"]*)"/)[1].split(/\s+/);
        assert.deepEqual(
          root,
          moving ? [`poster-${id}`, `poster-${id}--moving`] : [`poster-${id}`],
        );
      }
  }
});

test('the key is squeezed to the board when long and not stretched when short', () => {
  for (const entry of POSTERS) {
    const length = (text) =>
      Number(render(entry.Component, { text }).match(/textLength="([\d.]+)"/)[1]);
    const [short, middle, long] = KEYS.map(length);
    assert.ok(short < middle, `${entry.id}: a short key is narrower than a typical one`);
    assert.ok(middle <= long, `${entry.id}: a long key is not narrower than a typical one`);
    assert.ok(long > 0 && long <= 60, `${entry.id}: the key fits a 72px board`);
  }
});

test('the stylesheet has exactly one namespaced block per poster and they share nothing', () => {
  const sheet = blocks();
  assert.deepEqual([...sheet.keys()].sort(), POSTERS.map(slugOf).sort(), 'one block per poster');
  const owners = new Map();
  const claim = (kind, name, slug) => {
    const key = `${kind} ${name}`;
    assert.ok(!owners.has(key), `${key} is used by ${owners.get(key)} and ${slug}`);
    owners.set(key, slug);
  };
  for (const [slug, block] of sheet) {
    const css = withoutComments(block);
    const prefix = `poster-${slug}`;
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
    for (const [, value] of css.matchAll(/animation(?:-name)?\s*:([^;}]+)/g))
      for (const [token] of value.matchAll(new RegExp(`(?<![\\w-])${prefix}-[\\w-]+`, 'g')))
        assert.ok(keyframes.includes(token), `${token} is a keyframe of ${slug}`);
    // The dashboard is dark-only, so there is one palette (the dark one) and no scheme split.
    assert.doesNotMatch(css, /prefers-color-scheme/, `${slug} has no light/dark split`);
    assert.equal(css.match(/:root\s*\{/g)?.length, 1, `${slug} has one :root palette`);
    // Palette hex values live only in :root token blocks; rules read tokens.
    const outsideRoot = css.replace(/:root\s*\{[^}]*\}/g, '');
    assert.doesNotMatch(outsideRoot, /#[0-9a-f]{3,8}\b/i, `${slug} rules read tokens, not hex`);
    assert.doesNotMatch(outsideRoot, /transition/, `${slug} has no transition`);
  }
});

test('a poster sways only while moving and only without a reduced-motion preference', () => {
  const sheet = blocks();
  for (const entry of POSTERS) {
    const slug = slugOf(entry);
    const rules = rulesOf(withoutComments(sheet.get(slug)));
    const animating = rules.filter((rule) => /(?<![\w-])animation(?:-name)?\s*:/.test(rule.body));
    const sway = animating.filter((rule) => rule.context === 'no-preference');
    assert.equal(sway.length, 1, `${slug} has one sway, inside no-preference`);
    assert.match(sway[0].selector, new RegExp(`\\.poster-${slug}--moving `), 'only when moving');
    assert.match(sway[0].body, new RegExp(`animation:\\s*poster-${slug}-sway`));
    // Nothing animates outside it but the reduced-motion block that switches the sway off.
    for (const rule of animating.filter((r) => r.context !== 'no-preference')) {
      assert.equal(
        rule.context,
        'reduce',
        `${slug}: "${rule.selector}" animates outside a media block`,
      );
      assert.match(rule.body, /animation:\s*none/);
    }
    assert.ok(
      animating.some((rule) => rule.context === 'reduce'),
      `${slug} has reduced motion`,
    );
    // Transform only: the keyframes touch nothing else, and the sway is a few degrees.
    const keyframes = withoutComments(sheet.get(slug)).match(/@keyframes[^{]+\{[\s\S]*?\n\}/)[0];
    assert.doesNotMatch(
      keyframes.replace(/animation-timing-function:[^;]+;/g, ''),
      /(?<!-)\b(?:opacity|fill|stroke|width|height|top|left)\s*:/,
    );
    for (const [, degrees] of keyframes.matchAll(/rotate\((-?[\d.]+)deg\)/g))
      assert.ok(Math.abs(Number(degrees)) <= 4, `${slug} sways at most 4 degrees`);
  }
});

test('every class a poster renders is namespaced and styled by its own block', () => {
  const sheet = blocks();
  for (const entry of POSTERS) {
    const slug = slugOf(entry);
    const css = sheet.get(slug);
    const rendered = new Set(classesIn(render(entry.Component, { text: 'TAP-1', moving: true })));
    for (const name of rendered) {
      assert.match(name, new RegExp(`^poster-${slug}(?:-|$)`), `${name} is namespaced`);
      assert.ok(css.includes(`.${name}`), `${name} has a rule in the ${slug} block`);
    }
  }
});

test('the poster sheet is imported once, next to the mascot sheet', () => {
  const root = readUi('styles.css');
  const at = (sheet) => root.search(new RegExp(`@import ['"]\\./styles/${sheet}\\.css['"]`));
  assert.ok(at('posters') > at('mascots'), 'posters.css loads after mascots.css');
  assert.equal(root.match(/styles\/posters\.css/g).length, 1);
});

test('posterFor gives a session one registered poster, the same one every time', () => {
  const ids = new Set();
  for (let i = 0; i < 300; i += 1) {
    const key = `TAP-${2000 + i}:review`;
    const poster = posterFor(key);
    assert.ok(POSTERS.includes(poster));
    assert.equal(posterFor(key), poster);
    ids.add(poster.id);
  }
  assert.equal(ids.size, POSTERS.length, 'every poster is used');
});
