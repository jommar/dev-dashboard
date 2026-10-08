import { test, expect } from './fixtures.js';
import { dashboardData, settingsData } from './data.js';

test('Settings-only navigation and keyboard edits preserve errors/conflicts, reload ready state and handle revocation', async ({
  page,
  dashboard,
  context,
}) => {
  test.setTimeout(90_000);
  const operational = () =>
    dashboard.requests.filter(({ path }) =>
      /^\/api\/(services|events|logs|prs|my-tickets|releases|pr-diff)/.test(path),
    );
  const settings = () => page.getByTestId('panel-settings');
  for (const mode of ['fresh', 'migration', 'invalid']) {
    Object.assign(dashboard.data, settingsData(mode));
    for (const width of [390, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      dashboard.requests.length = 0;
      await page.goto('/#prs');
      await expect(page).toHaveURL(/#\/?settings$/);
      await expect(page.getByTestId('tabs').locator('a')).toHaveCount(1);
      await expect(page.getByTestId('tab-settings')).toBeVisible();
      await expect(settings()).toBeVisible();
      await expect(page.locator('.panel:visible')).toHaveCount(1);
      await expect(page.locator('input[type="password"]')).toHaveCount(2);
      for (const input of await page.locator('input[type="password"]').all())
        await expect(input).toHaveValue('');
      expect(operational()).toEqual([]);
      expect(await page.evaluate(() => window.__dashboardMock.streams.length)).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.evaluate(() => {
        location.hash = 'services';
      });
      await expect(page).toHaveURL(/#\/?settings$/);
      await page.getByTestId('home-link').click();
      await expect(page).toHaveURL(/#\/?settings$/);
      await page.goBack();
      await expect(page).toHaveURL(/#\/?settings$/);
      expect(operational()).toEqual([]);
      await expect(page.getByText(/service feed|connecting to services/i)).toHaveCount(0);
    }
  }
  const form = settings();
  await form.getByLabel('GitHub organization', { exact: true }).fill('ExampleOrg');
  await form.getByLabel('Jira base URL', { exact: true }).fill('https://jira.example.invalid');
  await form.getByLabel('Jira email', { exact: true }).fill('qa@example.invalid');
  await form.getByLabel('Local root', { exact: true }).fill('/synthetic/workspace');
  await form.getByLabel('GitHub token', { exact: true }).fill('synthetic-ui-gh');
  await form.getByLabel('Jira token', { exact: true }).fill('synthetic-ui-jira');
  await form.getByRole('button', { name: 'Add repository', exact: true }).click();
  await form.getByLabel('Repository 2', { exact: true }).fill('added');
  await form.getByRole('button', { name: 'Remove repository 2', exact: true }).click();
  await form.getByRole('button', { name: 'Add service', exact: true }).click();
  await form.getByLabel('Service 4 ID', { exact: true }).fill('new-service');
  await form.getByLabel('Service 4 command', { exact: true }).fill('["npm","run","dev"]');
  await form.getByRole('button', { name: 'Remove service 4', exact: true }).click();
  const save = form.getByRole('button', { name: 'Save settings', exact: true });
  dashboard.data.saveResponse = {
    status: 422,
    json: {
      code: 'INVALID_SETTINGS',
      errors: [{ field: 'jira.email', message: 'Enter a valid Jira email' }],
    },
  };
  await save.focus();
  await page.keyboard.press('Enter');
  await expect(form.getByRole('alert')).toContainText('Enter a valid Jira email');
  await expect(form.getByLabel('Jira email', { exact: true })).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await expect(form.getByLabel('Jira email', { exact: true })).toHaveAttribute(
    'aria-describedby',
    /.+/,
  );
  const beforeConflict = await form.getByLabel('GitHub organization', { exact: true }).inputValue();
  dashboard.data.saveResponse = {
    status: 409,
    json: { code: 'REVISION_CONFLICT', error: 'Settings changed; reload or retry' },
  };
  await save.click();
  await expect(form.getByRole('alert')).toContainText(/changed|conflict/i);
  await expect(form.getByLabel('GitHub organization', { exact: true })).toHaveValue(beforeConflict);
  await expect(form.getByLabel('GitHub token', { exact: true })).toHaveValue('synthetic-ui-gh');
  dashboard.data.saveResponse = {
    status: 503,
    json: { code: 'VALIDATION_UNAVAILABLE', error: 'Connection unavailable; retry' },
  };
  await save.click();
  await expect(form.getByRole('alert')).toContainText(/unavailable|retry/i);
  await form.getByLabel('GitHub token', { exact: true }).fill('');
  await form.getByLabel('Jira token', { exact: true }).fill('');
  const submitted = [];
  page.on('request', (request) => {
    if (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/settings')
      submitted.push(request.postDataJSON());
  });
  const ready = dashboardData();
  delete dashboard.data.saveResponse;
  Object.assign(dashboard.data, ready);
  let navigations = 0;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations++;
  });
  await save.click();
  await expect(page.getByTestId('tab-services')).toBeVisible();
  expect(navigations).toBeGreaterThan(0);
  expect(submitted.at(-1).expectedRevision).toBe(1);
  expect(submitted.at(-1).credentials?.githubToken || '').toBe('');
  expect(await page.evaluate(() => window.__dashboardMock.streams.length)).toBe(1);
  await page.getByTestId('tab-settings').click();
  for (const input of await page.locator('input[type="password"]').all())
    await expect(input).toHaveValue('');
  Object.assign(dashboard.data, settingsData('invalid'));
  await page.evaluate(() =>
    window.__dashboardMock.streams[0].emit('setup-required', { code: 'SETUP_REQUIRED' }),
  );
  await expect(page).toHaveURL(/#\/?settings$/);
  await expect(page.getByTestId('tabs').locator('a')).toHaveCount(1);
  expect(await page.evaluate(() => window.__dashboardMock.streams.length)).toBe(0);
  Object.assign(dashboard.data, dashboardData());
  await page.reload();
  await expect(page.getByTestId('tab-services')).toBeVisible();
  Object.assign(dashboard.data, settingsData('invalid'));
  await context.route('**/api/my-tickets*', (route) =>
    route.fulfill({ status: 409, json: { code: 'SETUP_REQUIRED', error: 'Finish setup' } }),
  );
  await page.getByTestId('tab-my-tickets').click();
  await expect(page).toHaveURL(/#\/?settings$/);
  await expect(page.getByTestId('tabs').locator('a')).toHaveCount(1);
  expect(await page.evaluate(() => window.__dashboardMock.streams.length)).toBe(0);
});
