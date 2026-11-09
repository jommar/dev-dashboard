import { test, expect } from './fixtures.js';
import { ticketBoardData } from './data.js';

const queueReads = (dashboard) =>
  dashboard.requests.filter(({ path }) => path === '/api/review-tickets');
const ticket = (page, key = 'DEMO-1') => page.getByTestId(`prs-ticket-${key}`);
const lane = (page, id) => page.getByTestId(`prs-column-${id}`);
const search = (page) =>
  page.getByTestId('panel-prs').getByRole('searchbox', { name: 'Search', exact: true });
const review = (state = 'approved') => ({
  complete: state !== 'unknown',
  state,
  approvers: state === 'approved' ? ['third-party'] : [],
  changesRequesters: state === 'changes_requested' ? ['reviewer'] : [],
  reviewDecision: null,
});

function mixedQueue(data) {
  const [first, second, empty] = data.reviewTickets.tickets;
  const frontend = { ...first.prs[0], repo: 'example/frontend', review: review() };
  const backend = {
    ...frontend,
    repo: 'example/backend',
    title: 'Backend counterpart',
    review: review('awaiting'),
  };
  Object.assign(data.reviewTickets, {
    total: 3,
    tickets: [
      { ...first, summary: 'Synthetic mixed review ticket', prs: [frontend, backend] },
      { ...second, prs: [{ ...second.prs[0], review: review() }] },
      empty,
    ],
    prCoverage: {
      available: true,
      complete: true,
      repos: ['example/frontend', 'example/backend', 'example/workspace'],
      reasons: [],
    },
  });
}

function prefixQueue(data) {
  mixedQueue(data);
  const [mixed, approved, empty] = data.reviewTickets.tickets;
  data.reviewTickets.tickets = [
    {
      ...approved,
      key: 'ALPHAX-2',
      prs: [{ ...approved.prs[0], title: 'ALPHA-999 unrelated title key' }],
    },
    { ...empty, key: 'BETA-3' },
    {
      ...mixed,
      key: 'ALPHA-1',
      prs: [{ ...mixed.prs[0], title: 'GAMMA-99 frontend change' }, mixed.prs[1]],
    },
    { ...empty, key: 'ALPHA-4' },
  ];
  data.reviewTickets.total = data.reviewTickets.tickets.length;
}

async function expectLaneHelp(page, heading, clauses) {
  await expect(heading).toHaveAttribute('aria-describedby', /\S+/);
  const tooltipId = await heading.getAttribute('aria-describedby');
  const tooltip = page.getByRole('tooltip').and(page.locator(`[id=${JSON.stringify(tooltipId)}]`));
  await expect(tooltip).toBeVisible();
  for (const clause of clauses) await expect(tooltip).toContainText(clause);
  await expect(heading).toHaveAccessibleDescription(await tooltip.innerText());
  return tooltip;
}

test('filters select whole tickets, keep every repo/PR and original lane, count tickets and ignore saved Section', async ({
  page,
  dashboard,
}) => {
  mixedQueue(dashboard.data);
  await page.addInitScript(() =>
    localStorage.setItem(
      'dev-dashboard.work-filters',
      JSON.stringify({ version: 1, views: { prs: { section: 'draft' } } }),
    ),
  );
  await page.goto('/#/prs');
  const panel = page.getByTestId('panel-prs');
  await expect(panel.getByTestId('prs-filter-count')).toHaveText('3 of 3');
  await expect(panel.getByRole('combobox', { name: 'Section', exact: true })).toHaveCount(0);
  await expect(lane(page, 'reviewing').getByTestId('prs-ticket-DEMO-1')).toBeVisible();
  await expect(ticket(page, 'DEMO-3')).toContainText('No linked open PRs');
  const before = queueReads(dashboard).length;
  await panel
    .getByRole('combobox', { name: 'Repository', exact: true })
    .selectOption('example/frontend');
  await panel.getByRole('combobox', { name: 'Review state', exact: true }).selectOption('approved');
  await expect(panel.getByTestId('prs-filter-count')).toHaveText('1 of 3');
  await expect(lane(page, 'reviewing').getByTestId('prs-ticket-DEMO-1')).toBeVisible();
  await expect(ticket(page).getByTestId('prs-pr-DEMO-1-example-frontend-17')).toBeVisible();
  await expect(ticket(page).getByTestId('prs-pr-DEMO-1-example-backend-17')).toBeVisible();
  await expect(ticket(page).locator('.board-card-stat')).toHaveText('2 PRs');
  await search(page).fill('Backend counterpart');
  await expect(panel.getByTestId('prs-filter-count')).toHaveText('1 of 3');
  await panel.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(panel.getByTestId('prs-filter-count')).toHaveText('3 of 3');
  await expect(ticket(page, 'DEMO-3')).toBeVisible();
  expect(queueReads(dashboard)).toHaveLength(before);
});

test('polling moves automatically both directions and preserves column scroll, filter focus and remounted actions', async ({
  page,
  dashboard,
}) => {
  mixedQueue(dashboard.data);
  const first = dashboard.data.reviewTickets.tickets[0];
  first.prs = [first.prs[0]];
  const empty = dashboard.data.reviewTickets.tickets[2];
  dashboard.data.reviewTickets.tickets.push(
    ...Array.from({ length: 25 }, (_, index) => ({
      ...empty,
      key: `DEMO-${index + 100}`,
      summary: `Long queue card ${index}`,
    })),
  );
  dashboard.data.reviewTickets.total = dashboard.data.reviewTickets.tickets.length;
  await page.clock.install();
  await page.goto('/#/prs');
  await expect(lane(page, 'reviewed').getByTestId('prs-ticket-DEMO-1')).toBeVisible();
  const body = page.getByTestId('prs-column-body-to-review');
  const scroll = await body.evaluate((element) => {
    element.scrollTop = 220;
    return element.scrollTop;
  });
  expect(scroll).toBeGreaterThan(0);
  const originalSearch = await search(page).elementHandle();
  await search(page).focus();
  first.prs.push({ ...first.prs[0], repo: 'example/backend', review: review('awaiting') });
  await page.clock.fastForward(91_000);
  await expect(lane(page, 'reviewing').getByTestId('prs-ticket-DEMO-1')).toBeVisible();
  expect(await body.evaluate((element) => element.scrollTop)).toBe(scroll);
  expect(
    await search(page).evaluate((element, original) => element === original, originalSearch),
  ).toBe(true);
  await expect(search(page)).toBeFocused();
  const action = page.getByTestId('prs-claude-icon-DEMO-1');
  await action.focus();
  first.prs[1].review = review();
  await page.clock.fastForward(91_000);
  await expect(lane(page, 'reviewed').getByTestId('prs-ticket-DEMO-1')).toBeVisible();
  await expect(action).toBeFocused();
  await action.click();
  const dialog = page.getByTestId('prs-claude-dialog');
  const originalDialog = await dialog.elementHandle();
  first.prs[1].review = review('changes_requested');
  await page.clock.fastForward(91_000);
  await expect(lane(page, 'reviewing').getByTestId('prs-ticket-DEMO-1')).toBeVisible();
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((element, original) => element === original, originalDialog)).toBe(
    true,
  );
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(lane(page, 'reviewing').getByTestId('prs-ticket-DEMO-1')).toBeVisible();
  expect(dashboard.requests.filter(({ method }) => method !== 'GET')).toEqual([]);
});

test('placeholder is empty, native, scoped, safe and closes by Close, Escape and true backdrop without Claude calls', async ({
  page,
  dashboard,
}) => {
  const first = dashboard.data.reviewTickets.tickets[0];
  first.summary = 'Literal <img src=x onerror=alert(1)> & placeholder';
  dashboard.data.tickets.tickets[0].key = first.key;
  await page.goto('/#/my-tickets');
  await expect(page.getByTestId('claude-icon-DEMO-1')).toBeVisible();
  await page.getByTestId('tab-prs').click();
  await expect(ticket(page)).toBeVisible();
  const requestsBefore = dashboard.requests.filter(({ path }) =>
    path.startsWith('/api/claude/'),
  ).length;
  const opener = page.getByTestId('prs-claude-icon-DEMO-1');
  const dialog = page.getByTestId('prs-claude-dialog');
  for (const close of ['Close', 'Escape', 'backdrop']) {
    await opener.click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAccessibleName(`DEMO-1 ${first.summary}`);
    await expect(page.getByTestId('prs-claude-dialog-body')).toBeEmpty();
    await expect(dialog.getByRole('button')).toHaveCount(1);
    await expect(dialog.locator('input, textarea, form, img, script')).toHaveCount(0);
    expect(await dialog.evaluate((element) => element.open && element.matches(':modal'))).toBe(
      true,
    );
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    if (close === 'Close') await page.getByTestId('prs-claude-dialog-close').click();
    else if (close === 'Escape') await page.keyboard.press('Escape');
    else {
      const box = await page.getByTestId('prs-claude-dialog-title').boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(2, 2);
      await page.mouse.up();
      await expect(dialog).toBeVisible();
      await page.mouse.click(2, 2);
    }
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
  }
  expect(dashboard.requests.filter(({ path }) => path.startsWith('/api/claude/'))).toHaveLength(
    requestsBefore,
  );
  expect(dashboard.requests.filter(({ method }) => method !== 'GET')).toEqual([]);
});

test('placeholder survives filtered-out cards but closes on eligibility removal and tab departure', async ({
  page,
  dashboard,
}) => {
  await page.clock.install();
  await page.goto('/#/prs');
  await search(page).fill('Improve keyboard');
  await page.getByTestId('prs-claude-icon-DEMO-1').click();
  dashboard.data.reviewTickets.tickets[0].summary = 'No longer matches the filter';
  dashboard.data.reviewTickets.tickets[0].prs[0].title = 'No longer matches the filter';
  await page.clock.fastForward(91_000);
  await expect(ticket(page)).toHaveCount(0);
  await expect(page.getByTestId('prs-claude-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('prs-board')).toBeFocused();
  await search(page).fill('');
  await page.getByTestId('prs-claude-icon-DEMO-1').click();
  dashboard.data.reviewTickets.tickets = dashboard.data.reviewTickets.tickets.slice(1);
  dashboard.data.reviewTickets.total = 2;
  await page.clock.fastForward(91_000);
  await expect(page.getByTestId('prs-claude-dialog')).toHaveCount(0);
  await page.getByTestId('prs-claude-icon-DEMO-2').click();
  await page.evaluate(() => {
    location.hash = '#/services';
  });
  await expect(page.getByTestId('panel-services')).toBeVisible();
  await expect(page.getByTestId('prs-claude-dialog')).toHaveCount(0);
});

test('states distinguish first loading/error, recovery, empty queue and no filter matches', async ({
  page,
  dashboard,
}) => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  let first = true;
  await page.route('**/api/review-tickets', async (route) => {
    if (!first) return route.fallback();
    first = false;
    await pending;
    await route.fulfill({ status: 503, json: { error: 'Synthetic Jira failure' } });
  });
  await page.goto('/#/prs');
  await expect(page.getByTestId('prs-loading')).toBeVisible();
  release();
  await expect(page.getByTestId('prs-error')).toContainText('Synthetic Jira failure');
  await expect(page.getByTestId('prs-loading')).toHaveCount(0);
  await page.getByTestId('prs-refresh').click();
  await expect(ticket(page)).toBeVisible();
  await search(page).fill('no matching ticket');
  await expect(page.getByTestId('prs-no-matches')).toBeVisible();
  await expect(page.getByTestId('prs-empty')).toHaveCount(0);
  await expect(page.getByTestId('prs-board')).toBeVisible();
  dashboard.data.reviewTickets = { ...dashboard.data.reviewTickets, total: 0, tickets: [] };
  await page.getByTestId('prs-refresh').click();
  await expect(page.getByTestId('prs-empty')).toBeVisible();
  await expect(page.getByTestId('prs-no-matches')).toHaveCount(0);
});

test('states retain stale Jira data honestly, keep GitHub-only uncertainty and guard refresh overlap/countdown', async ({
  page,
  dashboard,
}) => {
  await page.clock.install();
  await page.goto('/#/prs');
  await expect(ticket(page)).toBeVisible();
  await page.clock.fastForward(5_000);
  let held;
  let requests = 0;
  await page.route('**/api/review-tickets', (route) => {
    requests += 1;
    held = route;
  });
  await page.getByTestId('prs-refresh').click();
  await expect.poll(() => requests).toBe(1);
  await expect(page.getByTestId('prs-refresh')).toBeDisabled();
  await page.getByTestId('prs-refresh').dispatchEvent('click');
  expect(requests).toBe(1);
  await held.fulfill({ status: 503, json: { error: 'Synthetic later Jira failure' } });
  await expect(page.getByTestId('prs-stale')).toContainText('last successful update');
  await expect(ticket(page)).toBeVisible();
  await expect(page.getByTestId('prs-next')).toContainText('90');
  await page.unroute('**/api/review-tickets');
  mixedQueue(dashboard.data);
  dashboard.data.reviewTickets.prCoverage = {
    available: false,
    complete: false,
    repos: ['example/frontend', 'example/backend'],
    reasons: ['github_unavailable'],
  };
  await page.getByTestId('prs-refresh').click();
  await expect(page.getByTestId('prs-coverage')).toContainText('incomplete');
  await expect(page.getByTestId('prs-stale')).toHaveCount(0);
  for (const key of ['DEMO-1', 'DEMO-2', 'DEMO-3'])
    await expect(lane(page, 'to-review').getByTestId(`prs-ticket-${key}`)).toBeVisible();
  await expect(ticket(page, 'DEMO-3')).not.toContainText('No linked open PRs');
  await expect(page.getByTestId('prs-ticket-warning-DEMO-3')).toContainText('unknown');
  await expect(ticket(page).getByTestId('prs-pr-DEMO-1-example-frontend-17')).toBeVisible();
});

for (const width of [390, 1024, 1440]) {
  test(`layout shares board geometry, fixed headers and viewport containment at ${width}`, async ({
    page,
    dashboard,
  }) => {
    mixedQueue(dashboard.data);
    const empty = dashboard.data.reviewTickets.tickets[2];
    dashboard.data.reviewTickets.tickets.push(
      ...Array.from({ length: 24 }, (_, index) => ({
        ...empty,
        key: `DEMO-${index + 100}`,
        summary: 'Long literal summary '.repeat(15),
      })),
    );
    dashboard.data.reviewTickets.total = dashboard.data.reviewTickets.tickets.length;
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/#/prs');
    await expect(ticket(page)).toBeAttached();
    const geometry = await page.getByTestId('panel-prs').evaluate((panel) => {
      const track = panel.querySelector('.board-track');
      const column = panel.querySelector('.board-column');
      const body = panel.querySelector('.board-column-body');
      const header = panel.querySelector('.board-column-head');
      const headerBefore = header.getBoundingClientRect().y;
      body.scrollTop = 200;
      return {
        direct: panel.firstElementChild.classList.contains('board-section'),
        width: column.getBoundingClientRect().width,
        trackOverflow: getComputedStyle(track).overflowX,
        snap: getComputedStyle(track).scrollSnapType,
        bodyOverflow: getComputedStyle(body).overflowY,
        scrollTop: body.scrollTop,
        headerBefore,
        headerAfter: header.getBoundingClientRect().y,
        pageHeight: document.documentElement.scrollHeight,
        pageWidth: document.documentElement.scrollWidth,
        cardFont: getComputedStyle(panel.querySelector('.board-card-summary')).fontSize,
        columnCount: panel.querySelectorAll('.board-column').length,
      };
    });
    expect(geometry.direct).toBe(true);
    expect(geometry.width).toBeCloseTo(width <= 599 ? width * 0.82 : 280, 0);
    expect(geometry.columnCount).toBe(3);
    expect(geometry.trackOverflow).toBe('auto');
    expect(geometry.bodyOverflow).toBe('auto');
    if (width <= 599) expect(geometry.snap).toBe('x mandatory');
    else expect(['x', 'x proximity']).toContain(geometry.snap);
    expect(geometry.scrollTop).toBeGreaterThan(0);
    expect(geometry.headerAfter).toBe(geometry.headerBefore);
    expect(geometry.pageHeight).toBeLessThanOrEqual(901);
    expect(geometry.pageWidth).toBeLessThanOrEqual(width);
    await page.getByTestId('tab-my-tickets').click();
    await expect(page.getByTestId('my-tickets-board')).toBeAttached();
    const referenceFont = await page
      .getByTestId('my-tickets-board')
      .locator('.board-card-summary')
      .first()
      .evaluate((element) => getComputedStyle(element).fontSize);
    expect(geometry.cardFont).toBe(referenceFont);
  });
}

test('ticket prefix derives sorted unique fetched-key options and combines filters without moving or splitting tickets', async ({
  page,
  dashboard,
}) => {
  prefixQueue(dashboard.data);
  await page.goto('/#/prs');
  const panel = page.getByTestId('panel-prs');
  const prefix = panel.getByLabel('Ticket prefix', { exact: true });
  const repo = panel.getByLabel('Repository', { exact: true });
  const state = panel.getByLabel('Review state', { exact: true });
  const count = panel.getByTestId('prs-filter-count');
  await expect(prefix).toBeVisible();
  await expect(prefix).toHaveValue('');
  await expect(prefix.locator('option')).toHaveText(['All', 'ALPHA', 'ALPHAX', 'BETA']);
  expect(
    await panel
      .locator('select')
      .evaluateAll((fields) => fields.map((field) => field.dataset.filter)),
  ).toEqual(['prefix', 'repo', 'review']);
  await expect(count).toHaveText('4 of 4');
  const before = queueReads(dashboard).length;
  await prefix.selectOption('ALPHA');
  await expect(count).toHaveText('2 of 4');
  await expect(ticket(page, 'ALPHAX-2')).toHaveCount(0);
  await expect(ticket(page, 'ALPHA-4')).toContainText('No linked open PRs');
  await repo.selectOption('example/frontend');
  await state.selectOption('approved');
  await search(page).fill('Backend counterpart');
  await expect(count).toHaveText('1 of 4');
  await expect(lane(page, 'reviewing').getByTestId('prs-ticket-ALPHA-1')).toBeVisible();
  for (const repoSlug of ['frontend', 'backend']) {
    await expect(
      ticket(page, 'ALPHA-1').getByTestId(`prs-pr-ALPHA-1-example-${repoSlug}-17`),
    ).toBeVisible();
  }
  await expect(ticket(page, 'ALPHA-1').locator('.board-card-stat')).toHaveText('2 PRs');
  for (const [id, expected] of [
    ['to-review', '0'],
    ['reviewing', '1'],
    ['reviewed', '0'],
  ]) {
    await expect(page.getByTestId(`prs-column-count-${id}`)).toHaveText(expected);
  }
  await expect(prefix.locator('option')).toHaveText(['All', 'ALPHA', 'ALPHAX', 'BETA']);
  await prefix.selectOption('BETA');
  await expect(count).toHaveText('0 of 4');
  await expect(page.getByTestId('prs-no-matches')).toBeVisible();
  await panel.getByRole('button', { name: 'Clear filters', exact: true }).click();
  for (const field of [prefix, repo, state, search(page)]) await expect(field).toHaveValue('');
  await expect(count).toHaveText('4 of 4');
  await expect(lane(page, 'to-review').getByTestId('prs-ticket-BETA-3')).toBeVisible();
  await expect(lane(page, 'reviewed').getByTestId('prs-ticket-ALPHAX-2')).toBeVisible();
  expect(queueReads(dashboard)).toHaveLength(before);
  expect(dashboard.requests.filter(({ method }) => method !== 'GET')).toEqual([]);
});

test('ticket prefix stays transient through reload, preserves other saved fields and reuses mobile and missing-option behavior', async ({
  page,
  dashboard,
}) => {
  prefixQueue(dashboard.data);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.addInitScript(() => {
    if (sessionStorage.getItem('prefix-fixture-seeded')) return;
    sessionStorage.setItem('prefix-fixture-seeded', 'true');
    localStorage.setItem(
      'dev-dashboard.work-filters',
      JSON.stringify({
        version: 1,
        views: {
          prs: {
            prefix: 'BETA',
            search: 'Backend counterpart',
            repo: 'example/frontend',
            review: 'approved',
          },
          tickets: { search: 'preserve other screen' },
        },
      }),
    );
  });
  await page.goto('/#/prs');
  const panel = page.getByTestId('panel-prs');
  const prefix = panel.getByLabel('Ticket prefix', { exact: true });
  const toggle = panel.getByTestId('prs-filter-toggle');
  const count = panel.getByTestId('prs-filter-count');
  await expect(count).toHaveText('1 of 4');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(prefix).toHaveCount(1);
  await expect(prefix).toBeHidden();
  await toggle.click();
  await expect(prefix).toBeVisible();
  await expect(prefix).toHaveValue('');
  await expect(search(page)).toHaveValue('Backend counterpart');
  await expect(panel.getByLabel('Repository', { exact: true })).toHaveValue('example/frontend');
  await expect(panel.getByLabel('Review state', { exact: true })).toHaveValue('approved');
  await prefix.selectOption('ALPHA');
  await expect(panel.getByTestId('prs-filter-active')).toHaveText('3 active');
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('dev-dashboard.work-filters')),
  );
  expect(saved.views.prs).toEqual({
    search: 'Backend counterpart',
    repo: 'example/frontend',
    review: 'approved',
  });
  expect(saved.views.tickets).toEqual({ search: 'preserve other screen' });
  await page.reload();
  await expect(count).toHaveText('1 of 4');
  await toggle.click();
  await expect(prefix).toHaveValue('');
  await expect(search(page)).toHaveValue('Backend counterpart');
  await expect(panel.getByLabel('Repository', { exact: true })).toHaveValue('example/frontend');
  await expect(panel.getByLabel('Review state', { exact: true })).toHaveValue('approved');
  const before = queueReads(dashboard).length;
  await panel.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await prefix.selectOption('BETA');
  await expect(count).toHaveText('1 of 4');
  expect(queueReads(dashboard)).toHaveLength(before);
  dashboard.data.reviewTickets.tickets = dashboard.data.reviewTickets.tickets.map((row) =>
    row.key === 'BETA-3' ? { ...row, key: 'DELTA-5' } : row,
  );
  await page.getByTestId('prs-refresh').click();
  await expect(count).toHaveText('0 of 4');
  await expect(prefix).toHaveValue('BETA');
  await expect(prefix.locator('option:checked')).toHaveText('BETA (not in fetched data)');
  await expect(prefix.locator('option[value="DELTA"]')).toHaveText('DELTA');
  await expect(page.getByTestId('prs-no-matches')).toBeVisible();
  expect(queueReads(dashboard)).toHaveLength(before + 1);
  await panel.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(prefix).toHaveValue('');
  await expect(count).toHaveText('4 of 4');
  await expect(panel.getByTestId('prs-filter-active')).toHaveCount(0);
  await toggle.click();
  await expect(prefix).toBeHidden();
  await expect(search(page)).toBeVisible();
  expect(dashboard.requests.filter(({ method }) => method !== 'GET')).toEqual([]);
});

test('lane header help describes classifier rules on hover and actual Tab focus, dismisses, and leaves no-hint boards unchanged', async ({
  page,
  dashboard,
}) => {
  ticketBoardData(dashboard.data);
  mixedQueue(dashboard.data);
  for (const view of ['my-tickets', 'slack']) {
    await page.goto(`/#/${view}`);
    const board = page.getByTestId(`${view}-board`);
    await expect(board).toBeVisible();
    const headings = board.locator('.board-column-title');
    expect(await headings.count()).toBeGreaterThan(0);
    expect(
      await headings.evaluateAll((elements) =>
        elements.every(
          (heading) =>
            heading.tagName === 'H3' &&
            heading.tabIndex === -1 &&
            !heading.hasAttribute('tabindex') &&
            !heading.hasAttribute('aria-describedby') &&
            !heading.hasAttribute('title') &&
            heading.parentElement.className === 'board-column-head' &&
            heading.parentElement.parentElement.getAttribute('aria-labelledby') === heading.id &&
            /^\d+$/.test(heading.nextElementSibling.textContent.trim()),
        ),
      ),
    ).toBe(true);
    await headings.first().hover();
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await board.focus();
    await page.keyboard.press('Tab');
    await expect(board.locator('.board-column-body').first()).toBeFocused();
  }
  await page.getByTestId('tab-prs').click();
  await expect(ticket(page)).toBeVisible();
  const before = queueReads(dashboard).length;
  const meanings = [
    [
      'to-review',
      'To Review',
      [
        /no current approval or changes-request activity/i,
        /no linked open PRs/i,
        /incomplete PR\/review data/i,
        /all linked open PRs in watched repositories/i,
        /unknown data stays here/i,
      ],
    ],
    [
      'reviewing',
      'Reviewing',
      [
        /PR\/review data is complete/i,
        /at least one linked open PR has an approval or standing changes request/i,
        /another PR may await approval/i,
        /a changes request may stand/i,
        /a draft may remain/i,
        /all linked open PRs in watched repositories/i,
        /not live reviewer activity/i,
      ],
    ],
    [
      'reviewed',
      'Reviewed',
      [
        /at least one linked open PR/i,
        /every linked open PR across watched repositories/i,
        /approved by anyone/i,
        /complete PR\/review data/i,
        /no drafts and no standing changes requests/i,
      ],
    ],
  ];
  for (const [id, label, clauses] of meanings) {
    const heading = lane(page, id).getByRole('heading', { name: label, exact: true });
    await expect(heading).toHaveAttribute('id', `prs-column-title-${id}`);
    await expect(lane(page, id)).toHaveAccessibleName(label);
    await expect(page.getByTestId(`prs-column-count-${id}`)).toHaveText('1');
    await heading.hover();
    const tooltip = await expectLaneHelp(page, heading, clauses);
    await expect(heading).toHaveAccessibleName(label);
    await page.mouse.move(0, 0);
    await expect(tooltip).toBeHidden();
    for (const dismiss of ['Escape', 'Tab']) {
      await page.getByTestId('prs-board').focus();
      for (
        let step = 0;
        step < 30 && !(await heading.evaluate((node) => node === document.activeElement));
        step += 1
      ) {
        await page.keyboard.press('Tab');
      }
      await expect(heading).toBeFocused();
      const focusedTooltip = await expectLaneHelp(page, heading, clauses);
      await page.keyboard.press(dismiss);
      await expect(focusedTooltip).toBeHidden();
      if (dismiss === 'Escape') await expect(heading).toBeFocused();
      else await expect(heading).not.toBeFocused();
    }
  }
  expect(queueReads(dashboard)).toHaveLength(before);
  expect(dashboard.requests.filter(({ method }) => method !== 'GET')).toEqual([]);
});
