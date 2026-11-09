import { test, expect } from './fixtures.js';

test('draft tickets retain amber cues, wrapping sprints, working diff and draft-to-ready refresh on the board', async ({
  page,
  dashboard,
}) => {
  test.setTimeout(60_000);
  const sprint = {
    id: 8,
    name: 'Sprint <delivery> & ' + 'LongSprintName'.repeat(18),
    state: 'active',
    startDate: '2026-10-01',
    endDate: '2026-10-14',
  };
  const template = dashboard.data.reviewTickets.tickets[0];
  const prs = Array.from({ length: 8 }, (_, i) => ({
    number: i + 101,
    repo: 'example/workspace',
    owner: 'developer',
    draft: true,
    title: i === 0 ? 'Tall draft '.repeat(25) : `Draft change ${i + 1}`,
    url: `https://example.invalid/pull/${i + 101}`,
    updatedAt: '2026-10-06T12:00:00Z',
    review: {
      complete: true,
      state: 'awaiting',
      approvers: [],
      changesRequesters: [],
      reviewDecision: null,
    },
  }));
  const ready = {
    ...prs[1],
    number: 200,
    draft: false,
    title: 'Ready change',
  };
  const ticket = (key, pr) => ({
    ...template,
    key,
    summary: pr.title,
    sprint,
    sprints: [sprint],
    prs: [pr],
  });
  let payload = {
    ...dashboard.data.reviewTickets,
    total: 9,
    tickets: [...prs.map((pr, index) => ticket(`DEMO-${index + 1}`, pr)), ticket('DEMO-20', ready)],
  };
  let failRefresh = false;
  let releaseRefresh;
  let pendingRefresh;
  await page.route('**/api/review-tickets', async (route) => {
    if (pendingRefresh) await pendingRefresh;
    if (failRefresh) return route.fulfill({ status: 502, json: { error: 'Synthetic outage' } });
    await route.fulfill({ json: structuredClone(payload) });
  });
  await page.goto('/#/prs');
  const board = page.getByTestId('prs-board');
  await expect(board).toBeVisible();
  await expect(page.getByTestId('prs-filter-count')).toHaveText('9 of 9');
  await expect(board.locator('[data-tone="warn"]')).toHaveCount(8);
  await expect(page.getByTestId('prs-ticket-DEMO-20').locator('[data-tone="warn"]')).toHaveCount(0);
  const draftCard = page.getByTestId('prs-ticket-DEMO-1');
  const draftCue = draftCard.locator('[data-tone="warn"]');
  await expect(draftCue).toHaveText('Draft');
  const amber = await draftCue.evaluate((element) =>
    [...getComputedStyle(element).color.matchAll(/[\d.]+/g)].map((match) => Number(match[0])),
  );
  expect(amber[0]).toBeGreaterThan(amber[1]);
  expect(amber[1]).toBeGreaterThan(amber[2]);
  for (const width of [390, 599, 600, 759, 760, 1699, 1700]) {
    await page.setViewportSize({ width, height: 1000 });
    const columns = board.getByRole('group');
    await expect(columns).toHaveCount(3);
    const boxes = await Promise.all(
      ['to-review', 'reviewing', 'reviewed'].map((lane) =>
        page.getByTestId(`prs-column-${lane}`).boundingBox(),
      ),
    );
    for (const box of boxes) {
      expect(box.width, `column width at ${width}`).toBeCloseTo(
        width <= 599 ? width * 0.82 : 280,
        0,
      );
      expect(box.y).toBe(boxes[0].y);
    }
    expect(boxes[1].x - boxes[0].x).toBeGreaterThan(boxes[0].width);
    const first = await draftCard.boundingBox();
    const second = await page.getByTestId('prs-ticket-DEMO-2').boundingBox();
    expect(second.x).toBe(first.x);
    expect(
      second.y - first.y - first.height,
      `vertical spacing at ${width}`,
    ).toBeGreaterThanOrEqual(8);
    expect(await draftCard.evaluate((element) => element.getClientRects().length)).toBe(1);
    for (const key of ['DEMO-20', 'DEMO-1']) {
      const card = page.getByTestId(`prs-ticket-${key}`);
      await expect(card).toContainText(sprint.name);
      expect(
        await card.evaluate((element) => {
          const pill = element.querySelector('.review-ticket-sprint');
          const head = element.getBoundingClientRect();
          const label = pill.getBoundingClientRect();
          return (
            label.left >= head.left - 1 &&
            label.right <= head.right + 1 &&
            pill.scrollWidth <= pill.clientWidth + 1
          );
        }),
        `${key} sprint fits at ${width}`,
      ).toBe(true);
      await expect(card.locator('img, script')).toHaveCount(0);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  const body = page.getByTestId('prs-column-body-to-review');
  const head = page.getByTestId('prs-column-head-to-review');
  const headTop = (await head.boundingBox()).y;
  expect(await body.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await body.evaluate((element) =>
    element.scrollTo({ top: element.scrollHeight, behavior: 'instant' }),
  );
  expect(await body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(
    await page.getByTestId('prs-column-body-reviewing').evaluate((element) => element.scrollTop),
  ).toBe(0);
  expect((await head.boundingBox()).y).toBe(headTop);
  await page.getByTestId('prs-diff-DEMO-1-example-workspace-101').click();
  await expect(page.getByRole('dialog', { name: 'Diff viewer', exact: true })).toBeVisible();
  await expect(page.getByTestId('diff-content')).toContainText('example.js');
  expect(
    dashboard.requests
      .filter((request) => request.path.startsWith('/api/pr-diff'))
      .map((request) => request.path),
  ).toEqual(['/api/pr-diff?repo=example%2Fworkspace&number=101']);
  await page.getByTestId('diff-close').click();
  const promoted = { ...prs[0], draft: false };
  payload = {
    ...payload,
    tickets: payload.tickets.map((item) =>
      item.key === 'DEMO-1' ? { ...item, prs: [promoted] } : item,
    ),
  };
  pendingRefresh = new Promise((resolve) => {
    releaseRefresh = resolve;
  });
  await page.getByTestId('prs-refresh').click();
  await expect(page.getByTestId('prs-refresh')).toBeDisabled();
  await expect(draftCard).toBeVisible();
  releaseRefresh();
  pendingRefresh = null;
  await expect(page.getByTestId('prs-pr-DEMO-1-example-workspace-101')).toBeVisible();
  await expect(draftCue).toHaveCount(0);
  await expect(board.locator('[data-tone="warn"]')).toHaveCount(7);
  failRefresh = true;
  await page.getByTestId('prs-refresh').click();
  await expect(page.getByTestId('prs-meta')).toContainText('Refresh failed');
  await expect(board.locator('[data-tone="warn"]')).toHaveCount(7);
  failRefresh = false;
  payload = {
    ...payload,
    tickets: payload.tickets.map((item) => ({
      ...item,
      prs: item.prs.map((pr) => ({ ...pr, draft: false })),
    })),
  };
  await page.getByTestId('prs-refresh').click();
  await expect(board.locator('[data-tone="warn"]')).toHaveCount(0);
  await expect(page.getByTestId('prs-filter-count')).toHaveText('9 of 9');
  payload = {
    ...payload,
    prCoverage: {
      ...payload.prCoverage,
      available: false,
      complete: false,
      reasons: ['unavailable'],
    },
  };
  await page.getByTestId('prs-refresh').click();
  await expect(page.getByTestId('prs-coverage')).toContainText(
    'PR discovery unavailable or incomplete',
  );
  await expect(board.locator('[data-testid^="prs-ticket-warning-"]')).toHaveCount(9);
  await expect(page.getByTestId('prs-refresh')).toBeEnabled();
});
