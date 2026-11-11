// The Mascots screen: one card per registry entry with four captioned states at two sizes, the
// toolbar's toggles, a roaming preview built from the bot bar's own lane classes, and a sheet that
// keeps to the repo's stylesheet rules. Loops over MASCOTS, so a new entry is covered with no edit.
// A click cannot be made here (no DOM): the toggles' effect is checked by passing their state in,
// and e2e/mascots.spec.js clicks them.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

const repo = fileURLToPath(new URL('../', import.meta.url));
const read = (file) => fs.readFileSync(`${repo}ui-react/${file}`, 'utf8');
const WORDS = ['working', 'idle', 'done', 'failed'];

let server;
let MASCOTS;
let POSTERS;
let PosterGallery;
let MascotGallery;
let RoamingPreview;
let MascotsPanel;
let mascotFor;
before(async () => {
  server = await createServer({
    configFile: false,
    root: repo,
    appType: 'custom',
    server: { middlewareMode: true },
    logLevel: 'error',
  });
  ({ MASCOTS } = await server.ssrLoadModule('/ui-react/components/mascots/index.js'));
  ({ POSTERS } = await server.ssrLoadModule('/ui-react/components/posters/index.js'));
  ({ MascotGallery, PosterGallery, RoamingPreview } = await server.ssrLoadModule(
    '/ui-react/components/MascotGallery.jsx',
  ));
  ({ MascotsPanel } = await server.ssrLoadModule('/ui-react/panels/MascotsPanel.jsx'));
  ({ mascotFor } = await server.ssrLoadModule('/ui-react/lib/mascot-for.js'));
});
after(() => server?.close());

const html = (component, props) => renderToStaticMarkup(createElement(component, props));
const cardOf = (markup, id) =>
  markup.match(new RegExp(`<li[^>]*data-testid="mascot-card-${id}"[\\s\\S]*?</li>`))?.[0];

test('the gallery has one card per registered mascot, with four captioned states at two sizes', () => {
  const markup = html(MascotGallery, { facing: 'right', moving: false });
  assert.equal(markup.match(/data-testid="mascot-card-/g).length, MASCOTS.length);
  for (const { id, name } of MASCOTS) {
    const card = cardOf(markup, id);
    assert.ok(card, `${id} has a card`);
    assert.ok(card.includes(`>${name}</h3>`), `${id} card names ${name}`);
    assert.ok(
      card.includes(`<code class="mascots-card-id">${id}</code>`),
      `${id} card shows its id`,
    );
    for (const size of ['bar', 'large']) {
      const captions = [
        ...card.matchAll(
          new RegExp(
            `data-testid="mascot-figure-${id}-${size}-[a-z]+"[\\s\\S]*?<figcaption>([^<]+)</figcaption>`,
            'g',
          ),
        ),
      ].map((match) => match[1]);
      assert.deepEqual(captions, WORDS, `${id} ${size} shows the four states, waiting as idle`);
    }
    assert.equal(card.match(/<svg /g).length, 8, `${id} draws eight pictures`);
    assert.doesNotMatch(card, /figcaption>waiting</, 'waiting is never printed, only idle');
    assert.ok(card.includes(`aria-label="${name}: idle"`), `${id} idle picture is named`);
  }
  assert.ok(markup.includes('aria-label="Registered mascots"'));
});

test('the facing and moving toggles reach every picture', () => {
  for (const facing of ['left', 'right']) {
    const markup = html(MascotGallery, { facing, moving: false });
    const roots = [...markup.matchAll(/<svg[^>]*class="([^"]*)"/g)].map((match) => match[1]);
    assert.equal(roots.length, MASCOTS.length * 8);
    for (const root of roots) {
      assert.match(root, new RegExp(`--${facing}(?:\\s|$)`), root);
      assert.doesNotMatch(root, new RegExp(`--${facing === 'left' ? 'right' : 'left'}(?:\\s|$)`));
    }
  }
  const still = html(MascotGallery, { facing: 'right', moving: false });
  const walking = html(MascotGallery, { facing: 'right', moving: true });
  assert.notEqual(walking, still, 'moving changes what a mascot that supports it renders');
});

test('a typed session key marks the card of the mascot it hashes to', () => {
  const picked = mascotFor('TAP-1234:implement');
  assert.ok(MASCOTS.some(({ id }) => id === picked.id));
  const markup = html(MascotGallery, { facing: 'right', moving: false, pickedId: picked.id });
  assert.equal(markup.match(/data-picked="true"/g).length, 1);
  assert.match(cardOf(markup, picked.id), /data-picked="true"[\s\S]*Picked/);
  assert.doesNotMatch(html(MascotGallery, { facing: 'right', moving: false }), /data-picked/);
});

test('the roaming preview reuses the bot bar lanes and shows every mascot', () => {
  const markup = html(RoamingPreview, {});
  const lanes = [...markup.matchAll(/<div class="bot-bar-lane"[^>]*>/g)].map((match) => match[0]);
  assert.ok(lanes.length >= MASCOTS.length);
  for (const lane of lanes)
    for (const property of ['--bot-from', '--bot-range', '--bot-dur', '--bot-phase', '--bot-rest'])
      assert.ok(lane.includes(`${property}:`), `${property} is set on ${lane}`);
  for (const { id } of MASCOTS) assert.ok(markup.includes(`mascots-roam-${id}-working`));
  const states = new Set([...markup.matchAll(/data-state="([a-z]+)"/g)].map((match) => match[1]));
  assert.ok(
    ['working', 'done'].every((state) => states.has(state)),
    [...states].join(),
  );
  assert.match(markup, /class="bot-bar-face mascots-roam-bot"/);
});

test('the panel is a board screen with the registry count, toolbar controls and no data loading', () => {
  const markup = html(MascotsPanel, { active: true });
  assert.match(
    markup,
    /id="panel-mascots"[^>]*class="panel board-panel"|class="panel board-panel"[^>]*id="panel-mascots"/,
  );
  assert.match(markup, /<h2[^>]*data-testid="mascots-title">Mascots<\/h2>/);
  assert.match(
    markup,
    new RegExp(`data-testid="mascots-sub">${MASCOTS.length} mascots registered<`),
  );
  assert.match(markup, /class="board-pane mascots-pane"/);
  for (const id of [
    'mascots-facing-left',
    'mascots-facing-right',
    'mascots-moving',
    'mascots-replay',
  ])
    assert.ok(markup.includes(`data-testid="${id}"`), id);
  assert.match(
    markup,
    /data-testid="mascots-facing-right"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-testid="mascots-facing-right"/,
  );
  assert.match(
    markup,
    /data-testid="mascots-moving"[^>]*aria-pressed="false"|aria-pressed="false"[^>]*data-testid="mascots-moving"/,
  );
  assert.equal(markup.match(/data-testid="mascot-card-/g).length, MASCOTS.length);
  assert.match(html(MascotsPanel, { active: false }), /hidden=""/);
  const source = read('panels/MascotsPanel.jsx') + read('components/MascotGallery.jsx');
  assert.doesNotMatch(
    source,
    /useActivePolling|useEffect|setInterval|setTimeout|fetch\(|EventSource|lib\/api/,
  );
});

test('the posters section has one card per registered poster, still and swaying', () => {
  const markup = html(PosterGallery, {});
  assert.equal(markup.match(/data-testid="poster-card-/g).length, POSTERS.length);
  for (const { id, name } of POSTERS) {
    const card = markup.match(
      new RegExp(`<li[^>]*data-testid="poster-card-${id}"[\\s\\S]*?</li>`),
    )?.[0];
    assert.ok(card, `${id} has a card`);
    assert.ok(card.includes(`>${name}</h3>`), `${id} card names ${name}`);
    assert.ok(card.includes(`<code class="mascots-card-id">${id}</code>`), `${id} shows its id`);
    // Still and swaying, at two sizes, plus the shortest and the longest key.
    for (const size of ['bar', 'large'])
      for (const mode of ['still', 'swaying'])
        assert.ok(card.includes(`data-testid="poster-figure-${id}-${size}-${mode}"`), mode);
    assert.equal(card.match(/<svg /g).length, 6);
    assert.equal(
      card.match(new RegExp(`class="poster-${id} poster-${id}--moving"`, 'g')).length,
      2,
    );
    assert.ok(card.includes('>AB-1</text>') && card.includes('>TRIPS-12345</text>'));
    assert.doesNotMatch(card, /<title|<desc|\stitle=/, 'no native tooltip source');
  }
  assert.ok(markup.includes('aria-label="Registered posters"'));
  const panel = html(MascotsPanel, { active: true });
  assert.match(
    panel,
    new RegExp(`data-testid="posters-sub">${POSTERS.length} posters registered<`),
  );
  assert.equal(panel.match(/data-testid="poster-card-/g).length, POSTERS.length);
});

test('every bot of the roaming preview carries a poster, outside its mirrored face', () => {
  const markup = html(RoamingPreview, {});
  const lanes = markup.split('<div class="bot-bar-lane"').slice(1);
  assert.ok(lanes.length >= MASCOTS.length);
  for (const lane of lanes) {
    assert.equal(lane.match(/class="bot-bar-poster"/g).length, 1, 'one poster per bot');
    assert.ok(
      lane.indexOf('class="bot-bar-poster"') < lane.indexOf('class="bot-bar-face'),
      'the poster is a sibling before the face, never inside it',
    );
    assert.match(lane, /class="bot-bar-poster" aria-hidden="true"/);
    assert.match(lane, />TAP-\d+<\/text>/);
  }
});

test('the tab is registered after DevTools, with a nav icon', () => {
  const app = read('App.jsx');
  const ids = [...app.matchAll(/\{ id: '([\w-]+)', label:/g)].map((match) => match[1]);
  assert.equal(ids.indexOf('mascots'), ids.indexOf('devtools') + 1);
  assert.match(app, /<MascotsPanel active=\{active === 'mascots'\} \/>/);
  assert.match(read('components/NavIcon.jsx'), /^\s*mascots:/m);
});

test('the sheet loads after the board, mascot and bot bar sheets, and keeps to the stylesheet rules', () => {
  const root = read('styles.css');
  const at = (sheet) => root.search(new RegExp(`@import ['"]\\./styles/${sheet}\\.css['"]`));
  for (const before of ['board', 'mascots', 'bot-bar'])
    assert.ok(at('mascots-page') > at(before), `after ${before}.css`);
  assert.equal(root.match(/styles\/mascots-page\.css/g).length, 1);

  const css = read('styles/mascots-page.css');
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, 'colours come from tokens, never a hex literal');
  assert.doesNotMatch(css, /(?<![\w-])columns:\s*\d/, 'the cards are a uniform grid, not masonry');
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // The recurring bug of this repo: a `display: grid` with no column rule is one column forever.
  for (const [, selector, body] of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g))
    if (/display:\s*grid/.test(body))
      assert.match(body, /grid-template-columns:/, `${selector.trim()} names its columns`);
  const grid = bare.match(/\.mascots-grid\s*\{([^}]*)\}/)[1];
  assert.match(grid, /grid-template-columns:\s*minmax\(0, 1fr\)/);
  for (const [width, count] of [
    [760, 2],
    [1700, 3],
  ])
    assert.match(
      bare,
      new RegExp(
        `@media\\s*\\(min-width:\\s*${width}px\\)[\\s\\S]*?\\.mascots-grid\\s*\\{[^}]*grid-template-columns:\\s*repeat\\(${count}, minmax\\(0, 1fr\\)\\)`,
      ),
    );
  for (const [, value] of css.matchAll(/transition(?:-duration|-property)?\s*:\s*([^;}]+)/g)) {
    for (const [, amount, unit] of value.matchAll(/(\d*\.?\d+)\s*(ms|s)\b/g))
      assert.ok((unit === 's' ? amount * 1000 : Number(amount)) <= 200, `${value.trim()} <= 200ms`);
    assert.doesNotMatch(value, /\ball\b/, 'transition names its properties');
  }
  for (const [, value] of css.matchAll(/border-radius\s*:\s*([^;}]+)/g))
    for (const [, px] of value.matchAll(/(\d*\.?\d+)px/g))
      assert.ok(Number(px) <= 12, `border-radius "${value.trim()}" is at most 12 px`);
  // No height of its own: viewport fill belongs to the shared board shell.
  assert.doesNotMatch(css, /(?:height|min-height):\s*calc\([^;]*100(?:d?vh)/);
  const selectors = [...bare.matchAll(/([^{}]+)\{/g)]
    .map(([, selector]) => selector.trim())
    .filter((selector) => !selector.startsWith('@'))
    .flatMap((selector) => selector.split(','));
  for (const selector of selectors)
    assert.match(selector.trim(), /^\.mascots\b/, `${selector.trim()} stays Mascots-scoped`);
});
