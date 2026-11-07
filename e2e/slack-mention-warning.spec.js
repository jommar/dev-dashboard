import { test, expect } from './fixtures.js';
import { slackAppThreadLink, ticketBoardData } from './data.js';

const NOW = Date.parse('2026-03-09T16:00:00Z');
const TS = '1772985600.000000'; // One day before NOW.
const TEAM = 'T0EXAMPLE1';
const CHANNEL = 'C0EXAMPLE1';

for (const hasRows of [false, true]) {
  for (const ambiguous of [false, true]) {
    test(`Slack coverage: ${hasRows ? 'nonempty' : 'empty'} ${ambiguous ? 'ambiguous' : 'other partial'} results warn accurately in both panels`, async ({
      page,
      dashboard,
    }) => {
      await page.clock.install({ time: NOW - 60_000 });
      await page.clock.pauseAt(NOW);
      ticketBoardData(dashboard.data);
      const { key } = dashboard.data.tickets.tickets[0];
      const thread = {
        ts: TS,
        url: slackAppThreadLink(TEAM, CHANNEL, TS),
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
        partialReasons: [ambiguous ? 'ambiguous_search_result' : 'refresh_failed'],
        truncated: false,
        continuation: null,
        started: hasRows ? [thread] : [],
        mentions: [],
      });
      await page.goto('/#/my-tickets');
      const ticketsWarning = page.getByTestId('my-tickets-slack-coverage');
      await expect(ticketsWarning).toContainText(/incomplete/i);
      if (ambiguous)
        await expect(ticketsWarning).toContainText(/standalone mentions may be missing/i);
      else await expect(ticketsWarning).not.toContainText(/standalone mentions/i);
      await expect(page.getByTestId(`slack-thread-link-${TS}`)).toHaveCount(hasRows ? 1 : 0);

      await page.getByTestId('tab-slack').click();
      const slackWarning = page.getByTestId('slack-coverage');
      await expect(slackWarning).toContainText(/incomplete/i);
      if (ambiguous)
        await expect(slackWarning).toContainText(/standalone mentions may be missing/i);
      else await expect(slackWarning).not.toContainText(/standalone mentions/i);
      await expect(page.getByTestId(`slack-thread-${TS}`)).toHaveCount(hasRows ? 1 : 0);
    });
  }
}
