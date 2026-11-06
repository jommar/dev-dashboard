import { createSlackBoard } from '../backend/slack-board.mjs';
import { withAttachedSessions } from '../backend/slack-model.mjs';
import { test, expect } from './fixtures.js';
import { slackAppThreadLink, ticketBoardData } from './data.js';

const NOW = Date.parse('2026-03-09T16:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const TEAM = 'T0EXAMPLE1';
const CHANNEL = 'C0EXAMPLE1';
const ME = 'U0EXAMPLE1';
const OTHER = 'U0EXAMPLE2';

// Require the same sentence to identify reply/activity information and its age;
// a generic incomplete-list warning alone is not a stale-reply disclosure.
const REPLY = '(?:reply|replies|activity)';
const STALE =
  '(?:stale|outdated|out[ -]of[ -]date|not (?:be |fully )?(?:current|up[ -]to[ -]date)|no longer (?:be )?(?:current|accurate)|may have changed|(?:previous|earlier|older|last) (?:successful )?(?:check|update|verification|snapshot))';
const STALE_REPLY = new RegExp(
  `(?:\\b${REPLY}\\b[^.!?\\n]{0,100}\\b${STALE}\\b|\\b${STALE}\\b[^.!?\\n]{0,100}\\b${REPLY}\\b)`,
  'i',
);

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

function view(page, panel) {
  return page.getByTestId(`panel-${panel}`);
}

function link(page, panel, timestamp) {
  return page.getByTestId(
    `${panel === 'slack' ? 'slack-thread' : 'slack-thread-link'}-${timestamp}`,
  );
}

function coverage(page, panel) {
  return panel === 'slack'
    ? page.locator('.slack-coverage')
    : page.getByTestId('my-tickets-slack-coverage');
}

async function refresh(page, panel) {
  if (panel === 'slack') await page.clock.runFor(60_000);
  else await page.getByTestId('my-tickets-refresh').click();
}

function displayedRow(key) {
  const rootTs = ts(NOW - DAY);
  const activityTs = ts(NOW - 60 * 60 * 1000);
  return {
    ts: rootTs,
    url: slackAppThreadLink(TEAM, CHANNEL, rootTs),
    watchKey: `${CHANNEL}:${rootTs}`,
    text: `${key}: confirmed thread`,
    subjectText: `${key}: confirmed thread`,
    author: { id: ME, name: 'Sam Example' },
    starter: { id: ME, name: 'Sam Example' },
    replyCount: 1,
    activityTs,
    activityAt: new Date(Number(activityTs) * 1000).toISOString(),
    latestReplyBy: { id: OTHER, name: 'Morgan Example' },
    needsReply: true,
    attachedSessions: 0,
  };
}

function seed(dashboard, { started, mentions = [], reasons }) {
  dashboard.data.slack.status.sessionVersion = 'same-session';
  Object.assign(dashboard.data.slack.threads, {
    available: true,
    enriched: true,
    serverTime: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    partial: true,
    partialReasons: reasons,
    stale: false,
    truncated: false,
    continuation: null,
    started,
    mentions,
  });
}

function backendFixture(key) {
  const root = {
    ts: ts(NOW - DAY),
    thread_ts: ts(NOW - DAY),
    user: ME,
    text: `${key}: confirmed thread`,
    reply_count: 1,
    latest_reply: ts(NOW - 60 * 60 * 1000),
  };
  const omitted = {
    ts: ts(NOW - 2 * DAY),
    thread_ts: ts(NOW - 2 * DAY),
    user: ME,
    text: `${key}: omitted by refresh`,
    reply_count: 0,
  };
  const reply = { ts: root.latest_reply, thread_ts: root.ts, user: OTHER, text: 'Reply' };
  let now = NOW;
  let throttled = false;
  let replyAttempts = 0;
  const board = createSlackBoard({
    call: async (method) => {
      if (method === 'conversations.history')
        return { ok: true, messages: throttled ? [root] : [root, omitted] };
      if (method === 'search.messages')
        return { ok: true, messages: { matches: [], total: 0, paging: { pages: 1 } } };
      if (method === 'conversations.replies') {
        replyAttempts += 1;
        if (throttled) throw new Error('rate_limited');
        return { ok: true, messages: [root, reply], has_more: false, response_metadata: {} };
      }
      throw new Error(`unexpected fake Slack method ${method}`);
    },
    session: () => ({ teamId: TEAM }),
    verify: async () => ({ connected: true, userId: ME, teamId: TEAM, user: 'Sam Example' }),
    channel: async () => ({ id: CHANNEL, name: 'example_channel' }),
    users: async () => ({ [OTHER]: 'Morgan Example' }),
    now: () => now,
    isCurrent: () => true,
    generation: () => 1,
  });
  return {
    root,
    omitted,
    board,
    replyAttempts: () => replyAttempts,
    throttle() {
      throttled = true;
      now += 300_001;
    },
    recover() {
      throttled = false;
    },
  };
}

for (const panel of ['slack', 'my-tickets']) {
  test(`stale reply: ${panel} discloses a throttled backend fallback until recovery`, async ({
    page,
    dashboard,
  }) => {
    await freeze(page);
    ticketBoardData(dashboard.data);
    const { key } = dashboard.data.tickets.tickets[0];
    const fixture = backendFixture(key);
    const { board, root, omitted } = fixture;
    await board.threads();
    await flush();
    const initial = structuredClone(withAttachedSessions(await board.threads(), {}));
    const initialRow = initial.started.find((item) => item.ts === root.ts);
    expect(initialRow).toMatchObject({
      activityTs: root.latest_reply,
      latestReplyBy: { id: OTHER },
      needsReply: true,
    });
    expect(initial.partialReasons).not.toContain('reply_activity_stale');
    expect(initial.started.map((item) => item.ts)).toContain(omitted.ts);
    dashboard.data.slack.status.sessionVersion = 'same-session';
    dashboard.data.slack.threads = initial;
    await page.goto(`/#/${panel}`);
    await expect(link(page, panel, root.ts)).toBeVisible();
    await expect(link(page, panel, omitted.ts)).toBeVisible();
    await expect(view(page, panel).getByText(STALE_REPLY)).toHaveCount(0);

    const previousAttempts = fixture.replyAttempts();
    fixture.throttle();
    await board.threads();
    await flush();
    const partial = structuredClone(withAttachedSessions(await board.threads(), {}));
    expect(fixture.replyAttempts()).toBeGreaterThan(previousAttempts);
    expect(partial.available).toBe(true);
    expect(partial.partial).toBe(true);
    expect(partial.partialReasons).toContain('reply_unavailable');
    expect(partial.partialReasons).toContain('reply_activity_stale');
    expect(partial.started.map((item) => item.ts)).toEqual([root.ts]);
    expect(partial.started[0]).toMatchObject({
      activityTs: initialRow.activityTs,
      latestReplyBy: initialRow.latestReplyBy,
      needsReply: initialRow.needsReply,
    });
    expect(partial.continuation).toBeTruthy();
    // Reply fallback must be disclosed even when the whole snapshot is not stale.
    dashboard.data.slack.threads = { ...partial, stale: false };
    await refresh(page, panel);
    await expect(link(page, panel, omitted.ts)).toHaveCount(0);
    await expect(link(page, panel, root.ts)).toBeVisible();
    if (panel === 'slack')
      await expect(link(page, panel, root.ts)).toHaveAttribute('data-needs-reply', 'yes');
    else await expect(page.getByTestId(`slack-thread-needs-reply-${root.ts}`)).toBeVisible();
    await expect(coverage(page, panel)).toContainText(/incomplete/i);
    await expect(view(page, panel).getByText(STALE_REPLY).first()).toBeVisible();

    fixture.recover();
    await board.threads({ continuation: partial.continuation });
    await flush();
    const recovered = structuredClone(withAttachedSessions(await board.threads(), {}));
    expect(recovered.partialReasons).not.toContain('reply_activity_stale');
    expect(recovered.partialReasons).not.toContain('reply_unavailable');
    expect(recovered.started.map((item) => item.ts)).toEqual([root.ts]);
    dashboard.data.slack.threads = recovered;
    await refresh(page, panel);
    await expect(view(page, panel).getByText(STALE_REPLY)).toHaveCount(0);
    await expect(link(page, panel, root.ts)).toBeVisible();
    await expect(link(page, panel, omitted.ts)).toHaveCount(0);
    await expect(coverage(page, panel)).toContainText(/incomplete/i);
  });

  test(`stale reply: ${panel} warns when its visible started list is empty`, async ({
    page,
    dashboard,
  }) => {
    await freeze(page);
    ticketBoardData(dashboard.data);
    const thread = displayedRow(dashboard.data.tickets.tickets[0].key);
    seed(dashboard, {
      started: [],
      mentions: [thread],
      reasons: ['ambiguous_search_result', 'reply_activity_stale'],
    });
    await page.goto(`/#/${panel}`);
    await expect(coverage(page, panel)).toContainText(/incomplete/i);
    await expect(coverage(page, panel)).toContainText(/standalone mentions may be missing/i);
    await expect(link(page, panel, thread.ts)).toHaveCount(0);
    await expect(view(page, panel).getByText(STALE_REPLY).first()).toBeVisible();
  });

  for (const reason of [
    'search_coverage_uncertain',
    'ambiguous_search_result',
    'reply_unavailable',
  ]) {
    test(`stale reply: ${panel} does not mislabel ${reason} as stale reply activity`, async ({
      page,
      dashboard,
    }) => {
      await freeze(page);
      ticketBoardData(dashboard.data);
      const thread = displayedRow(dashboard.data.tickets.tickets[0].key);
      if (reason === 'reply_unavailable') {
        thread.activityTs = null;
        thread.activityAt = '';
        thread.latestReplyBy = null;
        thread.needsReply = null;
      }
      seed(dashboard, { started: [thread], reasons: [reason] });
      await page.goto(`/#/${panel}`);
      await expect(link(page, panel, thread.ts)).toBeVisible();
      await expect(coverage(page, panel)).toContainText(/incomplete/i);
      await expect(view(page, panel).getByText(STALE_REPLY)).toHaveCount(0);
      if (reason === 'ambiguous_search_result')
        await expect(coverage(page, panel)).toContainText(/standalone mentions may be missing/i);
    });
  }
}
