import { test, expect } from './fixtures.js';
import { BOARD_THREAD_TS, claudeEntry, ticketBoardData } from './data.js';

const STORAGE_KEY = 'dev-dashboard.releases';
const API_WITH_QUERY = /\/api\/releases\?/;

const releaseRequests = (dashboard) =>
  dashboard.requests
    .filter(({ path }) => path === '/api/releases' || path.startsWith('/api/releases?'))
    .map(({ path }) => Object.fromEntries(new URL(path, 'http://dashboard.invalid').searchParams));

const scriptRequests = (dashboard) =>
  dashboard.requests.filter(
    ({ method, path }) => method === 'POST' && path === '/api/releases/scripts',
  );

const storedSelection = (page) => page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);

// Runs once per tab session, so a reload keeps whatever the page stored afterwards.
const seedStoredSelection = (page, raw) =>
  page.addInitScript(
    ([key, value]) => {
      if (sessionStorage.getItem('seeded:' + key)) return;
      sessionStorage.setItem('seeded:' + key, '1');
      localStorage.setItem(key, value);
    },
    [STORAGE_KEY, raw],
  );

const card = (page, key) => page.getByTestId(`releases-card-${key}`);

async function openReleases(page) {
  await page.goto('/#/releases');
  await expect(page.getByTestId('panel-releases')).toBeVisible();
  await expect(page.locator('[data-testid^="releases-card-"]').first()).toBeVisible();
  await expect(page.getByTestId('releases-loading')).toHaveCount(0);
  await expect(page.getByTestId('releases-refresh')).toBeEnabled();
}

test('board & scope: opens viewport-locked with Jira-status columns (finished last), copyKeys, and always-All scope', async ({
  page,
  dashboard,
}) => {
  await page.goto('/#/home');
  await expect(page.getByTestId('panel-home')).toBeVisible();
  await expect(page.getByTestId('home-meta')).not.toContainText('loading');
  for (const id of ['services', 'prs', 'my-tickets']) {
    await page.getByTestId('tab-' + id).click();
    await expect(page.getByTestId('panel-' + id)).toBeVisible();
  }
  expect(releaseRequests(dashboard)).toEqual([]);

  await page.getByTestId('tab-releases').click();
  await expect(page).toHaveURL(/#\/releases$/);
  await expect(page.getByTestId('panel-releases')).toBeVisible();
  await expect(page.locator('[data-testid^="releases-card-"]')).toHaveCount(9);
  await expect(page.getByTestId('releases-loading')).toHaveCount(0);
  await expect(page.getByTestId('releases-meta')).not.toContainText('loading');

  // Viewport-locked board panel and no Mine/All checkbox.
  expect(
    await page.evaluate(() => getComputedStyle(document.getElementById('root')).display === 'flex'),
    'Releases opts into the shared viewport-locked board layout',
  ).toBe(true);
  await expect(page.getByTestId('releases-scope')).toHaveCount(0);

  const requests = releaseRequests(dashboard);
  expect(requests).toHaveLength(1);
  expect(requests[0].version).toBeUndefined();
  expect(requests[0].refresh).toBeUndefined();
  expect(requests[0].scope).toBe('all');
  await expect(page.getByTestId('releases-version')).toHaveValue('18741');
  await expect(page.getByTestId('releases-version').locator('option')).toHaveCount(5);

  // Columns follow Jira workflow order with non-done finished statuses (Rejected) last.
  const columns = await page
    .locator('section.board-column[data-testid^="releases-column-"]')
    .evaluateAll((elements) => elements.map((element) => element.dataset.testid));
  expect(columns).toEqual([
    'releases-column-blocked',
    'releases-column-to-do',
    'releases-column-in-progress',
    'releases-column-ready-for-testing',
    'releases-column-done',
    'releases-column-rejected',
  ]);

  // Populated columns render copyKeys buttons.
  await expect(page.getByTestId('releases-column-copy-in-progress')).toBeVisible();
  await expect(page.getByTestId('releases-column-copy-done')).toBeVisible();

  // Decluttered cards show a compact PR rollup toggle that expands to 1-line PR rows.
  await expect(page.getByTestId('releases-ticket-note-DEMO-476')).toHaveText('No PRs');
  const toggle1058 = page.getByTestId('releases-ticket-prs-toggle-DEMO-1058');
  await expect(toggle1058).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle1058).toContainText('2/3 PRs merged');
  await expect(page.getByTestId('releases-ticket-prs-DEMO-1058')).toHaveCount(0);

  await toggle1058.click();
  await expect(toggle1058).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('releases-ticket-prs-DEMO-1058')).toBeVisible();
  await expect(page.getByTestId('release-pr-link-example/web-535')).toHaveText('web #535');
  await expect(page.getByTestId('release-pr-state-example/web-535')).toHaveText('MERGED');
  await expect(page.getByTestId('release-pr-link-example/worker-451')).toHaveText('worker #451');
  await expect(page.getByTestId('release-pr-state-example/worker-451')).toHaveText('OPEN');

  await toggle1058.click();
  await expect(toggle1058).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('releases-ticket-prs-DEMO-1058')).toHaveCount(0);
});

test('badges, Slack, and Claude: cards show always-visible Script/Migration/Prisma badges, open SlackThreadDialog and ClaudeDialog', async ({
  page,
  dashboard,
}) => {
  // Seed TAP-9002 in the release so threadTicketKeys matches ticketBoardData's needsReply thread.
  ticketBoardData(dashboard.data);
  const target = dashboard.data.releases.tickets['18741'].all.find(
    (ticket) => ticket.key === 'DEMO-1058',
  );
  target.key = 'TAP-9002';
  dashboard.data.releaseScripts.byTicket['TAP-9002'] =
    dashboard.data.releaseScripts.byTicket['DEMO-1058'];
  delete dashboard.data.releaseScripts.byTicket['DEMO-1058'];
  dashboard.data.claude.tickets['TAP-9002'] = claudeEntry('done', 'plan_ready', {});

  await openReleases(page);
  await expect.poll(() => scriptRequests(dashboard).length).toBeGreaterThanOrEqual(1);

  // Script & Migration badges on TAP-9002 and Prisma schema badge on DEMO-1200 are visible while PRs stay collapsed.
  await expect(page.getByTestId('releases-ticket-prs-TAP-9002')).toHaveCount(0);
  const badges9002 = page.getByTestId('releases-ticket-scripts-TAP-9002');
  await expect(badges9002).toBeVisible();
  await expect(badges9002).toContainText('Migration');
  await expect(badges9002).toContainText('Script');

  const badges1200 = page.getByTestId('releases-ticket-scripts-DEMO-1200');
  await expect(badges1200).toBeVisible();
  await expect(badges1200).toContainText('Prisma schema');

  // Slack thread chip opens SlackThreadDialog.
  const threadChip = card(page, 'TAP-9002').getByTestId(
    `slack-thread-link-${BOARD_THREAD_TS.needsReply}`,
  );
  await expect(threadChip).toBeVisible();
  await threadChip.click();
  await expect(page.getByTestId('slack-thread-close')).toBeVisible();
  await expect(
    page.getByTestId(`slack-thread-message-${BOARD_THREAD_TS.needsReply}`),
  ).toBeVisible();
  await page.getByTestId('slack-thread-close').click();
  await expect(page.getByTestId('slack-thread-close')).toBeHidden();

  // Claude icon opens ClaudeDialog.
  await card(page, 'TAP-9002').getByTestId('claude-icon-TAP-9002').click();
  await expect(page.getByTestId('claude-dialog')).toBeVisible();
  await expect(page.getByTestId('claude-dialog-title')).toContainText('TAP-9002');
  await page.getByTestId('claude-dialog-close').click();
  await expect(page.getByTestId('claude-dialog')).toBeHidden();
});

test('summary: toolbar Summary button opens Release Summary dialog with rollup, scripts, and text; ?view=text opens and clears on close', async ({
  page,
  dashboard,
}) => {
  await openReleases(page);
  await expect.poll(() => scriptRequests(dashboard).length).toBeGreaterThanOrEqual(1);
  await expect(page).toHaveURL(/#\/releases$/);
  await expect(page.getByTestId('releases-summary-dialog')).toHaveCount(0);
  const requests = releaseRequests(dashboard).length;

  await page.getByTestId('releases-summary-open').click();
  const dialog = page.getByTestId('releases-summary-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('releases-summary-total')).toHaveText('9 tickets');
  await expect(page.getByTestId('releases-summary-prs')).toContainText('PRs merged');
  await expect(page.getByTestId('releases-summary-scripts-count')).toHaveText(
    '2 tickets with scripts/migrations',
  );
  await expect(page.getByTestId('releases-summary-statuses')).toBeVisible();
  await expect(page.getByTestId('releases-summary-script-DEMO-1058')).toBeVisible();
  await expect(page.getByTestId('releases-summary-script-DEMO-1200')).toBeVisible();
  await expect(page.getByTestId('releases-copy-text')).toBeVisible();

  const pre = page.getByTestId('releases-text');
  await expect(pre).toBeVisible();
  await expect(pre).toContainText('DEMO-1058');
  await expect(pre).toContainText('#2075 example/api merged -> ops/development');
  await expect(pre).toContainText('[Migration]');
  await expect(pre).toContainText('setup/knex/migrations/20260101_mileage.js');
  await expect(pre).toContainText('[Script]');
  await expect(pre).toContainText('setup/scripts/backfill.js');
  await expect(pre).toContainText('[Prisma schema]');
  await expect(pre).toContainText('libs/client/prisma/client/client.prisma');
  expect(releaseRequests(dashboard)).toHaveLength(requests);

  await page.getByTestId('releases-summary-close').click();
  await expect(dialog).toHaveCount(0);

  // Navigating directly to ?view=text auto-opens the Summary dialog; closing returns to #/releases.
  await page.goto('/#/releases?view=text');
  await expect(page.getByTestId('releases-summary-dialog')).toBeVisible();
  await expect(page.getByTestId('releases-text')).toBeVisible();

  await page.getByTestId('releases-summary-close').click();
  await expect(page.getByTestId('releases-summary-dialog')).toHaveCount(0);
  await expect(page).toHaveURL(/#\/releases$/);
  await expect(page.locator('[data-testid^="releases-card-"]')).toHaveCount(9);
});

test('version: picking a release requests it with scope=all, stores the choice and requests it first after a reload', async ({
  page,
  dashboard,
}) => {
  await openReleases(page);
  expect(await storedSelection(page), 'the default selection is never written').toBeNull();

  await page.getByTestId('releases-version').selectOption('18838');
  await expect(card(page, 'DEMO-2001')).toBeVisible();
  await expect(page.locator('[data-testid^="releases-card-"]')).toHaveCount(2);
  expect(releaseRequests(dashboard).at(-1).version).toBe('18838');
  expect(releaseRequests(dashboard).at(-1).scope).toBe('all');
  expect(JSON.parse(await storedSelection(page))).toEqual({ version: 1, versionId: '18838' });

  dashboard.requests.length = 0;
  await page.reload();
  await expect(card(page, 'DEMO-2001')).toBeVisible();
  expect(releaseRequests(dashboard)[0].version).toBe('18838');
  expect(releaseRequests(dashboard)[0].scope).toBe('all');
  await expect(page.getByTestId('releases-version')).toHaveValue('18838');
});

test('version: a stored id the server rejects is cleared and the load repeats once without it', async ({
  page,
  dashboard,
}) => {
  await seedStoredSelection(page, '{"version":1,"versionId":"99999"}');
  await page.goto('/#/releases');
  await expect(card(page, 'DEMO-1398')).toBeVisible();
  await page.waitForTimeout(300);

  const requests = releaseRequests(dashboard);
  expect(requests).toHaveLength(2);
  expect(requests[0].version).toBe('99999');
  expect(requests[1].version).toBeUndefined();
  expect(await storedSelection(page)).toBeNull();
  await expect(page.getByTestId('releases-version')).toHaveValue('18741');
  await expect(page.getByTestId('releases-error')).toBeHidden();
});

test('version: a slow earlier response never overwrites a newer selection', async ({ page }) => {
  await openReleases(page);
  let releaseSlowResponse;
  const slowResponse = new Promise((resolve) => {
    releaseSlowResponse = resolve;
  });
  await page.route(API_WITH_QUERY, async (route) => {
    if (new URL(route.request().url()).searchParams.get('version') === '18838') await slowResponse;
    try {
      await route.fallback();
    } catch {
      /* the page abandoned the superseded request */
    }
  });
  try {
    const picker = page.getByTestId('releases-version');
    await picker.selectOption('18838');
    await picker.selectOption('18600');
    await expect(card(page, 'DEMO-3001')).toBeVisible();

    releaseSlowResponse();
    await page.waitForTimeout(500);
    await expect(picker).toHaveValue('18600');
    await expect(card(page, 'DEMO-3001')).toBeVisible();
    await expect(card(page, 'DEMO-2001')).toHaveCount(0);
    expect(JSON.parse(await storedSelection(page))).toEqual({ version: 1, versionId: '18600' });
  } finally {
    releaseSlowResponse();
  }
});

test('refresh: the Refresh button bypasses cache, has no countdown span, guards pending requests and keeps data on failure', async ({
  page,
  dashboard,
}) => {
  await openReleases(page);
  expect(releaseRequests(dashboard)[0].refresh).toBeUndefined();
  await expect(page.getByTestId('releases-next')).toHaveCount(0);

  await page.getByTestId('releases-refresh').click();
  await expect.poll(() => releaseRequests(dashboard).length).toBe(2);
  expect(releaseRequests(dashboard)[1].refresh).toBe('1');
  await expect(page.getByTestId('releases-refresh')).toBeEnabled();
  await expect(page.locator('[data-testid^="releases-card-"]')).toHaveCount(9);

  // Pending request disables repeated refreshes.
  let releasePending;
  const pending = new Promise((resolve) => {
    releasePending = resolve;
  });
  await page.route(API_WITH_QUERY, async (route) => {
    await pending;
    try {
      await route.fallback();
    } catch {
      /* page may have closed */
    }
  });
  try {
    await page.getByTestId('releases-refresh').click();
    await expect(page.getByTestId('releases-refresh')).toBeDisabled();
  } finally {
    releasePending();
  }
  await expect(page.getByTestId('releases-refresh')).toBeEnabled();
  await page.unroute(API_WITH_QUERY);

  // Failed refresh preserves last-good cards and version.
  await page.route(API_WITH_QUERY, (route) =>
    route.fulfill({
      status: 502,
      json: { code: 'OPERATION_FAILED', error: 'OPERATION FAILED', errors: [] },
    }),
  );
  await page.getByTestId('releases-refresh').click();
  await expect(page.getByTestId('releases-meta')).toContainText(
    'Refresh failed — showing last update',
  );
  await expect(page.locator('[data-testid^="releases-card-"]')).toHaveCount(9);
  await expect(card(page, 'DEMO-1398')).toBeVisible();
  await expect(page.getByTestId('releases-error')).toBeHidden();
});

test('unavailable: tickets whose PR lookup failed say so with a banner count while other cards stay', async ({
  page,
}) => {
  await openReleases(page);
  const unavailable = card(page, 'DEMO-1884');
  await expect(unavailable).toContainText('PRs unavailable (timeout)');
  await expect(unavailable).not.toContainText('No linked PRs');

  const banner = page.getByTestId('releases-unavailable');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(/\b1 tickets?\b/);
  await expect(banner).toContainText('Use Refresh to retry.');

  await page.getByTestId('releases-version').selectOption('18790');
  await expect(card(page, 'DEMO-4001')).toBeVisible();
  await expect(banner).toHaveText(
    'PR lookup returned nothing for tickets Jira says have PRs — check the Jira GitHub integration. Refresh will not fix this.',
  );
  await expect(card(page, 'DEMO-4001').locator('[data-error]')).toHaveAttribute(
    'data-error',
    'instance-mismatch',
  );
});

test('truncated: a release cut off by the ticket cap warns above its tickets and a complete one does not', async ({
  page,
}) => {
  await openReleases(page);
  await expect(page.getByTestId('releases-truncated')).toBeHidden();

  await page.getByTestId('releases-version').selectOption('18590');
  await expect(card(page, 'DEMO-5001')).toBeVisible();
  const warning = page.getByTestId('releases-truncated');
  await expect(warning).toBeVisible();
  await expect(warning).toHaveText(
    'Only the first 4 tickets are shown — totals may be incomplete.',
  );

  await page.getByTestId('releases-version').selectOption('18741');
  await expect(card(page, 'DEMO-1398')).toBeVisible();
  await expect(page.getByTestId('releases-truncated')).toBeHidden();
});

test('poll: an open releases tab makes no further request after ten minutes', async ({
  page,
  dashboard,
}) => {
  await page.clock.install();
  await page.goto('/#/releases');
  await expect(card(page, 'DEMO-1398')).toBeVisible();
  expect(releaseRequests(dashboard)).toHaveLength(1);

  await page.clock.runFor(10 * 60_000);
  await page.waitForTimeout(500);
  expect(releaseRequests(dashboard)).toHaveLength(1);
  await expect(card(page, 'DEMO-1398')).toBeVisible();
});

test('overflow: the eleven-tab nav and the releases board fit a 390px viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openReleases(page);
  const fit = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('[data-testid="tabs"] .tab')];
    return {
      tabCount: tabs.length,
      tabsOutsideViewport: tabs
        .filter((tab) => {
          const rect = tab.getBoundingClientRect();
          return rect.left < -0.5 || rect.right > innerWidth + 0.5;
        })
        .map((tab) => tab.textContent.trim()),
      content: document.documentElement.scrollWidth,
      width: document.documentElement.clientWidth,
    };
  });
  expect(fit.tabCount).toBe(11);
  expect(fit.tabsOutsideViewport).toEqual([]);
  expect(fit.content, 'the page must not scroll horizontally').toBeLessThanOrEqual(fit.width);
});
