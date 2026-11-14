import { test, expect } from './fixtures.js';
import { claudeEntry } from './data.js';

// F15 deferred surface: each Sessions drawer row says the tokens its session used. Asked for only while
// the drawer is open (one request per batch of eight sessions), never from the bar or the tickets poll.
//   TAP-9101  implement session working, tokens used
//   TAP-9102  implement session with an empty tally: no label
//   TAP-9103  review session, no session id: no label, no request for it
const A = '3f2b8c1e-5d4a-4e7b-9c60-1a2b3c4d5e6f';
const B = '7d1e4a90-2b3c-4f58-8a6e-9c0d1e2f3a4b';
const tally = (tokens, complete = true) => ({
  tokens,
  models: { 'claude-sonnet-5-5': 2 },
  messages: 2,
  complete,
});
const NONE = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

async function seed(page, { data }) {
  Object.assign(data.claude.tickets, {
    'TAP-9101': claudeEntry('working', 'running', { phase: 'implement-plan' }),
    'TAP-9102': claudeEntry('working', 'running', { phase: 'implement-plan' }),
    'TAP-9103': claudeEntry('none', null, { review: { state: 'working', reason: 'running' } }),
  });
  data.claude.activeSprint.keys = ['TAP-9101', 'TAP-9102', 'TAP-9103'];
  data.claude.sessionIds = { 'TAP-9101': { implement: A }, 'TAP-9102': { implement: B } };
  data.claude.usage.sessions[A] = tally({
    input: 900,
    output: 200,
    cacheRead: 100_000,
    cacheCreation: 0,
  });
  data.claude.usage.sessions[B] = tally(NONE);
  await page.goto('/#/home');
  await expect(page.getByTestId('bot-bar-bot-TAP-9101-implement')).toBeVisible();
}

test('drawer usage: a row shows its tokens, a session with none or no id shows nothing', async ({
  page,
  dashboard,
}) => {
  await seed(page, dashboard);
  expect(dashboard.data.claude.usage.asks, 'nothing is read while the drawer is shut').toEqual([]);
  await page.getByTestId('sessions-tab').click();
  await expect(page.getByTestId('sessions-usage-TAP-9101:implement')).toHaveText('~101.1k tokens');
  await expect(page.getByTestId('sessions-usage-TAP-9102:implement')).toHaveCount(0);
  await expect(page.getByTestId('sessions-usage-TAP-9103:review')).toHaveCount(0);
  expect(dashboard.data.claude.usage.asks).toEqual([[A, B]]);
  // The row's name is unchanged; the tokens are its description with the time.
  const open = page.getByTestId('sessions-open-TAP-9101:implement');
  await expect(open).toHaveAccessibleName('Open TAP-9101 Implement plan session');
  await expect(page.getByTestId('sessions-row-TAP-9101:implement')).toContainText('~101.1k tokens');
});

test('drawer usage: asked again on each open, never by the bar, and an incomplete tally says at least', async ({
  page,
  dashboard,
}) => {
  await seed(page, dashboard);
  dashboard.data.claude.usage.sessions[A] = tally(
    { input: 0, output: 0, cacheRead: 0, cacheCreation: 1_100_000 },
    false,
  );
  await page.getByTestId('sessions-tab').click();
  await expect(page.getByTestId('sessions-usage-TAP-9101:implement')).toHaveText(
    'at least 1.1M tokens',
  );
  // The whole qualifier is readable, not cut by the fixed column, at desktop and phone width.
  const usage = page.getByTestId('sessions-usage-TAP-9101:implement');
  const fits = () => usage.evaluate((el) => el.scrollWidth <= el.clientWidth);
  expect(await fits(), 'desktop width').toBe(true);
  await page.setViewportSize({ width: 360, height: 800 });
  expect(await fits(), '360px wide').toBe(true);
  await page.getByTestId('sessions-close').click();
  await expect(page.getByTestId('sessions-drawer')).toBeHidden();
  expect(dashboard.data.claude.usage.asks).toHaveLength(1);
  await page.getByTestId('sessions-tab').click();
  await expect.poll(() => dashboard.data.claude.usage.asks.length).toBe(2);
});

test('drawer usage: no session rows, no request', async ({ page, dashboard }) => {
  await page.goto('/#/home');
  await page.getByTestId('sessions-tab').click();
  await expect(page.getByTestId('sessions-empty')).toBeVisible();
  expect(dashboard.data.claude.usage.asks).toEqual([]);
});
