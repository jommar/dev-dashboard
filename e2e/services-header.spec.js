import { test, expect, openActions } from './fixtures.js';
import { dashboardData } from './data.js';

const DIR = 'workspace-api-service';
const BRANCH = 'feature-with-a-rather-long-branch-name';
const WORKTREE = `/repos/.worktrees/${DIR}/${BRANCH}`;
const COMMAND_ACCEPTED = 'Command accepted. Status follows the service feed.';

// Four cards, one per status the header colours: api runs from a worktree with a port (the widest
// header), web is stopped, worker exited cleanly and batch exited with code 2.
const build = () => {
  const data = dashboardData();
  data.services = [
    {
      ...data.services[0],
      dir: DIR,
      port: 4321,
      status: 'running',
      exitCode: null,
      checkout: WORKTREE,
      checkoutLabel: BRANCH,
    },
    { ...data.services[1], port: 4322, status: 'stopped', exitCode: null },
    { ...data.services[2], port: 4323, status: 'exited', exitCode: 0 },
    {
      id: 'batch',
      label: 'Nightly Batch Job',
      dir: 'workspace-batch',
      checkout: '/repos/workspace-batch',
      checkoutLabel: null,
      status: 'exited',
      port: 4324,
      exitCode: 2,
    },
  ];
  data.logs.batch = 'batch output';
  data.worktrees = {
    [DIR]: {
      dir: DIR,
      worktrees: [
        { path: `/repos/${DIR}`, label: 'master', isMain: true },
        { path: WORKTREE, label: BRANCH, isMain: false },
      ],
    },
  };
  return data;
};

test.use({ dashboardFixture: { build } });

const ids = () => build().services.map(({ id }) => id);
const trigger = (page, id) => page.getByTestId(`service-actions-${id}`);

// Boxes of what the header shows, measured in the browser. `null` marks something absent.
const measureHeader = (page, id) =>
  page.evaluate((id) => {
    const card = document.querySelector(`[data-testid="card-${id}"]`);
    const header = card.querySelector('header');
    const find = (testId) => card.querySelector(`[data-testid="${testId}"]`);
    const box = (node) => {
      if (!node) return null;
      const { top, bottom, left, right, height } = node.getBoundingClientRect();
      return { top, bottom, left, right, height };
    };
    const style = getComputedStyle(header);
    const parts = {
      title: find(`card-title-${id}`),
      dir: find(`card-dir-${id}`),
      status: find(`status-${id}`),
      checkout: find(`service-checkout-${id}`),
      badge: find(`service-checkout-badge-${id}`),
      actions: find(`service-actions-${id}`),
    };
    return {
      card: box(card),
      header: box(header),
      parts: Object.fromEntries(Object.entries(parts).map(([name, node]) => [name, box(node)])),
      padding: parseFloat(style.paddingTop) + parseFloat(style.paddingBottom),
      headerOverflows: header.scrollWidth > header.clientWidth,
      pageOverflows: document.documentElement.scrollWidth > innerWidth,
    };
  }, id);

// Rows of boxes: a box starts a new row when it begins below everything the row holds so far.
function rowsOf(boxes) {
  const rows = [];
  for (const box of [...boxes].sort((a, b) => a.top - b.top)) {
    const row = rows.at(-1);
    if (row && box.top < row.bottom - 1) row.bottom = Math.max(row.bottom, box.bottom);
    else rows.push({ bottom: box.bottom });
  }
  return rows;
}

// The colour a status dot is painted in: the `::before` background, or its text colour when it is
// a glyph. Compared with the colour a probe resolves a design token to, so no name is assumed.
const dotColour = (page, id) =>
  page.getByTestId(`status-${id}`).evaluate((chip) => {
    const dot = getComputedStyle(chip, '::before');
    const clear = ['rgba(0, 0, 0, 0)', 'transparent'].includes(dot.backgroundColor);
    return { exists: dot.content !== 'none', colour: clear ? dot.color : dot.backgroundColor };
  });

const tokenColour = (page, token) =>
  page.evaluate((token) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${token})`;
    document.body.append(probe);
    const { color } = getComputedStyle(probe);
    probe.remove();
    return color;
  }, token);

test.describe('service card header @regression', () => {
  test('header 1: every card header fits in at most two rows at every card width', async ({
    page,
  }) => {
    await page.goto('/#/services');
    await expect(page.getByTestId('log-api')).toContainText('line 120');
    for (const width of [390, 760, 1024, 1699, 1700]) {
      await page.setViewportSize({ width, height: 900 });
      for (const id of ids()) {
        const where = `${id} at ${width}px`;
        const measured = await measureHeader(page, id);
        const { parts, header, card } = measured;
        for (const name of ['title', 'dir', 'status', 'checkout', 'actions'])
          expect(parts[name], `${name} is shown (${where})`).not.toBeNull();
        const shown = Object.values(parts).filter(Boolean);
        expect(rowsOf(shown).length, `header rows (${where})`).toBeLessThanOrEqual(2);
        expect(
          header.height - measured.padding,
          `header content height against three controls (${where})`,
        ).toBeLessThan(3 * parts.actions.height);
        for (const box of shown) {
          expect(box.left, `inside the card on the left (${where})`).toBeGreaterThanOrEqual(
            card.left - 1,
          );
          expect(box.right, `inside the card on the right (${where})`).toBeLessThanOrEqual(
            card.right + 1,
          );
        }
        expect(measured.headerOverflows, `header scrolls sideways (${where})`).toBe(false);
        expect(measured.pageOverflows, `page scrolls sideways (${where})`).toBe(false);
      }
    }
  });

  test('header 2: Actions opens a menu with Start, Stop and Restart', async ({ page }) => {
    await page.goto('/#/services');
    const actions = trigger(page, 'api');
    await expect(actions).toHaveAccessibleName('Actions');
    await expect(actions).toHaveAttribute('aria-haspopup', 'menu');
    await expect(actions).toHaveAttribute('aria-expanded', 'false');
    for (const action of ['start', 'stop', 'restart'])
      await expect(page.getByTestId(`${action}-api`)).toHaveCount(0);

    await openActions(page, 'api');
    await expect(actions).toHaveAttribute('aria-expanded', 'true');
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem')).toHaveText(['Start', 'Stop', 'Restart']);
    for (const action of ['start', 'stop', 'restart'])
      await expect(menu.getByTestId(`${action}-api`)).toHaveRole('menuitem');
    // The card clips what overflows it, so each item must be what the pointer reaches.
    for (const action of ['start', 'stop', 'restart']) {
      const reached = await page.getByTestId(`${action}-api`).evaluate((item) => {
        const { left, top, width, height } = item.getBoundingClientRect();
        const hit = document.elementFromPoint(left + width / 2, top + height / 2);
        return Boolean(hit?.closest('[role="menuitem"]') === item);
      });
      expect(reached, `${action} is reachable by the pointer`).toBe(true);
    }
  });

  test('header 3: choosing Stop sends the same request and closes the menu', async ({ page }) => {
    // A page route answers before the fixture's context route, so it records every per-service call.
    const calls = [];
    await page.route('**/api/services/*/*', (route) => {
      calls.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
      return route.fulfill({ json: { ok: true } });
    });
    await page.goto('/#/services');
    await openActions(page, 'api');
    await page.getByTestId('stop-api').click();

    await expect(page.getByTestId('control-feedback-api')).toHaveText(COMMAND_ACCEPTED);
    await expect(page.getByTestId('control-feedback-api')).toHaveAttribute('data-state', 'success');
    expect(calls).toEqual(['POST /api/services/api/stop']);
    await expect(page.getByRole('menuitem')).toHaveCount(0);
    await expect(trigger(page, 'api')).toHaveAttribute('aria-expanded', 'false');
  });

  test('header 4: a card with a command in flight has a disabled Actions trigger', async ({
    page,
  }) => {
    let command;
    await page.route('**/api/services/worker/start', (route) => (command = route));
    await page.goto('/#/services');
    await openActions(page, 'worker');
    await page.getByTestId('start-worker').click();
    await expect.poll(() => Boolean(command)).toBe(true);
    await expect(trigger(page, 'worker')).toBeDisabled();
    for (const id of ['api', 'web', 'batch']) await expect(trigger(page, id)).toBeEnabled();
    await command.fulfill({ json: { ok: true } });
    await expect(trigger(page, 'worker')).toBeEnabled();
  });

  test('header 4: every Actions trigger is disabled while a bulk command runs', async ({
    page,
  }) => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    await page.route('**/api/services/*/start', async (route) => {
      await gate;
      await route.fulfill({ json: { ok: true } });
    });
    await page.goto('/#/services');
    await page.getByTestId('start-all').click();
    for (const id of ids()) await expect(trigger(page, id)).toBeDisabled();
    release();
    for (const id of ids()) await expect(trigger(page, id)).toBeEnabled();
  });

  test('header 5: Escape closes the menu and returns focus to the trigger', async ({ page }) => {
    await page.goto('/#/services');
    await openActions(page, 'api');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menuitem')).toHaveCount(0);
    await expect(trigger(page, 'api')).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger(page, 'api')).toBeFocused();
  });

  test('header 5: the arrow keys move between the menu items', async ({ page }) => {
    await page.goto('/#/services');
    await openActions(page, 'api');
    const focused = () =>
      page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null);
    await page.keyboard.press('ArrowDown');
    const first = await focused();
    await page.keyboard.press('ArrowDown');
    const second = await focused();
    expect([first, second].every((testId) => /^(start|stop|restart)-api$/.test(testId))).toBe(true);
    expect(second).not.toBe(first);
    await page.keyboard.press('ArrowUp');
    expect(await focused()).toBe(first);
  });

  test('header 7: keyboard focus ends on the trigger after an action is chosen', async ({
    page,
  }) => {
    await page.goto('/#/services');
    await trigger(page, 'api').focus();
    await page.keyboard.press('Enter');
    await expect(trigger(page, 'api')).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem')).toHaveCount(0);
    await expect(trigger(page, 'api')).toBeEnabled();
    await expect(trigger(page, 'api')).toBeFocused();
  });

  test('header 8: the menu is named by its trigger and the trigger points at it', async ({
    page,
  }) => {
    await page.goto('/#/services');
    await openActions(page, 'api');
    const menu = page.getByRole('menu', { name: 'Actions' });
    await expect(menu).toBeVisible();
    const controls = await trigger(page, 'api').getAttribute('aria-controls');
    await expect(menu).toHaveAttribute('id', controls);
  });

  test('header 9: the port stays whole and clear of the status chip on a 320px screen', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto('/#/services');
    await expect(page.getByTestId('log-api')).toContainText('line 120');
    for (const id of ids()) {
      const { parts } = await measureHeader(page, id);
      const port = await page
        .getByTestId(`card-${id}`)
        .locator('.service-port')
        .evaluate((node) => {
          const { left, right } = node.getBoundingClientRect();
          return { left, right, whole: node.scrollWidth <= node.clientWidth };
        });
      expect(port.right, `port clear of the chip (${id})`).toBeLessThanOrEqual(
        parts.status.left + 1,
      );
      expect(port.whole, `port not clipped (${id})`).toBe(true);
    }
  });

  test.describe('status dot colour', () => {
    const expectDot = async (page, id, token, text) => {
      await expect(page.getByTestId(`status-${id}`)).toHaveText(text);
      const dot = await dotColour(page, id);
      expect(dot.exists, `${id} has a dot`).toBe(true);
      expect(dot.colour, `${id} dot colour`).toBe(await tokenColour(page, token));
    };

    test('header 6: the three colours are told apart', async ({ page }) => {
      await page.goto('/#/services');
      const colours = await Promise.all(
        ['--green', '--red', '--muted'].map((token) => tokenColour(page, token)),
      );
      expect(new Set(colours).size).toBe(3);
    });

    test('header 6: a running service has a green dot', async ({ page }) => {
      await page.goto('/#/services');
      await expectDot(page, 'api', '--green', 'running');
    });

    test('header 6: a service that exited with a non-zero code has a red dot', async ({ page }) => {
      await page.goto('/#/services');
      await expectDot(page, 'batch', '--red', 'exited (2)');
    });

    test('header 6: stopped and cleanly exited services have a grey dot', async ({ page }) => {
      await page.goto('/#/services');
      await expectDot(page, 'web', '--muted', 'stopped');
      await expectDot(page, 'worker', '--muted', 'exited (0)');
    });
  });
});
