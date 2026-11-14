import { test, expect, openChatStreams } from './fixtures.js';
import { CHAT_SESSION_ID, claudeEntry, ticketBoardData } from './data.js';

// F14 UI performance (plan .orchestrator/features-ui-nav-perf/02-plan-f14-performance.md, section 4a,
// items 3 to 10): lazy screens (Releases, Chat, DevTools, Mascots mount on first visit and stay
// mounted), the service snapshot dedupe, the live-log trigger and the isolated countdown clock.
// The build under test is unminified, so a chunk's file name keeps its module name.

const LAZY_CHUNKS = ['ChatPanel', 'ReleasesPanel', 'DevtoolsPanel', 'MascotsPanel'];
const chunkRequests = (dashboard, name) =>
  dashboard.requests.filter(({ path }) => path.startsWith('/assets/') && path.includes(name));
const logReads = (dashboard) =>
  dashboard.requests.filter(({ path }) => path.startsWith('/api/logs/')).map(({ path }) => path);

// Holds every request for a chunk until `release()`; the chunk then loads from the real server.
async function holdChunk(page, name) {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(`**/assets/${name}*`, async (route) => {
    await gate;
    await route.continue();
  });
  return release;
}

// A board screen locks the page to one viewport (`#root` becomes a 100dvh flex column); a normal page
// such as Releases does not. A loading stand-in must agree with its screen or the height flips.
const rootIsViewportLocked = (page) =>
  page.evaluate(() => getComputedStyle(document.getElementById('root')).display === 'flex');

const emitServices = (page, services) =>
  page.evaluate(
    (snapshot) => window.__dashboardMock.streams[0].emit('message', snapshot),
    services,
  );

test('unvisited screens cost nothing: no panel and no chunk request while Home is open', async ({
  page,
  dashboard,
}) => {
  await page.goto('/#/home');
  await expect(page.getByTestId('panel-home')).toBeVisible();
  await expect(page.getByTestId('tab-home')).toHaveAttribute('aria-current', 'page');
  // Let anything that was going to start start: the entry chunk is requested, the lazy ones are not.
  await page.waitForTimeout(300);
  expect(
    dashboard.requests.some(({ path }) => path.startsWith('/assets/index-')),
    'the entry chunk was requested (the log is working)',
  ).toBe(true);
  for (const id of ['chat', 'releases', 'devtools', 'mascots']) {
    await expect(page.getByTestId(`panel-${id}`)).toHaveCount(0);
    await expect(page.getByTestId(`panel-${id}-loading`)).toHaveCount(0);
  }
  for (const name of LAZY_CHUNKS) expect(chunkRequests(dashboard, name), name).toEqual([]);
});

test('first visit shows the loading fallback, then the real screen, for a direct link and a tab click', async ({
  page,
}) => {
  const releasesRelease = await holdChunk(page, 'ReleasesPanel');
  await page.goto('/#/releases?view=list');
  await expect(page.getByTestId('panel-releases-loading')).toBeVisible();
  await expect(page.getByTestId('screen-loading-releases')).toBeVisible();
  await expect(page.getByTestId('panel-releases')).toHaveCount(0);
  expect(
    await rootIsViewportLocked(page),
    'Releases is not a board: no viewport lock while loading',
  ).toBe(false);
  releasesRelease();
  await expect(page.getByTestId('panel-releases')).toBeVisible();
  expect(await rootIsViewportLocked(page), 'and none once it has loaded, so the height holds').toBe(
    false,
  );
  await expect(page.getByTestId('panel-releases-loading')).toHaveCount(0);
  await expect(page.getByTestId('releases-view-list')).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/#\/releases\?view=list$/);

  const chatRelease = await holdChunk(page, 'ChatPanel');
  await page.goto(`/#/chat?session=${CHAT_SESSION_ID}`);
  await page.reload();
  await expect(page.getByTestId('panel-chat-loading')).toBeVisible();
  await expect(page.getByTestId('panel-chat')).toHaveCount(0);
  expect(await rootIsViewportLocked(page), 'Chat is a board: locked from the first paint').toBe(
    true,
  );
  chatRelease();
  await expect(page.getByTestId('panel-chat')).toBeVisible();
  await expect(page.getByTestId('panel-chat-loading')).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`#/chat\\?session=${CHAT_SESSION_ID}$`));
  await expect.poll(() => openChatStreams(page)).toContain(CHAT_SESSION_ID);

  // A tab click from a loaded app takes the same path.
  await page.goto('/#/home');
  await expect(page.getByTestId('panel-home')).toBeVisible();
  const devtoolsRelease = await holdChunk(page, 'DevtoolsPanel');
  await page.getByTestId('tab-devtools').click();
  await expect(page.getByTestId('panel-devtools-loading')).toBeVisible();
  devtoolsRelease();
  await expect(page.getByTestId('panel-devtools')).toBeVisible();
  await expect(page.getByTestId('panel-devtools-loading')).toHaveCount(0);
});

test('revisit keeps the screens mounted with their state and requests no chunk again', async ({
  page,
  dashboard,
}) => {
  await page.goto('/#/devtools');
  await expect(page.getByTestId('panel-devtools')).toBeVisible();
  await page.getByTestId('tab-releases').click();
  await expect(page.getByTestId('panel-releases')).toBeVisible();
  await expect(page.locator('.release-ticket').first()).toBeVisible();
  await expect(page.getByTestId('releases-refresh')).toBeEnabled();

  const mark = (id) =>
    page.getByTestId(`panel-${id}`).evaluate((node, value) => {
      node.__perfMarker = value;
    }, id);
  await mark('devtools');
  await mark('releases');
  await page.getByTestId('releases-scope').check();
  await expect(page.getByTestId('releases-scope')).toBeChecked();
  await page.getByTestId('tab-devtools').click();
  await expect(page.getByTestId('panel-devtools')).toBeVisible();
  await expect(page.getByTestId('panel-releases')).toBeHidden();
  await page.getByTestId('devtools-url-input').fill('https://example.invalid/kept');

  const before = Object.fromEntries(
    LAZY_CHUNKS.map((name) => [name, chunkRequests(dashboard, name).length]),
  );
  expect(before.ReleasesPanel).toBeGreaterThan(0);
  expect(before.DevtoolsPanel).toBeGreaterThan(0);

  await page.getByTestId('tab-home').click();
  await expect(page.getByTestId('panel-home')).toBeVisible();
  await page.getByTestId('tab-releases').click();
  await expect(page.getByTestId('panel-releases')).toBeVisible();
  await expect(page.getByTestId('panel-releases')).toHaveJSProperty('__perfMarker', 'releases');
  await expect(page.getByTestId('releases-scope')).toBeChecked();
  await page.getByTestId('tab-devtools').click();
  await expect(page.getByTestId('panel-devtools')).toBeVisible();
  await expect(page.getByTestId('panel-devtools')).toHaveJSProperty('__perfMarker', 'devtools');
  await expect(page.getByTestId('devtools-url-input')).toHaveValue('https://example.invalid/kept');

  for (const name of LAZY_CHUNKS)
    expect(chunkRequests(dashboard, name).length, `${name} requested again`).toBe(before[name]);
});

test('chunk failure shows a retry state in place and leaves every other tab working', async ({
  page,
}) => {
  await page.route('**/assets/ReleasesPanel*', (route) => route.abort('failed'));
  await page.goto('/#/home');
  await expect(page.getByTestId('panel-home')).toBeVisible();
  await page.getByTestId('tab-releases').click();
  await expect(page.getByTestId('screen-error-releases')).toBeVisible();
  await expect(page.getByTestId('screen-reload-releases')).toBeVisible();
  await expect(page.getByTestId('screen-reload-releases')).toBeEnabled();
  await expect(page.getByTestId('panel-releases')).toHaveCount(0);
  await expect(page.getByTestId('screen-loading-releases')).toHaveCount(0);

  await page.getByTestId('tab-home').click();
  await expect(page.getByTestId('panel-home')).toBeVisible();
  await expect(page.getByTestId('screen-error-releases')).toBeHidden();
  await page.getByTestId('tab-services').click();
  await expect(page.getByTestId('panel-services')).toBeVisible();
  await expect(page.getByTestId('log-api')).toContainText('line 120');
  await page.getByTestId('tab-my-tickets').click();
  await expect(page.getByTestId('panel-my-tickets')).toBeVisible();
});

test('identical snapshots do not re-render the app, a changed one does', async ({
  page,
  dashboard,
}) => {
  // A stub of React DevTools' global hook: React calls `onCommitFiberRoot` after every commit, so the
  // counter is the number of renders that reached the DOM tree, whichever component caused them.
  await page.addInitScript(() => {
    window.__perfCommits = 0;
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      renderers: new Map(),
      inject() {
        return 1;
      },
      onCommitFiberRoot() {
        window.__perfCommits += 1;
      },
      onCommitFiberUnmount() {},
      onPostCommitFiberRoot() {},
      checkDCE() {},
    };
  });
  const commits = () => page.evaluate(() => window.__perfCommits);
  await page.goto('/#/home');
  await expect(page.getByTestId('panel-home')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__dashboardMock.streams.length)).toBe(1);
  expect(await commits(), 'the stub sees React commits').toBeGreaterThan(0);
  // The stream says hello once; wait until the app has settled on it.
  let settled = -1;
  await expect
    .poll(async () => {
      const now = await commits();
      const quiet = now === settled;
      settled = now;
      return quiet;
    })
    .toBe(true);

  const baseline = await commits();
  await page.evaluate((snapshot) => {
    for (let i = 0; i < 50; i += 1)
      window.__dashboardMock.streams[0].emit('message', structuredClone(snapshot));
  }, dashboard.data.services);
  await page.waitForTimeout(200);
  expect(await commits(), '50 identical snapshots cause no commit').toBe(baseline);

  const changed = dashboard.data.services.map((service, index) =>
    index === 0 ? { ...service, status: 'stopped' } : service,
  );
  await emitServices(page, changed);
  await expect.poll(commits).toBeGreaterThan(baseline);
});

test('live logs follow a snapshot with a new lineCount, and an identical snapshot reads nothing', async ({
  page,
  dashboard,
}) => {
  await page.goto('/#/services');
  await expect(page.getByTestId('log-api')).toContainText('line 120');
  await expect(page.getByTestId('log-worker')).toContainText('line');
  const ids = dashboard.data.services.map(({ id }) => id);
  const withCount = (lineCount) =>
    dashboard.data.services.map((service) => ({ ...service, lineCount, lastLineAt: lineCount }));

  // Settle on a first snapshot, then wait for every card's read to finish.
  await emitServices(page, withCount(1));
  await expect.poll(() => logReads(dashboard).length).toBeGreaterThanOrEqual(ids.length * 2);
  await page.waitForTimeout(200);
  const settled = logReads(dashboard).length;

  // The same snapshot, again and again: the list keeps its identity, so no card reads.
  for (let i = 0; i < 5; i += 1) await emitServices(page, withCount(1));
  await page.waitForTimeout(300);
  expect(logReads(dashboard).length, 'identical snapshots read no log').toBe(settled);

  // A snapshot with a new lineCount: one read per service card (each card shows its own log).
  await emitServices(page, withCount(2));
  await expect.poll(() => logReads(dashboard).length).toBe(settled + ids.length);
  await page.waitForTimeout(300);
  const fresh = logReads(dashboard).slice(settled);
  expect(fresh.length, 'one read per card, no more').toBe(ids.length);
  for (const id of ids)
    expect(fresh.filter((path) => path.startsWith(`/api/logs/${id}?`))).toHaveLength(1);

  // Output that arrived with the change is shown.
  dashboard.data.logs.api += '\nfresh api output';
  await emitServices(page, withCount(3));
  await expect(page.getByTestId('log-api')).toContainText('fresh api output');
});

test('countdown still counts down and a Refresh click resets it', async ({ page }) => {
  await page.goto('/#/my-tickets');
  await expect(page.getByTestId('my-tickets-board')).toBeVisible();
  const label = page.getByTestId('my-tickets-next');
  const seconds = async () => Number((await label.textContent()).match(/^refresh in (\d+)s$/)?.[1]);
  await expect(label).toHaveText(/^refresh in \d+s$/);
  const first = await seconds();
  await page.waitForTimeout(2200);
  const later = await seconds();
  expect(later, `${later}s is lower than ${first}s after 2 s`).toBeLessThan(first);

  await page.getByTestId('my-tickets-refresh').click();
  await expect(page.getByTestId('my-tickets-refresh')).toBeEnabled();
  await expect.poll(seconds).toBeGreaterThan(later);
});

test('hidden tab pauses the countdown label and its tick, and visible resumes it', async ({
  page,
}) => {
  await page.clock.install();
  await page.goto('/#/my-tickets');
  await expect(page.getByTestId('my-tickets-board')).toBeVisible();
  const label = page.getByTestId('my-tickets-next');
  await expect(label).toHaveText(/^refresh in \d+s$/);
  const setHidden = (hidden) =>
    page.evaluate((value) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => (value ? 'hidden' : 'visible'),
      });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);

  await page.clock.runFor(2000);
  await setHidden(true);
  await expect(label).toHaveText(/^refresh paused \(\d+s\)$/);
  const paused = await label.textContent();
  await page.clock.runFor(5000);
  await expect(label).toHaveText(paused);
  await page.clock.fastForward(5000);
  await expect(label).toHaveText(paused);

  await setHidden(false);
  await expect(label).not.toContainText('paused');
  await expect(label).toHaveText(/^refresh in \d+s$/);
  const resumed = await label.textContent();
  await page.clock.runFor(3000);
  await expect(label).not.toHaveText(resumed);
  await expect(label).toHaveText(/^refresh in \d+s$/);
});

// The overlays opened on demand (palette, help, ticket Claude dialog) are not in the entry chunk:
// idle Home requests none of them, the first key press loads then opens, a slow chunk loses nothing,
// and a chunk that cannot load shows the Reload alert instead of silently doing nothing.
const OVERLAY_CHUNKS = ['CommandPalette', 'ShortcutsHelp', 'ClaudeDialog'];

test('on-demand overlays cost nothing until used: no chunk request while Home idles', async ({
  page,
  dashboard,
}) => {
  await page.goto('/#/home');
  await expect(page.getByTestId('panel-home')).toBeVisible();
  await page.waitForLoadState('networkidle');
  for (const name of OVERLAY_CHUNKS) expect(chunkRequests(dashboard, name), name).toEqual([]);
});

test('Control+K and ? load their chunk then open, once, on the first press', async ({ page }) => {
  // Counted off the browser's own requests: a held (routed) request is not in the dashboard log.
  const asked = {};
  page.on('request', (request) => {
    const match = new URL(request.url()).pathname.match(/\/assets\/(CommandPalette|ShortcutsHelp)/);
    if (match) asked[match[1]] = (asked[match[1]] ?? 0) + 1;
  });
  await page.goto('/#/home');
  await expect(page.getByTestId('panel-home')).toBeVisible();
  const release = await holdChunk(page, 'CommandPalette');
  await page.keyboard.press('Control+K');
  // The chunk is still loading: nothing is open yet, and nothing was lost.
  await expect.poll(() => asked.CommandPalette).toBe(1);
  await expect(page.getByTestId('command-palette')).toBeHidden();
  release();
  await expect(page.getByTestId('command-palette')).toBeVisible();
  await expect(page.getByTestId('command-palette-input')).toBeFocused();
  await page.keyboard.type('sla');
  await expect(page.getByTestId('command-palette-input')).toHaveValue('sla');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('command-palette')).toBeHidden();
  await page.keyboard.press('Control+K');
  await expect(page.getByTestId('command-palette')).toBeVisible();
  expect(asked.CommandPalette, 'requested once').toBe(1);
  await page.keyboard.press('Escape');

  await page.keyboard.press('?');
  await expect(page.getByTestId('shortcuts-help')).toBeVisible();
  expect(asked.ShortcutsHelp).toBe(1);
});

for (const { chunk, press, label } of [
  { chunk: 'CommandPalette', press: 'Control+K', label: 'The command palette' },
  { chunk: 'ShortcutsHelp', press: '?', label: 'The shortcuts help' },
]) {
  test(`a failed ${chunk} chunk shows a Reload alert, and Close dismisses it`, async ({ page }) => {
    await page.route(`**/assets/${chunk}*`, (route) => route.abort('failed'));
    await page.goto('/#/home');
    await expect(page.getByTestId('panel-home')).toBeVisible();
    await page.keyboard.press(press);
    const alert = page.getByTestId('dialog-error');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(`${label} could not load`);
    await alert.getByRole('button', { name: 'Reload' }).click({ trial: true });
    await alert.getByRole('button', { name: 'Close' }).click();
    await expect(alert).toHaveCount(0);
  });
}

test('the Claude dialog loads on its first open, and a failed chunk shows Reload, not nothing', async ({
  page,
  dashboard,
}) => {
  ticketBoardData(dashboard.data);
  dashboard.data.claude.tickets['TAP-9001'] = claudeEntry('done', 'plan_ready', {});
  const asked = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.includes('/assets/ClaudeDialog')) asked.push(request.url());
  });
  await page.goto('/#/my-tickets');
  await expect(page.getByTestId('my-tickets-item-TAP-9001')).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(asked, 'idle My Tickets does not load the dialog').toEqual([]);
  await page.getByTestId('claude-icon-TAP-9001').click();
  await expect(page.getByTestId('claude-dialog')).toBeVisible();
  expect(asked).toHaveLength(1);

  await page.route('**/assets/ClaudeDialog*', (route) => route.abort('failed'));
  await page.reload();
  await expect(page.getByTestId('my-tickets-item-TAP-9001')).toBeVisible();
  await page.getByTestId('claude-icon-TAP-9001').click();
  const alert = page.getByTestId('dialog-error');
  await expect(alert).toContainText('The Claude dialog could not load');
  await alert.getByRole('button', { name: 'Reload' }).click({ trial: true });
  await alert.getByRole('button', { name: 'Close' }).click();
  await expect(alert).toHaveCount(0);
  await expect(page.getByTestId('claude-dialog')).toHaveCount(0);
});
