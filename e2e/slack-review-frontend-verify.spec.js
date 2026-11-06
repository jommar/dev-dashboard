import { createSlackBoard } from '../backend/slack-board.mjs';
import { test, expect } from './fixtures.js';
import { ticketBoardData } from './data.js';

const NOW = Date.parse('2026-03-09T16:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const TEAM = 'T0EXAMPLE1';
const CHANNEL = 'C0EXAMPLE1';
const ME = 'U0EXAMPLE1';

function ts(ms) {
  return `${Math.floor(ms / 1000)}.${String((ms % 1000) * 1000).padStart(6, '0')}`;
}

async function freeze(page) {
  await page.clock.install({ time: NOW - 60_000 });
  await page.clock.pauseAt(NOW);
}

async function flush() {
  for (let index = 0; index < 30; index++) await new Promise((resolve) => setImmediate(resolve));
}

for (const panel of ['slack', 'my-tickets']) {
  test(`an unverified backend refresh clears old rows and warns in ${panel}`, async ({
    page,
    dashboard,
  }) => {
    await freeze(page);
    ticketBoardData(dashboard.data);
    const rootTs = ts(NOW - DAY);
    const root = {
      ts: rootTs,
      thread_ts: rootTs,
      user: ME,
      text: `${dashboard.data.tickets.tickets[0].key}: previous confirmed root`,
      reply_count: 0,
    };
    let backendNow = NOW;
    let identityVerified = true;
    const board = createSlackBoard({
      call: async (method) => {
        if (method === 'conversations.history') return { ok: true, messages: [root] };
        if (method === 'search.messages')
          return { ok: true, messages: { matches: [], total: 0, paging: { pages: 1 } } };
        throw new Error(`unexpected fake Slack method ${method}`);
      },
      session: () => ({ teamId: TEAM }),
      verify: async () =>
        identityVerified
          ? { connected: true, userId: ME, teamId: TEAM, user: 'Sam Example' }
          : { connected: true, verified: false, userId: '' },
      channel: async () => ({ id: CHANNEL, name: 'example_channel' }),
      users: async () => ({}),
      now: () => backendNow,
      isCurrent: () => true,
      generation: () => 1,
    });
    await board.threads();
    await flush();
    const initial = structuredClone(await board.threads());
    expect(initial.started.map((item) => item.ts)).toEqual([rootTs]);
    dashboard.data.slack.status.sessionVersion = 'same-session';
    Object.assign(dashboard.data.slack.threads, initial);
    let failedRefresh = false;
    let failedReads = 0;
    await page.route('**/api/slack/threads', async (route) => {
      if (failedRefresh) failedReads += 1;
      await route.fulfill({ json: dashboard.data.slack.threads });
    });
    const oldLink = page.getByTestId(
      `${panel === 'slack' ? 'slack-thread' : 'slack-thread-link'}-${rootTs}`,
    );
    await page.goto(`/#/${panel}`);
    await expect(oldLink).toBeVisible();
    identityVerified = false;
    backendNow += 300_001;
    await board.threads();
    await flush();
    const partial = structuredClone(await board.threads());
    expect(partial.partial).toBe(true);
    expect(partial.partialReasons).toContain('refresh_failed');
    if (partial.available) expect(partial.started).toEqual([]);
    dashboard.data.slack.threads = partial;
    failedRefresh = true;
    if (panel === 'slack') await page.clock.runFor(60_000);
    else await page.getByTestId('my-tickets-refresh').click();
    await expect.poll(() => failedReads).toBeGreaterThan(0);
    if (panel === 'slack') {
      await expect(page.getByTestId('panel-slack')).toContainText(/incomplete|not responding/i);
      await expect(oldLink).toHaveCount(0);
    } else {
      await expect(oldLink).toHaveCount(0);
      await expect(page.getByTestId('my-tickets-slack-coverage')).toContainText(/incomplete/i);
    }
  });
}

test('ambiguous mentions are skipped, both panels warn, and Slack identifies missing standalone coverage', async ({
  page,
  dashboard,
}) => {
  await freeze(page);
  ticketBoardData(dashboard.data);
  const key = dashboard.data.tickets.tickets[0].key;
  const verified = {
    ts: ts(NOW - DAY),
    thread_ts: ts(NOW - DAY),
    user: ME,
    text: `${key}: verified <@${ME}>`,
    reply_count: 0,
  };
  const ambiguous = {
    ts: ts(NOW - 3000),
    user: 'U0EXAMPLE2',
    text: `Unmarked <@${ME}>`,
    channel: { id: CHANNEL },
  };
  const calls = [];
  const board = createSlackBoard({
    call: async (method, params) => {
      calls.push({ method, params });
      if (method === 'conversations.history') return { ok: true, messages: [verified] };
      if (method === 'search.messages')
        return { ok: true, messages: { matches: [ambiguous], total: 1, paging: { pages: 1 } } };
      throw new Error(`unexpected fake Slack method ${method}`);
    },
    session: () => ({ teamId: TEAM }),
    verify: async () => ({ connected: true, userId: ME, teamId: TEAM, user: 'Sam Example' }),
    channel: async () => ({ id: CHANNEL, name: 'example_channel' }),
    users: async () => ({}),
    now: () => NOW,
    isCurrent: () => true,
    generation: () => 1,
  });
  const result = structuredClone(await board.threads());
  expect(result.partial).toBe(true);
  expect(result.partialReasons).toContain('ambiguous_search_result');
  expect(result.mentions.map((item) => item.ts)).toContain(verified.ts);
  expect(result.mentions.map((item) => item.ts)).not.toContain(ambiguous.ts);
  expect(calls.filter((call) => call.method === 'conversations.replies')).toEqual([]);
  dashboard.data.slack.status.sessionVersion = 'same-session';
  Object.assign(dashboard.data.slack.threads, result);

  await page.goto('/#/my-tickets');
  await expect(page.getByTestId(`slack-thread-link-${verified.ts}`)).toBeVisible();
  await expect(page.getByTestId('my-tickets-slack-coverage')).toContainText(/incomplete/i);
  await page.getByTestId('tab-slack').click();
  await expect(page.getByTestId(`slack-thread-${verified.ts}`)).toBeVisible();
  await expect(page.getByTestId('slack-threads-card')).toContainText(/incomplete/i);
  await expect(page.getByTestId('slack-threads-card')).toContainText(/standalone.*mention/i);
});
