import { test, expect, seedVelocitySnapshot } from './fixtures.js';

const STORAGE_KEY = 'dev-dashboard.work-filters';
const literal = '[fix].* <img> &';
const controls = (panel) => ({
  search: panel.getByRole('searchbox', { name: 'Search', exact: true }),
  select: (name) => panel.getByRole('combobox', { name, exact: true }),
  clear: panel.getByRole('button', { name: 'Clear filters', exact: true }),
});
const apiRequests = (dashboard) =>
  dashboard.requests.filter(({ path }) => path.startsWith('/api/'));

function populateFilters(data) {
  const [active, previous] = data.tickets.allSprints;
  const pr = (number, overrides = {}) => ({
    ...data.prs.prs[0],
    number,
    title: `${literal} change ${number}`,
    repo: 'example/api',
    tickets: [`DEMO-${number}`],
    ...overrides,
  });
  const changed = pr(101, { tickets: ['DEMO-101', 'DEMO-201'] });
  const approved = pr(102, {
    repo: 'example/web',
    reviews: { state: 'approved', approvers: ['reviewer'], changesRequesters: [], available: true },
  });
  const unknown = pr(103, { reviews: null });
  const awaiting = pr(104, {
    reviews: { state: null, approvers: [], changesRequesters: [], available: true },
  });
  const draft = pr(105, { draft: true });
  const teammate = pr(106, { owner: 'colleague', reviews: awaiting.reviews });
  const candidate = pr(107, { repo: 'example/web', reviews: approved.reviews });
  Object.assign(data.prs, {
    prsAvailable: true,
    total: 4,
    prs: [changed, approved, unknown, awaiting],
    groups: {
      'DEMO-101': [changed, approved],
      'DEMO-201': [changed],
      'DEMO-103': [unknown],
      'DEMO-104': [awaiting],
    },
    draftPrs: [draft],
    draftGroups: { 'DEMO-105': [draft] },
    prsNeedingApprovals: [teammate],
    approvalGroups: { 'DEMO-106': [teammate] },
    ticketStatuses: { 'DEMO-101': 'Code Review', 'DEMO-201': 'Ready For Testing' },
    ticketSprints: { 'DEMO-101': active, 'DEMO-201': previous },
    approvalTicketStatuses: { 'DEMO-106': 'Ready For Code Review' },
    uatPromoteAvailable: true,
    uatPromoteTotal: 1,
    uatPromoteGroups: {
      'DEMO-107': { ticket: { status: 'Promote to UAT', sprint: active }, prs: [candidate] },
    },
  });
  const queuePr = (item) => ({
    repo: item.repo,
    number: item.number,
    title: item.title,
    url: item.url,
    owner: item.owner,
    draft: !!item.draft,
    updatedAt: item.updatedAt,
    review: {
      complete: !!item.reviews?.available,
      state: item.reviews ? item.reviews.state || 'awaiting' : 'unknown',
      approvers: item.reviews?.approvers || [],
      changesRequesters: item.reviews?.changesRequesters || [],
      reviewDecision: null,
    },
  });
  const queueTicket = (key, items, sprint = active) => ({
    ...data.reviewTickets.tickets[0],
    key,
    summary: `${literal} change ${key.slice(5)}`,
    status: 'Ready For Code Review',
    sprint,
    sprints: [sprint],
    prs: items.map(queuePr),
  });
  data.reviewTickets = {
    ...data.reviewTickets,
    total: 8,
    prCoverage: {
      available: true,
      complete: true,
      repos: ['example/api', 'example/web'],
      reasons: [],
    },
    tickets: [
      queueTicket('DEMO-101', [changed, approved]),
      queueTicket('DEMO-201', [changed], previous),
      queueTicket('DEMO-103', [unknown]),
      queueTicket('DEMO-104', [awaiting]),
      queueTicket('DEMO-105', [draft]),
      queueTicket('DEMO-106', [teammate]),
      queueTicket('DEMO-107', [candidate]),
      queueTicket('DEMO-108', []),
    ],
  };
  const ticket = (key, overrides = {}) => ({
    ...data.tickets.tickets[0],
    key,
    summary: `${literal} ticket ${key}`,
    priority: 'High',
    issueType: 'Bug',
    sprints: [previous, active],
    sprint: active,
    ...overrides,
  });
  data.tickets.tickets = [
    ticket('DEMO-1'),
    ticket('DEMO-2', { priority: 'Low' }),
    ticket('DEMO-3', { issueType: 'Task', storyPoints: null }),
    ticket('DEMO-4', { status: 'To Do', statusCategory: 'To Do' }),
    ticket('DEMO-5', { status: 'Done', statusCategory: 'Done', storyPoints: 3 }),
  ];
  data.tickets.truncated = true;
}

async function expectNoFetches(dashboard, work) {
  const before = structuredClone(apiRequests(dashboard));
  await work();
  expect(apiRequests(dashboard), 'Local filtering must not send API requests').toEqual(before);
}

async function waitLoaded(page, view) {
  await expect(page.getByTestId(`${view}-refresh`)).toBeEnabled();
  await expect(page.getByTestId(`${view}-meta`)).not.toContainText(/loading|Refreshing/);
}

// Ticket readiness does not await the optional Slack list or its final session check.
function waitForSlackListing(page) {
  let threadsReceived = false;
  return page.waitForResponse((response) => {
    const path = new URL(response.url()).pathname;
    if (path === '/api/slack/threads') threadsReceived = true;
    return threadsReceived && path === '/api/slack/status';
  });
}

test('work toolbars combine local filters, keep counts and warnings honest, and persist each view safely', async ({
  page,
  dashboard,
  context,
}) => {
  test.setTimeout(120_000);
  populateFilters(dashboard.data);
  await page.clock.install();
  await page.goto('/#/prs');
  await waitLoaded(page, 'prs');
  const prs = page.getByTestId('panel-prs');
  const pr = controls(prs);
  const tickets = page.getByTestId('panel-my-tickets');
  const mine = controls(tickets);

  await test.step('PR controls combine AND criteria, distinguish unknown reviews and keep whole-ticket counts', async () => {
    await expect(pr.search).toBeVisible();
    for (const label of ['Repository', 'Review state'])
      await expect(pr.select(label)).toBeVisible();
    await expect(pr.select('Section')).toHaveCount(0);
    await expect(prs.getByTestId('prs-filter-count')).toHaveText('8 of 8');
    await expectNoFetches(dashboard, async () => {
      await pr.search.fill('[FIX].* <IMG> &');
      await pr.select('Repository').selectOption('example/api');
      await pr.select('Review state').selectOption('changes_requested');
      await expect(prs.getByTestId('prs-filter-count')).toHaveText('3 of 8');
      await expect(prs.getByTestId('prs-ticket-DEMO-101')).toContainText('change 101');
      await expect(prs.getByTestId('prs-ticket-DEMO-101')).toContainText('2 PRs');
      await expect(prs.getByTestId('prs-ticket-DEMO-201')).toContainText('change 201');
      await expect(prs.getByTestId('prs-pr-DEMO-101-example-web-102')).toBeVisible();
      await expect(
        prs.getByTestId('prs-column-reviewing').getByTestId('prs-ticket-DEMO-101'),
      ).toBeVisible();
      await expect(prs.getByTestId('prs-ticket-DEMO-105')).toContainText('Draft');
      await expect(prs.locator('img, script')).toHaveCount(0);
      await pr.select('Review state').selectOption('unknown');
      await expect(prs.getByTestId('prs-pr-DEMO-103-example-api-103')).toBeVisible();
      await expect(prs.getByTestId('prs-ticket-DEMO-104')).toHaveCount(0);
      await pr.select('Review state').selectOption('awaiting');
      await expect(prs.getByTestId('prs-pr-DEMO-104-example-api-104')).toBeVisible();
      await expect(prs.getByTestId('prs-ticket-DEMO-103')).toHaveCount(0);
      await pr.clear.click();
      for (const key of ['DEMO-105', 'DEMO-106', 'DEMO-107', 'DEMO-108']) {
        await pr.search.fill(key);
        await expect(prs.getByTestId(`prs-ticket-${key}`)).toBeVisible();
        await expect(prs.getByTestId('prs-filter-count')).toHaveText('1 of 8');
      }
      await pr.search.fill('^');
      await expect(prs.getByTestId('prs-no-matches')).toContainText('No matches');
      await expect(prs.getByTestId('prs-filter-count')).toHaveText('0 of 8');
      await pr.clear.click();
      await expect(prs.getByTestId('prs-filter-count')).toHaveText('8 of 8');
      await expect(prs.getByTestId('prs-ticket-DEMO-108')).toContainText('No linked open PRs');
      await pr.search.fill('change 105');
    });
    await prs.getByTestId('prs-diff-DEMO-105-example-api-105').click();
    await expect(page.getByRole('dialog', { name: 'Diff viewer', exact: true })).toBeVisible();
    await page.getByTestId('diff-close').click();
  });

  await test.step('ticket status, full sprint history, priority and type combine without changing remote scope', async () => {
    const slackLoaded = waitForSlackListing(page);
    await page.getByTestId('tab-my-tickets').click();
    await waitLoaded(page, 'my-tickets');
    await slackLoaded;
    await expect(mine.search).toBeVisible();
    await expect(tickets.getByTestId('my-tickets-filter-count')).toHaveText('4 of 4');
    await expectNoFetches(dashboard, async () => {
      await mine.search.fill('[FIX].* <IMG> &');
      for (const [label, value] of [
        ['Status', 'In Progress'],
        ['Sprint', '2'],
        ['Priority', 'High'],
        ['Type', 'Bug'],
      ]) {
        await mine.select(label).selectOption(value);
      }
      await expect(tickets.getByTestId('my-tickets-item-DEMO-1')).toBeVisible();
      await expect(tickets.getByTestId('my-tickets-item-DEMO-2')).toHaveCount(0);
      await expect(tickets.getByTestId('my-tickets-item-DEMO-3')).toHaveCount(0);
      await expect(tickets.getByTestId('my-tickets-item-DEMO-4')).toHaveCount(0);
      await expect(tickets.getByTestId('my-tickets-filter-count')).toHaveText('1 of 4');
      await expect(tickets.getByTestId('my-tickets-column-count-In-Progress')).toHaveText('1');
      await expect(tickets.getByTestId('my-tickets-truncated')).toContainText('incomplete');
      await mine.search.focus();
      await mine.search.fill('impossible');
      await expect(mine.search).toBeFocused();
      await expect(tickets.getByTestId('my-tickets-no-matches')).toContainText('No matches');
      await expect(tickets.getByTestId('my-tickets-filter-count')).toHaveText('0 of 4');
      await expect(tickets.getByTestId('my-tickets-empty')).toHaveCount(0);
      await expect(tickets.getByTestId('my-tickets-truncated')).toBeVisible();
      await mine.search.fill('[FIX].* <IMG> &');
    });
    let failedRoute;
    let arrived;
    const requestArrived = new Promise((resolve) => {
      arrived = resolve;
    });
    await page.route('**/api/my-tickets?includeDone=1', (route) => {
      failedRoute = route;
      arrived();
    });
    await tickets.getByTestId('my-tickets-include-done').check();
    await requestArrived;
    await failedRoute.fulfill({ status: 503, body: 'Unavailable' });
    await expect(tickets.getByTestId('my-tickets-meta')).toContainText('last update');
    await expect(tickets.getByTestId('my-tickets-include-done')).not.toBeChecked();
    await expect(mine.select('Sprint')).toHaveValue('2');
    await expect(tickets.getByTestId('my-tickets-item-DEMO-1')).toBeVisible();
    await mine.search.fill('DEMO-1');
    await expect(tickets.getByTestId('my-tickets-meta')).toContainText('last update');
    await page.unroute('**/api/my-tickets?includeDone=1');
    await tickets.getByTestId('my-tickets-include-done').check();
    await waitLoaded(page, 'my-tickets');
    await expect(tickets.getByTestId('my-tickets-filter-count')).toHaveText('1 of 5');
    await expect(tickets.getByTestId('my-tickets-include-done')).toBeChecked();
  });

  await test.step('refresh, tab switches and reload keep independent selections; missing options stay selected', async () => {
    await page.getByTestId('tab-prs').click();
    await expect(pr.search).toHaveValue('change 105');
    await expect(pr.select('Section')).toHaveCount(0);
    await pr.select('Repository').selectOption('example/api');
    const searchNode = await pr.search.elementHandle();
    await pr.search.focus();
    dashboard.data.reviewTickets.tickets.find((ticket) => ticket.key === 'DEMO-105').summary +=
      ' refreshed';
    await page.clock.fastForward(91_000);
    await expect(prs.getByTestId('prs-ticket-DEMO-105')).toContainText('refreshed');
    expect(await pr.search.evaluate((element, original) => element === original, searchNode)).toBe(
      true,
    );
    await expect(pr.search).toBeFocused();
    await page.route('**/api/review-tickets', (route) =>
      route.fulfill({ status: 502, body: 'Unavailable' }),
    );
    await prs.getByTestId('prs-refresh').click();
    await expect(prs.getByTestId('prs-meta')).toContainText('Refresh failed');
    await pr.search.fill('change 105');
    await expect(prs.getByTestId('prs-meta')).toContainText('Refresh failed');
    await expect(prs.getByTestId('prs-ticket-DEMO-105')).toBeVisible();
    await page.unroute('**/api/review-tickets');
    dashboard.data.reviewTickets.tickets = dashboard.data.reviewTickets.tickets.filter(
      (ticket) => ticket.key === 'DEMO-107',
    );
    dashboard.data.reviewTickets.total = 1;
    await prs.getByTestId('prs-refresh').click();
    await waitLoaded(page, 'prs');
    await expect(pr.select('Repository')).toHaveValue('example/api');
    await expect(pr.select('Repository').locator('option[value="example/api"]')).toHaveCount(1);
    await expect(prs.getByTestId('prs-no-matches')).toBeVisible();
    await page.reload();
    await waitLoaded(page, 'prs');
    await expect(pr.search).toHaveValue('change 105');
    await expect(pr.select('Section')).toHaveCount(0);
    await expect(pr.select('Repository')).toHaveValue('example/api');
    const slackLoaded = waitForSlackListing(page);
    await page.getByTestId('tab-my-tickets').click();
    await waitLoaded(page, 'my-tickets');
    await slackLoaded;
    await expect(mine.search).toHaveValue('DEMO-1');
    for (const [label, value] of [
      ['Status', 'In Progress'],
      ['Sprint', '2'],
      ['Priority', 'High'],
      ['Type', 'Bug'],
    ])
      await expect(mine.select(label)).toHaveValue(value);
    dashboard.data.tickets.tickets = dashboard.data.tickets.tickets.map((ticket) => ({
      ...ticket,
      priority: 'Low',
      sprints: [ticket.sprint],
    }));
    dashboard.data.tickets.allSprints = [dashboard.data.tickets.activeSprints[0]];
    const slackRefreshed = waitForSlackListing(page);
    await tickets.getByTestId('my-tickets-refresh').click();
    await waitLoaded(page, 'my-tickets');
    await slackRefreshed;
    await expect(mine.select('Sprint')).toHaveValue('2');
    await expect(mine.select('Priority')).toHaveValue('High');
    await expect(tickets.getByTestId('my-tickets-no-matches')).toBeVisible();
    await expectNoFetches(dashboard, async () => {
      await mine.clear.click();
      await expect(mine.search).toHaveValue('');
      for (const label of ['Status', 'Sprint', 'Priority', 'Type'])
        await expect(mine.select(label)).toHaveValue('');
      await expect(mine.select('Priority').locator('option[value="High"]')).toHaveCount(0);
      await expect(mine.select('Sprint').locator('option[value="2"]')).toHaveCount(0);
      await page.getByTestId('tab-prs').click();
      await expect(pr.search).toHaveValue('change 105');
      await pr.clear.click();
      await expect(pr.search).toHaveValue('');
      for (const label of ['Repository', 'Review state'])
        await expect(pr.select(label)).toHaveValue('');
      await expect(pr.select('Repository').locator('option[value="example/api"]')).toHaveCount(0);
    });
    await page.reload();
    await waitLoaded(page, 'prs');
    await expect(pr.search).toHaveValue('');
  });

  await test.step('versioned browser storage validates saved fields and falls back on malformed or unavailable storage', async () => {
    const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), STORAGE_KEY);
    expect(saved.version).toBe(1);
    expect(saved.views).toEqual(expect.any(Object));
    for (const value of [
      '{bad json',
      JSON.stringify({ version: 999, views: { prs: { search: 'hidden' } } }),
      JSON.stringify({
        version: 1,
        views: { prs: { search: {}, section: 'invalid', repo: [], review: 'invalid' } },
      }),
    ]) {
      await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
        key: STORAGE_KEY,
        value,
      });
      await page.reload();
      await waitLoaded(page, 'prs');
      await expect(pr.search).toHaveValue('');
      for (const label of ['Repository', 'Review state'])
        await expect(pr.select(label)).toHaveValue('');
    }
    await page.evaluate(
      (key) =>
        localStorage.setItem(
          key,
          JSON.stringify({
            version: 1,
            views: { prs: { search: '', section: 'draft', repo: '', review: '' } },
          }),
        ),
      STORAGE_KEY,
    );
    await page.reload();
    await waitLoaded(page, 'prs');
    await expect(pr.select('Section')).toHaveCount(0);
    await expect(prs.getByTestId('prs-filter-count')).toHaveText('1 of 1');
    await expect(prs.getByTestId('prs-ticket-DEMO-107')).toBeVisible();
    const blockedPage = await context.newPage();
    await blockedPage.addInitScript((key) => {
      const get = Storage.prototype.getItem;
      const set = Storage.prototype.setItem;
      Storage.prototype.getItem = function (name) {
        if (name === key) throw new DOMException('Unavailable', 'SecurityError');
        return get.call(this, name);
      };
      Storage.prototype.setItem = function (name, value) {
        if (name === key) throw new DOMException('Full', 'QuotaExceededError');
        return set.call(this, name, value);
      };
    }, STORAGE_KEY);
    const blockedSlackLoaded = waitForSlackListing(blockedPage);
    await blockedPage.goto('/#/my-tickets');
    await waitLoaded(blockedPage, 'my-tickets');
    await blockedSlackLoaded;
    const blocked = controls(blockedPage.getByTestId('panel-my-tickets'));
    await expectNoFetches(dashboard, async () => {
      await blocked.search.fill('DEMO-1');
      await expect(blockedPage.getByTestId('my-tickets-filter-count')).toHaveText('1 of 4');
      await blocked.clear.click();
      await expect(blockedPage.getByTestId('my-tickets-filter-count')).toHaveText('4 of 4');
    });
    await blockedPage.close();
  });

  await test.step('ticket keys, PR titles and shared PRs agree with whole-ticket counts', async () => {
    populateFilters(dashboard.data);
    dashboard.data.reviewTickets.tickets.find((ticket) => ticket.key === 'DEMO-106').summary =
      'Independent Jira summary for a linked PR';
    await prs.getByTestId('prs-refresh').click();
    await waitLoaded(page, 'prs');
    for (const [search, row] of [
      ['DEMO-201', 'prs-pr-DEMO-201-example-api-101'],
      ['DEMO-105', 'prs-pr-DEMO-105-example-api-105'],
      ['change 106', 'prs-pr-DEMO-106-example-api-106'],
    ]) {
      await pr.clear.click();
      await pr.search.fill(search);
      await expect.soft(prs.getByTestId('prs-filter-count')).toHaveText('1 of 8');
      await expect.soft(prs.getByTestId(row)).toBeVisible();
      await expect.soft(prs.getByTestId('prs-no-matches')).toBeHidden();
    }
    await pr.clear.click();
    await pr.select('Review state').selectOption('approved');
    await pr.search.fill('change 105');
    await expect.soft(prs.getByTestId('prs-filter-count')).toHaveText('0 of 8');
    await expect.soft(prs.getByTestId('prs-no-matches')).toBeVisible();
    dashboard.data.reviewTickets.tickets = dashboard.data.reviewTickets.tickets.filter(
      (ticket) => ticket.key === 'DEMO-108',
    );
    dashboard.data.reviewTickets.total = 1;
    await prs.getByTestId('prs-refresh').click();
    await waitLoaded(page, 'prs');
    await pr.search.fill('');
    await expect.soft(prs.getByTestId('prs-filter-count')).toHaveText('0 of 1');
    await expect.soft(prs.getByTestId('prs-no-matches')).toBeVisible();
  });

  await test.step('local edits preserve pending Include Done intent until success or failure', async () => {
    populateFilters(dashboard.data);
    await page.getByTestId('tab-my-tickets').click();
    await mine.clear.click();
    await tickets.getByTestId('my-tickets-refresh').click();
    await waitLoaded(page, 'my-tickets');
    const box = tickets.getByTestId('my-tickets-include-done');
    for (const fail of [false, true]) {
      let pendingRoute;
      let arrived;
      const requestArrived = new Promise((resolve) => {
        arrived = resolve;
      });
      await page.route('**/api/my-tickets?includeDone=1', (route) => {
        pendingRoute = route;
        arrived();
      });
      await box.check();
      await requestArrived;
      await expect(box).toBeDisabled();
      await mine.search.fill('DEMO-1');
      await expect.soft(box).toBeChecked();
      await mine.clear.click();
      await expect.soft(box).toBeChecked();
      if (fail) await pendingRoute.fulfill({ status: 503, body: 'Unavailable' });
      else
        await pendingRoute.fulfill({
          json: {
            ...dashboard.data.tickets,
            includeDone: true,
            total: 5,
            groupsByCategory: {
              'In Progress': dashboard.data.tickets.tickets.slice(0, 3),
              'To Do': [dashboard.data.tickets.tickets[3]],
              Done: [dashboard.data.tickets.tickets[4]],
            },
          },
        });
      await expect(box).toBeEnabled();
      await expect(box).toBeChecked({ checked: !fail });
      await page.unroute('**/api/my-tickets?includeDone=1');
      if (!fail) {
        await box.uncheck();
        await waitLoaded(page, 'my-tickets');
      }
    }
  });
});

test('ticket filters send no requests while the initial Slack session check is pending', async ({
  page,
  dashboard,
}) => {
  populateFilters(dashboard.data);
  await page.clock.install();
  let statusRequests = 0;
  let heldStatus;
  let arrived;
  const statusArrived = new Promise((resolve) => {
    arrived = resolve;
  });
  await page.route('**/api/slack/status', (route) => {
    statusRequests += 1;
    if (statusRequests !== 2) return route.fallback();
    heldStatus = route;
    arrived();
  });
  const slackLoaded = waitForSlackListing(page);
  const badgeLoaded = page.waitForResponse('**/api/slack/pending');
  const prsLoaded = page.waitForResponse('**/api/ticket-prs');
  await page.goto('/#/my-tickets');
  await waitLoaded(page, 'my-tickets');
  await Promise.all([statusArrived, badgeLoaded, prsLoaded]);

  const filters = controls(page.getByTestId('panel-my-tickets'));
  await expectNoFetches(dashboard, async () => {
    await filters.search.fill('DEMO-1');
    await expect(page.getByTestId('my-tickets-filter-count')).toHaveText('1 of 4');
    await filters.clear.click();
    await expect(page.getByTestId('my-tickets-filter-count')).toHaveText('4 of 4');
  });
  await heldStatus.fallback();
  await slackLoaded;
  expect(statusRequests).toBe(2);
});

test('Home Team filtering changes only chart scope and keeps shared work filters independent', async ({
  page,
  dashboard,
}) => {
  populateFilters(dashboard.data);
  await seedVelocitySnapshot(page, dashboard.data.teamVelocity);
  await page.clock.install();
  const slackLoaded = waitForSlackListing(page);
  const prsLoaded = page.waitForResponse('**/api/ticket-prs');
  await page.goto('/#/my-tickets');
  await waitLoaded(page, 'my-tickets');
  await Promise.all([slackLoaded, prsLoaded]);
  const mine = controls(page.getByTestId('panel-my-tickets'));
  await mine.search.fill('DEMO-1');
  const workFilters = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
  await page.getByTestId('tab-home').click();
  await expect(page.getByTestId('home-velocity-chart')).toContainText('Nexus Sprint 2');
  const snapshot = structuredClone(dashboard.data.teamVelocity);
  const select = page.getByTestId('home-velocity-team');
  await expectNoFetches(dashboard, async () => {
    await select.selectOption('Mobile');
    await expect(page.getByTestId('home-velocity-chart')).toContainText('Mobile Sprint 11');
    await expect(page.getByTestId('home-velocity-chart')).not.toContainText('Nexus Sprint');
  });
  expect(dashboard.data.teamVelocity).toEqual(snapshot);
  expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBe(workFilters);
  await page.getByTestId('tab-my-tickets').click();
  await expect(mine.search).toHaveValue('DEMO-1');
  await page.getByTestId('tab-home').click();
  await expect(select).toHaveValue('Mobile');
  await page.getByTestId('home-refresh').click();
  await waitLoaded(page, 'home');
  await expect(page.getByTestId('home-velocity-chart')).toContainText('Mobile Sprint 11');
  expect(dashboard.data.teamVelocity).toEqual(snapshot);
});
