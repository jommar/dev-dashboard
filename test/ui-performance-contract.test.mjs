import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement, lazy } from 'react';
import { renderToString } from 'react-dom/server';
import { createServer } from 'vite';

// Source-level contracts for the UI performance work: lazy screens with a first-visit gate, one
// deduplicated service feed, memoized screens and a countdown that ticks in its own component.
// The build-size half is test/bundle-budget.test.mjs; the behavior half is e2e/perf.spec.js.
const root = fileURLToPath(new URL('../ui-react/', import.meta.url));
const read = (file) => fs.readFileSync(`${root}${file}`, 'utf8');
const withoutComments = (source) => source.replace(/^\s*\/\/.*$/gm, '');
const LAZY = [
  ['releases', 'Releases', 'ReleasesPanel'],
  ['chat', 'Chat', 'ChatPanel'],
  ['devtools', 'Devtools', 'DevtoolsPanel'],
  ['mascots', 'Mascots', 'MascotsPanel'],
];
// Every <ScreenSlot ... /> element in App's source, each as its own text, so a pin does not depend on
// the order of its props or on how Prettier wrapped them.
const slotElements = (source) => source.match(/<ScreenSlot\b[\s\S]*?\/>/g) || [];
const EAGER = [
  ['Home', 'HomePanel'],
  ['Services', 'ServicesPanel'],
  ['Prs', 'PrsPanel'],
  ['MyTickets', 'MyTicketsPanel'],
  ['Slack', 'SlackPanel'],
  ['Settings', 'SettingsPanel'],
];

test('memo: every screen App renders is memoized, so a feed tick re-renders only Services', () => {
  const app = read('App.jsx');
  for (const [name, panel] of EAGER)
    assert.match(app, new RegExp(`const ${name} = memo\\(${panel}\\);`), `${panel} is memoized`);
  for (const [, name, panel] of LAZY)
    assert.match(
      app,
      new RegExp(
        `const ${name} = memo\\(\\s*lazyScreen\\(\\s*\\(\\) => import\\('\\./panels/${panel}\\.jsx'\\),\\s*'${panel}',?\\s*\\),?\\s*\\);`,
      ),
      `${panel} is a memoized lazy screen`,
    );
  // Only the Services screen takes the feed.
  const takers = (app.match(/<(\w+)\b[^<]*?\bservices=\{/g) || []).map(
    (tag) => tag.match(/\w+/)[0],
  );
  assert.deepEqual(takers, ['Services']);
  const shell = read('components/AppShell.jsx');
  assert.match(shell, /const AppTabs = memo\(AppTabsView\);/);
  assert.match(shell, /const BotBar = memo\(BotBarView\);/);
});

test('lazy screens: Settings and the daily tabs stay eager, four screens mount on first visit', () => {
  const app = read('App.jsx');
  // Nothing eager imports a lazy screen, and the only dynamic imports are the four screens.
  for (const [, , panel] of LAZY)
    assert.doesNotMatch(
      app,
      new RegExp(`import \\{ ${panel} \\}`),
      `${panel} is not a static import`,
    );
  // Each of the four is mounted through one ScreenSlot with its own id, screen and active flag.
  const slots = slotElements(app);
  for (const [id, name] of LAZY) {
    const own = slots.filter((slot) => slot.includes(`id="${id}"`));
    assert.equal(own.length, 1, `${id} has one ScreenSlot`);
    assert.match(own[0], new RegExp(`\\bScreen=\\{${name}\\}`), `${id} renders ${name}`);
    assert.match(own[0], new RegExp(`\\bactive=\\{active === '${id}'\\}`), `${id} gets its flag`);
  }
  assert.match(app, /import \{ SettingsPanel \} from '\.\/panels\/SettingsPanel\.jsx'/);
  // The route table and the shared-hook text other tests read are unchanged.
  assert.match(app, /useServiceEvents\(ready, setupChanged\)/);
  assert.equal((app.match(/subscribeServices/g) || []).length, 0);
});

test('lazy screens: the slot gates on first visit, keeps state, and has loading and error states', () => {
  const slot = read('components/ScreenSlot.jsx');
  assert.match(slot, /useState\(active\)/, 'a screen that is active at boot mounts at once');
  assert.match(slot, /if \(!visited && !active\) return null;/, 'unvisited screens render nothing');
  assert.doesNotMatch(slot, /setVisited\(false\)/, 'a visited screen stays mounted');
  assert.match(slot, /testId=\{`screen-error-\$\{id\}`\}/);
  assert.match(slot, /location\.reload\(\)/, 'the error state offers Reload');
  assert.match(slot, /getDerivedStateFromError/);
  const lazy = read('lib/lazy-screen.js');
  assert.match(lazy, /module\[name\]/, 'a named export is lazy-loaded');
  const dialog = read('components/ClaudeDialog.jsx');
  assert.match(
    dialog,
    /lazyScreen\(\(\) => import\('\.\/ArtifactViewer\.jsx'\), 'ArtifactViewer'\)/,
  );
  assert.match(
    dialog,
    /lazyScreen\(\(\) => import\('\.\/E2eCheckDialog\.jsx'\), 'E2eCheckDialog'\)/,
  );
  assert.doesNotMatch(dialog, /import \{ (ArtifactViewer|E2eCheckDialog) \}/);
});

test('snapshots: the service feed keeps the previous list when the whole JSON is equal', () => {
  const hook = read('hooks/useServiceEvents.js');
  assert.match(hook, /from '\.\.\/\.\.\/ui\/keep-if-equal\.js'/);
  assert.match(hook, /keepIfEqual\(previous, list\)/);
  // Never a projection: the Services card refreshes its log on every snapshot, so a comparison on
  // status or any chosen fields alone would freeze live logs.
  assert.doesNotMatch(withoutComments(hook), /\.map\(|\.status|lineCount|JSON\.stringify/);
});

test('countdown: the 1 s tick lives in BoardCountdown, not in the polling hook or the panels', () => {
  const polling = read('hooks/useActivePolling.js');
  assert.doesNotMatch(polling, /setNow/, 'the hook no longer re-renders its panel every second');
  assert.match(polling, /return \{ load: loadOnce, countdown \}/);
  assert.match(polling, /\{ lastLoadedAt, interval, loaded, active \}/);
  const shell = read('components/BoardShell.jsx');
  assert.match(shell, /function BoardCountdown\(/);
  assert.match(shell, /<BoardCountdown name=\{name\} countdown=\{countdown\} \/>/);
  assert.match(shell, /data-testid=\{`\$\{name\}-next`\}/);
  assert.match(shell, /refresh paused \(/);
  assert.match(shell, /addEventListener\('visibilitychange', sync\)/);
  // Every consumer hands the descriptor straight to RefreshControl.
  for (const file of ['MyTickets', 'Slack', 'Prs']) {
    const panel = read(`panels/${file}Panel.jsx`);
    assert.match(panel, /countdown=\{countdown\}/, `${file} passes the descriptor on`);
    // It may read a field of the descriptor (My Tickets keys its sprint refresh on lastLoadedAt), but
    // never renders it as text: the 1 s clock must stay in BoardCountdown.
    assert.doesNotMatch(
      panel,
      /`[^`]*\$\{countdown\b|>\s*\{countdown\}\s*</,
      `${file} does not render it as text`,
    );
  }
  assert.match(read('panels/DevtoolsPanel.jsx'), /countdown=\{polling\.countdown\}/);
});

test('memo: My Tickets memoizes the filter options and the sprint sub line', () => {
  const panel = read('panels/MyTicketsPanel.jsx');
  assert.match(panel, /const options = useMemo\(/);
  assert.match(
    panel,
    /const sprint = useMemo\(\(\) => data && sprintHtml\(data\.activeSprints\), \[data\]\)/,
  );
  assert.match(panel, /sub=\{sprint\}/);
});

// The loading stand-in must have the shape of the screen it stands in for: a board screen is locked
// to one viewport by `#root:has(.board-panel:not([hidden]))`, a normal page is not, and a stand-in of
// the wrong shape makes the page height flip when the chunk arrives. Rendered for real, so the pin is
// on the markup a visitor gets, not on source text.
test('lazy screens: the loading stand-in has the shape of its screen, board or plain page', async () => {
  const server = await createServer({
    configFile: fileURLToPath(new URL('../vite.config.js', import.meta.url)),
    logLevel: 'silent',
    server: { middlewareMode: true },
    appType: 'custom',
  });
  try {
    const { ScreenSlot } = await server.ssrLoadModule(`${root}components/ScreenSlot.jsx`);
    const never = lazy(() => new Promise(() => {}));
    // renderToString has no Suspense support and says so in a comment; the fallback is still rendered.
    const render = (props) =>
      renderToString(createElement(ScreenSlot, { id: 'x', label: 'X', Screen: never, ...props }));
    const board = render({ active: true });
    assert.match(board, /<section[^>]*\bid="panel-x-loading"/);
    assert.match(
      board,
      /<section[^>]*\bclass="panel board-panel"/,
      'a board screen stands in as a board',
    );
    assert.match(board, /data-testid="screen-loading-x"/);
    const page = render({ board: false, active: true });
    assert.match(page, /<section[^>]*\bid="panel-x-loading"/);
    assert.match(page, /<section[^>]*\bclass="panel"/, 'a plain page stands in as a plain panel');
    assert.doesNotMatch(page, /board-panel|board-section/, 'and takes nothing from the board rule');
    assert.match(page, /data-testid="screen-loading-x"/);
  } finally {
    await server.close();
  }
});

test('lazy screens: only Releases, the one screen that is not a board, opts out of the board shape', () => {
  const slots = slotElements(read('App.jsx'));
  assert.equal(slots.length, LAZY.length);
  for (const [id] of LAZY) {
    const own = slots.find((slot) => slot.includes(`id="${id}"`));
    assert.equal(/\bboard=\{false\}/.test(own), id === 'releases', `${id} board flag`);
  }
  // The screens' own roots agree with the flags: Releases is a plain panel, the rest BoardPanels.
  assert.doesNotMatch(read('panels/ReleasesPanel.jsx'), /<BoardPanel\b/);
  for (const panel of ['ChatPanel', 'DevtoolsPanel', 'MascotsPanel'])
    assert.match(read(`panels/${panel}.jsx`), /<BoardPanel\b/, `${panel} is a board panel`);
});

test('lazy overlays: the palette and the help load on demand, and the key listener loads them before opening', () => {
  const overlays = withoutComments(read('lib/lazy-overlays.js'));
  assert.match(overlays, /import\(['"]\.\.\/components\/CommandPalette\.jsx['"]\)/);
  assert.match(overlays, /import\(['"]\.\.\/components\/ShortcutsHelp\.jsx['"]\)/);
  for (const [file, name] of [
    ['components/BotBar.jsx', 'CommandPalette'],
    ['components/AppShell.jsx', 'ShortcutsHelp'],
  ]) {
    const source = withoutComments(read(file));
    assert.doesNotMatch(
      source,
      new RegExp(`from '\\./${name}\\.jsx'`),
      `${file} imports ${name} eagerly`,
    );
    assert.match(source, new RegExp(`<${name}\\b`), `${file} still renders ${name}`);
    assert.match(
      source,
      new RegExp(`<LazyDialog[^>]*>\\s*<${name}\\b`),
      `${name} is inside a LazyDialog, so a failed chunk shows Reload`,
    );
  }
  const keys = withoutComments(read('hooks/useGlobalShortcuts.js'));
  assert.match(keys, /loadCommandPalette\(\)/, 'Ctrl+K loads the palette chunk first');
  assert.match(keys, /loadShortcutsHelp\(\)/, '? loads the help chunk first');
});

test('lazy overlays: the ticket Claude dialog loads on its first open, from both places that open it', () => {
  assert.match(
    withoutComments(read('lib/lazy-overlays.js')),
    /import\(['"]\.\.\/components\/ClaudeDialog\.jsx['"]\)/,
  );
  for (const file of ['components/BotBar.jsx', 'panels/MyTicketsPanel.jsx']) {
    const source = withoutComments(read(file));
    assert.doesNotMatch(
      source,
      /from '[^']*\/ClaudeDialog\.jsx'/,
      `${file} imports the dialog eagerly`,
    );
    assert.match(
      source,
      /<LazyDialog[^>]*>\s*<ClaudeDialog\b/,
      `${file} mounts it inside a LazyDialog, so a failed chunk shows Reload`,
    );
    assert.match(source, /loadClaudeDialog\(\)\.then\(/, `${file} loads the dialog, then opens it`);
  }
});
