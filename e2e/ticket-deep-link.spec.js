import { test, expect } from './fixtures.js';
import { ticketBoardData } from './data.js';

// `#/my-tickets?ticket=<KEY>` opens that ticket's Claude dialog once the board has loaded, then the
// URL drops the query. Only tickets the board lists (assigned to the user) open; an unlisted one gets
// a note; anything that is not a key is ignored. TAP-9001 is assigned in `ticketBoardData`;
// TAP-1 is not. Invented data only.

const dialog = (page) => page.getByTestId('claude-dialog');
const board = (page) => page.getByTestId('my-tickets-board');
const missing = (page) => page.getByTestId('my-tickets-ticket-missing');

test.beforeEach(({ dashboard }) => {
  ticketBoardData(dashboard.data);
});

test('a ticket link opens the dialog after the load, drops the query, and closing does not reopen it', async ({
  page,
}) => {
  await page.goto('/#/my-tickets?ticket=TAP-9001');
  await expect(board(page)).toBeVisible();
  await expect(dialog(page)).toBeVisible();
  await expect(page.getByTestId('claude-dialog-title')).toContainText('TAP-9001');
  await expect(page).toHaveURL(/#\/my-tickets$/);
  await expect(missing(page)).toHaveCount(0);

  await page.getByTestId('claude-dialog-close').click();
  await expect(dialog(page)).toBeHidden();
  await expect(page).toHaveURL(/#\/my-tickets$/);
  // Leaving and coming back by the plain route is not a request either.
  await page.getByTestId('tab-slack').click();
  await expect(page.getByTestId('panel-slack')).toBeVisible();
  await page.getByTestId('tab-my-tickets').click();
  await expect(board(page)).toBeVisible();
  await expect(dialog(page)).toBeHidden();
});

test('a lower-case ticket key opens the dialog too', async ({ page }) => {
  await page.goto('/#/my-tickets?ticket=tap-9001');
  await expect(dialog(page)).toBeVisible();
  await expect(page.getByTestId('claude-dialog-title')).toContainText(/TAP-9001/i);
  await expect(page).toHaveURL(/#\/my-tickets$/);
});

test('an unknown ticket (not assigned) shows the note and opens no dialog', async ({ page }) => {
  await page.goto('/#/my-tickets?ticket=TAP-1');
  await expect(board(page)).toBeVisible();
  await expect(missing(page)).toBeVisible();
  await expect(dialog(page)).toBeHidden();
});

for (const junk of ['not-a-key', 'TAP-9001;x']) {
  test(`unknown junk "${junk}" is ignored: no note, no dialog, the query is dropped`, async ({
    page,
  }) => {
    await page.goto(`/#/my-tickets?ticket=${junk}`);
    await expect(board(page)).toBeVisible();
    await expect(page).toHaveURL(/#\/my-tickets$/);
    await expect(missing(page)).toHaveCount(0);
    await expect(dialog(page)).toBeHidden();
  });
}

test('unknown placement: a ticket query on Home is dropped and opens nothing', async ({ page }) => {
  await page.goto('/#/home?ticket=TAP-9001');
  await expect(page.getByTestId('panel-home')).toBeVisible();
  await expect(page).toHaveURL(/#\/home$/);
  await expect(dialog(page)).toBeHidden();
  await expect(missing(page)).toHaveCount(0);
});

test('a ticket assigned after the board last loaded is found once the activation load lands, not reported missing', async ({
  page,
  dashboard,
}) => {
  await page.clock.install();
  await page.goto('/#/my-tickets');
  await expect(board(page)).toBeVisible();
  await page.getByTestId('tab-slack').click();
  await expect(page.getByTestId('panel-slack')).toBeVisible();
  // The list changes while My Tickets is not shown, and more than a poll interval passes.
  dashboard.data.tickets.tickets.push({
    ...dashboard.data.tickets.tickets[0],
    key: 'TAP-9777',
    summary: 'Invented late assignment',
  });
  await page.clock.fastForward(5 * 60 * 1000);
  await page.evaluate(() => {
    location.hash = '#/my-tickets?ticket=TAP-9777';
  });
  await expect(dialog(page)).toBeVisible();
  await expect(page.getByTestId('claude-dialog-title')).toContainText('TAP-9777');
  await expect(missing(page)).toHaveCount(0);
});
