import { test, expect, seedVelocitySnapshot } from './fixtures.js';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

async function capture(page, name) {
  const directory = new URL(
    '../../docs/dev-dashboard-redesign/verification/screenshots/',
    import.meta.url,
  );
  await mkdir(directory, { recursive: true });
  await page.screenshot({
    path: fileURLToPath(new URL(`fix-1-${name}.png`, directory)),
    fullPage: true,
  });
}

test('viewer errors survive changed polling and retry clears the message @regression', async ({
  page,
  dashboard,
}) => {
  let fail = true;
  await page.route('**/api/pr-diff*', (route) =>
    fail ? route.fulfill({ status: 503, json: { error: 'Diff unavailable' } }) : route.fallback(),
  );
  await page.goto('/#/prs');
  await page.clock.install();
  const button = page.getByTestId('prs-diff-DEMO-1-example-workspace-17');
  const note = page.getByTestId('diff-status');
  await button.click();
  await expect(note).toContainText('Diff unavailable');
  dashboard.data.reviewTickets.tickets[0].summary = 'Updated after failed diff';
  await page.clock.fastForward(91_000);
  await expect(page.getByTestId('prs-list')).toContainText('Updated after failed diff');
  await expect(note).toContainText('Diff unavailable');
  fail = false;
  await page.getByTestId('diff-retry').click();
  await expect(page.getByTestId('diff-copy')).toBeEnabled();
  await expect(note).not.toContainText('Diff unavailable');
  await page.keyboard.press('Escape');
  await expect(button).toBeFocused();
});

test('empty velocity history discloses a failed refresh @regression', async ({
  page,
  dashboard,
}) => {
  dashboard.data.teamVelocity.boards = [];
  await seedVelocitySnapshot(page, dashboard.data.teamVelocity);
  await page.goto('/#/home');
  await expect(page.getByTestId('home-velocity-empty')).toContainText(
    'No velocity history for Nexus.',
  );
  await page.route('**/api/team-velocity', (route) =>
    route.fulfill({ status: 503, body: 'Unavailable' }),
  );
  await page.getByTestId('home-refresh').click();
  await expect(page.getByTestId('home-velocity-stale')).toBeVisible();
  await expect(page.getByTestId('home-velocity-empty')).toContainText(
    'No velocity history for Nexus.',
  );
  await expect(page.getByTestId('home-velocity-chart')).toHaveCount(0);
});

for (const width of [390, 1440]) {
  test(`dense ticket hierarchy stays readable at ${width} @regression`, async ({
    page,
    dashboard,
  }) => {
    const base = dashboard.data.tickets.tickets[0];
    dashboard.data.tickets.tickets.push(
      ...Array.from({ length: 12 }, (_, i) => ({
        ...base,
        key: `work-${i}`,
        summary: `Workspace maintenance item ${i}`,
      })),
    );
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/#/my-tickets');
    await expect(page.getByTestId('my-tickets-column-count-In-Progress')).toHaveText('13');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await capture(page, `tickets-dense-${width}`);
  });
}

for (const route of ['prs']) {
  for (const failure of ['API', 'clipboard']) {
    test(`${route} ${failure} diff failure explains recovery inside the viewer @regression`, async ({
      page,
      dashboard,
    }) => {
      if (route === 'prs') {
        const ticket = dashboard.data.reviewTickets.tickets[0];
        const base = ticket.prs[0];
        const extra = Array.from({ length: 23 }, (_, i) => ({
          ...base,
          number: i + 100,
          title: `Additional change ${i}`,
        }));
        ticket.prs.push(...extra);
      }
      if (failure === 'API')
        await page.route('**/api/pr-diff*', (r) =>
          r.fulfill({ status: 503, json: { error: 'Diff unavailable' } }),
        );
      await page.goto(`/#/${route}`);
      if (failure === 'clipboard')
        await page.evaluate(() => {
          window.__dashboardMock.clipboard.error = 'Clipboard denied';
        });
      const button = page.getByTestId('prs-diff-DEMO-1-example-workspace-17');
      await button.focus();
      await page.keyboard.press('Enter');
      if (failure === 'clipboard') {
        await expect(page.getByTestId('diff-copy')).toBeEnabled();
        await page.getByTestId('diff-copy').click();
      }
      const feedback = page.getByTestId('diff-status');
      await expect(feedback).toContainText(
        failure === 'API' ? 'Diff unavailable' : 'Clipboard denied',
      );
      await expect(page.getByTestId(failure === 'API' ? 'diff-retry' : 'diff-copy')).toBeEnabled();
      expect(
        await page.getByTestId('diff-viewer').evaluate((el) => el.contains(document.activeElement)),
      ).toBe(true);
      const box = await feedback.boundingBox();
      expect(box.y + box.height).toBeLessThanOrEqual(900);
      await capture(page, `${route}-${failure}-diff-error`);
      await page.keyboard.press('Escape');
      await expect(button).toBeFocused();
    });
  }
}

test('the board keeps one column per status and adds one when a new status appears @regression', async ({
  page,
  dashboard,
}) => {
  await page.goto('/#/my-tickets');
  await expect(page.getByTestId('my-tickets-column-count-In-Progress')).toHaveText('1');
  await expect(page.getByTestId('my-tickets-column-In-Review')).toHaveCount(0);
  const base = dashboard.data.tickets.tickets[0];
  dashboard.data.tickets.tickets.push({ ...base, key: 'sample-review', status: 'In Review' });
  await page.getByTestId('my-tickets-refresh').click();
  await expect(page.getByTestId('my-tickets-column-count-In-Progress')).toHaveText('1');
  await expect(page.getByTestId('my-tickets-column-count-In-Review')).toHaveText('1');
  const progress = await page.getByTestId('my-tickets-column-In-Progress').boundingBox();
  const review = await page.getByTestId('my-tickets-column-In-Review').boundingBox();
  expect(review.x).toBeGreaterThan(progress.x);
});

for (const control of ['individual', 'global']) {
  test(`${control} Follow resumes at latest output after scrolling up @regression`, async ({
    page,
    dashboard,
  }) => {
    await page.goto('/#/services');
    const log = page.getByTestId('log-api');
    await expect(log).toContainText('line 120');
    const toggle = page.getByTestId(control === 'global' ? 'autoscroll-toggle' : 'follow-api');
    await toggle.click();
    await log.evaluate((el) => {
      el.scrollTop = 0;
    });
    if (control === 'individual') {
      await page.getByTestId('follow-web').click();
      await page.getByTestId('log-web').evaluate((el) => {
        el.scrollTop = 0;
      });
    }
    await toggle.click();
    // The global switch reaches the log through a later effect than the click, so wait for it.
    await expect
      .poll(() => log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
      .toBeLessThan(12);
    dashboard.data.logs.api += '\nresumed output';
    // Turning Follow on starts a log read of its own, and a snapshot that arrives while a read is
    // in flight is folded into it (the read already holds the old text). The real stream keeps
    // sending snapshots, so this one does too, until the log shows the new line.
    await expect(async () => {
      await page.evaluate(() =>
        window.__dashboardMock.streams[0].emit('message', [{ id: 'api', status: 'running' }]),
      );
      await expect(log).toContainText('resumed output', { timeout: 500 });
    }).toPass({ timeout: 10_000 });
    expect(
      await log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight),
    ).toBeLessThan(12);
    if (control === 'individual')
      expect(await page.getByTestId('log-web').evaluate((el) => el.scrollTop)).toBe(0);
  });
}
