import { test, expect } from './fixtures.js';

// The Slack activity edge drawer (plan items 1, 2, 7-10 and 13-15), beside the Sessions drawer.
// Every id, name and line of text below is synthetic. The two routes the drawer reads are answered
// by the spec itself (a page route wins over the shared fixture's), so it counts its own requests.

const NOW = '2026-11-14T12:00:00.000Z';
const CHANNEL = { name: 'example-channel', type: 'channel' };
const URL_BASE = 'https://app.slack.com/client/T0EXAMPLE1/C0EXAMPLE1';

const feedRow = (id, kind, extra = {}) => ({
  id,
  kind,
  unread: false,
  at: NOW,
  url: `${URL_BASE}/thread/C0EXAMPLE1-${id}`,
  hydrated: true,
  channel: CHANNEL,
  author: 'Example Person',
  text: `Example text of ${id}`,
  ...extra,
});

const FEED = {
  available: true,
  updatedAt: NOW,
  partial: [],
  mentions: [
    feedRow('mention-one', 'mention', { unread: true }),
    feedRow('mention-two', 'keyword'),
  ],
  threads: [feedRow('thread-one', 'thread', { replies: 3, parentText: 'Example parent text' })],
  reactions: [
    feedRow('reaction-one', 'reaction', { reaction: { by: 'Example Person', name: 'tada' } }),
  ],
};

const pendingWith = (activityMentions, available = true) =>
  available
    ? {
        available: true,
        channel: { id: 'C0EXAMPLE1', name: 'example-channel', mentions: 0, unread: false },
        mentionsTotal: 0,
        activityMentions,
        updatedAt: NOW,
      }
    : { available: false };

// Answers the two Slack routes the drawer reads and counts every request to each. `state.feed` and
// `state.pending` are what the next request gets (a function is called per request; a number is an
// HTTP status for an error answer).
async function mockSlack(page, { feed = FEED, pending = pendingWith(0) } = {}) {
  const state = { feed, pending, feedReads: 0, pendingReads: 0 };
  const answer = (route, value) => {
    const body = typeof value === 'function' ? value() : value;
    if (typeof body === 'number') return route.fulfill({ status: body, json: { error: 'failed' } });
    return route.fulfill({ json: body });
  };
  await page.route('**/api/slack/feed', (route) => {
    state.feedReads += 1;
    return answer(route, state.feed);
  });
  await page.route('**/api/slack/pending', (route) => {
    state.pendingReads += 1;
    return answer(route, state.pending);
  });
  return state;
}

// `document.hidden` follows `window.__hidden`, flipped by `window.__setHidden` (the needs-you spec's way).
async function controlVisibility(page) {
  await page.addInitScript(() => {
    window.__hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__hidden });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (window.__hidden ? 'hidden' : 'visible'),
    });
    window.__setHidden = (value) => {
      window.__hidden = value;
      document.dispatchEvent(new Event('visibilitychange'));
    };
  });
}

// The open drawer lies over both tabs, so a keyboard user (and this spec) activates a tab by focus and Enter.
async function activate(page, tab) {
  await tab.focus();
  await page.keyboard.press('Enter');
}

const tab = (page) => page.getByTestId('slack-feed-tab');
const drawer = (page) => page.getByTestId('slack-feed-drawer');
const openSlack = async (page) => {
  await tab(page).click();
  await expect(drawer(page)).toBeVisible();
};

test('one drawer at a time: opening one shuts the other and Escape closes only the open one', async ({
  page,
}) => {
  await mockSlack(page);
  await page.goto('/#/home');
  const sessions = page.getByTestId('sessions-tab');
  await expect(tab(page)).toBeVisible();

  await activate(page, sessions);
  await expect(page.getByTestId('sessions-drawer')).toBeVisible();
  await expect(drawer(page)).toBeHidden();

  // Sessions is open: the Slack tab (under the drawer) opens Slack and shuts Sessions.
  await activate(page, tab(page));
  await expect(drawer(page)).toBeVisible();
  await expect(tab(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('sessions-drawer')).toBeHidden();
  await expect(sessions).toHaveAttribute('aria-expanded', 'false');

  // And back: Sessions opens, Slack closes.
  await activate(page, sessions);
  await expect(page.getByTestId('sessions-drawer')).toBeVisible();
  await expect(page.getByTestId('sessions-close')).toBeFocused();
  await expect(drawer(page)).toBeHidden();
  await expect(tab(page)).toHaveAttribute('aria-expanded', 'false');

  // Escape closes only the open drawer and focus returns to its own tab.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('sessions-drawer')).toBeHidden();
  await expect(sessions).toBeFocused();
  await openSlack(page);
  await expect(page.getByTestId('slack-feed-close')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(drawer(page)).toBeHidden();
  await expect(tab(page)).toBeFocused();
  await expect(page.getByTestId('sessions-drawer')).toBeHidden();
});

test('both edge tabs stay visible, apart and inside the page, wide and at 480px', async ({
  page,
}) => {
  await mockSlack(page, { pending: pendingWith(3) });
  for (const size of [
    { width: 1440, height: 900 },
    { width: 480, height: 800 },
  ]) {
    await page.setViewportSize(size);
    await page.goto('/#/home');
    await expect(tab(page)).toBeVisible();
    const upper = await page.getByTestId('sessions-tab').boundingBox();
    const lower = await tab(page).boundingBox();
    expect(upper.y + upper.height, `${size.width}px: no overlap`).toBeLessThanOrEqual(lower.y + 1);
    for (const box of [upper, lower]) {
      expect(box.x + box.width).toBeLessThanOrEqual(size.width + 1);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(size.height);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
});

test('mentions first: Mentions, Threads, Reactions in order, Mentions selected on every open', async ({
  page,
}) => {
  await mockSlack(page);
  await page.goto('/#/home');
  await openSlack(page);

  await expect(drawer(page).getByRole('tab')).toHaveText([/^Mentions/, /^Threads/, /^Reactions/]);
  const mentions = page.getByTestId('slack-feed-view-mentions');
  const threads = page.getByTestId('slack-feed-view-threads');
  await expect(mentions).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('slack-feed-row-mention-one')).toBeVisible();
  await expect(page.getByTestId('slack-feed-row-mention-two')).toBeVisible();
  await expect(page.getByTestId('slack-feed-row-thread-one')).toHaveCount(0);

  await mentions.focus();
  await page.keyboard.press('ArrowRight');
  await expect(threads).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('slack-feed-row-thread-one')).toBeVisible();
  await expect(page.getByTestId('slack-feed-row-mention-one')).toHaveCount(0);

  // Close and reopen with Threads selected: it starts on Mentions again.
  await page.keyboard.press('Escape');
  await expect(drawer(page)).toBeHidden();
  await openSlack(page);
  await expect(page.getByTestId('slack-feed-view-mentions')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByTestId('slack-feed-row-mention-one')).toBeVisible();
});

const COUNT_CASES = [
  ['3 unread mentions', pendingWith(3), 'Slack activity, 3 unread mentions', '3'],
  ['1 unread mention', pendingWith(1), 'Slack activity, 1 unread mention', '1'],
  ['no mentions (only thread chatter unread)', pendingWith(0), 'Slack activity', null],
  ['Slack unavailable', pendingWith(5, false), 'Slack activity', null],
  [
    'more than 99 mentions',
    pendingWith(120),
    /^Slack activity, (?:120|99\+) unread mentions$/,
    '99+',
  ],
];
for (const [name, pending, label, count] of COUNT_CASES)
  test(`tab count: ${name}`, async ({ page }) => {
    await mockSlack(page, { pending });
    await page.goto('/#/home');
    await expect(tab(page)).toHaveAttribute('aria-label', label);
    const pill = tab(page).locator('.slack-feed-tab-count');
    if (count === null) {
      await expect(pill).toHaveCount(0);
      await expect(tab(page)).not.toHaveAttribute('data-attention', 'true');
    } else {
      await expect(pill).toHaveText(count);
      await expect(tab(page)).toHaveAttribute('data-attention', 'true');
    }
  });

test('shared pending poll: one request per interval for the badge and the tab, none while hidden', async ({
  page,
}) => {
  await controlVisibility(page);
  await page.clock.install();
  const slack = await mockSlack(page, { pending: pendingWith(2) });
  await page.goto('/#/home');
  // Both consumers are mounted: the app's Slack badge area and the drawer's tab.
  await expect(tab(page)).toHaveAttribute('aria-label', 'Slack activity, 2 unread mentions');
  await expect.poll(() => slack.pendingReads).toBeGreaterThanOrEqual(1);

  await page.clock.runFor(180_000);
  // One at mount and one a minute for 3 minutes is 4; a poll per consumer would be 8.
  expect(slack.pendingReads).toBeGreaterThanOrEqual(3);
  expect(slack.pendingReads).toBeLessThanOrEqual(4);

  await page.evaluate(() => window.__setHidden(true));
  const before = slack.pendingReads;
  await page.clock.runFor(180_000);
  expect(slack.pendingReads, 'a hidden page asks for nothing').toBe(before);
});

test('returning to a hidden tab reads the count at once and the one-a-minute cadence resumes', async ({
  page,
}) => {
  await controlVisibility(page);
  await page.clock.install();
  const slack = await mockSlack(page, { pending: pendingWith(2) });
  await page.goto('/#/home');
  await expect(tab(page)).toHaveAttribute('aria-label', 'Slack activity, 2 unread mentions');
  await expect.poll(() => slack.pendingReads).toBe(1);

  await page.evaluate(() => window.__setHidden(true));
  await page.clock.runFor(30_000);
  expect(slack.pendingReads, 'hiding the page asks for nothing').toBe(1);

  slack.pending = pendingWith(7);
  await page.evaluate(() => window.__setHidden(false));
  await expect.poll(() => slack.pendingReads, 'the return reads at once').toBe(2);
  await expect(tab(page)).toHaveAttribute('aria-label', 'Slack activity, 7 unread mentions');

  // The return read re-armed the timer from its answer: the next one is a minute later, not sooner.
  await page.clock.runFor(59_000);
  expect(slack.pendingReads, 'no second timer beside the return read').toBe(2);
  slack.pending = pendingWith(8);
  await page.clock.runFor(2_000);
  await expect.poll(() => slack.pendingReads).toBe(3);
  // The new count is on screen once that answer has landed and re-armed the timer.
  await expect(tab(page)).toHaveAttribute('aria-label', 'Slack activity, 8 unread mentions');
  await page.clock.runFor(60_000);
  await expect.poll(() => slack.pendingReads).toBe(4);
});

test('backoff: while Slack is unavailable the poll waits five minutes, a session change asks at once', async ({
  page,
}) => {
  await page.clock.install();
  const slack = await mockSlack(page, { pending: pendingWith(0, false) });
  await page.goto('/#/home');
  await expect(tab(page)).toBeVisible();
  await expect.poll(() => slack.pendingReads).toBe(1);

  await page.clock.runFor(240_000);
  expect(slack.pendingReads, 'nothing in the first 4 minutes').toBe(1);
  await page.clock.runFor(61_000);
  await expect.poll(() => slack.pendingReads).toBe(2);

  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('slack-session-changed', { detail: { source: 'spec' } })),
  );
  await expect.poll(() => slack.pendingReads).toBe(3);
});

test('open and refresh only: the rows are read when the drawer opens and on Refresh, never on a timer', async ({
  page,
}) => {
  await page.clock.install();
  const slack = await mockSlack(page);
  await page.goto('/#/home');
  await expect(tab(page)).toBeVisible();
  await page.clock.runFor(180_000);
  expect(slack.feedReads, 'a shut drawer reads nothing').toBe(0);

  await openSlack(page);
  await expect(page.getByTestId('slack-feed-row-mention-one')).toBeVisible();
  expect(slack.feedReads).toBe(1);

  await page.getByTestId('slack-feed-refresh').click();
  await expect.poll(() => slack.feedReads).toBe(2);
  await page.clock.runFor(180_000);
  expect(slack.feedReads, 'an open drawer does not poll').toBe(2);
});

test('disconnected: a calm line that points to the Slack tab, no Connect button, the link closes the drawer', async ({
  page,
}) => {
  await mockSlack(page, { feed: { available: false, reason: 'disconnected' } });
  await page.goto('/#/home');
  await openSlack(page);

  const note = page.getByTestId('slack-feed-disconnected');
  await expect(note).toBeVisible();
  await expect(note).toContainText('Slack is not connected');
  await expect(note).toContainText('Connect Slack in the Slack tab');
  await expect(drawer(page).locator('[data-kind="error"]')).toHaveCount(0);
  await expect(drawer(page).getByRole('button', { name: /connect/i })).toHaveCount(0);
  const link = page.getByTestId('slack-feed-connect-link');
  await expect(link).toHaveAttribute('href', '#/slack');

  await link.click();
  await expect(drawer(page)).toBeHidden();
  await expect(page).toHaveURL(/#\/slack$/);
  await expect(tab(page)).toBeFocused();
});

test('unavailable: a neutral line with Refresh, and Refresh reads again', async ({ page }) => {
  const slack = await mockSlack(page, { feed: { available: false, reason: 'unavailable' } });
  await page.goto('/#/home');
  await openSlack(page);

  const note = page.getByTestId('slack-feed-unavailable');
  await expect(note).toBeVisible();
  await expect(note).toContainText('Slack activity could not be read right now');
  await expect(drawer(page).locator('[data-kind="error"]')).toHaveCount(0);
  await expect(drawer(page).getByRole('alert')).toHaveCount(0);

  slack.feed = FEED;
  await drawer(page).getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByTestId('slack-feed-row-mention-one')).toBeVisible();
  expect(slack.feedReads).toBe(2);
});

test('unavailable: a failed request reads the same as an unavailable answer', async ({ page }) => {
  await mockSlack(page, { feed: 500 });
  await page.goto('/#/home');
  await openSlack(page);
  await expect(page.getByTestId('slack-feed-unavailable')).toBeVisible();
  await expect(drawer(page).locator('[data-kind="error"]')).toHaveCount(0);
});

test('row link: a row opens Slack in a new tab, an unhydrated row still links', async ({
  page,
}) => {
  const unhydrated = feedRow('mention-bare', 'mention', {
    hydrated: false,
    text: '',
    author: '',
    channel: { name: '', type: 'channel' },
  });
  await mockSlack(page, { feed: { ...FEED, mentions: [...FEED.mentions, unhydrated] } });
  await page.goto('/#/home');
  await openSlack(page);

  const row = page.getByTestId('slack-feed-row-mention-one');
  await expect(row).toHaveJSProperty('tagName', 'A');
  await expect(row).toHaveAttribute('href', `${URL_BASE}/thread/C0EXAMPLE1-mention-one`);
  await expect(row).toHaveAttribute('target', '_blank');
  await expect(row).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(row).toContainText('#example-channel');
  await expect(row).toContainText('Example text of mention-one');

  const bare = page.getByTestId('slack-feed-row-mention-bare');
  await expect(bare).toContainText('Message not loaded');
  await expect(bare).toHaveAttribute('href', unhydrated.url);
  await expect(bare).toHaveAttribute('target', '_blank');
  await expect(bare).toHaveAttribute('rel', 'noopener noreferrer');
});

test('Refresh keeps its focus while it reads, and a failed Refresh keeps the rows already shown', async ({
  page,
}) => {
  const slack = await mockSlack(page);
  await page.goto('/#/home');
  await openSlack(page);
  const refresh = page.getByTestId('slack-feed-refresh');
  await expect(page.getByTestId('slack-feed-row-mention-one')).toBeVisible();

  slack.feed = 500;
  await refresh.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => slack.feedReads).toBe(2);
  await expect(refresh).toBeFocused();
  await expect(page.getByTestId('slack-feed-row-mention-one')).toBeVisible();
  await expect(page.getByTestId('slack-feed-unavailable')).toHaveCount(0);
});

test('a Refresh that answers disconnected replaces the rows with the connect line', async ({
  page,
}) => {
  const slack = await mockSlack(page);
  await page.goto('/#/home');
  await openSlack(page);
  await expect(page.getByTestId('slack-feed-row-mention-one')).toBeVisible();

  slack.feed = { available: false, reason: 'disconnected' };
  await page.getByTestId('slack-feed-refresh').click();
  await expect(page.getByTestId('slack-feed-disconnected')).toBeVisible();
  await expect(page.getByTestId('slack-feed-row-mention-one')).toHaveCount(0);
});

test('the Mentions tab speaks its count as unread', async ({ page }) => {
  await mockSlack(page);
  await page.goto('/#/home');
  await openSlack(page);
  await expect(page.getByTestId('slack-feed-view-mentions')).toHaveAccessibleName(
    /Mentions\s*1\s*unread/,
  );
  await expect(page.getByTestId('slack-feed-view-reactions')).toHaveAccessibleName('Reactions');
});

test('a failed pending fetch is retried in a minute, a server answer of unavailable in five', async ({
  page,
}) => {
  await page.clock.install();
  const slack = await mockSlack(page, { pending: 500 });
  await page.goto('/#/home');
  await expect.poll(() => slack.pendingReads).toBe(1);
  await page.clock.runFor(61_000);
  await expect.poll(() => slack.pendingReads).toBe(2);

  slack.pending = pendingWith(0, false);
  await page.clock.runFor(61_000);
  await expect.poll(() => slack.pendingReads).toBe(3);
  await page.clock.runFor(120_000);
  expect(slack.pendingReads, 'an unavailable answer backs off to five minutes').toBe(3);
  await page.clock.runFor(180_000);
  await expect.poll(() => slack.pendingReads).toBe(4);
});
