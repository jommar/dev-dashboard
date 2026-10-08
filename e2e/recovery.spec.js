import { test, expect } from './fixtures.js';

test('startup can retry configuration and reconnects with one stream @regression', async ({
  page,
}) => {
  let fail = true;
  await page.route('**/api/config', (route) =>
    fail ? route.fulfill({ status: 503, body: 'Unavailable' }) : route.fallback(),
  );
  await page.goto('/#/services');
  await expect(page.getByTestId('startup-retry')).toBeVisible();
  expect(await page.evaluate(() => window.__dashboardMock.streams.length)).toBe(0);
  fail = false;
  await page.getByTestId('startup-retry').click();
  await expect(page.getByTestId('panel-services')).toBeVisible();
  await expect(page.getByTestId('connection-status')).toContainText('Live');
  await page.evaluate(() => window.__dashboardMock.streams[0].emit('error'));
  await expect(page.getByTestId('connection-status')).toContainText('Reconnecting');
  await page.evaluate(() => window.__dashboardMock.streams[0].emit('open'));
  await expect(page.getByTestId('connection-status')).toContainText('Live');
  expect(await page.evaluate(() => window.__dashboardMock.streams.length)).toBe(1);
});

for (const route of ['prs', 'my-tickets']) {
  test(`${route} manual failure retains last content and unchanged retry recovers @regression`, async ({
    page,
  }) => {
    await page.goto(`/#/${route}`);
    const list = page.getByTestId(route === 'prs' ? 'prs-list' : 'my-tickets-list');
    await expect(list).toContainText(route === 'prs' ? 'Improve keyboard' : 'Preserve a readable');
    const before = await list.innerHTML();
    let fail = true;
    await page.route(`**/api/${route}*`, (r) =>
      fail ? r.fulfill({ status: 503, body: 'Unavailable' }) : r.fallback(),
    );
    await page.getByTestId(`${route}-refresh`).click();
    await expect(page.getByTestId(`${route}-meta`)).toContainText('last update');
    expect(await list.innerHTML()).toBe(before);
    fail = false;
    await page.getByTestId(`${route}-refresh`).click();
    await expect(page.getByTestId(`${route}-meta`)).toContainText('updated');
    expect(await list.innerHTML()).toBe(before);
    await expect(page.getByTestId(`${route}-refresh`)).toBeEnabled();
  });
}

test('Home retains each last-good source independently on partial refresh @regression', async ({
  page,
  dashboard,
}) => {
  await page.goto('/#/home');
  await expect(page.getByTestId('home-actions')).toContainText('Improve keyboard');
  const sprint = await page.getByTestId('home-sprint').innerHTML();
  await page.route('**/api/my-tickets*', (r) => r.fulfill({ status: 503, body: 'Unavailable' }));
  dashboard.data.prs.prs[0].title = 'A fresh pull request title';
  await page.getByTestId('home-refresh').click();
  await expect(page.getByTestId('home-actions')).toContainText('A fresh pull request title');
  await expect(page.getByTestId('home-meta')).toContainText('stale');
  expect(await page.getByTestId('home-sprint').innerHTML()).toBe(sprint);
});

test('Home viewer copy reports clipboard failures and retries @regression', async ({
  page,
  dashboard,
}) => {
  await page.goto('/#/home');
  await page.getByTestId('home-action-view-diff-example/workspace-17').click();
  const copy = page.getByTestId('diff-copy');
  await expect(copy).toBeEnabled();
  await page.evaluate(() => {
    window.__dashboardMock.clipboard.error = 'Permission denied';
  });
  await copy.click();
  await expect(page.getByTestId('diff-status')).toContainText('Permission denied');
  await expect(page.getByTestId('diff-content')).toContainText('example.js');
  await expect(copy).toBeEnabled();
  await page.evaluate(() => {
    window.__dashboardMock.clipboard.error = null;
  });
  await copy.click();
  await expect(page.getByTestId('diff-status')).toContainText(/copied/i);
  expect(await page.evaluate(() => window.__dashboardMock.clipboard.writes)).toEqual([
    dashboard.data.diff.diff,
  ]);
  expect(dashboard.requests.filter((r) => r.path.startsWith('/api/pr-diff'))).toHaveLength(1);
});

test('initial partial failures are unavailable, not unconfigured, and back off @regression', async ({
  page,
  dashboard,
}) => {
  await page.route('**/api/my-tickets*', (route) =>
    route.fulfill({ status: 503, body: 'Unavailable' }),
  );
  await page.goto('/#/home');
  await expect(page.getByTestId('home-sprint-unavailable')).toBeVisible();
  await expect(page.getByTestId('home-actions')).toContainText('Improve keyboard');
  await expect(page.getByTestId('home-meta')).toContainText('Jira unavailable');
  await page.clock.install();
  const before = dashboard.requests.filter((r) => r.path.startsWith('/api/my-tickets')).length;
  await page.clock.fastForward(10_000);
  expect(dashboard.requests.filter((r) => r.path.startsWith('/api/my-tickets')).length).toBe(
    before,
  );
});

test('a pending diff survives a changed poll and does not submit twice @regression', async ({
  page,
  dashboard,
}) => {
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  await page.route('**/api/pr-diff*', async (route) => {
    calls++;
    await wait;
    await route.fulfill({ json: dashboard.data.diff });
  });
  await page.goto('/#/home');
  await page.clock.install();
  const trigger = page.getByTestId('home-action-view-diff-example/workspace-17');
  await trigger.click();
  await expect(page.getByTestId('diff-copy')).toBeDisabled();
  dashboard.data.prs.prs[0].title = 'Changed while loading diff';
  await page.clock.fastForward(91_000);
  await expect(page.getByTestId('home-actions')).toContainText('Changed while loading diff');
  await expect(page.getByTestId('diff-viewer')).toBeVisible();
  await expect(page.getByTestId('diff-copy')).toBeDisabled();
  release();
  await expect(page.getByTestId('diff-copy')).toBeEnabled();
  expect(calls).toBe(1);
  expect(await page.evaluate(() => window.__dashboardMock.clipboard.writes)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
});

test('PR diff API failure does not claim clipboard success and can retry @regression', async ({
  page,
}) => {
  let fail = true;
  await page.route('**/api/pr-diff*', (route) =>
    fail ? route.fulfill({ status: 502, json: { error: 'Diff unavailable' } }) : route.fallback(),
  );
  await page.goto('/#/prs');
  await page.getByTestId('pr-open-view-diff-example/workspace-17').click();
  const copy = page.getByTestId('diff-copy');
  await expect(page.getByTestId('diff-status')).toContainText('Diff unavailable');
  await expect(copy).toBeDisabled();
  expect(await page.evaluate(() => window.__dashboardMock.clipboard.writes.length)).toBe(0);
  fail = false;
  await page.getByTestId('diff-retry').click();
  await expect(copy).toBeEnabled();
  await copy.click();
  await expect(page.getByTestId('diff-status')).toContainText(/copied/i);
  expect(await page.evaluate(() => window.__dashboardMock.clipboard.writes.length)).toBe(1);
});
