import { test, expect } from './fixtures.js';
import { slackAppThreadLink, ticketBoardData } from './data.js';

const NOW = Date.parse('2026-03-09T16:00:00Z');
const TS = '1772985600.000000';

for (const panel of ['slack', 'my-tickets']) {
  for (const hasRows of [false, true]) {
    test(`history marker: ${panel} discloses and clears an ambiguous mention with ${hasRows ? 'rows' : 'no rows'}`, async ({
      page,
      dashboard,
    }) => {
      await page.clock.install({ time: NOW - 60_000 });
      await page.clock.pauseAt(NOW);
      ticketBoardData(dashboard.data);
      const { key } = dashboard.data.tickets.tickets[0];
      const thread = {
        ts: TS,
        url: slackAppThreadLink('T0EXAMPLE1', 'C0EXAMPLE1', TS),
        text: `${key}: confirmed thread`,
        subjectText: `${key}: confirmed thread`,
        author: { id: 'U0EXAMPLE1', name: 'Sam Example' },
        starter: { id: 'U0EXAMPLE1', name: 'Sam Example' },
        replyCount: 0,
        activityAt: new Date(Number(TS) * 1000).toISOString(),
        needsReply: false,
        attachedSessions: 0,
      };
      dashboard.data.slack.status.sessionVersion = 'same-session';
      Object.assign(dashboard.data.slack.threads, {
        available: true,
        enriched: true,
        serverTime: new Date(NOW).toISOString(),
        updatedAt: new Date(NOW).toISOString(),
        partial: true,
        partialReasons: [
          'search_coverage_uncertain',
          'ambiguous_history_mention',
          'reply_activity_stale',
        ],
        started: hasRows ? [thread] : [],
        mentions: [],
      });
      const coverage = () =>
        panel === 'slack'
          ? page.locator('.slack-coverage')
          : page.getByTestId('my-tickets-slack-coverage');
      await page.goto(`/#/${panel}`);
      await expect(coverage()).toContainText(/standalone mentions may be missing/i);
      await expect(coverage()).toContainText(/reply information may be stale/i);
      await expect(
        page.getByTestId(`${panel === 'slack' ? 'slack-thread' : 'slack-thread-link'}-${TS}`),
      ).toHaveCount(hasRows ? 1 : 0);

      dashboard.data.slack.threads.partialReasons = [
        'search_coverage_uncertain',
        'reply_activity_stale',
      ];
      if (panel === 'slack') await page.clock.runFor(60_000);
      else await page.getByTestId('my-tickets-refresh').click();
      await expect(coverage()).not.toContainText(/standalone mentions may be missing/i);
      await expect(coverage()).toContainText(/reply information may be stale/i);
    });
  }
}
