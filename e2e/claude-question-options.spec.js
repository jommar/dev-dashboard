import { test, expect } from './fixtures.js';
import { claudeEntry, claudeQuestion, ticketBoardData } from './data.js';

// Lettered options inside a question's text show as choices above its answer box (the answer stays
// free text, written as "(b) its words"), and the Independent row's descriptions are tooltips.
// Test ids: `claude-question-<id>` is the box; `<form id>-<id>-option-options` is not stable, so the
// group is found by role.

const KEY = 'TAP-9001';
const PLANNED = { 'investigate-and-plan': true, 'implement-plan': false, done: false };
const OPTIONS_QUESTION =
  'How should totals refresh? (a) Right away (recommended); (b) on reopen only; (c) other.';
const PLAIN_QUESTION = 'Which repo owns the fix?';

async function openDialog(page, dashboard) {
  ticketBoardData(dashboard.data);
  dashboard.data.claude.tickets[KEY] = claudeEntry('waiting', 'questions', {
    flags: PLANNED,
    questions: [claudeQuestion('q1', OPTIONS_QUESTION), claudeQuestion('q2', PLAIN_QUESTION)],
  });
  await page.goto('/#/my-tickets');
  await expect(page.getByTestId(`my-tickets-item-${KEY}`)).toBeVisible();
  await page.getByTestId(`claude-icon-${KEY}`).click();
  const dialog = page.getByTestId('claude-dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

test('lettered options show as choices and the box still takes a custom answer', async ({
  page,
  dashboard,
}) => {
  const dialog = await openDialog(page, dashboard);
  const box = dialog.getByTestId('claude-question-q1');
  const group = dialog.getByRole('radiogroup', { name: 'How should totals refresh?' });
  const radios = group.getByRole('radio');

  await expect(radios).toHaveCount(3);
  await expect(group.getByText('Recommended')).toHaveCount(1);
  // The box keeps the question's words as its name.
  await expect(dialog.getByRole('textbox', { name: 'How should totals refresh?' })).toHaveCount(1);
  for (const radio of await radios.all()) await expect(radio).not.toBeChecked();

  // A choice writes its letter and words, never the "(recommended)" tag, and the tick follows.
  await radios.nth(0).check();
  await expect(box).toHaveValue('(a) Right away');
  await dialog.getByTestId('claude-questions-save').click();
  await expect
    .poll(() => dashboard.data.claude.calls.filter((call) => call.path === '/api/claude/answers'))
    .toMatchObject([{ body: { key: KEY, answers: { q1: '(a) Right away' } } }]);
  await expect(dialog.getByTestId('claude-question-answered-q1')).toBeVisible();
  await expect(radios.nth(0)).toBeChecked();
  await radios.nth(1).check();
  await expect(box).toHaveValue('(b) on reopen only');
  await expect(radios.nth(1)).toBeChecked();
  await expect(radios.nth(0)).not.toBeChecked();

  // Words of your own are an answer too: they unselect the letters and select Other.
  await box.fill('hold on, do TAP-2537 first');
  await expect(radios.nth(2)).toBeChecked();
  await expect(radios.nth(1)).not.toBeChecked();

  // Picking a letter and then Other drops the letter and hands the box over, focused.
  await radios.nth(0).check();
  await radios.nth(2).check();
  await expect(box).toHaveValue('');
  await expect(box).toBeFocused();

  // A question with no options is exactly the old textarea.
  await expect(dialog.getByRole('radiogroup')).toHaveCount(1);
  await expect(dialog.getByTestId('claude-question-q2')).toHaveValue('');
  await expect(dialog.getByText(PLAIN_QUESTION)).toBeVisible();
});

test('the Independent descriptions are tooltips, not lines under the row', async ({
  page,
  dashboard,
}) => {
  const dialog = await openDialog(page, dashboard);
  const groom = dialog.getByTestId('claude-action-groom');
  const note = 'Groom ticket works on any ticket, on its own.';

  // Still in the page for assistive tech and linked to the button, but not drawn.
  await expect(dialog.getByTestId('claude-groom-note')).toHaveClass(/sr-only/);
  await expect(dialog.getByTestId('claude-groom-note')).toContainText(note);
  await expect(groom).toHaveAccessibleDescription(new RegExp(note));
  await expect(groom).toHaveAccessibleName('Groom ticket');

  await groom.hover();
  await expect(page.getByRole('tooltip')).toContainText(note);
  await page.mouse.move(0, 0);
  await expect(page.getByRole('tooltip')).toHaveCount(0);

  // Keyboard focus shows it too: Tab from Groom ticket steps past its copy-prompt icon to E2E check.
  await groom.focus();
  await page.keyboard.press('Tab');
  await expect(dialog.getByTestId('claude-copy-prompt-groom')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByTestId('claude-action-e2e')).toBeFocused();
  await expect(page.getByRole('tooltip')).toContainText('E2E check opens a new browser');
});
