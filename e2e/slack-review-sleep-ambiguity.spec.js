import { createSlackBoard } from '../backend/slack-board.mjs';
import { test, expect } from './fixtures.js';
import { slackAppThreadLink, ticketBoardData } from './data.js';

const NOW = Date.parse('2026-03-09T16:00:00.000Z');
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const TEAM = 'T0EXAMPLE1';
const CHANNEL = 'C0EXAMPLE1';
const ME = 'U0EXAMPLE1';
const PERSON = { id: ME, name: 'Sam Example' };

function ts(ms) {
  return `${Math.floor(ms / 1000)}.${String((ms % 1000) * 1000).padStart(6, '0')}`;
}

function row(text, created) {
  const timestamp = ts(created);
  return {
    ts: timestamp,
    url: slackAppThreadLink(TEAM, CHANNEL, timestamp),
    watchKey: `${CHANNEL}:${timestamp}`,
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

function seedClockScenario(dashboard) {
  ticketBoardData(dashboard.data);
  const key = dashboard.data.tickets.tickets[0].key;
  const expiring = row(`${key}: near the rolling cutoff`, NOW - 28 * DAY + 5 * MINUTE);
  Object.assign(dashboard.data.slack.threads, {
    available: true,
    enriched: true,
    updatedAt: new Date(NOW).toISOString(),
    serverTime: new Date(NOW).toISOString(),
    started: [expiring],
    mentions: [],
  });
  dashboard.data.slack.status.sessionVersion = 'same-session';
  dashboard.data.slack.threadReads = {
    [expiring.ts]: {
      ts: expiring.ts,
      url: expiring.url,
      watchKey: expiring.watchKey,
      channel: { id: CHANNEL, name: 'example_channel' },
      replyCount: 0,
      messages: [
        {
          ts: expiring.ts,
          at: new Date(Number(expiring.ts) * 1000).toISOString(),
          author: PERSON,
          text: expiring.text,
          mrkdwn: expiring.text,
        },
      ],
    },
  };
  return expiring;
}

async function freezeSlowWall(page) {
  await page.clock.install({ time: NOW - DAY - MINUTE });
  await page.clock.pauseAt(NOW - DAY);
}

function link(page, panel, timestamp) {
  return page.getByTestId(
    `${panel === 'slack' ? 'slack-thread' : 'slack-thread-link'}-${timestamp}`,
  );
}

async function resumeWithFrozenMonotonic(page) {
  const before = await page.evaluate(() => ({ wall: Date.now(), mono: performance.now() }));
  await page.clock.setSystemTime(before.wall + 10 * MINUTE);
  const after = await page.evaluate(() => ({ wall: Date.now(), mono: performance.now() }));
  expect(after.wall - before.wall).toBe(10 * MINUTE);
  expect(after.mono).toBe(before.mono);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
}

async function historySnapshot(key, mention) {
  const verifiedTs = ts(NOW - DAY);
  const ambiguousTs = ts(NOW - MINUTE);
  const history = [
    { ts: verifiedTs, thread_ts: verifiedTs, user: ME, text: `${key}: verified`, reply_count: 0 },
    {
      ts: ambiguousTs,
      user: 'U0EXAMPLE2',
      text: mention ? `${key}: unmarked <@${ME}>` : `${key}: no mention`,
    },
  ];
  const calls = [];
  const board = createSlackBoard({
    call: async (method, params) => {
      calls.push({ method, params });
      if (method === 'conversations.history') return { ok: true, messages: history };
      if (method === 'search.messages')
        return { ok: true, messages: { matches: [], total: 0, paging: { pages: 1 } } };
      throw new Error(`unexpected fake Slack method ${method}`);
    },
    session: () => ({ teamId: TEAM }),
    verify: async () => ({ connected: true, userId: ME, teamId: TEAM, user: PERSON.name }),
    channel: async () => ({ id: CHANNEL, name: 'example_channel' }),
    users: async () => ({}),
    now: () => NOW,
    isCurrent: () => true,
    generation: () => 1,
  });
  const result = structuredClone(await board.threads());
  expect(result.partial).toBe(true);
  expect(result.partialReasons).toContain('search_coverage_uncertain');
  expect(result.started.map((item) => item.ts)).toContain(verifiedTs);
  expect([...result.started, ...result.mentions].map((item) => item.ts)).not.toContain(ambiguousTs);
  expect(calls.filter((call) => call.method === 'search.messages')).toHaveLength(2);
  expect(calls.filter((call) => call.method === 'conversations.replies')).toEqual([]);
  return { result, verifiedTs, ambiguousTs };
}

for (const panel of ['slack', 'my-tickets']) {
  for (const target of ['row', 'dialog']) {
    test(`sleep: ${panel} expires its ${target} after wall time advances while monotonic time is frozen`, async ({
      page,
      dashboard,
    }) => {
      await freezeSlowWall(page);
      const expiring = seedClockScenario(dashboard);
      await page.goto(`/#/${panel}`);
      await expect(link(page, panel, expiring.ts)).toBeVisible();
      if (target === 'dialog') {
        await link(page, panel, expiring.ts).click();
        await expect(page.getByTestId('slack-thread-dialog')).toBeVisible();
        await expect(page.getByTestId(`slack-thread-message-${expiring.ts}`)).toContainText(
          expiring.text,
        );
      }

      await resumeWithFrozenMonotonic(page);
      if (target === 'row') await expect(link(page, panel, expiring.ts)).toHaveCount(0);
      else await expect(page.getByTestId('slack-thread-dialog')).toHaveCount(0);
    });
  }

  test(`clock control: ${panel} keeps a valid dialog during normal elapsed time and expires it at the cutoff`, async ({
    page,
    dashboard,
  }) => {
    await freezeSlowWall(page);
    const expiring = seedClockScenario(dashboard);
    await page.goto(`/#/${panel}`);
    await expect(link(page, panel, expiring.ts)).toBeVisible();
    await link(page, panel, expiring.ts).click();
    const dialog = page.getByTestId('slack-thread-dialog');
    await expect(dialog.getByTestId(`slack-thread-message-${expiring.ts}`)).toContainText(
      expiring.text,
    );
    await page.clock.runFor(2 * MINUTE);
    await expect(dialog).toBeVisible();
    await expect(link(page, panel, expiring.ts)).toBeAttached();
    await page.clock.runFor(4 * MINUTE);
    await expect(dialog).toHaveCount(0);
    await expect(link(page, panel, expiring.ts)).toHaveCount(0);
  });

  for (const mention of [true, false]) {
    test(`history coverage: ${panel} ${mention ? 'discloses a skipped unmarked mention omitted by search' : 'does not label unrelated incomplete coverage as missing mentions'}`, async ({
      page,
      dashboard,
    }) => {
      await freezeSlowWall(page);
      ticketBoardData(dashboard.data);
      const { result, verifiedTs, ambiguousTs } = await historySnapshot(
        dashboard.data.tickets.tickets[0].key,
        mention,
      );
      dashboard.data.slack.status.sessionVersion = 'same-session';
      Object.assign(dashboard.data.slack.threads, result);
      await page.goto(`/#/${panel}`);
      await expect(link(page, panel, verifiedTs)).toBeVisible();
      await expect(link(page, panel, ambiguousTs)).toHaveCount(0);
      const coverage =
        panel === 'slack'
          ? page.getByTestId('slack-threads-card')
          : page.getByTestId('my-tickets-slack-coverage');
      await expect(coverage).toContainText(/incomplete/i);
      if (mention) await expect(coverage).toContainText(/standalone.*mention/i);
      else await expect(coverage).not.toContainText(/standalone.*mention/i);
    });
  }
}
