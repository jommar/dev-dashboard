import { test, expect } from './fixtures.js';
import {
  CLAUDE_PROMPT_DEFAULTS,
  claudeEntry,
  claudePromptEntry,
  claudePromptNotChanged,
  claudeQuestion,
  ticketBoardData,
} from './data.js';

// The prompt editor inside the Claude dialog. The fake API (e2e/data.js) lists four prompt files,
// `dashboard.data.claude.prompts.entries` by name (investigate, implement, answers), each `default`,
// `custom` or `unusable`; a spec changes an entry before the editor opens, and queues a response for
// the next prompt request in `prompts.failures`. PUT and DELETE are recorded in `claude.calls`.
//
// Test ids (each `<name>` is investigate, implement or answers): `claude-prompts-open` in the
// footer; `claude-prompts-view`, `claude-prompts-loading`, `claude-prompts-error`,
// `claude-prompts-retry`, `claude-prompts-back` in the editor view; per prompt `claude-prompt-<name>`
// (the text area), `claude-prompt-source-<name>` (the badge), `claude-prompt-save-<name>`,
// `claude-prompt-reset-<name>`, `claude-prompt-status-<name>`, `claude-prompt-dirty-<name>` and
// `claude-prompt-warning-<name>`. The footer is `.claude-dialog-foot` and the scrolling body
// `.claude-dialog-body` (classes: neither has a test id).

const KEY = 'TAP-9001';
const NAMES = ['investigate', 'implement', 'answers', 'groom'];
const LABELS = {
  investigate: 'Investigate and plan prompt',
  implement: 'Implement plan prompt',
  answers: 'Answers message',
  groom: 'Groom ticket prompt',
};
const WARNING =
  'This prompt does not contain {STATUS_FILE}, so the session cannot find status.json: questions, the flags and done will not work.';
const UNUSABLE_NOTE =
  'The file in the prompts folder cannot be used. Saving replaces it and Reset removes it. If either fails, check that a folder is not in its place.';
const NOT_CHANGED =
  'The prompt file could not be changed. Check that prompts/ is a real folder you can write to, with nothing in the place of the file.';
const PLANNED = { 'investigate-and-plan': true, 'implement-plan': false, done: false };
const QUESTION = 'Which repo owns the fix?';

const promptCalls = ({ data }) =>
  data.claude.calls.filter(({ path }) => path.startsWith('/api/claude/prompts'));
const promptReads = ({ requests }) =>
  requests.filter(({ method, path }) => method === 'GET' && path === '/api/claude/prompts');

// How far a footer control's left edge is from the footer's content-box left edge (inside its border
// and padding). A control that starts the footer is within a few pixels of it, whatever the width.
const insetFromStart = (foot, testId) =>
  foot.evaluate((footer, id) => {
    const box = footer.getBoundingClientRect();
    const style = getComputedStyle(footer);
    const start = box.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
    return footer.querySelector(`[data-testid="${id}"]`).getBoundingClientRect().left - start;
  }, testId);

// The board, with a ticket whose planning session asked a question (so the dialog has its answers
// controls) or none (so it has only the standing footer). The card is asserted first: a broken mock
// or a missing board is not an editor RED.
async function openBoard(page, dashboard, { questions = true } = {}) {
  ticketBoardData(dashboard.data);
  if (questions) {
    dashboard.data.claude.tickets[KEY] = claudeEntry('waiting', 'questions', {
      flags: PLANNED,
      questions: [claudeQuestion('q1', QUESTION)],
    });
  }
  await page.goto('/#/my-tickets');
  await expect(page.getByTestId('my-tickets-board')).toBeVisible();
  await expect(page.getByTestId(`my-tickets-item-${KEY}`)).toBeVisible();
}

async function openDialog(page) {
  await page.getByTestId(`claude-icon-${KEY}`).click();
  const dialog = page.getByTestId('claude-dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

// The dialog with the editor view showing its three prompts.
async function openEditor(page, dashboard, options) {
  await openBoard(page, dashboard, options);
  const dialog = await openDialog(page);
  await dialog.getByTestId('claude-prompts-open').click();
  await expect(dialog.getByTestId('claude-prompts-view')).toBeVisible();
  await expect(dialog.getByTestId('claude-prompt-investigate')).toBeVisible();
  return dialog;
}

// One prompt's controls.
const promptOf = (dialog, name) => ({
  box: dialog.getByTestId(`claude-prompt-${name}`),
  badge: dialog.getByTestId(`claude-prompt-source-${name}`),
  save: dialog.getByTestId(`claude-prompt-save-${name}`),
  reset: dialog.getByTestId(`claude-prompt-reset-${name}`),
  status: dialog.getByTestId(`claude-prompt-status-${name}`),
  dirty: dialog.getByTestId(`claude-prompt-dirty-${name}`),
  warning: dialog.getByTestId(`claude-prompt-warning-${name}`),
});

test('scenario 55: Prompts opens the editor in place of the answers, and Back returns with the answer draft kept', async ({
  page,
  dashboard,
}) => {
  dashboard.data.claude.prompts.entries.implement = claudePromptEntry(
    'implement',
    'custom',
    'Build the plan for {KEY}. Record progress in {STATUS_FILE}.',
  );
  await openBoard(page, dashboard);
  const dialog = await openDialog(page);
  const foot = dialog.locator('.claude-dialog-foot');

  // The footer's Prompts button is on its left, beside the answers controls.
  const open = foot.getByTestId('claude-prompts-open');
  await expect(open).toHaveText('Prompts');
  const [openBox, saveBox, closeBox] = await Promise.all(
    ['claude-prompts-open', 'claude-questions-save', 'claude-dialog-close'].map((id) =>
      foot.getByTestId(id).boundingBox(),
    ),
  );
  expect(openBox.x + openBox.width, 'Prompts is left of Save answers').toBeLessThanOrEqual(
    saveBox.x,
  );
  expect(openBox.x + openBox.width, 'Prompts is left of Close').toBeLessThanOrEqual(closeBox.x);
  // It starts the footer, with the progress text after it (the answers controls keep their places).
  expect(
    Math.abs(await insetFromStart(foot, 'claude-prompts-open')),
    'Prompts starts the footer',
  ).toBeLessThanOrEqual(4);
  const progressBox = await foot.getByTestId('claude-questions-progress').boundingBox();
  expect(progressBox.x, 'progress comes after Prompts').toBeGreaterThanOrEqual(
    openBox.x + openBox.width,
  );
  expect(progressBox.x + progressBox.width, 'progress comes before Save').toBeLessThanOrEqual(
    saveBox.x,
  );
  await expect(dialog.getByTestId('claude-prompts-view')).toHaveCount(0);

  // An answer typed and not saved must survive the swap and the way back.
  const answer = dialog.getByLabel(QUESTION);
  await answer.fill('half typed answer');

  // The editor fetches when it opens and says so while it waits.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => url.pathname === '/api/claude/prompts',
    async (route) => {
      await gate;
      await route.fallback().catch(() => {});
    },
  );
  try {
    await open.click();
    await expect(dialog.getByTestId('claude-prompts-loading')).toBeVisible();
  } finally {
    release();
  }
  const view = dialog.getByTestId('claude-prompts-view');
  await expect(view).toBeVisible();
  await expect(dialog.getByTestId('claude-prompt-investigate')).toBeVisible();
  await expect(dialog.getByTestId('claude-prompts-loading')).toHaveCount(0);
  expect(promptReads(dashboard)).toHaveLength(1);

  // The body is the editor; the header stays; the footer is Back and Close.
  await expect(dialog.getByTestId('claude-dialog-title')).toContainText(KEY);
  await expect(dialog.getByTestId('claude-questions')).toHaveCount(0);
  await expect(dialog.getByTestId('claude-action-investigate')).toHaveCount(0);
  await expect(foot.getByTestId('claude-prompts-back')).toBeVisible();
  await expect(foot.getByTestId('claude-dialog-close')).toBeVisible();
  expect(
    Math.abs(await insetFromStart(foot, 'claude-prompts-back')),
    'Back starts the footer',
  ).toBeLessThanOrEqual(4);
  await expect(dialog.getByTestId('claude-questions-save')).toHaveCount(0);
  await expect(dialog.getByTestId('claude-questions-progress')).toHaveCount(0);

  // Three prompts, each with its label, source badge, saved text and placeholders.
  const sources = {
    investigate: 'default',
    implement: 'custom',
    answers: 'default',
    groom: 'default',
  };
  const texts = {
    ...CLAUDE_PROMPT_DEFAULTS,
    implement: 'Build the plan for {KEY}. Record progress in {STATUS_FILE}.',
  };
  for (const name of NAMES) {
    const prompt = promptOf(dialog, name);
    await expect(view.getByRole('heading', { name: LABELS[name], exact: true })).toBeVisible();
    await expect(prompt.badge).toHaveText(sources[name]);
    await expect(prompt.box).toHaveValue(texts[name]);
    await expect(prompt.box).toHaveJSProperty('tagName', 'TEXTAREA');
    await expect(prompt.box).toHaveAttribute('maxlength', '20000');
    await expect(prompt.box).toHaveAttribute('autocomplete', 'off');
    await expect(prompt.box).toHaveAttribute('data-lpignore', 'true');
    await expect(prompt.box).toHaveAttribute('data-1p-ignore', 'true');
    await expect(prompt.box).toHaveAttribute('data-bwignore', 'true');
    expect(await prompt.box.evaluate((box) => getComputedStyle(box).fontFamily)).toMatch(/mono/i);
    await expect(prompt.status).toHaveAttribute('role', 'status');
    await expect(prompt.dirty).toHaveCount(0);
    await expect(prompt.warning).toHaveCount(0);
  }
  // A line of placeholders per prompt: three prompts name {KEY}, {SLUG} and {STATUS_FILE}, and only
  // the answers message adds {QUESTION_IDS} and {CHANGE}; grooming has no status file and lists
  // {KEY} and {SLUG} alone. The warning for a missing {STATUS_FILE} is checked above for all four:
  // grooming never has one to miss.
  await expect(view.getByText(/\{KEY\}\W+\{SLUG\}\W*$/)).toHaveCount(1);
  await expect(view.getByText(/\{KEY\}\W+\{SLUG\}\W+\{STATUS_FILE\}/)).toHaveCount(3);
  await expect(view.getByText(/\{QUESTION_IDS\}\W+\{CHANGE\}/)).toHaveCount(1);

  // Back returns to the answers, with the draft still in the box and still unsaved.
  await foot.getByTestId('claude-prompts-back').click();
  await expect(dialog.getByTestId('claude-prompts-view')).toHaveCount(0);
  await expect(answer).toHaveValue('half typed answer');
  await expect(dialog.getByTestId('claude-questions-save')).toBeEnabled();
  await expect(foot.getByTestId('claude-prompts-open')).toBeVisible();
});

test('scenario 56: a prompt is saved and reset, shows what is unsaved, and warns without blocking when {STATUS_FILE} is missing', async ({
  page,
  dashboard,
}) => {
  const dialog = await openEditor(page, dashboard);
  const investigate = promptOf(dialog, 'investigate');
  const built = CLAUDE_PROMPT_DEFAULTS.investigate;

  // Untouched: nothing to save, nothing to reset, nothing said.
  await expect(investigate.status).toHaveText('');
  await expect(investigate.save).toBeDisabled();
  await expect(investigate.reset).toBeDisabled();

  // Unsaved changes are tagged and can be saved, unless the text is empty after trimming.
  await investigate.box.fill(`${built} Also list the open questions.`);
  await expect(investigate.dirty).toHaveText('Unsaved changes');
  await expect(investigate.save).toBeEnabled();
  await investigate.box.fill('   ');
  await expect(investigate.dirty).toBeVisible();
  await expect(investigate.save).toBeDisabled();
  await investigate.box.fill(built);
  await expect(investigate.dirty).toHaveCount(0);
  await expect(investigate.save).toBeDisabled();
  for (const other of ['implement', 'answers', 'groom']) {
    const prompt = promptOf(dialog, other);
    await expect(prompt.dirty).toHaveCount(0);
    await expect(prompt.save).toBeDisabled();
  }

  // The warning follows the draft: it shows without {STATUS_FILE}, goes when it is typed back and
  // never stops Save.
  await investigate.box.fill('Work out the plan for {KEY}.');
  await expect(investigate.warning).toHaveText(WARNING);
  await expect(investigate.warning).toHaveAttribute('role', 'status');
  await expect(investigate.save).toBeEnabled();
  await investigate.box.fill('Work out the plan for {KEY}. Record progress in {STATUS_FILE}.');
  await expect(investigate.warning).toHaveCount(0);
  await investigate.box.fill('Work out the plan for {KEY}.');
  await expect(investigate.warning).toHaveText(WARNING);
  // Only a prompt whose placeholders include {STATUS_FILE} can miss it: grooming has none.
  const groom = promptOf(dialog, 'groom');
  await groom.box.fill('Groom ticket {KEY} and say what is missing.');
  await expect(groom.dirty).toBeVisible();
  await expect(groom.warning).toHaveCount(0);
  await groom.box.fill(CLAUDE_PROMPT_DEFAULTS.groom);
  await expect(groom.dirty).toHaveCount(0);

  // Save sends the text, and what the server returns becomes the prompt's saved state.
  await investigate.save.click();
  await expect(investigate.status).toHaveText('Saved.');
  await expect(investigate.badge).toHaveText('custom');
  await expect(investigate.box).toHaveValue('Work out the plan for {KEY}.');
  await expect(investigate.dirty).toHaveCount(0);
  await expect(investigate.save).toBeDisabled();
  await expect(investigate.reset).toBeEnabled();
  await expect(investigate.warning).toHaveText(WARNING);
  expect(promptCalls(dashboard)).toEqual([
    {
      method: 'PUT',
      path: '/api/claude/prompts/investigate',
      body: { text: 'Work out the plan for {KEY}.' },
    },
  ]);

  // Reset removes the file: the built-in text is back and there is nothing left to reset.
  await investigate.reset.click();
  await expect(investigate.status).toHaveText('Reset to default.');
  await expect(investigate.badge).toHaveText('default');
  await expect(investigate.box).toHaveValue(built);
  await expect(investigate.reset).toBeDisabled();
  await expect(investigate.save).toBeDisabled();
  await expect(investigate.warning).toHaveCount(0);
  expect(promptCalls(dashboard).at(-1)).toEqual({
    method: 'DELETE',
    path: '/api/claude/prompts/investigate',
    body: undefined,
  });
  expect(promptCalls(dashboard)).toHaveLength(2);
});

test('scenario 57: an unusable file is flagged, shows the built-in text, and can be fixed or reset', async ({
  page,
  dashboard,
}) => {
  const { entries } = dashboard.data.claude.prompts;
  entries.implement = claudePromptEntry('implement', 'unusable');
  entries.answers = claudePromptEntry('answers', 'unusable');
  const dialog = await openEditor(page, dashboard);
  const implement = promptOf(dialog, 'implement');
  const answers = promptOf(dialog, 'answers');
  const investigate = promptOf(dialog, 'investigate');

  await expect(implement.badge).toHaveText('unusable file');
  await expect(answers.badge).toHaveText('unusable file');
  await expect(investigate.badge).toHaveText('default');
  await expect(dialog.getByText(UNUSABLE_NOTE)).toHaveCount(2);
  await expect(implement.box).toHaveValue(CLAUDE_PROMPT_DEFAULTS.implement);
  await expect(answers.box).toHaveValue(CLAUDE_PROMPT_DEFAULTS.answers);
  await expect(implement.reset).toBeEnabled();
  await expect(answers.reset).toBeEnabled();
  await expect(investigate.reset).toBeDisabled();
  await expect(implement.save).toBeDisabled();

  // Saving a fix replaces the file: the prompt is custom and its note goes.
  const fixed = `${CLAUDE_PROMPT_DEFAULTS.implement} Read the plan first.`;
  await implement.box.fill(fixed);
  await implement.save.click();
  await expect(implement.status).toHaveText('Saved.');
  await expect(implement.badge).toHaveText('custom');
  await expect(implement.box).toHaveValue(fixed);
  await expect(dialog.getByText(UNUSABLE_NOTE)).toHaveCount(1);

  // Reset removes the other: the built-in text applies and its note goes too.
  await answers.reset.click();
  await expect(answers.status).toHaveText('Reset to default.');
  await expect(answers.badge).toHaveText('default');
  await expect(dialog.getByText(UNUSABLE_NOTE)).toHaveCount(0);
  expect(promptCalls(dashboard).map(({ method, path }) => `${method} ${path}`)).toEqual([
    'PUT /api/claude/prompts/implement',
    'DELETE /api/claude/prompts/answers',
  ]);
});

test('scenario 58: a failed load can be retried, a failed save or reset says why and keeps what was there, and Close ends the editor', async ({
  page,
  dashboard,
}) => {
  const { failures } = dashboard.data.claude.prompts;
  failures.push({
    status: 502,
    json: { code: 'CLAUDE_FAILED', error: 'CLAUDE FAILED', errors: [] },
  });
  await openBoard(page, dashboard);
  let dialog = await openDialog(page);
  await dialog.getByTestId('claude-prompts-open').click();
  await expect(dialog.getByTestId('claude-prompts-error')).toBeVisible();
  await expect(dialog.getByTestId('claude-prompt-investigate')).toHaveCount(0);

  await dialog.getByTestId('claude-prompts-retry').click();
  await expect(dialog.getByTestId('claude-prompt-investigate')).toBeVisible();
  await expect(dialog.getByTestId('claude-prompts-error')).toHaveCount(0);
  expect(promptReads(dashboard)).toHaveLength(2);

  // A save that cannot write the file says why in words and leaves the draft where it was.
  const investigate = promptOf(dialog, 'investigate');
  failures.push(claudePromptNotChanged());
  const draft = 'Work out the plan for {KEY}. Record progress in {STATUS_FILE}.';
  await investigate.box.fill(draft);
  await investigate.save.click();
  await expect(investigate.status).toHaveText(NOT_CHANGED);
  await expect(investigate.box).toHaveValue(draft);
  await expect(investigate.dirty).toBeVisible();
  await expect(investigate.badge).toHaveText('default');
  await expect(investigate.save).toBeEnabled();
  await investigate.save.click();
  await expect(investigate.status).toHaveText('Saved.');
  await expect(investigate.badge).toHaveText('custom');

  // A reset that cannot remove the file says the same and leaves the custom prompt as it was.
  failures.push(claudePromptNotChanged());
  await investigate.reset.click();
  await expect(investigate.status).toHaveText(NOT_CHANGED);
  await expect(investigate.badge).toHaveText('custom');
  await expect(investigate.box).toHaveValue(draft);
  await expect(investigate.reset).toBeEnabled();

  // Close closes the whole dialog; opened again it shows the answers, not the editor.
  await dialog.locator('.claude-dialog-foot').getByTestId('claude-dialog-close').click();
  await expect(page.getByTestId('claude-dialog')).toHaveCount(0);
  dialog = await openDialog(page);
  await expect(dialog.getByTestId('claude-prompts-view')).toHaveCount(0);
  await expect(dialog.getByTestId('claude-action-investigate')).toBeVisible();
});

test('scenario 59: at 390px the editor does not overflow sideways and Back and Close stay on screen', async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ width: 390, height: 700 });
  dashboard.data.claude.prompts.entries.implement = claudePromptEntry('implement', 'unusable');
  const dialog = await openEditor(page, dashboard);
  // A long unbroken line with no {STATUS_FILE}: the unsaved tag and the warning both show.
  const investigate = promptOf(dialog, 'investigate');
  await investigate.box.fill('x'.repeat(300));
  await expect(investigate.dirty).toBeVisible();
  await expect(investigate.warning).toBeVisible();
  await expect(dialog.getByText(UNUSABLE_NOTE)).toBeVisible();

  const body = dialog.locator('.claude-dialog-body');
  expect(
    await body.evaluate((box) => box.scrollHeight - box.clientHeight),
    'three prompts are taller than the body, which scrolls',
  ).toBeGreaterThan(0);
  expect(await body.evaluate((box) => box.scrollWidth - box.clientWidth)).toBeLessThanOrEqual(0);
  const frame = await dialog.boundingBox();
  expect(frame.x + frame.width).toBeLessThanOrEqual(390);
  for (const name of NAMES) {
    const box = await promptOf(dialog, name).box.boundingBox();
    expect(box.x, `${name} starts inside the dialog`).toBeGreaterThanOrEqual(frame.x);
    expect(box.x + box.width, `${name} ends inside the dialog`).toBeLessThanOrEqual(
      frame.x + frame.width,
    );
  }

  // Back and Close are on screen without scrolling the body.
  expect(await body.evaluate((box) => box.scrollTop)).toBe(0);
  const foot = dialog.locator('.claude-dialog-foot');
  await expect(foot).toBeInViewport({ ratio: 1 });
  await expect(foot.getByTestId('claude-prompts-back')).toBeInViewport({ ratio: 1 });
  await expect(foot.getByTestId('claude-dialog-close')).toBeInViewport({ ratio: 1 });
  expect(
    Math.abs(await insetFromStart(foot, 'claude-prompts-back')),
    'Back starts the footer',
  ).toBeLessThanOrEqual(4);
});
