import { test, expect } from './fixtures.js';
import { settingsData } from './data.js';

for (const outcome of ['verified', 'degraded']) {
  test(`stateful ${outcome} Check then Save adopts new revision and preserves draft`, async ({
    page,
    dashboard,
  }) => {
    dashboard.data.statefulSettings = true;
    await page.goto('/#/settings');
    const org = page.getByLabel('GitHub organization', { exact: true });
    await org.fill('RetainedDraftOrg');
    dashboard.data.nextValidationSetup = {
      ready: true,
      errors: [],
      connection: {
        state: outcome,
        errors:
          outcome === 'degraded'
            ? [{ field: 'github', message: 'Synthetic GitHub rate limit; retry later' }]
            : [],
      },
    };
    const checked = page.waitForResponse((response) =>
      response.url().endsWith('/api/settings/validate'),
    );
    await page.getByRole('button', { name: 'Check saved connections', exact: true }).click();
    expect((await checked).status()).toBe(200);
    await expect(org).toHaveValue('RetainedDraftOrg');
    if (outcome === 'degraded') {
      await expect(page.getByTestId('panel-settings')).toContainText(/degraded/i);
      await expect(page.getByTestId('panel-settings')).toContainText(
        'Synthetic GitHub rate limit; retry later',
      );
    }
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/settings') && response.request().method() === 'PUT',
    );
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    const response = await saved;
    expect(response.request().postDataJSON().expectedRevision).toBe(2);
    expect(response.status()).toBe(200);
    await expect(page.getByLabel('GitHub organization', { exact: true })).toHaveValue(
      'RetainedDraftOrg',
    );
    expect(dashboard.data.settings.revision).toBe(3);
    expect(dashboard.data.settings.github.org).toBe('RetainedDraftOrg');
  });
}

for (const direction of ['restored', 'revoked']) {
  test(`saved Check ${direction} reloads committed readiness and stream ownership`, async ({
    page,
    dashboard,
  }) => {
    if (direction === 'restored') Object.assign(dashboard.data, settingsData('migration'));
    dashboard.data.statefulSettings = true;
    await page.goto('/#/settings');
    await expect(
      page.getByRole('button', { name: 'Check saved connections', exact: true }),
    ).toBeVisible();
    dashboard.data.nextValidationSetup = {
      ready: direction === 'restored',
      errors:
        direction === 'revoked' ? [{ field: 'jira', message: 'Synthetic auth rejected' }] : [],
      connection: { state: direction === 'restored' ? 'verified' : 'invalid' },
    };
    let navigations = 0;
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) navigations++;
    });
    await page.getByRole('button', { name: 'Check saved connections', exact: true }).click();
    if (direction === 'restored') {
      await expect(page.getByTestId('tab-services')).toBeVisible();
      expect(await page.evaluate(() => window.__dashboardMock.streams.length)).toBe(1);
    } else {
      await expect(page.getByTestId('tabs').locator('a')).toHaveCount(1);
      expect(await page.evaluate(() => window.__dashboardMock.streams.length)).toBe(0);
    }
    expect(navigations).toBeGreaterThan(0);
    expect(dashboard.data.settings.revision).toBe(2);
    await expect(page.locator('input[type="password"]').first()).toHaveValue('');
  });
}

for (const malformed of ['repository-string', 'service-object', 'null-service']) {
  test(`malformed ${malformed} remains editable for Settings repair`, async ({
    page,
    dashboard,
  }) => {
    Object.assign(dashboard.data, settingsData('invalid'));
    if (malformed === 'repository-string') dashboard.data.settings.github.repos = 'broken-list';
    else if (malformed === 'service-object')
      dashboard.data.settings.local.services = { id: 'broken' };
    else dashboard.data.settings.local.services = [null];
    await page.goto('/#/settings');
    await expect(page.getByLabel('GitHub organization', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save settings', exact: true })).toBeVisible();
    await page.getByLabel('GitHub organization', { exact: true }).fill('RepairOrg');
    await page.getByRole('button', { name: 'Add repository', exact: true }).click();
    await page.getByRole('button', { name: 'Add service', exact: true }).click();
    await expect(page.getByLabel('GitHub organization', { exact: true })).toHaveValue('RepairOrg');
    expect(await page.evaluate(() => window.__dashboardMock.streams.length)).toBe(0);
    expect(
      dashboard.requests.filter(({ path }) =>
        /^\/api\/(services|events|prs|my-tickets|releases)/.test(path),
      ),
    ).toEqual([]);
  });
}

test('failed Settings load can retry and repair without a reload', async ({
  page,
  context,
  dashboard,
}) => {
  Object.assign(dashboard.data, settingsData('invalid'));
  let attempts = 0;
  await context.route('**/api/settings', (route) => {
    attempts++;
    return route.fulfill(
      attempts === 1
        ? { status: 503, json: { error: 'Synthetic unavailable' } }
        : { json: dashboard.data.settings },
    );
  });
  await page.goto('/#/settings');
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save settings', exact: true })).toBeVisible();
  expect(attempts).toBe(2);
});
