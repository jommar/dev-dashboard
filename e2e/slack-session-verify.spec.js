import { createSlackIntegration, slackPaths } from '../backend/slack.mjs';
import { test, expect } from './fixtures.js';
import { slackAppThreadLink, ticketBoardData } from './data.js';

const NOW = Date.parse('2026-03-09T16:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const TEAM = 'T0EXAMPLE1';
const CHANNEL = 'C0EXAMPLE1';
const PERSON = { id: 'U0EXAMPLE1', name: 'Sam Example' };

function row(text, offset) {
  const created = NOW - DAY - offset * 1000;
  const ts = `${Math.floor(created / 1000)}.000000`;
  return {
    ts,
    url: slackAppThreadLink(TEAM, CHANNEL, ts),
    watchKey: `${CHANNEL}:${ts}`,
    text,
    subjectText: text,
    author: PERSON,
    starter: PERSON,
    replyCount: 1,
    activityAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
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
    replyCount: 1,
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

function seed(dashboard, thread) {
  Object.assign(dashboard.data.slack.threads, {
    available: true,
    enriched: true,
    updatedAt: new Date(NOW).toISOString(),
    serverTime: new Date(NOW).toISOString(),
    started: [thread],
    mentions: [],
  });
  dashboard.data.slack.threadReads = { [thread.ts]: threadRead(thread) };
}

async function freeze(page) {
  await page.clock.install({ time: NOW - 60_000 });
  await page.clock.pauseAt(NOW);
}

function syntheticLegacySessions() {
  let credentials = { token: 'xoxc-invented-one', cookie: 'xoxd-invented-one', teamId: TEAM };
  const paths = slackPaths('/virtual-slack-session-verification');
  const fs = {
    lstatSync(file) {
      return {
        isDirectory: () => file !== paths.session,
        isFile: () => file === paths.session,
        isSymbolicLink: () => false,
      };
    },
    chmodSync() {},
    readFileSync: () => JSON.stringify(credentials),
  };
  const fetchImpl = async (url) => {
    if (new URL(url).pathname !== '/api/auth.test') throw new Error('Unexpected fake Slack method');
    return new Response(
      JSON.stringify({
        ok: true,
        user: 'same-user',
        user_id: PERSON.id,
        team: 'same-team',
        team_id: TEAM,
      }),
    );
  };
  return {
    integration: createSlackIntegration({ paths, fs, fetchImpl, now: () => NOW }),
    replace() {
      credentials = { token: 'xoxc-invented-two', cookie: 'xoxd-invented-two', teamId: TEAM };
    },
  };
}

test('real session status signals a same-account legacy credential replacement to the board', async ({
  page,
  dashboard,
}) => {
  await freeze(page);
  const first = row('Legacy session old conversation', 0);
  const second = row('Legacy session new conversation', 1);
  const fake = syntheticLegacySessions();
  const before = await fake.integration.status();
  expect(before.connected).toBe(true);
  expect(before.savedAt).toBe('');
  await page.route(
    (url) => url.pathname === '/api/slack/status',
    async (route) => {
      await route.fulfill({ json: await fake.integration.status() });
    },
  );
  seed(dashboard, first);
  await page.goto('/#/slack');
  const firstCard = page.getByTestId(`slack-thread-${first.ts}`);
  await firstCard.click();
  const dialog = page.getByTestId('slack-thread-dialog');
  await expect(dialog.getByTestId(`slack-thread-message-${first.ts}`)).toContainText(first.text);

  fake.replace();
  const after = await fake.integration.status();
  expect(after.userId).toBe(before.userId);
  expect(after.teamId).toBe(before.teamId);
  expect(after.savedAt).toBe('');
  expect(after.sessionVersion).not.toBe(before.sessionVersion);
  seed(dashboard, second);
  await page.clock.runFor(60_000);
  await expect(page.getByTestId(`slack-thread-${second.ts}`)).toHaveCount(1);
  await expect(firstCard).toHaveCount(0);
  await expect(dialog).toHaveCount(0);
});

for (const panel of ['slack', 'my-tickets']) {
  test(`late dialog data from a replaced session cannot repaint ${panel}`, async ({
    page,
    dashboard,
  }) => {
    await freeze(page);
    ticketBoardData(dashboard.data);
    const { key } = dashboard.data.tickets.tickets[0];
    const first = row(`${key}: old delayed conversation`, 0);
    const second = row(`${key}: replacement conversation`, 1);
    dashboard.data.slack.status.sessionVersion = 'before-replacement';
    seed(dashboard, first);
    let release;
    let requested = false;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    await page.route(
      (url) => url.pathname === '/api/slack/thread',
      async (route) => {
        requested = true;
        await held;
        await route
          .fulfill({ json: { available: true, thread: threadRead(first) } })
          .catch(() => {});
      },
    );
    const link = (entry) =>
      panel === 'slack'
        ? page.getByTestId(`slack-thread-${entry.ts}`)
        : page.getByTestId(`slack-thread-link-${entry.ts}`);
    try {
      await page.goto(`/#/${panel}`);
      await link(first).click();
      await expect(page.getByTestId('slack-thread-dialog')).toBeVisible();
      await expect.poll(() => requested).toBe(true);
      dashboard.data.slack.status.sessionVersion = 'after-replacement';
      seed(dashboard, second);
      await page.clock.runFor(panel === 'slack' ? 60_000 : 90_000);
      await expect(link(second)).toBeVisible();
      await expect(link(first)).toHaveCount(0);
      await expect(page.getByTestId('slack-thread-dialog')).toHaveCount(0);
      const response = page.waitForResponse(
        (value) => new URL(value.url()).pathname === '/api/slack/thread',
      );
      release();
      await (await response).finished();
      await page.clock.runFor(1000);
      await expect(page.getByTestId('slack-thread-dialog')).toHaveCount(0);
      await expect(page.getByTestId(`slack-thread-message-${first.ts}`)).toHaveCount(0);
      await expect(link(first)).toHaveCount(0);
    } finally {
      release();
    }
  });
}

test('disconnect and reconnect do not restore the former conversation', async ({
  page,
  dashboard,
}) => {
  await freeze(page);
  const first = row('Conversation before disconnect', 0);
  const second = row('Conversation after reconnect', 1);
  dashboard.data.slack.status.sessionVersion = 'before-disconnect';
  seed(dashboard, first);
  await page.route(
    (url) => url.pathname === '/api/slack/disconnect',
    async (route) => {
      dashboard.data.slack.status = { connected: false, connecting: false };
      await route.fulfill({ json: { ok: true } });
    },
  );
  await page.route(
    (url) => url.pathname === '/api/slack/connect',
    async (route) => {
      await route.fulfill({ json: { ok: true } });
    },
  );
  await page.goto('/#/slack');
  await page.getByTestId(`slack-thread-${first.ts}`).click();
  await expect(page.getByTestId(`slack-thread-message-${first.ts}`)).toContainText(first.text);
  await page.getByTestId('slack-thread-close').click();
  await expect(page.getByTestId('slack-thread-dialog')).toHaveCount(0);
  await page.getByTestId('slack-disconnect').click();
  await expect(page.getByTestId('slack-thread-dialog')).toHaveCount(0);
  await expect(page.getByTestId(`slack-thread-${first.ts}`)).toHaveCount(0);
  await expect(page.getByTestId('slack-connect')).toBeVisible();
  await page.getByTestId('slack-connect').click();
  await expect(page.getByTestId('slack-connecting')).toBeVisible();
  dashboard.data.slack.status = {
    connected: true,
    connecting: false,
    user: 'developer',
    team: 'Example Workspace',
    sessionVersion: 'after-reconnect',
  };
  seed(dashboard, second);
  await page.clock.runFor(2000);
  await expect(page.getByTestId(`slack-thread-${second.ts}`)).toBeVisible();
  await expect(page.getByTestId(`slack-thread-${first.ts}`)).toHaveCount(0);
  await expect(page.getByTestId(`slack-thread-message-${first.ts}`)).toHaveCount(0);
});
