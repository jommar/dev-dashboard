import { test, expect, expectTooltip, watchListReads } from './fixtures.js';
import {
  WATCH_DEFAULT_TEMPLATE,
  slackWatchData,
  ticketBoardData,
  watchDelivery,
  watchLink,
  watchPermalink,
  watchSession,
} from './data.js';

// The Slack card's switch (Threads I started, Mentions, Watch threads) is a real tab set: each tab
// controls the card's body, only the selected tab is a Tab stop, and the arrow keys walk the row.
// The Watch tab also carries what the watcher is doing, so a paused or failing watcher shows while
// another view is selected. `ticketBoardData` seeds two started threads, so the board has cards.
test.beforeEach(({ dashboard }) => {
  ticketBoardData(dashboard.data);
});

const CHANNEL = 'C0EXAMPLE1';
const SESSION = '11111111-1111-4111-8111-111111111111';
const IDS = ['started', 'mentions', 'watch'];
const tab = (page, id) => page.getByTestId(`slack-tab-${id}`);
const boardOf = (page) => page.getByRole('region', { name: /slack.*board/i });

const openSlack = async (page) => {
  await page.goto('/#/slack');
  await expect(boardOf(page)).toBeVisible();
};

test('the tabs and the body they switch are tied together for assistive technology', async ({
  page,
}) => {
  await openSlack(page);
  await expect(page.getByRole('tablist', { name: 'Slack lists' }).getByRole('tab')).toHaveCount(3);
  // One body serves every tab, because the views are swapped inside it.
  const panel = page.getByRole('tabpanel');
  await expect(panel).toHaveCount(1);
  const panelId = await panel.getAttribute('id');
  expect(panelId).toBeTruthy();
  const tabIds = [];
  for (const id of IDS) {
    await expect(tab(page, id)).toHaveAttribute('aria-controls', panelId);
    tabIds.push(await tab(page, id).getAttribute('id'));
  }
  expect(tabIds.every(Boolean) && new Set(tabIds).size === IDS.length).toBe(true);

  const names = { started: /^Threads I started/, mentions: /^Mentions/, watch: /^Watch threads/ };
  for (const [index, id] of IDS.entries()) {
    await tab(page, id).click();
    await expect(panel).toHaveAttribute('aria-labelledby', tabIds[index]);
    await expect(panel).toHaveAccessibleName(names[id]);
  }
  // The Watch pane is inside that body, and the board keeps the region name the specs find it by.
  await expect(panel.getByTestId('slack-watch-card')).toBeVisible();
  await tab(page, 'started').click();
  await expect(panel.getByRole('region', { name: 'Slack activity board' })).toBeVisible();
});

test('only the selected tab is a Tab stop', async ({ page }) => {
  await openSlack(page);
  const tabindexes = async () =>
    Promise.all(IDS.map((id) => tab(page, id).getAttribute('tabindex')));
  expect(await tabindexes()).toEqual(['0', '-1', '-1']);

  // Tab from the control before the row lands on the selected tab and leaves the row after it.
  await page.getByTestId('slack-refresh').focus();
  await page.keyboard.press('Tab');
  await expect(tab(page, 'started')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('slack-board')).toBeFocused();

  await tab(page, 'mentions').click();
  await expect(tab(page, 'mentions')).toHaveAttribute('aria-selected', 'true');
  expect(await tabindexes()).toEqual(['-1', '0', '-1']);
  await tab(page, 'watch').click();
  expect(await tabindexes()).toEqual(['-1', '-1', '0']);
});

test('arrow keys, Home and End move along the tabs and select the one they reach', async ({
  page,
}) => {
  await openSlack(page);
  await tab(page, 'started').focus();
  // Focus and selection move together: the tab reached is focused and the only one selected.
  const reaches = async (key, id) => {
    await page.keyboard.press(key);
    await expect(tab(page, id)).toBeFocused();
    for (const other of IDS)
      await expect(tab(page, other)).toHaveAttribute('aria-selected', String(other === id));
  };
  await reaches('ArrowRight', 'mentions');
  await reaches('ArrowRight', 'watch');
  await expect(page.getByTestId('slack-watch-card')).toBeVisible();
  await expect(boardOf(page)).toBeHidden();
  await reaches('ArrowRight', 'started');
  await expect(boardOf(page)).toBeVisible();
  await expect(page.getByTestId('slack-watch-card')).toBeHidden();
  await reaches('ArrowLeft', 'watch');
  await reaches('ArrowLeft', 'mentions');
  await reaches('End', 'watch');
  await reaches('Home', 'started');

  // Keys that are not the tabs' own, and a browser shortcut that uses an arrow, change nothing.
  for (const key of ['ArrowDown', 'ArrowUp', 'Alt+ArrowRight']) await reaches(key, 'started');
});

test('a tab reached by focus alone moves from where it is, not from the selected tab', async ({
  page,
}) => {
  await openSlack(page);
  await tab(page, 'watch').focus();
  await expect(tab(page, 'started')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(tab(page, 'mentions')).toBeFocused();
  await expect(tab(page, 'mentions')).toHaveAttribute('aria-selected', 'true');
});

// The watcher's state on the Watch tab while Started is selected. The data is the card's own
// poll, so the tab needs no read of its own.
const watched = (...links) => links.map((index) => watchLink(CHANNEL, `1761900${index}00.000100`));
const paused = (links) =>
  slackWatchData({
    links,
    settings: { intervalSeconds: 180, noticeTemplate: WATCH_DEFAULT_TEMPLATE, paused: true },
  });
const withDelivery = (status) =>
  watched(1).map((link) => ({
    ...link,
    sessions: [
      watchSession(SESSION, watchDelivery(status, 'append_failed', '2026-10-31T08:59:00.000Z')),
    ],
  }));

const WATCH_TABS = [
  [
    'a healthy watcher shows its count and no warning',
    () => slackWatchData({ links: watched(1, 2) }),
    2,
    '',
  ],
  [
    'a delivered session is healthy',
    () => slackWatchData({ links: withDelivery('delivered') }),
    1,
    '',
  ],
  [
    'a paused watcher shows its count and a warning',
    () => paused(watched(1, 2, 3)),
    3,
    'Watcher paused',
  ],
  [
    'a disabled watcher shows a warning',
    () => slackWatchData({ disabledReason: 'claude_home_unreadable', links: watched(1) }),
    1,
    'Watcher disabled',
  ],
  [
    'a transient delivery failure shows a warning',
    () => slackWatchData({ links: withDelivery('failed-transient') }),
    1,
    'A delivery is failing',
  ],
  [
    'a permanent delivery failure shows a warning',
    () => slackWatchData({ links: withDelivery('failed-permanent') }),
    1,
    'A delivery is failing',
  ],
  ['an empty watch list shows zero', () => slackWatchData(), 0, ''],
];

for (const [name, watch, count, attention] of WATCH_TABS) {
  test(`Watch tab, Started selected: ${name}`, async ({ page, dashboard }) => {
    dashboard.data.slack.watch = watch();
    await openSlack(page);
    const watchTab = tab(page, 'watch');
    await expect(tab(page, 'started')).toHaveAttribute('aria-selected', 'true');
    await expect(watchTab.locator('.board-tab-count')).toHaveText(String(count));
    // The tab is fed by the card's own read: still the only one.
    expect(watchListReads(dashboard)).toHaveLength(1);
    if (attention) {
      await expect(watchTab).toHaveAttribute('data-tone', 'warn');
      // The warning is a sentence too, not only a colour: named for a screen reader and on hover.
      await expect(watchTab).toHaveAccessibleName(new RegExp(`${attention}$`));
      await expectTooltip(page, watchTab, attention);
      const color = await watchTab
        .locator('.board-tab-count')
        .evaluate((node) => getComputedStyle(node).color);
      const muted = await tab(page, 'mentions')
        .locator('.board-tab-count')
        .evaluate((node) => getComputedStyle(node).color);
      expect(color).not.toBe(muted);
    } else {
      await expect(watchTab).not.toHaveAttribute('data-tone', /.+/);
      await expect(watchTab).toHaveAccessibleName(/^Watch threads\s*\d*$/);
      await watchTab.hover();
      await expect(page.getByRole('tooltip')).toHaveCount(0);
    }
  });
}

test('the Watch tab follows the card: a resumed watcher and a new link update it from another view', async ({
  page,
  dashboard,
}) => {
  dashboard.data.slack.watch = paused(watched(1));
  await openSlack(page);
  const watchTab = tab(page, 'watch');
  await expect(watchTab).toHaveAttribute('data-tone', 'warn');
  await expect(watchTab.locator('.board-tab-count')).toHaveText('1');

  await watchTab.click();
  await page.getByTestId('slack-watch-resume').click();
  await page
    .getByTestId('slack-watch-links-input')
    .fill(watchPermalink(CHANNEL, '1761900200.000100'));
  await page.getByTestId('slack-watch-links-add').click();
  await expect(page.getByTestId('slack-watch-state')).toHaveText('Running');
  // The count is on the tab in every view, and the warning is gone once the watcher runs.
  await expect(watchTab.locator('.board-tab-count')).toHaveText('2');
  await expect(watchTab).not.toHaveAttribute('data-tone', /.+/);
  await tab(page, 'started').click();
  await expect(boardOf(page)).toBeVisible();
  await expect(watchTab.locator('.board-tab-count')).toHaveText('2');
  await expect(watchTab).not.toHaveAttribute('data-tone', /.+/);
});
