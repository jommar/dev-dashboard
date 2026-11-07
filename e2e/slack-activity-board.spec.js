import { test, expect, listReads } from './fixtures.js';
import { slackAppThreadLink, slackWatchData, ticketBoardData, watchLink } from './data.js';

const CHANNEL = 'C0EXAMPLE1';
const TEAM = 'T0EXAMPLE1';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOON = Date.parse('2026-03-09T16:00:00.000Z'); // 12:00 EDT, after the spring DST change
const MIDNIGHT_CASE = Date.parse('2026-03-09T05:00:00.000Z'); // 01:00 EDT
const GROUPS = ['Last 3 hours', 'Today', 'Yesterday', 'Past week', 'Past month'];
const SAM = { id: 'U0EXAMPLE1', name: 'Sam Example' };
const RILEY = { id: 'U0EXAMPLE2', name: 'Riley Sample' };

test.use({ timezoneId: 'America/New_York' });

// Slack's root identity retains six decimal places, including at the creation cutoff.
function slackTs(ms) {
  return `${Math.floor(ms / 1000)}.${String((ms % 1000) * 1000).padStart(6, '0')}`;
}

function row(text, created, activity, extra = {}) {
  const ts = slackTs(created);
  return {
    ts,
    url: slackAppThreadLink(TEAM, CHANNEL, ts),
    watchKey: `${CHANNEL}:${ts}`,
    text,
    subjectText: text,
    author: SAM,
    starter: SAM,
    replyCount: 1,
    activityAt: typeof activity === 'number' ? new Date(activity).toISOString() : activity,
    latestReplyBy: RILEY,
    needsReply: false,
    attachedSessions: 0,
    ...extra,
  };
}

function threadRead(thread) {
  return {
    ts: thread.ts,
    url: thread.url,
    watchKey: thread.watchKey,
    channel: { id: CHANNEL, name: 'example_channel' },
    replyCount: thread.replyCount,
    truncated: false,
    names: { [SAM.id]: SAM.name },
    messages: [
      {
        ts: thread.ts,
        at: new Date(Number(thread.ts) * 1000).toISOString(),
        author: SAM,
        text: thread.text,
        mrkdwn: thread.text,
      },
    ],
  };
}

function seed(dashboard, now, started, mentions = []) {
  Object.assign(dashboard.data.slack.threads, {
    available: true,
    enriched: true,
    channel: { id: CHANNEL, name: 'example_channel' },
    updatedAt: new Date(now).toISOString(),
    serverTime: new Date(now).toISOString(),
    started,
    mentions,
  });
  dashboard.data.slack.threadReads = Object.fromEntries(
    [...started, ...mentions].map((thread) => [thread.ts, threadRead(thread)]),
  );
}

async function freeze(page, now) {
  await page.clock.install({ time: now - 60_000 });
  await page.clock.pauseAt(now);
}

async function openSlack(page) {
  await page.goto('/#/slack');
  await expect(page.getByTestId('slack-tab-started')).toBeVisible();
  await expect(page.getByTestId('slack-threads-loading')).toHaveCount(0);
}

const boardOf = (page) => page.getByRole('region', { name: /slack.*board/i });
const groupOf = (page, name) => boardOf(page).getByRole('group', { name: new RegExp(name, 'i') });
const cardOf = (page, thread) => page.getByTestId(`slack-thread-${thread.ts}`);

test('board activity: five loaded groups count and sort by newest activity, not root age', async ({
  page,
  dashboard,
}) => {
  await freeze(page, NOON);
  const olderRootNewReply = row('Old root, newest reply', NOON - 20 * DAY, NOON - 5 * 60_000);
  const newerRootOldReply = row('New root, older reply', NOON - 2 * HOUR, NOON - 70 * 60_000);
  const today = row('Earlier today', NOON - 8 * HOUR, NOON - 3 * HOUR - 1);
  const yesterday = row('Previous local date', NOON - 2 * DAY, Date.parse('2026-03-08T14:00:00Z'));
  // March 2 is seven local dates ago despite the intervening 23-hour DST day.
  const week = row(
    'Seven local dates ago',
    Date.parse('2026-03-02T05:00:00Z'),
    Date.parse('2026-03-02T05:00:00Z'),
    { replyCount: 0 },
  );
  const month = row(
    'Eight local dates ago',
    Date.parse('2026-03-01T05:00:00Z'),
    Date.parse('2026-03-01T05:00:00Z'),
    { replyCount: 0 },
  );
  seed(dashboard, NOON, [newerRootOldReply, month, yesterday, today, week, olderRootNewReply]);
  await openSlack(page);

  const board = boardOf(page);
  await expect(board).toBeVisible();
  await expect(board).toHaveAttribute('tabindex', '0');
  const counts = [2, 1, 1, 1, 1];
  for (const [index, name] of GROUPS.entries()) {
    const column = groupOf(page, name);
    await expect(column).toBeVisible();
    await expect(column.getByText(String(counts[index]), { exact: true })).toBeVisible();
  }
  await expect(board.getByRole('group')).toHaveCount(5);
  for (const [name, thread] of [
    ['Today', today],
    ['Yesterday', yesterday],
    ['Past week', week],
    ['Past month', month],
  ])
    await expect(groupOf(page, name).getByTestId(`slack-thread-${thread.ts}`)).toBeVisible();
  const ordered = await groupOf(page, 'Last 3 hours')
    .locator('button[data-testid^="slack-thread-"]')
    .evaluateAll((buttons) => buttons.map((button) => button.dataset.testid));
  expect(ordered).toEqual([
    `slack-thread-${olderRootNewReply.ts}`,
    `slack-thread-${newerRootOldReply.ts}`,
  ]);
});

test('board activity: more than 25 loaded threads are present and counted', async ({
  page,
  dashboard,
}) => {
  await freeze(page, NOON);
  const threads = Array.from({ length: 26 }, (_, index) =>
    row(`Loaded thread ${index}`, NOON - 2 * HOUR - index * 1000, NOON - index * 60_000),
  );
  seed(dashboard, NOON, [...threads].reverse());
  await openSlack(page);
  // Assert the existing rows first: a broken mock or missing app is not a board RED.
  await expect(page.locator('button[data-testid^="slack-thread-"]')).toHaveCount(26);
  const column = groupOf(page, 'Last 3 hours');
  await expect(column.getByText('26', { exact: true })).toBeVisible();
  await expect(column.locator('button[data-testid^="slack-thread-"]')).toHaveCount(26);
  const ids = await column
    .locator('button[data-testid^="slack-thread-"]')
    .evaluateAll((buttons) => buttons.map((button) => button.dataset.testid));
  expect(ids).toEqual(threads.map((thread) => `slack-thread-${thread.ts}`));
});

test('board scope: stale old roots cannot reappear and there is no older opt-in', async ({
  page,
  dashboard,
}) => {
  await freeze(page, NOON);
  const boundary = row('Exactly 28 days old', NOON - 28 * DAY, NOON - HOUR);
  const expired = row('Expired root with a new reply', NOON - 28 * DAY - 1, NOON - 60_000);
  // A stale snapshot exercises client-side rechecking; the backend separately rejects this root.
  seed(dashboard, NOON, [expired, boundary], [expired]);
  await openSlack(page);
  await expect(page.getByRole('button', { name: /older|more history|all history/i })).toHaveCount(
    0,
  );
  await expect(page.getByRole('checkbox', { name: /older|history/i })).toHaveCount(0);
  expect(listReads(dashboard).length).toBeGreaterThan(0);
  for (const { path } of listReads(dashboard))
    expect(path).not.toMatch(/[?&](older|history|all)=/i);
  await expect(cardOf(page, boundary)).toBeVisible();
  await expect(cardOf(page, expired)).toHaveCount(0);
  await page.getByTestId('slack-tab-mentions').click();
  await expect(cardOf(page, expired)).toHaveCount(0);
});

test('board coverage: partial loaded results are not described as all caught up', async ({
  page,
  dashboard,
}) => {
  await freeze(page, NOON);
  seed(dashboard, NOON, []);
  dashboard.data.slack.threads.partial = true;
  dashboard.data.slack.threads.truncated = true;
  await openSlack(page);
  await expect(page.getByTestId('slack-threads-meta')).not.toContainText('All caught up');
  await expect(page.getByTestId('slack-section')).toContainText(/partial|incomplete|not all/i);
});

test('board coverage: a bounded continuation keeps the loaded scope and unknown reply status honest', async ({
  page,
  dashboard,
}) => {
  await freeze(page, NOON);
  const first = row('First loaded thread', NOON - DAY, NOON - HOUR, { needsReply: null });
  const second = row('Next loaded thread', NOON - DAY - 1000, NOON - 2 * HOUR);
  seed(dashboard, NOON, [first]);
  Object.assign(dashboard.data.slack.threads, {
    partial: true,
    truncated: true,
    continuation: 'session-bound-token',
    coverageNotes: ['Slack search boundaries are uncertain.'],
  });
  let continued = false;
  await page.route(
    (url) => url.pathname === '/api/slack/threads' && url.searchParams.has('continuation'),
    async (route) => {
      continued =
        new URL(route.request().url()).searchParams.get('continuation') === 'session-bound-token';
      await route.fulfill({
        json: { ...dashboard.data.slack.threads, started: [first, second], continuation: null },
      });
    },
  );
  await openSlack(page);
  await expect(page.getByTestId('slack-threads-meta')).toContainText('Reply status unknown');
  await expect(cardOf(page, first)).toContainText('Reply status unknown');
  await expect(page.getByTestId('slack-section')).toContainText('search boundaries are uncertain');
  await page.getByRole('button', { name: 'Load more eligible threads' }).click();
  await expect(cardOf(page, second)).toBeVisible();
  expect(continued).toBe(true);
  await expect(page.getByRole('button', { name: 'Load more eligible threads' })).toHaveCount(0);
});

test('board scope: server time prevents a slow browser clock extending eligibility', async ({
  page,
  dashboard,
}) => {
  await freeze(page, NOON - DAY);
  const thread = row('Expires on server time', NOON - 28 * DAY + 5000, NOON - HOUR);
  seed(dashboard, NOON, [thread]);
  await openSlack(page);
  await expect(cardOf(page, thread)).toBeVisible();
  await page.clock.runFor(5001);
  await expect(cardOf(page, thread)).toHaveCount(0);
});

test('board scope: a dialog expires even if its card disappears during a refresh', async ({
  page,
  dashboard,
}) => {
  await freeze(page, NOON);
  const thread = row('Removed before expiry', NOON - 28 * DAY + 65_000, NOON - HOUR);
  seed(dashboard, NOON, [thread]);
  await openSlack(page);
  await cardOf(page, thread).click();
  await expect(page.getByTestId('slack-thread-dialog')).toBeVisible();
  dashboard.data.slack.threads.started = [];
  await page.clock.runFor(60_000);
  await expect(cardOf(page, thread)).toHaveCount(0);
  await expect(page.getByTestId('slack-thread-dialog')).toBeVisible();
  await page.clock.runFor(5001);
  await expect(page.getByTestId('slack-thread-dialog')).toHaveCount(0);
});

test('board scope: replacing the connected Slack identity clears the previous dialog and rows', async ({
  page,
  dashboard,
}) => {
  await freeze(page, NOON);
  const old = row('Previous account thread', NOON - DAY, NOON - HOUR);
  const next = row('New account thread', NOON - DAY - 1000, NOON - HOUR);
  seed(dashboard, NOON, [old]);
  await openSlack(page);
  await cardOf(page, old).click();
  await expect(page.getByTestId('slack-thread-dialog')).toBeVisible();
  dashboard.data.slack.status.user = 'replacement';
  seed(dashboard, NOON, [next]);
  await page.clock.runFor(60_000);
  await expect(page.getByTestId('slack-thread-dialog')).toHaveCount(0);
  await expect(cardOf(page, old)).toHaveCount(0);
  await expect(cardOf(page, next)).toBeVisible();
  await expect(page.getByTestId('slack-meta')).toContainText('@replacement');
});

test('board scope: a same-account session replacement clears an open My Tickets dialog', async ({
  page,
  dashboard,
}) => {
  await freeze(page, NOON);
  ticketBoardData(dashboard.data);
  const { key } = dashboard.data.tickets.tickets[0];
  const first = row(`${key}: first session`, NOON - DAY, NOON - HOUR);
  const second = row(`${key}: next session`, NOON - DAY - 1000, NOON - 2 * HOUR);
  dashboard.data.slack.status.savedAt = '2026-03-09T15:00:00Z';
  seed(dashboard, NOON, [first]);
  await page.goto('/#/my-tickets');
  await page.getByTestId(`slack-thread-link-${first.ts}`).click();
  await expect(page.getByTestId('slack-thread-dialog')).toBeVisible();
  dashboard.data.slack.status.savedAt = '2026-03-09T16:00:00Z';
  seed(dashboard, NOON, [second]);
  await page.clock.runFor(90_000);
  await expect(page.getByTestId('slack-thread-dialog')).toHaveCount(0);
  await expect(page.getByTestId(`slack-thread-link-${first.ts}`)).toHaveCount(0);
  await expect(page.getByTestId(`slack-thread-link-${second.ts}`)).toBeVisible();
});

test('board scope: legacy same-account replacement clears stale dialog content', async ({
  page,
  dashboard,
}, testInfo) => {
  await freeze(page, NOON);
  const first = row('Legacy session old conversation', NOON - DAY, NOON - HOUR);
  const second = row('Legacy session new conversation', NOON - DAY - 1000, NOON - 2 * HOUR);
  delete dashboard.data.slack.status.savedAt;
  dashboard.data.slack.status.sessionVersion = 'legacy-session-one';
  seed(dashboard, NOON, [first]);
  await openSlack(page);
  await cardOf(page, first).click();
  const dialog = page.getByTestId('slack-thread-dialog');
  await expect(dialog.getByTestId(`slack-thread-message-${first.ts}`)).toContainText(first.text);

  // Model an externally replaced legacy session with the same account but no
  // savedAt in either status. The backend's opaque session version changes.
  dashboard.data.slack.status.sessionVersion = 'legacy-session-two';
  seed(dashboard, NOON, [second]);
  await page.clock.runFor(60_000);
  await expect(cardOf(page, second)).toHaveCount(1);
  await expect(cardOf(page, first)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('legacy-session-replacement.png') });
  await expect(dialog).toHaveCount(0);
});

test('board scope: routine polls of the same session keep the dialog open despite new rows', async ({
  page,
  dashboard,
}) => {
  await freeze(page, NOON);
  const first = row('Stable session original conversation', NOON - DAY, NOON - HOUR);
  const second = row('New listing in the same session', NOON - DAY - 1000, NOON - 2 * HOUR);
  dashboard.data.slack.status.sessionVersion = 'unchanged-session';
  seed(dashboard, NOON, [first]);
  await openSlack(page);
  await cardOf(page, first).click();
  const dialog = page.getByTestId('slack-thread-dialog');
  await expect(dialog.getByTestId(`slack-thread-message-${first.ts}`)).toContainText(first.text);
  seed(dashboard, NOON, [second]);
  dashboard.data.slack.threads.updatedAt = new Date(NOON + 60_000).toISOString();
  await page.clock.runFor(60_000);
  await expect(cardOf(page, second)).toHaveCount(1);
  await expect(dialog.getByTestId(`slack-thread-message-${first.ts}`)).toContainText(first.text);
});

test('board scope: routine My Tickets polls keep the same-session dialog open', async ({
  page,
  dashboard,
}) => {
  await freeze(page, NOON);
  ticketBoardData(dashboard.data);
  const { key } = dashboard.data.tickets.tickets[0];
  const first = row(`${key}: stable conversation`, NOON - DAY, NOON - HOUR);
  const second = row(`${key}: changed listing`, NOON - DAY - 1000, NOON - 2 * HOUR);
  dashboard.data.slack.status.sessionVersion = 'unchanged-session';
  seed(dashboard, NOON, [first]);
  await page.goto('/#/my-tickets');
  await page.getByTestId(`slack-thread-link-${first.ts}`).click();
  const dialog = page.getByTestId('slack-thread-dialog');
  await expect(dialog.getByTestId(`slack-thread-message-${first.ts}`)).toContainText(first.text);
  seed(dashboard, NOON, [second]);
  dashboard.data.slack.threads.updatedAt = new Date(NOON + 90_000).toISOString();
  await page.clock.runFor(90_000);
  await expect(page.getByTestId(`slack-thread-link-${second.ts}`)).toHaveCount(1);
  await expect(dialog.getByTestId(`slack-thread-message-${first.ts}`)).toContainText(first.text);
});

test('board scope: legacy same-account replacement clears the My Tickets dialog', async ({
  page,
  dashboard,
}) => {
  await freeze(page, NOON);
  ticketBoardData(dashboard.data);
  const { key } = dashboard.data.tickets.tickets[0];
  const first = row(`${key}: old legacy session`, NOON - DAY, NOON - HOUR);
  const second = row(`${key}: replacement legacy session`, NOON - DAY - 1000, NOON - 2 * HOUR);
  delete dashboard.data.slack.status.savedAt;
  dashboard.data.slack.status.sessionVersion = 'legacy-session-one';
  seed(dashboard, NOON, [first]);
  await page.goto('/#/my-tickets');
  await page.getByTestId(`slack-thread-link-${first.ts}`).click();
  const dialog = page.getByTestId('slack-thread-dialog');
  await expect(dialog.getByTestId(`slack-thread-message-${first.ts}`)).toContainText(first.text);
  dashboard.data.slack.status.sessionVersion = 'legacy-session-two';
  seed(dashboard, NOON, [second]);
  await page.clock.runFor(90_000);
  await expect(page.getByTestId(`slack-thread-link-${second.ts}`)).toBeVisible();
  await expect(page.getByTestId(`slack-thread-link-${first.ts}`)).toHaveCount(0);
  await expect(dialog).toHaveCount(0);
});

for (const panel of ['slack', 'my-tickets']) {
  test(`board scope: versioned cross-account replacement and disconnect clear ${panel} data`, async ({
    page,
    dashboard,
  }) => {
    await freeze(page, NOON);
    ticketBoardData(dashboard.data);
    const { key } = dashboard.data.tickets.tickets[0];
    const first = row(`${key}: previous account`, NOON - DAY, NOON - HOUR);
    const second = row(`${key}: replacement account`, NOON - DAY - 1000, NOON - 2 * HOUR);
    const thread = (entry) =>
      panel === 'slack' ? cardOf(page, entry) : page.getByTestId(`slack-thread-link-${entry.ts}`);
    const interval = panel === 'slack' ? 60_000 : 90_000;
    dashboard.data.slack.status.sessionVersion = 'account-one';
    seed(dashboard, NOON, [first]);
    if (panel === 'slack') await openSlack(page);
    else await page.goto('/#/my-tickets');
    await thread(first).click();
    const dialog = page.getByTestId('slack-thread-dialog');
    await expect(dialog.getByTestId(`slack-thread-message-${first.ts}`)).toContainText(first.text);

    dashboard.data.slack.status.user = 'replacement';
    dashboard.data.slack.status.sessionVersion = 'account-two';
    seed(dashboard, NOON, [second]);
    await page.clock.runFor(interval);
    await expect(dialog).toHaveCount(0);
    await expect(thread(first)).toHaveCount(0);
    await expect(thread(second)).toBeVisible();

    await thread(second).click();
    await expect(dialog.getByTestId(`slack-thread-message-${second.ts}`)).toContainText(
      second.text,
    );
    dashboard.data.slack.status = { connected: false, connecting: false };
    await page.clock.runFor(interval);
    await expect(dialog).toHaveCount(0);
    await expect(thread(second)).toHaveCount(0);
  });
}

test('board scope: a late My Tickets listing from the previous session cannot repaint', async ({
  page,
  dashboard,
}) => {
  await freeze(page, NOON);
  ticketBoardData(dashboard.data);
  const { key } = dashboard.data.tickets.tickets[0];
  const old = row(`${key}: old delayed result`, NOON - DAY, NOON - HOUR);
  dashboard.data.slack.status.savedAt = '2026-03-09T15:00:00Z';
  seed(dashboard, NOON, [old]);
  const previous = structuredClone(dashboard.data.slack.threads);
  let release;
  let requested = false;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => url.pathname === '/api/slack/threads',
    async (route) => {
      requested = true;
      await gate;
      await route.fulfill({ json: previous });
    },
  );
  try {
    await page.goto('/#/my-tickets');
    await expect.poll(() => requested).toBe(true);
    dashboard.data.slack.status.savedAt = '2026-03-09T16:00:00Z';
    const checked = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/slack/status',
    );
    release();
    await checked;
    await expect(page.getByTestId('my-tickets-board')).toBeVisible();
    await expect(page.getByTestId(`slack-thread-link-${old.ts}`)).toHaveCount(0);
  } finally {
    release();
  }
});

test('board activity: time across midnight without a listing refresh; unplaceable threads are left out', async ({
  page,
  dashboard,
}) => {
  await freeze(page, MIDNIGHT_CASE);
  const crossMidnight = row(
    'Yesterday at 23:30',
    MIDNIGHT_CASE - DAY,
    Date.parse('2026-03-09T03:30:00Z'),
  );
  const exact = row(
    'Exactly three hours ago',
    MIDNIGHT_CASE - DAY - 1000,
    MIDNIGHT_CASE - 3 * HOUR,
  );
  const justPast = row(
    'Three hours and one millisecond',
    MIDNIGHT_CASE - DAY - 2000,
    MIDNIGHT_CASE - 3 * HOUR - 1,
  );
  const unknown = row('Unknown reply activity', MIDNIGHT_CASE - DAY - 3000, 'not-a-date', {
    needsReply: null,
  });
  const future = row('Future reply activity', MIDNIGHT_CASE - DAY - 4000, MIDNIGHT_CASE + HOUR, {
    needsReply: null,
  });
  seed(dashboard, MIDNIGHT_CASE, [justPast, unknown, exact, future, crossMidnight]);
  await openSlack(page);
  await expect(
    groupOf(page, 'Last 3 hours').getByTestId(`slack-thread-${crossMidnight.ts}`),
  ).toBeVisible();
  await expect(groupOf(page, 'Last 3 hours').getByTestId(`slack-thread-${exact.ts}`)).toBeVisible();
  await expect(groupOf(page, 'Yesterday').getByTestId(`slack-thread-${justPast.ts}`)).toBeVisible();
  // An unusable and a future activity time cannot be placed in a group, so neither thread is shown or
  // counted (not as a card, a tab count, or a reply that needs checking) and the note says how many.
  await expect(cardOf(page, unknown)).toHaveCount(0);
  await expect(cardOf(page, future)).toHaveCount(0);
  await expect(page.getByText('Activity time unavailable')).toHaveCount(0);
  await expect(page.locator('button[data-testid^="slack-thread-"]')).toHaveCount(3);
  await expect(page.getByTestId('slack-tab-started').locator('.board-tab-count')).toHaveText('3');
  await expect(page.getByTestId('slack-threads-meta')).toContainText(
    '0 loaded threads need a reply',
  );
  await expect(page.getByTestId('slack-threads-meta')).not.toContainText('All caught up');
  await expect(page.getByTestId('slack-coverage')).toContainText(
    '2 loaded threads with no usable activity time are not shown.',
  );
  const before = listReads(dashboard).length;
  await page.clock.runFor(1);
  await expect(groupOf(page, 'Yesterday').getByTestId(`slack-thread-${exact.ts}`)).toBeVisible();
  expect(listReads(dashboard)).toHaveLength(before);
});

test('board activity: local calendar boundaries remain correct after the fall DST change', async ({
  page,
  dashboard,
}) => {
  const now = Date.parse('2026-11-02T17:00:00Z'); // noon EST, a 25-hour day just elapsed
  await freeze(page, now);
  const seventh = row(
    'Fall seven dates',
    Date.parse('2026-10-26T04:00:00Z'),
    Date.parse('2026-10-26T04:00:00Z'),
    { replyCount: 0 },
  );
  const eighth = row(
    'Fall eight dates',
    Date.parse('2026-10-25T04:00:00Z'),
    Date.parse('2026-10-25T04:00:00Z'),
    { replyCount: 0 },
  );
  seed(dashboard, now, [eighth, seventh]);
  await openSlack(page);
  await expect(groupOf(page, 'Past week').getByTestId(`slack-thread-${seventh.ts}`)).toBeVisible();
  await expect(groupOf(page, 'Past month').getByTestId(`slack-thread-${eighth.ts}`)).toBeVisible();
});

test('board activity: crossing local midnight regroups without fetching', async ({
  page,
  dashboard,
}) => {
  const now = Date.parse('2026-03-10T03:59:58.000Z'); // 23:59:58 EDT
  await freeze(page, now);
  const earlier = row('Earlier before midnight', now - DAY, now - 5 * HOUR);
  const recent = row('Recent across midnight', now - DAY - 1000, now - 60_000);
  seed(dashboard, now, [earlier, recent]);
  await openSlack(page);
  await expect(groupOf(page, 'Today').getByTestId(`slack-thread-${earlier.ts}`)).toBeVisible();
  await expect(
    groupOf(page, 'Last 3 hours').getByTestId(`slack-thread-${recent.ts}`),
  ).toBeVisible();
  const before = listReads(dashboard).length;
  await page.clock.runFor(3000);
  await expect(groupOf(page, 'Yesterday').getByTestId(`slack-thread-${earlier.ts}`)).toBeVisible();
  await expect(
    groupOf(page, 'Last 3 hours').getByTestId(`slack-thread-${recent.ts}`),
  ).toBeVisible();
  expect(listReads(dashboard)).toHaveLength(before);
});

test('board scope: live expiry removes both consumers and rejects a late dialog response but keeps an old watcher', async ({
  page,
  dashboard,
}) => {
  await freeze(page, NOON);
  ticketBoardData(dashboard.data);
  const { key } = dashboard.data.tickets.tickets[0];
  const thread = row(`${key}: expiring conversation`, NOON - 28 * DAY + 5000, NOON - HOUR);
  const watched = watchLink(CHANNEL, slackTs(NOON - 60 * DAY));
  seed(dashboard, NOON, [thread]);
  dashboard.data.slack.watch = slackWatchData({ links: [watched] });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let requested = false;
  await page.route(
    (url) => url.pathname === '/api/slack/thread',
    async (route) => {
      requested = true;
      await gate;
      await route
        .fulfill({ json: { available: true, thread: threadRead(thread) } })
        .catch(() => {});
    },
  );
  try {
    await page.goto('/#/my-tickets');
    await expect(page.getByTestId(`slack-thread-link-${thread.ts}`)).toBeVisible();
    await page.getByTestId('tab-slack').click();
    await expect(cardOf(page, thread)).toBeVisible();
    await page.getByTestId('slack-tab-watch').click();
    await expect(page.getByTestId(`slack-watch-row-${watched.key}`)).toBeVisible();
    await page.getByTestId('slack-tab-started').click();
    await cardOf(page, thread).click();
    await expect(page.getByTestId('slack-thread-dialog')).toBeVisible();
    await expect.poll(() => requested).toBe(true);
    const before = listReads(dashboard).length;
    await page.clock.runFor(5001);
    await expect(cardOf(page, thread)).toHaveCount(0);
    await expect(page.getByTestId(`slack-thread-link-${thread.ts}`)).toHaveCount(0);
    await expect(page.getByTestId('slack-thread-dialog')).toHaveCount(0);
    expect(listReads(dashboard)).toHaveLength(before);
    const response = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/slack/thread',
    );
    release();
    await (await response).finished();
    await page.clock.runFor(1);
    await expect(page.getByTestId(`slack-thread-message-${thread.ts}`)).toHaveCount(0);
    await page.getByTestId('slack-tab-watch').click();
    await expect(page.getByTestId(`slack-watch-row-${watched.key}`)).toBeVisible();
    await page.getByTestId('tab-my-tickets').click();
    await expect(page.getByTestId('my-tickets-board')).toBeVisible();
    await expect(page.getByTestId(`slack-thread-link-${thread.ts}`)).toHaveCount(0);
  } finally {
    release();
  }
});

test('board interaction: both tabs retain needs-reply, dialog, focus and independent watcher', async ({
  page,
  dashboard,
}) => {
  await freeze(page, NOON);
  const started = row('Started conversation', NOON - DAY, NOON - HOUR, { needsReply: true });
  const mention = row('Please take a look', NOON - 2 * DAY, NOON - 2 * HOUR, {
    author: RILEY,
    needsReply: true,
  });
  const watched = watchLink(CHANNEL, slackTs(NOON - 60 * DAY));
  seed(dashboard, NOON, [started], [mention]);
  dashboard.data.slack.watch = slackWatchData({ links: [watched] });
  await openSlack(page);
  await expect(cardOf(page, started)).toContainText('Needs reply');
  await page.getByTestId('slack-tab-mentions').click();
  await expect(cardOf(page, mention)).toContainText('@Riley Sample mentioned you');
  await expect(cardOf(page, mention)).toContainText('Needs reply');
  await cardOf(page, mention).click();
  const dialog = page.getByTestId('slack-thread-dialog');
  await expect(dialog.getByTestId(`slack-thread-message-${mention.ts}`)).toContainText(
    mention.text,
  );
  await dialog.getByTestId('slack-thread-close').click();
  await expect(cardOf(page, mention)).toBeFocused();
  await page.getByTestId('slack-tab-started').click();
  await expect(cardOf(page, started)).toBeVisible();
  await page.getByTestId('slack-tab-watch').click();
  await expect(page.getByTestId(`slack-watch-row-${watched.key}`)).toBeVisible();
  await expect(page.getByTestId('slack-watch-links-input')).toBeVisible();
  await page.getByTestId('slack-tab-started').click();
  await expect(boardOf(page)).toBeVisible();
});

test('board interaction: focus scroll mobile survives a card moving while its dialog is open', async ({
  page,
  dashboard,
}) => {
  await freeze(page, NOON);
  await page.setViewportSize({ width: 1024, height: 768 });
  const moving = row('Moving conversation', NOON - DAY, NOON - 3 * HOUR + 1000);
  const threads = Array.from({ length: 26 }, (_, index) =>
    row(`Other conversation ${index}`, NOON - 2 * HOUR - index * 1000, NOON - index * 60_000),
  );
  seed(dashboard, NOON, [...threads, moving]);
  await openSlack(page);
  const board = boardOf(page);
  const body = groupOf(page, 'Last 3 hours').getByRole('list');
  await expect(board).toBeVisible();
  await cardOf(page, moving).click();
  const dialog = page.getByTestId('slack-thread-dialog');
  await expect(dialog.getByTestId(`slack-thread-message-${moving.ts}`)).toBeVisible();
  await body.evaluate((element) => {
    element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) / 2);
  });
  // Near the second column's snap point (the same value the My Tickets board specs use): the shared
  // board snaps to columns, so an arbitrary offset would settle somewhere else before it is read.
  await board.evaluate((element) => element.scrollTo({ left: 300, behavior: 'instant' }));
  const before = await body.evaluate((element) => element.scrollTop);
  const leftBefore = await board.evaluate((element) => element.scrollLeft);
  expect(before).toBeGreaterThan(0);
  expect(leftBefore).toBeGreaterThan(0);
  await page.clock.runFor(1001);
  await expect(groupOf(page, 'Today').getByTestId(`slack-thread-${moving.ts}`)).toBeAttached();
  expect(await body.evaluate((element) => element.scrollTop)).toBe(before);
  expect(await board.evaluate((element) => element.scrollLeft)).toBe(leftBefore);
  await dialog.getByTestId('slack-thread-close').click();
  await expect
    .poll(() =>
      page.evaluate((id) => {
        const active = document.activeElement;
        return (
          active?.getAttribute('data-testid') === id ||
          (active?.getAttribute('role') === 'region' &&
            /slack.*board/i.test(active.getAttribute('aria-label') || ''))
        );
      }, `slack-thread-${moving.ts}`),
    )
    .toBe(true);
});

test('board interaction: each tab restores its own column scroll', async ({ page, dashboard }) => {
  await freeze(page, NOON);
  const started = Array.from({ length: 30 }, (_, index) =>
    row(`Started ${index}`, NOON - 4 * HOUR - index * 1000, NOON - index * 60_000),
  );
  const mentions = Array.from({ length: 30 }, (_, index) =>
    row(`Mention ${index}`, NOON - 5 * HOUR - index * 1000, NOON - index * 60_000),
  );
  seed(dashboard, NOON, started, mentions);
  await openSlack(page);
  const body = groupOf(page, 'Last 3 hours').getByRole('list');
  await body.evaluate((element) => {
    element.scrollTop = Math.floor(element.scrollHeight / 2);
  });
  const startedTop = await body.evaluate((element) => element.scrollTop);
  expect(startedTop).toBeGreaterThan(0);
  await page.getByTestId('slack-tab-mentions').click();
  await body.evaluate((element) => {
    element.scrollTop = 100;
  });
  const mentionsTop = await body.evaluate((element) => element.scrollTop);
  await page.getByTestId('slack-tab-started').click();
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBe(startedTop);
  await page.getByTestId('slack-tab-mentions').click();
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBe(mentionsTop);
});

test('board interaction: keyboard reaches every column on a narrow screen', async ({
  page,
  dashboard,
}) => {
  await freeze(page, NOON);
  await page.setViewportSize({ width: 390, height: 600 });
  const recent = row('Keyboard recent', NOON - DAY, NOON - HOUR);
  const today = row('Keyboard today', NOON - DAY - 1000, NOON - 5 * HOUR);
  const yesterday = row('Keyboard yesterday', NOON - 2 * DAY, Date.parse('2026-03-08T14:00:00Z'));
  const weekTime = Date.parse('2026-03-02T05:00:00Z');
  const monthTime = Date.parse('2026-03-01T05:00:00Z');
  const week = row('Keyboard week', weekTime, weekTime, { replyCount: 0 });
  const month = row('Keyboard month', monthTime, monthTime, { replyCount: 0 });
  seed(dashboard, NOON, [recent, today, yesterday, week, month]);
  await openSlack(page);
  const board = boardOf(page);
  await board.focus();
  for (const [index, group] of GROUPS.entries()) {
    await page.keyboard.press('Tab');
    await expect(groupOf(page, group).getByRole('list')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(cardOf(page, [recent, today, yesterday, week, month][index])).toBeFocused();
  }
  expect(await board.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
});

test('board interaction: keyboard reaches the watcher through its tab on a narrow screen', async ({
  page,
  dashboard,
}, testInfo) => {
  await freeze(page, NOON);
  await page.setViewportSize({ width: 390, height: 600 });
  seed(dashboard, NOON, [row('Keyboard recent', NOON - DAY, NOON - HOUR)]);
  await openSlack(page);
  await page.getByTestId('slack-tab-watch').focus();
  await page.keyboard.press('Enter');
  // The bar renders once the first watch read has landed; Tab only counts from there.
  await expect(page.getByTestId('slack-watch-check')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('slack-watch-check')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('slack-watch-pause')).toBeFocused();
  await page.keyboard.press('Tab');
  const watcherInput = page.getByTestId('slack-watch-links-input');
  await expect(watcherInput).toBeFocused();
  await expect(watcherInput).toBeInViewport();
  await expect(watcherInput).toHaveAccessibleName('Slack thread links, one per line');
  await page.screenshot({ path: testInfo.outputPath('keyboard-watcher-390.png') });
});

for (const [width, height] of [
  [390, 600],
  [1024, 768],
  [1440, 900],
]) {
  test(`board interaction: focus scroll mobile at ${width}x${height}`, async ({
    page,
    dashboard,
  }) => {
    await freeze(page, NOON);
    await page.setViewportSize({ width, height });
    const threads = Array.from({ length: 26 }, (_, index) =>
      row(`Scrollable thread ${index}`, NOON - 2 * HOUR - index * 1000, NOON - index * 60_000),
    );
    seed(dashboard, NOON, threads);
    await openSlack(page);
    const board = boardOf(page);
    await expect(board).toBeVisible();
    await board.focus();
    await expect(board).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    const dimensions = await board.evaluate((element) => ({
      scroll: element.scrollWidth,
      client: element.clientWidth,
      overflow: getComputedStyle(element).overflowX,
    }));
    expect(dimensions.scroll).toBeGreaterThan(dimensions.client);
    expect(['auto', 'scroll']).toContain(dimensions.overflow);
    const column = groupOf(page, 'Last 3 hours');
    const body = column.getByRole('list');
    expect(await body.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
      true,
    );
    expect(await body.evaluate((element) => getComputedStyle(element).overflowY)).toMatch(
      /auto|scroll/,
    );
    const title = column.getByRole('heading', { name: /last 3 hours/i });
    const top = (await title.boundingBox()).y;
    await body.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    expect(Math.abs((await title.boundingBox()).y - top)).toBeLessThanOrEqual(1);
  });
}
