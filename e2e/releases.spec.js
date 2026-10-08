import { test, expect } from './fixtures.js';

const STORAGE_KEY = 'dev-dashboard.releases';
const API_WITH_QUERY = /\/api\/releases\?/;

const releaseRequests = (dashboard) =>
  dashboard.requests
    .filter(({ path }) => path.startsWith('/api/releases'))
    .map(({ path }) => Object.fromEntries(new URL(path, 'http://dashboard.invalid').searchParams));

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

async function openReleases(page) {
  await page.goto('/#/releases');
  await expect(page.getByTestId('panel-releases')).toBeVisible();
  await expect(page.locator('.release-ticket').first()).toBeVisible();
  await expect(page.getByTestId('releases-loading')).toHaveCount(0);
  await expect(page.getByTestId('releases-refresh')).toBeEnabled();
}

test('releases tab opens on its own route, loads the default release grouped by merge state and stays silent until opened', async ({
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
  await expect(page.locator('.release-ticket')).toHaveCount(6);
  await expect(page.getByTestId('releases-loading')).toHaveCount(0);
  await expect(page.getByTestId('releases-meta')).not.toContainText('loading');

  const requests = releaseRequests(dashboard);
  expect(requests).toHaveLength(1);
  expect(requests[0].version).toBeUndefined();
  expect(requests[0].refresh).toBeUndefined();
  expect(requests[0].scope ?? 'mine').toBe('mine');
  await expect(page.getByTestId('releases-version')).toHaveValue('18741');
  await expect(page.getByTestId('releases-version').locator('option')).toHaveCount(5);
  await expect(page.getByTestId('releases-scope')).not.toBeChecked();

  const groups = await page
    .getByTestId(/^releases-group-(open|partial|no-pr|unavailable|merged)$/)
    .evaluateAll((elements) => elements.map((element) => element.dataset.testid));
  expect(groups).toEqual([
    'releases-group-open',
    'releases-group-partial',
    'releases-group-no-pr',
    'releases-group-unavailable',
    'releases-group-merged',
  ]);
  const members = {
    open: ['DEMO-1398', 'DEMO-1700'],
    partial: ['DEMO-1058'],
    'no-pr': ['DEMO-476'],
    unavailable: ['DEMO-1884'],
    merged: ['DEMO-1200'],
  };
  for (const [state, keys] of Object.entries(members)) {
    const group = page.getByTestId(`releases-group-${state}`);
    await expect(group.getByTestId(`releases-group-count-${state}`)).toHaveText(
      String(keys.length),
    );
    for (const key of keys) await expect(group.getByTestId(`release-ticket-${key}`)).toBeVisible();
  }

  await expect(page.getByTestId('release-pr-state-example/web-535')).toHaveText('merged');
  await expect(page.getByTestId('release-pr-owner-example/web-535')).toHaveText('@pr-owner-535');
  await expect(page.getByTestId('release-pr-base-example/web-535')).toHaveText('ops/development');
  await expect(page.getByTestId('release-pr-state-example/worker-451')).toHaveText('open');
  await expect(page.getByTestId('release-pr-base-example/worker-451')).toHaveText(
    'ops/development',
  );
  await expect(page.getByTestId('release-pr-state-example/api-88')).toHaveText('merged');
  await expect(page.getByTestId('release-pr-base-example/api-88')).toHaveText('ops/qa');
  await expect(
    page.locator('[data-testid^="release-pr-base-"][data-base-match="false"]'),
  ).toHaveCount(1);
  await expect(page.getByTestId('release-pr-base-example/api-88')).toHaveAttribute(
    'data-base-match',
    'false',
  );
});

test('view: Cards is the default, List is one row per ticket, and the choice lives in the URL', async ({
  page,
  dashboard,
}) => {
  await openReleases(page);
  await expect(page).toHaveURL(/#\/releases$/);
  await expect(page.getByTestId('releases-view-cards')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.release-ticket')).toHaveCount(6);
  await expect(page.locator('.release-row')).toHaveCount(0);
  const requests = releaseRequests(dashboard).length;

  await page.getByTestId('releases-view-list').click();
  await expect(page).toHaveURL(/#\/releases\?view=list$/);
  await expect(page.getByTestId('releases-view-list')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.release-row')).toHaveCount(6);
  await expect(page.locator('.release-ticket')).toHaveCount(0);
  await expect(page.getByTestId('release-row-DEMO-1398')).toHaveAttribute(
    'data-merge-state',
    'open',
  );
  await expect(page.getByTestId('release-row-prs-DEMO-1058')).toContainText('#');
  expect(releaseRequests(dashboard)).toHaveLength(requests);

  await page.reload();
  await expect(page.locator('.release-row').first()).toBeVisible();
  await expect(page.locator('.release-ticket')).toHaveCount(0);

  await page.goBack();
  await expect(page).toHaveURL(/#\/releases$/);
  await expect(page.locator('.release-ticket')).toHaveCount(6);

  await page.getByTestId('releases-view-list').click();
  await page.getByTestId('releases-view-cards').click();
  await expect(page).toHaveURL(/#\/releases$/);
  await expect(page.locator('.release-ticket')).toHaveCount(6);
});

test('view: any of mode, view, v or m set to list opens the list view directly', async ({
  page,
}) => {
  for (const key of ['mode', 'view', 'v', 'm']) {
    await page.goto(`/#/releases?${key}=list`);
    await expect(page.locator('.release-row')).toHaveCount(6);
    await expect(page.locator('.release-ticket')).toHaveCount(0);
  }
  await page.goto('/#/releases?view=cards');
  await expect(page.locator('.release-ticket')).toHaveCount(6);
  await expect(page.locator('.release-row')).toHaveCount(0);
});

test('scope: ticking All release tickets requests the whole release and shows more tickets', async ({
  page,
  dashboard,
}) => {
  await openReleases(page);
  await expect(page.locator('.release-ticket')).toHaveCount(6);
  await expect(page.getByTestId('release-ticket-DEMO-1500')).toHaveCount(0);

  await page.getByTestId('releases-scope').check();
  await expect(page.locator('.release-ticket')).toHaveCount(9);
  await expect(page.getByTestId('release-ticket-DEMO-1500')).toBeVisible();
  const requests = releaseRequests(dashboard);
  expect(requests).toHaveLength(2);
  expect(requests.filter(({ scope }) => scope === 'all')).toHaveLength(1);
  expect(requests[1].scope).toBe('all');
});

test('version: picking a release requests it, stores the choice and requests it first after a reload', async ({
  page,
  dashboard,
}) => {
  await openReleases(page);
  expect(await storedSelection(page), 'the default selection is never written').toBeNull();

  await page.getByTestId('releases-version').selectOption('18838');
  await expect(page.getByTestId('release-ticket-DEMO-2001')).toBeVisible();
  await expect(page.locator('.release-ticket')).toHaveCount(1);
  expect(releaseRequests(dashboard).at(-1).version).toBe('18838');
  expect(JSON.parse(await storedSelection(page))).toEqual({ version: 1, versionId: '18838' });

  dashboard.requests.length = 0;
  await page.reload();
  await expect(page.getByTestId('release-ticket-DEMO-2001')).toBeVisible();
  expect(releaseRequests(dashboard)[0].version).toBe('18838');
  await expect(page.getByTestId('releases-version')).toHaveValue('18838');
  await expect(page.getByTestId('releases-scope')).not.toBeChecked();
});

test('version: a stored id the server rejects is cleared and the load repeats once without it', async ({
  page,
  dashboard,
}) => {
  await seedStoredSelection(page, '{"version":1,"versionId":"99999"}');
  await page.goto('/#/releases');
  await expect(page.getByTestId('release-ticket-DEMO-1398')).toBeVisible();
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
    await expect(page.getByTestId('release-ticket-DEMO-3001')).toBeVisible();

    releaseSlowResponse();
    await page.waitForTimeout(500);
    await expect(picker).toHaveValue('18600');
    await expect(page.getByTestId('release-ticket-DEMO-3001')).toBeVisible();
    await expect(page.getByTestId('release-ticket-DEMO-2001')).toHaveCount(0);
    expect(JSON.parse(await storedSelection(page))).toEqual({ version: 1, versionId: '18600' });
  } finally {
    releaseSlowResponse();
  }
});

test('refresh: the Refresh button asks the server to bypass its cache', async ({
  page,
  dashboard,
}) => {
  await openReleases(page);
  expect(releaseRequests(dashboard)[0].refresh).toBeUndefined();

  await page.getByTestId('releases-refresh').click();
  await expect.poll(() => releaseRequests(dashboard).length).toBe(2);
  expect(releaseRequests(dashboard)[1].refresh).toBe('1');
  await expect(page.getByTestId('releases-refresh')).toBeEnabled();
  await expect(page.locator('.release-ticket')).toHaveCount(6);
});

test('refresh: a pending request marks the panel busy and disables repeated refreshes', async ({
  page,
}) => {
  await openReleases(page);
  let releaseResponse;
  const pendingResponse = new Promise((resolve) => {
    releaseResponse = resolve;
  });
  await page.route(API_WITH_QUERY, async (route) => {
    await pendingResponse;
    try {
      await route.fallback();
    } catch {
      /* page may have closed */
    }
  });
  try {
    await page.getByTestId('releases-refresh').click();
    await expect(page.getByTestId('panel-releases')).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByTestId('releases-refresh')).toBeDisabled();
  } finally {
    releaseResponse();
  }
  await expect(page.getByTestId('panel-releases')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByTestId('releases-refresh')).toBeEnabled();
});

test('refresh: a failed refresh keeps the cards and says it is showing the last update', async ({
  page,
}) => {
  await openReleases(page);
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
  await expect(page.locator('.release-ticket')).toHaveCount(6);
  await expect(page.getByTestId('release-ticket-DEMO-1398')).toBeVisible();
  await expect(page.getByTestId('releases-error')).toBeHidden();
});

test('unavailable: tickets whose PR lookup failed say so with a banner count while other cards stay', async ({
  page,
}) => {
  await openReleases(page);
  const unavailable = page.getByTestId('release-ticket-DEMO-1884');
  await expect(
    page.getByTestId('releases-group-unavailable').getByTestId('release-ticket-DEMO-1884'),
  ).toBeVisible();
  await expect(unavailable).toContainText('PRs unavailable');
  await expect(unavailable).not.toContainText('No linked PRs');

  const banner = page.getByTestId('releases-unavailable');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(/\b1 tickets?\b/);
  await expect(banner).toContainText('PRs unavailable');

  await expect(page.getByTestId('release-ticket-DEMO-1398')).not.toContainText('PRs unavailable');
  await expect(page.getByTestId('release-pr-state-example/api-2110')).toHaveText('open');
  await expect(page.getByTestId('release-ticket-DEMO-476')).toContainText('No linked PRs');
  await expect(page.getByTestId('release-ticket-DEMO-476')).not.toContainText('PRs unavailable');

  await page.getByTestId('releases-version').selectOption('18838');
  await expect(page.getByTestId('release-ticket-DEMO-2001')).toBeVisible();
  await expect(page.getByTestId('releases-unavailable')).toBeHidden();
});

test('unavailable: a failed PR lookup names its reason on the card and the banner keeps its retry advice', async ({
  page,
}) => {
  await openReleases(page);
  const note = page.getByTestId('release-ticket-DEMO-1884').locator('[data-error]');
  await expect(note).toHaveText('PRs unavailable (timeout)');
  await expect(note).toHaveAttribute('data-error', 'timeout');
  await expect(page.getByTestId('releases-unavailable')).toContainText('Use Refresh to retry.');
  await expect(page.getByTestId('release-ticket-DEMO-1398').locator('[data-error]')).toHaveCount(0);
});

test('unavailable: an instance mismatch drops the retry advice and points at the Jira GitHub integration', async ({
  page,
}) => {
  await openReleases(page);
  await page.getByTestId('releases-version').selectOption('18790');
  await expect(page.getByTestId('release-ticket-DEMO-4001')).toBeVisible();

  const banner = page.getByTestId('releases-unavailable');
  await expect(banner).toHaveText(
    'PR lookup returned nothing for tickets Jira says have PRs — check the Jira GitHub integration. Refresh will not fix this.',
  );
  await expect(banner).not.toContainText('Use Refresh to retry');
  const mismatch = page.getByTestId('release-ticket-DEMO-4001').locator('[data-error]');
  await expect(mismatch).toHaveText('PRs unavailable (instance-mismatch)');
  await expect(mismatch).toHaveAttribute('data-error', 'instance-mismatch');
  await expect(page.getByTestId('release-ticket-DEMO-4002').locator('[data-error]')).toHaveText(
    'PRs unavailable (timeout)',
  );
});

test('truncated: a release cut off by the ticket cap warns above its tickets and a complete one does not', async ({
  page,
}) => {
  await openReleases(page);
  await expect(page.getByTestId('releases-truncated')).toBeHidden();

  await page.getByTestId('releases-version').selectOption('18590');
  await expect(page.getByTestId('release-ticket-DEMO-5001')).toBeVisible();
  const warning = page.getByTestId('releases-truncated');
  await expect(warning).toBeVisible();
  await expect(warning).toHaveText(
    'Only the first 4 tickets are shown — totals may be incomplete.',
  );
  const warningBox = await warning.boundingBox();
  const firstCardBox = await page.locator('.release-ticket').first().boundingBox();
  expect(
    warningBox.y + warningBox.height,
    'the warning sits above the first card',
  ).toBeLessThanOrEqual(firstCardBox.y + 0.5);

  await page.getByTestId('releases-version').selectOption('18741');
  await expect(page.getByTestId('release-ticket-DEMO-1398')).toBeVisible();
  await expect(page.getByTestId('releases-truncated')).toBeHidden();
});

test('lag note: a loaded release says its merge state comes from Jira and can lag GitHub', async ({
  page,
}) => {
  await openReleases(page);
  const note = page.getByTestId('releases-lag-note');
  await expect(note).toBeVisible();
  await expect(note).toHaveText('Merge state comes from Jira and can lag GitHub by a few minutes.');

  await page.getByTestId('releases-version').selectOption('18838');
  await expect(page.getByTestId('release-ticket-DEMO-2001')).toBeVisible();
  await expect(page.getByTestId('releases-lag-note')).toBeVisible();
});

test('poll: an open releases tab makes no further request after ten minutes', async ({
  page,
  dashboard,
}) => {
  await page.clock.install();
  await page.goto('/#/releases');
  await expect(page.getByTestId('release-ticket-DEMO-1398')).toBeVisible();
  expect(releaseRequests(dashboard)).toHaveLength(1);

  await page.clock.runFor(10 * 60_000);
  await page.waitForTimeout(500);
  expect(releaseRequests(dashboard)).toHaveLength(1);
  await expect(page.getByTestId('release-ticket-DEMO-1398')).toBeVisible();
});

test('layout: ticket groups pack into 1, 2 and 3 columns with at least 20px between stacked cards', async ({
  page,
  dashboard,
}) => {
  const [template] = dashboard.data.releases.tickets['18741'].mine.filter(
    ({ mergeState }) => mergeState === 'open',
  );
  dashboard.data.releases.tickets['18741'].mine = Array.from({ length: 7 }, (_, index) => ({
    ...template,
    key: `DEMO-${1600 + index}`,
    summary: `Open change ${index + 1}`,
    prs: template.prs.map((pr, position) => ({ ...pr, number: 3000 + index * 10 + position })),
  }));
  await openReleases(page);
  await expect(page.locator('.release-ticket')).toHaveCount(7);
  await expect(page.locator('.release-ticket-groups')).toHaveCount(1);

  for (const [width, columns] of [
    [390, 1],
    [1024, 2],
    [1800, 3],
  ]) {
    await page.setViewportSize({ width, height: 1000 });
    const geometry = await page.locator('.release-ticket-groups').evaluate((container) => {
      const cards = [...container.querySelectorAll('.release-ticket')].map((card) => {
        const rect = card.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          bottom: rect.bottom,
          fragments: card.getClientRects().length,
          breakInside: getComputedStyle(card).breakInside,
        };
      });
      const gaps = cards.flatMap((card) => {
        const above = cards
          .filter((other) => Math.abs(other.x - card.x) < 1 && other.bottom <= card.y + 0.5)
          .sort((a, b) => b.bottom - a.bottom)[0];
        return above ? [card.y - above.bottom] : [];
      });
      const style = getComputedStyle(container);
      return { columnCount: style.columnCount, display: style.display, cards, gaps };
    });
    expect(geometry.columnCount, `columns at ${width}px`).toBe(String(columns));
    expect(geometry.display, `container display at ${width}px`).not.toMatch(/grid/);
    expect(geometry.cards, `cards at ${width}px`).toHaveLength(7);
    for (const card of geometry.cards) {
      expect(card.fragments, `a card stays whole at ${width}px`).toBe(1);
      expect(card.breakInside).toBe('avoid');
    }
    expect(geometry.gaps.length, `stacked pairs at ${width}px`).toBeGreaterThan(0);
    for (const gap of geometry.gaps)
      expect(gap, `gap between stacked cards at ${width}px`).toBeGreaterThanOrEqual(19.5);
  }
});

test('overflow: the six-tab nav and the releases panel fit a 390px viewport', async ({ page }) => {
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
  expect(fit.tabCount).toBe(6);
  expect(fit.tabsOutsideViewport).toEqual([]);
  expect(fit.content, 'the page must not scroll horizontally').toBeLessThanOrEqual(fit.width);
});
