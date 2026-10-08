import { test, expect } from './fixtures.js';

test('service commands recover from failures and report individual bulk results @regression', async ({
  page,
}) => {
  await page.route('**/api/services/api/start', (route) =>
    route.fulfill({ status: 409, json: { error: 'Process is busy' } }),
  );
  await page.goto('/#/services');
  await page.getByTestId('start-api').click();
  await expect(page.getByTestId('control-feedback-api')).toContainText('Process is busy');
  await expect(page.getByTestId('start-api')).toBeEnabled();
  await page.getByTestId('start-all').click();
  await expect(page.getByTestId('bulk-feedback')).toContainText('Workspace API');
  await expect(page.getByTestId('bulk-feedback')).toContainText('Process is busy');
  await expect(page.getByTestId('stop-all')).toBeEnabled();
  await expect(page.getByTestId('restart-api')).toBeEnabled();
});

test('logs retain text on failure, retry, and ignore obsolete tail responses @regression', async ({
  page,
}) => {
  await page.goto('/#/services');
  const log = page.getByTestId('log-api');
  await expect(log).toContainText('line 120');
  const before = await log.textContent();
  let fail = true;
  await page.route('**/api/logs/api*', (route) =>
    fail ? route.fulfill({ status: 503, body: 'Unavailable' }) : route.fallback(),
  );
  await page.getByTestId('log-retry-api').click();
  await expect(page.getByTestId('log-feedback-api')).toContainText('503');
  expect(await log.textContent()).toBe(before);
  fail = false;
  await page.getByTestId('log-retry-api').click();
  await expect(page.getByTestId('log-feedback-api')).not.toContainText('503');
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let tailStarted = false;
  await page.route('**/api/logs/api?lines=40', async (route) => {
    tailStarted = true;
    await held;
    await route.fulfill({ body: 'OBSOLETE TAIL', contentType: 'text/plain' });
  });
  await page.getByTestId('log-retry-api').click();
  await expect.poll(() => tailStarted).toBe(true);
  await page.getByTestId('expand-api').click();
  await expect(log).toContainText('line 1:');
  const obsoleteResponse = page.waitForResponse((response) =>
    response.url().endsWith('/api/logs/api?lines=40'),
  );
  release();
  await (await obsoleteResponse).finished();
  await page.waitForTimeout(50);
  await expect(page.getByTestId('log-feedback-api')).toContainText('retained');
  await expect(log).not.toContainText('OBSOLETE');
});

test('independent follow and scroll survive stream updates; hidden panels do not fetch logs @regression', async ({
  page,
  dashboard,
}) => {
  await page.goto('/#/services');
  await expect(page.getByTestId('log-api')).toContainText('line 120');
  await page.getByTestId('follow-api').click();
  await page.getByTestId('log-api').evaluate((el) => {
    el.scrollTop = 0;
  });
  dashboard.data.logs.api += '\nnew api output';
  dashboard.data.logs.web += '\nnew web output';
  await page.evaluate(() =>
    window.__dashboardMock.streams[0].emit('message', [
      { id: 'api', status: 'running' },
      { id: 'web', status: 'running' },
    ]),
  );
  await expect(page.getByTestId('log-api')).toContainText('new api output');
  expect(await page.getByTestId('log-api').evaluate((el) => el.scrollTop)).toBe(0);
  expect(
    await page
      .getByTestId('log-web')
      .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight),
  ).toBeLessThan(12);
  await page.getByTestId('tab-prs').click();
  const count = dashboard.requests.filter((r) => r.path.startsWith('/api/logs/')).length;
  await page.evaluate(() =>
    window.__dashboardMock.streams[0].emit('message', [{ id: 'api', status: 'running' }]),
  );
  await page.waitForTimeout(100);
  expect(dashboard.requests.filter((r) => r.path.startsWith('/api/logs/')).length).toBe(count);
});

test('Home service command errors never strand controls @regression', async ({ page }) => {
  await page.route('**/api/services/worker/start', (route) =>
    route.fulfill({ status: 500, json: { error: 'Cannot start worker' } }),
  );
  await page.goto('/#/home');
  const button = page.getByTestId('home-svc-toggle-worker');
  await button.click();
  await expect(page.getByTestId('home-control-feedback')).toContainText('Cannot start worker');
  await expect(button).toBeEnabled();
});

test('service discovery failure is retryable without duplicate cards @regression', async ({
  page,
}) => {
  let fail = true;
  await page.route('**/api/services', (route) =>
    fail ? route.fulfill({ status: 503, body: 'Unavailable' }) : route.fallback(),
  );
  await page.goto('/#/services');
  await expect(page.getByTestId('services-retry')).toBeVisible();
  await expect(page.getByTestId('start-all')).toBeDisabled();
  fail = false;
  await page.getByTestId('services-retry').click();
  await expect(page.getByTestId('log-api')).toContainText('line 120');
  await expect(page.getByTestId('services-retry')).toBeHidden();
  await expect(page.getByTestId('card-api')).toHaveCount(1);
});

test('bulk commands lock conflicting controls across routes until settled @regression', async ({
  page,
  dashboard,
}) => {
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [];
  await page.route('**/api/services/*/start', async (route) => {
    calls.push(route.request().url());
    await wait;
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto('/#/services');
  await page.getByTestId('start-all').click();
  await expect(page.getByTestId('stop-api')).toBeDisabled();
  await expect(page.getByTestId('restart-all')).toBeDisabled();
  await page.getByTestId('tab-home').click();
  await expect(page.getByTestId('home-svc-toggle-api')).toBeDisabled();
  release();
  await expect(page.getByTestId('home-svc-toggle-api')).toBeEnabled();
  expect(calls).toHaveLength(dashboard.data.services.length);
});

test('global follow reflects mixed individual preferences @regression', async ({ page }) => {
  await page.goto('/#/services');
  await page.getByTestId('follow-api').click();
  await expect(page.getByTestId('autoscroll-toggle')).toHaveAttribute('aria-pressed', 'mixed');
  await expect(page.getByTestId('autoscroll-toggle')).toContainText('Mixed');
  await page.getByTestId('autoscroll-toggle').click();
  for (const id of ['api', 'web', 'worker'])
    await expect(page.getByTestId(`follow-${id}`)).toHaveAttribute('aria-pressed', 'true');
});
