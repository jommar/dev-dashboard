import { test, expect } from './fixtures.js';
import { dashboardData } from './data.js';

// `api` and `web` share one repo dir (like be and queue); `worker` has its own.
const SHARED = 'workspace-api';
const OTHER = 'workspace-worker';
const MAIN = `/repos/${SHARED}`;
const A_FIX = `/repos/.worktrees/${SHARED}/a-fix`;
const B_FEAT = `/repos/.worktrees/${SHARED}/b-feat`;
const GONE = `/repos/.worktrees/${SHARED}/gone`;

const listing = {
  dir: SHARED,
  worktrees: [
    { path: MAIN, label: 'master', isMain: true },
    { path: A_FIX, label: 'a-fix', isMain: false },
    { path: B_FEAT, label: 'b-feat', isMain: false },
  ],
};

// Fresh data per test: the shared repo's two services get the given statuses, the worker is stopped.
const build =
  (statuses = {}) =>
  () => {
    const data = dashboardData();
    data.services = data.services.map((service) => ({
      ...service,
      dir: service.id === 'worker' ? OTHER : SHARED,
      checkout: `/repos/${service.id === 'worker' ? OTHER : SHARED}`,
      checkoutLabel: null,
      status: statuses[service.id] || 'stopped',
      exitCode: null,
    }));
    data.worktrees = { [SHARED]: listing };
    return data;
  };
const stopped = build();
const apiRunning = build({ api: 'running' });

const emitServices = (page, services) =>
  page.evaluate(
    (snapshot) => window.__dashboardMock.streams[0].emit('message', snapshot),
    services,
  );

const selected = (page, id) => page.getByTestId(`service-checkout-${id}`).locator('option:checked');

// Answers every checkout PUT: records the body and replies with the given response.
async function recordPuts(page, response) {
  const puts = [];
  await page.route('**/api/repos/*/checkout', (route) => {
    puts.push({
      path: new URL(route.request().url()).pathname,
      body: route.request().postDataJSON(),
    });
    return route.fulfill(response);
  });
  return puts;
}

const switched = (checkout, label) => ({
  json: { ok: true, dir: SHARED, checkout, checkoutLabel: label, restarted: [] },
});

test.describe('service checkout picker @regression', () => {
  test.describe('listing and picker options', () => {
    test.use({ dashboardFixture: { build: stopped } });

    test('checkout 15: options follow the listing and the snapshot picks the selected one', async ({
      page,
      dashboard,
    }) => {
      await page.goto('/#/services');
      const picker = page.getByTestId('service-checkout-api');
      await expect(picker).toBeVisible();
      await expect(page.getByRole('combobox', { name: 'Workspace API checkout' })).toHaveAttribute(
        'data-testid',
        'service-checkout-api',
      );
      await expect(picker.locator('option')).toHaveText(['main · master', 'a-fix', 'b-feat']);
      await expect(selected(page, 'api')).toHaveText('main · master');

      await emitServices(
        page,
        dashboard.data.services.map((service) =>
          service.id === 'api' ? { ...service, checkout: GONE, checkoutLabel: 'gone' } : service,
        ),
      );
      await expect(selected(page, 'api')).toHaveText('gone (not listed)');
    });

    test('checkout 16: the listing is fetched per dir on load and on focus, never on a timer', async ({
      page,
      dashboard,
    }) => {
      const reads = () =>
        dashboard.requests
          .filter(
            ({ method, path }) => method === 'GET' && /^\/api\/repos\/[^/]+\/worktrees$/.test(path),
          )
          .map(({ path }) => path);
      await page.goto('/#/services');
      await expect(page.getByTestId('service-checkout-api')).toBeVisible();
      await expect.poll(reads).toHaveLength(2);
      expect([...reads()].sort()).toEqual([
        `/api/repos/${SHARED}/worktrees`,
        `/api/repos/${OTHER}/worktrees`,
      ]);

      await page.getByTestId('service-checkout-web').focus();
      await expect.poll(reads).toHaveLength(3);
      expect(reads()[2]).toBe(`/api/repos/${SHARED}/worktrees`);

      await page.waitForTimeout(3000);
      expect(reads()).toHaveLength(3);
    });

    test('checkout 17: a repo with nothing running switches at once without a dialog', async ({
      page,
    }) => {
      const puts = await recordPuts(page, switched(A_FIX, 'a-fix'));
      await page.goto('/#/services');
      await page.getByTestId('service-checkout-api').selectOption({ label: 'a-fix' });
      await expect.poll(() => puts.length).toBe(1);
      expect(puts[0]).toEqual({
        path: `/api/repos/${SHARED}/checkout`,
        body: { path: A_FIX, restart: false },
      });
      await expect(page.getByTestId('control-feedback-api')).toHaveText(
        'Checkout set to a-fix. The next start uses it.',
      );
      await expect(page.getByTestId('service-checkout-dialog-api')).not.toBeVisible();
    });

    test('checkout 17: focus returns to the picker once the switch has finished', async ({
      page,
    }) => {
      await recordPuts(page, switched(A_FIX, 'a-fix'));
      await page.goto('/#/services');
      const picker = page.getByTestId('service-checkout-api');
      await picker.focus();
      await picker.selectOption({ label: 'a-fix' });
      await expect(page.getByTestId('control-feedback-api')).toHaveText(
        'Checkout set to a-fix. The next start uses it.',
      );
      await expect(picker).toBeEnabled();
      await expect(picker).toBeFocused();
    });

    test('checkout 19: the worktree badge follows the status feed on every card of the repo', async ({
      page,
      dashboard,
    }) => {
      await page.goto('/#/services');
      await expect(page.getByTestId('service-checkout-api')).toBeVisible();
      const withLabel = (label) =>
        dashboard.data.services.map((service) =>
          service.dir === SHARED
            ? {
                ...service,
                checkout: label ? A_FIX.replace('a-fix', label) : MAIN,
                checkoutLabel: label,
              }
            : service,
        );
      await emitServices(page, withLabel('x'));
      for (const id of ['api', 'web'])
        await expect(page.getByTestId(`service-checkout-badge-${id}`)).toHaveText('worktree: x');
      await expect(page.getByTestId('service-checkout-badge-worker')).toHaveCount(0);

      await page.getByTestId('service-checkout-badge-api').hover();
      await expect(page.getByRole('tooltip')).toContainText(`/repos/.worktrees/${SHARED}/x`);
      await page.mouse.move(0, 0);

      await emitServices(page, withLabel(null));
      for (const id of ['api', 'web', 'worker'])
        await expect(page.getByTestId(`service-checkout-badge-${id}`)).toHaveCount(0);
    });

    test('checkout 20: a held switch locks the whole repo, a held start locks only its pickers', async ({
      page,
    }) => {
      const repoCards = ['api', 'web'];
      const buttonsOf = (id) =>
        ['start', 'stop', 'restart'].map((action) => page.getByTestId(`${action}-${id}`));
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      await page.route('**/api/repos/*/checkout', async (route) => {
        await gate;
        await route.fulfill(switched(A_FIX, 'a-fix'));
      });
      await page.goto('/#/services');
      await page.getByTestId('service-checkout-api').selectOption({ label: 'a-fix' });
      for (const id of repoCards) {
        await expect(page.getByTestId(`service-checkout-${id}`)).toBeDisabled();
        for (const button of buttonsOf(id)) await expect(button).toBeDisabled();
      }
      await expect(page.getByTestId('service-checkout-worker')).toBeEnabled();
      for (const button of buttonsOf('worker')) await expect(button).toBeEnabled();
      release();
      for (const id of repoCards) {
        await expect(page.getByTestId(`service-checkout-${id}`)).toBeEnabled();
        for (const button of buttonsOf(id)) await expect(button).toBeEnabled();
      }

      let releaseStart;
      const startGate = new Promise((resolve) => {
        releaseStart = resolve;
      });
      await page.route('**/api/services/api/start', async (route) => {
        await startGate;
        await route.fulfill({ json: { ok: true } });
      });
      await page.getByTestId('start-api').click();
      for (const id of repoCards)
        await expect(page.getByTestId(`service-checkout-${id}`)).toBeDisabled();
      for (const button of buttonsOf('api')) await expect(button).toBeDisabled();
      for (const button of buttonsOf('web')) await expect(button).toBeEnabled();
      await expect(page.getByTestId('service-checkout-worker')).toBeEnabled();
      releaseStart();
      for (const id of repoCards)
        await expect(page.getByTestId(`service-checkout-${id}`)).toBeEnabled();
      for (const button of buttonsOf('api')) await expect(button).toBeEnabled();
    });

    test('checkout 21: a refused switch and an unavailable listing are reported on the card', async ({
      page,
    }) => {
      await page.route('**/api/repos/*/checkout', (route) =>
        route.fulfill({
          status: 409,
          json: { code: 'CHECKOUT_IN_USE', error: 'CHECKOUT IN USE', errors: [] },
        }),
      );
      let unavailable = false;
      await page.route('**/api/repos/*/worktrees', (route) =>
        unavailable
          ? route.fulfill({
              status: 502,
              json: { code: 'WORKTREES_UNAVAILABLE', error: 'WORKTREES UNAVAILABLE', errors: [] },
            })
          : route.fallback(),
      );
      await page.goto('/#/services');
      await page.getByTestId('service-checkout-api').selectOption({ label: 'a-fix' });
      const feedback = page.getByTestId('control-feedback-api');
      await expect(feedback).toHaveText('Checkout not changed: CHECKOUT IN USE');
      await expect(feedback).toHaveAttribute('data-state', 'error');
      await expect(selected(page, 'api')).toHaveText('main · master');

      unavailable = true;
      await page.getByTestId('service-checkout-web').focus();
      await expect(page.getByTestId('control-feedback-web')).toHaveText(
        'Checkouts unavailable: WORKTREES UNAVAILABLE',
      );
    });
  });

  test.describe('a repo with a running member', () => {
    test.use({ dashboardFixture: { build: apiRunning } });

    test('checkout 18: asks before restarting and only Confirm sends the restart', async ({
      page,
    }) => {
      const puts = await recordPuts(page, switched(A_FIX, 'a-fix'));
      await page.goto('/#/services');
      const picker = page.getByTestId('service-checkout-api');
      const dialog = page.getByTestId('service-checkout-dialog-api');

      await picker.selectOption({ label: 'a-fix' });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('Workspace API');
      await page.getByTestId('service-checkout-cancel-api').click();
      await expect(dialog).not.toBeVisible();
      await expect(selected(page, 'api')).toHaveText('main · master');

      await picker.selectOption({ label: 'a-fix' });
      await expect(dialog).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();
      await expect(selected(page, 'api')).toHaveText('main · master');
      expect(puts).toEqual([]);

      await picker.selectOption({ label: 'a-fix' });
      await page.getByTestId('service-checkout-confirm-api').click();
      await expect.poll(() => puts.length).toBe(1);
      expect(puts[0].body).toEqual({ path: A_FIX, restart: true });
      await expect(page.getByTestId('control-feedback-api')).toHaveText(
        'Restarting from a-fix. Status follows the service feed.',
      );
    });
  });
});
