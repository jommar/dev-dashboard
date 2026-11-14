import { test, expect } from './fixtures.js';
import { claudeEntry, ticketBoardData } from './data.js';

// A lazily loaded dialog (the E2E check, the artifact viewer) whose chunk cannot load, usually a tab
// that outlived a deploy. The Claude dialog under it is a modal, so everything outside it is inert:
// the failure alert must be a modal of its own, in front, or its Reload button cannot be clicked.
// The build under test is unminified, so a chunk's file name keeps its module name.
const KEY = 'TAP-9001';
const PLAN_FINISHED = {
  'investigate-and-plan': true,
  'implement-plan': false,
  done: true,
  approved: true,
};

async function openClaudeDialog(page, dashboard) {
  ticketBoardData(dashboard.data);
  dashboard.data.claude.tickets[KEY] = claudeEntry('done', 'plan_ready', { flags: PLAN_FINISHED });
  dashboard.data.claude.artifacts[KEY] = { '02-plan.md': '# Plan\n' };
  await page.goto('/#/my-tickets');
  await expect(page.getByTestId(`my-tickets-item-${KEY}`)).toBeVisible();
  await page.getByTestId(`claude-icon-${KEY}`).click();
  const dialog = page.getByTestId('claude-dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

const CASES = [
  { chunk: 'E2eCheckDialog', open: 'claude-action-e2e', label: 'The E2E check' },
  { chunk: 'ArtifactViewer', open: 'claude-view-plan', label: 'The artifact viewer' },
];

for (const { chunk, open, label } of CASES) {
  test(`a failed ${chunk} chunk shows a Reload that can be clicked over the Claude dialog`, async ({
    page,
    dashboard,
  }) => {
    await page.route(`**/assets/${chunk}*`, (route) => route.abort());
    const claude = await openClaudeDialog(page, dashboard);
    await claude.getByTestId(open).click();

    const alert = page.getByTestId('dialog-error');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(`${label} could not load`);
    const reload = alert.getByRole('button', { name: 'Reload' });
    // `trial` runs every actionability check, including "receives events", which fails when a modal
    // dialog's inert backdrop covers the control.
    await reload.click({ trial: true });

    // Close dismisses the alert and leaves the Claude dialog open under it.
    await alert.getByRole('button', { name: 'Close' }).click();
    await expect(alert).toHaveCount(0);
    await expect(claude).toBeVisible();
    await expect(claude.getByTestId('claude-dialog-close')).toBeEnabled();
  });
}

test('Reload on the failure alert reloads the page', async ({ page, dashboard }) => {
  await page.route('**/assets/ArtifactViewer*', (route) => route.abort());
  const claude = await openClaudeDialog(page, dashboard);
  await claude.getByTestId('claude-view-plan').click();
  const reload = page.getByTestId('dialog-error').getByRole('button', { name: 'Reload' });
  await expect(reload).toBeVisible();
  await page.evaluate(() => {
    window.__beforeReload = true;
  });
  await Promise.all([page.waitForEvent('load'), reload.click()]);
  expect(await page.evaluate(() => window.__beforeReload)).toBeUndefined();
});

test('Escape closes the failure alert first, not the Claude dialog under it', async ({
  page,
  dashboard,
}) => {
  await page.route('**/assets/E2eCheckDialog*', (route) => route.abort());
  const claude = await openClaudeDialog(page, dashboard);
  await claude.getByTestId('claude-action-e2e').click();
  await expect(page.getByTestId('dialog-error')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('dialog-error')).toHaveCount(0);
  await expect(claude).toBeVisible();
});
