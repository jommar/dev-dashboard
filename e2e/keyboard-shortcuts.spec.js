import { test, expect, expectTooltip } from './fixtures.js';
import { CHAT_SESSION_ID, claudeEntry, devtoolsFrame, ticketBoardData } from './data.js';

// The global keyboard layer (F9): the command palette (Control+K), `g` chords, the `?` help dialog,
// route-change cues and their guards. Invented data only. The test ids below are a contract:
//   command-palette (the native modal <dialog>), command-palette-input (role=combobox),
//   command-palette-list (role=listbox), command-palette-status (polite result count),
//   command-option-<id> with <id> = tab-<tabId> | session-<botKey> | new-chat | refresh | ticket-<KEY>,
//   shortcuts-help (the help <dialog>), route-announcement (role=status, sr-only).

const TITLE_SUFFIX = ' · EZAT Dev Dashboard';
const TAB_IDS = [
  'home',
  'my-tickets',
  'slack',
  'prs',
  'chat',
  'releases',
  'services',
  'devtools',
  'mascots',
  'settings',
];
const CHAT = '8c1d4e7f-3a2b-4c5d-9e6f-0a1b2c3d4e5f';
const RUNNING = 'b-3f9a2c7d';
const hour = 60 * 60 * 1000;

const palette = (page) => page.getByTestId('command-palette');
const paletteInput = (page) => page.getByTestId('command-palette-input');
const option = (page, id) => page.getByTestId(`command-option-${id}`);
const anyOpenDialog = (page) => page.locator('dialog[open]');
const heading = (page, id) => page.getByTestId(`panel-${id}`).locator('h2').first();

// A Home that has finished loading is the base of most of these.
const load = async (page, route = 'home') => {
  await page.goto(`/#/${route}`);
  await expect(page.getByTestId(`panel-${route.split('?')[0]}`)).toBeVisible();
};
const openPalette = async (page) => {
  await page.keyboard.press('Control+K');
  await expect(palette(page)).toBeVisible();
  await expect(paletteInput(page)).toBeFocused();
};
// An implement bot in the sprint, a review bot outside it, and a finished chat.
const seedSessions = ({ data }) => {
  Object.assign(data.claude.tickets, {
    'BOT-1': claudeEntry('working', 'running', { phase: 'implement-plan' }),
    'BOT-7': claudeEntry('none', null, { review: { state: 'working', reason: 'running' } }),
  });
  data.claude.activeSprint.keys = ['BOT-1'];
  data.claude.chats = [
    {
      id: CHAT,
      title: 'Outline the migration',
      state: 'done',
      createdAt: new Date(Date.now() - 2 * hour).toISOString(),
      lastActiveAt: new Date(Date.now() - hour).toISOString(),
      goTo: { kind: 'resume', command: `cd ~/pathwise && claude --resume ${CHAT}` },
    },
  ];
};
const myTicketsReads = ({ requests }) =>
  requests.filter(({ path }) => path.startsWith('/api/my-tickets')).length;
const velocityReads = ({ requests }) =>
  requests.filter(({ path }) => path.startsWith('/api/team-velocity'));

test('palette opens with Control+K, focuses its input and lists one option per tab', async ({
  page,
}) => {
  await load(page);
  await expect(palette(page)).toBeHidden();
  await openPalette(page);
  await expect(page.locator('[data-testid^="command-option-tab-"]')).toHaveCount(TAB_IDS.length);
  for (const id of TAB_IDS) await expect(option(page, `tab-${id}`)).toBeVisible();
  await expect(option(page, 'tab-my-tickets')).toHaveAccessibleName(/^Go to My Tickets/);
  await expect(option(page, 'tab-my-tickets')).toContainText('g t');
  await expect(option(page, 'new-chat')).toHaveAccessibleName(/^New chat/);
  // Home has no board to refresh.
  await expect(option(page, 'refresh')).toHaveCount(0);
  await expect(page.getByTestId('command-palette-status')).toHaveText(/\d/);
});

test('palette filter and enter go to the first match, close, and focus the new screen', async ({
  page,
}) => {
  await load(page);
  await openPalette(page);
  await page.keyboard.type('rel');
  await expect(option(page, 'tab-releases')).toHaveAttribute('aria-selected', 'true');
  await expect(option(page, 'tab-slack')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/releases$/);
  await expect(page.getByTestId('panel-releases')).toBeVisible();
  await expect(palette(page)).toBeHidden();
  await expect(heading(page, 'releases')).toBeFocused();
});

test('palette sessions list the sprint bots and chats, and open them', async ({
  page,
  dashboard,
}) => {
  seedSessions(dashboard);
  await load(page, 'services');
  await openPalette(page);
  await page.keyboard.type('bot-1');
  const bot = option(page, 'session-BOT-1:implement');
  await expect(bot).toBeVisible();
  await expect(bot).toHaveAccessibleName(/^Open BOT-1 Implement plan session/);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('claude-dialog')).toBeVisible();
  await expect(page.getByTestId('claude-dialog-title')).toContainText('BOT-1');
  await expect(palette(page)).toBeHidden();
  await page.getByTestId('claude-dialog-close').click();
  await expect(page.getByTestId('claude-dialog')).toBeHidden();

  // A session whose ticket is outside the sprint has no option, though it exists.
  await openPalette(page);
  await page.keyboard.type('bot');
  await expect(option(page, 'session-BOT-1:implement')).toBeVisible();
  await expect(option(page, 'session-BOT-7:review')).toHaveCount(0);

  // A chat is named like its drawer row and opens the Chat screen on its session.
  await paletteInput(page).fill('outline');
  const chat = option(page, `session-${CHAT}:chat`);
  await expect(chat).toHaveAccessibleName(/^Open Outline the migration Chat session/);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`#/chat\\?session=${CHAT}$`));
  await expect(palette(page)).toBeHidden();
});

test('palette new chat clears the session from the URL', async ({ page }) => {
  await load(page, `chat?session=${CHAT_SESSION_ID}`);
  await expect(page).toHaveURL(new RegExp(`#/chat\\?session=${CHAT_SESSION_ID}$`));
  await openPalette(page);
  await page.keyboard.type('new chat');
  await expect(option(page, 'new-chat')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/chat$/);
  await expect(palette(page)).toBeHidden();
});

test('palette refresh runs the active board own load, and Home never reads velocity', async ({
  page,
  dashboard,
}) => {
  ticketBoardData(dashboard.data);
  await load(page, 'my-tickets');
  await expect(page.getByTestId('my-tickets-board')).toBeVisible();
  await page.waitForLoadState('networkidle');
  const before = myTicketsReads(dashboard);
  await openPalette(page);
  await page.keyboard.type('refresh');
  await expect(option(page, 'refresh')).toHaveAccessibleName(/^Refresh My Tickets/);
  await page.keyboard.press('Enter');
  await expect.poll(() => myTicketsReads(dashboard)).toBe(before + 1);
  await expect(palette(page)).toBeHidden();
  expect(myTicketsReads(dashboard)).toBe(before + 1);

  // Boards with a Refresh of their own offer it.
  for (const [route, label] of [
    ['slack', 'Slack'],
    ['prs', 'Pull Requests'],
    ['devtools', 'DevTools'],
  ]) {
    await load(page, route);
    // The board registers its refresh when its toolbar renders.
    await expect(page.getByTestId(`${route}-refresh`)).toBeVisible();
    await openPalette(page);
    await page.keyboard.type('refresh');
    await expect(option(page, 'refresh')).toHaveAccessibleName(new RegExp(`^Refresh ${label}`));
    await page.keyboard.press('Escape');
    await expect(palette(page)).toBeHidden();
  }
  // Screens with nothing of their own to refresh offer nothing, and Home is not borrowed for them.
  for (const route of ['home', 'services', 'releases', 'chat', 'mascots']) {
    await load(page, route);
    await openPalette(page);
    await page.keyboard.type('refresh');
    await expect(option(page, 'refresh')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(palette(page)).toBeHidden();
  }
  expect(velocityReads(dashboard)).toEqual([]);
});

test('chord g then a letter goes to a tab, and a wrong letter or a late one goes nowhere', async ({
  page,
}) => {
  await load(page);
  await page.keyboard.press('g');
  await page.keyboard.press('t');
  await expect(page).toHaveURL(/#\/my-tickets$/);
  await expect(page.getByTestId('panel-my-tickets')).toBeVisible();
  await page.keyboard.press('g');
  await page.keyboard.press('h');
  await expect(page).toHaveURL(/#\/home$/);
  await expect(page.getByTestId('panel-home')).toBeVisible();

  // Not a chord letter, and a second g: nowhere.
  await page.keyboard.press('g');
  await page.keyboard.press('x');
  await page.keyboard.press('g');
  await page.keyboard.press('g');
  await page.keyboard.press('x');
  await expect(page).toHaveURL(/#\/home$/);

  // The window is 1.5 s; the only wait in this spec is the one that proves it ends.
  await page.keyboard.press('g');
  await page.waitForTimeout(1700);
  await page.keyboard.press('t');
  await expect(page).toHaveURL(/#\/home$/);
  await expect(page.getByTestId('panel-home')).toBeVisible();
});

test('help opens with ? and lists the shortcuts, and Escape closes it', async ({ page }) => {
  await load(page);
  const help = page.getByTestId('shortcuts-help');
  await expect(help).toBeHidden();
  await page.keyboard.press('?');
  await expect(help).toBeVisible();
  await expect(help).toContainText(/Ctrl|Cmd/);
  await expect(help).toContainText('My Tickets');
  await expect(help).toContainText('Settings');
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();
});

test('typing g t ? in fields changes nothing: composer, PR search and sessions search', async ({
  page,
  dashboard,
}) => {
  seedSessions(dashboard);
  const typeInto = async (field) => {
    await field.click();
    await page.keyboard.type('g t ?');
    await expect(field).toHaveValue('g t ?');
    await expect(anyOpenDialog(page)).toHaveCount(0);
  };

  await load(page, 'chat');
  await typeInto(page.getByLabel('Message'));
  await expect(page).toHaveURL(/#\/chat$/);

  await load(page, 'prs');
  await typeInto(
    page.getByTestId('panel-prs').getByRole('searchbox', { name: 'Search', exact: true }),
  );
  await expect(page).toHaveURL(/#\/prs$/);

  await load(page, 'services');
  await page.getByTestId('sessions-tab').click();
  await expect(page.getByTestId('sessions-drawer')).toBeVisible();
  await typeInto(page.getByTestId('sessions-search'));
  await expect(page).toHaveURL(/#\/services$/);
});

test('palette chord works in the composer and focus returns to it on close', async ({ page }) => {
  await load(page, 'chat');
  const composer = page.getByLabel('Message');
  await composer.click();
  await expect(composer).toBeFocused();
  await page.keyboard.press('Control+K');
  await expect(palette(page)).toBeVisible();
  await expect(paletteInput(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(palette(page)).toBeHidden();
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue('');
});

test('shortcuts are blocked by dialogs: an open ticket dialog keeps Control+K, chords and ? out', async ({
  page,
  dashboard,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  seedSessions(dashboard);
  await load(page, 'services');
  await page.getByRole('button', { name: 'BOT-1 implement: working' }).click();
  const dialog = page.getByTestId('claude-dialog');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Control+K');
  await page.keyboard.press('g');
  await page.keyboard.press('t');
  await page.keyboard.press('?');
  await expect(palette(page)).toBeHidden();
  await expect(page.getByTestId('shortcuts-help')).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(anyOpenDialog(page)).toHaveCount(1);
  await expect(page).toHaveURL(/#\/services$/);
  await page.getByTestId('claude-dialog-close').click();
  await expect(dialog).toBeHidden();
  // With it closed the layer is back.
  await openPalette(page);
});

// -- the DevTools viewer (see devtools.spec.js for the same helpers) -----------------------------

const emitScreencast = (page, type, payload) =>
  page.evaluate(
    ([name, value]) => window.__dashboardMock.screencasts.at(-1).emit(name, value),
    [
      type,
      type === 'target'
        ? { id: RUNNING, targetId: payload.id, title: payload.title, url: payload.url }
        : { id: RUNNING, ...payload },
    ],
  );
const forwardedKeys = ({ data }) =>
  data.devtools.calls
    .filter(({ path }) => path === '/api/devtools/browsers/input')
    .map(({ body }) => body.event)
    .filter((event) => event.type === 'keyDown' && event.key);

test('screencast control keeps its keys: Control+K, g, t and ? are forwarded, not handled', async ({
  page,
  dashboard,
}) => {
  await load(page, 'devtools');
  await expect.poll(() => dashboard.data.devtools.subscriptions[RUNNING]).toBe('tile');
  await page.getByTestId(`devtools-open-${RUNNING}`).click();
  await expect(page.getByTestId('devtools-viewer')).toBeVisible();
  await emitScreencast(page, 'status', { status: 'live', reason: '' });
  await emitScreencast(page, 'target', {
    id: 'T1',
    title: 'Home',
    url: 'https://example.invalid/home',
  });
  await emitScreencast(page, 'frame', devtoolsFrame());
  await expect(page.getByTestId('devtools-viewer-status')).toHaveText('Live');
  await page.getByTestId('devtools-viewer-control').click();
  await expect(page.getByTestId('devtools-viewer-control')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('devtools-viewer-stage')).toHaveAttribute('data-control', 'true');
  await page.getByTestId('devtools-viewer-stage').focus();

  await page.keyboard.press('Control+K');
  await page.keyboard.press('g');
  await page.keyboard.press('t');
  await page.keyboard.press('?');
  await expect
    .poll(() => forwardedKeys(dashboard).map(({ key }) => key.toLowerCase()))
    .toEqual(expect.arrayContaining(['control', 'k', 'g', 't', '?']));
  await expect(palette(page)).toBeHidden();
  await expect(page.getByTestId('shortcuts-help')).toBeHidden();
  await expect(page).toHaveURL(/#\/devtools$/);
  await expect(page.getByTestId('devtools-viewer')).toBeVisible();
});

test('typed ticket key offers the deep link and opens that ticket through My Tickets', async ({
  page,
  dashboard,
}) => {
  ticketBoardData(dashboard.data);
  // The hash the palette goes through: replaceState (the deep link's cleanup) fires no event.
  await page.addInitScript(() => {
    window.__hashes = [];
    window.addEventListener('hashchange', (event) =>
      window.__hashes.push(new URL(event.newURL).hash),
    );
  });
  await load(page);
  await openPalette(page);
  await page.keyboard.type('tap-9001');
  const offered = option(page, 'ticket-TAP-9001');
  await expect(offered).toHaveAccessibleName(/^Open TAP-9001 in My Tickets/);
  await expect(offered).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('claude-dialog')).toBeVisible();
  await expect(page.getByTestId('claude-dialog-title')).toContainText('TAP-9001');
  await expect(page).toHaveURL(/#\/my-tickets$/);
  expect(await page.evaluate(() => window.__hashes)).toContain('#/my-tickets?ticket=TAP-9001');
});

test('typed text that is not a ticket key offers no ticket option', async ({ page }) => {
  await load(page);
  await openPalette(page);
  await page.keyboard.type('tap');
  await expect(page.locator('[data-testid^="command-option-ticket-"]')).toHaveCount(0);
});

test('route cues: title and announcement follow the screen, and first load announces nothing', async ({
  page,
  dashboard,
}) => {
  ticketBoardData(dashboard.data);
  await load(page);
  const announcement = page.getByTestId('route-announcement');
  await expect(page).toHaveTitle(`Home${TITLE_SUFFIX}`);
  await expect(announcement).toHaveAttribute('role', 'status');
  await expect(announcement).toHaveText('');

  await page.getByTestId('tab-my-tickets').click();
  await expect(page).toHaveTitle(`My Tickets${TITLE_SUFFIX}`);
  await expect(announcement).toHaveText('My Tickets');
  await page.getByTestId('tab-slack').click();
  await expect(page).toHaveTitle(`Slack${TITLE_SUFFIX}`);
  await expect(announcement).toHaveText('Slack');
});

test('focus moves to the new heading only when it was lost, and tab tooltips show the chord', async ({
  page,
}) => {
  await load(page);
  // Lost focus (a chord from the body): the new screen's heading takes it.
  await expect.poll(() => page.evaluate(() => document.activeElement === document.body)).toBe(true);
  await page.keyboard.press('g');
  await page.keyboard.press('s');
  await expect(page).toHaveURL(/#\/slack$/);
  await expect(heading(page, 'slack')).toBeFocused();
  await expect(heading(page, 'slack')).toHaveAttribute('tabindex', '-1');

  // Held by a tab link: left there (navigation.spec.js expects the same of the Tools toggle).
  const link = page.getByTestId('tab-my-tickets');
  await link.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/my-tickets$/);
  await expect(page.getByTestId('panel-my-tickets')).toBeVisible();
  await expect(link).toBeFocused();

  // A focused tab link shows its own tooltip, so let go of it before hovering the others.
  await page.evaluate(() => document.activeElement.blur());
  await expectTooltip(page, page.getByTestId('tab-slack'), 'Slack (g then s)');
  await expectTooltip(page, link, 'My Tickets (g then t)');
});

test('no requests: the palette, chords to the same tab and help add none, and velocity is never read', async ({
  page,
  dashboard,
}) => {
  await load(page);
  await page.waitForLoadState('networkidle');
  const before = dashboard.requests.length;
  await openPalette(page);
  await page.keyboard.type('sla');
  await page.keyboard.press('Escape');
  await expect(palette(page)).toBeHidden();
  await page.keyboard.press('?');
  await expect(page.getByTestId('shortcuts-help')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('shortcuts-help')).toBeHidden();
  await page.keyboard.press('g');
  await page.keyboard.press('h');
  await expect(page).toHaveURL(/#\/home$/);
  await openPalette(page);
  await page.keyboard.press('Escape');
  await expect(palette(page)).toBeHidden();
  // No API read; the palette and help chunks themselves load on their first use (static assets).
  expect(dashboard.requests.slice(before).filter(({ path }) => path.startsWith('/api/'))).toEqual(
    [],
  );
  expect(velocityReads(dashboard)).toEqual([]);
});

test('palette semantics: combobox, listbox, options, active descendant, modal and Escape', async ({
  page,
}) => {
  await load(page);
  await openPalette(page);
  const input = paletteInput(page);
  const list = page.getByTestId('command-palette-list');
  await expect(input).toHaveAttribute('role', 'combobox');
  await expect(input).toHaveAttribute('aria-expanded', 'true');
  await expect(list).toHaveAttribute('role', 'listbox');
  const listId = await list.getAttribute('id');
  expect(listId).toBeTruthy();
  await expect(input).toHaveAttribute('aria-controls', listId);
  const options = list.getByRole('option');
  await expect(options).toHaveCount(TAB_IDS.length + 1);
  const ids = await options.evaluateAll((all) => all.map((el) => el.id));
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.every(Boolean)).toBe(true);

  // First is selected on open; the arrows move the selection and the active descendant, and wrap.
  const active = async () => {
    const id = await input.getAttribute('aria-activedescendant');
    return ids.indexOf(id);
  };
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
  expect(await active()).toBe(0);
  await page.keyboard.press('ArrowDown');
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'false');
  expect(await active()).toBe(1);
  await page.keyboard.press('ArrowUp');
  expect(await active()).toBe(0);
  await page.keyboard.press('ArrowUp');
  await expect(options.last()).toHaveAttribute('aria-selected', 'true');
  expect(await active()).toBe(ids.length - 1);
  await page.keyboard.press('ArrowDown');
  expect(await active()).toBe(0);

  // Filtering narrows the list, resets the selection to the first match and says how many.
  await page.keyboard.type('mascot');
  await expect(options).toHaveCount(1);
  await expect(options.first()).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('command-palette-status')).toHaveText(/1/);

  // Modal, and never inside the bot strip.
  expect(await palette(page).evaluate((el) => el.matches(':modal'))).toBe(true);
  await expect(page.getByTestId('bot-bar').getByTestId('command-palette')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(palette(page)).toBeHidden();
});

// -- fixes after review: backdrop, popups, Control+K --------------------------------------------

test('a drag from the palette input released on the backdrop keeps it open; a plain backdrop click closes it', async ({
  page,
}) => {
  await load(page);
  await openPalette(page);
  await page.keyboard.type('sla');
  const box = await paletteInput(page).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(8, 8, { steps: 4 });
  await page.mouse.up();
  await expect(palette(page)).toBeVisible();
  await expect(paletteInput(page)).toHaveValue('sla');
  await page.mouse.click(8, 8);
  await expect(palette(page)).toBeHidden();
});

test('a click on the help dialog padding keeps it open; a backdrop click closes it', async ({
  page,
}) => {
  await load(page);
  const help = page.getByTestId('shortcuts-help');
  await page.keyboard.press('?');
  await expect(help).toBeVisible();
  await help.click({ position: { x: 6, y: 6 } });
  await expect(help).toBeVisible();
  await page.mouse.click(8, 8);
  await expect(help).toBeHidden();
});

test('chords and ? are ignored while the Services Actions menu is open', async ({ page }) => {
  await load(page, 'services');
  const trigger = page.locator('[data-testid^="service-actions-"]').first();
  await trigger.click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('g');
  await page.keyboard.press('s');
  await page.keyboard.press('?');
  await expect(page).toHaveURL(/#\/services$/);
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(page.getByTestId('shortcuts-help')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menuitem')).toHaveCount(0);
  await page.keyboard.press('g');
  await page.keyboard.press('s');
  await expect(page).toHaveURL(/#\/slack$/);
});

// dispatchEvent returns false when a listener called preventDefault.
const controlK = (page, init = {}, selector = 'body') =>
  page.evaluate(
    ([extra, target]) =>
      !document.querySelector(target).dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'k',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
          ...extra,
        }),
      ),
    [init, selector],
  );

test('Control+K is always default-prevented: closed, open in the palette, open in the help and on repeat', async ({
  page,
}) => {
  await load(page);
  expect(await controlK(page)).toBe(true);
  await expect(palette(page)).toBeVisible();
  expect(await controlK(page, {}, '[data-testid="command-palette-input"]')).toBe(true);
  expect(await controlK(page, { repeat: true }, '[data-testid="command-palette-input"]')).toBe(
    true,
  );
  await page.keyboard.press('Escape');
  await expect(palette(page)).toBeHidden();
  expect(await controlK(page, { repeat: true })).toBe(true);
  await page.keyboard.press('?');
  await expect(page.getByTestId('shortcuts-help')).toBeVisible();
  expect(await controlK(page, {}, '[data-testid="shortcuts-help"]')).toBe(true);
});
