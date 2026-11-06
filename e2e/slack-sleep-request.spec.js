import { test, expect } from './fixtures.js';
import { slackAppThreadLink, ticketBoardData } from './data.js';

const NOW = Date.parse('2026-03-09T16:00:00Z');
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function row(text, created) {
  const ts = `${Math.floor(created / 1000)}.${String((created % 1000) * 1000).padStart(6, '0')}`;
  return {
    ts,
    url: slackAppThreadLink('T0EXAMPLE1', 'C0EXAMPLE1', ts),
    text,
    subjectText: text,
    author: { id: 'U0EXAMPLE1', name: 'Sam Example' },
    starter: { id: 'U0EXAMPLE1', name: 'Sam Example' },
    replyCount: 0,
    activityAt: new Date(created).toISOString(),
    needsReply: false,
    attachedSessions: 0,
  };
}

for (const panel of ['slack', 'my-tickets']) {
  test(`sleep: ${panel} accounts for suspend during a held post-list status`, async ({
    page,
    dashboard,
  }) => {
    await page.clock.install({ time: NOW - DAY - MINUTE });
    await page.clock.pauseAt(NOW - DAY);
    ticketBoardData(dashboard.data);
    const { key } = dashboard.data.tickets.tickets[0];
    const expiring = row(`${key}: expires while suspended`, NOW - 28 * DAY + 5 * MINUTE);
    const stable = row(`${key}: remains eligible`, NOW - DAY);
    Object.assign(dashboard.data.slack.threads, {
      available: true,
      enriched: true,
      serverTime: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
      started: [expiring, stable],
      mentions: [],
    });
    dashboard.data.slack.status.sessionVersion = 'same-session';
    let release;
    let listDelivered = false;
    let heldStatus = false;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    await page.route('**/api/slack/threads', async (route) => {
      listDelivered = true;
      await route.fulfill({ json: dashboard.data.slack.threads });
    });
    await page.route('**/api/slack/status', async (route) => {
      if (listDelivered) {
        heldStatus = true;
        await gate;
      }
      await route.fulfill({ json: dashboard.data.slack.status }).catch(() => {});
    });
    const link = (thread) =>
      page.getByTestId(`${panel === 'slack' ? 'slack-thread' : 'slack-thread-link'}-${thread.ts}`);
    try {
      await page.goto(`/#/${panel}`);
      await expect.poll(() => heldStatus).toBe(true);
      const before = await page.evaluate(() => ({ wall: Date.now(), mono: performance.now() }));
      await page.clock.setSystemTime(before.wall + 10 * MINUTE);
      const after = await page.evaluate(() => ({ wall: Date.now(), mono: performance.now() }));
      expect(after.wall - before.wall).toBe(10 * MINUTE);
      expect(after.mono).toBe(before.mono);
      release();
      // The stable row proves the snapshot was committed, not merely discarded.
      await expect(link(stable)).toBeVisible();
      await expect(link(expiring)).toHaveCount(0);
    } finally {
      release();
    }
  });
}
