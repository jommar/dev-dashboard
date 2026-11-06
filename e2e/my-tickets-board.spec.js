import { statSync } from 'node:fs';
import { test, expect } from './fixtures.js';
import {
  ticketBoardData,
  withFollowUpCases,
  withForeignProjectTicket,
  withTripsProjectTicket,
  BOARD_THREAD_TS,
  FOLLOW_UP_THREAD_TS,
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
// A PR line's own id and its comment chips' ids share the `my-tickets-pr-` prefix, so the lines are
// the ones that are not chips.
const prLinesOf = (page, key) =>
  page
    .getByTestId(`my-tickets-item-${key}`)
    .locator('[data-testid^="my-tickets-pr-"]:not([data-testid^="my-tickets-pr-comments-"])');
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
  withFollowUpCases(dashboard.data);
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
  // The pictures show comment chips, an attached Slack chip and an all-approved card.
  await expect(commentChip(page, 'human', 'TAP-9001', API, 812)).toBeVisible();
  await expect(commentChip(page, 'copilot', 'TAP-9001', API, 812)).toBeVisible();
  await expect(page.getByTestId(`slack-thread-link-${BOARD_THREAD_TS.needsReply}`)).toHaveAttribute(
    'data-attached',
    'true',
  );
  await expect(page.getByTestId('my-tickets-item-TAP-9002')).toHaveAttribute(
    'data-all-approved',
    'true',
  );
  // The follow-up cases sit in the column right of Ready For Testing.
  await page.getByTestId(columnId('', 'Ready For Delivery')).scrollIntoViewIfNeeded();
  await settle(page);
  const followUpPath = testInfo.outputPath('board-1440-follow-ups.png');
  await page.screenshot({ path: followUpPath });
  expect(statSync(followUpPath).size).toBeGreaterThan(0);
  await testInfo.attach('board-1440-follow-ups', { path: followUpPath, contentType: 'image/png' });
  await board.evaluate((element) => element.scrollTo({ left: 0, behavior: 'instant' }));
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

// -- comment chips, the attached Slack chip and the all-approved card -------------------------------
//
// The cases are the matrix in `ticketBoardData` plus `withFollowUpCases` (e2e/data.js). The ids:
//   - a comment chip is `my-tickets-pr-comments-<human|copilot>-<KEY>-<slug of repo>-<number>` and
//     carries `data-comment-state` ("open" or "resolved"; a cut-off list is never "resolved");
//   - an all-approved card carries `data-all-approved="true"` and a seal `my-tickets-item-approved-<KEY>`;
//   - an attached Slack chip carries `data-attached="true"`.

const commentChip = (page, author, key, repo, number) =>
  page.getByTestId(`my-tickets-pr-comments-${author}-${key}-${slugOf(repo)}-${number}`);
const commentChipsOf = (line) => line.locator('[data-testid^="my-tickets-pr-comments-"]');
const slackChip = (page, ts) => page.getByTestId(`slack-thread-link-${ts}`);
const colorOf = (locator) => locator.evaluate((element) => getComputedStyle(element).color);
const firstGlyph = (locator) =>
  locator
    .locator('svg')
    .first()
    .evaluate((svg) => svg.innerHTML);
const tokenColor = (page, token) =>
  page.evaluate((name) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);
const slackThreadReads = (dashboard) =>
  dashboard.requests.filter(({ path }) => path.startsWith('/api/slack/threads')).length;
const slackWatchReads = (dashboard) =>
  dashboard.requests.filter(({ path }) => path === '/api/slack/watch').length;

async function openFollowUps(page, dashboard) {
  ticketBoardData(dashboard.data);
  withFollowUpCases(dashboard.data);
  const board = await openBoard(page);
  await expect(page.getByTestId('my-tickets-item-TAP-9401')).toBeVisible();
  return board;
}

// The chips on the PR line.

test('comment chips show unresolved over total while open, the total alone once resolved, and a plus when cut off @regression', async ({
  page,
  dashboard,
}) => {
  await openFollowUps(page, dashboard);
  const chip = (author, key, number) => commentChip(page, author, key, API, number);
  const amber = await tokenColor(page, '--amber');
  const muted = await tokenColor(page, '--muted');

  const human = chip('human', 'TAP-9401', 401);
  await expect(human).toBeVisible();
  await expect(human).toHaveText('2/5');
  await expect(human).toHaveAttribute('data-comment-state', 'open');
  await expect(human).toHaveAttribute(
    'data-tooltip',
    'Human: 2 unresolved, 3 resolved, 9 comments',
  );
  expect(await colorOf(human), 'an open chip is amber').toBe(amber);
  await expect(chip('copilot', 'TAP-9401', 401)).toHaveCount(0);

  const copilot = chip('copilot', 'TAP-9402', 402);
  await expect(copilot).toHaveText('4');
  await expect(copilot).toHaveAttribute('data-comment-state', 'resolved');
  await expect(copilot).toHaveAttribute(
    'data-tooltip',
    'Copilot: 0 unresolved, 4 resolved, 6 comments',
  );
  expect(await colorOf(copilot), 'a resolved chip is muted').toBe(muted);
  await expect(chip('human', 'TAP-9402', 402)).toHaveCount(0);

  await expect(chip('human', 'TAP-9403', 403)).toHaveText('1/3');
  await expect(chip('copilot', 'TAP-9403', 403)).toHaveText('2/2');
  await expect(chip('human', 'TAP-9403', 403)).toHaveAttribute('data-comment-state', 'open');
  await expect(chip('copilot', 'TAP-9403', 403)).toHaveAttribute('data-comment-state', 'open');

  await expect(chip('human', 'TAP-9404', 404)).toHaveText('3');
  await expect(chip('copilot', 'TAP-9404', 404)).toHaveText('2');
  await expect(chip('human', 'TAP-9404', 404)).toHaveAttribute('data-comment-state', 'resolved');
  await expect(chip('copilot', 'TAP-9404', 404)).toHaveAttribute('data-comment-state', 'resolved');

  // 63 threads, 50 read: the count is a floor, so it says so and never claims resolved.
  const cut = chip('human', 'TAP-9408', 408);
  await expect(cut).toHaveText('3/50+');
  await expect(cut).toHaveAttribute('data-comment-state', 'open');
  await expect(cut).toHaveAttribute('data-tooltip', /^Human: 3 unresolved/);
  await expect(chip('copilot', 'TAP-9408', 408)).toHaveCount(0);
});

test('the human chip comes first and the two authors differ in glyph shape, not only in colour @regression', async ({
  page,
  dashboard,
}) => {
  await openFollowUps(page, dashboard);
  const human = commentChip(page, 'human', 'TAP-9403', API, 403);
  const copilot = commentChip(page, 'copilot', 'TAP-9403', API, 403);
  await expect(human).toBeVisible();
  await expect(copilot).toBeVisible();
  const [humanBox, copilotBox] = [await human.boundingBox(), await copilot.boundingBox()];
  expect(humanBox.x + humanBox.width).toBeLessThanOrEqual(copilotBox.x + 0.5);
  expect(Math.abs(humanBox.y - copilotBox.y)).toBeLessThanOrEqual(2);

  const humanGlyph = await firstGlyph(human);
  const copilotGlyph = await firstGlyph(copilot);
  expect(humanGlyph).not.toBe('');
  expect(copilotGlyph).not.toBe('');
  expect(humanGlyph).not.toBe(copilotGlyph);
  // The same author draws the same glyph on every line.
  expect(await firstGlyph(commentChip(page, 'human', 'TAP-9401', API, 401))).toBe(humanGlyph);
  expect(await firstGlyph(commentChip(page, 'copilot', 'TAP-9402', API, 402))).toBe(copilotGlyph);
  const nodes = await human.evaluate((element) => ({
    tag: element.tagName,
    interactive: element.querySelector('a, button, input') !== null,
  }));
  expect(['A', 'BUTTON']).not.toContain(nodes.tag);
  expect(nodes.interactive).toBe(false);
});

test('no chip is drawn for no threads, unknown comments, another bot or conversation comments, and the line names them in words @regression', async ({
  page,
  dashboard,
}) => {
  await openFollowUps(page, dashboard);
  const line = (key, number) => prLine(page, key, API, number);
  const words = {
    'TAP-9405': [405, null],
    'TAP-9406': [406, /comments unavailable/],
    'TAP-9407': [407, /Other: 1 unresolved, 0 resolved, 2 comments/],
    'TAP-9409': [409, /Conversation: 3 comments/],
  };
  for (const [key, [number, name]] of Object.entries(words)) {
    await expect(line(key, number), key).toBeVisible();
    await expect(commentChipsOf(line(key, number)), key).toHaveCount(0);
    if (name) await expect(line(key, number), key).toHaveAccessibleName(name);
  }
  await expect(line('TAP-9405', 405)).not.toHaveAccessibleName(/unavailable|Human|Copilot/);
});

test('the PR line keeps its CI tooltip, stays one link and adds the comment words to its accessible name @regression', async ({
  page,
  dashboard,
}) => {
  await openFollowUps(page, dashboard);
  const talked = prLine(page, 'TAP-9401', API, 401);
  await expect(talked).toHaveAttribute('data-tooltip', 'CI passing (9 of 9)');
  await expect(talked).toHaveAttribute('data-ci-state', 'passing');
  await expect(talked).toHaveAccessibleName(/Human: 2 unresolved, 3 resolved, 9 comments/);
  await expect(talked).toHaveAccessibleName(/CI passing \(9 of 9\)/);
  await expect(talked).toHaveAccessibleName(/awaiting/);
  expect(await talked.evaluate((element) => element.tagName)).toBe('A');
  await expect(talked).toHaveAttribute(
    'href',
    'https://github.com/ExampleOrg/example-api/pull/401',
  );
  await expect(talked).toHaveAttribute('target', '_blank');
  await expect(talked.locator('a, button')).toHaveCount(0);
  // The CI glyph is still the first drawing on the line, and the chips follow the review words.
  expect(await firstGlyph(talked)).toBe(await firstGlyph(prLine(page, 'TAP-9402', API, 402)));

  const cut = prLine(page, 'TAP-9408', API, 408);
  await expect(cut).toHaveAccessibleName(/showing the first 50 of 63 threads/);
  await expect(cut).toHaveAccessibleName(/Human: 3 unresolved, 47 resolved, 61 comments/);
  // A PR with no chips still reads as before.
  await expect(prLine(page, 'TAP-9405', API, 405)).toHaveAttribute(
    'data-tooltip',
    'CI passing (9 of 9)',
  );
});

test('matrix PR lines show the chips of their comments, and a PR whose comments are unknown shows none @regression', async ({
  page,
  dashboard,
}) => {
  ticketBoardData(dashboard.data);
  await openBoard(page);
  await expect(commentChip(page, 'human', 'TAP-9001', API, 812)).toHaveText('2/5');
  await expect(commentChip(page, 'copilot', 'TAP-9001', API, 812)).toHaveText('4');
  await expect(commentChip(page, 'human', 'TAP-9005', API, 820)).toHaveText('2/3');
  await expect(commentChip(page, 'copilot', 'TAP-9005', API, 820)).toHaveText('2/2');
  await expect(commentChipsOf(prLine(page, 'TAP-9005', WEB, 821))).toHaveCount(0);
  await expect(commentChipsOf(prLine(page, 'TAP-9003', API, 815))).toHaveCount(0);
  await expect(prLine(page, 'TAP-9005', WEB, 821)).toHaveAccessibleName(/comments unavailable/);
  // Counting PR lines still ignores the chips.
  await expect(prLinesOf(page, 'TAP-9005')).toHaveCount(2);
});

// The longest PR line at 390.

test.describe('PR line at 390', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  const BILLING = 'ExampleOrg/example-billing';
  const parts = (line) => ({
    name: line.locator('.my-tickets-pr-name'),
    draft: line.locator('.my-tickets-pr-draft'),
    review: line.locator('.my-tickets-pr-review'),
    chips: commentChipsOf(line),
  });
  const centre = (box) => box.y + box.height / 2;

  test('the longest line keeps its name, DRAFT, review words and both chips on two rows inside the card @regression', async ({
    page,
    dashboard,
  }) => {
    await openFollowUps(page, dashboard);
    const line = prLine(page, 'TAP-9410', BILLING, 1234);
    await line.scrollIntoViewIfNeeded();
    const { name, draft, review, chips } = parts(line);
    for (const part of [name, draft, review]) await expect(part).toBeVisible();
    await expect(chips).toHaveCount(2);
    const card = await page.getByTestId('my-tickets-item-TAP-9410').boundingBox();
    const box = await line.boundingBox();
    const [nameBox, draftBox, reviewBox] = [
      await name.boundingBox(),
      await draft.boundingBox(),
      await review.boundingBox(),
    ];
    expect(
      Math.abs(centre(nameBox) - centre(draftBox)),
      'the name and DRAFT share row one',
    ).toBeLessThanOrEqual(6);
    expect(centre(reviewBox) - centre(nameBox), 'the review words are on row two').toBeGreaterThan(
      8,
    );
    expect(reviewBox.width).toBeGreaterThan(0);
    expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth), 'the name is whole').toBe(
      true,
    );

    let previousRight = reviewBox.x + reviewBox.width - 1;
    for (let index = 0; index < 2; index++) {
      const chip = chips.nth(index);
      await expect(chip).toBeVisible();
      const chipBox = await chip.boundingBox();
      expect(
        Math.abs(centre(chipBox) - centre(reviewBox)),
        `chip ${index} shares row two`,
      ).toBeLessThanOrEqual(6);
      expect(chipBox.x, `chip ${index} follows the review words`).toBeGreaterThanOrEqual(
        previousRight,
      );
      expect(chipBox.x).toBeGreaterThanOrEqual(card.x);
      expect(chipBox.x + chipBox.width).toBeLessThanOrEqual(card.x + card.width + 0.5);
      expect(chipBox.x + chipBox.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
      expect(
        await chip.evaluate((el) => el.scrollWidth <= el.clientWidth),
        `chip ${index} is whole`,
      ).toBe(true);
      previousRight = chipBox.x + chipBox.width;
    }
    expect(await sidewaysScroll(page)).toBe(false);
  });

  test('when the line is squeezed the review words truncate and the chips keep their size @regression', async ({
    page,
    dashboard,
  }) => {
    await openFollowUps(page, dashboard);
    const line = prLine(page, 'TAP-9410', BILLING, 1234);
    await line.scrollIntoViewIfNeeded();
    const { review, chips } = parts(line);
    await expect(chips).toHaveCount(2);
    const natural = [await chips.nth(0).boundingBox(), await chips.nth(1).boundingBox()];
    await line.evaluate((element) => {
      element.style.width = '200px';
      element.style.maxWidth = '200px';
    });
    const box = await line.boundingBox();
    expect(box.width).toBeLessThanOrEqual(200.5);
    expect(
      await review.evaluate((el) => el.scrollWidth > el.clientWidth),
      'the review words give way first',
    ).toBe(true);
    const clipping = await review.evaluate((el) => {
      const style = getComputedStyle(el);
      return { overflowX: style.overflowX, textOverflow: style.textOverflow };
    });
    expect(['hidden', 'clip'], 'the words are cut off, not painted over the chips').toContain(
      clipping.overflowX,
    );
    expect(clipping.textOverflow).toBe('ellipsis');
    const reviewBox = await review.boundingBox();
    const firstChip = await chips.nth(0).boundingBox();
    expect(
      reviewBox.x + reviewBox.width,
      'the words end before the first chip',
    ).toBeLessThanOrEqual(firstChip.x + 0.5);
    for (let index = 0; index < 2; index++) {
      const chip = chips.nth(index);
      const chipBox = await chip.boundingBox();
      expect(chipBox.width, `chip ${index} keeps its width`).toBeGreaterThanOrEqual(
        natural[index].width - 0.5,
      );
      expect(chipBox.x + chipBox.width, `chip ${index} stays inside the line`).toBeLessThanOrEqual(
        box.x + box.width + 0.5,
      );
      expect(await chip.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
  });
});

// The Slack chip shows an attached Claude session.

test('an attached thread is filled, coloured and worded, and an unattached one on the same card is not @regression', async ({
  page,
  dashboard,
}) => {
  await openFollowUps(page, dashboard);
  const card = page.getByTestId('my-tickets-item-TAP-9430');
  const attached = card.getByTestId(`slack-thread-link-${FOLLOW_UP_THREAD_TS.attached}`);
  const unattached = card.getByTestId(`slack-thread-link-${FOLLOW_UP_THREAD_TS.unattached}`);
  await expect(attached).toBeVisible();
  await expect(unattached).toBeVisible();

  await expect(attached).toHaveAttribute('data-attached', 'true');
  await expect(attached).toHaveAttribute('aria-label', /Claude session attached/);
  await expect(attached).toHaveAttribute('data-tooltip', /Claude session attached/);
  await expect(attached).toHaveAttribute('aria-label', /2 replies/);
  await expect(unattached).not.toHaveAttribute('data-attached', 'true');
  await expect(unattached).not.toHaveAttribute('aria-label', /Claude session/);
  await expect(unattached).not.toHaveAttribute('data-tooltip', /Claude session/);
  await expect(unattached).toHaveAttribute('aria-label', /2 replies/);

  // The words are in the label only: the chip still shows just the reply count.
  await expect(attached).toHaveText('2');
  await expect(unattached).toHaveText('2');

  // Shape: the bubble is filled when attached and an outline when not.
  const filled = (chip) =>
    chip
      .locator('svg path')
      .evaluateAll((paths) => paths.some((path) => getComputedStyle(path).fill !== 'none'));
  expect(await filled(attached), 'the attached bubble is filled').toBe(true);
  expect(await filled(unattached), 'the unattached bubble is an outline').toBe(false);
  // Colour is the third cue, and it is the one token that means nothing else on the card.
  expect(await colorOf(attached)).toBe(await tokenColor(page, '--support'));
  expect(await colorOf(unattached)).not.toBe(await tokenColor(page, '--support'));
  expect(await attached.evaluate((element) => element.tagName)).toBe('BUTTON');
});

test('two attached threads on one card each say how many sessions, and every chip stays 24 by 24 @regression', async ({
  page,
  dashboard,
}) => {
  await openFollowUps(page, dashboard);
  const card = page.getByTestId('my-tickets-item-TAP-9431');
  const two = card.getByTestId(`slack-thread-link-${FOLLOW_UP_THREAD_TS.pairTwo}`);
  const one = card.getByTestId(`slack-thread-link-${FOLLOW_UP_THREAD_TS.pairOne}`);
  for (const chip of [two, one]) {
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute('data-attached', 'true');
  }
  await expect(two).toHaveAttribute('aria-label', /2 Claude sessions attached/);
  await expect(one).toHaveAttribute('aria-label', /Claude session attached/);
  await expect(one).not.toHaveAttribute('aria-label', /sessions/);

  const everyChip = page.locator('[data-testid^="slack-thread-link-"]');
  expect(await everyChip.count()).toBeGreaterThanOrEqual(7);
  for (const box of await everyChip.evaluateAll((chips) =>
    chips.map((chip) => {
      const { width, height } = chip.getBoundingClientRect();
      return { id: chip.dataset.testid, width, height };
    }),
  )) {
    expect(box.width, box.id).toBeGreaterThanOrEqual(24);
    expect(box.height, box.id).toBeGreaterThanOrEqual(24);
  }
  await expect(page.locator('[data-attached="true"]')).toHaveCount(5);
});

test('with the watcher unavailable no chip is attached, whether the count is 0 or missing @regression', async ({
  page,
  dashboard,
}) => {
  ticketBoardData(dashboard.data);
  withFollowUpCases(dashboard.data);
  const rows = dashboard.data.slack.threads.started;
  rows.forEach((row, index) => {
    if (index % 2) delete row.attachedSessions;
    else row.attachedSessions = 0;
  });
  await openBoard(page);
  await expect(page.getByTestId('my-tickets-item-TAP-9430')).toBeVisible();
  expect(await page.locator('[data-testid^="slack-thread-link-"]').count()).toBe(rows.length);
  await expect(page.locator('[data-attached]')).toHaveCount(0);
  await expect(
    page.locator('[data-testid^="slack-thread-link-"][aria-label*="Claude session"]'),
  ).toHaveCount(0);
});

// An attach made in the dialog shows when it closes.

test('closing the thread dialog refreshes the attached state with one threads read, and the board never reads the watch list @regression', async ({
  page,
  dashboard,
}) => {
  const data = ticketBoardData(dashboard.data);
  await openBoard(page);
  const { quiet } = BOARD_THREAD_TS;
  const chip = slackChip(page, quiet);
  await expect(chip).toBeVisible();
  await expect(chip).not.toHaveAttribute('data-attached', 'true');
  await settle(page);
  const loaded = slackThreadReads(dashboard);
  expect(loaded, 'one ticket load, one threads read').toBe(1);
  expect(slackWatchReads(dashboard), 'the board does not read the watch list').toBe(0);

  await chip.click();
  const dialog = page.getByTestId('slack-thread-dialog');
  await expect(dialog).toBeVisible();
  // The dialog reads the watch list for its own session section, once, as it always has.
  await expect.poll(() => slackWatchReads(dashboard)).toBe(1);
  // An attach made in the dialog: the next threads answer carries it.
  data.slack.threads.started.find((row) => row.ts === quiet).attachedSessions = 1;
  await settle(page);
  expect(slackThreadReads(dashboard), 'nothing is read while the dialog is open').toBe(loaded);

  await dialog.getByTestId('slack-thread-close').click();
  await expect(page.getByTestId('slack-thread-dialog')).toHaveCount(0);
  await expect.poll(() => slackThreadReads(dashboard)).toBe(loaded + 1);
  await expect(chip).toHaveAttribute('data-attached', 'true');
  await expect(chip).toHaveAttribute('aria-label', /Claude session attached/);
  await settle(page);
  expect(slackThreadReads(dashboard), 'exactly one read follows the close').toBe(loaded + 1);
  expect(slackWatchReads(dashboard), 'no watch read from the board').toBe(1);
});

// Slack never blocks the tickets.

test('a Slack outage leaves the cards and draws no chip, attached or not @regression', async ({
  page,
  dashboard,
}) => {
  ticketBoardData(dashboard.data);
  withFollowUpCases(dashboard.data);
  await page.route('**/api/slack/threads*', (route) =>
    route.fulfill({ status: 503, body: 'Unavailable' }),
  );
  await openBoard(page);
  await expect(page.getByTestId('my-tickets-item-TAP-9001')).toBeVisible();
  await expect(page.getByTestId('my-tickets-error')).toHaveCount(0);
  await expect(page.locator('[data-testid^="slack-thread-link-"]')).toHaveCount(0);
  await expect(page.locator('[data-attached]')).toHaveCount(0);
  await expect(prLine(page, 'TAP-9001', API, 812)).toBeVisible();
});

// The green card.

const GREEN_CARDS = [
  'TAP-9002',
  'TAP-9006',
  'TAP-9007',
  'TAP-9008',
  'TAP-9420',
  'TAP-9424',
  'TAP-9425',
  'TAP-9426',
];
const PLAIN_CARDS = [
  'TAP-9001',
  'TAP-9003',
  'TAP-9004',
  'TAP-9005',
  'TAP-9100',
  'TAP-9200',
  'TAP-9401',
  'TAP-9405',
  'TAP-9406',
  'TAP-9410',
  'TAP-9421',
  'TAP-9422',
  'TAP-9423',
  'TAP-9430',
];

test('exactly the cards whose every open PR is approved carry the green mark and the seal @regression', async ({
  page,
  dashboard,
}) => {
  await openFollowUps(page, dashboard);
  const flagged = await page
    .locator('[data-all-approved="true"]')
    .evaluateAll((cards) => cards.map((card) => card.dataset.testid).sort());
  expect(flagged).toEqual(GREEN_CARDS.map((key) => `my-tickets-item-${key}`).sort());

  for (const key of GREEN_CARDS) {
    const card = page.getByTestId(`my-tickets-item-${key}`);
    const seal = card.getByTestId(`my-tickets-item-approved-${key}`);
    await expect(card, key).toHaveAttribute('data-all-approved', 'true');
    await expect(seal, key).toBeVisible();
    await expect(seal, key).toHaveAttribute('role', 'img');
    await expect(seal, key).toHaveAccessibleName('All PRs approved');
    await expect(seal, key).toHaveAttribute('data-tooltip', 'All PRs approved');
  }
  for (const key of PLAIN_CARDS) {
    const card = page.getByTestId(`my-tickets-item-${key}`);
    await expect(card, key).toBeVisible();
    await expect(card, key).not.toHaveAttribute('data-all-approved', 'true');
    await expect(page.getByTestId(`my-tickets-item-approved-${key}`), key).toHaveCount(0);
  }
  await expect(page.locator('[data-testid^="my-tickets-item-approved-"]')).toHaveCount(
    GREEN_CARDS.length,
  );
});

test('a card with no PR is never green, and with PR status unavailable no card is @regression', async ({
  page,
  dashboard,
}) => {
  ticketBoardData(dashboard.data, { available: false });
  await openBoard(page);
  await expect(page.getByTestId('my-tickets-item-TAP-9002')).toBeVisible();
  await expect(page.getByTestId('my-tickets-item-TAP-9004')).toBeVisible();
  await expect(page.locator('[data-all-approved]')).toHaveCount(0);
  await expect(page.locator('[data-testid^="my-tickets-item-approved-"]')).toHaveCount(0);
});

test('a card turns green on a refresh that approves its last open PR, and back when it is not @regression', async ({
  page,
  dashboard,
}) => {
  ticketBoardData(dashboard.data);
  const data = withFollowUpCases(dashboard.data);
  await openBoard(page);
  const card = page.getByTestId('my-tickets-item-TAP-9421');
  await expect(card).toBeVisible();
  await expect(card).not.toHaveAttribute('data-all-approved', 'true');
  const [first, second] = data.ticketPrs.byTicket['TAP-9421'];
  second.review = { ...first.review };
  await page.getByTestId('my-tickets-refresh').click();
  await expect(card).toHaveAttribute('data-all-approved', 'true');
  await expect(page.getByTestId('my-tickets-item-approved-TAP-9421')).toBeVisible();

  second.review = { state: 'changes_requested', approvals: 0 };
  await expect(page.getByTestId('my-tickets-refresh')).toBeEnabled();
  await page.getByTestId('my-tickets-refresh').click();
  await expect(card).not.toHaveAttribute('data-all-approved', 'true');
  await expect(page.getByTestId('my-tickets-item-approved-TAP-9421')).toHaveCount(0);
});

// Contrast on the green card.

// Every text and glyph colour inside `card` against the card's own computed background, as WCAG
// contrast ratios. A translucent colour is composited over the card background first.
const contrastOf = (card) =>
  card.evaluate((root) => {
    const parse = (css) => {
      const match = /^(rgba?|color)\((.+)\)$/.exec(css.trim());
      if (!match) throw new Error(`unreadable colour: ${css}`);
      const numbers = match[2]
        .replace('srgb', '')
        .replace('/', ' ')
        .split(/[\s,]+/)
        .filter(Boolean)
        .map(Number);
      return match[1] === 'color'
        ? [numbers[0] * 255, numbers[1] * 255, numbers[2] * 255, numbers[3] ?? 1]
        : [numbers[0], numbers[1], numbers[2], numbers[3] ?? 1];
    };
    const channel = (value) => {
      const unit = value / 255;
      return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
    };
    const luminance = ([r, g, b]) =>
      0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    const blend = ([r, g, b, a], [br, bg, bb]) => [
      r * a + br * (1 - a),
      g * a + bg * (1 - a),
      b * a + bb * (1 - a),
    ];
    const background = parse(getComputedStyle(root).backgroundColor);
    const opacityOf = (element) => {
      let opacity = 1;
      for (let node = element; node && node !== root.parentElement; node = node.parentElement) {
        opacity *= Number(getComputedStyle(node).opacity);
      }
      return opacity;
    };
    const entries = [];
    const consider = (element, label) => {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) return;
      const [r, g, b, a] = parse(getComputedStyle(element).color);
      const painted = blend([r, g, b, a * opacityOf(element)], background);
      const ratio =
        (Math.max(luminance(painted), luminance(background)) + 0.05) /
        (Math.min(luminance(painted), luminance(background)) + 0.05);
      entries.push({ label, ratio });
    };
    const labelOf = (element) =>
      element.closest('[data-testid]')?.dataset.testid ?? element.className ?? element.tagName;
    for (const element of root.querySelectorAll('*')) {
      const ownText = [...element.childNodes].some(
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim() !== '',
      );
      if (ownText || element instanceof SVGSVGElement) consider(element, labelOf(element));
    }
    return { background: background, entries };
  });

test('every text and glyph on an all-approved card keeps a contrast of 4.5 or better against its tinted background @regression', async ({
  page,
  dashboard,
}) => {
  await openFollowUps(page, dashboard);
  const green = page.getByTestId('my-tickets-item-TAP-9426');
  const plain = page.getByTestId('my-tickets-item-TAP-9401');
  await expect(green).toHaveAttribute('data-all-approved', 'true');
  await expect(slackChip(page, FOLLOW_UP_THREAD_TS.green)).toHaveAttribute('data-attached', 'true');
  await expect(commentChip(page, 'human', 'TAP-9426', API, 442)).toHaveAttribute(
    'data-comment-state',
    'open',
  );
  await expect(commentChip(page, 'copilot', 'TAP-9426', API, 442)).toHaveAttribute(
    'data-comment-state',
    'resolved',
  );

  const tinted = await contrastOf(green);
  const untinted = await contrastOf(plain);
  const [r, g, b, a] = tinted.background;
  expect(a, 'the tint is opaque, so the ratios are against one colour').toBe(1);
  expect(g, 'the tint is green').toBeGreaterThan(r);
  expect(g).toBeGreaterThan(b);
  expect(tinted.background, 'the card is not the plain card colour').not.toEqual(
    untinted.background,
  );

  const labels = tinted.entries.map((entry) => entry.label);
  for (const expected of [
    'my-tickets-item-link-TAP-9426',
    'my-tickets-item-summary-TAP-9426',
    `slack-thread-link-${FOLLOW_UP_THREAD_TS.green}`,
    `my-tickets-pr-comments-human-TAP-9426-${slugOf(API)}-442`,
    `my-tickets-pr-comments-copilot-TAP-9426-${slugOf(API)}-442`,
    'my-tickets-item-approved-TAP-9426',
  ]) {
    expect(labels, `${expected} is among the measured colours`).toContain(expected);
  }
  expect(tinted.entries.length).toBeGreaterThanOrEqual(10);
  for (const { label, ratio } of tinted.entries) {
    expect(ratio, `${label} on the green card`).toBeGreaterThanOrEqual(4.5);
  }
});

// The green card reads apart from the other greens.

const shadowLayers = (value) => {
  const layers = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === '(') depth++;
    else if (value[index] === ')') depth--;
    else if (value[index] === ',' && depth === 0) {
      layers.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  layers.push(value.slice(start).trim());
  return layers.filter((layer) => layer && layer !== 'none');
};
const hasRail = (layers) =>
  layers.some((layer) => layer.includes('inset') && /\b2px 0px 0px(?: 0px)?\b/.test(layer));
const shadowOf = async (locator) =>
  shadowLayers(await locator.evaluate((element) => getComputedStyle(element).boxShadow));

test('the seal is not the CI check, and a green card keeps the current-sprint rail @regression', async ({
  page,
  dashboard,
}) => {
  await openFollowUps(page, dashboard);
  const card = page.getByTestId('my-tickets-item-TAP-9002');
  const seal = card.getByTestId('my-tickets-item-approved-TAP-9002');
  await expect(seal).toBeVisible();
  const ciCheck = await firstGlyph(prLine(page, 'TAP-9002', WEB, 904));
  const sealGlyph = await firstGlyph(seal);
  expect(sealGlyph).not.toBe('');
  expect(sealGlyph, 'the seal is not the CI check').not.toBe(ciCheck);

  const sprintPlain = await shadowOf(page.getByTestId('my-tickets-item-TAP-9001'));
  const sprintGreen = await shadowOf(card);
  const otherPlain = await shadowOf(page.getByTestId('my-tickets-item-TAP-9004'));
  const otherGreen = await shadowOf(page.getByTestId('my-tickets-item-TAP-9426'));
  await expect(card).toHaveAttribute('data-in-current-sprint', 'true');
  expect(hasRail(sprintPlain), 'a current-sprint card has its accent rail').toBe(true);
  expect(hasRail(sprintGreen), 'a green current-sprint card keeps it').toBe(true);
  expect(hasRail(otherPlain)).toBe(false);
  expect(hasRail(otherGreen), 'a green card of another sprint gets no rail').toBe(false);
  expect(sprintGreen.length, 'the green hairline is added to the stack').toBeGreaterThan(
    sprintPlain.length,
  );
  expect(otherGreen.length).toBeGreaterThan(otherPlain.length);
});

test('a green card in the Done column leaves the column rule and the column background alone @regression', async ({
  page,
  dashboard,
}) => {
  ticketBoardData(dashboard.data);
  withFollowUpCases(dashboard.data);
  await openBoard(page);
  await page.getByTestId('my-tickets-include-done').check();
  const done = page.getByTestId(columnId('', 'Done'));
  await expect(done).toBeVisible();
  const card = done.getByTestId('my-tickets-item-TAP-9427');
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-all-approved', 'true');
  await expect(card.getByTestId('my-tickets-item-approved-TAP-9427')).toBeVisible();

  const green = await tokenColor(page, '--green');
  const head = page.getByTestId(columnId('head', 'Done'));
  const rule = await head.evaluate((element) => getComputedStyle(element).boxShadow);
  expect(rule, 'the Done column keeps its green rule').toContain(green);
  const backgroundOf = (locator) =>
    locator.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(await backgroundOf(done), 'the tint marks the card, not the column').toBe(
    await backgroundOf(page.getByTestId(columnId('', 'In Progress'))),
  );
  const plain = done.getByTestId('my-tickets-item-TAP-9300');
  await expect(plain).toBeVisible();
  await expect(plain).not.toHaveAttribute('data-all-approved', 'true');
  expect(await backgroundOf(card), 'the green card differs from a plain Done card').not.toBe(
    await backgroundOf(plain),
  );
});

// -- a change request keeps a card plain; the details of the attached chip, the comment chips and the
// card transition ------------------------------------------------------------------------------------------

// A change request outranks approvals. The fixture ticket TAP-9422 holds one approved PR and one that
// reads changes requested.
test('a card with one approved PR and one that reads changes requested is not green, and each line says its own state @regression', async ({
  page,
  dashboard,
}) => {
  await openFollowUps(page, dashboard);
  const card = page.getByTestId('my-tickets-item-TAP-9422');
  const plain = page.getByTestId('my-tickets-item-TAP-9401');
  const review = (number) => prLine(page, 'TAP-9422', API, number).locator('.my-tickets-pr-review');
  await expect(review(424)).toHaveText('approved');
  await expect(review(425)).toHaveText('changes requested');
  await expect(prLine(page, 'TAP-9422', API, 425)).toHaveAccessibleName(/changes requested/);

  await expect(card).not.toHaveAttribute('data-all-approved', 'true');
  await expect(card.getByTestId('my-tickets-item-approved-TAP-9422')).toHaveCount(0);
  const backgroundOf = (locator) =>
    locator.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(await backgroundOf(card), 'no green tint').toBe(await backgroundOf(plain));
  // The control: the same two lines both approved make a green card.
  await expect(page.getByTestId('my-tickets-item-TAP-9420')).toHaveAttribute(
    'data-all-approved',
    'true',
  );
});

test('the attached bubble is painted: its fill is a visible colour, and the unattached bubble has none @regression', async ({
  page,
  dashboard,
}) => {
  await openFollowUps(page, dashboard);
  const card = page.getByTestId('my-tickets-item-TAP-9430');
  const attached = card.getByTestId(`slack-thread-link-${FOLLOW_UP_THREAD_TS.attached}`);
  const unattached = card.getByTestId(`slack-thread-link-${FOLLOW_UP_THREAD_TS.unattached}`);
  await expect(attached).toHaveAttribute('data-attached', 'true');
  const paint = (chip) =>
    chip.locator('svg path').evaluate((path) => {
      const style = getComputedStyle(path);
      return { fill: style.fill, fillOpacity: Number(style.fillOpacity) };
    });
  const filled = await paint(attached);
  const outline = await paint(unattached);
  expect(filled.fill, 'the attached bubble has a fill colour').not.toBe('none');
  expect(filled.fillOpacity, 'and it is not painted at zero opacity').toBeGreaterThan(0);
  expect(filled.fillOpacity).toBeLessThanOrEqual(1);
  expect(filled.fill, 'the fill takes the chip colour').toBe(await colorOf(attached));
  expect(outline.fill, 'the unattached bubble is an outline').toBe('none');
  expect(filled).not.toEqual(outline);
});

test('the comment chips are hidden from assistive tech, and the PR line names them in words instead @regression', async ({
  page,
  dashboard,
}) => {
  await openFollowUps(page, dashboard);
  const line = prLine(page, 'TAP-9403', API, 403);
  const human = commentChip(page, 'human', 'TAP-9403', API, 403);
  const copilot = commentChip(page, 'copilot', 'TAP-9403', API, 403);
  for (const chip of [human, copilot]) {
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute('aria-hidden', 'true');
  }
  await expect(line).toHaveAccessibleName(/Human: 1 unresolved, 2 resolved, 5 comments/);
  await expect(line).toHaveAccessibleName(/Copilot: 2 unresolved, 0 resolved, 4 comments/);
  // What the accessibility tree exposes under the link: the review words, and not the chips' bare
  // "1/3" and "2/2" (the words are the link's name).
  const tree = await line.ariaSnapshot();
  expect(tree).toContain('awaiting');
  expect(tree).not.toContain('1/3');
  expect(tree).not.toContain('2/2');
});

test('a chip whose threads are all resolved draws a check beside its author glyph, and an open chip does not @regression', async ({
  page,
  dashboard,
}) => {
  await openFollowUps(page, dashboard);
  const glyphs = (chip) =>
    chip.locator('svg').evaluateAll((svgs) => svgs.map((svg) => svg.innerHTML));
  const ciCheck = await firstGlyph(prLine(page, 'TAP-9401', API, 401));
  const resolved = [
    commentChip(page, 'copilot', 'TAP-9402', API, 402),
    commentChip(page, 'human', 'TAP-9404', API, 404),
    commentChip(page, 'copilot', 'TAP-9404', API, 404),
  ];
  for (const chip of resolved) {
    await expect(chip).toHaveAttribute('data-comment-state', 'resolved');
    const drawn = await glyphs(chip);
    expect(drawn, 'the author glyph, then the check').toHaveLength(2);
    expect(drawn[1], 'a check, the same stroke as the CI check').toBe(ciCheck);
    expect(drawn[1]).not.toBe(drawn[0]);
  }
  const open = [
    commentChip(page, 'human', 'TAP-9401', API, 401),
    commentChip(page, 'human', 'TAP-9403', API, 403),
    commentChip(page, 'copilot', 'TAP-9403', API, 403),
    commentChip(page, 'human', 'TAP-9408', API, 408),
  ];
  for (const chip of open) {
    await expect(chip).toHaveAttribute('data-comment-state', 'open');
    expect(await glyphs(chip), 'the author glyph alone').toHaveLength(1);
  }
});

// Every glyph the board draws shares one frame. Without its stroke a glyph is invisible, without its
// size it fills the card, and without its hiding it is read out as an unnamed graphic.
test('every board glyph is stroked in its text colour, a small square, and hidden from assistive tech @regression', async ({
  page,
  dashboard,
}) => {
  await openFollowUps(page, dashboard);
  const glyphs = page.locator('[data-testid^="my-tickets-item-"] svg[viewBox="0 0 16 16"]');
  expect(await glyphs.count(), 'the cards draw glyphs').toBeGreaterThan(10);
  const frames = await glyphs.evaluateAll((svgs) =>
    svgs.map((svg) => {
      const style = getComputedStyle(svg);
      const box = svg.getBoundingClientRect();
      return {
        stroke: style.stroke,
        color: style.color,
        strokeWidth: parseFloat(style.strokeWidth),
        width: box.width,
        height: box.height,
        inChip: svg.closest('[data-testid^="my-tickets-pr-comments-"]') !== null,
        hidden: svg.closest('[aria-hidden="true"]') !== null,
      };
    }),
  );
  for (const frame of frames) {
    expect(frame.stroke, 'stroked in the text colour').toBe(frame.color);
    expect(frame.strokeWidth, 'a line weight of 1.6 or 1.8').toBeGreaterThanOrEqual(1.5);
    expect(frame.strokeWidth).toBeLessThanOrEqual(2);
    expect(frame.width, 'a square, 11 px in a comment chip and 14 px elsewhere').toBe(
      frame.inChip ? 11 : 14,
    );
    expect(frame.height).toBe(frame.width);
    expect(frame.hidden, 'hidden from assistive tech').toBe(true);
  }
  expect(
    frames.some((frame) => frame.inChip),
    'the chips are covered',
  ).toBe(true);
});

// The card eases its background over 150 ms, and a user who asks for reduced motion gets none.
const transitionOf = (card) =>
  card.evaluate((element) => {
    const style = getComputedStyle(element);
    const seconds = (list) => list.split(',').map((item) => parseFloat(item));
    return {
      properties: style.transitionProperty.split(',').map((name) => name.trim()),
      durations: seconds(style.transitionDuration),
    };
  });

test('a card eases its background in 200 ms or less, and not at all when reduced motion is asked for @regression', async ({
  page,
  dashboard,
}) => {
  await openFollowUps(page, dashboard);
  const cards = ['TAP-9401', 'TAP-9426'].map((key) => page.getByTestId(`my-tickets-item-${key}`));
  for (const card of cards) await expect(card).toBeVisible();
  await expect(cards[1]).toHaveAttribute('data-all-approved', 'true');

  for (const card of cards) {
    const { properties, durations } = await transitionOf(card);
    expect(properties, 'the background colour is what eases').toContain('background-color');
    for (const duration of durations) {
      expect(duration, 'there is a transition').toBeGreaterThan(0);
      expect(duration, 'and it is 200 ms or shorter').toBeLessThanOrEqual(0.2);
    }
  }

  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const card of cards) {
    const { durations } = await transitionOf(card);
    expect(durations, 'reduced motion removes the transition').toEqual(durations.map(() => 0));
  }
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  expect((await transitionOf(cards[0])).durations[0]).toBeGreaterThan(0);
});
