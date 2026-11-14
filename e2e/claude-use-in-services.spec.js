import { test, expect } from './fixtures.js';
import { claudeEntry, ticketBoardData } from './data.js';

// Use in Services, in the Claude dialog of a ticket whose implement session is done: it reads the
// worktrees of every service repo once, on the click (GET /api/repos/checkout-matches?key=), and
// switches a matching repo through the Services tab's own route (PUT /api/repos/<dir>/checkout),
// never starting a service. Both routes are answered here by the spec, so what the page sends is
// what is asserted.
//
// Test ids: `claude-use-in-services` (the button), `claude-use-in-services-result` (the status line),
// `claude-use-in-services-repo-<dir>` (one button per matching repo when several match) and
// `claude-use-in-services-restart` / `-cancel` (the confirm when a service of the repo runs).

const KEY = 'TAP-9001';
const BACKEND = 'Portage-backend';
const FRONTEND = 'TravelTracker';
const WORKTREE = '/r/.wt/tap-9001-fix';
const WORKTREE_FE = '/r/.wt/tap-9001-ui';
const DONE_IMPLEMENT = claudeEntry('done', 'implemented', {
  phase: 'implement-plan',
  flags: { 'investigate-and-plan': true, 'implement-plan': true, done: true, approved: true },
});

const match = (dir, ids, path, label) => ({ dir, ids, status: 'match', path, label });

// Answers the matches read with `repos`, and every checkout PUT with `put(body)` (default: success).
async function stubRoutes(page, repos, put) {
  const reads = [];
  const puts = [];
  await page.route('**/api/repos/checkout-matches**', (route) => {
    reads.push(new URL(route.request().url()).search);
    return route.fulfill({ json: { key: KEY, repos } });
  });
  await page.route('**/api/repos/*/checkout', (route) => {
    const body = route.request().postDataJSON();
    const dir = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3]);
    puts.push({ dir, body });
    return route.fulfill(
      put?.(body, dir) ?? {
        json: {
          ok: true,
          dir,
          checkout: body.path,
          checkoutLabel: body.path.split('/').pop(),
          restarted: [],
        },
      },
    );
  });
  return { reads, puts };
}

async function openDialog(page, dashboard) {
  ticketBoardData(dashboard.data);
  dashboard.data.claude.tickets[KEY] = DONE_IMPLEMENT;
  await page.goto('/#/my-tickets');
  await page.getByTestId(`claude-icon-${KEY}`).click();
  const dialog = page.getByTestId('claude-dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

test('use in services: single match switches the repo through the existing route', async ({
  page,
  dashboard,
}) => {
  const seen = await stubRoutes(page, [
    match(BACKEND, ['be', 'queue'], WORKTREE, 'tap-9001-fix'),
    { dir: FRONTEND, ids: ['fe'], status: 'none' },
  ]);
  const dialog = await openDialog(page, dashboard);

  await dialog.getByTestId('claude-use-in-services').click();

  const result = dialog.getByTestId('claude-use-in-services-result');
  await expect(result).toContainText(BACKEND);
  await expect(result).toContainText('tap-9001-fix');
  await expect(result).toContainText('stay stopped');
  expect(seen.reads).toEqual([`?key=${KEY}`]);
  expect(seen.puts).toEqual([{ dir: BACKEND, body: { path: WORKTREE, restart: false } }]);
});

test('use in services: a running repo asks before restarting, and cancel sends nothing more', async ({
  page,
  dashboard,
}) => {
  const seen = await stubRoutes(
    page,
    [match(BACKEND, ['be', 'queue'], WORKTREE, 'tap-9001-fix')],
    (body) =>
      body.restart
        ? undefined
        : { status: 409, json: { code: 'CHECKOUT_IN_USE', error: 'CHECKOUT IN USE', errors: [] } },
  );
  const dialog = await openDialog(page, dashboard);

  await dialog.getByTestId('claude-use-in-services').click();
  const confirm = dialog.getByTestId('claude-use-in-services-confirm');
  await expect(confirm).toContainText(/restart/i);
  await expect(confirm).toContainText(BACKEND);
  await dialog.getByTestId('claude-use-in-services-cancel').click();
  await expect(confirm).toHaveCount(0);
  expect(seen.puts).toHaveLength(1);

  await dialog.getByTestId('claude-use-in-services').click();
  await dialog.getByTestId('claude-use-in-services-restart').click();
  await expect(dialog.getByTestId('claude-use-in-services-result')).toContainText('tap-9001-fix');
  expect(seen.puts.map(({ body }) => body.restart)).toEqual([false, false, true]);
});

test('use in services: an ambiguous or missing match refuses and sends no PUT', async ({
  page,
  dashboard,
}) => {
  const seen = await stubRoutes(page, [
    {
      dir: BACKEND,
      ids: ['be', 'queue'],
      status: 'ambiguous',
      candidates: ['tap-9001-a', 'tap-9001-b'],
    },
    { dir: FRONTEND, ids: ['fe'], status: 'none' },
  ]);
  const dialog = await openDialog(page, dashboard);

  await dialog.getByTestId('claude-use-in-services').click();
  const result = dialog.getByTestId('claude-use-in-services-result');
  await expect(result).toContainText('tap-9001-a');
  await expect(result).toContainText('tap-9001-b');
  await expect(result).toContainText('pick one in Services');
  expect(seen.puts).toEqual([]);

  await page.unroute('**/api/repos/checkout-matches**');
  await page.route('**/api/repos/checkout-matches**', (route) =>
    route.fulfill({
      json: { key: KEY, repos: [{ dir: BACKEND, ids: ['be'], status: 'none' }] },
    }),
  );
  await dialog.getByTestId('claude-use-in-services').click();
  await expect(result).toHaveText(`No worktree branch contains ${KEY}.`);
  expect(seen.puts).toEqual([]);
});

test('use in services: several repos match, so one button each, and only the pressed one switches', async ({
  page,
  dashboard,
}) => {
  const seen = await stubRoutes(page, [
    match(BACKEND, ['be', 'queue'], WORKTREE, 'tap-9001-fix'),
    match(FRONTEND, ['fe'], WORKTREE_FE, 'tap-9001-ui'),
  ]);
  const dialog = await openDialog(page, dashboard);

  await dialog.getByTestId('claude-use-in-services').click();
  await expect(dialog.getByTestId(`claude-use-in-services-repo-${BACKEND}`)).toBeVisible();
  await expect(dialog.getByTestId(`claude-use-in-services-repo-${FRONTEND}`)).toBeVisible();
  expect(seen.puts).toEqual([]);

  await dialog.getByTestId(`claude-use-in-services-repo-${FRONTEND}`).click();
  await expect(dialog.getByTestId('claude-use-in-services-result')).toContainText('tap-9001-ui');
  expect(seen.puts).toEqual([{ dir: FRONTEND, body: { path: WORKTREE_FE, restart: false } }]);
});

test('use in services: no polling, nothing is read until the button is pressed, and only a done implement shows it', async ({
  page,
  dashboard,
}) => {
  await page.clock.install();
  const reads = [];
  await page.route('**/api/repos/**', (route) => {
    reads.push(route.request().url());
    return route.fulfill({ json: { key: KEY, repos: [] } });
  });
  const dialog = await openDialog(page, dashboard);
  await expect(dialog.getByTestId('claude-use-in-services')).toBeVisible();
  await page.clock.runFor(20_000);
  expect(reads).toEqual([]);

  dashboard.data.claude.tickets[KEY] = claudeEntry('working', 'running', {
    phase: 'implement-plan',
  });
  await page.clock.runFor(16_000);
  await expect(dialog.getByTestId('claude-use-in-services')).toHaveCount(0);
  expect(reads).toEqual([]);
});
