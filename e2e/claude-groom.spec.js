import { test, expect, expectTooltip } from './fixtures.js';
import { claudeEntry, claudeQuestion, ticketBoardData } from './data.js';

// Groom ticket in the Claude dialog: a third row, after Implement plan, that is not part of the
// workflow. Its own state is `entry.groom` (`{ state, reason }`), its session `goTo.groom` and its
// block `blocks.groom` (the fake API in e2e/data.js models all three). The workflow's `state`,
// `reason` and header line never follow it, and the card's icon follows it only for a ticket that
// has no workflow record.
//
// Test ids: `claude-action-groom`, `claude-action-goto-groom` (named "Go to groom ticket session"),
// `claude-action-hint-groom`, `claude-action-hint-goto-groom`, `claude-goto-copied-groom`,
// `claude-groom-note` and `claude-groom-path`.

const KEY = 'TAP-9001';
const ATTACH = { kind: 'attach', command: 'claude attach ab12cd34' };
const GROOM_RESUME = {
  kind: 'resume',
  command: 'cd ~/pathwise && claude --resume 7d1e4a90-2b3c-4f58-8a6e-9c0d1e2f3a4b',
};
const PLAN_RESUME = {
  kind: 'resume',
  command: 'cd ~/pathwise && claude --resume 3f2b8c1e-5d4a-4e7b-9c60-1a2b3c4d5e6f',
};
const NOTE =
  'Works on any ticket, on its own. Needs no plan and changes nothing in Jira until you say so.';
const RUNNING = 'A Claude session is already running for this ticket.';
const UNAVAILABLE = 'Claude status is unavailable.';
const PLAN_DONE = {
  'investigate-and-plan': true,
  'implement-plan': false,
  done: true,
  approved: true,
};
const PLANNED = { ...PLAN_DONE, done: false };
// A groom session's own state, as the server lists it.
const GROOM = {
  working: { state: 'working', reason: 'running' },
  waiting: { state: 'waiting', reason: 'blocked' },
  done: { state: 'done', reason: 'finished' },
  failed: { state: 'failed', reason: 'session_missing' },
  unknown: { state: 'unknown', reason: 'listing_unavailable' },
};
const sessions = (investigate = null, implement = null, groom = null) => ({
  investigate,
  implement,
  groom,
});

const iconOf = (page, key = KEY) => page.getByTestId(`claude-icon-${key}`);
const bodiesTo = ({ data }, path) =>
  data.claude.calls.filter((call) => call.path === path).map((call) => call.body);

// The board with these Claude entries (a ticket with none is not started). The card is asserted
// first: a broken mock or a missing board is not a groom RED.
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

async function closeDialog(page) {
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('claude-dialog')).toHaveCount(0);
}

test('scenario 60: Groom ticket needs nothing, starts its own session and leaves the workflow alone', async ({
  page,
  dashboard,
}) => {
  await openBoard(page, dashboard);
  expect(await iconOf(page).getAttribute('data-state')).toBe('none');
  const dialog = await openDialog(page);

  // Groom ticket is not a step: it sits apart, below the workflow, with its note and (once it has
  // one) its own Go to session chip. The workflow strip holds exactly the three steps.
  await expect(dialog.locator('.claude-steps > li')).toHaveCount(3);
  const section = dialog.locator('.claude-groom');
  const groom = dialog.getByTestId('claude-action-groom');
  const goTo = dialog.getByTestId('claude-action-goto-groom');
  await expect(section.getByTestId('claude-action-groom')).toHaveText('Groom ticket');
  await expect(dialog.locator('.claude-steps').getByTestId('claude-action-groom')).toHaveCount(0);
  const implementBox = await dialog.getByTestId('claude-action-implement').boundingBox();
  const groomBox = await groom.boundingBox();
  expect(groomBox.y, 'Groom ticket is below Implement plan').toBeGreaterThan(
    implementBox.y + implementBox.height - 1,
  );
  await expect(dialog.getByTestId('claude-groom-note')).toHaveText(NOTE);
  await expect(dialog.getByTestId('claude-groom-path')).toHaveCount(0);

  // No precondition: a ticket never started can be groomed while Implement plan is still blocked,
  // and with no session there is nothing to join, so no chip and no hint about it.
  await expect(groom).toBeEnabled();
  await expect(dialog.getByTestId('claude-action-hint-groom')).toHaveCount(0);
  await expect(dialog.getByTestId('claude-action-implement')).toBeDisabled();
  await expect(goTo).toHaveCount(0);
  await expect(dialog.getByTestId('claude-action-hint-goto-groom')).toHaveCount(0);

  // The launch names the phase, and only the key and the phase.
  await groom.click();
  await expect
    .poll(() => bodiesTo(dashboard, '/api/claude/launch'))
    .toEqual([{ key: KEY, phase: 'groom' }]);
  // The session runs: the row says so, while the workflow's items and header are as they were.
  await expect(groom).toBeDisabled();
  await expect(dialog.getByTestId('claude-action-hint-groom')).toHaveText(RUNNING);
  await expect(goTo).toBeEnabled();
  await expect(section.getByTestId('claude-action-goto-groom')).toHaveText('Go to session');
  await expect(
    dialog.getByRole('button', { name: 'Go to groom ticket session', exact: true }),
  ).toHaveAttribute('data-testid', 'claude-action-goto-groom');
  await expect(dialog.getByTestId('claude-action-investigate')).toBeEnabled();
  await expect(dialog.getByTestId('claude-action-implement')).toBeDisabled();
  await expect(dialog.getByTestId('claude-dialog-state')).toHaveText('not started');
  await expect(iconOf(page)).toHaveAttribute('data-state', 'working');

  // Go to groom ticket session copies its own command, and only that one is marked copied.
  await goTo.click();
  await expect(dialog.getByTestId('claude-goto-copied-groom')).toContainText('Copied');
  await expect(dialog.getByTestId('claude-goto-copied-investigate')).toHaveCount(0);
  expect(await page.evaluate(() => window.__dashboardMock.clipboard.writes)).toEqual([
    ATTACH.command,
  ]);
});

test('scenario 61: the groom row follows its own session, whatever the workflow is doing', async ({
  page,
  dashboard,
}) => {
  await openBoard(page, dashboard, {
    // Plan ready and groomed: the groom file is named, and grooming can run again.
    [KEY]: claudeEntry('done', 'plan_ready', {
      flags: PLAN_DONE,
      groom: GROOM.done,
      goTo: sessions(PLAN_RESUME, null, GROOM_RESUME),
    }),
    // Investigate running: a finished groom is not held up by it.
    'TAP-9002': claudeEntry('working', 'running', {
      groom: GROOM.done,
      goTo: sessions(ATTACH, null, GROOM_RESUME),
    }),
    // Never started with a workflow, groom running: only groom is held.
    'TAP-9003': claudeEntry('none', null, {
      groom: GROOM.working,
      goTo: sessions(null, null, ATTACH),
    }),
    // The listing is unavailable: nothing can start or be joined.
    'TAP-9004': claudeEntry('unknown', 'listing_unavailable', { groom: GROOM.unknown }),
    // A groom session that vanished can be started again, and there is no file to name.
    'TAP-9005': claudeEntry('waiting', 'questions', {
      flags: PLANNED,
      questions: [claudeQuestion('q1', 'Which repo owns the fix?')],
      groom: GROOM.failed,
    }),
  });

  let dialog = await openDialog(page);
  await expect(dialog.getByTestId('claude-groom-note')).toHaveText(NOTE);
  await expect(dialog.getByTestId('claude-groom-path')).toHaveText(
    '~/pathwise/.orchestrator/tap-9001/groom.md',
  );
  await expect(dialog.getByTestId('claude-plan-hint')).toBeVisible();
  await expect(dialog.getByTestId('claude-action-groom')).toBeEnabled();
  await expect(dialog.getByTestId('claude-action-goto-groom')).toBeEnabled();
  await expect(dialog.getByTestId('claude-action-hint-goto-groom')).toHaveCount(0);
  await dialog.getByTestId('claude-action-goto-groom').click();
  await expect(dialog.getByTestId('claude-goto-copied-groom')).toContainText('Copied');
  expect(await page.evaluate(() => window.__dashboardMock.clipboard.writes)).toEqual([
    GROOM_RESUME.command,
  ]);
  await closeDialog(page);

  dialog = await openDialog(page, 'TAP-9002');
  await expect(dialog.getByTestId('claude-action-investigate')).toBeDisabled();
  await expect(dialog.getByTestId('claude-action-groom')).toBeEnabled();
  await expect(dialog.getByTestId('claude-action-hint-groom')).toHaveCount(0);
  await expect(dialog.getByTestId('claude-groom-path')).toHaveText(
    '~/pathwise/.orchestrator/tap-9002/groom.md',
  );
  await closeDialog(page);

  dialog = await openDialog(page, 'TAP-9003');
  await expect(dialog.getByTestId('claude-action-groom')).toBeDisabled();
  await expect(dialog.getByTestId('claude-action-hint-groom')).toHaveText(RUNNING);
  await expect(dialog.getByTestId('claude-action-investigate')).toBeEnabled();
  await expect(dialog.getByTestId('claude-action-goto-groom')).toBeEnabled();
  await expect(dialog.getByTestId('claude-groom-path')).toHaveCount(0);
  await closeDialog(page);

  dialog = await openDialog(page, 'TAP-9004');
  await expect(dialog.getByTestId('claude-action-groom')).toBeDisabled();
  await expect(dialog.getByTestId('claude-action-hint-groom')).toHaveText(UNAVAILABLE);
  // No session to join: no chip at all.
  await expect(dialog.getByTestId('claude-action-goto-groom')).toHaveCount(0);
  await closeDialog(page);

  dialog = await openDialog(page, 'TAP-9005');
  await expect(dialog.getByTestId('claude-action-groom')).toBeEnabled();
  await expect(dialog.getByTestId('claude-groom-path')).toHaveCount(0);
  // No session to join: no chip at all.
  await expect(dialog.getByTestId('claude-action-goto-groom')).toHaveCount(0);
});

test('scenario 62: the card icon follows grooming only for a ticket with no workflow record', async ({
  page,
  dashboard,
}) => {
  await openBoard(page, dashboard, {
    // No workflow record: the icon is the groom session's.
    'TAP-9002': claudeEntry('none', null, { groom: GROOM.working }),
    'TAP-9003': claudeEntry('none', null, { groom: GROOM.waiting }),
    'TAP-9004': claudeEntry('none', null, { groom: GROOM.done }),
    'TAP-9005': claudeEntry('none', null, { groom: GROOM.failed }),
    // A workflow record: the workflow's state wins, whatever the groom session is.
    [KEY]: claudeEntry('working', 'running', { groom: GROOM.failed }),
    'TAP-9007': claudeEntry('failed', 'ended_without_flag', { groom: GROOM.done }),
  });
  const grooming = /groom/i;
  for (const [key, state] of [
    ['TAP-9002', 'working'],
    ['TAP-9003', 'waiting'],
    ['TAP-9004', 'done'],
    ['TAP-9005', 'failed'],
  ]) {
    const icon = iconOf(page, key);
    await expect(icon, `${key} shows its groom session`).toHaveAttribute('data-state', state);
    await expect(icon).toHaveAttribute('aria-label', grooming);
    await expectTooltip(page, icon, grooming);
  }
  for (const [key, state] of [
    [KEY, 'working'],
    ['TAP-9007', 'failed'],
  ]) {
    const icon = iconOf(page, key);
    await expect(icon, `${key} keeps the workflow's state`).toHaveAttribute('data-state', state);
    await expect(icon).not.toHaveAttribute('aria-label', grooming);
  }
  // Nothing at all: as today.
  await expect(iconOf(page, 'TAP-9006')).toHaveAttribute('data-state', 'none');
  await expect(iconOf(page, 'TAP-9006')).not.toHaveAttribute('aria-label', grooming);
});
