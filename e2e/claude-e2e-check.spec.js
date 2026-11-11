import { test, expect } from './fixtures.js';
import { claudeEntry, devtoolsFrame, ticketBoardData } from './data.js';
import { DEFAULT_DEVTOOLS_URL } from '../ui/devtools-defaults.js';

// E2E check in the Claude dialog: a row, after Groom ticket, that opens its own two-step dialog. Step 1
// takes the URL and launches a NEW DevTools browser; step 2 names the port, offers the live view and
// "I've logged in, start check", the only thing that starts the session. The session's own state is
// `entry.e2e` (`{ state, reason }`), its join command `goTo.e2e` and its block `blocks.e2e`; all
// three exist only for a ticket with an e2e record (the fake API in e2e/data.js models them).
//
// Test ids: `claude-action-e2e`, `claude-action-hint-e2e`, `claude-action-goto-e2e` (named "Go to e2e
// check session"), `claude-goto-copied-e2e` and `claude-view-e2e`. The two-step dialog is found by
// its accessible name (it contains "E2E check") and its buttons by their words.

const KEY = 'TAP-9001';
const BROWSER = { id: 'b-5e0f6a1b', port: 9304 };
const URL_ENTERED = 'https://example.invalid/app';
const ATTACH = { kind: 'attach', command: 'claude attach ab12cd34' };
const E2E_RESUME = {
  kind: 'resume',
  command: 'cd ~/pathwise && claude --resume 5b9d3c21-7e4f-4a08-9d16-2c3b4a5f6e70',
};
const RUNNING = 'A Claude session is already running for this ticket.';
const UNAVAILABLE = 'Claude status is unavailable.';
const GONE = 'That browser is no longer running. Launch a new one.';
const E2E = {
  working: { state: 'working', reason: 'running' },
  done: { state: 'done', reason: 'finished' },
  failed: { state: 'failed', reason: 'session_missing' },
};
const sessions = (e2e = null, groom = null) => ({
  investigate: null,
  implement: null,
  groom,
  e2e,
});

const iconOf = (page, key = KEY) => page.getByTestId(`claude-icon-${key}`);
const bodiesTo = ({ data }, path) =>
  data.claude.calls.filter((call) => call.path === path).map((call) => call.body);
const browserCalls = ({ data }, suffix) =>
  data.devtools.calls.filter((call) => call.path === `/api/devtools/browsers${suffix}`);
const streamCalls = ({ data }, kind) =>
  data.devtools.streamCalls.filter((call) => call.path.endsWith(`/${kind}`));
const e2eDialog = (page) => page.getByRole('dialog', { name: /E2E check/ });
const launchButton = (page) => e2eDialog(page).getByRole('button', { name: 'Launch browser' });
const startButton = (page) =>
  e2eDialog(page).getByRole('button', { name: "I've logged in, start check" });
const liveViewButton = (page) => e2eDialog(page).getByRole('button', { name: 'Open live view' });

// The board with these Claude entries (a ticket with none is not started). The card is asserted
// first: a broken mock or a missing board is not an e2e RED.
async function openBoard(page, dashboard, entries = {}) {
  ticketBoardData(dashboard.data);
  Object.assign(dashboard.data.claude.tickets, entries);
  await page.goto('/#/my-tickets');
  await expect(page.getByTestId('my-tickets-board')).toBeVisible();
  await expect(page.getByTestId(`my-tickets-item-${KEY}`)).toBeVisible();
}

async function openDialog(page, key = KEY) {
  await iconOf(page, key).click();
  const dialog = page.getByTestId('claude-dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

// Step 1 to step 2: the browser the fake registry creates next is BROWSER (or the id a spec set).
async function openStepTwo(page, dashboard) {
  await openBoard(page, dashboard);
  const claude = await openDialog(page);
  await claude.getByTestId('claude-action-e2e').click();
  await expect(e2eDialog(page)).toBeVisible();
  await e2eDialog(page).getByPlaceholder(DEFAULT_DEVTOOLS_URL).fill(URL_ENTERED);
  await launchButton(page).click();
  await expect(startButton(page)).toBeEnabled();
  return claude;
}

const emitScreencast = (page, type, payload) =>
  page.evaluate(
    ([name, value]) => window.__dashboardMock.screencasts.at(-1).emit(name, value),
    [type, { id: BROWSER.id, ...payload }],
  );
// The viewer's browser is up, showing a page, with a picture.
async function goLive(page) {
  await emitScreencast(page, 'status', { status: 'live', reason: '' });
  await emitScreencast(page, 'target', {
    targetId: 'T1',
    title: 'Home',
    url: 'https://example.invalid/home',
  });
  await emitScreencast(page, 'frame', devtoolsFrame());
  await expect(page.getByTestId('devtools-viewer-status')).toHaveText('Live');
}

test('e2e check: the browser launches first, the session does not', async ({ page, dashboard }) => {
  await openBoard(page, dashboard);
  const claude = await openDialog(page);
  await claude.getByTestId('claude-action-e2e').click();
  await expect(e2eDialog(page)).toBeVisible();

  await e2eDialog(page).getByPlaceholder(DEFAULT_DEVTOOLS_URL).fill(URL_ENTERED);
  await launchButton(page).click();

  await expect
    .poll(() => browserCalls(dashboard, ''))
    .toEqual([
      {
        method: 'POST',
        path: '/api/devtools/browsers',
        body: { label: `E2E ${KEY}`, url: URL_ENTERED },
      },
    ]);
  await expect(e2eDialog(page).getByText(`Port ${BROWSER.port}`)).toBeVisible();
  await expect(liveViewButton(page)).toBeVisible();
  await expect(startButton(page)).toBeEnabled();
  expect(bodiesTo(dashboard, '/api/claude/launch')).toEqual([]);
});

// Step 1 with the URL filled in; `headed` ticks "Show browser window" before launching.
async function launchFromStepOne(page, dashboard, { headed = false } = {}) {
  await openBoard(page, dashboard);
  const claude = await openDialog(page);
  await claude.getByTestId('claude-action-e2e').click();
  await expect(e2eDialog(page)).toBeVisible();
  await e2eDialog(page).getByPlaceholder(DEFAULT_DEVTOOLS_URL).fill(URL_ENTERED);
  if (headed) await showWindowBox(page).check();
  await launchButton(page).click();
  await expect(startButton(page)).toBeEnabled();
}
const showWindowBox = (page) =>
  e2eDialog(page).getByRole('checkbox', { name: 'Show browser window' });
// The one-sentence hint above the buttons; it is the only place the dialog says where to sign in.
const hint = (page) => e2eDialog(page).locator('.claude-note');
const PROMISES_A_WINDOW = /window|desktop|visible/i;

test('e2e check: Show browser window is unchecked, and the default launch sends no headed', async ({
  page,
  dashboard,
}) => {
  await openBoard(page, dashboard);
  const claude = await openDialog(page);
  await claude.getByTestId('claude-action-e2e').click();
  await expect(showWindowBox(page)).toBeVisible();
  await expect(showWindowBox(page)).not.toBeChecked();
  // Step 1 promises no window by default.
  await expect(hint(page)).not.toHaveText(PROMISES_A_WINDOW);

  await e2eDialog(page).getByPlaceholder(DEFAULT_DEVTOOLS_URL).fill(URL_ENTERED);
  await launchButton(page).click();
  await expect(startButton(page)).toBeEnabled();
  expect(browserCalls(dashboard, '')).toEqual([
    {
      method: 'POST',
      path: '/api/devtools/browsers',
      body: { label: `E2E ${KEY}`, url: URL_ENTERED },
    },
  ]);
});

test('e2e check: checking Show browser window launches with headed: true', async ({
  page,
  dashboard,
}) => {
  await launchFromStepOne(page, dashboard, { headed: true });
  expect(browserCalls(dashboard, '')).toEqual([
    {
      method: 'POST',
      path: '/api/devtools/browsers',
      body: { label: `E2E ${KEY}`, url: URL_ENTERED, headed: true },
    },
  ]);
  // Still the same step 2: the session starts only from its button.
  expect(bodiesTo(dashboard, '/api/claude/launch')).toEqual([]);
});

test('e2e check: by default the hint sends you to the live viewer, never to a desktop window', async ({
  page,
  dashboard,
}) => {
  await launchFromStepOne(page, dashboard);
  await expect(hint(page)).toContainText(/live view/i);
  await expect(hint(page)).toContainText('Take control');
  await expect(hint(page)).not.toHaveText(PROMISES_A_WINDOW);
  await expect(hint(page)).toContainText('throw-away test client');
});

test('e2e check: a browser launched with its window says the window is a second way to sign in', async ({
  page,
  dashboard,
}) => {
  await launchFromStepOne(page, dashboard, { headed: true });
  await expect(hint(page)).toContainText(/window/i);
  await expect(hint(page)).toContainText(/live view/i);
  await expect(hint(page)).toContainText('Take control');
  await expect(hint(page)).not.toHaveText(/desktop/i);
});

test('e2e check: a rejected URL stays on step 1', async ({ page, dashboard }) => {
  const MESSAGE = 'Enter an http or https address.';
  await page.route('**/api/devtools/browsers', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'INVALID_URL', error: MESSAGE, errors: [] }),
        })
      : route.fallback(),
  );
  await openBoard(page, dashboard);
  const claude = await openDialog(page);
  await claude.getByTestId('claude-action-e2e').click();
  await e2eDialog(page).getByPlaceholder(DEFAULT_DEVTOOLS_URL).fill('javascript:alert(1)');
  await launchButton(page).click();

  await expect(e2eDialog(page).getByText(MESSAGE)).toBeVisible();
  await expect(launchButton(page)).toBeVisible();
  await expect(e2eDialog(page).getByText(/Port \d+/)).toHaveCount(0);
  await expect(startButton(page)).toHaveCount(0);
  expect(bodiesTo(dashboard, '/api/claude/launch')).toEqual([]);
});

test('e2e check: the live view is an optional way to sign in', async ({ page, dashboard }) => {
  await openStepTwo(page, dashboard);
  // Without opening the live view nothing watches the browser.
  expect(dashboard.data.devtools.streamCalls).toEqual([]);

  await liveViewButton(page).click();
  await expect(page.getByTestId('devtools-viewer')).toBeVisible();
  await expect(page.getByTestId('devtools-viewer-title')).toHaveText(`E2E ${KEY}`);
  await expect.poll(() => dashboard.data.devtools.subscriptions[BROWSER.id]).toBe('full');
  await goLive(page);
  await page.getByTestId('devtools-viewer-control').click();
  const box = await page.getByTestId('devtools-viewer-image').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(() => browserCalls(dashboard, '/input').length).toBeGreaterThan(0);
  expect(browserCalls(dashboard, '/input')[0].body.id).toBe(BROWSER.id);

  // The close button releases the browser and leaves step 2 shown.
  await page.getByTestId('devtools-viewer-close').click();
  await expect(page.getByTestId('devtools-viewer')).toHaveCount(0);
  await expect(startButton(page)).toBeVisible();
  expect(streamCalls(dashboard, 'unsubscribe').map(({ body }) => body.id)).toEqual([BROWSER.id]);
  expect(dashboard.data.devtools.subscriptions[BROWSER.id]).toBeUndefined();

  // So does Esc, and the dialog stays.
  await liveViewButton(page).click();
  await expect(page.getByTestId('devtools-viewer')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('devtools-viewer')).toHaveCount(0);
  await expect(startButton(page)).toBeVisible();
  await expect.poll(() => streamCalls(dashboard, 'unsubscribe').length).toBe(2);
});

test('e2e check: start check hands the browser to the session alone', async ({
  page,
  dashboard,
}) => {
  const claude = await openStepTwo(page, dashboard);
  await liveViewButton(page).click();
  await expect(page.getByTestId('devtools-viewer')).toBeVisible();
  await page.getByTestId('devtools-viewer-close').click();
  await expect(page.getByTestId('devtools-viewer')).toHaveCount(0);

  await startButton(page).click();
  await expect
    .poll(() => bodiesTo(dashboard, '/api/claude/launch'))
    .toEqual([{ key: KEY, phase: 'e2e-ticket-check', browserId: BROWSER.id }]);
  await expect(e2eDialog(page)).toHaveCount(0);
  await expect(page.getByTestId('devtools-viewer')).toHaveCount(0);

  // The viewer let go of the stream before the session started, and nothing drove it afterwards.
  const paths = dashboard.requests.map(({ path }) => path);
  expect(paths.indexOf('/api/devtools/stream/unsubscribe')).toBeGreaterThan(-1);
  expect(paths.indexOf('/api/devtools/stream/unsubscribe')).toBeLessThan(
    paths.indexOf('/api/claude/launch'),
  );
  expect(browserCalls(dashboard, '/input')).toEqual([]);
  // The row shows the session, and the browser is the backend's to stop now.
  await expect(claude.getByTestId('claude-action-e2e')).toBeDisabled();
  await expect(claude.getByTestId('claude-action-goto-e2e')).toBeEnabled();
  await expect(iconOf(page)).toHaveAttribute('data-state', 'working');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('claude-dialog')).toHaveCount(0);
  expect(browserCalls(dashboard, '/stop')).toEqual([]);
});

test('e2e check: a browser stopped before start returns to step 1', async ({ page, dashboard }) => {
  const claude = await openStepTwo(page, dashboard);
  // The browser died between Launch browser and Start.
  dashboard.data.devtools.browsers.find(({ id }) => id === BROWSER.id).status = 'stopped';
  await startButton(page).click();

  await expect(e2eDialog(page).getByText(GONE)).toBeVisible();
  await expect(launchButton(page)).toBeVisible();
  await expect(startButton(page)).toHaveCount(0);
  expect(browserCalls(dashboard, '/stop')).toEqual([]);
  // Nothing started: the row shows no e2e session.
  await page.keyboard.press('Escape');
  await expect(e2eDialog(page)).toHaveCount(0);
  await expect(claude.getByTestId('claude-action-e2e')).toBeEnabled();
  await expect(claude.getByTestId('claude-action-goto-e2e')).toHaveCount(0);
  await expect(claude.getByTestId('claude-action-hint-e2e')).toHaveCount(0);
});

test('e2e check: any other refusal keeps step 2 and the browser', async ({ page, dashboard }) => {
  await openStepTwo(page, dashboard);
  dashboard.data.claude.listing = 'unavailable';
  await startButton(page).click();

  await expect(e2eDialog(page).getByText(UNAVAILABLE)).toBeVisible();
  await expect(startButton(page)).toBeEnabled();
  await expect(e2eDialog(page).getByText(`Port ${BROWSER.port}`)).toBeVisible();
  expect(browserCalls(dashboard, '/stop')).toEqual([]);

  // A retry that succeeds proceeds as a first Start does.
  dashboard.data.claude.listing = 'ok';
  await startButton(page).click();
  await expect(e2eDialog(page)).toHaveCount(0);
  expect(bodiesTo(dashboard, '/api/claude/launch')).toEqual([
    { key: KEY, phase: 'e2e-ticket-check', browserId: BROWSER.id },
    { key: KEY, phase: 'e2e-ticket-check', browserId: BROWSER.id },
  ]);
  expect(browserCalls(dashboard, '/stop')).toEqual([]);
});

test('e2e check: closing after a timed out start leaves the browser alone', async ({
  page,
  dashboard,
}) => {
  await openStepTwo(page, dashboard);
  await page.route('**/api/claude/launch', (route) =>
    route.fulfill({
      status: 502,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'CLAUDE_FAILED', error: 'FAILED', errors: ['timed_out'] }),
    }),
  );
  await startButton(page).click();
  await expect(e2eDialog(page).getByText(/took too long to start/)).toBeVisible();
  await expect(startButton(page)).toBeVisible();

  // The session may exist: the backend stops the browser when it finishes, not the dialog.
  await e2eDialog(page).getByRole('button', { name: 'Close', exact: true }).click();
  await expect(e2eDialog(page)).toHaveCount(0);
  expect(browserCalls(dashboard, '/stop')).toEqual([]);
});

test('e2e check: closing before start stops the browser', async ({ page, dashboard }) => {
  await openBoard(page, dashboard);
  const claude = await openDialog(page);
  const open = () => claude.getByTestId('claude-action-e2e').click();
  const stopped = () => browserCalls(dashboard, '/stop').map(({ body }) => body);
  const launchNext = async (id) => {
    dashboard.data.devtools.nextLaunch = { id, port: BROWSER.port };
    await open();
    await launchButton(page).click();
    await expect(startButton(page)).toBeVisible();
  };

  // At step 1 there is no browser, so nothing is stopped.
  await open();
  await expect(e2eDialog(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(e2eDialog(page)).toHaveCount(0);
  expect(stopped()).toEqual([]);

  // At step 2 each way of closing stops that browser, once.
  await launchNext('b-1a000001');
  await e2eDialog(page).getByRole('button', { name: 'Close', exact: true }).click();
  await expect(e2eDialog(page)).toHaveCount(0);
  expect(stopped()).toEqual([{ id: 'b-1a000001' }]);

  await launchNext('b-1a000002');
  await page.keyboard.press('Escape');
  await expect(e2eDialog(page)).toHaveCount(0);
  expect(stopped()).toEqual([{ id: 'b-1a000001' }, { id: 'b-1a000002' }]);

  await launchNext('b-1a000003');
  await page.mouse.click(4, 4);
  await expect(e2eDialog(page)).toHaveCount(0);
  expect(stopped().map(({ id }) => id)).toEqual(['b-1a000001', 'b-1a000002', 'b-1a000003']);

  // A stop that fails changes nothing for the person: the dialog still closes.
  await page.route('**/api/devtools/browsers/stop', (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'LAUNCH_FAILED', error: 'LAUNCH FAILED', errors: [] }),
    }),
  );
  await launchNext('b-1a000004');
  const failing = page.waitForRequest((request) => request.url().endsWith('/browsers/stop'));
  await e2eDialog(page).getByRole('button', { name: 'Close', exact: true }).click();
  expect((await failing).postDataJSON()).toEqual({ id: 'b-1a000004' });
  await expect(e2eDialog(page)).toHaveCount(0);
});

// A request the page makes is held until `release()`, then answered by the fake API as usual.
async function holdRequest(page, url, method) {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(url, async (route) => {
    if (route.request().method() !== method) return route.fallback();
    await gate;
    return route.fallback();
  });
  return release;
}

test('e2e check: closing while the browser opens still stops it', async ({ page, dashboard }) => {
  const release = await holdRequest(page, '**/api/devtools/browsers', 'POST');
  await openBoard(page, dashboard);
  const claude = await openDialog(page);
  await claude.getByTestId('claude-action-e2e').click();
  await launchButton(page).click();
  await page.keyboard.press('Escape');
  await expect(e2eDialog(page)).toHaveCount(0);

  release();
  await expect
    .poll(() => browserCalls(dashboard, '/stop').map(({ body }) => body))
    .toEqual([{ id: BROWSER.id }]);
});

test('e2e check: closing while the session starts leaves the browser alone', async ({
  page,
  dashboard,
}) => {
  await openStepTwo(page, dashboard);
  const release = await holdRequest(page, '**/api/claude/launch', 'POST');
  await startButton(page).click();
  await page.keyboard.press('Escape');
  await e2eDialog(page).getByRole('button', { name: 'Close', exact: true }).click();
  await expect(e2eDialog(page)).toBeVisible();

  release();
  await expect(e2eDialog(page)).toHaveCount(0);
  expect(browserCalls(dashboard, '/stop')).toEqual([]);
});

test('e2e check: a working session disables the button with a visible reason', async ({
  page,
  dashboard,
}) => {
  await openBoard(page, dashboard, {
    [KEY]: claudeEntry('none', null, { e2e: E2E.working, goTo: sessions(ATTACH) }),
    'TAP-9002': claudeEntry('none', null),
  });
  let dialog = await openDialog(page);
  await expect(dialog.getByTestId('claude-action-e2e')).toBeDisabled();
  await expect(dialog.getByTestId('claude-action-hint-e2e')).toHaveText(RUNNING);
  await expect(dialog.getByTestId('claude-action-goto-e2e')).toBeEnabled();
  await expect(dialog.getByTestId('claude-view-e2e')).toHaveCount(0);
  await expect(dialog.getByTestId('claude-action-investigate')).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('claude-dialog')).toHaveCount(0);

  // No e2e record, no block: the button is open and the workflow buttons are as they were.
  dialog = await openDialog(page, 'TAP-9002');
  await expect(dialog.getByTestId('claude-action-e2e')).toBeEnabled();
  await expect(dialog.getByTestId('claude-action-hint-e2e')).toHaveCount(0);
  await expect(dialog.getByTestId('claude-action-goto-e2e')).toHaveCount(0);
  await expect(dialog.getByTestId('claude-action-investigate')).toBeEnabled();
});

test('e2e check: a finished session shows its chip and result, and leaves the workflow alone', async ({
  page,
  dashboard,
}) => {
  dashboard.data.claude.artifacts[KEY] = { 'e2e.md': 'Verdict: PASS\n\n# E2E check\n' };
  await openBoard(page, dashboard, {
    [KEY]: claudeEntry('none', null, { e2e: E2E.done, goTo: sessions(E2E_RESUME) }),
  });
  const dialog = await openDialog(page);
  await expect(dialog.getByTestId('claude-dialog-state')).toHaveText('not started');
  await expect(dialog.getByTestId('claude-action-e2e')).toBeEnabled();

  const chip = dialog.getByRole('button', { name: 'Go to e2e check session', exact: true });
  await expect(chip).toHaveAttribute('data-testid', 'claude-action-goto-e2e');
  await chip.click();
  await expect(dialog.getByTestId('claude-goto-copied-e2e')).toContainText('Copied');
  expect(await page.evaluate(() => window.__dashboardMock.clipboard.writes)).toEqual([
    E2E_RESUME.command,
  ]);

  await dialog.getByTestId('claude-view-e2e').click();
  await expect(page.getByTestId('artifact-viewer-title')).toContainText('e2e.md');
  await expect(page.getByTestId('artifact-markdown')).toContainText('Verdict: PASS');
  await expect(dialog.getByTestId('claude-dialog-state')).toHaveText('not started');
});

test('e2e check: the card icon follows the e2e session only when nothing else stands in', async ({
  page,
  dashboard,
}) => {
  await openBoard(page, dashboard, {
    // No workflow record, no groom: the icon is the e2e session's.
    'TAP-9002': claudeEntry('none', null, { e2e: E2E.working }),
    // Groom stands in first, whatever the e2e session is.
    'TAP-9003': claudeEntry('none', null, {
      groom: { state: 'working', reason: 'running' },
      e2e: E2E.done,
    }),
    // A workflow record: the workflow's state wins.
    'TAP-9004': claudeEntry('failed', 'ended_without_flag', { e2e: E2E.working }),
  });
  await expect(iconOf(page, 'TAP-9002')).toHaveAttribute('data-state', 'working');
  await expect(iconOf(page, 'TAP-9002')).toHaveAttribute('aria-label', /^Claude e2e check: /);

  await expect(iconOf(page, 'TAP-9003')).toHaveAttribute('data-state', 'working');
  await expect(iconOf(page, 'TAP-9003')).toHaveAttribute('aria-label', /groom/i);
  await expect(iconOf(page, 'TAP-9003')).not.toHaveAttribute('aria-label', /e2e/i);

  await expect(iconOf(page, 'TAP-9004')).toHaveAttribute('data-state', 'failed');
  await expect(iconOf(page, 'TAP-9004')).not.toHaveAttribute('aria-label', /e2e/i);
});
