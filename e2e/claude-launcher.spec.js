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
// and `claude-goto-fallback-<phase>`. The dialog's footer is `.claude-dialog-foot` (a class: the
// element has no test id) and its scrolling body `.claude-dialog-body`; each phase is one list item of
// `.claude-actions`.

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
  // With no questions the footer holds Close and nothing else.
  const foot = dialog.locator('.claude-dialog-foot');
  await expect(foot.getByRole('button')).toHaveCount(1);
  await expect(foot.getByTestId('claude-dialog-close')).toBeVisible();
  for (const id of ['claude-questions-save', 'claude-questions-progress', 'claude-send-result']) {
    await expect(dialog.getByTestId(id)).toHaveCount(0);
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
  // The number and the tick stay out of the label: its accessible name is the question, exactly.
  for (const [text, id] of [
    [Q1, 'q1'],
    [Q2, 'q2'],
  ]) {
    await expect(dialog.getByRole('textbox', { name: text, exact: true })).toHaveAttribute(
      'data-testid',
      `claude-question-${id}`,
    );
  }
  await expect(dialog.getByTestId('claude-action-implement')).toBeDisabled();
  await expect(dialog.getByTestId('claude-action-hint-implement')).toContainText(
    'Answer the open questions first',
  );
  const save = dialog.getByTestId('claude-questions-save');
  await expect(save).toBeDisabled();

  // The answer is a growing text area that the password managers leave alone.
  await expect(first).toHaveJSProperty('tagName', 'TEXTAREA');
  await expect(first).toHaveAttribute('maxlength', '2000');
  await expect(first).toHaveAttribute('autocomplete', 'off');
  await expect(first).toHaveAttribute('data-lpignore', 'true');
  await expect(first).toHaveAttribute('data-1p-ignore', 'true');
  await expect(first).toHaveAttribute('data-bwignore', 'true');
  const emptyHeight = (await second.boundingBox()).height;
  await second.fill(Array.from({ length: 8 }, (_, line) => `line ${line + 1}`).join('\n'));
  const grown = (await second.boundingBox()).height;
  expect(grown, 'eight lines make the box taller than an empty one').toBeGreaterThan(
    emptyHeight + 40,
  );
  await second.fill(Array.from({ length: 60 }, (_, line) => `line ${line + 1}`).join('\n'));
  expect((await second.boundingBox()).height, 'a long answer stops growing').toBeLessThan(400);
  expect(await second.evaluate((box) => box.scrollHeight > box.clientHeight)).toBe(true);
  await second.fill('');
  // Enter adds a line to an answer; only Save sends it.
  await first.fill('line one');
  await first.press('Enter');
  await first.pressSequentially('line two');
  await expect(first).toHaveValue('line one\nline two');
  expect(bodiesTo(dashboard, '/api/claude/answers')).toEqual([]);

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
  const save = dialog.getByTestId('claude-questions-save');
  const result = dialog.getByTestId('claude-send-result');

  // The standing hint is in the body above the first question, never in the footer.
  const hint = dialog.locator('.claude-dialog-body').getByText(STANDING_HINT);
  await expect(hint).toHaveCount(1);
  const foot = dialog.locator('.claude-dialog-foot');
  await expect(foot.getByText(STANDING_HINT)).toHaveCount(0);
  const hintBox = await hint.boundingBox();
  const firstBox = await dialog.getByTestId('claude-question-q1').boundingBox();
  expect(hintBox.y + hintBox.height, 'the hint sits above the questions').toBeLessThanOrEqual(
    firstBox.y,
  );

  // The questions are a numbered list.
  const items = dialog.getByTestId('claude-questions').getByRole('listitem');
  await expect(items).toHaveCount(3);
  for (const [index, text] of [Q1, Q2, Q3].entries()) {
    await expect(items.nth(index)).toHaveText(new RegExp(`^\\s*${index + 1}(?!\\d)`));
    await expect(items.nth(index)).toContainText(text);
  }

  // Progress, the result, Save and Close share the footer; Save is outside the form and submits it.
  for (const id of [
    'claude-questions-progress',
    'claude-send-result',
    'claude-questions-save',
    'claude-dialog-close',
  ]) {
    await expect(foot.getByTestId(id)).toHaveCount(1);
  }
  const form = dialog.getByTestId('claude-questions');
  await expect(form.getByTestId('claude-questions-save')).toHaveCount(0);
  const formId = await form.getAttribute('id');
  expect(formId, 'the form has an id for Save to point at').toBeTruthy();
  await expect(save).toHaveAttribute('type', 'submit');
  await expect(save).toHaveAttribute('form', formId);
  const [progressBox, saveBox, closeBox] = await Promise.all(
    ['claude-questions-progress', 'claude-questions-save', 'claude-dialog-close'].map((id) =>
      foot.getByTestId(id).boundingBox(),
    ),
  );
  expect(progressBox.x + progressBox.width, 'progress is left of the buttons').toBeLessThanOrEqual(
    saveBox.x,
  );
  expect(saveBox.x + saveBox.width, 'Save comes before Close').toBeLessThanOrEqual(closeBox.x);

  // A tick shows a saved answer; a draft alone does not.
  const tick = (id) => dialog.getByTestId(`claude-question-answered-${id}`);
  for (const id of ['q1', 'q2', 'q3']) await expect(tick(id)).toHaveCount(0);
  await dialog.getByLabel(Q1).fill('Portage-backend');
  await expect(tick('q1')).toHaveCount(0);
  await save.click();
  await expect(result).toHaveText('Saved. 2 questions still need an answer; nothing was sent.');
  await expect(progress).toContainText('1 of 3 answered');
  await expect(tick('q1')).toBeVisible();
  await expect(tick('q1')).toHaveAccessibleName('Answered');
  await expect(tick('q2')).toHaveCount(0);
  await expect(tick('q3')).toHaveCount(0);

  await dialog.getByLabel(Q2).fill('Yes, behind a setting');
  await dialog.getByLabel(Q3).fill('No');
  await expect(tick('q2')).toHaveCount(0);
  await save.click();
  await expect(result).toHaveText(SENT_LINE);
  await expect(progress).toContainText('3 of 3 answered');
  for (const id of ['q1', 'q2', 'q3']) await expect(tick(id)).toBeVisible();
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
  const firstBox = await dialog.getByTestId('claude-question-q1').boundingBox();
  expect(hintBox.y + hintBox.height, 'the hint sits above the questions').toBeLessThanOrEqual(
    firstBox.y,
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
  // Each button says "Go to session"; its accessible name is the phase's full label.
  await expect(investigate).toHaveText('Go to session');
  await expect(implement).toHaveText('Go to session');
  await expect(
    dialog.getByRole('button', { name: LABEL.investigate, exact: true }),
  ).toHaveAttribute('data-testid', 'claude-action-goto-investigate');
  await expect(dialog.getByRole('button', { name: LABEL.implement, exact: true })).toHaveAttribute(
    'data-testid',
    'claude-action-goto-implement',
  );
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

// Each phase is one row: its run button and its own Go to session button, side by side on a wide
// screen and stacked on a phone, with that row's hints on lines of their own under the buttons (the
// run hint, then the plan path, then the Go to session hint).
for (const [width, stacked] of [
  [1440, false],
  [390, true],
]) {
  test(`scenario 53: each phase row holds its run and Go to session buttons with the hints under them at ${width}px`, async ({
    page,
    dashboard,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await openBoard(page, dashboard, {
      [KEY]: claudeEntry('working', 'running', { goTo: sessions(ATTACH) }),
      'TAP-9002': claudeEntry('done', 'plan_ready', { flags: PLAN_DONE, goTo: sessions(RESUME) }),
    });

    // A row's buttons share a line when wide and sit one above the other when narrow; the lower edge
    // of the two is where its hints may start.
    const buttonsOf = async (row, run, goTo) => {
      const runBox = await row.getByTestId(run).boundingBox();
      const goBox = await row.getByTestId(goTo).boundingBox();
      if (stacked) {
        expect(goBox.y, `${goTo} is below ${run}`).toBeGreaterThanOrEqual(
          runBox.y + runBox.height - 1,
        );
      } else {
        const centre = ({ y, height }) => y + height / 2;
        expect(
          Math.abs(centre(goBox) - centre(runBox)),
          `${goTo} is on the line of ${run}`,
        ).toBeLessThanOrEqual(4);
        expect(goBox.x, `${goTo} is right of ${run}`).toBeGreaterThanOrEqual(
          runBox.x + runBox.width - 1,
        );
      }
      return Math.max(runBox.y + runBox.height, goBox.y + goBox.height);
    };
    // Each hint, in the order given, is in the row, under the buttons and under the one before.
    const hintsUnder = async (row, bottom, ids) => {
      let edge = bottom;
      for (const id of ids) {
        const box = await row.getByTestId(id).boundingBox();
        expect(box.y, `${id} is under what comes before it`).toBeGreaterThanOrEqual(edge - 1);
        edge = box.y + box.height;
      }
    };
    const noOverflow = async (dialog) => {
      const body = dialog.locator('.claude-dialog-body');
      expect(await body.evaluate((box) => box.scrollWidth - box.clientWidth)).toBeLessThanOrEqual(
        0,
      );
      const box = await dialog.boundingBox();
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    };

    let dialog = await openDialog(page);
    const rows = dialog.locator('.claude-actions > li');
    await expect(rows).toHaveCount(2);
    const [investigate, implement] = [rows.nth(0), rows.nth(1)];
    for (const [row, phase] of [
      [investigate, 'investigate'],
      [implement, 'implement'],
    ]) {
      await expect(row.getByTestId(`claude-action-${phase}`)).toBeVisible();
      await expect(row.getByTestId(`claude-action-goto-${phase}`)).toBeVisible();
    }
    // Investigate and plan runs: Investigate has its run hint, Implement its run hint and no session.
    const investigateBottom = await buttonsOf(
      investigate,
      'claude-action-investigate',
      'claude-action-goto-investigate',
    );
    const implementBottom = await buttonsOf(
      implement,
      'claude-action-implement',
      'claude-action-goto-implement',
    );
    await hintsUnder(investigate, investigateBottom, ['claude-action-hint-investigate']);
    await expect(investigate.getByTestId('claude-action-hint-goto-investigate')).toHaveCount(0);
    await hintsUnder(implement, implementBottom, [
      'claude-action-hint-implement',
      'claude-action-hint-goto-implement',
    ]);
    await noOverflow(dialog);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('claude-dialog')).toHaveCount(0);

    // Plan ready: the plan path sits under the Implement row's buttons, above its Go to session hint.
    dialog = await openDialog(page, 'TAP-9002');
    const planRow = dialog.locator('.claude-actions > li').nth(1);
    const planBottom = await buttonsOf(
      planRow,
      'claude-action-implement',
      'claude-action-goto-implement',
    );
    await hintsUnder(planRow, planBottom, [
      'claude-plan-hint',
      'claude-action-hint-goto-implement',
    ]);
    await expect(planRow.getByTestId('claude-action-hint-implement')).toHaveCount(0);
    await noOverflow(dialog);
  });
}

// The footer holds Save beside Close and stays on screen: with many long questions only the body
// scrolls, so Save answers is in view without scrolling, on a wide screen and on a phone, and still
// is when a long result wraps.
const LONG_QUESTION =
  'which team owns the retry policy for failed export jobs, and what should happen when the cap is reached? ';
for (const width of [1440, 390]) {
  test(`scenario 54: Save answers stays on screen with many long questions at ${width}px`, async ({
    page,
    dashboard,
  }) => {
    await page.setViewportSize({ width, height: 700 });
    const questions = [
      'Alpha',
      'Bravo',
      'Charlie',
      'Delta',
      'Echo',
      'Foxtrot',
      'Golf',
      'Hotel',
    ].map((name, index) => claudeQuestion(`q${index + 1}`, `${name}: ${LONG_QUESTION.repeat(3)}`));
    await openBoard(page, dashboard, {
      [KEY]: claudeEntry('waiting', 'questions', { flags: PLANNED, questions }),
    });
    const dialog = await openDialog(page);
    const body = dialog.locator('.claude-dialog-body');
    expect(
      await body.evaluate((box) => box.scrollHeight - box.clientHeight),
      'the questions are taller than the body, which scrolls',
    ).toBeGreaterThan(0);
    expect(await body.evaluate((box) => box.scrollTop)).toBe(0);
    const foot = dialog.locator('.claude-dialog-foot');
    const onScreen = async () => {
      for (const id of ['claude-questions-save', 'claude-dialog-close']) {
        await expect(dialog.getByTestId(id), `${id} is on screen`).toBeInViewport({ ratio: 1 });
      }
      await expect(foot).toBeInViewport({ ratio: 1 });
    };
    await onScreen();

    // A result that wraps over several lines does not push the footer off the screen.
    dashboard.data.claude.sends.push({ status: 'failed', reason: 'session_not_found' });
    await dialog.getByTestId('claude-question-q1').fill('Portage-backend');
    await dialog.getByTestId('claude-questions-save').click();
    await expect(foot.getByTestId('claude-send-result')).toContainText(
      'Answers saved, but they could not be sent',
    );
    await onScreen();
  });
}
