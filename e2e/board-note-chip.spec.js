import { test, expect } from './fixtures.js';
import { slackThreadRow, ticketBoardData } from './data.js';

const NOW = Date.parse('2026-03-09T16:00:00Z');
const NOTE_TEXT =
  'PR discovery unavailable or incomplete for watched repositories. Known PRs are shown; every ticket remains To Review until discovery completes.';

async function freeze(page, time) {
  await page.clock.install({ time: time - 60_000 });
  await page.clock.pauseAt(time);
}

test('a long note is a one-line chip that expands, with its text unchanged', async ({
  page,
  dashboard,
}) => {
  dashboard.data.reviewTickets.prCoverage = {
    available: false,
    complete: false,
    repos: ['example/frontend', 'example/backend'],
    reasons: ['github_unavailable'],
  };
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto('/#/prs');
  const note = page.getByTestId('prs-coverage');
  await expect(note).toBeVisible();
  await expect(note).toHaveAttribute('role', 'status');
  await expect(note).toHaveText(NOTE_TEXT);
  const text = note.locator('.board-note-text');
  const lineHeight = await text.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
  const collapsed = await text.evaluate((el) => el.getBoundingClientRect().height);
  expect(collapsed).toBeLessThanOrEqual(lineHeight + 1);
  const toggle = note.getByRole('button', { name: 'Show full note' });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toHaveAttribute('aria-controls', (await text.getAttribute('id')) ?? 'none');
  expect(await toggle.evaluate((el) => el.textContent.trim())).toBe('');
  await toggle.click();
  const collapse = note.getByRole('button', { name: 'Collapse note' });
  await expect(collapse).toHaveAttribute('aria-expanded', 'true');
  await expect(note).toHaveText(NOTE_TEXT);
  expect(await text.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(
    lineHeight * 1.5,
  );
  await collapse.click();
  await expect(note.getByRole('button', { name: 'Show full note' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
});

test('the My Tickets Slack coverage note starts open and its link works', async ({
  page,
  dashboard,
}) => {
  await freeze(page, NOW);
  ticketBoardData(dashboard.data);
  dashboard.data.slack.status.sessionVersion = 'same-session';
  Object.assign(dashboard.data.slack.threads, {
    available: true,
    enriched: true,
    updatedAt: new Date(NOW).toISOString(),
    serverTime: new Date(NOW).toISOString(),
    started: [
      slackThreadRow({
        text: 'Only thread',
        createdAt: NOW - 1000,
        activityAt: NOW - 1000,
        teamId: 'T0EXAMPLE1',
        channelId: 'C0EXAMPLE1',
        author: { id: 'U0EXAMPLE1', name: 'Sam Example' },
        replyCount: 0,
      }),
    ],
    mentions: [],
    partial: true,
    continuation: 'next-page',
  });
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto('/#/my-tickets');
  const note = page.getByTestId('my-tickets-slack-coverage');
  await expect(note).toContainText(/incomplete/i);
  await expect(note).toHaveAttribute('data-open', 'true');
  await expect(note.getByRole('button', { name: 'Collapse note' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  const link = note.getByRole('link', { name: 'View Slack and load more' });
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(/#\/slack$/);
  await expect(page.getByTestId('panel-slack')).toBeVisible();
});

test('a note that fits has no toggle and keeps its exact text', async ({ page }) => {
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'dev-dashboard.home-velocity.snapshot')
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      return setItem.call(this, key, value);
    };
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/home');
  await page.getByTestId('home-refresh').click();
  const note = page.getByTestId('home-velocity-save-warning');
  await expect(note).toBeVisible();
  await expect(note).toHaveAttribute('role', 'status');
  await expect(note).toHaveText(
    'Could not save velocity in this browser; this update may not survive reload.',
  );
  await expect(note.locator('.board-note-text')).toHaveCount(1);
  await expect(note.locator('.board-note-toggle')).toHaveCount(0);
});
