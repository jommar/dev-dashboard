import { test, expect } from './fixtures.js';

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

  await test.step('PR controls combine AND criteria, distinguish unknown reviews and keep grouped counts', async () => {
    await expect(pr.search).toBeVisible();
    for (const label of ['Section', 'Repository', 'Review state'])
      await expect(pr.select(label)).toBeVisible();
    await expect(prs.getByTestId('prs-filter-count')).toHaveText('7 of 7');
    await expectNoFetches(dashboard, async () => {
      await pr.search.fill('[FIX].* <IMG> &');
      await pr.select('Section').selectOption('open');
      await pr.select('Repository').selectOption('example/api');
      await pr.select('Review state').selectOption('changes_requested');
      await expect(prs.getByTestId('prs-filter-count')).toHaveText('1 of 7');
      await expect(prs.getByTestId('pr-open-ticket-DEMO-101')).toContainText('change 101');
      await expect(prs.getByTestId('pr-open-group-count-DEMO-101')).toHaveText('1');
      await expect(prs.getByTestId('pr-open-ticket-DEMO-201')).toContainText('change 101');
      await expect(prs.getByTestId('pr-open-example/web-102')).toHaveCount(0);
      await expect(prs.getByTestId('pr-draft-example/api-105')).toHaveCount(0);
      await expect(prs.locator('img, script')).toHaveCount(0);
      await pr.select('Review state').selectOption('unknown');
      await expect(prs.getByTestId('pr-open-example/api-103')).toBeVisible();
      await expect(prs.getByTestId('pr-open-example/api-104')).toHaveCount(0);
      await pr.select('Review state').selectOption('awaiting');
      await expect(prs.getByTestId('pr-open-example/api-104')).toBeVisible();
      await expect(prs.getByTestId('pr-open-example/api-103')).toHaveCount(0);
      await pr.clear.click();
      for (const [section, row] of [
        ['draft', 'pr-draft-example/api-105'],
        ['approval', 'pr-approval-example/api-106'],
        ['uat', 'pr-uat-promote-example/web-107'],
      ]) {
        await pr.select('Section').selectOption(section);
        await expect(prs.getByTestId(row)).toBeVisible();
        await expect(prs.getByTestId('prs-filter-count')).toHaveText('1 of 7');
      }
      await pr.search.fill('^');
      await expect(prs.getByTestId('prs-no-matches')).toContainText('No matches');
      await expect(prs.getByTestId('prs-filter-count')).toHaveText('0 of 7');
      await pr.clear.click();
      await expect(prs.getByTestId('prs-filter-count')).toHaveText('7 of 7');
      await pr.search.fill('change 105');
      await pr.select('Section').selectOption('draft');
    });
    await prs.getByTestId('pr-draft-view-diff-example/api-105').click();
    await expect(page.getByRole('dialog', { name: 'Diff viewer', exact: true })).toBeVisible();
    await page.getByTestId('diff-close').click();
  });

  await test.step('ticket status, full sprint history, priority and type combine without changing remote scope', async () => {
    await page.getByTestId('tab-my-tickets').click();
    await waitLoaded(page, 'my-tickets');
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
      await expect(tickets.getByTestId('my-tickets-category-count-In-Progress')).toHaveText('1');
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
    await page.route('**/api/my-tickets?includeDone=1', (route) =>
      route.fulfill({ status: 503, body: 'Unavailable' }),
    );
    await tickets.getByTestId('my-tickets-include-done').check();
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
    await expect(pr.select('Section')).toHaveValue('draft');
    await pr.select('Repository').selectOption('example/api');
    const searchNode = await pr.search.elementHandle();
    await pr.search.focus();
    dashboard.data.prs.draftPrs[0].title += ' refreshed';
    await page.clock.fastForward(91_000);
    await expect(prs.getByTestId('pr-draft-example/api-105')).toContainText('refreshed');
    expect(await pr.search.evaluate((element, original) => element === original, searchNode)).toBe(
      true,
    );
    await expect(pr.search).toBeFocused();
    await page.route('**/api/prs', (route) => route.fulfill({ status: 502, body: 'Unavailable' }));
    await prs.getByTestId('prs-refresh').click();
    await expect(prs.getByTestId('prs-meta')).toContainText('Refresh failed');
    await pr.search.fill('change 105');
    await expect(prs.getByTestId('prs-meta')).toContainText('Refresh failed');
    await expect(prs.getByTestId('pr-draft-example/api-105')).toBeVisible();
    await page.unroute('**/api/prs');
    dashboard.data.prs.draftPrs = [];
    dashboard.data.prs.draftGroups = {};
    dashboard.data.prs.prs = [dashboard.data.prs.prs[1]];
    dashboard.data.prs.groups = { 'DEMO-102': dashboard.data.prs.prs };
    dashboard.data.prs.prsNeedingApprovals = [];
    dashboard.data.prs.approvalGroups = {};
    await prs.getByTestId('prs-refresh').click();
    await waitLoaded(page, 'prs');
    await expect(pr.select('Repository')).toHaveValue('example/api');
    await expect(pr.select('Repository').locator('option[value="example/api"]')).toHaveCount(1);
    await expect(prs.getByTestId('prs-no-matches')).toBeVisible();
    await page.reload();
    await waitLoaded(page, 'prs');
    await expect(pr.search).toHaveValue('change 105');
    await expect(pr.select('Section')).toHaveValue('draft');
    await expect(pr.select('Repository')).toHaveValue('example/api');
    await page.getByTestId('tab-my-tickets').click();
    await waitLoaded(page, 'my-tickets');
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
    await tickets.getByTestId('my-tickets-refresh').click();
    await waitLoaded(page, 'my-tickets');
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
      for (const label of ['Section', 'Repository', 'Review state'])
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
      for (const label of ['Section', 'Repository', 'Review state'])
        await expect(pr.select(label)).toHaveValue('');
    }
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
    await blockedPage.goto('/#/my-tickets');
    await waitLoaded(blockedPage, 'my-tickets');
    const blocked = controls(blockedPage.getByTestId('panel-my-tickets'));
    await expectNoFetches(dashboard, async () => {
      await blocked.search.fill('DEMO-1');
      await expect(blockedPage.getByTestId('my-tickets-filter-count')).toHaveText('1 of 4');
      await blocked.clear.click();
      await expect(blockedPage.getByTestId('my-tickets-filter-count')).toHaveText('4 of 4');
    });
    await blockedPage.close();
  });

  await test.step('JSON group context matches and overlapping drafts agree with rendered counts', async () => {
    populateFilters(dashboard.data);
    dashboard.data.prs.prs.push(dashboard.data.prs.draftPrs[0]);
    dashboard.data.prs.groups.Unticketed = dashboard.data.prs.draftPrs;
    dashboard.data.prs.draftGroups = { 'CONTEXT-DRAFT': dashboard.data.prs.draftPrs };
    dashboard.data.prs.approvalGroups = {
      'CONTEXT-APPROVAL': dashboard.data.prs.prsNeedingApprovals,
    };
    await prs.getByTestId('prs-refresh').click();
    await waitLoaded(page, 'prs');
    for (const [section, search, row] of [
      ['open', 'Ready For Testing', 'pr-open-example/api-101'],
      ['draft', 'CONTEXT-DRAFT', 'pr-draft-example/api-105'],
      ['approval', 'CONTEXT-APPROVAL', 'pr-approval-example/api-106'],
    ]) {
      await pr.clear.click();
      await pr.select('Section').selectOption(section);
      await pr.search.fill(search);
      await expect.soft(prs.getByTestId('prs-filter-count')).toHaveText('1 of 7');
      await expect.soft(prs.getByTestId(row)).toBeVisible();
      await expect.soft(prs.getByTestId('prs-no-matches')).toBeHidden();
    }
    await pr.clear.click();
    await pr.select('Section').selectOption('open');
    await pr.search.fill('change 105');
    await expect.soft(prs.getByTestId('prs-filter-count')).toHaveText('0 of 7');
    await expect.soft(prs.getByTestId('prs-no-matches')).toBeVisible();
    dashboard.data.prs.prs = dashboard.data.prs.draftPrs;
    dashboard.data.prs.groups = { Unticketed: dashboard.data.prs.draftPrs };
    dashboard.data.prs.prsNeedingApprovals = [];
    dashboard.data.prs.approvalGroups = {};
    dashboard.data.prs.uatPromoteGroups = {};
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

test('Home filters the full Needs You queue before twelve rows and only filters Sprint drilldowns, preserving aggregates', async ({
  page,
  dashboard,
}) => {
  test.setTimeout(60_000);
  populateFilters(dashboard.data);
  const template = dashboard.data.prs.prs[0];
  const crowded = Array.from({ length: 13 }, (_, index) => ({
    ...template,
    number: 200 + index,
    title: `Urgent change ${index}`,
    tickets: [],
  }));
  dashboard.data.prs.prs = crowded;
  dashboard.data.prs.groups = { Unticketed: crowded };
  dashboard.data.prs.total = 13;
  await page.clock.install();
  await page.goto('/#/home');
  await waitLoaded(page, 'home');
  const queue = page.getByTestId('home-actions-block');
  const action = controls(queue);
  const sprint = page.getByTestId('home-sprint-block');
  const drilldown = controls(sprint);
  const card = page.getByTestId('home-sprint-Workspace-Sprint');
  const aggregateSnapshot = async () => ({
    kpis: await page.getByTestId('home-kpi-row').textContent(),
    history: await page.getByTestId('home-velocity').innerHTML(),
    total: await card.getByTestId('home-sprint-Workspace-Sprint-total').textContent(),
    legend: await card.locator('[data-band]').allTextContents(),
    widths: await card
      .locator('.sprint-band')
      .evaluateAll((elements) => elements.map((element) => element.style.width)),
    unestimated: await card.getByTestId('home-sprint-Workspace-Sprint-unestimated').textContent(),
  });
  await expect(page.getByTestId('kpi-value-my-prs')).toHaveText('13');
  await expect(page.getByTestId('kpi-value-sprint-tickets')).toHaveText('5');
  await expect(page.getByTestId('kpi-value-sprint-done')).toHaveText('1');
  await expect(card.getByTestId('home-sprint-Workspace-Sprint-total')).toHaveText(
    '3 of 18 pts · 5 tickets',
  );
  const before = await aggregateSnapshot();

  await test.step('lower-priority actions survive filtering before cap and count all matching rows', async () => {
    await expect(queue.locator('.pr-item, .action-ticket')).toHaveCount(12);
    await expect(page.getByTestId('home-action-ticket-DEMO-1')).toHaveCount(0);
    await expectNoFetches(dashboard, async () => {
      await expect(action.search).toBeVisible();
      await action.select('Action type').selectOption('in-progress');
      await expect(queue.locator('.action-ticket')).toHaveCount(3);
      await expect(queue.getByTestId('home-actions-filter-count')).toHaveText('3 of 17');
      await expect(page.getByTestId('home-actions-more')).toHaveCount(0);
      await action.search.fill('[FIX].* <IMG> &');
      await expect(queue.locator('.action-ticket')).toHaveCount(3);
      await action.search.fill('DEMO-1');
      await expect(page.getByTestId('home-action-ticket-DEMO-1')).toBeVisible();
      await expect(queue.locator('.action-ticket')).toHaveCount(1);
      await expect(queue.getByTestId('home-actions-filter-count')).toHaveText('1 of 17');
      await action.search.fill('^');
      await expect(queue.getByTestId('home-actions-no-matches')).toContainText('No matches');
      await expect(page.getByTestId('home-actions-empty')).toHaveCount(0);
      await action.clear.click();
      await action.select('Action type').selectOption('changes-requested');
      await expect(queue.locator('.pr-item')).toHaveCount(12);
      await expect(page.getByTestId('home-actions-more')).toHaveText('1 more not shown');
      await expect(queue.getByTestId('home-actions-filter-count')).toHaveText('13 of 17');
      await action.select('Action type').selectOption('in-progress');
      await action.search.fill('DEMO-1');
    });
    expect(await aggregateSnapshot()).toEqual(before);
  });

  await test.step('Sprint search and status affect only expanded rows and leave counts, points and history intact', async () => {
    await card.getByTestId('home-sprint-Workspace-Sprint-count-active').click();
    const rows = page.getByTestId('sprint-1-list-active');
    await expect(rows.locator('.my-ticket')).toHaveCount(3);
    await expectNoFetches(dashboard, async () => {
      await drilldown.search.fill('[FIX].* <IMG> &');
      await drilldown.select('Status').selectOption('In Progress');
      await expect(rows.locator('.my-ticket')).toHaveCount(3);
      await drilldown.search.fill('DEMO-1');
      await expect(rows.getByTestId('sprint-1-list-active-item-DEMO-1')).toBeVisible();
      await expect(rows.locator('.my-ticket')).toHaveCount(1);
      await expect(sprint.getByTestId('home-sprint-filter-count')).toHaveText('1 of 5');
      await drilldown.search.fill('^');
      await expect(sprint.getByTestId('home-sprint-no-matches')).toContainText('No matches');
      await expect(sprint.locator('.my-ticket')).toHaveCount(0);
      await expect(page.getByTestId('home-sprint-truncated')).toBeVisible();
      await drilldown.search.fill('DEMO-1');
    });
    expect(await aggregateSnapshot()).toEqual(before);
    await page.getByTestId('home-refresh').click();
    await waitLoaded(page, 'home');
    await expect(action.search).toHaveValue('DEMO-1');
    await expect(drilldown.search).toHaveValue('DEMO-1');
    await page.route('**/api/prs', (route) => route.fulfill({ status: 502, body: 'Unavailable' }));
    await page.getByTestId('home-refresh').click();
    await expect(page.getByTestId('home-meta')).toContainText('GitHub stale');
    await expectNoFetches(dashboard, async () => {
      await action.search.fill('impossible');
      await expect(page.getByTestId('home-meta')).toContainText('GitHub stale');
      await action.search.fill('DEMO-1');
      await expect(page.getByTestId('home-action-ticket-DEMO-1')).toBeVisible();
    });
    await page.unroute('**/api/prs');
    await page.getByTestId('tab-services').click();
    await page.getByTestId('tab-home').click();
    await expect(action.select('Action type')).toHaveValue('in-progress');
    await expect(drilldown.select('Status')).toHaveValue('In Progress');
    await page.reload();
    await waitLoaded(page, 'home');
    await expect(action.search).toHaveValue('DEMO-1');
    await expect(action.select('Action type')).toHaveValue('in-progress');
    await expect(drilldown.search).toHaveValue('DEMO-1');
    await expect(drilldown.select('Status')).toHaveValue('In Progress');
    expect(await aggregateSnapshot()).toEqual(before);
    await expectNoFetches(dashboard, async () => {
      await action.clear.click();
      await expect(action.search).toHaveValue('');
      await expect(action.select('Action type')).toHaveValue('');
      await expect(drilldown.search).toHaveValue('DEMO-1');
      await drilldown.clear.click();
      await expect(drilldown.search).toHaveValue('');
      await expect(drilldown.select('Status')).toHaveValue('');
    });
    expect(await aggregateSnapshot()).toEqual(before);
  });

  await test.step('Home clears stale counts and options when rows or integrations disappear', async () => {
    await action.select('Action type').selectOption('in-progress');
    await drilldown.select('Status').selectOption('In Progress');
    dashboard.data.tickets = { tickets: [], activeSprints: [], allSprints: [], truncated: false };
    await page.getByTestId('home-refresh').click();
    await waitLoaded(page, 'home');
    await expect.soft(sprint.getByTestId('home-sprint-filter-count')).toHaveText('0 of 0');
    await expect.soft(drilldown.select('Status')).toHaveValue('In Progress');
    await expect.soft(drilldown.select('Status').locator('option[value="Done"]')).toHaveCount(0);
    await drilldown.clear.click();
    await expect
      .soft(drilldown.select('Status').locator('option[value="In Progress"]'))
      .toHaveCount(0);
    await page.route('**/api/prs', (route) => route.fulfill({ status: 401, body: 'Unconfigured' }));
    await page.route('**/api/my-tickets?includeDone=1', (route) =>
      route.fulfill({ status: 401, body: 'Unconfigured' }),
    );
    await page.getByTestId('home-refresh').click();
    await waitLoaded(page, 'home');
    await expect.soft(queue.getByTestId('home-actions-filter-count')).toHaveText('0 of 0');
    await expect.soft(sprint.getByTestId('home-sprint-filter-count')).toHaveText('0 of 0');
    await expect.soft(action.select('Action type')).toHaveValue('in-progress');
    await action.clear.click();
    await expect.soft(action.select('Action type').locator('option')).toHaveCount(1);
  });
});
