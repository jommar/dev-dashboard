import { test, expect, listReads, watchListReads, watchRequests } from './fixtures.js';
import { slackWatchData, ticketBoardData, watchLink } from './data.js';

// The Slack screen is the My Tickets screen with Slack's content: one card, one toolbar, one
// board that fills the viewport. `ticketBoardData` seeds two started threads whose last activity
// was an hour ago (one needs a reply), which is all these specs need; only the polling spec moves
// the clock, and by minutes.
test.beforeEach(({ dashboard }) => {
  ticketBoardData(dashboard.data);
});

const boardOf = (page) => page.getByTestId('slack-board');
const threadCards = (page) => page.locator('button[data-testid^="slack-thread-"]');

// A copy of the first seeded thread whose activity time cannot be placed in any group.
function addUnplacedThread({ data }) {
  const [base] = data.slack.threads.started;
  const ts = base.ts.replace('.000100', '.000200');
  const unplaced = {
    ...base,
    ts,
    watchKey: base.watchKey.replace(base.ts, ts),
    activityAt: 'not-a-date',
    needsReply: true,
  };
  data.slack.threads.started.push(unplaced);
  return unplaced;
}

for (const [width, height] of [
  [1440, 900],
  [390, 844],
]) {
  test(`Slack fills the ${width}x${height} viewport with no page scroll`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/#/slack');
    await expect(boardOf(page)).toBeVisible();
    const sizes = await page.evaluate(() => ({
      scrollHeight: document.documentElement.scrollHeight,
      scrollWidth: document.documentElement.scrollWidth,
      innerHeight,
      innerWidth,
    }));
    expect(sizes.scrollHeight).toBeLessThanOrEqual(sizes.innerHeight);
    expect(sizes.scrollWidth).toBeLessThanOrEqual(sizes.innerWidth);
    const box = await boardOf(page).boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(320);
    expect(box.y + box.height).toBeLessThanOrEqual(height);
    // The board reaches the foot of the viewport: only the panel's bottom padding is left.
    expect(height - (box.y + box.height)).toBeLessThanOrEqual(56);
  });
}

test('the toolbar names the account and offers Refresh with a countdown', async ({
  page,
  dashboard,
}) => {
  await page.goto('/#/slack');
  await expect(page.getByTestId('slack-title')).toHaveText('Slack');
  await expect(page.getByTestId('slack-meta')).toContainText('@developer');
  await expect(page.getByTestId('slack-meta')).toContainText('Example Workspace');
  // The account line is a live region, so a sign-in or a disconnect is announced.
  await expect(page.getByTestId('slack-meta').getByRole('status')).toContainText('@developer');
  await expect(page.getByTestId('slack-next')).toHaveText(/refresh in \d+s/);
  const before = listReads(dashboard).length;
  await page.getByTestId('slack-refresh').click();
  await expect.poll(() => listReads(dashboard).length).toBe(before + 1);
});

test('a disconnected Slack keeps Connect Slack in the toolbar, shows one state and asks for no watch', async ({
  page,
  dashboard,
}) => {
  dashboard.data.slack.status = { connected: false, connecting: false };
  await page.goto('/#/slack');
  await expect(page.getByTestId('slack-disconnected')).toBeVisible();
  await expect(page.getByTestId('slack-meta')).toHaveText('Not connected');
  await expect(page.getByTestId('slack-meta').getByRole('status')).toHaveText('Not connected');
  const controls = page.getByTestId('panel-slack').locator('.board-controls');
  await expect(controls.getByRole('button', { name: 'Connect Slack' })).toBeVisible();
  await expect(page.getByTestId('slack-tab-started')).toHaveCount(0);
  await expect(boardOf(page)).toHaveCount(0);
  expect(watchRequests(dashboard)).toEqual([]);
});

test('a thread with no usable activity time is left out of the board, the counts and the reply total', async ({
  page,
  dashboard,
}) => {
  const unplaced = addUnplacedThread(dashboard);
  await page.goto('/#/slack');
  await expect(threadCards(page)).toHaveCount(2);
  await expect(page.getByTestId(`slack-thread-${unplaced.ts}`)).toHaveCount(0);
  await expect(page.getByText('Activity time unavailable')).toHaveCount(0);
  await expect(page.locator('.slack-unknown')).toHaveCount(0);
  await expect(page.getByTestId('slack-tab-started').locator('.board-tab-count')).toHaveText('2');
  // The unplaced thread needs a reply too, which would make the total two.
  await expect(page.getByTestId('slack-threads-meta')).toContainText(
    '1 loaded threads need a reply',
  );
  // Nothing else is wrong with the listing, so this clause alone raises the note.
  await expect(page.getByTestId('slack-coverage')).toContainText(
    '1 loaded thread with no usable activity time is not shown.',
  );
});

test('Watch threads is a third view of the card that swaps with the board and keeps its draft', async ({
  page,
  dashboard,
}) => {
  Object.assign(dashboard.data.slack.threads, { partial: true, continuation: 'next-page' });
  await page.goto('/#/slack');
  const watchTab = page.getByTestId('slack-tab-watch');
  const watchCard = page.getByTestId('slack-watch-card');
  const coverage = page.getByTestId('slack-coverage');
  const loadMore = page.getByRole('button', { name: 'Load more eligible threads' });
  await expect(boardOf(page)).toBeVisible();
  await expect(coverage).toBeVisible();
  await expect(loadMore).toBeVisible();
  await expect(watchCard).toBeHidden();

  await watchTab.click();
  await expect(watchTab).toHaveAttribute('aria-selected', 'true');
  await expect(watchCard).toBeVisible();
  await expect(boardOf(page)).toBeHidden();
  await expect(coverage).toBeHidden();
  await expect(loadMore).toBeHidden();
  const draft = page.getByTestId('slack-watch-links-input');
  await draft.fill('a draft that is not submitted');

  await page.getByTestId('slack-tab-started').click();
  await expect(boardOf(page)).toBeVisible();
  await expect(watchCard).toBeHidden();
  await watchTab.click();
  await expect(draft).toHaveValue('a draft that is not submitted');
});

test('an empty section shows its own message instead of a board', async ({ page, dashboard }) => {
  dashboard.data.slack.threads.started = [];
  await page.goto('/#/slack');
  const empty = page.getByTestId('slack-threads-empty');
  await expect(empty).toHaveText('No started threads loaded in #ezat_claudio.');
  await expect(boardOf(page)).toHaveCount(0);
  await expect(page.getByTestId('slack-tab-started').locator('.board-tab-count')).toHaveText('0');
  await page.getByTestId('slack-tab-mentions').click();
  await expect(empty).toHaveText('No mentions loaded in #ezat_claudio.');
  await expect(boardOf(page)).toHaveCount(0);
});

// Forty links make the watch list far taller than any viewport here.
const manyLinks = () =>
  Array.from({ length: 40 }, (_, index) =>
    watchLink('C0EXAMPLE1', `${1_800_000_000 + index}.000100`),
  );

for (const [width, height] of [
  [1440, 900],
  [390, 844],
]) {
  test(`the Watch view fills the card and scrolls inside itself at ${width}x${height}`, async ({
    page,
    dashboard,
  }) => {
    dashboard.data.slack.watch = slackWatchData({ links: manyLinks() });
    await page.setViewportSize({ width, height });
    await page.goto('/#/slack');
    await page.getByTestId('slack-tab-watch').click();
    await expect(page.locator('[data-testid^="slack-watch-row-"]')).toHaveCount(40);
    const pane = page.getByTestId('slack-watch-card');
    await expect(pane).toBeVisible();
    const sizes = await page.evaluate(() => ({
      scrollHeight: document.documentElement.scrollHeight,
      scrollWidth: document.documentElement.scrollWidth,
      innerHeight,
      innerWidth,
    }));
    expect(sizes.scrollHeight).toBeLessThanOrEqual(sizes.innerHeight);
    expect(sizes.scrollWidth).toBeLessThanOrEqual(sizes.innerWidth);
    // The pane takes the board's place: down to the foot of the viewport, no shorter than the
    // board's floor, and it is the pane that holds the overflow.
    const box = await pane.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(320);
    expect(height - (box.y + box.height)).toBeLessThanOrEqual(56);
    const own = await pane.evaluate((element) => ({
      overflowY: getComputedStyle(element).overflowY,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }));
    expect(own.overflowY).toBe('auto');
    expect(own.scrollHeight).toBeGreaterThan(own.clientHeight);
    // The last control of the pane is below the fold until the pane itself scrolls to it.
    const save = page.getByTestId('slack-watch-settings-save');
    await expect(save).not.toBeInViewport();
    await pane.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(save).toBeInViewport();
    expect(await page.evaluate(() => scrollY)).toBe(0);
  });
}

test('the watcher keeps polling while the Started view is selected', async ({
  page,
  dashboard,
}) => {
  await page.clock.install();
  await page.goto('/#/slack');
  await expect(boardOf(page)).toBeVisible();
  await expect(page.getByTestId('slack-watch-card')).toBeHidden();
  await expect.poll(() => watchListReads(dashboard).length).toBeGreaterThan(0);
  const before = watchListReads(dashboard).length;
  await page.clock.runFor(120_000);
  await expect.poll(() => watchListReads(dashboard).length).toBeGreaterThan(before);
  await expect(page.getByTestId('slack-watch-card')).toBeHidden();
});

test('a Started to Watch to Started round trip returns the board to the column it was on', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/slack');
  const board = boardOf(page);
  await expect(board).toBeVisible();
  await board.evaluate((element) =>
    element.scrollTo({ left: element.scrollWidth, behavior: 'instant' }),
  );
  // The board snaps to a column, so read where it settled rather than assuming an offset.
  await expect.poll(() => board.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  const left = await board.evaluate((element) => element.scrollLeft);
  await page.getByTestId('slack-tab-watch').click();
  await expect(board).toBeHidden();
  await page.getByTestId('slack-tab-started').click();
  await expect(board).toBeVisible();
  await expect.poll(() => board.evaluate((element) => element.scrollLeft)).toBe(left);
});

// Disconnect and a session change from elsewhere both clear the session; the card must reopen on
// its thread view, not on the Watch view it was left on.
const expectOnStartedView = async (page) => {
  await expect(boardOf(page)).toBeVisible();
  await expect(page.getByTestId('slack-tab-started')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('slack-tab-watch')).toHaveAttribute('aria-selected', 'false');
  await expect(page.getByTestId('slack-watch-card')).toBeHidden();
};

test('reconnecting after a disconnect on the Watch view lands on the thread view', async ({
  page,
  dashboard,
}) => {
  await page.clock.install();
  await page.route(
    (url) => url.pathname === '/api/slack/disconnect',
    async (route) => {
      dashboard.data.slack.status = { connected: false, connecting: false };
      await route.fulfill({ json: { ok: true } });
    },
  );
  await page.route(
    (url) => url.pathname === '/api/slack/connect',
    (route) => route.fulfill({ json: { ok: true } }),
  );
  await page.goto('/#/slack');
  await page.getByTestId('slack-tab-watch').click();
  await expect(page.getByTestId('slack-watch-card')).toBeVisible();
  await page.getByTestId('slack-disconnect').click();
  await expect(page.getByTestId('slack-disconnected')).toBeVisible();
  await page.getByTestId('slack-connect').click();
  await expect(page.getByTestId('slack-connecting')).toBeVisible();
  dashboard.data.slack.status = {
    connected: true,
    connecting: false,
    user: 'developer',
    team: 'Example Workspace',
  };
  await page.clock.runFor(2000);
  await expectOnStartedView(page);
});

test('a session change from elsewhere on the Watch view lands on the thread view', async ({
  page,
}) => {
  await page.goto('/#/slack');
  await page.getByTestId('slack-tab-watch').click();
  await expect(page.getByTestId('slack-watch-card')).toBeVisible();
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent('slack-session-changed', { detail: { source: 'another-tab' } }),
    ),
  );
  await expectOnStartedView(page);
});

// What a viewer sees of the shared chrome, read off the panel's own elements.
const chromeOf = (page, panel) =>
  page.getByTestId(`panel-${panel}`).evaluate((root) => {
    const style = (selector) => getComputedStyle(root.querySelector(selector));
    const title = style('.board-title');
    const section = style('.board-section');
    return {
      titleSize: title.fontSize,
      titleWeight: title.fontWeight,
      background: section.backgroundColor,
      radius: section.borderRadius,
      overflowX: style('.board-track').overflowX,
    };
  });

test('Slack and My Tickets share one title, card surface and board scroller', async ({ page }) => {
  await page.goto('/#/slack');
  await expect(boardOf(page)).toBeVisible();
  const slack = await chromeOf(page, 'slack');
  await page.getByTestId('tab-my-tickets').click();
  await expect(page.getByTestId('my-tickets-board')).toBeVisible();
  const tickets = await chromeOf(page, 'my-tickets');
  expect(slack).toEqual(tickets);
  // Equal nothings would pass: the values are real.
  expect(parseFloat(slack.titleSize)).toBeGreaterThan(0);
  expect(parseFloat(slack.radius)).toBeGreaterThan(0);
  expect(slack.overflowX).toMatch(/auto|scroll/);
});

// Refresh is the same control on both board screens: a click goes through the polling hook, so it
// reads the data again and restarts the countdown to the next automatic refresh.
for (const [name, route, pollSeconds] of [
  ['my-tickets', '/#/my-tickets', 90],
  ['slack', '/#/slack', 60],
]) {
  test(`${name}: Refresh restarts the countdown`, async ({ page }) => {
    await page.clock.install();
    await page.goto(route);
    const next = page.getByTestId(`${name}-next`);
    await expect(next).toHaveText(/refresh in \d+s/);
    const seconds = async () => Number((await next.innerText()).match(/\d+/)?.[0]);
    await page.clock.runFor(30_000);
    await expect.poll(seconds).toBeLessThanOrEqual(pollSeconds - 25);
    await page.getByTestId(`${name}-refresh`).click();
    await expect.poll(seconds).toBeGreaterThanOrEqual(pollSeconds - 5);
  });
}
