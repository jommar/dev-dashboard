import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Source guards for the Slack activity drawer's frame, wiring, laziness and stylesheets (plan items
// 19, 20, 21 and 22). The behaviour itself is held by e2e/slack-feed-drawer.spec.js.
const root = path.join(import.meta.dirname, '..', 'ui-react');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const exists = (file) => fs.existsSync(path.join(root, file));
// Every source file under ui-react/, as [relative path, text].
const sources = () => {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (/\.(jsx?|mjs)$/.test(entry.name)) out.push([rel, read(rel)]);
    }
  };
  walk('.');
  return out;
};
// What a component must never use: a native title, the app tooltip or a described child.
const NO_TOOLTIP =
  /<(?:button|div|span|aside|header|svg|a)\b[^>]*\stitle=|DashboardTooltip|describeChild/;

test('EdgeDrawer is the one frame: ids derive from name, Escape keeps its two guards, no tooltip', () => {
  assert.ok(exists('components/EdgeDrawer.jsx'), 'components/EdgeDrawer.jsx exists');
  const frame = read('components/EdgeDrawer.jsx');
  assert.match(frame, /export (?:function|const) EdgeDrawer\b/);
  for (const part of ['tab', 'drawer', 'close'])
    assert.ok(frame.includes(`\${name}-${part}`), `\${name}-${part} is derived from the name prop`);
  assert.match(frame, /dialog\[open\]/, 'a modal dialog over the drawer keeps Escape');
  assert.match(frame, /defaultPrevented/, 'a handled Escape does not close the drawer');
  assert.match(frame, /data-edge-tab/);
  assert.match(frame, /data-edge-drawer/);
  assert.match(frame, /data-edge-head/);
  assert.doesNotMatch(frame, NO_TOOLTIP);
});

test('Sessions renders through EdgeDrawer and keeps everything that is not frame', () => {
  const sessions = read('components/SessionsDrawer.jsx');
  assert.match(sessions, /from '\.\/EdgeDrawer\.jsx'/);
  assert.match(sessions, /<EdgeDrawer\b[\s\S]{0,400}?name="sessions"/);
  assert.match(sessions, /slot="upper"/);
  assert.match(sessions, /useSessionsUsage\(/);
  assert.match(sessions, /Close session list/);
  // The frame owns the tab and the aside now: Sessions no longer spells them.
  assert.doesNotMatch(sessions, /className="sessions-tab"/);
  assert.doesNotMatch(sessions, /className="sessions-drawer"/);
});

test('BotBar holds one activeDrawer, takes no props and mounts the Slack drawer after Sessions', () => {
  const bar = read('components/BotBar.jsx');
  assert.doesNotMatch(bar, /drawerOpen|setDrawerOpen/, 'the boolean is gone');
  assert.match(bar, /activeDrawer/);
  assert.match(bar, /'slack-feed'/);
  assert.match(bar, /export function BotBar\(\)/, 'BotBar takes no props');
  const sessionsAt = bar.indexOf('<SessionsDrawer');
  const slackAt = bar.indexOf('<SlackDrawer');
  assert.ok(sessionsAt > -1 && slackAt > sessionsAt, '<SlackDrawer> follows <SessionsDrawer>');
  assert.match(bar, /import \{ SlackDrawer \} from '\.\/SlackDrawer\.jsx'/);
  // Opening a chat from a row or bot shuts whichever drawer is open.
  assert.match(bar, /setActiveDrawer\(null\)/);
});

test('SlackDrawer is a tiny eager tab: lower slot, mentions-only count, lazy body behind ChunkBoundary', () => {
  assert.ok(exists('components/SlackDrawer.jsx'), 'components/SlackDrawer.jsx exists');
  const drawer = read('components/SlackDrawer.jsx');
  assert.match(drawer, /<EdgeDrawer\b[\s\S]{0,400}?name="slack-feed"/);
  assert.match(drawer, /slot="lower"/);
  assert.match(drawer, /Slack activity/);
  assert.match(drawer, /Close Slack activity/);
  assert.match(drawer, /useSlackPending/);
  assert.match(drawer, /activityMentions/, 'the count is the mentions-only field');
  assert.match(drawer, /99\+/);
  assert.match(drawer, /loadSlackFeedPanel/, 'the body loads before the drawer opens');
  assert.match(drawer, /ChunkBoundary/);
  assert.match(drawer, /slack-feed-load-failed/);
  assert.match(drawer, /Slack activity could not load\. Reload the page\./);
  assert.doesNotMatch(drawer, NO_TOOLTIP);
  assert.doesNotMatch(drawer, /import[^;]*SlackFeedPanel[^;]*from '\.\/SlackFeedPanel\.jsx'/);
});

test('only lazy-overlays.js imports SlackFeedPanel, as a dynamic import with a load/Overlay pair', () => {
  assert.ok(exists('components/SlackFeedPanel.jsx'), 'components/SlackFeedPanel.jsx exists');
  const overlays = read('lib/lazy-overlays.js');
  assert.match(overlays, /export const \[loadSlackFeedPanel, SlackFeedPanel\] = lazyOverlay\(/);
  assert.match(overlays, /import\('\.\.\/components\/SlackFeedPanel\.jsx'\)/);
  for (const [file, text] of sources()) {
    if (file === 'lib/lazy-overlays.js' || file === 'components/SlackFeedPanel.jsx') continue;
    assert.doesNotMatch(
      text,
      /SlackFeedPanel\.jsx/,
      `${file} must reach SlackFeedPanel only through lib/lazy-overlays.js`,
    );
  }
});

test('the feed panel reads on open and Refresh only: no timer, no polling hook', () => {
  const panel = read('components/SlackFeedPanel.jsx');
  assert.match(panel, /getSlackFeed/);
  assert.match(panel, /BoardTabs/);
  assert.doesNotMatch(panel, /setInterval|setTimeout|useActivePolling|useSlackPending/);
  assert.doesNotMatch(panel, /getSlackThreads|getSlackThread\b|getSlackPending/);
  // A row is a plain link out to Slack, never the thread dialog.
  assert.match(panel, /target="_blank"/);
  assert.match(panel, /rel="noopener noreferrer"/);
  assert.doesNotMatch(panel, /SlackThreadDialog|useSlackThreadDialog|kind="error"/);
});

test('api.js holds the /api/slack/feed literal once and degrades every failure to unavailable', () => {
  const api = read('lib/api.js');
  assert.equal(api.split('/api/slack/feed').length - 1, 1, 'the route literal appears once');
  assert.match(api, /export (?:async )?function getSlackFeed\b|export const getSlackFeed\b/);
  assert.match(api, /available: false, reason: 'unavailable'/);
});

test('useSlackPending is one shared store: same exports, delay from pendingDelay', () => {
  const hook = read('hooks/useSlackPending.js');
  assert.match(hook, /export function useSlackPending\b/);
  assert.match(hook, /export function notifySlackSessionChanged\b/);
  assert.match(hook, /pendingDelay/);
  assert.match(hook, /slack-session-changed/);
  assert.match(hook, /document\.hidden/);
  assert.doesNotMatch(hook, /setInterval/, 'the next tick is scheduled from the answer');
});

// The declarations of the stylesheets, not just their text.
const rules = (css) =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
    ([, selector, body]) => ({ selector: selector.trim(), body }),
  );

test('edge-drawer.css and slack-feed.css are imported in order and hold the stylesheet contracts', () => {
  assert.ok(exists('styles/edge-drawer.css'), 'styles/edge-drawer.css exists');
  assert.ok(exists('styles/slack-feed.css'), 'styles/slack-feed.css exists');
  const rootCss = read('styles.css');
  const importAt = (sheet) =>
    rootCss.search(new RegExp(`@import ['"]\\./styles/${sheet}\\.css['"]`));
  assert.ok(importAt('edge-drawer') > -1 && importAt('slack-feed') > -1, 'both are imported');
  assert.ok(
    importAt('edge-drawer') < importAt('sessions-drawer'),
    'the frame loads before Sessions',
  );
  assert.ok(importAt('edge-drawer') < importAt('slack-feed'), 'the frame loads before Slack');

  const tokens = read('styles/tokens.css');
  assert.match(tokens, /--edge-tab-length:\s*128px/, 'the narrow tab length is one token');

  const declared = new Set(
    [
      tokens,
      rootCss,
      ...fs.readdirSync(path.join(root, 'styles')).map((f) => read(`styles/${f}`)),
    ].flatMap((sheet) => [...sheet.matchAll(/(--[\w-]+)\s*:/g)].map(([, name]) => name)),
  );
  for (const file of ['styles/edge-drawer.css', 'styles/slack-feed.css']) {
    const css = read(file);
    assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, `${file}: colours come from tokens`);
    assert.doesNotMatch(css, /(?<![\w-])columns:\s*\d/, `${file}: a drawer is not a masonry`);
    for (const [, name, fallback] of css.matchAll(/var\((--[\w-]+)\s*(,)?/g))
      assert.ok(
        declared.has(name) || name.startsWith('--bot-') || fallback,
        `${file} reads ${name}, which nothing declares`,
      );
    for (const [, size] of css.matchAll(/font-size\s*:\s*(\d*\.?\d+)px/g))
      assert.ok(Number(size) >= 12, `${file}: text is at least 12px`);
    let transitions = 0;
    for (const [, value] of css.matchAll(/transition(?:-duration|-property)?\s*:\s*([^;}]+)/g)) {
      transitions += 1;
      for (const [, amount, unit] of value.matchAll(/(\d*\.?\d+)\s*(ms|s)\b/g))
        assert.ok(
          (unit === 's' ? Number(amount) * 1000 : Number(amount)) <= 200,
          `${file}: "${value.trim()}" stays within 200 ms`,
        );
      assert.doesNotMatch(value, /\ball\b/, `${file}: a transition names its properties`);
    }
    if (transitions)
      assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/, `${file}: reduced motion`);
  }
});

test('edge-drawer.css owns the frame on data-edge hooks; slack-feed.css is .slack-feed, cyan, never lavender', () => {
  const edge = read('styles/edge-drawer.css');
  for (const hook of ['data-edge-tab', 'data-edge-count', 'data-edge-drawer', 'data-edge-head'])
    assert.ok(edge.includes(hook), `edge-drawer.css styles [${hook}]`);
  assert.match(edge, /\[data-edge-drawer\]\[hidden\]|\[data-edge-drawer\]:where\(\[hidden\]\)/s);
  assert.match(edge, /data-edge-tab=['"]?upper/);
  assert.match(edge, /data-edge-tab=['"]?lower/);
  assert.match(edge, /--edge-tab-length/);
  assert.match(edge, /@media\s*\(max-width:\s*599px\)|@media\s*\(width\s*<\s*600px\)/);
  assert.match(edge, /@media print/);
  assert.doesNotMatch(edge, /var\(--support\)/, 'the frame is neutral: Sessions adds lavender');

  const sessions = read('styles/sessions-drawer.css');
  for (const { selector, body } of rules(sessions))
    if (/^\.sessions-tab\b/.test(selector))
      assert.doesNotMatch(body, /position\s*:/, `${selector} no longer places itself`);

  const feed = read('styles/slack-feed.css');
  assert.doesNotMatch(feed, /--support/, 'lavender means Claude only');
  assert.match(feed, /var\(--accent\)/, 'the Slack tab is cyan');
  const selectors = rules(feed)
    .map(({ selector }) => selector)
    .filter((selector) => !selector.startsWith('@') && !/^(?:from|to|\d)/.test(selector))
    .flatMap((selector) => selector.split(/,(?![^(]*\))/))
    .map((selector) => selector.trim());
  assert.ok(selectors.length > 0, 'slack-feed.css has rules');
  for (const selector of selectors)
    assert.match(selector, /^\.slack-feed\b/, `${selector} stays slack-feed scoped`);
});

// SessionsBody is a lazy chunk, and rolldown makes a module that the entry and two lazy chunks share into
// an initial chunk of its own, which broke the first-paint budget once. So it imports only what no other
// lazy chunk uses; a new import here must be measured (see test/bundle-budget.test.mjs) and added below.
test('SessionsBody imports only the modules measured not to split the first-paint bundle', () => {
  const imports = [...read('components/SessionsBody.jsx').matchAll(/from '([^']+)'/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(imports.sort(), [
    '../../ui/bot-bar.js',
    '../../ui/chat-stream.js',
    '../../ui/session-usage.js',
    './NavIcon.jsx',
    './Primitives.jsx',
    './slack-watch/RelativeTime.jsx',
    'react',
  ]);
});
