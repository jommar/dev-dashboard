import { test, expect } from './fixtures.js';

test('draft cards are amber masonry with wrapping sprints, working diff and draft-to-ready refresh', async ({
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
  const prs = Array.from({ length: 8 }, (_, i) => ({
    number: i + 101,
    repo: 'example/workspace',
    owner: 'developer',
    draft: true,
    tickets: [`DEMO-${i + 1}`],
    title: i === 0 ? 'Tall draft '.repeat(25) : `Draft change ${i + 1}`,
    url: `https://example.invalid/pull/${i + 101}`,
    updatedAt: '2026-10-06T12:00:00Z',
  }));
  const ready = {
    ...prs[1],
    number: 200,
    draft: false,
    tickets: ['DEMO-20'],
    title: 'Ready change',
  };
  const approval = { ...ready, number: 201, owner: 'colleague', tickets: ['DEMO-21'] };
  let payload = {
    ...dashboard.data.prs,
    login: 'developer',
    prsAvailable: true,
    total: 1,
    prs: [ready],
    groups: { 'DEMO-20': [ready] },
    draftPrs: prs,
    draftGroups: Object.fromEntries(prs.map((pr) => [pr.tickets[0], [pr]])),
    ticketStatuses: { 'DEMO-20': 'Code Review', 'DEMO-1': 'In Progress' },
    ticketSprints: { 'DEMO-20': sprint, 'DEMO-1': sprint },
    prsNeedingApprovals: [approval],
    approvalGroups: { 'DEMO-21': [approval] },
    approvalTicketStatuses: { 'DEMO-21': 'Ready For Code Review' },
    approvalTicketSprints: { 'DEMO-21': sprint },
    uatPromoteAvailable: true,
    uatPromoteTotal: 1,
    uatPromoteGroups: {
      'DEMO-22': { ticket: { status: 'Promote to UAT', sprint }, prs: [{ ...ready, number: 202 }] },
    },
  };
  let failRefresh = false;
  let releaseRefresh;
  let pendingRefresh;
  await page.route('**/api/prs', async (route) => {
    if (pendingRefresh) await pendingRefresh;
    if (failRefresh) return route.fulfill({ status: 502, json: { error: 'Synthetic outage' } });
    await route.fulfill({ json: structuredClone(payload) });
  });
  await page.goto('/#/prs');
  const section = page.getByTestId('pr-draft-section');
  await expect(section).toBeVisible();
  await expect(section).toContainText('Your draft PRs');
  await expect(page.getByTestId('pr-draft-count')).toHaveText('8');
  await expect(section.locator('[data-pr-state="draft"].pill')).toHaveCount(8);
  await expect(page.getByTestId('prs-list').locator('[data-pr-state="draft"]')).toHaveCount(0);
  const draftCard = page.getByTestId('pr-draft-ticket-DEMO-1');
  const appearance = async (card) =>
    card.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        background: style.backgroundColor,
        border: style.borderLeftColor,
        borderWidth: parseFloat(style.borderLeftWidth),
        borderStyle: style.borderLeftStyle,
      };
    });
  const draftStyle = await appearance(draftCard);
  expect(draftStyle).not.toEqual(await appearance(page.getByTestId('pr-open-ticket-DEMO-20')));
  expect(draftStyle.background).not.toBe(
    (await appearance(page.getByTestId('pr-open-ticket-DEMO-20'))).background,
  );
  expect(draftStyle.borderWidth).toBeGreaterThan(0);
  expect(draftStyle.borderStyle).not.toBe('none');
  expect(draftStyle.borderStyle).not.toBe('hidden');
  const amber = [...draftStyle.border.matchAll(/[\d.]+/g)].map((match) => Number(match[0]));
  expect(amber[0]).toBeGreaterThan(amber[1]);
  expect(amber[1]).toBeGreaterThan(amber[2]);
  for (const [width, columns] of [
    [390, 1],
    [759, 1],
    [760, 2],
    [1699, 2],
    [1700, 3],
  ]) {
    await page.setViewportSize({ width, height: 1000 });
    const geometry = await section.evaluate((element) => {
      const cards = [...element.querySelectorAll('article')];
      const style = getComputedStyle(cards[0].parentElement);
      return {
        columns: style.columnCount,
        gap: parseFloat(style.columnGap),
        cards: cards.map((card) => {
          const rect = card.getBoundingClientRect();
          return {
            x: rect.x,
            y: rect.y,
            bottom: rect.bottom,
            fragments: card.getClientRects().length,
            breakInside: getComputedStyle(card).breakInside,
          };
        }),
      };
    });
    expect(geometry.columns, `draft masonry at ${width}`).toBe(String(columns));
    expect(
      new Set(geometry.cards.map((card) => Math.round(card.x))).size,
      `visible draft columns at ${width}`,
    ).toBe(columns);
    expect(geometry.gap).toBeGreaterThan(0);
    for (const card of geometry.cards) {
      expect(card.fragments).toBe(1);
      expect(card.breakInside).toBe('avoid');
      const above = geometry.cards
        .filter((other) => Math.abs(other.x - card.x) < 1 && other.bottom <= card.y)
        .sort((a, b) => b.bottom - a.bottom)[0];
      if (above) expect(card.y - above.bottom, 'vertical spacing').toBeGreaterThanOrEqual(8);
    }
    for (const [variant, key] of [
      ['pr-open', 'DEMO-20'],
      ['pr-draft', 'DEMO-1'],
      ['pr-approval', 'DEMO-21'],
      ['pr-uat-promote', 'DEMO-22'],
    ]) {
      const header = page.getByTestId(`${variant}-group-${key}`);
      await expect(header).toContainText(sprint.name);
      expect(
        await header.evaluate((element) => {
          const pill = element.querySelector('[data-sprint-state]');
          const head = element.getBoundingClientRect();
          const label = pill.getBoundingClientRect();
          return (
            label.left >= head.left - 1 &&
            label.right <= head.right + 1 &&
            pill.scrollWidth <= pill.clientWidth + 1
          );
        }),
        `${variant} sprint fits at ${width}`,
      ).toBe(true);
      await expect(header.locator('img, script')).toHaveCount(0);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.getByTestId('pr-draft-view-diff-example/workspace-101').click();
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
    prs: [ready, promoted],
    total: 2,
    groups: { 'DEMO-20': [ready], 'DEMO-1': [promoted] },
    draftPrs: prs.slice(1),
    draftGroups: Object.fromEntries(prs.slice(1).map((pr) => [pr.tickets[0], [pr]])),
    ticketStatuses: { ...payload.ticketStatuses, 'DEMO-1': 'Code Review' },
  };
  pendingRefresh = new Promise((resolve) => {
    releaseRefresh = resolve;
  });
  await page.getByTestId('prs-refresh').click();
  await expect(page.getByTestId('prs-refresh')).toBeDisabled();
  await expect(draftCard).toBeVisible();
  releaseRefresh();
  pendingRefresh = null;
  await expect(page.getByTestId('pr-open-example/workspace-101')).toBeVisible();
  await expect(page.getByTestId('pr-draft-example/workspace-101')).toHaveCount(0);
  await expect(page.getByTestId('pr-draft-count')).toHaveText('7');
  failRefresh = true;
  await page.getByTestId('prs-refresh').click();
  await expect(page.getByTestId('prs-meta')).toContainText('Refresh failed');
  await expect(page.getByTestId('pr-draft-count')).toHaveText('7');
  failRefresh = false;
  payload = { ...payload, draftPrs: [], draftGroups: {} };
  await page.getByTestId('prs-refresh').click();
  await expect(section).toContainText('No draft PRs');
  await expect(page.getByTestId('pr-draft-count')).toHaveText('0');
  payload = { ...payload, prsAvailable: false, prs: [], groups: {} };
  await page.getByTestId('prs-refresh').click();
  await expect(section).toContainText('GitHub is unavailable');
  await expect(page.getByTestId('prs-refresh')).toBeEnabled();
});
