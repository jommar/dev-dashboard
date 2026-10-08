import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures.js';

// prettier-ignore
const screenshots = fileURLToPath(new URL('../../docs/dev-dashboard-redesign/verification/screenshots', import.meta.url));
for (const [width, height] of [
  [1440, 900],
  [1024, 768],
  [390, 844],
]) {
  for (const route of ['home', 'services', 'prs', 'my-tickets']) {
    test(`mocked ${route} presentation ${width} @regression`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(`/#/${route}`);
      const ready = {
        home: 'home-action-title-link-example/workspace-17',
        services: 'log-api',
        prs: 'pr-open-title-link-example/workspace-17',
        'my-tickets': 'my-tickets-item-sample-active',
      };
      await expect(page.getByTestId(ready[route])).not.toBeEmpty();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      if (route === 'home') {
        const expectedColumnCount = width >= 760 ? '2' : '1';
        expect(
          await page.evaluate(
            () => getComputedStyle(document.querySelector('.home-cols')).columnCount,
          ),
        ).toBe(expectedColumnCount);
      }
      if (route === 'prs' && width < 760) {
        // Unlike .home-cols (which leaves column-count unset below 960px),
        // .pr-open-groups sets `columns: 1` explicitly as its base rule, so
        // the resolved value below 760px is '1', not 'auto'.
        expect(
          await page.evaluate(
            () => getComputedStyle(document.querySelector('#prs-list')).columnCount,
          ),
        ).toBe('1');
      }
      await mkdir(screenshots, { recursive: true });
      const path = `${screenshots}/mocked-${route}-${width}.png`;
      await page.screenshot({ path, fullPage: true });
      await testInfo.attach(`Mocked ${route} ${width}`, { path, contentType: 'image/png' });
    });
  }
}

test('dense long content and sprint warnings fit mobile without losing actions @regression', async ({
  page,
  dashboard,
}, testInfo) => {
  const name = 'VeryLongUnbrokenWorkspaceSprintName'.repeat(5);
  dashboard.data.tickets.activeSprints[0].name = name;
  dashboard.data.tickets.truncated = true;
  dashboard.data.prs.prs[0].title = 'LongTitle'.repeat(30);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/home');
  await expect(page.getByTestId('home-sprint-truncated')).toBeVisible();
  await expect(page.getByTestId('home-actions')).toContainText('LongTitle');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await mkdir(screenshots, { recursive: true });
  const path = `${screenshots}/mocked-home-long-warnings-mobile.png`;
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach('Mocked long content', { path, contentType: 'image/png' });
});

test('empty workspace renders honest states @regression', async ({ page, dashboard }) => {
  dashboard.data.prs = {
    ...dashboard.data.prs,
    prs: [],
    groups: {},
    prsNeedingApprovals: [],
    approvalGroups: {},
  };
  dashboard.data.tickets = { tickets: [], activeSprints: [], allSprints: [], truncated: false };
  await page.goto('/#/home');
  await expect(page.getByTestId('home-actions-empty')).toBeVisible();
  await expect(page.getByTestId('home-sprint-none')).toBeVisible();
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: `${screenshots}/mocked-home-empty.png`, fullPage: true });
});

test('stale content stays legible with source warning @regression', async ({ page }) => {
  await page.goto('/#/home');
  await expect(page.getByTestId('home-actions')).toContainText('Improve keyboard');
  await page.route('**/api/prs', (route) => route.fulfill({ status: 503, body: 'Unavailable' }));
  await page.getByTestId('home-refresh').click();
  await expect(page.getByTestId('home-meta')).toContainText('GitHub stale');
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

test('dense grouped PR lists retain consistent alignment @regression', async ({
  page,
  dashboard,
}) => {
  const base = dashboard.data.prs.prs[0];
  const prs = Array.from({ length: 24 }, (_, index) => ({
    ...base,
    number: index + 100,
    title: `${index + 1}. ${base.title}`,
    url: `https://example.invalid/pull/${index + 100}`,
  }));
  dashboard.data.prs.prs = prs;
  // Asymmetric split: a large card (20 PRs) and a small one (4). Two equal-size
  // cards let the browser's column-balancer break exactly at the group
  // boundary regardless of break-inside, masking a regression; only an
  // asymmetric split forces the large card itself to fragment if the guard
  // is missing.
  dashboard.data.prs.groups = { Unticketed: prs.slice(0, 20), Workspace: prs.slice(20) };
  await page.goto('/#/prs');
  const top = page.getByTestId('pr-open-title-link-example/workspace-100');
  const bottom = page.getByTestId('pr-open-title-link-example/workspace-119');
  await expect(top).toBeVisible();
  // Top and bottom of the SAME (large) ticket-card: sharing an x proves the
  // card never split across columns, which is the load-bearing break-inside
  // guarantee.
  expect((await top.boundingBox()).x).toBe((await bottom.boundingBox()).x);
  expect((await top.boundingBox()).y).toBeLessThan((await bottom.boundingBox()).y);
  expect(
    await page.evaluate(() => getComputedStyle(document.querySelector('#prs-list')).columnCount),
  ).toBe('2');
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: `${screenshots}/mocked-prs-dense.png`, fullPage: true });
});

test('PR masonry reaches 3 columns at wide viewports @regression', async ({ page }) => {
  await page.setViewportSize({ width: 1700, height: 900 });
  await page.goto('/#/prs');
  await expect(page.getByTestId('pr-open-title-link-example/workspace-17')).toBeVisible();
  expect(
    await page.evaluate(() => getComputedStyle(document.querySelector('#prs-list')).columnCount),
  ).toBe('3');
});

test('approval groups column-pack across breakpoints @regression', async ({ page, dashboard }) => {
  const base = dashboard.data.prs.prs[0];
  const approvals = Array.from({ length: 2 }, (_, index) => ({
    ...base,
    number: 300 + index,
    title: `Approval candidate ${index + 1}`,
    url: `https://example.invalid/pull/${300 + index}`,
  }));
  dashboard.data.prs.prsNeedingApprovals = approvals;
  dashboard.data.prs.approvalGroups = { GroupA: [approvals[0]], GroupB: [approvals[1]] };

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/prs');
  await expect(page.getByTestId('pr-approval-count')).toHaveText('2');
  const columnCount = () =>
    page.evaluate(
      () => getComputedStyle(document.querySelector('.pr-approval-groups')).columnCount,
    );
  expect(await columnCount()).toBe('1');

  await page.setViewportSize({ width: 1440, height: 900 });
  expect(await columnCount()).toBe('2');

  await page.setViewportSize({ width: 1700, height: 900 });
  expect(await columnCount()).toBe('3');
});

test('approval card never splits across columns @regression', async ({ page, dashboard }) => {
  const base = dashboard.data.prs.prs[0];
  const approvals = Array.from({ length: 24 }, (_, index) => ({
    ...base,
    number: 400 + index,
    title: `${index + 1}. Approval item`,
    url: `https://example.invalid/pull/${400 + index}`,
  }));
  dashboard.data.prs.prsNeedingApprovals = approvals;
  // Asymmetric split (20 vs 4): equal-height groups let the column-balancer
  // break exactly at the group boundary regardless of break-inside, masking
  // a regression; only an asymmetric split forces the large card itself to
  // fragment if the guard is missing.
  dashboard.data.prs.approvalGroups = {
    TallGroup: approvals.slice(0, 20),
    ShortGroup: approvals.slice(20),
  };

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/prs');
  const top = page.getByTestId('pr-approval-title-link-example/workspace-400');
  const bottom = page.getByTestId('pr-approval-title-link-example/workspace-419');
  await expect(top).toBeVisible();
  // Top and bottom of the SAME (large) approval card: sharing an x proves the
  // card never split across columns, which is the load-bearing break-inside
  // guarantee.
  expect((await top.boundingBox()).x).toBe((await bottom.boundingBox()).x);
  expect((await top.boundingBox()).y).toBeLessThan((await bottom.boundingBox()).y);
  expect(
    await page.evaluate(
      () => getComputedStyle(document.querySelector('.pr-approval-groups')).columnCount,
    ),
  ).toBe('2');
});

test('my-tickets groups column-pack across breakpoints @regression', async ({
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
  // Two categories, one status group apiece: `.my-ticket-groups` is rendered
  // once per statusCategory section, so the fix must hold for every instance.
  dashboard.data.tickets.tickets = [ticket('group-a', 'To Do'), ticket('group-b', 'In Progress')];

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/my-tickets');
  await expect(page.getByTestId('my-tickets-item-group-a')).toBeVisible();
  const columnCounts = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.my-ticket-groups')].map(
        (el) => getComputedStyle(el).columnCount,
      ),
    );
  expect(await columnCounts()).toEqual(['1', '1']);

  await page.setViewportSize({ width: 1440, height: 900 });
  expect(await columnCounts()).toEqual(['2', '2']);

  await page.setViewportSize({ width: 1700, height: 900 });
  expect(await columnCounts()).toEqual(['3', '3']);
});

test('ticket group never splits across columns @regression', async ({ page, dashboard }) => {
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
  // Asymmetric split (20 vs 4) within one statusCategory, so both status
  // groups share a single `.my-ticket-groups` column context — same
  // rationale as the approval-card test above.
  const tall = Array.from({ length: 20 }, (_, index) => ticket(`tall-${index}`, 'In Progress'));
  const short = Array.from({ length: 4 }, (_, index) => ticket(`short-${index}`, 'In Review'));
  dashboard.data.tickets.tickets = [...tall, ...short];

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/my-tickets');
  const top = page.getByTestId('my-tickets-item-tall-0');
  const bottom = page.getByTestId('my-tickets-item-tall-19');
  await expect(top).toBeVisible();
  expect((await top.boundingBox()).x).toBe((await bottom.boundingBox()).x);
  expect((await top.boundingBox()).y).toBeLessThan((await bottom.boundingBox()).y);
  expect(
    await page.evaluate(
      () => getComputedStyle(document.querySelector('.my-ticket-groups')).columnCount,
    ),
  ).toBe('2');
});
