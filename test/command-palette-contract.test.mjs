import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..', 'ui-react');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('command-palette.css loads after board.css and is token-only, short, small-radius and scoped', () => {
  const rootCss = read('styles.css');
  const importAt = (sheet) =>
    rootCss.search(new RegExp(`@import ['"]\\./styles/${sheet}\\.css['"]`));
  assert.ok(importAt('command-palette') > -1, 'styles.css imports command-palette.css');
  assert.ok(importAt('board') < importAt('command-palette'), 'board.css loads first');

  const css = read('styles/command-palette.css');
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, 'colours come from tokens, never a hex literal');
  const declared = new Set(
    [read('styles/tokens.css'), rootCss, css].flatMap((sheet) =>
      [...sheet.matchAll(/(--[\w-]+)\s*:/g)].map(([, name]) => name),
    ),
  );
  for (const [, name] of css.matchAll(/var\((--[\w-]+)/g))
    assert.ok(declared.has(name), `${name} is a declared token`);
  assert.doesNotMatch(css, /(?<![\w-])columns:\s*\d/, 'a palette is not a masonry');
  for (const [, value] of css.matchAll(/transition(?:-duration|-property)?\s*:\s*([^;}]+)/g)) {
    for (const [, amount, unit] of value.matchAll(/(\d*\.?\d+)\s*(ms|s)\b/g)) {
      const ms = unit === 's' ? Number(amount) * 1000 : Number(amount);
      assert.ok(ms <= 200, `transition "${value.trim()}" stays within 200 ms`);
    }
    assert.doesNotMatch(value, /\ball\b/, 'transition names its properties');
  }
  for (const [, value] of css.matchAll(/border-radius\s*:\s*([^;}]+)/g))
    for (const [, px] of value.matchAll(/(\d*\.?\d+)px/g))
      assert.ok(Number(px) <= 12, `border-radius "${value.trim()}" is at most 12 px`);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*(?:reduce|no-preference)\)/);
  const selectors = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)]
    .map(([, selector]) => selector.trim())
    .filter((selector) => !selector.startsWith('@') && !/^(?:from|to|\d)/.test(selector))
    .flatMap((selector) => selector.split(/,(?![^(]*\))/));
  assert.ok(selectors.length > 0, 'the sheet has rules');
  for (const selector of selectors)
    assert.match(selector.trim(), /^\.command-palette\b/, `${selector.trim()} stays scoped`);
});

test('the keyboard layer keeps its seams: palette in BotBar, no native title, one hashFor allow-list', () => {
  const botBar = read('components/BotBar.jsx');
  assert.match(botBar, /<CommandPalette\b/, 'BotBar renders the palette');
  const barStart = botBar.indexOf('className="bot-bar"');
  const barEnd = botBar.indexOf('</div>\n      )}', barStart);
  assert.doesNotMatch(botBar.slice(barStart, barEnd), /CommandPalette/, 'never inside the strip');
  for (const file of ['components/CommandPalette.jsx', 'components/ShortcutsHelp.jsx']) {
    const source = read(file);
    assert.doesNotMatch(source, /<[a-z][\w-]*\b[^<>]*\stitle=/, `${file} has no native title`);
    assert.doesNotMatch(source, /data-tooltip/, `${file} uses the app tooltip`);
  }
  const app = read('App.jsx');
  assert.match(
    app,
    /const QUERY_ROUTES = new Set\(\['releases', 'chat', 'my-tickets'\]\);/,
    'only these routes keep a query',
  );
  assert.match(app, /\{ id: 'home', label: 'Home' \}/, 'READY_TABS rows are unchanged');
  assert.match(
    read('components/AppTabs.jsx'),
    /const PRIMARY_ROUTES = new Set\(\['home', 'my-tickets', 'slack'\]\);/,
    'the primary row stays pinned',
  );
});

test('useModalDialog keeps the latest onClose in a ref so a new callback never reopens the dialog', () => {
  const hook = read('hooks/useModalDialog.js');
  assert.match(hook, /useRef\(onClose\)/, 'onClose is held in a ref');
  assert.doesNotMatch(hook, /\[onClose\]/, 'the effect does not depend on the onClose identity');
});
