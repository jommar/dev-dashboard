import { test, expect, seedVelocitySnapshot } from './fixtures.js';

test('Home keeps one velocity pane in the shared workspace @regression', async ({
  page,
  dashboard,
}) => {
  await seedVelocitySnapshot(page, dashboard.data.teamVelocity);
  await page.goto('/#/home');
  await expect(page.getByTestId('home-title')).toHaveText('Velocity');
  await expect(page.getByTestId('home-velocity-chart')).toBeVisible();
  await expect(page.getByTestId('home-velocity-team')).toHaveValue('Nexus');
  for (const id of ['home-kpi-row', 'home-sprint-block', 'home-services-block']) {
    await expect(page.getByTestId(id)).toHaveCount(0);
  }
});

test('tickets keep truncation warnings and a failed filter rolls back honestly @regression', async ({
  page,
  dashboard,
}) => {
  dashboard.data.tickets.truncated = true;
  await page.goto('/#/my-tickets');
  await expect(page.getByTestId('my-tickets-truncated')).toContainText('incomplete');
  await expect(page.getByTestId('my-tickets-item-sample-active')).toBeVisible();
  let failedRoute;
  let arrived;
  const requestArrived = new Promise((resolve) => {
    arrived = resolve;
  });
  await page.route('**/api/my-tickets?includeDone=1', (route) => {
    failedRoute = route;
    arrived();
  });
  await page.getByTestId('my-tickets-include-done').check();
  await requestArrived;
  await failedRoute.fulfill({ status: 503, body: 'Unavailable' });
  await expect(page.getByTestId('my-tickets-meta')).toContainText('last update');
  await expect(page.getByTestId('my-tickets-include-done')).not.toBeChecked();
  await expect(page.getByTestId('my-tickets-item-sample-active')).toBeVisible();
});

test('changed refreshes preserve work-list keyboard focus @regression', async ({
  page,
  dashboard,
}) => {
  await page.goto('/#/prs');
  const link = page.getByTestId('prs-pr-DEMO-1-example-workspace-17');
  await expect(link).toBeVisible();
  await page.clock.install();
  await link.focus();
  dashboard.data.reviewTickets.tickets[0].prs[0].title = 'Updated while reading';
  await page.clock.fastForward(91_000);
  await expect(link).toHaveAccessibleName(/Updated while reading/);
  await expect(link).toBeFocused();
});

test('expanded service logs coexist at medium width and remain literal @regression', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('/#/services');
  for (const id of ['api', 'web']) {
    const log = page.getByTestId(`log-${id}`);
    await expect(log).toContainText('<literal> output');
    const box = await log.boundingBox();
    expect(box.y).toBeGreaterThan(0);
    expect(box.y + box.height).toBeLessThanOrEqual(768);
    expect(box.height).toBeGreaterThanOrEqual(200);
    expect(await log.evaluate((el) => el.children.length)).toBe(0);
  }
  await expect(page.getByTestId('log-worker')).toBeVisible();
});
