import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test, expect, seedVelocitySnapshot } from './fixtures.js';

// prettier-ignore
const screenshots = fileURLToPath(new URL('../../docs/dev-dashboard-redesign/verification/screenshots', import.meta.url));
const prScreenshots = fileURLToPath(
  new URL('../.orchestrator/pr-review-kanban/scratch/screenshots/', import.meta.url),
);
for (const [width, height] of [
  [1440, 900],
  [1024, 768],
  [390, 844],
]) {
  for (const route of ['home', 'services', 'prs', 'my-tickets']) {
    test(`mocked ${route} presentation ${width} @regression`, async ({
      page,
      dashboard,
    }, testInfo) => {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      if (route === 'home') await seedVelocitySnapshot(page, dashboard.data.teamVelocity);
      await page.goto(`/#/${route}`);
      const ready = {
        home: 'home-velocity-chart',
        services: 'log-api',
        prs: 'prs-ticket-DEMO-1',
        'my-tickets': 'my-tickets-item-sample-active',
      };
      await expect(page.getByTestId(ready[route])).not.toBeEmpty();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      if (route === 'home') {
        await expect(page.getByTestId('home-title')).toHaveText('Velocity');
        await expect(page.getByTestId('home-velocity-team')).toHaveAccessibleName('Team');
        await expect(page.getByTestId('home-velocity-team')).toHaveValue('Nexus');
        await expect(page.getByTestId('home-refresh')).toBeVisible();
        const pane = page.getByTestId('home-list').locator('.board-pane');
        await expect(pane).toHaveCount(1);
        await expect(pane.getByTestId('home-velocity-chart')).toContainText('Nexus Sprint 2');
        for (const id of [
          'home-actions-block',
          'home-services-block',
          'home-kpi-row',
          'home-sprint-block',
        ]) {
          await expect(page.getByTestId(id)).toHaveCount(0);
        }
      }
      if (route === 'prs') {
        await expect(page.getByTestId('prs-board').getByRole('group')).toHaveCount(4);
        const column = await page.getByTestId('prs-column-to-review').boundingBox();
        expect(column.width).toBeCloseTo(width <= 599 ? width * 0.82 : 280, 0);
      }
      const directory = route === 'prs' ? prScreenshots : screenshots;
      await mkdir(directory, { recursive: true });
      const path = `${directory}/mocked-${route}-${width}.png`;
      await page.screenshot({ path, fullPage: true });
      await testInfo.attach(`Mocked ${route} ${width}`, { path, contentType: 'image/png' });
    });
  }
}

test('long velocity team and sprint names and coverage warnings fit mobile @regression', async ({
  page,
  dashboard,
}, testInfo) => {
  const teamName = 'VeryLongUnbrokenTeamName'.repeat(5);
  const sprintName = 'VeryLongUnbrokenWorkspaceSprintName'.repeat(5);
  const board = dashboard.data.teamVelocity.boards.find(({ name }) => name === 'Nexus');
  board.name = teamName;
  for (const entry of board.series) entry.sprint.name = `${sprintName} ${entry.sprint.id}`;
  for (const person of board.people) {
    for (const [index, entry] of person.series.entries()) {
      entry.sprint = { ...board.series[index].sprint };
    }
  }
  dashboard.data.teamVelocity.coverage.possibleTruncation = true;
  await seedVelocitySnapshot(page, dashboard.data.teamVelocity);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/home');
  await page.getByTestId('home-velocity-team').selectOption(teamName);
  await expect(page.getByTestId('home-velocity-team')).toHaveValue(teamName);
  await expect(page.getByTestId('home-velocity-data')).toContainText(sprintName);
  await expect(page.getByTestId('home-velocity-coverage')).toBeVisible();
  await expect(page.getByTestId('home-velocity-coverage')).toContainText(/limit|5,?000/i);
  await expect(page.getByTestId('home-refresh')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await mkdir(screenshots, { recursive: true });
  const path = `${screenshots}/mocked-home-long-warnings-mobile.png`;
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach('Mocked long content', { path, contentType: 'image/png' });
});

test('empty workspace renders honest states @regression', async ({ page, dashboard }) => {
  dashboard.data.teamVelocity.boards = [];
  await seedVelocitySnapshot(page, dashboard.data.teamVelocity);
  await page.goto('/#/home');
  await expect(page.getByTestId('home-velocity-empty')).toHaveText(
    'No velocity history for Nexus.',
  );
  await expect(page.getByTestId('home-velocity-team')).toHaveValue('Nexus');
  await expect(page.getByTestId('home-velocity-chart')).toHaveCount(0);
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: `${screenshots}/mocked-home-empty.png`, fullPage: true });
});

test('stale content stays legible with source warning @regression', async ({ page, dashboard }) => {
  await seedVelocitySnapshot(page, dashboard.data.teamVelocity);
  await page.goto('/#/home');
  await expect(page.getByTestId('home-velocity-chart')).toContainText('Nexus Sprint 2');
  await page.route('**/api/team-velocity', (route) =>
    route.fulfill({ status: 503, body: 'Unavailable' }),
  );
  await page.getByTestId('home-refresh').click();
  await expect(page.getByTestId('home-velocity-stale')).toBeVisible();
  await expect(page.getByTestId('home-velocity-stale')).toContainText(
    /stale|last (successful|update)/i,
  );
  await expect(page.getByTestId('home-velocity-chart')).toContainText('Nexus Sprint 2');
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: `${screenshots}/mocked-home-stale.png`, fullPage: true });
});

test('double-size layout and keyboard focus remain usable with reduced motion @regression', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/#/services');
  await expect(page.getByTestId('log-api')).toContainText('line 120');
  await page.evaluate(() => {
    document.documentElement.style.zoom = '2';
  });
  if (!(await page.getByTestId('tab-services').isVisible()))
    await page.getByTestId('nav-tools-toggle').click();
  await page.getByTestId('tab-services').focus();
  await expect(page.getByTestId('tab-services')).toBeFocused();
  expect(
    await page.getByTestId('tab-services').evaluate((el) => getComputedStyle(el).outlineStyle),
  ).toBe('solid');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({
    path: `${screenshots}/mocked-services-double-size-focus.png`,
    fullPage: true,
  });
});

function denseReviewTickets(data, state = 'awaiting', firstNumber = 100) {
  const base = data.reviewTickets.tickets[0];
  const prs = Array.from({ length: 24 }, (_, index) => ({
    ...base.prs[0],
    number: index + firstNumber,
    title: `${index + 1}. Synthetic review change`,
    url: `https://example.invalid/pull/${index + firstNumber}`,
    draft: false,
    review: {
      complete: true,
      state,
      approvers: state === 'approved' ? ['reviewer'] : [],
      changesRequesters: [],
      reviewDecision: null,
    },
  }));
  data.reviewTickets.total = 2;
  data.reviewTickets.tickets = [
    {
      ...base,
      key: 'DEMO-100',
      summary: 'Tall ticket with twenty open PRs',
      prs: prs.slice(0, 20),
    },
    { ...base, key: 'DEMO-200', summary: 'Short ticket with four open PRs', prs: prs.slice(20) },
  ];
}

test('dense ticket PR lists retain consistent alignment inside one board column @regression', async ({
  page,
  dashboard,
}) => {
  denseReviewTickets(dashboard.data);
  await page.goto('/#/prs');
  const top = page.getByTestId('prs-pr-DEMO-100-example-workspace-100');
  const bottom = page.getByTestId('prs-pr-DEMO-100-example-workspace-119');
  await expect(top).toBeVisible();
  expect((await top.boundingBox()).x).toBe((await bottom.boundingBox()).x);
  expect((await top.boundingBox()).y).toBeLessThan((await bottom.boundingBox()).y);
  await expect(
    page.getByTestId('prs-column-to-review').getByTestId('prs-ticket-DEMO-100'),
  ).toContainText('20 PRs');
  await expect(page.getByTestId('prs-column-count-to-review')).toHaveText('2');
  expect(
    await page
      .getByTestId('prs-ticket-DEMO-100')
      .evaluate((element) => element.getClientRects().length),
  ).toBe(1);
  expect(
    await page
      .getByTestId('prs-column-body-to-review')
      .evaluate((element) => element.scrollHeight > element.clientHeight),
  ).toBe(true);
  await mkdir(prScreenshots, { recursive: true });
  await page.screenshot({ path: `${prScreenshots}/mocked-prs-dense.png`, fullPage: true });
});

test('PR review board retains exactly four fixed-width columns at wide viewports @regression', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1700, height: 900 });
  await page.goto('/#/prs');
  await expect(page.getByTestId('prs-ticket-DEMO-1')).toBeVisible();
  await expect(page.getByTestId('prs-board').getByRole('group')).toHaveCount(4);
  for (const lane of ['to-review', 'reviewing', 'reviewed'])
    expect((await page.getByTestId(`prs-column-${lane}`).boundingBox()).width).toBe(280);
});

test('review columns share a top edge and scroll-snap across breakpoints @regression', async ({
  page,
}) => {
  await page.goto('/#/prs');
  await expect(page.getByTestId('prs-ticket-DEMO-1')).toBeVisible();
  for (const width of [390, 599, 600, 1440, 1700]) {
    await page.setViewportSize({ width, height: 900 });
    const board = page.getByTestId('prs-board');
    await expect(board.getByRole('group')).toHaveCount(4);
    const boxes = await Promise.all(
      ['to-review', 'reviewing', 'reviewed'].map((lane) =>
        page.getByTestId(`prs-column-${lane}`).boundingBox(),
      ),
    );
    for (const box of boxes) {
      expect(box.width).toBeCloseTo(width <= 599 ? width * 0.82 : 280, 0);
      expect(box.y).toBe(boxes[0].y);
    }
    expect(boxes[1].x).toBeGreaterThan(boxes[0].x + boxes[0].width);
    expect(await board.evaluate((element) => getComputedStyle(element).overflowX)).toMatch(
      /auto|scroll/,
    );
    const snap = await board.evaluate((element) => getComputedStyle(element).scrollSnapType);
    if (width <= 599) expect(snap).toBe('x mandatory');
    else expect(['x', 'x proximity']).toContain(snap);
    if (width <= 599)
      expect(await board.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
        true,
      );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
});

test('reviewed ticket cards never split and their column scrolls independently @regression', async ({
  page,
  dashboard,
}) => {
  denseReviewTickets(dashboard.data, 'approved', 400);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/prs');
  const top = page.getByTestId('prs-pr-DEMO-100-example-workspace-400');
  const bottom = page.getByTestId('prs-pr-DEMO-100-example-workspace-419');
  await expect(top).toBeVisible();
  expect((await top.boundingBox()).x).toBe((await bottom.boundingBox()).x);
  expect((await top.boundingBox()).y).toBeLessThan((await bottom.boundingBox()).y);
  const body = page.getByTestId('prs-column-body-reviewed');
  const head = page.getByTestId('prs-column-head-reviewed');
  const headTop = (await head.boundingBox()).y;
  await expect(page.getByTestId('prs-column-count-reviewed')).toHaveText('2');
  expect(await body.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await body.evaluate((element) =>
    element.scrollTo({ top: element.scrollHeight, behavior: 'instant' }),
  );
  expect(await body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect((await head.boundingBox()).y).toBe(headTop);
  expect(
    await page.getByTestId('prs-column-body-to-review').evaluate((element) => element.scrollTop),
  ).toBe(0);
  const bodyBox = await body.boundingBox();
  const lastBox = await page.getByTestId('prs-ticket-DEMO-200').boundingBox();
  expect(lastBox.y).toBeGreaterThanOrEqual(bodyBox.y - 1);
  expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(bodyBox.y + bodyBox.height + 1);
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1)).toBe(
    true,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('my-tickets columns share one top edge and scroll inside the board @regression', async ({
  page,
  dashboard,
}) => {
  const ticket = (key, status) => ({
    key,
    summary: `Ticket ${key}`,
    status,
    statusCategory: status,
    storyPoints: null,
    sprints: [],
    sprint: null,
    updated: '2026-09-03T10:00:00Z',
    priority: 'Medium',
    issueType: 'Task',
  });
  // Two statuses, one column apiece: the board lays every column on one row, so they must start
  // at the same height at any width and the page itself must never scroll sideways.
  dashboard.data.tickets.tickets = [ticket('group-a', 'To Do'), ticket('group-b', 'In Progress')];

  for (const width of [390, 1440, 1700]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/#/my-tickets');
    await expect(page.getByTestId('my-tickets-item-group-a')).toBeVisible();
    const board = page.getByTestId('my-tickets-board');
    await expect(board).toBeVisible();
    const queued = await page.getByTestId('my-tickets-column-To-Do').boundingBox();
    const active = await page.getByTestId('my-tickets-column-In-Progress').boundingBox();
    expect(active.y, `columns share a top edge at ${width}`).toBe(queued.y);
    expect(active.x).toBeGreaterThan(queued.x);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    // The board is the scroller: it, not the page, would take any overflow.
    expect(await board.evaluate((el) => getComputedStyle(el).overflowX)).toMatch(/auto|scroll/);
  }
});

test('a tall column keeps its tickets in one column and scrolls inside itself @regression', async ({
  page,
  dashboard,
}) => {
  const ticket = (key, status) => ({
    key,
    summary: `Ticket ${key}`,
    status,
    statusCategory: 'In Progress',
    storyPoints: null,
    sprints: [],
    sprint: null,
    updated: '2026-09-03T10:00:00Z',
    priority: 'Medium',
    issueType: 'Task',
  });
  // Asymmetric split (20 vs 4) within one statusCategory: the tall status keeps all its tickets in
  // one column, and that column's body scrolls while its header stays put.
  const tall = Array.from({ length: 20 }, (_, index) => ticket(`tall-${index}`, 'In Progress'));
  const short = Array.from({ length: 4 }, (_, index) => ticket(`short-${index}`, 'In Review'));
  dashboard.data.tickets.tickets = [...tall, ...short];

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/my-tickets');
  const top = page.getByTestId('my-tickets-item-tall-0');
  const bottom = page.getByTestId('my-tickets-item-tall-19');
  await expect(top).toBeVisible();
  await expect(page.getByTestId('my-tickets-board')).toBeVisible();
  expect((await top.boundingBox()).x).toBe((await bottom.boundingBox()).x);
  expect((await top.boundingBox()).y).toBeLessThan((await bottom.boundingBox()).y);
  const body = page.getByTestId('my-tickets-column-body-In-Progress');
  const head = page.getByTestId('my-tickets-column-head-In-Progress');
  await expect(head).toBeVisible();
  const headTop = (await head.boundingBox()).y;
  expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await body.evaluate((el) => el.scrollTo({ top: el.scrollHeight, behavior: 'instant' }));
  await expect(head).toBeVisible();
  expect(Math.abs((await head.boundingBox()).y - headTop)).toBeLessThanOrEqual(1);
  const bodyBox = await body.boundingBox();
  const lastBox = await bottom.boundingBox();
  expect(lastBox.y).toBeGreaterThanOrEqual(bodyBox.y - 1);
  expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(bodyBox.y + bodyBox.height + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
