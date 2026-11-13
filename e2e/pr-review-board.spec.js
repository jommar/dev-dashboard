import { test, expect, expectTooltip } from './fixtures.js';
import { claudeEntry, ticketBoardData } from './data.js';

const queueReads = (dashboard) =>
  dashboard.requests.filter(({ path }) => path === '/api/review-tickets');
const ticket = (page, key = 'DEMO-1') => page.getByTestId(`prs-ticket-${key}`);
const lane = (page, id) => page.getByTestId(`prs-column-${id}`);
const claudeReads = (dashboard) =>
  dashboard.requests.filter(({ path }) => path === '/api/claude/tickets');
const reviewLaunches = (dashboard) =>
  dashboard.data.claude.calls.filter(({ path }) => path === '/api/claude/launch');
const reviewStart = (page) => page.getByTestId('prs-claude-action-review');
const rereviewButton = (page) => page.getByTestId('prs-claude-action-rereview');
const rereviewCalls = (dashboard) =>
  dashboard.data.claude.calls.filter(({ path }) => path === '/api/claude/rereview');
const reviewBody = (page) => page.getByTestId('prs-claude-dialog-body');

async function openReview(page) {
  await page.getByTestId('prs-claude-icon-DEMO-1').click();
  await expect(page.getByTestId('prs-claude-dialog')).toBeVisible();
}
const search = (page) =>
  page.getByTestId('panel-prs').getByRole('searchbox', { name: 'Search', exact: true });
const review = (state = 'approved') => ({
  complete: state !== 'unknown',
  state,
  approvers: state === 'approved' ? ['third-party'] : [],
  changesRequesters: state === 'changes_requested' ? ['reviewer'] : [],
  reviewDecision: null,
});

test('ticket cards show assignee names and a readable fallback without changing their actions', async ({
  page,
  dashboard,
}) => {
  dashboard.data.reviewTickets.tickets[0].assignee = 'Alex Example';
  dashboard.data.reviewTickets.tickets[1].assignee = null;
  delete dashboard.data.reviewTickets.tickets[2].assignee;
  await page.goto('/#/prs');
  await expect(page.getByTestId('prs-ticket-assignee-DEMO-1')).toHaveText('Assignee: Alex Example');
  const assignee = page.getByTestId('prs-ticket-assignee-DEMO-1');
  const palette = await ticket(page).evaluate((element) => ({
    accent: getComputedStyle(element.querySelector('.review-ticket-key')).color,
    muted: getComputedStyle(element.querySelector('.review-ticket-sprint')).color,
  }));
  await expect(assignee).toHaveCSS('color', palette.muted);
  await expect(assignee.locator('span')).toHaveCSS('color', palette.accent);
  for (const key of ['DEMO-2', 'DEMO-3']) {
    await expect(page.getByTestId(`prs-ticket-assignee-${key}`)).toHaveText('Assignee: Unassigned');
    await expect(page.getByTestId(`prs-ticket-assignee-${key}`).locator('span')).toHaveCSS(
      'color',
      palette.muted,
    );
  }
  await expect(ticket(page).getByTestId('prs-ticket-link-DEMO-1')).toBeVisible();
  await expect(ticket(page).getByTestId('prs-claude-icon-DEMO-1')).toBeEnabled();
  await expect(ticket(page, 'DEMO-3')).toContainText('No linked open PRs');
  expect(dashboard.requests.filter(({ method }) => method !== 'GET')).toEqual([]);
});

for (const width of [390, 1440]) {
  test(`Jira sprint badges show state, omit missing sprints and contain long names at ${width} @regression`, async ({
    page,
    dashboard,
  }, testInfo) => {
    const queue = dashboard.data.reviewTickets;
    const [sample] = queue.tickets;
    const longName = 'Nexus Sprint 23 — a deliberately long Jira sprint name for containment';
    const sprints = [
      { ...sample.sprint, name: 'Nexus Sprint 22', state: 'active' },
      { ...sample.sprint, name: longName, state: 'future' },
      { ...sample.sprint, name: 'Nexus Sprint 21', state: 'closed' },
      null,
    ];
    queue.tickets = sprints.map((sprint, index) => ({
      ...sample,
      key: `DEMO-${index + 1}`,
      sprint,
      sprints: sprint ? [sprint] : [],
      prs: [],
    }));
    queue.total = queue.tickets.length;
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/#/prs');
    for (const [index, sprint] of sprints.entries()) {
      const card = ticket(page, `DEMO-${index + 1}`);
      const badge = card.getByTestId(`prs-ticket-sprint-DEMO-${index + 1}`);
      if (!sprint) {
        await expect(card).toBeVisible();
        await expect(card.locator('.review-ticket-sprint')).toHaveCount(0);
        await expect(card.locator('.ticket-sprint')).toHaveCount(0);
        continue;
      }
      await expect(badge).toBeVisible();
      await expect(badge).toHaveText(sprint.name);
      await expect(badge).toHaveClass(/ticket-sprint/);
      await expect(badge).toHaveAttribute('data-sprint-state', sprint.state);
      await expectTooltip(page, badge, new RegExp(`^${sprint.state} · `));
    }
    const card = ticket(page, 'DEMO-2');
    const badge = card.getByTestId('prs-ticket-sprint-DEMO-2');
    await badge.scrollIntoViewIfNeeded();
    await expect(badge).toHaveCSS('text-overflow', 'ellipsis');
    expect(await badge.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    const cardBox = await card.boundingBox();
    const badgeBox = await badge.boundingBox();
    expect(badgeBox.x).toBeGreaterThanOrEqual(cardBox.x);
    expect(badgeBox.x + badgeBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    const path = testInfo.outputPath(`pr-review-sprint-${width}.png`);
    await card.screenshot({ path });
    await testInfo.attach(`pr-review-sprint-${width}`, {
      path,
      contentType: 'image/png',
    });
  });
}

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

test('review dialog is native, scoped, literal and closes by Close, Escape and true backdrop without launching', async ({
  page,
  dashboard,
}) => {
  const first = dashboard.data.reviewTickets.tickets[0];
  first.summary = 'Literal <img src=x onerror=alert(1)> & review';
  dashboard.data.tickets.tickets[0].key = first.key;
  await page.goto('/#/my-tickets');
  await expect(page.getByTestId('claude-icon-DEMO-1')).toBeVisible();
  await page.getByTestId('tab-prs').click();
  await expect(ticket(page)).toBeVisible();
  const opener = page.getByTestId('prs-claude-icon-DEMO-1');
  const dialog = page.getByTestId('prs-claude-dialog');
  for (const close of ['Close', 'Escape', 'backdrop']) {
    await opener.click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAccessibleName(`DEMO-1 ${first.summary}`);
    await expect(reviewStart(page)).toHaveText('Start code review');
    await expect(reviewStart(page)).toBeEnabled();
    await expect(dialog.getByRole('button')).toHaveCount(3);
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
  expect(dashboard.requests.filter(({ method }) => method !== 'GET')).toEqual([]);
});

test('review dialog survives filtered-out cards but closes on eligibility removal and tab departure', async ({
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

test('PR Claude icons have no hover/focus tooltip but retain review names and My Tickets tooltips', async ({
  page,
  dashboard,
}) => {
  dashboard.data.tickets.tickets[0].key = 'DEMO-1';
  await page.goto('/#/my-tickets');
  const mine = page.getByTestId('claude-icon-DEMO-1');
  await expect(mine).toHaveAccessibleName('Claude: not started');
  await mine.hover();
  const visibleTooltips = page.getByRole('tooltip');
  await expect(visibleTooltips).toHaveText('Claude: not started');
  await page.mouse.move(0, 0);
  await expect(visibleTooltips).toHaveCount(0);
  await page.getByTestId('tab-prs').click();
  const icon = page.getByTestId('prs-claude-icon-DEMO-1');
  await expect.soft(icon).toHaveAccessibleName('Claude code review for DEMO-1');
  await expect(icon).toHaveAttribute('aria-haspopup', 'dialog');
  await expect.soft(icon).not.toHaveAttribute('title');
  for (const interaction of ['hover', 'focus']) {
    await icon[interaction]();
    await expect.soft(visibleTooltips).toHaveCount(0);
    await expect.soft(icon).not.toHaveAttribute('aria-describedby');
  }
});

test('first review launch leaves the workflow phase null', async ({ page, dashboard }) => {
  expect(dashboard.data.claude.tickets['DEMO-1']).toBeUndefined();
  await page.goto('/#/prs');
  await openReview(page);
  const response = page.waitForResponse('**/api/claude/launch');
  await reviewStart(page).click();
  const { ticket } = await (await response).json();
  expect(ticket).toMatchObject({
    phase: null,
    state: 'none',
    review: { state: 'working', reason: 'starting' },
  });
  expect(dashboard.data.claude.tickets['DEMO-1'].phase).toBeNull();
  await expect(reviewStart(page)).toBeDisabled();
});

test('review launch sends only key/action, disables repeat submission and keeps the dialog with independent feedback', async ({
  page,
  dashboard,
}) => {
  const workflow = claudeEntry('working', 'running');
  dashboard.data.claude.tickets['DEMO-1'] = workflow;
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const bodies = [];
  await page.route('**/api/claude/launch', async (route) => {
    bodies.push(route.request().postDataJSON());
    await pending;
    await route.fallback().catch(() => {});
  });
  try {
    await page.goto('/#/prs');
    await openReview(page);
    await expect(reviewStart(page)).toBeEnabled();
    await reviewStart(page).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => bodies.length).toBe(1);
    await expect(reviewStart(page)).toBeDisabled();
    await expect(page.getByTestId('prs-claude-dialog-close')).toBeFocused();
    await reviewStart(page).dispatchEvent('click');
    expect(bodies).toEqual([{ key: 'DEMO-1', phase: 'pr-review-transact' }]);
    release();
    await expect.poll(() => reviewLaunches(dashboard).length).toBe(1);
    await expect(page.getByTestId('prs-claude-dialog-state')).toContainText(/starting|working/i);
    await expect(reviewStart(page)).toBeDisabled();
    await expect(page.getByTestId('prs-claude-dialog')).toBeVisible();
    expect(dashboard.data.claude.tickets['DEMO-1']).toMatchObject({
      phase: workflow.phase,
      state: workflow.state,
      flags: workflow.flags,
      questions: workflow.questions,
      review: { state: 'working', reason: 'starting' },
    });
    await expect(ticket(page).getByTestId('prs-claude-icon-DEMO-1')).toHaveAttribute(
      'data-state',
      'none',
    );
  } finally {
    release();
  }
});

for (const failure of ['server refusal', 'network failure']) {
  test(`review launch shows readable ${failure} without success or closing`, async ({ page }) => {
    await page.route('**/api/claude/launch', (route) =>
      failure === 'server refusal'
        ? route.fulfill({
            status: 409,
            json: { code: 'CLAUDE_REFUSED', error: 'CLAUDE REFUSED', errors: ['session_running'] },
          })
        : route.abort('failed'),
    );
    await page.goto('/#/prs');
    await openReview(page);
    await reviewStart(page).click();
    const error = page.getByTestId('prs-claude-error');
    await expect(error).toBeVisible();
    await expect(error).toHaveAttribute('role', 'alert');
    await expect(error).toContainText(
      failure === 'server refusal'
        ? /session.*(?:running|working)|already.*(?:running|working)/i
        : /network|connect|request|reach/i,
    );
    await expect(error).not.toContainText(/CLAUDE_REFUSED|session_running/);
    await expect(reviewBody(page)).not.toContainText(
      /review started|review launched|successfully/i,
    );
    await expect(reviewStart(page)).toBeEnabled();
    await expect(page.getByTestId('prs-claude-dialog')).toBeVisible();
  });
}

for (const [state, reason, phrase] of [
  ['working', 'running', 'working'],
  ['working', 'starting', 'starting'],
  ['unknown', 'unrecognised_state', 'status unavailable'],
  ['unknown', 'listing_unavailable', 'status unavailable'],
]) {
  test(`review dialog blocks ${state}/${reason} independently of workflow status`, async ({
    page,
    dashboard,
  }) => {
    dashboard.data.claude.tickets['DEMO-1'] = claudeEntry('none', null, {
      review: { state, reason },
    });
    await page.goto('/#/prs');
    await openReview(page);
    await expect(reviewStart(page)).toBeVisible();
    await expect(reviewStart(page)).toBeDisabled();
    await expect(page.getByTestId('prs-claude-dialog-state')).toContainText(phrase);
    await expect(page.getByTestId('prs-claude-dialog-state')).toHaveAttribute('role', 'status');
    await expect(page.getByTestId('prs-claude-dialog-close')).toBeEnabled();
    expect(reviewLaunches(dashboard)).toEqual([]);
  });
}

test('review polling runs only for an open active dialog and reopening refreshes lifecycle without claiming approval', async ({
  page,
  dashboard,
}) => {
  await page.clock.install();
  await page.goto('/#/prs');
  await expect(ticket(page)).toBeVisible();
  await page.clock.fastForward(31_000);
  expect(claudeReads(dashboard)).toHaveLength(0);
  dashboard.data.claude.tickets['DEMO-1'] = claudeEntry('none', null, {
    review: { state: 'working', reason: 'running' },
  });
  await openReview(page);
  await expect.poll(() => claudeReads(dashboard).length).toBeGreaterThan(0);
  await expect(reviewStart(page)).toBeDisabled();
  dashboard.data.claude.tickets['DEMO-1'] = claudeEntry('none', null, {
    review: { state: 'done', reason: 'finished' },
  });
  const beforePoll = claudeReads(dashboard).length;
  await page.clock.fastForward(16_000);
  await expect.poll(() => claudeReads(dashboard).length).toBeGreaterThan(beforePoll);
  await expect(reviewStart(page)).toBeEnabled();
  await expect(page.getByTestId('prs-claude-dialog-state')).toContainText('finished');
  await expect(page.getByTestId('prs-claude-dialog')).not.toContainText(
    /review passed|all PRs approved|review approved/i,
  );
  await reviewStart(page).click();
  await expect.poll(() => reviewLaunches(dashboard).length).toBe(1);
  expect(reviewLaunches(dashboard)[0].body).toEqual({ key: 'DEMO-1', phase: 'pr-review-transact' });
  await expect(reviewStart(page)).toBeDisabled();
  await expect(page.getByTestId('prs-claude-dialog-state')).toContainText(/starting|working/i);
  await page.getByTestId('prs-claude-dialog-close').click();
  const afterClose = claudeReads(dashboard).length;
  await page.clock.fastForward(31_000);
  expect(claudeReads(dashboard)).toHaveLength(afterClose);
  dashboard.data.claude.tickets['DEMO-1'] = claudeEntry('none', null, {
    review: { state: 'unknown', reason: 'listing_unavailable' },
  });
  await openReview(page);
  await expect.poll(() => claudeReads(dashboard).length).toBeGreaterThan(afterClose);
  await expect(reviewStart(page)).toBeDisabled();
  await expect(page.getByTestId('prs-claude-dialog-state')).toContainText('status unavailable');
  await page.evaluate(() => {
    location.hash = '#/services';
  });
  await expect(page.getByTestId('prs-claude-dialog')).toHaveCount(0);
  const afterDeparture = claudeReads(dashboard).length;
  await page.clock.fastForward(31_000);
  expect(claudeReads(dashboard)).toHaveLength(afterDeparture);
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
    expect(geometry.columnCount).toBe(4);
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

test('all four PR filters persist through reload, polling and tabs, preserve other views and Clear persists All', async ({
  page,
  dashboard,
}) => {
  prefixQueue(dashboard.data);
  await page.clock.install();
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
  await expect(count).toHaveText('0 of 4');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(prefix).toHaveCount(1);
  await expect(prefix).toBeHidden();
  await toggle.click();
  await expect(prefix).toBeVisible();
  await expect(prefix).toHaveValue('BETA');
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
    prefix: 'ALPHA',
    repo: 'example/frontend',
    review: 'approved',
  });
  expect(saved.views.tickets).toEqual({ search: 'preserve other screen' });
  await page.reload();
  await expect(count).toHaveText('1 of 4');
  await toggle.click();
  await expect(prefix).toHaveValue('ALPHA');
  await expect(search(page)).toHaveValue('Backend counterpart');
  await expect(panel.getByLabel('Repository', { exact: true })).toHaveValue('example/frontend');
  await expect(panel.getByLabel('Review state', { exact: true })).toHaveValue('approved');
  await page.getByTestId('prs-refresh').click();
  await expect(page.getByTestId('prs-refresh')).toBeEnabled();
  await page.clock.fastForward(91_000);
  await page.getByTestId('nav-tools-toggle').click();
  await page.getByTestId('tab-services').click();
  await page.getByTestId('nav-tools-toggle').click();
  await page.getByTestId('tab-prs').click();
  await expect(page.getByTestId('prs-refresh')).toBeEnabled();
  await expect(prefix).toHaveValue('ALPHA');
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
  await page.reload();
  await expect(count).toHaveText('4 of 4');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  for (const field of [
    prefix,
    search(page),
    panel.getByLabel('Repository', { exact: true }),
    panel.getByLabel('Review state', { exact: true }),
  ])
    await expect(field).toHaveValue('');
  const cleared = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('dev-dashboard.work-filters')),
  );
  expect(cleared).toMatchObject({
    version: 1,
    views: {
      prs: { search: '', prefix: '', repo: '', review: '' },
      tickets: { search: 'preserve other screen' },
    },
  });
  expect(dashboard.requests.filter(({ method }) => method !== 'GET')).toEqual([]);
});

test('fresh PR storage defaults to empty Search and All in each dropdown', async ({ page }) => {
  await page.goto('/#/prs');
  const panel = page.getByTestId('panel-prs');
  await expect(ticket(page)).toBeVisible();
  await expect(search(page)).toHaveValue('');
  for (const name of ['Ticket prefix', 'Repository', 'Review state']) {
    const select = panel.getByLabel(name, { exact: true });
    await expect(select).toHaveValue('');
    await expect(select.locator('option:checked')).toHaveText('All');
  }
});

test('valid v1 missing prefix and repository selections restore their fallback options', async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      'dev-dashboard.work-filters',
      JSON.stringify({
        version: 1,
        views: {
          prs: { search: '', prefix: 'MISSING', repo: 'example/missing', review: 'approved' },
        },
      }),
    ),
  );
  await page.goto('/#/prs');
  const panel = page.getByTestId('panel-prs');
  await expect(panel.getByTestId('prs-filter-count')).toHaveText('0 of 3');
  for (const [name, value] of [
    ['Ticket prefix', 'MISSING'],
    ['Repository', 'example/missing'],
  ]) {
    const select = panel.getByLabel(name, { exact: true });
    await expect(select).toHaveValue(value);
    await expect(select.locator('option:checked')).toHaveText(`${value} (not in fetched data)`);
  }
  await expect(panel.getByLabel('Review state', { exact: true })).toHaveValue('approved');
});

test('an invalid saved prefix resets the PR view rather than applying its other known fields', async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      'dev-dashboard.work-filters',
      JSON.stringify({
        version: 1,
        views: {
          prs: {
            search: 'must not apply',
            prefix: [],
            repo: 'example/missing',
            review: 'approved',
          },
        },
      }),
    ),
  );
  await page.goto('/#/prs');
  const panel = page.getByTestId('panel-prs');
  await expect(search(page)).toHaveValue('');
  for (const name of ['Ticket prefix', 'Repository', 'Review state'])
    await expect(panel.getByLabel(name, { exact: true })).toHaveValue('');
  await expect(panel.getByTestId('prs-filter-count')).toHaveText('3 of 3');
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

test('re-review is off with its reason until a review session exists, and sends nothing', async ({
  page,
  dashboard,
}) => {
  dashboard.data.claude.tickets['DEMO-1'] = claudeEntry('none', null, { phase: null });
  await page.goto('/#/prs');
  await openReview(page);

  await expect(rereviewButton(page)).toHaveText('Re-review');
  await expect(rereviewButton(page)).toBeDisabled();
  await expect(page.getByTestId('prs-claude-rereview-hint')).toHaveText(
    'Start a code review first.',
  );
  expect(rereviewCalls(dashboard)).toEqual([]);
});

test('re-review sends to the existing review session and shows when it was requested', async ({
  page,
  dashboard,
}) => {
  dashboard.data.claude.tickets['DEMO-1'] = claudeEntry('none', null, {
    phase: null,
    review: { state: 'done', reason: 'finished' },
  });
  await page.goto('/#/prs');
  await openReview(page);
  await expect(rereviewButton(page)).toBeEnabled();
  await expect(page.getByTestId('prs-claude-rereview-hint')).toHaveCount(0);
  await expect(page.getByTestId('prs-claude-rereview-at')).toHaveCount(0);

  await rereviewButton(page).click();

  await expect(reviewBody(page)).toContainText(
    'Re-review requested. Claude is checking the linked PRs.',
  );
  await expect(page.getByTestId('prs-claude-rereview-at')).toContainText(
    'Last re-review requested',
  );
  expect(rereviewCalls(dashboard).map(({ body }) => body)).toEqual([{ key: 'DEMO-1' }]);
  expect(reviewLaunches(dashboard)).toEqual([]);
});

test('a re-review that was not delivered says why and can be tried again', async ({
  page,
  dashboard,
}) => {
  dashboard.data.claude.tickets['DEMO-1'] = claudeEntry('none', null, {
    phase: null,
    review: { state: 'done', reason: 'finished' },
  });
  dashboard.data.claude.sends.push({ status: 'failed', reason: 'live_at_resume' });
  await page.goto('/#/prs');
  await openReview(page);

  await rereviewButton(page).click();

  await expect(reviewBody(page)).toContainText(
    'Re-review not sent: The Claude review session is still running. Press Re-review to retry.',
  );
  await expect(rereviewButton(page)).toBeEnabled();
  await expect(page.getByTestId('prs-claude-rereview-at')).toHaveCount(0);

  await rereviewButton(page).click();

  await expect(reviewBody(page)).toContainText('Re-review requested.');
  expect(rereviewCalls(dashboard)).toHaveLength(2);
});

test('re-review is off while the review session works', async ({ page, dashboard }) => {
  dashboard.data.claude.tickets['DEMO-1'] = claudeEntry('none', null, {
    review: { state: 'working', reason: 'running' },
  });
  await page.goto('/#/prs');
  await openReview(page);

  await expect(rereviewButton(page)).toBeDisabled();
  await expect(page.getByTestId('prs-claude-rereview-hint')).toHaveText(
    'A Claude review session is already running for this ticket.',
  );
});

test('review dialog has one primary: Start while there is no review, Re-review once there is one', async ({
  page,
  dashboard,
}) => {
  await page.goto('/#/prs');
  await openReview(page);
  await expect(reviewStart(page)).toHaveClass(/\bprimary\b/);
  await expect(reviewStart(page)).toHaveText('Start code review');
  await expect(rereviewButton(page)).not.toHaveClass(/\bprimary\b/);
  await expect(page.getByTestId('prs-claude-dialog-state')).toContainText('not started');
  await page.keyboard.press('Escape');

  dashboard.data.claude.tickets['DEMO-1'] = claudeEntry('none', null, {
    phase: null,
    review: { state: 'done', reason: 'finished' },
  });
  await openReview(page);
  await expect(page.getByTestId('prs-claude-dialog-state')).toContainText('finished');
  await expect(rereviewButton(page)).toHaveClass(/\bprimary\b/);
  // Starting another review is still there, quieter and named for what it does.
  await expect(reviewStart(page)).not.toHaveClass(/\bprimary\b/);
  await expect(reviewStart(page)).toBeEnabled();
  await expect(reviewStart(page)).toHaveText('Start new review');
  await expect(
    page.locator('.claude-dialog ul:not(.claude-review-actions):not(.claude-reasons)'),
  ).toHaveCount(0);
});

test('while the review works both buttons are off and the reason is said once', async ({
  page,
  dashboard,
}) => {
  dashboard.data.claude.tickets['DEMO-1'] = claudeEntry('none', null, {
    phase: null,
    review: { state: 'working', reason: 'running' },
  });
  await page.goto('/#/prs');
  await openReview(page);
  await expect(reviewStart(page)).toBeDisabled();
  await expect(rereviewButton(page)).toBeDisabled();
  await expect(page.locator('.claude-reasons > li:not(.sr-only)')).toHaveCount(1);
  await expect(page.getByTestId('prs-claude-rereview-hint')).toHaveText(
    'A Claude review session is already running for this ticket.',
  );
  await expect(page.getByTestId('prs-claude-dialog-state')).toContainText('working');
});

test('a thread someone else started and mentioned the user in gets its Slack button on the PR card', async ({
  page,
  dashboard,
}) => {
  ticketBoardData(dashboard.data);
  const { started, ...rest } = dashboard.data.slack.threads;
  const [mentioned] = started;
  // The thread is under `mentions` only: My Tickets never reads it, the PR board does.
  dashboard.data.slack.threads = { ...rest, started: [], mentions: [mentioned] };
  dashboard.data.reviewTickets.tickets[0].key = 'TAP-9002';
  await page.goto('/#/prs');
  const button = ticket(page, 'TAP-9002').getByTestId(`slack-thread-link-${mentioned.ts}`);
  await expect(button).toBeVisible();
  await expect(ticket(page, 'DEMO-2').locator('.slack-thread-link')).toHaveCount(0);
  await button.click();
  await expect(page.getByTestId('slack-thread-close')).toBeVisible();
  await page.goto('/#/my-tickets');
  await expect(
    page.getByTestId('panel-my-tickets').getByTestId(`slack-thread-link-${mentioned.ts}`),
  ).toHaveCount(0);
});

test.describe('Spec review lane', () => {
  const specLane = (page) => lane(page, 'spec-review');
  const spec = (page, number) => page.getByTestId(`prs-spec-${number}`);
  const specFeed = (specs, extra = {}) => ({
    available: true,
    total: specs.length,
    specs,
    hasMore: false,
    updatedAt: '2026-11-09T10:00:00Z',
    ...extra,
  });
  const specPr = (number, title, keys, extra = {}) => ({
    number,
    title,
    url: `https://github.com/TransActComm/ezat-specs/pull/${number}`,
    author: 'alice',
    draft: false,
    keys,
    ageDays: 3,
    reviewsByOthers: 2,
    review: 'none',
    reviewRequested: false,
    ...extra,
  });
  const SINGLE = specPr(321, '[TAP-100] Trip export spec', ['TAP-100']);
  const SHARED = specPr(330, '[TAP-1][TAP-2] Shared spec', ['TAP-1', 'TAP-2']);
  const requested = [601, 602, 603, 604].map((number) =>
    specPr(number, `[TAP-${number}] Requested spec`, [`TAP-${number}`], { reviewRequested: true }),
  );
  const others = [701, 702, 703, 704, 705, 706, 707].map((number) =>
    specPr(number, `[TRIPS-${number}] Other spec`, [`TRIPS-${number}`]),
  );
  const windows = () => ({
    3: specFeed([...requested, ...others.slice(0, 3)], { hasMore: true }),
    6: specFeed([...requested, ...others.slice(0, 6)], { hasMore: true }),
    9: specFeed([...requested, ...others]),
  });
  const loadMore = (page) => page.getByTestId('prs-spec-load-more');
  async function specWindows(page, responses) {
    const reads = [];
    await page.route('**/api/spec-reviews*', async (route) => {
      const value = new URL(route.request().url()).searchParams.get('limit');
      const limit = value == null ? null : Number(value);
      reads.push({ method: route.request().method(), limit });
      const response = responses[limit] ?? responses.default ?? responses[3];
      if (typeof response === 'function') await response(route, limit);
      else await route.fulfill({ json: response });
    });
    return reads;
  }
  async function expectSpecNumbers(page, expected) {
    const cards = specLane(page).getByTestId(/^prs-spec-\d+$/);
    await expect(cards).toHaveCount(expected.length);
    expect(
      await cards.evaluateAll((elements) => elements.map((element) => element.dataset.testid)),
    ).toEqual(expected.map((number) => `prs-spec-${number}`));
    await expect(page.getByTestId('prs-column-count-spec-review')).toHaveText(
      String(expected.length),
    );
  }

  test('paging: Load more requests six others, replaces the complete feed and excludes its control from the count', async ({
    page,
    dashboard,
  }) => {
    const reads = await specWindows(page, windows());
    await page.clock.install();
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto('/#/prs');
    await expectSpecNumbers(page, [601, 602, 603, 604, 701, 702, 703]);
    const button = loadMore(page);
    await expect(button).toBeVisible();
    await expect(button).toHaveRole('button');
    expect(await button.evaluate((element) => element.tagName)).toBe('BUTTON');
    await expect(
      specLane(page).locator('li').last().getByTestId('prs-spec-load-more'),
    ).toBeVisible();
    const before = dashboard.requests.length;
    await button.focus();
    await page.keyboard.press('Enter');
    await expectSpecNumbers(page, [601, 602, 603, 604, 701, 702, 703, 704, 705, 706]);
    expect(reads).toEqual([
      { method: 'GET', limit: 3 },
      { method: 'GET', limit: 6 },
    ]);
    expect(
      dashboard.requests
        .slice(before)
        .filter(
          ({ path }) => path === '/api/review-tickets' || path.startsWith('/api/slack/threads'),
        ),
    ).toEqual([]);
    expect(dashboard.requests.filter(({ method }) => method !== 'GET')).toEqual([]);
    for (const number of [601, 602, 603, 604])
      await expect(page.getByTestId(`prs-spec-requested-${number}`)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await button.click();
    await expectSpecNumbers(page, [601, 602, 603, 604, 701, 702, 703, 704, 705, 706, 707]);
    expect(reads.at(-1)).toEqual({ method: 'GET', limit: 9 });
    await expect(button).toHaveCount(0);
  });

  test('paging: refresh and polls retain committed expansion and skip overlapping triggers', async ({
    page,
    dashboard,
  }) => {
    const responses = windows();
    let release;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    let releaseLate = () => {};
    const expanded = responses[6];
    responses[6] = async (route) => {
      await pending;
      await route.fulfill({ json: expanded }).catch(() => {});
    };
    const reads = await specWindows(page, responses);
    await page.clock.install();
    try {
      await page.goto('/#/prs');
      await expectSpecNumbers(page, [601, 602, 603, 604, 701, 702, 703]);
      await loadMore(page).click();
      await expect.poll(() => reads.length).toBe(2);
      await expect(loadMore(page)).toBeDisabled();
      await expect(loadMore(page)).toHaveText(/Loading/i);
      await expect(page.getByTestId('prs-refresh')).toBeDisabled();
      await loadMore(page).dispatchEvent('click');
      await loadMore(page).dispatchEvent('click');
      await page.getByTestId('prs-refresh').dispatchEvent('click');
      dashboard.data.reviewTickets.tickets[0].summary =
        'Tickets settle while spec expansion is pending';
      const slackReads = dashboard.requests.filter(({ path }) =>
        path.startsWith('/api/slack/threads'),
      ).length;
      await page.clock.fastForward(91_000);
      await expect(ticket(page)).toContainText('Tickets settle while spec expansion is pending');
      expect(
        dashboard.requests.filter(({ path }) => path.startsWith('/api/slack/threads')).length,
      ).toBeGreaterThan(slackReads);
      expect(reads).toEqual([
        { method: 'GET', limit: 3 },
        { method: 'GET', limit: 6 },
      ]);
      await expectSpecNumbers(page, [601, 602, 603, 604, 701, 702, 703]);
      release();
      await expectSpecNumbers(page, [601, 602, 603, 604, 701, 702, 703, 704, 705, 706]);
      const fresh = specFeed([
        specPr(802, '[TAP-802] Newly requested', ['TAP-802'], { reviewRequested: true }),
        requested[1],
        requested[2],
        requested[3],
        { ...requested[0], reviewRequested: false },
        others[0],
        others[1],
      ]);
      responses[6] = fresh;
      await page.getByTestId('prs-refresh').click();
      await expectSpecNumbers(page, [802, 602, 603, 604, 601, 701, 702]);
      await expect(page.getByTestId('prs-spec-requested-601')).toHaveCount(0);
      await expect(page.getByTestId('prs-spec-requested-802')).toBeVisible();
      await expect(spec(page, 703)).toHaveCount(0);
      expect(reads.at(-1).limit).toBe(6);
      await page.clock.fastForward(91_000);
      await expect.poll(() => reads.length).toBe(4);
      expect(reads.at(-1).limit).toBe(6);
      await page.getByTestId('tab-services').click();
      await page.getByTestId('tab-prs').click();
      await page.getByTestId('prs-refresh').click();
      await expect.poll(() => reads.length).toBe(5);
      expect(reads.at(-1).limit).toBe(6);
      const late = new Promise((resolve) => {
        releaseLate = resolve;
      });
      responses[6] = async (route) => {
        await late;
        await route.fulfill({ json: specFeed([], { available: false }) }).catch(() => {});
      };
      await page.getByTestId('prs-refresh').click();
      await expect.poll(() => reads.length).toBe(6);
      await page.reload();
      await expectSpecNumbers(page, [601, 602, 603, 604, 701, 702, 703]);
      expect(reads.at(-1).limit).toBe(3);
      releaseLate();
      await expect(page.getByTestId('prs-spec-error')).toHaveCount(0);
      await expect(loadMore(page)).toBeEnabled();
    } finally {
      release();
      releaseLate();
    }
  });

  test('paging: expansion failure clears the lane, preserves the dialog and retries only the committed count with explicit limits', async ({
    page,
    dashboard,
  }) => {
    const responses = windows();
    let release;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    responses[9] = async (route) => {
      await pending;
      await route.fulfill({ json: specFeed([], { available: false }) }).catch(() => {});
    };
    const reads = await specWindows(page, responses);
    await page.clock.install();
    try {
      await page.goto('/#/prs');
      await expect(loadMore(page)).toBeVisible();
      await loadMore(page).click();
      await expectSpecNumbers(page, [601, 602, 603, 604, 701, 702, 703, 704, 705, 706]);
      await loadMore(page).click();
      await expect.poll(() => reads.length).toBe(3);
      await spec(page, 601).getByTestId('prs-spec-claude-icon-601').click();
      await expect(page.getByTestId('prs-claude-dialog')).toBeVisible();
      release();
      await expect(page.getByTestId('prs-spec-error')).toBeVisible();
      await expectSpecNumbers(page, []);
      await expect(loadMore(page)).toHaveCount(0);
      await expect(ticket(page)).toBeVisible();
      await expect(page.getByTestId('prs-claude-dialog')).toBeVisible();
      await page.keyboard.press('Escape');
      responses[6] = specFeed([requested[0], others[0]]);
      await page.getByTestId('prs-refresh').click();
      await expectSpecNumbers(page, [601, 701]);
      expect(reads.map(({ limit }) => limit)).toEqual([3, 6, 9, 6]);
      await expect(page.getByTestId('prs-spec-error')).toHaveCount(0);
      await expect(loadMore(page)).toHaveCount(0);
      responses[6] = specFeed([], { available: false, reason: 'search_limit' });
      await page.getByTestId('prs-refresh').click();
      await expect(page.getByTestId('prs-spec-error')).toContainText(/1,?000/);
      await expect(page.getByTestId('prs-spec-error')).toContainText(
        /GitHub.*search|search.*GitHub/i,
      );
      await expectSpecNumbers(page, []);
      await expect(ticket(page)).toBeVisible();

      await expect(loadMore(page)).toHaveCount(0);
      expect(dashboard.requests.filter(({ method }) => method !== 'GET')).toEqual([]);
    } finally {
      release();
    }
  });

  test('review requested specs have a distinct background and a visible chip, including reviewed specs', async ({
    page,
    dashboard,
  }) => {
    const omitted = specPr(331, '[TAP-3] Legacy spec', ['TAP-3']);
    delete omitted.reviewRequested;
    dashboard.data.specReviews = specFeed([
      { ...SINGLE, reviewRequested: true, review: 'current' },
      SHARED,
      omitted,
      specPr(332, '[TAP-4] Changed spec', ['TAP-4'], {
        reviewRequested: true,
        review: 'stale',
      }),
    ]);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/#/prs');
    await expect(page.getByTestId('prs-column-count-spec-review')).toHaveText('4');
    const ordinaryBackground = await spec(page, 330).evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    await expect(spec(page, 331)).toHaveCSS('background-color', ordinaryBackground);
    for (const number of [321, 332]) {
      const card = spec(page, number);
      await expect(card).toBeVisible();
      const background = await card.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      );
      expect.soft(background).not.toBe(ordinaryBackground);
      const chip = card.getByTestId(`prs-spec-requested-${number}`);
      await expect(chip).toHaveText('Your review requested');
      await expect(chip).toBeVisible();
      await expect(chip).toHaveClass(/board-chip/);
      await expect(chip).toHaveAttribute('data-tone', 'warn');
      await expect(card.getByTestId(`prs-spec-claude-icon-${number}`)).toBeEnabled();
    }
    await expect(page.getByTestId('prs-spec-review-321')).toHaveText('Reviewed');
    await expect(page.getByTestId('prs-spec-review-332')).toHaveText(
      'New commits since your review',
    );
    for (const number of [330, 331])
      await expect(page.getByTestId(`prs-spec-requested-${number}`)).toHaveCount(0);
    expect(dashboard.requests.filter(({ method }) => method !== 'GET')).toEqual([]);
  });

  test('review requested appearance clears on refresh without removing an already-reviewed spec', async ({
    page,
    dashboard,
  }) => {
    const requested = { ...SINGLE, reviewRequested: true, review: 'current' };
    dashboard.data.specReviews = specFeed([requested, SHARED]);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/#/prs');
    const card = spec(page, 321);
    const chip = card.getByTestId('prs-spec-requested-321');
    await expect(chip).toBeVisible();
    const ordinaryStyle = await spec(page, 330).evaluate((element) => ({
      background: getComputedStyle(element).backgroundColor,
      shadow: getComputedStyle(element).boxShadow,
    }));
    const requestedShadow = await card.evaluate((element) => getComputedStyle(element).boxShadow);
    expect(requestedShadow).not.toBe(ordinaryStyle.shadow);
    requested.reviewRequested = false;
    await page.getByTestId('prs-refresh').click();
    await expect(chip).toHaveCount(0);
    await expect(card).toBeVisible();
    await expect(card).toHaveCSS('background-color', ordinaryStyle.background);
    await expect(card).toHaveCSS('box-shadow', ordinaryStyle.shadow);
    await expect(page.getByTestId('prs-spec-review-321')).toHaveText('Reviewed');
    await expect(page.getByTestId('prs-column-count-spec-review')).toHaveText('2');
    expect(dashboard.requests.filter(({ method }) => method !== 'GET')).toEqual([]);
  });

  test('shows one card per spec with its content', async ({ page, dashboard }) => {
    dashboard.data.specReviews = specFeed([SINGLE, SHARED]);
    await page.goto('/#/prs');
    await expect(
      specLane(page).getByRole('heading', { name: 'Spec review', exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId('prs-column-count-spec-review')).toHaveText('2');
    const card = spec(page, 321);
    await expect(specLane(page).getByTestId('prs-spec-321')).toBeVisible();
    const key = card.getByTestId('prs-spec-key-321-TAP-100');
    await expect(key).toHaveText('TAP-100');
    await expect(key).toHaveAttribute('href', 'https://example.invalid/browse/TAP-100');
    const link = card.getByTestId('prs-spec-pr-321');
    await expect(link).toContainText('#321');
    await expect(link).toContainText('Trip export spec');
    await expect(link).toHaveAttribute('href', SINGLE.url);
    await expect(card.getByTestId('prs-spec-author-321')).toContainText('alice');
    await expect(card.getByTestId('prs-spec-age-321')).toContainText('3 d');
    await expect(card.getByTestId('prs-spec-reviews-321')).toContainText('2 reviews');
    const shared = spec(page, 330);
    for (const key of ['TAP-1', 'TAP-2']) {
      await expect(shared.getByTestId(`prs-spec-key-330-${key}`)).toHaveAttribute(
        'href',
        `https://example.invalid/browse/${key}`,
      );
    }
  });

  test('leaves the three existing lanes as they were', async ({ page, dashboard }) => {
    dashboard.data.specReviews = specFeed([SINGLE, SHARED]);
    await page.goto('/#/prs');
    const groups = page.getByTestId('prs-board').getByRole('group');
    await expect(groups).toHaveCount(4);
    await expect(groups.getByRole('heading')).toHaveText([
      'To Review',
      'Reviewing',
      'Reviewed',
      'Spec review',
    ]);
    await expect(lane(page, 'reviewing').getByTestId('prs-ticket-DEMO-1')).toBeVisible();
    for (const key of ['DEMO-2', 'DEMO-3'])
      await expect(lane(page, 'to-review').getByTestId(`prs-ticket-${key}`)).toBeVisible();
    for (const [id, expected] of [
      ['to-review', '2'],
      ['reviewing', '1'],
      ['reviewed', '0'],
    ])
      await expect(page.getByTestId(`prs-column-count-${id}`)).toHaveText(expected);
    for (const id of ['to-review', 'reviewing', 'reviewed'])
      await expect(lane(page, id).getByTestId(/^prs-spec-\d+$/)).toHaveCount(0);
  });

  for (const [failure, outage] of [
    [
      'an unavailable answer',
      (route) => route.fulfill({ json: specFeed([], { available: false }) }),
    ],
    ['an HTTP 500', (route) => route.fulfill({ status: 500, json: { error: 'Synthetic outage' } })],
  ]) {
    test(`a failed lookup (${failure}) empties the lane and says so`, async ({
      page,
      dashboard,
    }) => {
      dashboard.data.specReviews = specFeed([SINGLE]);
      await page.goto('/#/prs');
      await expect(spec(page, 321)).toBeVisible();
      const meta = await page.getByTestId('prs-meta').innerText();
      await page.route('**/api/spec-reviews*', outage);
      await page.getByTestId('prs-refresh').click();
      await expect(page.getByTestId('prs-spec-error')).toBeVisible();
      await expect(page.getByTestId('prs-column-count-spec-review')).toHaveText('0');
      await expect(spec(page, 321)).toHaveCount(0);
      await expect(ticket(page)).toBeVisible();
      await expect(page.getByTestId('prs-meta')).toHaveText(meta);
    });
  }

  test('the Claude action launches the spec review for the first key', async ({
    page,
    dashboard,
  }) => {
    dashboard.data.specReviews = specFeed([SINGLE, SHARED]);
    const bodies = [];
    await page.route('**/api/claude/launch', async (route) => {
      bodies.push(route.request().postDataJSON());
      await route.fulfill({
        json: {
          ok: true,
          key: 'TAP-1',
          phase: 'spec-review',
          name: 'TAP-1-spec-review',
          id: 'ab12cd34',
          ticket: claudeEntry('none', null, {
            phase: null,
            specReview: { state: 'working', reason: 'starting' },
          }),
        },
      });
    });
    await page.goto('/#/prs');
    await spec(page, 330).getByTestId('prs-spec-claude-icon-330').click();
    await expect(page.getByTestId('prs-claude-dialog')).toBeVisible();
    await expect(page.getByTestId('prs-claude-action-spec-review')).toBeEnabled();
    await expect(page.getByTestId('prs-claude-action-rereview')).toHaveCount(0);
    await expect(page.getByTestId('prs-claude-action-review')).toHaveCount(0);
    await page.getByTestId('prs-claude-action-spec-review').click();
    await expect.poll(() => bodies.length).toBe(1);
    expect(bodies).toEqual([{ key: 'TAP-1', phase: 'spec-review', pr: 330 }]);
  });

  test('marks a spec the signed-in user has reviewed, or must review again', async ({
    page,
    dashboard,
  }) => {
    dashboard.data.specReviews = specFeed([
      specPr(321, '[TAP-100] Not reviewed spec', ['TAP-100'], { review: 'none' }),
      specPr(322, '[TAP-101] Reviewed spec', ['TAP-101'], { review: 'current' }),
      specPr(323, '[TAP-102] Changed spec', ['TAP-102'], { review: 'stale' }),
    ]);
    await page.goto('/#/prs');
    await expect(page.getByTestId('prs-column-count-spec-review')).toHaveText('3');
    await expect(page.getByTestId('prs-spec-review-321')).toHaveCount(0);
    await expect(spec(page, 321).locator('.board-chip')).toHaveCount(0);
    await expect(page.getByTestId('prs-spec-review-322')).toHaveText('Reviewed');
    await expect(page.getByTestId('prs-spec-review-323')).toHaveText(
      'New commits since your review',
    );
    for (const number of [322, 323])
      await expect(spec(page, number).getByTestId(`prs-spec-review-${number}`)).toHaveClass(
        /board-chip/,
      );
  });

  for (const [state, label] of [
    ['none', 'Start spec review'],
    ['current', 'Review again'],
    ['stale', 'Re-review'],
  ]) {
    test(`the dialog button reads "${label}" for a spec with review ${state}`, async ({
      page,
      dashboard,
    }) => {
      dashboard.data.specReviews = specFeed([
        specPr(321, '[TAP-100] Trip export spec', ['TAP-100'], { review: state }),
      ]);
      await page.goto('/#/prs');
      await spec(page, 321).getByTestId('prs-spec-claude-icon-321').click();
      const action = page.getByTestId('prs-claude-action-spec-review');
      await expect(action).toHaveText(label);
      await expect(action).toBeEnabled();
    });
  }

  test('shows spec cards beside the empty state when there are no review tickets', async ({
    page,
    dashboard,
  }) => {
    dashboard.data.reviewTickets = { ...dashboard.data.reviewTickets, total: 0, tickets: [] };
    dashboard.data.specReviews = specFeed([SINGLE]);
    await page.goto('/#/prs');
    await expect(page.getByTestId('prs-empty')).toBeVisible();
    await expect(specLane(page).getByTestId('prs-spec-321')).toBeVisible();
  });
});
