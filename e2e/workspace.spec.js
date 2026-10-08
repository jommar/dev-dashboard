import { test, expect } from './fixtures.js';

test('Home leads with the action queue in reading and visual order @regression', async ({
  page,
}) => {
  await page.goto('/#/home');
  const queue = page.getByTestId('home-actions-block');
  await expect(page.getByTestId('home-actions')).toContainText('Improve keyboard');
  for (const id of [
    'home-kpi-row',
    'home-sprint-block',
    'home-velocity-block',
    'home-services-block',
  ]) {
    const later = page.getByTestId(id);
    expect(
      await queue.evaluate(
        (el, testId) =>
          Boolean(
            el.compareDocumentPosition(document.querySelector(`[data-testid="${testId}"]`)) &
            Node.DOCUMENT_POSITION_FOLLOWING,
          ),
        id,
      ),
    ).toBe(true);
    expect((await queue.boundingBox()).y).toBeLessThanOrEqual((await later.boundingBox()).y);
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
  await page.route('**/api/my-tickets?includeDone=1', (route) =>
    route.fulfill({ status: 503, body: 'Unavailable' }),
  );
  await page.getByTestId('my-tickets-include-done').check();
  await expect(page.getByTestId('my-tickets-meta')).toContainText('last update');
  await expect(page.getByTestId('my-tickets-include-done')).not.toBeChecked();
  await expect(page.getByTestId('my-tickets-item-sample-active')).toBeVisible();
});

test('changed refreshes preserve work-list keyboard focus @regression', async ({
  page,
  dashboard,
}) => {
  await page.goto('/#/prs');
  const link = page.getByTestId('pr-open-title-link-example/workspace-17');
  await expect(link).toBeVisible();
  await page.clock.install();
  await link.focus();
  dashboard.data.prs.prs[0].title = 'Updated while reading';
  await page.clock.fastForward(91_000);
  await expect(link).toHaveText('Updated while reading');
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
