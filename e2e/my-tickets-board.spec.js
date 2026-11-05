import { statSync } from 'node:fs';
import { test, expect } from './fixtures.js';
import {
  ticketBoardData,
  withForeignProjectTicket,
  withTripsProjectTicket,
  BOARD_THREAD_TS,
} from './data.js';

// The My Tickets kanban board. The fixture is the matrix in `ticketBoardData` (e2e/data.js). The
// ids below are the board's own, and this spec relies on each:
//   - a PR line's id is `my-tickets-pr-<KEY>-<slug of the PR's "org/repo">-<number>`;
//   - an unreadable CI (`ci: null`) reads `data-ci-state="unknown"`;
//   - the needs-reply dot inside a Slack chip is `slack-thread-needs-reply-<ts>`.

const slugOf = (text) => text.replace(/[^A-Za-z0-9-]+/g, '-');
const columnId = (part, status) => `my-tickets-column${part ? `-${part}` : ''}-${slugOf(status)}`;
const prId = (key, repo, number) => `my-tickets-pr-${key}-${slugOf(repo)}-${number}`;

const API = 'ExampleOrg/example-api';
const WEB = 'ExampleOrg/example-web';

// Workflow order for the fixture. Done is added by Include Done.
const COLUMNS = [
  ['Blocked', 1],
  ['To Do', 21],
  ['In Progress', 3],
  ['Code Review', 2],
  ['Ready For Testing', 1],
  ['Weird Custom Gate', 1],
];

const BOARD = 'my-tickets-board';
const prLine = (page, key, repo, number) => page.getByTestId(prId(key, repo, number));
const prLinesOf = (page, key) =>
  page.getByTestId(`my-tickets-item-${key}`).locator('[data-testid^="my-tickets-pr-"]');
const ciGlyph = (line) =>
  line
    .locator('svg')
    .first()
    .evaluate((svg) => svg.innerHTML);
const settle = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
const ticketRequests = (dashboard) =>
  dashboard.requests.filter(({ path }) => path.startsWith('/api/my-tickets')).length;
const sidewaysScroll = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth > innerWidth);

async function openBoard(page) {
  await page.goto('/#/my-tickets');
  const board = page.getByTestId(BOARD);
  await expect(board).toBeVisible();
  return board;
}

// Columns render and reorder.

test('columns follow the workflow order and carry their ticket counts @regression', async ({
  page,
  dashboard,
}) => {
  ticketBoardData(dashboard.data);
  await openBoard(page);
  const lefts = [];
  for (const [status, count] of COLUMNS) {
    const column = page.getByTestId(columnId('', status));
    await expect(column).toBeVisible();
    await expect(page.getByTestId(columnId('head', status))).toContainText(new RegExp(status, 'i'));
    await expect(page.getByTestId(columnId('count', status))).toHaveText(String(count));
    lefts.push((await column.boundingBox()).x);
  }
  for (let index = 1; index < lefts.length; index++)
    expect(
      lefts[index],
      `${COLUMNS[index][0]} sits right of ${COLUMNS[index - 1][0]}`,
    ).toBeGreaterThan(lefts[index - 1]);
  // Done tickets are not fetched by default, and the old category sections are gone.
  await expect(page.getByTestId(columnId('', 'Done'))).toHaveCount(0);
  await expect(page.locator('[data-testid^="my-tickets-category-"]')).toHaveCount(0);
  await expect(page.locator('[data-testid^="my-tickets-status-"]')).toHaveCount(0);
});

test('Include Done adds a Done column at the end of the board @regression', async ({
  page,
  dashboard,
}) => {
  ticketBoardData(dashboard.data);
  await openBoard(page);
  await expect(page.getByTestId(columnId('', 'Done'))).toHaveCount(0);
  await page.getByTestId('my-tickets-include-done').check();
  const done = page.getByTestId(columnId('', 'Done'));
  await expect(done).toBeVisible();
  await expect(page.getByTestId(columnId('count', 'Done'))).toHaveText('1');
  await expect(page.getByTestId('my-tickets-item-TAP-9300')).toBeVisible();
  const last = await page.getByTestId(columnId('', 'Weird Custom Gate')).boundingBox();
  expect((await done.boundingBox()).x).toBeGreaterThan(last.x);
});

test('filtering to one status leaves one column @regression', async ({ page, dashboard }) => {
  ticketBoardData(dashboard.data);
  await openBoard(page);
  await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('In Progress');
  await expect(page.getByTestId(columnId('', 'In Progress'))).toBeVisible();
  await expect(page.getByTestId(columnId('count', 'In Progress'))).toHaveText('3');
  for (const [status] of COLUMNS.filter(([name]) => name !== 'In Progress'))
    await expect(page.getByTestId(columnId('', status))).toHaveCount(0);
  await expect(page.getByTestId('my-tickets-filter-count')).toHaveText('3 of 29');
});

// The card shows the compact facts.

test('a card shows its Jira link, named priority, points, update time and clamped summary @regression', async ({
  page,
  dashboard,
}) => {
  const data = ticketBoardData(dashboard.data);
  await openBoard(page);
  const card = page.getByTestId('my-tickets-item-TAP-9001');
  await expect(
    page.getByTestId(columnId('body', 'In Progress')).getByTestId('my-tickets-item-TAP-9001'),
  ).toBeVisible();
  const link = card.getByTestId('my-tickets-item-link-TAP-9001');
  await expect(link).toHaveText('TAP-9001');
  await expect(link).toHaveAttribute('href', 'https://example.invalid/browse/TAP-9001');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  const priority = card.getByTestId('my-tickets-item-priority-TAP-9001');
  await expect(priority).toHaveAccessibleName(/high/i);
  await expect(priority).toHaveAttribute('data-tooltip', /high/i);
  await expect(card.getByTestId('my-tickets-item-points-TAP-9001')).toHaveText('5 pt');
  await expect(card.getByTestId('my-tickets-item-updated-TAP-9001')).toHaveText('2h ago');
  await expect(card.getByTestId('my-tickets-item-summary-TAP-9001')).toHaveText(
    'Invented fix for the failing export job',
  );

  const longSummary = data.tickets.tickets.find(({ key }) => key === 'TAP-9008').summary;
  const summary = page.getByTestId('my-tickets-item-summary-TAP-9008');
  await expect(summary).toHaveText(longSummary);
  await expect(summary).toHaveAttribute('title', longSummary);
  const clamp = await summary.evaluate((element) => ({
    lines: getComputedStyle(element).getPropertyValue('-webkit-line-clamp'),
    clipped: element.scrollHeight > element.clientHeight,
  }));
  expect(clamp).toEqual({ lines: '2', clipped: true });
});

test('a current-sprint card is marked and another sprint is named on the card @regression', async ({
  page,
  dashboard,
}) => {
  ticketBoardData(dashboard.data);
  await openBoard(page);
  const current = page.getByTestId('my-tickets-item-TAP-9001');
  await expect(current).toHaveAttribute('data-in-current-sprint', 'true');
  await expect(current).toContainText('In current sprint');
  const other = page.getByTestId('my-tickets-item-TAP-9004');
  await expect(other).not.toHaveAttribute('data-in-current-sprint', 'true');
  await expect(other.getByTestId('my-tickets-item-sprint-label-TAP-9004')).toHaveText(
    'Following Sprint',
  );
});

// PR lines carry CI and review.

test('each CI state has its own glyph, repo and number, review words and a tooltip @regression', async ({
  page,
  dashboard,
}) => {
  ticketBoardData(dashboard.data);
  await openBoard(page);
  const lines = {
    failing: prLine(page, 'TAP-9001', API, 812),
    passing: prLine(page, 'TAP-9002', WEB, 904),
    pending: prLine(page, 'TAP-9003', API, 815),
    none: prLine(page, 'TAP-9008', API, 840),
    unknown: prLine(page, 'TAP-9005', WEB, 821),
  };
  const tooltips = {
    failing: /^CI failing: lint, unit-tests \(2 of 9 failed\)$/,
    passing: /^CI passing \(9 of 9\)$/,
    pending: /^CI pending \(3 of 9 running\)$/,
    none: /^No CI checks$/,
    unknown: /^CI status unavailable$/,
  };
  for (const [state, line] of Object.entries(lines)) {
    await expect(line, state).toBeVisible();
    await expect(line, state).toHaveAttribute('data-ci-state', state);
    await expect(line, state).toHaveAttribute('data-tooltip', tooltips[state]);
  }
  await expect(lines.failing).toHaveAccessibleName(
    /CI failing: lint, unit-tests \(2 of 9 failed\)/,
  );
  // Shape, not colour: check, cross and open ring each differ from every other state.
  const glyphs = await Promise.all(
    ['passing', 'failing', 'pending', 'none'].map((state) => ciGlyph(lines[state])),
  );
  expect(new Set(glyphs).size).toBe(4);

  await expect(lines.failing).toContainText('example-api');
  await expect(lines.failing).toContainText('#812');
  await expect(lines.failing).not.toContainText('ExampleOrg');
  await expect(lines.failing).toContainText('awaiting');
  await expect(lines.passing).toContainText('example-web');
  await expect(lines.passing).toContainText('#904');
  await expect(lines.passing).toContainText('approved');
  await expect(prLine(page, 'TAP-9005', API, 820)).toContainText('changes requested');
});

test('a failing line names at most three failing checks and counts the rest @regression', async ({
  page,
  dashboard,
}) => {
  const data = ticketBoardData(dashboard.data);
  data.ticketPrs.byTicket['TAP-9001'][0].ci = {
    state: 'failing',
    passed: 4,
    failed: 5,
    pending: 0,
    failing: ['a-lint', 'b-unit', 'c-e2e', 'd-build', 'e-types'],
  };
  await openBoard(page);
  const tooltip = await prLine(page, 'TAP-9001', API, 812).getAttribute('data-tooltip');
  expect(tooltip).toMatch(/^CI failing: a-lint, b-unit, c-e2e/);
  expect(tooltip).toMatch(/\+2 more/);
  expect(tooltip).not.toMatch(/d-build|e-types/);
});

test('a PR line is a safe new-tab link and only a draft carries the DRAFT tag @regression', async ({
  page,
  dashboard,
}) => {
  ticketBoardData(dashboard.data);
  await openBoard(page);
  const line = prLine(page, 'TAP-9001', API, 812);
  await expect(line).toBeVisible();
  expect(await line.evaluate((element) => element.tagName)).toBe('A');
  await expect(line).toHaveAttribute('href', 'https://github.com/ExampleOrg/example-api/pull/812');
  await expect(line).toHaveAttribute('target', '_blank');
  await expect(line).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(prLine(page, 'TAP-9003', API, 815)).toContainText(/draft/i);
  await expect(line).not.toContainText(/draft/i);
  await expect(prLine(page, 'TAP-9002', WEB, 904)).not.toContainText(/draft/i);
});

test('PRs sit on the tickets they name: two on one card, one on two cards, none on a bare ticket @regression', async ({
  page,
  dashboard,
}) => {
  ticketBoardData(dashboard.data);
  await openBoard(page);
  await expect(prLinesOf(page, 'TAP-9005')).toHaveCount(2);
  await expect(prLine(page, 'TAP-9005', API, 820)).toBeVisible();
  await expect(prLine(page, 'TAP-9005', WEB, 821)).toBeVisible();
  await expect(prLine(page, 'TAP-9006', WEB, 931)).toBeVisible();
  await expect(prLine(page, 'TAP-9007', WEB, 931)).toBeVisible();
  await expect(prLinesOf(page, 'TAP-9004')).toHaveCount(0);
  await expect(page.getByTestId('my-tickets-item-TAP-9004')).toBeVisible();
  await expect(prLinesOf(page, 'TAP-9100')).toHaveCount(0);
});

test('unreadable review and CI show as unknown on that PR only @regression', async ({
  page,
  dashboard,
}) => {
  const data = ticketBoardData(dashboard.data);
  const [pr] = data.ticketPrs.byTicket['TAP-9001'];
  data.ticketPrs.byTicket['TAP-9001'] = [{ ...pr, review: null, ci: null }];
  await openBoard(page);
  const line = prLine(page, 'TAP-9001', API, 812);
  await expect(line).toBeVisible();
  await expect(line).toHaveAttribute('data-ci-state', 'unknown');
  await expect(line).toHaveAttribute('data-tooltip', 'CI status unavailable');
  await expect(line).toContainText('#812');
  await expect(line).not.toContainText(/approved|changes requested|awaiting/);
  // The next ticket's PR is untouched.
  await expect(prLine(page, 'TAP-9002', WEB, 904)).toHaveAttribute('data-ci-state', 'passing');
});

// Slack chips open the dialog.

test('a Slack chip shows its reply count and a needs-reply mark and opens the thread dialog @regression', async ({
  page,
  dashboard,
}) => {
  ticketBoardData(dashboard.data);
  await page.goto('/#/my-tickets');
  const { needsReply, quiet } = BOARD_THREAD_TS;
  const urgent = page.getByTestId(`slack-thread-link-${needsReply}`);
  const calm = page.getByTestId(`slack-thread-link-${quiet}`);
  // The count is visible text beside the bubble; the label already says it, so it is aria-hidden.
  await expect(urgent).toHaveText('4');
  await expect(calm).toHaveText('1');
  await expect(urgent).toHaveAttribute('aria-label', /4 replies/);
  await expect(urgent).toHaveAttribute('aria-label', /needs reply/);
  await expect(urgent.getByTestId(`slack-thread-needs-reply-${needsReply}`)).toBeVisible();
  await expect(calm).toHaveAttribute('aria-label', /1 reply/);
  await expect(calm).not.toHaveAttribute('aria-label', /needs reply/);
  await expect(calm.getByTestId(`slack-thread-needs-reply-${quiet}`)).toHaveCount(0);

  // The chips live on the cards of the board, one per matching thread.
  const board = page.getByTestId(BOARD);
  await expect(
    board.getByTestId('my-tickets-item-TAP-9002').getByTestId(`slack-thread-link-${needsReply}`),
  ).toBeVisible();
  await expect(
    board.getByTestId('my-tickets-item-TAP-9005').getByTestId(`slack-thread-link-${quiet}`),
  ).toBeVisible();
  await urgent.click();
  const dialog = page.getByTestId('slack-thread-dialog');
  await expect(dialog.getByTestId(`slack-thread-message-${needsReply}`)).toBeVisible();
});

// PR data never blocks or fails the tickets.

test('a slow PR route neither delays the cards nor raises a ticket error @regression', async ({
  page,
  dashboard,
}) => {
  ticketBoardData(dashboard.data);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let requested = 0;
  await page.route('**/api/ticket-prs*', async (route) => {
    requested++;
    await gate;
    await route.fulfill({ status: 503, body: 'Unavailable' });
  });
  try {
    await page.goto('/#/my-tickets');
    await expect(page.getByTestId('my-tickets-item-TAP-9001')).toBeVisible();
    await expect(page.getByTestId(BOARD)).toBeVisible();
    await expect(page.getByTestId('my-tickets-error')).toHaveCount(0);
    await expect
      .poll(() => requested, { message: 'the board asks for PR status in the same load' })
      .toBe(1);
    await expect(page.getByTestId('my-tickets-item-TAP-9001')).toBeVisible();
    await expect(page.locator('[data-testid^="my-tickets-pr-"]')).toHaveCount(0);
  } finally {
    release();
  }
  await expect(page.getByTestId('my-tickets-prs-note')).toBeVisible();
  await expect(page.getByTestId('my-tickets-error')).toHaveCount(0);
  await expect(page.getByTestId('my-tickets-item-TAP-9001')).toBeVisible();
});

test('a 503 after a good load keeps the PR lines and says they are from the last update @regression', async ({
  page,
  dashboard,
}) => {
  ticketBoardData(dashboard.data);
  await openBoard(page);
  const line = prLine(page, 'TAP-9001', API, 812);
  await expect(line).toBeVisible();
  await expect(page.getByTestId('my-tickets-prs-note')).toHaveCount(0);
  await page.route('**/api/ticket-prs*', (route) =>
    route.fulfill({ status: 503, body: 'Unavailable' }),
  );
  await page.getByTestId('my-tickets-refresh').click();
  await expect(page.getByTestId('my-tickets-prs-note')).toContainText(/last update/i);
  await expect(line).toBeVisible();
  await expect(line).toHaveAttribute('data-ci-state', 'failing');
  await expect(page.getByTestId('my-tickets-error')).toHaveCount(0);
});

test('PR status that is unavailable leaves the cards, notes it and lists no PR @regression', async ({
  page,
  dashboard,
}) => {
  ticketBoardData(dashboard.data, { available: false });
  await openBoard(page);
  await expect(page.getByTestId('my-tickets-item-TAP-9001')).toBeVisible();
  await expect(page.getByTestId('my-tickets-prs-note')).toBeVisible();
  await expect(page.locator('[data-testid^="my-tickets-pr-"]')).toHaveCount(0);
  await expect(page.getByTestId('my-tickets-error')).toHaveCount(0);
});

// The board scrolls inside itself and keeps its position.

for (const width of [390, 1024, 1440]) {
  test(`the board scrolls sideways inside itself while the page stays put at ${width} @regression`, async ({
    page,
    dashboard,
  }) => {
    ticketBoardData(dashboard.data);
    await page.setViewportSize({ width, height: 900 });
    const board = await openBoard(page);
    await expect(board).toHaveAttribute('role', 'region');
    await expect(board).toHaveAttribute('aria-label', 'Ticket board');
    await expect(board).toHaveAttribute('tabindex', '0');
    expect(await sidewaysScroll(page)).toBe(false);
    const sizes = await board.evaluate((element) => ({
      scroll: element.scrollWidth,
      client: element.clientWidth,
      overflowX: getComputedStyle(element).overflowX,
    }));
    expect(['auto', 'scroll']).toContain(sizes.overflowX);
    expect(sizes.scroll).toBeGreaterThan(sizes.client);

    // The attention column is the first thing on the board, fully visible without scrolling.
    const blocked = await page.getByTestId(columnId('', 'Blocked')).boundingBox();
    expect(blocked.x).toBeGreaterThanOrEqual(0);
    expect(blocked.x + blocked.width).toBeLessThanOrEqual(width);
    if (width === 390) {
      expect(blocked.width / width).toBeGreaterThanOrEqual(0.8);
      expect(blocked.width / width).toBeLessThanOrEqual(0.9);
      // The next column peeks in, which tells the reader the board continues.
      const next = await page.getByTestId(columnId('', 'To Do')).boundingBox();
      expect(next.x).toBeLessThan(width);
      expect(next.x + next.width).toBeGreaterThan(width);
    } else {
      expect(blocked.width).toBeGreaterThanOrEqual(240);
      expect(blocked.width).toBeLessThanOrEqual(320);
    }
  });
}

test('a column of twenty tickets scrolls inside itself while its header stays visible @regression', async ({
  page,
  dashboard,
}) => {
  ticketBoardData(dashboard.data);
  await openBoard(page);
  const body = page.getByTestId(columnId('body', 'To Do'));
  const head = page.getByTestId(columnId('head', 'To Do'));
  await expect(head).toBeVisible();
  const headBefore = await head.boundingBox();
  expect(await body.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  expect(await body.evaluate((element) => getComputedStyle(element).overflowY)).toMatch(
    /auto|scroll/,
  );
  await body.evaluate((element) =>
    element.scrollTo({ top: element.scrollHeight, behavior: 'instant' }),
  );
  await settle(page);
  const bodyBox = await body.boundingBox();
  const lastBox = await page.getByTestId('my-tickets-item-TAP-9119').boundingBox();
  expect(lastBox.y).toBeGreaterThanOrEqual(bodyBox.y - 1);
  expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(bodyBox.y + bodyBox.height + 1);
  await expect(head).toBeVisible();
  expect(Math.abs((await head.boundingBox()).y - headBefore.y)).toBeLessThanOrEqual(1);
  expect(await sidewaysScroll(page)).toBe(false);
});

test('board and column scroll positions survive a refresh @regression', async ({
  page,
  dashboard,
}) => {
  const data = ticketBoardData(dashboard.data);
  const board = await openBoard(page);
  const body = page.getByTestId(columnId('body', 'To Do'));
  await expect(page.getByTestId('my-tickets-item-TAP-9100')).toBeVisible();
  await board.evaluate((element) => element.scrollTo({ left: 300, behavior: 'instant' }));
  await body.evaluate((element) => element.scrollTo({ top: 500, behavior: 'instant' }));
  await settle(page);
  const position = async () => ({
    left: await board.evaluate((element) => element.scrollLeft),
    top: await body.evaluate((element) => element.scrollTop),
  });
  const before = await position();
  expect(before.left).toBeGreaterThan(0);
  expect(before.top).toBeGreaterThan(0);

  data.tickets.tickets.find(({ key }) => key === 'TAP-9001').summary =
    'Invented summary after refresh';
  const calls = ticketRequests(dashboard);
  await page.getByTestId('my-tickets-refresh').click();
  await expect(page.getByTestId('my-tickets-item-summary-TAP-9001')).toHaveText(
    'Invented summary after refresh',
  );
  await expect(page.getByTestId('my-tickets-refresh')).toBeEnabled();
  expect(ticketRequests(dashboard)).toBe(calls + 1);
  await settle(page);
  expect(await position()).toEqual(before);
});

// Evidence at three widths.

test('board screenshots at 1440, 1024 and 390 @regression', async ({
  page,
  dashboard,
}, testInfo) => {
  ticketBoardData(dashboard.data);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const shoot = async (name) => {
    const path = testInfo.outputPath(`${name}.png`);
    await page.screenshot({ path, fullPage: true });
    expect(statSync(path).size).toBeGreaterThan(0);
    await testInfo.attach(name, { path, contentType: 'image/png' });
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  const board = await openBoard(page);
  await page.getByTestId('my-tickets-include-done').check();
  await expect(page.getByTestId(columnId('', 'Done'))).toBeVisible();
  await expect(prLine(page, 'TAP-9001', API, 812)).toBeVisible();
  await expect(page.getByTestId(`slack-thread-link-${BOARD_THREAD_TS.needsReply}`)).toBeVisible();
  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await settle(page);
    expect(await sidewaysScroll(page)).toBe(false);
    await shoot(`board-${width}`);
  }
  await board.evaluate((element) =>
    element.scrollTo({ left: element.scrollWidth, behavior: 'instant' }),
  );
  await settle(page);
  const scroll = await board.evaluate((element) => ({
    left: element.scrollLeft,
    max: element.scrollWidth - element.clientWidth,
  }));
  expect(scroll.left).toBeGreaterThan(0);
  expect(scroll.left).toBeGreaterThanOrEqual(scroll.max - 1);
  // A viewport capture after the scroll: a fullPage capture resets the board's scroll.
  const lastPath = testInfo.outputPath('board-390-last-column.png');
  await page.screenshot({ path: lastPath });
  expect(statSync(lastPath).size).toBeGreaterThan(0);
  await testInfo.attach('board-390-last-column', { path: lastPath, contentType: 'image/png' });
});

// A PR on a ticket outside TAP and TRIPS: the server files it under the key as written.
test('a PR on a ticket outside TAP and TRIPS shows on its card @regression', async ({
  page,
  dashboard,
}) => {
  ticketBoardData(dashboard.data);
  withForeignProjectTicket(dashboard.data);
  const [pr] = dashboard.data.ticketPrs.byTicket['PRT-901'];
  await openBoard(page);
  await expect(page.getByTestId('my-tickets-item-PRT-901')).toBeVisible();
  await expect(prLine(page, 'PRT-901', pr.repo, 901)).toBeVisible();
});

const prRequests = (dashboard) =>
  dashboard.requests.filter(({ path }) => path.startsWith('/api/ticket-prs')).length;

// Include Done changes which tickets come back, never which PRs exist, so it asks for tickets only.
test('Include Done refetches tickets but not PR status @regression', async ({
  page,
  dashboard,
}) => {
  ticketBoardData(dashboard.data);
  await openBoard(page);
  await expect(page.getByTestId('my-tickets-item-TAP-9001')).toBeVisible();
  const tickets = ticketRequests(dashboard);
  const prs = prRequests(dashboard);
  await page.getByTestId('my-tickets-include-done').check();
  await expect(page.getByTestId(columnId('', 'Done'))).toBeVisible();
  expect(ticketRequests(dashboard)).toBeGreaterThan(tickets);
  expect(prRequests(dashboard)).toBe(prs);
});

// The Home filters are the plain row: no disclosure, no toggle, no collapsed region.
test('Home filters never fold away @regression', async ({ page }) => {
  await page.goto('/#/home');
  const filter = page.locator('#home-actions-filter');
  await expect(filter).toBeAttached();
  await expect(filter.locator('[aria-expanded]')).toHaveCount(0);
  expect(await filter.getAttribute('data-collapsible')).toBeNull();
});

test.describe('narrow filters', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the Filters disclosure hides the selects until opened and counts the active ones @regression', async ({
    page,
    dashboard,
  }) => {
    ticketBoardData(dashboard.data);
    await openBoard(page);
    const toggle = page.getByTestId('my-tickets-filter-toggle');
    const status = page.locator('#my-tickets-filter select[data-filter="status"]');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(status).toBeHidden();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(status).toBeVisible();
    const values = await status
      .locator('option')
      .evaluateAll((options) => options.map((option) => option.value).filter(Boolean));
    expect(values.length).toBeGreaterThan(0);
    const countBefore = await page.getByTestId('my-tickets-filter-count').textContent();
    await status.selectOption(values[0]);
    await expect(page.getByTestId('my-tickets-filter-active')).toHaveText('1 active');
    await expect(page.getByTestId('my-tickets-filter-count')).not.toHaveText(countBefore);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(status).toBeHidden();
    await expect(page.getByTestId('my-tickets-filter-active')).toHaveText('1 active');
  });
});

// Two PR answers race: the first is held, a Refresh gets the second, then the first is released.
// Only the newest answer may stay on the board.
test('a late PR answer never replaces a newer one @regression', async ({ page, dashboard }) => {
  ticketBoardData(dashboard.data);
  const [pr] = dashboard.data.ticketPrs.byTicket['TAP-9001'];
  const answer = (number) => ({
    ...dashboard.data.ticketPrs,
    byTicket: { 'TAP-9001': [{ ...pr, number }] },
  });
  let calls = 0;
  let held = null;
  await page.route('**/api/ticket-prs*', async (route) => {
    calls += 1;
    if (calls === 1) {
      held = route;
      return;
    }
    await route.fulfill({ json: answer(222) });
  });
  await openBoard(page);
  await expect(page.getByTestId('my-tickets-item-TAP-9001')).toBeVisible();
  const refresh = page.getByTestId('my-tickets-refresh');
  await expect(refresh).toBeEnabled();
  await refresh.click();
  await expect(prLine(page, 'TAP-9001', pr.repo, 222)).toBeVisible();

  const released = page.waitForResponse('**/api/ticket-prs*');
  await held.fulfill({ json: answer(111) });
  await released;
  await settle(page);
  await expect(prLine(page, 'TAP-9001', pr.repo, 111)).toHaveCount(0);
  await expect(prLine(page, 'TAP-9001', pr.repo, 222)).toBeVisible();
});

// Layout pins. Each one fails when the layout fix it names is undone.
test('the Slack chip is at least 24 by 24 and keeps its padding @regression', async ({
  page,
  dashboard,
}) => {
  ticketBoardData(dashboard.data);
  await openBoard(page);
  const chip = page.getByTestId(`slack-thread-link-${BOARD_THREAD_TS.needsReply}`);
  await expect(chip).toBeVisible();
  const box = await chip.boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(24);
  expect(box.height).toBeGreaterThanOrEqual(24);
  const padding = await chip.evaluate((element) =>
    parseFloat(getComputedStyle(element).paddingLeft),
  );
  expect(padding).toBeGreaterThan(0);
});

for (const width of [768, 1024, 1280, 1440]) {
  test(`the search field ends before the Status label at ${width} @regression`, async ({
    page,
    dashboard,
  }) => {
    ticketBoardData(dashboard.data);
    await page.setViewportSize({ width, height: 900 });
    await openBoard(page);
    const search = await page.locator('#my-tickets-filter .work-filter-search input').boundingBox();
    const status = await page
      .locator('#my-tickets-filter label')
      .filter({ has: page.locator('select[data-filter="status"]') })
      .boundingBox();
    expect(search.x + search.width).toBeLessThanOrEqual(status.x);
  });
}

for (const [width, height] of [
  [1440, 900],
  [390, 844],
]) {
  test(`My Tickets fills the ${width}x${height} viewport with no page scroll @regression`, async ({
    page,
    dashboard,
  }) => {
    ticketBoardData(dashboard.data);
    await page.setViewportSize({ width, height });
    const board = await openBoard(page);
    const sizes = await page.evaluate(() => ({
      scroll: document.documentElement.scrollHeight,
      inner: innerHeight,
    }));
    expect(sizes.scroll).toBeLessThanOrEqual(sizes.inner);
    const box = await board.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(320);
    expect(box.y + box.height).toBeLessThanOrEqual(height);
    // The board reaches the foot of the viewport: only the panel's bottom padding is left.
    expect(height - (box.y + box.height)).toBeLessThanOrEqual(56);
  });
}

// TRIPS folds onto TAP: a PR the server files under TAP-n must show on the TRIPS-n card.
test('a PR filed under TAP shows on its TRIPS card @regression', async ({ page, dashboard }) => {
  ticketBoardData(dashboard.data);
  withTripsProjectTicket(dashboard.data);
  const [pr] = dashboard.data.ticketPrs.byTicket['TAP-901'];
  await openBoard(page);
  await expect(page.getByTestId('my-tickets-item-TRIPS-901')).toBeVisible();
  await expect(prLinesOf(page, 'TRIPS-901')).toHaveCount(1);
  await expect(prLine(page, 'TRIPS-901', pr.repo, 903)).toBeVisible();
});

test('each board column is a group named after its status @regression', async ({
  page,
  dashboard,
}) => {
  ticketBoardData(dashboard.data);
  await openBoard(page);
  for (const [status] of COLUMNS) {
    await expect(page.getByRole('group', { name: status, exact: true })).toHaveCount(1);
  }
});

test.describe('narrow filter pins', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the Filters button controls a field region that holds the selects @regression', async ({
    page,
    dashboard,
  }) => {
    ticketBoardData(dashboard.data);
    await openBoard(page);
    const controls = await page
      .getByTestId('my-tickets-filter-toggle')
      .getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    await expect(page.locator(`[id="${controls}"]`)).toHaveCount(1);
    await expect(page.locator(`[id="${controls}"] select[data-filter="status"]`)).toHaveCount(1);
  });

  test('the search field and Status do not overlap at 390 with Filters open @regression', async ({
    page,
    dashboard,
  }) => {
    ticketBoardData(dashboard.data);
    await openBoard(page);
    await page.getByTestId('my-tickets-filter-toggle').click();
    const search = await page.locator('#my-tickets-filter .work-filter-search input').boundingBox();
    const status = await page
      .locator('#my-tickets-filter label')
      .filter({ has: page.locator('select[data-filter="status"]') })
      .boundingBox();
    const apart =
      search.x + search.width <= status.x ||
      status.x + status.width <= search.x ||
      search.y + search.height <= status.y ||
      status.y + status.height <= search.y;
    expect(apart).toBe(true);
  });
});
