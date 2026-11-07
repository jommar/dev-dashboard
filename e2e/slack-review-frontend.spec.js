import { test, expect } from './fixtures.js';
import { slackAppThreadLink, ticketBoardData } from './data.js';

const NOW = Date.parse('2026-03-09T16:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const TEAM = 'T0EXAMPLE1';
const CHANNEL = 'C0EXAMPLE1';
const PERSON = { id: 'U0EXAMPLE1', name: 'Sam Example' };

function row(text, created) {
  const ts = `${Math.floor(created / 1000)}.${String((created % 1000) * 1000).padStart(6, '0')}`;
  return {
    ts,
    url: slackAppThreadLink(TEAM, CHANNEL, ts),
    watchKey: `${CHANNEL}:${ts}`,
    text,
    subjectText: text,
    author: PERSON,
    starter: PERSON,
    replyCount: 0,
    activityAt: new Date(created).toISOString(),
    needsReply: false,
    attachedSessions: 0,
  };
}

function threadRead(thread) {
  return {
    ts: thread.ts,
    url: thread.url,
    watchKey: thread.watchKey,
    channel: { id: CHANNEL, name: 'example_channel' },
    replyCount: 0,
    messages: [
      {
        ts: thread.ts,
        at: new Date(Number(thread.ts) * 1000).toISOString(),
        author: PERSON,
        text: thread.text,
        mrkdwn: thread.text,
      },
    ],
  };
}

function seed(dashboard, threads) {
  Object.assign(dashboard.data.slack.threads, {
    available: true,
    enriched: true,
    updatedAt: new Date(NOW).toISOString(),
    serverTime: new Date(NOW).toISOString(),
    started: threads,
    mentions: [],
  });
}

async function freeze(page, time) {
  await page.clock.install({ time: time - 60_000 });
  await page.clock.pauseAt(time);
}

function link(page, panel, thread) {
  return page.getByTestId(
    `${panel === 'slack' ? 'slack-thread' : 'slack-thread-link'}-${thread.ts}`,
  );
}

function deferred() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

for (const panel of ['slack', 'my-tickets']) {
  test(`server clock: ${panel} does not show a root that expired during the post-list status delay`, async ({
    page,
    dashboard,
  }) => {
    await freeze(page, NOW - DAY);
    ticketBoardData(dashboard.data);
    const { key } = dashboard.data.tickets.tickets[0];
    const expiring = row(`${key}: expires during status`, NOW - 28 * DAY + 5000);
    const stable = row(`${key}: remains eligible`, NOW - DAY);
    seed(dashboard, [expiring, stable]);
    dashboard.data.slack.status.sessionVersion = 'same-session';
    const gate = deferred();
    let listDelivered = false;
    let heldStatus = false;
    await page.route('**/api/slack/threads', async (route) => {
      listDelivered = true;
      await route.fulfill({ json: dashboard.data.slack.threads });
    });
    await page.route('**/api/slack/status', async (route) => {
      if (listDelivered && !heldStatus) {
        heldStatus = true;
        await gate.promise;
      }
      await route.fulfill({ json: dashboard.data.slack.status }).catch(() => {});
    });
    try {
      await page.goto(`/#/${panel}`);
      await expect.poll(() => heldStatus).toBe(true);
      await page.clock.runFor(10_000);
      gate.release();
      // The second row proves the delayed snapshot was committed, not merely absent.
      await expect(link(page, panel, stable)).toBeVisible();
      await expect(link(page, panel, expiring)).toHaveCount(0);
    } finally {
      gate.release();
    }
  });

  test(`server clock: ${panel} expires a root after the browser wall clock moves backwards`, async ({
    page,
    dashboard,
  }) => {
    await freeze(page, NOW - DAY);
    ticketBoardData(dashboard.data);
    const { key } = dashboard.data.tickets.tickets[0];
    const expiring = row(`${key}: expires after clock correction`, NOW - 28 * DAY + 5000);
    seed(dashboard, [expiring]);
    dashboard.data.slack.status.sessionVersion = 'same-session';
    await page.goto(`/#/${panel}`);
    await expect(link(page, panel, expiring)).toBeVisible();
    await page.clock.setSystemTime(NOW - DAY - 60 * 60 * 1000);
    await page.clock.runFor(6000);
    await expect(link(page, panel, expiring)).toHaveCount(0);
  });

  test(`session race: ${panel} rejects a pre-poll old-session dialog response`, async ({
    page,
    dashboard,
  }) => {
    await freeze(page, NOW);
    ticketBoardData(dashboard.data);
    const { key } = dashboard.data.tickets.tickets[0];
    const old = row(`${key}: previous session secret`, NOW - DAY);
    seed(dashboard, [old]);
    dashboard.data.slack.status.sessionVersion = 'session-A';
    const gate = deferred();
    let requested = false;
    await page.route('**/api/slack/thread?*', async (route) => {
      // This response was produced under A, but is delayed in transit to the browser.
      requested = true;
      await gate.promise;
      await route.fulfill({ json: { available: true, thread: threadRead(old) } }).catch(() => {});
    });
    try {
      await page.goto(`/#/${panel}`);
      await link(page, panel, old).click();
      const dialog = page.getByTestId('slack-thread-dialog');
      await expect(dialog).toBeVisible();
      await expect.poll(() => requested).toBe(true);
      await expect(dialog.getByTestId('slack-thread-loading')).toBeVisible();
      dashboard.data.slack.status.sessionVersion = 'session-B';
      const response = page.waitForResponse(
        (value) => new URL(value.url()).pathname === '/api/slack/thread',
      );
      gate.release();
      await (await response).finished();
      // Wait until the response is consumed or the dialog closes. Checking only
      // immediately after release would pass before React processes the response.
      await expect
        .poll(
          async () =>
            (await dialog.count()) === 0 ||
            (await dialog.getByTestId('slack-thread-loading').count()) === 0,
        )
        .toBe(true);
      await expect(page.getByTestId(`slack-thread-message-${old.ts}`)).toHaveCount(0);
    } finally {
      gate.release();
    }
  });
}

test('session race: My Tickets detects replacement before Slack reopens with a held status', async ({
  page,
  dashboard,
}) => {
  await freeze(page, NOW);
  ticketBoardData(dashboard.data);
  const { key } = dashboard.data.tickets.tickets[0];
  const old = row(`${key}: session A`, NOW - DAY);
  const next = row(`${key}: session B`, NOW - DAY - 1000);
  dashboard.data.slack.status.sessionVersion = 'session-A';
  seed(dashboard, [old]);
  const gate = deferred();
  let holdNextStatus = false;
  let heldStatuses = 0;
  await page.route('**/api/slack/status', async (route) => {
    if (holdNextStatus) {
      heldStatuses += 1;
      await gate.promise;
    }
    await route.fulfill({ json: dashboard.data.slack.status }).catch(() => {});
  });
  try {
    await page.goto('/#/slack');
    await expect(link(page, 'slack', old)).toBeVisible();
    await page.getByTestId('tab-my-tickets').click();
    await expect(link(page, 'my-tickets', old)).toBeVisible();
    await expect(link(page, 'slack', old)).toBeAttached();
    dashboard.data.slack.status.sessionVersion = 'session-B';
    seed(dashboard, [next]);
    await page.getByTestId('my-tickets-refresh').click();
    await expect(link(page, 'my-tickets', next)).toBeVisible();
    await expect(link(page, 'my-tickets', old)).toHaveCount(0);
    holdNextStatus = true;
    await page.getByTestId('tab-slack').click();
    await expect(page.getByTestId('panel-slack')).toBeVisible();
    await expect.poll(() => heldStatuses).toBeGreaterThan(0);
    await expect(link(page, 'slack', old)).toBeHidden();
  } finally {
    gate.release();
  }
});

test('session race: My Tickets reloads Slack after an inactive session change', async ({
  page,
  dashboard,
}) => {
  await freeze(page, NOW);
  ticketBoardData(dashboard.data);
  const { key } = dashboard.data.tickets.tickets[0];
  const old = row(`${key}: inactive session A`, NOW - DAY);
  const next = row(`${key}: inactive session B`, NOW - DAY - 1000);
  dashboard.data.slack.status.sessionVersion = 'session-A';
  seed(dashboard, [old]);
  await page.goto('/#/slack');
  await expect(link(page, 'slack', old)).toBeVisible();
  await page.getByTestId('tab-my-tickets').click();
  await expect(link(page, 'my-tickets', old)).toBeVisible();
  await page.getByTestId('tab-slack').click();
  dashboard.data.slack.status.sessionVersion = 'session-B';
  seed(dashboard, [next]);
  await page.clock.runFor(60_000);
  await expect(link(page, 'slack', next)).toBeVisible();
  await page.getByTestId('tab-my-tickets').click();
  await expect(link(page, 'my-tickets', next)).toBeVisible();
  await expect(link(page, 'my-tickets', old)).toHaveCount(0);
});

test('session race: My Tickets retries once when the session changes during its list read', async ({
  page,
  dashboard,
}) => {
  await freeze(page, NOW);
  ticketBoardData(dashboard.data);
  const { key } = dashboard.data.tickets.tickets[0];
  const old = row(`${key}: replaced during listing`, NOW - DAY);
  const next = row(`${key}: replacement listing`, NOW - DAY - 1000);
  dashboard.data.slack.status.sessionVersion = 'session-A';
  seed(dashboard, [old]);
  const oldResult = structuredClone(dashboard.data.slack.threads);
  let listReads = 0;
  await page.route('**/api/slack/threads', async (route) => {
    listReads += 1;
    if (listReads === 1) {
      dashboard.data.slack.status.sessionVersion = 'session-B';
      seed(dashboard, [next]);
      await route.fulfill({ json: oldResult });
    } else await route.fulfill({ json: dashboard.data.slack.threads });
  });
  await page.goto('/#/my-tickets');
  await expect(link(page, 'my-tickets', next)).toBeVisible();
  await expect(link(page, 'my-tickets', old)).toHaveCount(0);
  expect(listReads).toBe(2);
});

test('session race: My Tickets does not immediately retry an unversioned session replacement', async ({
  page,
  dashboard,
}) => {
  await freeze(page, NOW);
  ticketBoardData(dashboard.data);
  const { key } = dashboard.data.tickets.tickets[0];
  const old = row(`${key}: old unversioned listing`, NOW - DAY);
  const next = row(`${key}: later replacement listing`, NOW - DAY - 1000);
  dashboard.data.slack.status.savedAt = '2026-03-09T15:00:00Z';
  seed(dashboard, [old]);
  const oldResult = structuredClone(dashboard.data.slack.threads);
  let listReads = 0;
  let statusReads = 0;
  await page.route('**/api/slack/status', async (route) => {
    statusReads += 1;
    await route.fulfill({ json: dashboard.data.slack.status });
  });
  await page.route('**/api/slack/threads', async (route) => {
    listReads += 1;
    if (listReads === 1) {
      dashboard.data.slack.status.savedAt = '2026-03-09T16:00:00Z';
      seed(dashboard, [next]);
      await route.fulfill({ json: oldResult });
    } else await route.fulfill({ json: dashboard.data.slack.threads });
  });
  await page.goto('/#/my-tickets');
  await expect.poll(() => statusReads).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId('my-tickets-board')).toBeVisible();
  await page.clock.runFor(2000);
  expect(listReads).toBe(1);
  await expect(link(page, 'my-tickets', old)).toHaveCount(0);
  await page.getByTestId('my-tickets-refresh').click();
  await expect(link(page, 'my-tickets', next)).toBeVisible();
  await expect(link(page, 'my-tickets', old)).toHaveCount(0);
});

test('incomplete Slack refresh replaces ticket links and warns until Load more restores them', async ({
  page,
  dashboard,
}) => {
  await freeze(page, NOW);
  ticketBoardData(dashboard.data);
  const { key } = dashboard.data.tickets.tickets[0];
  const old = row(`${key}: omitted until continuation`, NOW - DAY);
  const fresh = row(`${key}: returned by refresh`, NOW - DAY - 1000);
  dashboard.data.slack.status.sessionVersion = 'same-session';
  seed(dashboard, [old]);
  await page.route('**/api/slack/threads**', async (route) => {
    if (new URL(route.request().url()).searchParams.get('continuation') === 'next-page') {
      seed(dashboard, [fresh, old]);
      Object.assign(dashboard.data.slack.threads, {
        partial: false,
        truncated: false,
        continuation: null,
      });
    }
    await route.fulfill({ json: dashboard.data.slack.threads });
  });
  await page.goto('/#/my-tickets');
  await expect(link(page, 'my-tickets', old)).toBeVisible();
  seed(dashboard, [fresh]);
  Object.assign(dashboard.data.slack.threads, {
    partial: true,
    continuation: 'next-page',
  });
  await page.getByTestId('my-tickets-refresh').click();
  await expect(link(page, 'my-tickets', fresh)).toBeVisible();
  await expect(link(page, 'my-tickets', old)).toHaveCount(0);
  await expect(page.getByTestId('my-tickets-slack-coverage')).toContainText(/incomplete/i);
  await page.getByTestId('my-tickets-slack-coverage').getByRole('link', { name: /Slack/i }).click();
  await expect(page.getByTestId('panel-slack')).toBeVisible();
  await expect(link(page, 'slack', fresh)).toBeVisible();
  await expect(link(page, 'slack', old)).toHaveCount(0);
  await page.getByRole('button', { name: 'Load more eligible threads' }).click();
  await expect(link(page, 'slack', old)).toBeVisible();
  await page.getByTestId('tab-my-tickets').click();
  await page.getByTestId('my-tickets-refresh').click();
  await expect(link(page, 'my-tickets', old)).toBeVisible();
  await expect(page.getByTestId('my-tickets-slack-coverage')).toHaveCount(0);
});

test('My Tickets warns when an incomplete Slack listing is empty', async ({ page, dashboard }) => {
  await freeze(page, NOW);
  ticketBoardData(dashboard.data);
  dashboard.data.slack.status.sessionVersion = 'same-session';
  seed(dashboard, []);
  Object.assign(dashboard.data.slack.threads, { partial: true, continuation: 'next-page' });
  await page.goto('/#/my-tickets');
  await expect(page.getByTestId('my-tickets-board')).toBeVisible();
  await expect(page.getByTestId('my-tickets-slack-coverage')).toContainText(/incomplete/i);
  await expect(page.getByTestId('my-tickets-slack-coverage').getByRole('link')).toHaveAttribute(
    'href',
    '#/slack',
  );
});
