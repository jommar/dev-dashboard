import { test, expect } from './fixtures.js';
import { BOARD_THREAD_TS, claudeEntry, claudeQuestion, ticketBoardData } from './data.js';

// The Claude launcher on the My Tickets board. The fixture is the matrix in `ticketBoardData`
// (e2e/data.js) with the fake Claude API laid over it: `dashboard.data.claude.tickets` is what the
// status route lists, by ticket key, and a ticket with no entry is not started.
//   TAP-9001  In Progress   "Invented fix for the failing export job"
//   TAP-9002  Code Review   a Slack thread chip
//
// Test ids come from the feature's spec: `claude-icon-<KEY>` on the card, and `claude-dialog`
// with its `claude-action-*`, `claude-action-hint-*`, `claude-question-<id>`, `claude-error`,
// `claude-dialog-close` and `claude-plan-hint` inside. Go to session is two items, one per phase,
// and every id it has takes the phase as a suffix: `claude-action-goto-investigate` /
// `claude-action-goto-implement`, `claude-action-hint-goto-<phase>`, `claude-goto-copied-<phase>`
// and `claude-goto-fallback-<phase>`.

const KEY = 'TAP-9001';
const SUMMARY = 'Invented fix for the failing export job';
const ATTACH = { kind: 'attach', command: 'claude attach ab12cd34' };
const RESUME = {
  kind: 'resume',
  command: 'cd ~/pathwise && claude --resume 3f2b8c1e-5d4a-4e7b-9c60-1a2b3c4d5e6f',
};
// An entry's `goTo`: the command to join each phase's own session, or null for one with none.
const sessions = (investigate = null, implement = null) => ({ investigate, implement });
const LABEL = {
  investigate: 'Go to investigate and plan session',
  implement: 'Go to implement plan session',
};
// The first pass wrote the plan; `done` stays false until every question is answered and the
// session has updated the plan.
const PLANNED = { 'investigate-and-plan': true, 'implement-plan': false, done: false };
const PLAN_DONE = { ...PLANNED, done: true };
const TRUST_SENTENCE =
  'Claude does not trust ~/pathwise yet. Run claude there once and accept the trust prompt.';
const Q1 = 'Which repo owns the fix?';
const Q2 = 'Should the retry cap be configurable?';
const Q3 = 'Should the old export keep working?';
const STANDING_HINT =
  'Save as you go. Nothing is sent to the session until every question has an answer.';
const SENT_LINE = 'Answers sent. Claude is updating the plan.';
const PLAN_NOT_DONE = 'Claude has not marked the plan done. Check the session before implementing.';
const ANSWERS_NOT_SENT =
  'All questions are answered, but they have not been sent to the session. Press Save answers to send them.';

const isPath = (path) => (url) => url.pathname === path;
const claudeReads = ({ requests }) =>
  requests.filter(({ method, path }) => method === 'GET' && path.startsWith('/api/claude/tickets'))
    .length;
// The bodies the fake API was sent for one POST route, in order.
const bodiesTo = ({ data }, path) =>
  data.claude.calls.filter((call) => call.path === path).map((call) => call.body);
const iconOf = (page, key = KEY) => page.getByTestId(`claude-icon-${key}`);
// A round trip through the page: what it was handed before the call has been processed by then.
const flushPage = (page) =>
  page.evaluate(() => fetch('/api/config').then((response) => response.json()));

// The board with the matrix tickets and these Claude entries (a key with none is not started).
// The card is asserted first: a broken mock or a missing board is not a Claude RED.
async function openBoard(page, dashboard, entries = {}) {
  ticketBoardData(dashboard.data);
  Object.assign(dashboard.data.claude.tickets, entries);
  await page.goto('/#/my-tickets');
  await expect(page.getByTestId('my-tickets-board')).toBeVisible();
  await expect(page.getByTestId(`my-tickets-item-${KEY}`)).toBeVisible();
}

async function openDialog(page, key = KEY) {
  await iconOf(page, key).click();
  const dialog = page.getByTestId('claude-dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

// Holds every answer for a route until `release`, then lets the shared fake answer it. `bodies`
// are the request bodies it was sent.
async function holdResponses(page, path) {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const bodies = [];
  await page.route(isPath(path), async (route) => {
    bodies.push(route.request().postDataJSON());
    await gate;
    await route.fallback().catch(() => {});
  });
  return { bodies, release };
}

test('scenario 21: every ticket card shows a Claude icon in its state', async ({
  page,
  dashboard,
}) => {
  await openBoard(page, dashboard, {
    'TAP-9002': claudeEntry('working', 'running', { goTo: sessions(ATTACH) }),
    'TAP-9003': claudeEntry('waiting', 'questions', {
      flags: PLANNED,
      questions: [claudeQuestion('q1', Q1)],
    }),
    'TAP-9005': claudeEntry('done', 'plan_ready', { flags: PLAN_DONE }),
    'TAP-9007': claudeEntry('failed', 'ended_without_flag'),
  });
  const cases = [
    ['TAP-9001', 'none', 'not started'],
    ['TAP-9002', 'working', 'working'],
    ['TAP-9003', 'waiting', 'has questions for you'],
    ['TAP-9005', 'done', 'plan ready'],
    ['TAP-9007', 'failed', 'ended without finishing'],
  ];
  for (const [key, state, phrase] of cases) {
    const card = page.getByTestId(`my-tickets-item-${key}`);
    const icon = card.getByTestId(`claude-icon-${key}`);
    await expect(icon).toHaveAttribute('data-state', state);
    await expect(icon).toHaveAttribute('aria-label', `Claude: ${phrase}`);
    await expect(card.getByRole('button', { name: `Claude: ${phrase}` })).toHaveCount(1);
    const box = await icon.boundingBox();
    expect(box.width, `${key} icon width`).toBeGreaterThanOrEqual(24);
    expect(box.height, `${key} icon height`).toBeGreaterThanOrEqual(24);
    const glyph = icon.locator('svg');
    await expect(glyph).toHaveCount(1);
    await expect(glyph).toHaveAttribute('aria-hidden', 'true');
    // The card's other controls are still there beside the icon.
    await expect(card.getByTestId(`my-tickets-item-link-${key}`)).toBeVisible();
    await expect(card.getByTestId(`my-tickets-item-priority-${key}`)).toBeVisible();
    await expect(card.getByTestId(`my-tickets-item-summary-${key}`)).toBeVisible();
  }
  await expect(page.getByTestId(`slack-thread-link-${BOARD_THREAD_TS.needsReply}`)).toBeVisible();
});

test('scenario 22: the icon opens a dialog with its four items and Escape closes it', async ({
  page,
  dashboard,
}) => {
  await openBoard(page, dashboard);
  const icon = iconOf(page);
  await expect(icon).toHaveAttribute('data-state', 'none');
  const dialog = await openDialog(page);
  const title = dialog.getByTestId('claude-dialog-title');
  await expect(title).toContainText(KEY);
  await expect(title).toContainText(SUMMARY);
  await expect(dialog.getByTestId('claude-action-investigate')).toBeEnabled();
  await expect(dialog.getByTestId('claude-action-implement')).toBeDisabled();
  await expect(dialog.getByTestId('claude-action-hint-implement')).toContainText(
    'Run Investigate and plan first',
  );
  for (const phase of ['investigate', 'implement']) {
    await expect(dialog.getByTestId(`claude-action-goto-${phase}`)).toBeDisabled();
    await expect(dialog.getByTestId(`claude-action-hint-goto-${phase}`)).toContainText(
      'No session to join',
    );
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(icon).toBeFocused();
});

test('scenario 23: Investigate and plan sends one launch request with the key and phase only and the icon starts working', async ({
  page,
  dashboard,
}) => {
  const { bodies, release } = await holdResponses(page, '/api/claude/launch');
  try {
    await openBoard(page, dashboard);
    await expect(iconOf(page)).toHaveAttribute('data-state', 'none');
    const dialog = await openDialog(page);
    // The summary is shown for the person; it is never part of a launch.
    await expect(dialog.getByTestId('claude-dialog-title')).toContainText(SUMMARY);
    const investigate = dialog.getByTestId('claude-action-investigate');
    await investigate.click();
    await expect.poll(() => bodies.length).toBe(1);
    await expect(investigate).toBeDisabled();
    release();
    await expect(iconOf(page)).toHaveAttribute('data-state', 'working');
    await expect(page.getByTestId('claude-error')).toHaveCount(0);
    expect(bodies).toEqual([{ key: KEY, phase: 'investigate-and-plan' }]);
  } finally {
    release();
  }
});

test('scenario 24: a failed launch says why and leaves the icon as it was', async ({
  page,
  dashboard,
}) => {
  await page.route(isPath('/api/claude/launch'), (route) =>
    route.fulfill({
      status: 502,
      json: { code: 'CLAUDE_FAILED', error: 'CLAUDE FAILED', errors: ['untrusted_workspace'] },
    }),
  );
  await openBoard(page, dashboard);
  await expect(iconOf(page)).toHaveAttribute('data-state', 'none');
  const dialog = await openDialog(page);
  await dialog.getByTestId('claude-action-investigate').click();
  const error = page.getByTestId('claude-error');
  await expect(error).toHaveText(TRUST_SENTENCE);
  await expect(error).toHaveAttribute('role', 'alert');
  await expect(dialog.getByTestId('claude-action-investigate')).toBeEnabled();
  await expect(iconOf(page)).toHaveAttribute('data-state', 'none');
});

test('scenario 25: questions are answered in the dialog and unlock Implement plan', async ({
  page,
  dashboard,
}) => {
  await openBoard(page, dashboard, {
    [KEY]: claudeEntry('waiting', 'questions', {
      flags: PLANNED,
      questions: [claudeQuestion('q1', Q1), claudeQuestion('q2', Q2)],
    }),
  });
  const dialog = await openDialog(page);
  await expect(dialog.getByTestId('claude-questions')).toBeVisible();
  const first = dialog.getByLabel(Q1);
  const second = dialog.getByLabel(Q2);
  await expect(first).toHaveAttribute('data-testid', 'claude-question-q1');
  await expect(second).toHaveAttribute('data-testid', 'claude-question-q2');
  await expect(dialog.getByTestId('claude-action-implement')).toBeDisabled();
  await expect(dialog.getByTestId('claude-action-hint-implement')).toContainText(
    'Answer the open questions first',
  );
  const save = dialog.getByTestId('claude-questions-save');
  await expect(save).toBeDisabled();

  await first.fill('Portage-backend');
  await save.click();
  await expect
    .poll(() => bodiesTo(dashboard, '/api/claude/answers'))
    .toEqual([{ key: KEY, answers: { q1: 'Portage-backend' } }]);
  await expect(first).toHaveValue('Portage-backend');
  await expect(dialog.getByTestId('claude-action-implement')).toBeDisabled();

  await second.fill('Yes, behind a setting');
  await save.click();
  await expect(dialog.getByTestId('claude-action-implement')).toBeEnabled();
  expect(bodiesTo(dashboard, '/api/claude/answers')).toEqual([
    { key: KEY, answers: { q1: 'Portage-backend' } },
    { key: KEY, answers: { q2: 'Yes, behind a setting' } },
  ]);
});

test('scenario 25: answers cannot be edited while a session works', async ({ page, dashboard }) => {
  await openBoard(page, dashboard, {
    [KEY]: claudeEntry('working', 'running', {
      flags: PLANNED,
      goTo: sessions(ATTACH),
      questions: [claudeQuestion('q1', Q1), claudeQuestion('q2', Q2)],
    }),
  });
  const dialog = await openDialog(page);
  await expect(dialog.getByTestId('claude-question-q1')).toBeDisabled();
  await expect(dialog.getByTestId('claude-question-q2')).toBeDisabled();
});

test('scenario 26: Go to session copies the exact command and says Copied', async ({
  page,
  dashboard,
}) => {
  await openBoard(page, dashboard, {
    [KEY]: claudeEntry('waiting', 'blocked', { goTo: sessions(ATTACH) }),
  });
  const dialog = await openDialog(page);
  const goTo = dialog.getByTestId('claude-action-goto-investigate');
  await expect(goTo).toBeEnabled();
  await goTo.click();
  await expect(dialog.getByTestId('claude-goto-copied-investigate')).toContainText('Copied');
  expect(await page.evaluate(() => window.__dashboardMock.clipboard.writes)).toEqual([
    ATTACH.command,
  ]);
  await expect(dialog.getByTestId('claude-goto-fallback-investigate')).toHaveCount(0);
  await expect(dialog.getByTestId('claude-goto-copied-implement')).toHaveCount(0);
});

test('scenario 26: Go to session falls back to a read-only field when the clipboard fails', async ({
  page,
  dashboard,
}) => {
  await openBoard(page, dashboard, {
    [KEY]: claudeEntry('waiting', 'blocked', { goTo: sessions(ATTACH) }),
  });
  const dialog = await openDialog(page);
  await page.evaluate(() => {
    window.__dashboardMock.clipboard.error = 'Permission denied';
  });
  await dialog.getByTestId('claude-action-goto-investigate').click();
  const fallback = dialog.getByTestId('claude-goto-fallback-investigate');
  await expect(fallback).toBeVisible();
  await expect(fallback).toHaveValue(ATTACH.command);
  await expect(fallback).toHaveAttribute('readonly', '');
  await expect(dialog.getByTestId('claude-goto-copied-investigate')).toHaveCount(0);
  expect(await page.evaluate(() => window.__dashboardMock.clipboard.writes)).toEqual([]);
});

test('scenario 26: Go to session is disabled when the ticket has no session to join', async ({
  page,
  dashboard,
}) => {
  await openBoard(page, dashboard, {
    [KEY]: claudeEntry('done', 'plan_ready', { flags: PLAN_DONE, goTo: sessions() }),
  });
  const dialog = await openDialog(page);
  for (const phase of ['investigate', 'implement']) {
    await expect(dialog.getByTestId(`claude-action-goto-${phase}`)).toBeDisabled();
    await expect(dialog.getByTestId(`claude-action-hint-goto-${phase}`)).toContainText(
      'No session to join',
    );
  }
});

test('scenario 27: the icon follows the session by polling, with no reload and the scroll kept', async ({
  page,
  dashboard,
}) => {
  const now = Date.now();
  await page.clock.install({ time: now - 60_000 });
  await page.clock.pauseAt(now);
  await openBoard(page, dashboard, {
    [KEY]: claudeEntry('working', 'running', { goTo: sessions(ATTACH) }),
  });
  const icon = iconOf(page);
  await expect(icon).toHaveAttribute('data-state', 'working');
  const board = page.getByTestId('my-tickets-board');
  const body = page.getByTestId('my-tickets-column-body-To-Do');
  await board.evaluate((element) => element.scrollTo({ left: 300, behavior: 'instant' }));
  await body.evaluate((element) => element.scrollTo({ top: 500, behavior: 'instant' }));
  const position = async () => ({
    left: await board.evaluate((element) => element.scrollLeft),
    top: await body.evaluate((element) => element.scrollTop),
  });
  const before = await position();
  expect(before.left).toBeGreaterThan(0);
  expect(before.top).toBeGreaterThan(0);
  const reads = claudeReads(dashboard);
  await page.evaluate(() => {
    window.__sameDocument = true;
  });

  dashboard.data.claude.tickets[KEY] = claudeEntry('done', 'plan_ready', {
    flags: PLAN_DONE,
    goTo: sessions(ATTACH),
  });
  await page.clock.runFor(15_000);
  await expect(icon).toHaveAttribute('data-state', 'done');
  expect(claudeReads(dashboard)).toBe(reads + 1);
  expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
  expect(await position()).toEqual(before);
});

// The tests below pin behaviours fixed after review.

test('scenario 36: leaving the tab closes the dialog and leaves the board usable', async ({
  page,
  dashboard,
}) => {
  await openBoard(page, dashboard);
  await openDialog(page);
  await page.evaluate(() => {
    location.hash = '#/home';
  });
  await expect(page.getByTestId('claude-dialog')).toHaveCount(0);
  await page.evaluate(() => {
    location.hash = '#/my-tickets';
  });
  await expect(page.getByTestId('my-tickets-board')).toBeVisible();
  await expect(page.getByTestId('claude-dialog')).toHaveCount(0);
  // A click an inert page would refuse.
  await openDialog(page);
});

test('scenario 37: a drag from an answer field to the backdrop keeps the dialog, a backdrop click closes it', async ({
  page,
  dashboard,
}) => {
  await openBoard(page, dashboard, {
    [KEY]: claudeEntry('waiting', 'questions', {
      flags: PLANNED,
      questions: [claudeQuestion('q1', Q1)],
    }),
  });
  const dialog = await openDialog(page);
  const input = dialog.getByTestId('claude-question-q1');
  await input.fill('half-typed answer');
  const box = await input.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(4, 4, { steps: 4 });
  await page.mouse.up();
  await expect(dialog).toBeVisible();
  await expect(input).toHaveValue('half-typed answer');
  await page.mouse.click(4, 4);
  await expect(page.getByTestId('claude-dialog')).toHaveCount(0);
});

test('scenario 38: after Investigate and plan is clicked, focus is on Close', async ({
  page,
  dashboard,
}) => {
  await openBoard(page, dashboard);
  const dialog = await openDialog(page);
  await dialog.getByTestId('claude-action-investigate').click();
  const close = dialog.getByTestId('claude-dialog-close');
  await expect(close).toBeFocused();
  await expect(iconOf(page)).toHaveAttribute('data-state', 'working');
  await expect(close).toBeFocused();
});

test('scenario 39: the status poll stops while the document is hidden and while another tab is active', async ({
  page,
  dashboard,
}) => {
  await page.clock.install();
  await openBoard(page, dashboard);
  await expect.poll(() => claudeReads(dashboard)).toBeGreaterThan(0);

  let before = claudeReads(dashboard);
  await page.clock.runFor(30_000);
  await flushPage(page);
  expect(claudeReads(dashboard)).toBeGreaterThan(before);

  await page.evaluate(() =>
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }),
  );
  await flushPage(page);
  before = claudeReads(dashboard);
  await page.clock.runFor(300_000);
  await flushPage(page);
  expect(claudeReads(dashboard)).toBe(before);

  await page.evaluate(() => {
    delete document.hidden;
  });
  await page.getByTestId('tab-services').click();
  await flushPage(page);
  before = claudeReads(dashboard);
  await page.clock.runFor(300_000);
  await flushPage(page);
  expect(claudeReads(dashboard)).toBe(before);
});

test('scenario 40: a poll already in flight cannot put the old state back after a launch', async ({
  page,
  dashboard,
}) => {
  await openBoard(page, dashboard);
  const dialog = await openDialog(page);
  // A poll that starts now is answered with the state as it is now, but only once released.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let held = 0;
  try {
    await page.route(isPath('/api/claude/tickets'), async (route) => {
      held += 1;
      const stale = structuredClone(dashboard.data.claude.tickets);
      await gate;
      await route.fulfill({ json: { listing: 'ok', tickets: stale } }).catch(() => {});
    });
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(() => held).toBe(1);
    await dialog.getByTestId('claude-action-investigate').click();
    await expect(iconOf(page)).toHaveAttribute('data-state', 'working');
    const answered = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/claude/tickets',
    );
    release();
    await (await answered).finished();
    await flushPage(page);
    await flushPage(page);
    await expect(iconOf(page)).toHaveAttribute('data-state', 'working');
  } finally {
    release();
  }
});

test('scenario 41: Implement plan sends an implement launch and the icon starts working', async ({
  page,
  dashboard,
}) => {
  await openBoard(page, dashboard, {
    [KEY]: claudeEntry('done', 'plan_ready', { flags: PLAN_DONE, goTo: sessions(ATTACH) }),
  });
  await expect(iconOf(page)).toHaveAttribute('data-state', 'done');
  const dialog = await openDialog(page);
  const implement = dialog.getByTestId('claude-action-implement');
  await expect(implement).toBeEnabled();
  await implement.click();
  await expect(iconOf(page)).toHaveAttribute('data-state', 'working');
  await expect(page.getByTestId('claude-error')).toHaveCount(0);
  expect(bodiesTo(dashboard, '/api/claude/launch')).toEqual([
    { key: KEY, phase: 'implement-plan' },
  ]);
});

test('scenario 42: a question id that names an object member renders empty and cannot be saved', async ({
  page,
  dashboard,
}) => {
  await openBoard(page, dashboard, {
    [KEY]: claudeEntry('waiting', 'questions', {
      flags: PLANNED,
      questions: [claudeQuestion('toString', Q1)],
    }),
  });
  const dialog = await openDialog(page);
  const input = dialog.getByTestId('claude-question-toString');
  await expect(input).toHaveValue('');
  await expect(dialog.getByTestId('claude-questions-save')).toBeDisabled();
});

// The Slack chip keeps its place beside the card's figures and the icon alone takes the row's free
// space. If both pushed right, the free space would be split between them and the chip would drift
// away from the figures. At 1440 px the icon wraps onto its own line on a card with a chip, at 390 px
// it does not.
for (const width of [1440, 390]) {
  test(`scenario 43: the Slack chip stays beside the figures and the icon keeps the card's right edge at ${width}px`, async ({
    page,
    dashboard,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await openBoard(page, dashboard);
    const chipId = `slack-thread-link-${BOARD_THREAD_TS.needsReply}`;
    await expect(page.getByTestId(chipId)).toBeVisible();
    const updated = await page.getByTestId('my-tickets-item-updated-TAP-9002').boundingBox();
    const chip = await page.getByTestId(chipId).boundingBox();
    expect(chip.y, 'the chip is on the figures row').toBeLessThan(updated.y + updated.height);
    expect(
      chip.x - (updated.x + updated.width),
      'gap from the figures to the chip',
    ).toBeLessThanOrEqual(16);
    // How far the icon's right edge is from its own card's.
    const inset = async (key) => {
      const card = await page.getByTestId(`my-tickets-item-${key}`).boundingBox();
      const icon = await iconOf(page, key).boundingBox();
      return card.x + card.width - (icon.x + icon.width);
    };
    expect(Math.abs((await inset('TAP-9002')) - (await inset('TAP-9001')))).toBeLessThanOrEqual(1);
  });
}

test('scenario 44: a plan-ready ticket shows where its plan file is beside Implement plan, no other state does', async ({
  page,
  dashboard,
}) => {
  await openBoard(page, dashboard, {
    [KEY]: claudeEntry('done', 'plan_ready', { flags: PLAN_DONE, goTo: sessions(ATTACH) }),
    'TAP-9002': claudeEntry('working', 'running', { flags: PLANNED, goTo: sessions(ATTACH) }),
    'TAP-9003': claudeEntry('waiting', 'questions', {
      flags: PLANNED,
      questions: [claudeQuestion('q1', Q1)],
    }),
    'TAP-9005': claudeEntry('done', 'implemented', {
      phase: 'implement-plan',
      flags: { ...PLAN_DONE, 'implement-plan': true },
      goTo: sessions(RESUME, RESUME),
    }),
  });
  let dialog = await openDialog(page);
  const implementRow = dialog.locator('li', { has: page.getByTestId('claude-action-implement') });
  await expect(implementRow.getByTestId('claude-action-implement')).toBeEnabled();
  await expect(implementRow.getByTestId('claude-plan-hint')).toHaveText(
    '~/pathwise/.orchestrator/tap-9001/02-plan.md',
  );
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('claude-dialog')).toHaveCount(0);

  for (const other of ['TAP-9004', 'TAP-9002', 'TAP-9003', 'TAP-9005']) {
    dialog = await openDialog(page, other);
    await expect(dialog.getByTestId('claude-action-implement')).toBeVisible();
    await expect(dialog.getByTestId('claude-plan-hint')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('claude-dialog')).toHaveCount(0);
  }
});

// While one phase runs the other says which: a session of this ticket is already running (the
// phase that runs) or the other phase is. Go to session is the way into the running session.
test('scenario 46: while Investigate and plan runs, Implement plan says so and Go to session stays open', async ({
  page,
  dashboard,
}) => {
  await openBoard(page, dashboard, {
    [KEY]: claudeEntry('working', 'running', { goTo: sessions(ATTACH) }),
  });
  const dialog = await openDialog(page);
  await expect(dialog.getByTestId('claude-action-investigate')).toBeDisabled();
  await expect(dialog.getByTestId('claude-action-hint-investigate')).toHaveText(
    'A Claude session is already running for this ticket.',
  );
  await expect(dialog.getByTestId('claude-action-implement')).toBeDisabled();
  await expect(dialog.getByTestId('claude-action-hint-implement')).toHaveText(
    'Investigate and plan is still running.',
  );
  await expect(dialog.getByTestId('claude-action-goto-investigate')).toBeEnabled();
  await expect(dialog.getByTestId('claude-action-goto-implement')).toBeDisabled();
});

test('scenario 47: while Implement plan runs, Investigate and plan says so and Implement plan keeps the running hint', async ({
  page,
  dashboard,
}) => {
  await openBoard(page, dashboard, {
    [KEY]: claudeEntry('working', 'running', {
      phase: 'implement-plan',
      flags: PLANNED,
      goTo: sessions(RESUME, ATTACH),
    }),
  });
  const dialog = await openDialog(page);
  await expect(dialog.getByTestId('claude-action-investigate')).toBeDisabled();
  await expect(dialog.getByTestId('claude-action-hint-investigate')).toHaveText(
    'Implement plan is running.',
  );
  await expect(dialog.getByTestId('claude-action-implement')).toBeDisabled();
  await expect(dialog.getByTestId('claude-action-hint-implement')).toHaveText(
    'A Claude session is already running for this ticket.',
  );
  await expect(dialog.getByTestId('claude-action-goto-implement')).toBeEnabled();
  await expect(dialog.getByTestId('claude-action-goto-investigate')).toBeEnabled();
});

// Saving answers routes them back to the session once every question has one.

test('scenario 48: answers are saved as you go and sent only when every question has one', async ({
  page,
  dashboard,
}) => {
  await openBoard(page, dashboard, {
    [KEY]: claudeEntry('waiting', 'questions', {
      flags: PLANNED,
      questions: [claudeQuestion('q1', Q1), claudeQuestion('q2', Q2), claudeQuestion('q3', Q3)],
    }),
  });
  const dialog = await openDialog(page);
  const progress = dialog.getByTestId('claude-questions-progress');
  await expect(progress).toContainText('0 of 3 answered');
  await expect(dialog.getByTestId('claude-questions')).toContainText(STANDING_HINT);
  const save = dialog.getByTestId('claude-questions-save');
  const result = dialog.getByTestId('claude-send-result');

  await dialog.getByLabel(Q1).fill('Portage-backend');
  await save.click();
  await expect(result).toHaveText('Saved. 2 questions still need an answer; nothing was sent.');
  await expect(progress).toContainText('1 of 3 answered');

  await dialog.getByLabel(Q2).fill('Yes, behind a setting');
  await dialog.getByLabel(Q3).fill('No');
  await save.click();
  await expect(result).toHaveText(SENT_LINE);
  await expect(progress).toContainText('3 of 3 answered');
  await expect(save).toBeDisabled();
  expect(bodiesTo(dashboard, '/api/claude/answers')).toEqual([
    { key: KEY, answers: { q1: 'Portage-backend' } },
    { key: KEY, answers: { q2: 'Yes, behind a setting', q3: 'No' } },
  ]);
});

test('scenario 49: unsent answers can be saved again with nothing changed, and each outcome is worded', async ({
  page,
  dashboard,
}) => {
  await openBoard(page, dashboard, {
    [KEY]: claudeEntry('waiting', 'answers_not_sent', {
      flags: PLANNED,
      unsent: true,
      questions: [claudeQuestion('q1', Q1, 'Portage-backend'), claudeQuestion('q2', Q2, 'Yes')],
    }),
  });
  const dialog = await openDialog(page);
  const save = dialog.getByTestId('claude-questions-save');
  const result = dialog.getByTestId('claude-send-result');
  // A failure reads "<reason's sentence, without its full stop>. Save again to retry."
  const failed = (sentence) =>
    `Answers saved, but they could not be sent: ${sentence}. Save again to retry.`;
  const outcomes = [
    [{ status: 'failed', reason: 'listing_unavailable' }, failed('Claude status is unavailable')],
    [
      { status: 'failed', reason: 'session_running' },
      failed('A Claude session is already running for this ticket'),
    ],
    [
      { status: 'failed', reason: 'session_not_found' },
      failed('The Claude session could not be found'),
    ],
    [{ status: 'failed', reason: 'live_at_resume' }, failed('The Claude session is still running')],
    [
      { status: 'failed', reason: 'resume_failed' },
      failed('The Claude session could not be resumed'),
    ],
    [
      { status: 'skipped', reason: 'unchanged' },
      'Saved. The answers had not changed, so nothing was sent.',
    ],
    [
      { status: 'skipped', reason: 'not_planned' },
      'Saved. The plan is not ready yet, so nothing was sent.',
    ],
    [
      { status: 'skipped', reason: 'implement_started' },
      'Saved. Implement plan has started, so nothing was sent.',
    ],
    [{ status: 'sent' }, SENT_LINE],
  ];
  for (const [send, expected] of outcomes) {
    // Nothing is typed, yet an unsent entry can be saved again.
    await expect(save).toBeEnabled();
    dashboard.data.claude.sends.push(send);
    await save.click();
    await expect(result).toHaveText(expected);
  }
  await expect(save).toBeDisabled();
  expect(bodiesTo(dashboard, '/api/claude/answers')).toEqual(
    outcomes.map(() => ({ key: KEY, answers: [] })),
  );
});

test('scenario 50: Save answers stays disabled while a session works, even for unsent answers', async ({
  page,
  dashboard,
}) => {
  await openBoard(page, dashboard, {
    [KEY]: claudeEntry('working', 'running', {
      flags: PLANNED,
      unsent: true,
      goTo: sessions(ATTACH),
      questions: [claudeQuestion('q1', Q1, 'Portage-backend')],
    }),
  });
  const dialog = await openDialog(page);
  await expect(dialog.getByTestId('claude-question-q1')).toBeDisabled();
  await expect(dialog.getByTestId('claude-questions-save')).toBeDisabled();
});

test('scenario 51: the icon and dialog tell answers not sent, plan not done and done apart', async ({
  page,
  dashboard,
}) => {
  const answered = [claudeQuestion('q1', Q1, 'Portage-backend')];
  await openBoard(page, dashboard, {
    'TAP-9002': claudeEntry('waiting', 'answers_not_sent', {
      flags: PLANNED,
      unsent: true,
      questions: answered,
    }),
    'TAP-9003': claudeEntry('failed', 'plan_not_done', {
      flags: PLANNED,
      goTo: sessions(ATTACH),
      questions: answered,
    }),
    'TAP-9005': claudeEntry('done', 'plan_ready', {
      flags: PLAN_DONE,
      goTo: sessions(ATTACH),
      questions: answered,
    }),
    'TAP-9006': claudeEntry('waiting', 'answers_not_sent', {
      flags: PLAN_DONE,
      unsent: true,
      questions: answered,
    }),
  });
  // The existing amber (waiting) and red (failed) badges, each with a phrase of its own.
  for (const [key, state, reason, phrase] of [
    ['TAP-9002', 'waiting', 'answers_not_sent', 'answers not sent'],
    ['TAP-9003', 'failed', 'plan_not_done', 'plan not done'],
    ['TAP-9005', 'done', 'plan_ready', 'plan ready'],
  ]) {
    const icon = iconOf(page, key);
    await expect(icon).toHaveAttribute('data-state', state);
    await expect(icon).toHaveAttribute('data-reason', reason);
    await expect(icon).toHaveAttribute('aria-label', `Claude: ${phrase}`);
    await expect(icon).toHaveAttribute('data-tooltip', `Claude: ${phrase}`);
  }

  // Answers complete but never sent: a hint above the questions says to press Save answers, and
  // Implement plan waits for them to be sent, saying the same thing beside the button.
  let dialog = await openDialog(page, 'TAP-9002');
  const hint = dialog.getByTestId('claude-answers-hint');
  await expect(hint).toHaveText(ANSWERS_NOT_SENT);
  const hintBox = await hint.boundingBox();
  const formBox = await dialog.getByTestId('claude-questions').boundingBox();
  expect(hintBox.y + hintBox.height, 'the hint sits above the questions').toBeLessThanOrEqual(
    formBox.y,
  );
  await expect(dialog.getByTestId('claude-action-implement')).toBeDisabled();
  await expect(dialog.getByTestId('claude-action-hint-implement')).toHaveText(ANSWERS_NOT_SENT);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('claude-dialog')).toHaveCount(0);

  // A changed answer whose send failed leaves the old `done` flag true: Implement plan still waits
  // for the answers to be sent, and says so rather than offering a plan the session never updated.
  dialog = await openDialog(page, 'TAP-9006');
  await expect(dialog.getByTestId('claude-action-implement')).toBeDisabled();
  await expect(dialog.getByTestId('claude-action-hint-implement')).toHaveText(ANSWERS_NOT_SENT);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('claude-dialog')).toHaveCount(0);

  // The plan was not marked done: Implement plan is blocked and says why beside the button.
  dialog = await openDialog(page, 'TAP-9003');
  await expect(dialog.getByTestId('claude-action-implement')).toBeDisabled();
  await expect(dialog.getByTestId('claude-action-hint-implement')).toHaveText(PLAN_NOT_DONE);
  await expect(dialog.getByTestId('claude-answers-hint')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('claude-dialog')).toHaveCount(0);

  dialog = await openDialog(page, 'TAP-9005');
  await expect(dialog.getByTestId('claude-action-implement')).toBeEnabled();
  await expect(dialog.getByTestId('claude-answers-hint')).toHaveCount(0);
});

// Once Implement plan has launched, the investigate session is still reachable: one item per phase,
// each with its own command and its own Copied.
test('scenario 52: both Go to session items work at once and each copies its own command', async ({
  page,
  dashboard,
}) => {
  await openBoard(page, dashboard, {
    [KEY]: claudeEntry('working', 'running', {
      phase: 'implement-plan',
      flags: PLANNED,
      goTo: sessions(RESUME, ATTACH),
    }),
  });
  const dialog = await openDialog(page);
  await expect(dialog.getByTestId('claude-action-goto')).toHaveCount(0);
  const investigate = dialog.getByTestId('claude-action-goto-investigate');
  const implement = dialog.getByTestId('claude-action-goto-implement');
  await expect(investigate).toHaveText(LABEL.investigate);
  await expect(implement).toHaveText(LABEL.implement);
  await expect(investigate).toBeEnabled();
  await expect(implement).toBeEnabled();
  await expect(dialog.getByTestId('claude-action-hint-goto-investigate')).toHaveCount(0);
  await expect(dialog.getByTestId('claude-action-hint-goto-implement')).toHaveCount(0);

  await investigate.click();
  await expect(dialog.getByTestId('claude-goto-copied-investigate')).toContainText('Copied');
  await expect(dialog.getByTestId('claude-goto-copied-implement')).toHaveCount(0);

  await implement.click();
  await expect(dialog.getByTestId('claude-goto-copied-implement')).toContainText('Copied');
  expect(await page.evaluate(() => window.__dashboardMock.clipboard.writes)).toEqual([
    RESUME.command,
    ATTACH.command,
  ]);
});
