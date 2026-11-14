import { test, expect } from './fixtures.js';
import { claudeEntry, ticketBoardData } from './data.js';

// The token total in the Claude dialog's header (the usage route and hook are covered by their own
// tests): one request per open carrying every phase's session id, none while the dialog is closed
// and none from the bot bar, and nothing shown for a ticket with no session or an empty tally.
//   TAP-9001  investigate and implement sessions, tokens used
//   TAP-9002  a session with an empty tally: no total
//   TAP-9003  no session ids: no request at all

const KEY = 'TAP-9001';
const INVESTIGATE_SESSION = '3f2b8c1e-5d4a-4e7b-9c60-1a2b3c4d5e6f';
const IMPLEMENT_SESSION = '7d1e4a90-2b3c-4f58-8a6e-9c0d1e2f3a4b';
const OTHER_SESSION = '5b9d3c21-7e4f-4a08-9d16-2c3b4a5f6e70';
const usage = (tokens, complete = true) => ({
  tokens,
  models: { 'claude-sonnet-5-5': 3 },
  messages: 3,
  complete,
});

async function openBoard(page, dashboard) {
  ticketBoardData(dashboard.data);
  Object.assign(dashboard.data.claude.tickets, {
    [KEY]: claudeEntry('working', 'running'),
    'TAP-9002': claudeEntry('working', 'running'),
    'TAP-9003': claudeEntry('working', 'running'),
  });
  dashboard.data.claude.sessionIds = {
    [KEY]: { investigate: INVESTIGATE_SESSION, implement: IMPLEMENT_SESSION },
    'TAP-9002': { investigate: OTHER_SESSION },
  };
  dashboard.data.claude.usage.sessions[INVESTIGATE_SESSION] = usage({
    input: 900,
    output: 200,
    cacheRead: 100_000,
    cacheCreation: 0,
  });
  dashboard.data.claude.usage.sessions[IMPLEMENT_SESSION] = usage({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 1_100_000,
  });
  await page.goto('/#/my-tickets');
  await expect(page.getByTestId(`my-tickets-item-${KEY}`)).toBeVisible();
}

test('dialog total: the header shows the tokens of every session of the ticket, asked for once per open', async ({
  page,
  dashboard,
}) => {
  await openBoard(page, dashboard);
  expect(dashboard.data.claude.usage.asks, 'nothing is read while no dialog is open').toEqual([]);

  await page.getByTestId(`claude-icon-${KEY}`).click();
  const dialog = page.getByTestId('claude-dialog');
  await expect(dialog.getByTestId('claude-usage-total')).toHaveText('~1.2M tokens');
  expect(dashboard.data.claude.usage.asks).toEqual([[INVESTIGATE_SESSION, IMPLEMENT_SESSION]]);
  // The tally sits in the header, with the key and the state.
  expect(
    await dialog
      .getByTestId('claude-usage-total')
      .evaluate((el) => el.closest('.claude-dialog-head') !== null),
  ).toBe(true);

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.getByTestId(`claude-icon-${KEY}`).click();
  await expect(page.getByTestId('claude-usage-total')).toBeVisible();
  expect(dashboard.data.claude.usage.asks).toHaveLength(2);
});

test('dialog total: an empty tally or no session shows no total, and a lower bound says so', async ({
  page,
  dashboard,
}) => {
  await openBoard(page, dashboard);
  dashboard.data.claude.usage.sessions[IMPLEMENT_SESSION] = usage(
    { input: 0, output: 0, cacheRead: 0, cacheCreation: 1_100_000 },
    false,
  );

  await page.getByTestId('claude-icon-TAP-9002').click();
  await expect(page.getByTestId('claude-dialog')).toBeVisible();
  await expect.poll(() => dashboard.data.claude.usage.asks).toEqual([[OTHER_SESSION]]);
  await expect(page.getByTestId('claude-usage-total')).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.getByTestId('claude-icon-TAP-9003').click();
  await expect(page.getByTestId('claude-dialog')).toBeVisible();
  await expect(page.getByTestId('claude-usage-total')).toHaveCount(0);
  expect(dashboard.data.claude.usage.asks, 'no session id, no request').toHaveLength(1);
  await page.keyboard.press('Escape');

  await page.getByTestId(`claude-icon-${KEY}`).click();
  await expect(page.getByTestId('claude-usage-total')).toHaveText('at least 1.2M tokens');
});

test('dialog total: the bot bar never asks for usage', async ({ page, dashboard }) => {
  Object.assign(dashboard.data.claude.tickets, { [KEY]: claudeEntry('working', 'running') });
  dashboard.data.claude.activeSprint.keys = [KEY];
  dashboard.data.claude.sessionIds = { [KEY]: { investigate: INVESTIGATE_SESSION } };
  await page.goto('/#/home');
  await expect(page.getByTestId('bot-bar')).toBeVisible();
  await expect(page.getByTestId(`bot-bar-bot-${KEY}-investigate`)).toBeVisible();
  expect(dashboard.data.claude.usage.asks).toEqual([]);
});
