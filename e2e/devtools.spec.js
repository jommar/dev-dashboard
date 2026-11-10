import { test, expect } from './fixtures.js';

// The fixture's two rows: one running, one stopped on its own profile.
const RUNNING = 'b-3f9a2c7d';
const STOPPED = 'b-7c1d4e20';

const devtoolsRequests = ({ requests }) =>
  requests.filter(({ path }) => path.startsWith('/api/devtools/'));
const lastCall = ({ data }) => data.devtools.calls.at(-1);
const openDevtools = async (page) => {
  await page.goto('/#/devtools');
  await expect(page.getByTestId('panel-devtools')).toBeVisible();
  await expect(page.getByTestId(`devtools-row-${RUNNING}`)).toBeVisible();
};

test.describe('devtools panel', () => {
  test('panel lists both instances', async ({ page }) => {
    await openDevtools(page);
    await expect(page.getByTestId('devtools-browsers')).toBeVisible();

    const running = page.getByTestId(`devtools-row-${RUNNING}`);
    await expect(running.getByTestId(`devtools-label-${RUNNING}`)).toHaveText('Browser 3f9a');
    await expect(running.getByTestId(`devtools-port-${RUNNING}`)).toHaveText('9300');
    await expect(running.getByTestId(`devtools-url-${RUNNING}`)).toHaveText('about:blank');
    await expect(running.getByTestId(`devtools-pid-${RUNNING}`)).toHaveText('41001');
    await expect(running.getByTestId(`devtools-started-${RUNNING}`)).toHaveText(
      /just now|\d+[mhd] ago/,
    );
    await expect(running.getByTestId(`devtools-status-${RUNNING}`)).toHaveText('running');
    await expect(running.getByTestId(`devtools-status-${RUNNING}`)).toHaveAttribute(
      'data-status',
      'running',
    );
    // The running row stops; the stopped row starts.
    await expect(running.getByTestId(`devtools-stop-${RUNNING}`)).toBeVisible();
    await expect(running.getByTestId(`devtools-start-${RUNNING}`)).toHaveCount(0);

    const stopped = page.getByTestId(`devtools-row-${STOPPED}`);
    await expect(stopped.getByTestId(`devtools-label-${STOPPED}`)).toHaveText('QA login');
    await expect(stopped.getByTestId(`devtools-port-${STOPPED}`)).toHaveText('9301');
    await expect(stopped.getByTestId(`devtools-url-${STOPPED}`)).toHaveText(
      'https://example.invalid/login',
    );
    // A stopped instance has no pid, but the row still carries the cell.
    await expect(stopped.getByTestId(`devtools-pid-${STOPPED}`)).toHaveCount(1);
    await expect(stopped.getByTestId(`devtools-started-${STOPPED}`)).toHaveCount(1);
    await expect(stopped.getByTestId(`devtools-status-${STOPPED}`)).toHaveText('stopped');
    await expect(stopped.getByTestId(`devtools-status-${STOPPED}`)).toHaveAttribute(
      'data-status',
      'stopped',
    );
    await expect(stopped.getByTestId(`devtools-start-${STOPPED}`)).toBeVisible();
    await expect(stopped.getByTestId(`devtools-stop-${STOPPED}`)).toHaveCount(0);
  });

  test('launch adds a row', async ({ page, dashboard }) => {
    await openDevtools(page);
    const { id, port } = dashboard.data.devtools.nextLaunch;
    await expect(page.getByTestId(`devtools-row-${id}`)).toHaveCount(0);

    await page.getByTestId('devtools-label-input').fill('QA');
    await page.getByTestId('devtools-launch').click();

    await expect(page.getByTestId(`devtools-row-${id}`)).toBeVisible();
    await expect(page.getByTestId(`devtools-label-${id}`)).toHaveText('QA');
    await expect(page.getByTestId(`devtools-port-${id}`)).toHaveText(String(port));
    expect(lastCall(dashboard)).toMatchObject({
      method: 'POST',
      path: '/api/devtools/browsers',
      body: { label: 'QA' },
    });
  });

  test('stop turns a row stopped', async ({ page, dashboard }) => {
    await openDevtools(page);
    await page.getByTestId(`devtools-stop-${RUNNING}`).click();

    await expect(page.getByTestId(`devtools-status-${RUNNING}`)).toHaveText('stopped');
    await expect(page.getByTestId(`devtools-status-${RUNNING}`)).toHaveAttribute(
      'data-status',
      'stopped',
    );
    // The action flips to Start, and Stop is gone.
    await expect(page.getByTestId(`devtools-start-${RUNNING}`)).toBeVisible();
    await expect(page.getByTestId(`devtools-stop-${RUNNING}`)).toHaveCount(0);
    expect(lastCall(dashboard)).toEqual({
      method: 'POST',
      path: '/api/devtools/browsers/stop',
      body: { id: RUNNING },
    });
  });

  test('inactive tab makes no request', async ({ page, dashboard }) => {
    await page.goto('/#/home');
    await expect(page.getByTestId('panel-home')).toBeVisible();
    await expect(page.getByTestId('home-meta')).not.toContainText('loading');
    expect(devtoolsRequests(dashboard)).toEqual([]);

    // The same tab, opened, does read the registry: the gate is what held it back.
    await page.getByTestId('tab-devtools').click();
    await expect(page.getByTestId(`devtools-row-${RUNNING}`)).toBeVisible();
    await expect.poll(() => devtoolsRequests(dashboard).length).toBeGreaterThan(0);
  });
});

test('tools route', async ({ page }) => {
  await page.goto('/#/devtools');
  await expect(page.getByTestId('panel-devtools')).toBeVisible();
  await expect(page.getByTestId('panel-home')).toBeHidden();
  // The route is a tools entry: current inside the Tools group, never a primary link.
  const tab = page.getByTestId('tab-devtools');
  await expect(tab).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.nav-tools').getByTestId('tab-devtools')).toHaveCount(1);
  expect(
    await page.locator('.nav-primary a').evaluateAll((links) => links.map((el) => el.dataset.tab)),
  ).toEqual(['home', 'my-tickets', 'slack']);

  // Below 1200 px it lives behind the Tools disclosure and navigates on Enter.
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto('/#/home');
  const toggle = page.getByTestId('nav-tools-toggle');
  await expect(toggle).toBeVisible();
  await expect(page.getByTestId('tab-devtools')).toBeHidden();
  await toggle.click();
  await expect(page.getByTestId('tab-devtools')).toBeVisible();
  await page.getByTestId('tab-devtools').focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/devtools$/);
  await expect(page.getByTestId('panel-devtools')).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
});

test('remove drops a row and its profile', async ({ page, dashboard }) => {
  await openDevtools(page);
  await expect(page.getByTestId(`devtools-remove-${STOPPED}`)).toBeVisible();

  await page.getByTestId(`devtools-remove-${STOPPED}`).click();

  await expect(page.getByTestId(`devtools-row-${STOPPED}`)).toHaveCount(0);
  await expect(page.getByTestId(`devtools-row-${RUNNING}`)).toBeVisible();
  expect(lastCall(dashboard)).toEqual({
    method: 'POST',
    path: '/api/devtools/browsers/remove',
    body: { id: STOPPED },
  });
});
