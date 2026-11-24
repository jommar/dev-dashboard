import { test, expect } from './fixtures.js';
import {
  SPRINT_THREAD_TS,
  claudeEntry,
  withFinishedSprintTickets,
  withSprintSlackThreads,
} from './data.js';

// The Sprint tab (`#/sprint`): one team's sprint for its product owner. The fixture is
// `sprintBoardData` in e2e/data.js (Nexus Sprint 17 by default, Orion Sprint 3 beside it). Test ids:
//   sprint-section | title | meta | list, sprint-board, sprint-column-*, sprint-card-<KEY> and its
//   sprint-card-<KEY>-groom button, sprint-summary, sprint-reason-<id> (aria-pressed),
//   sprint-view-attention, sprint-attention-list, sprint-groom-batch, sprint-groom-dialog,
//   sprint-groom-item-<KEY>, sprint-groom-outcome-<KEY>, sprint-team-select, sprint-sprint-select,
//   slack-thread-link-<ts> (a card's thread chip), sprint-board-slack-coverage.

const STORAGE_KEY = 'dev-dashboard.sprint-board';
const NEXUS_TODO = ['NXS-106', 'NXS-108', 'NXS-110', 'NXS-107', 'NXS-109', 'NXS-111', 'NXS-105'];

const card = (page, key) => page.getByTestId(`sprint-card-${key}`);
// A card's Groom button shares the card's id prefix, so the cards are the ones that are not it.
const cardsIn = (scope) =>
  scope.locator('[data-testid^="sprint-card-"]:not([data-testid$="-groom"])');
const cardKeys = (scope) =>
  cardsIn(scope).evaluateAll((cards) =>
    cards.map((el) => el.dataset.testid.replace('sprint-card-', '')),
  );
const launches = ({ data }) =>
  data.claude.calls.filter((call) => call.path === '/api/claude/launch').map((call) => call.body);
const velocityReads = ({ requests }) =>
  requests.filter(({ path }) => path.startsWith('/api/team-velocity'));

const chosen = (select) => select.evaluate((el) => el.selectedOptions[0]?.textContent?.trim());
const storedChoice = (page) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key)), STORAGE_KEY);

async function openSprint(page) {
  await page.goto('/#/sprint');
  await expect(page.getByTestId('sprint-section')).toBeVisible();
  const board = page.getByTestId('sprint-board');
  await expect(board).toBeVisible();
  return board;
}

test.describe('Sprint tab', () => {
  test("each lane's copy button comes before its title and lists and copies the lane's keys", async ({
    page,
  }) => {
    const board = await openSprint(page);
    const lane = board.getByTestId('sprint-column-To-Do');
    const keys = await cardKeys(lane);
    expect(keys).toEqual(NEXUS_TODO);
    const copy = board.getByTestId('sprint-column-copy-To-Do');
    const title = lane.locator('.board-column-title');
    expect((await copy.boundingBox()).x).toBeLessThan((await title.boundingBox()).x);
    await copy.hover();
    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toContainText('Copy 7 ticket keys');
    for (const key of keys) await expect(tooltip).toContainText(key);
    await copy.click();
    expect(await page.evaluate(() => window.__dashboardMock.clipboard.writes.at(-1))).toBe(
      keys.join(' '),
    );
  });

  test("board shows every assignee's tickets in status columns with their card details", async ({
    page,
    dashboard,
  }) => {
    Object.assign(dashboard.data.claude.tickets, {
      'NXS-101': claudeEntry('working', 'running', { phase: 'implement-plan' }),
      'NXS-102': claudeEntry('none', null, {
        groom: { state: 'done', reason: 'finished', verdict: 'READY' },
      }),
    });
    const board = await openSprint(page);

    await expect(board.locator('.board-column-title')).toHaveText([
      'Blocked',
      'To Do',
      'In Progress',
      'Code Review',
      'Done',
    ]);
    await expect(cardsIn(board)).toHaveCount(11);
    const column = (status) =>
      board.locator('.board-column').filter({
        has: page.locator('.board-column-title', { hasText: new RegExp(`^${status}$`) }),
      });
    await expect(column('Blocked').getByTestId('sprint-card-NXS-103')).toBeVisible();
    await expect(column('Done').getByTestId('sprint-card-NXS-104')).toBeVisible();

    const first = card(page, 'NXS-101');
    await expect(first.getByRole('link', { name: 'NXS-101' })).toHaveAttribute(
      'href',
      'https://example.invalid/browse/NXS-101',
    );
    await expect(first).toContainText('Invented import of the route schedule');
    await expect(first).toContainText('Story');
    await expect(first).toContainText('Avery Quill');
    await expect(first).toContainText('5 pt');
    await expect(first).toContainText('In Progress');
    await expect(first).toContainText(/implement/i);
    await expect(first).toContainText(/working/i);

    const groomed = card(page, 'NXS-102');
    await expect(groomed).toContainText('Bryn Talbot');
    await expect(groomed).toContainText(/groom/i);
    await expect(groomed).toContainText('Ready');

    const unassigned = card(page, 'NXS-105');
    await expect(unassigned).toContainText('Unassigned');
    await expect(unassigned).toContainText('Not groomed');
    await expect(card(page, 'NXS-106')).toContainText('No estimate');
    await expect(card(page, 'NXS-103').locator('[data-reason="jira-blocked"]')).toHaveText(
      'Blocked',
    );
  });

  test('summary toggles filter both views and release on a second press', async ({ page }) => {
    const board = await openSprint(page);
    await expect(page.getByTestId('sprint-summary')).toBeVisible();
    const toggle = page.getByTestId('sprint-reason-unassigned');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => cardKeys(board)).toEqual(['NXS-105']);

    await page.getByTestId('sprint-view-attention').click();
    const list = page.getByTestId('sprint-attention-list');
    await expect(list).toBeVisible();
    await expect.poll(() => cardKeys(list)).toEqual(['NXS-105']);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    // Most important reason first (Blocked, Unassigned, No estimate, Not groomed), then key.
    await expect
      .poll(() => cardKeys(list))
      .toEqual([
        'NXS-103',
        'NXS-105',
        'NXS-106',
        'NXS-107',
        'NXS-108',
        'NXS-109',
        'NXS-110',
        'NXS-111',
      ]);
  });

  test('assignee filter scopes the board, summary, Needs attention view and resets on team switch', async ({
    page,
  }) => {
    const board = await openSprint(page);
    const select = page.getByTestId('sprint-assignee-select');
    await expect(select).toBeEnabled();
    await expect(select.locator('option')).toHaveText([
      'Everyone',
      'Avery Quill',
      'Bryn Talbot',
      'Unassigned',
    ]);

    await select.selectOption({ label: 'Avery Quill' });
    await expect
      .poll(() => cardKeys(board))
      .toEqual(['NXS-103', 'NXS-106', 'NXS-108', 'NXS-110', 'NXS-101']);
    await expect(page.getByTestId('sprint-summary')).toContainText('5 tickets');
    await expect(page.getByTestId('sprint-summary')).toContainText('11 pt committed');
    await expect(page.getByTestId('sprint-summary')).toContainText('0 pt done');
    await expect(page.getByTestId('sprint-view-attention')).toContainText('4');

    // Combines with attention reason toggles and applies to Needs attention view.
    await page.getByTestId('sprint-reason-jira-blocked').click();
    await expect.poll(() => cardKeys(board)).toEqual(['NXS-103']);
    await page.getByTestId('sprint-view-attention').click();
    await expect
      .poll(() => cardKeys(page.getByTestId('sprint-attention-list')))
      .toEqual(['NXS-103']);

    // Switching to Unassigned and clearing reason shows only the unassigned ticket.
    await page.getByTestId('sprint-reason-jira-blocked').click();
    await page.getByTestId('sprint-view-board').click();
    await select.selectOption({ label: 'Unassigned' });
    await expect.poll(() => cardKeys(board)).toEqual(['NXS-105']);

    // Team switch resets assignee to Everyone and omits Unassigned when none exist.
    await page.getByTestId('sprint-team-select').selectOption({ label: 'Orion' });
    await expect(card(page, 'ORB-201')).toBeVisible();
    await expect.poll(() => chosen(select)).toBe('Everyone');
    await expect(select.locator('option')).toHaveText(['Everyone', 'Casey Moor', 'Dale Ferris']);
  });

  test('card groom opens the Claude dialog for that ticket and launches nothing by itself', async ({
    page,
    dashboard,
  }) => {
    await openSprint(page);
    const groom = page.getByTestId('sprint-card-NXS-107-groom');
    await expect(groom).toHaveAccessibleName('Groom NXS-107');
    await expect(groom).toHaveAttribute('aria-haspopup', 'dialog');

    await groom.click();
    const dialog = page.getByTestId('claude-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('claude-dialog-title')).toContainText('NXS-107');
    expect(launches(dashboard)).toEqual([]);

    await dialog.getByTestId('claude-action-groom').click();
    await expect.poll(() => launches(dashboard)).toEqual([{ key: 'NXS-107', phase: 'groom' }]);
  });

  test('groom ungroomed lists five checked, launches the checked ones in turn, and Cancel sends none', async ({
    page,
    dashboard,
  }) => {
    await openSprint(page);
    const batch = page.getByTestId('sprint-groom-batch');
    await expect(batch).toBeEnabled();
    const listed = ['NXS-105', 'NXS-106', 'NXS-107', 'NXS-108', 'NXS-109'];
    const dialog = page.getByTestId('sprint-groom-dialog');
    const box = (key) => dialog.getByRole('checkbox', { name: new RegExp(`${key}\\b`) });

    await batch.click();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-testid^="sprint-groom-item-"]')).toHaveCount(5);
    for (const key of listed) {
      await expect(page.getByTestId(`sprint-groom-item-${key}`)).toBeVisible();
      await expect(box(key)).toBeChecked();
    }
    await expect(page.getByTestId('sprint-groom-item-NXS-110')).toHaveCount(0);
    await dialog.getByRole('button', { name: /cancel/i }).click();
    await expect(dialog).toBeHidden();
    expect(launches(dashboard)).toEqual([]);

    await batch.click();
    await expect(dialog).toBeVisible();
    await box('NXS-107').uncheck();
    await dialog.getByRole('button', { name: /confirm/i }).click();
    const started = ['NXS-105', 'NXS-106', 'NXS-108', 'NXS-109'];
    await expect
      .poll(() => launches(dashboard))
      .toEqual(started.map((key) => ({ key, phase: 'groom' })));
    for (const key of started)
      await expect(page.getByTestId(`sprint-groom-outcome-${key}`)).toHaveText(/started/i);

    // Every To Do ticket groomed: nothing is eligible, and the button says why.
    for (const key of NEXUS_TODO)
      dashboard.data.claude.tickets[key] = claudeEntry('none', null, {
        groom: { state: 'done', reason: 'finished', verdict: 'READY' },
      });
    await page.reload();
    await expect(page.getByTestId('sprint-board')).toBeVisible();
    await expect(batch).toBeDisabled();
    await expect(batch).toHaveAccessibleDescription(/\S/);
  });

  test('switch to another team loads its active sprint, keeps the choice across a reload and never reads velocity', async ({
    page,
    dashboard,
  }) => {
    await openSprint(page);
    const team = page.getByTestId('sprint-team-select');
    const sprint = page.getByTestId('sprint-sprint-select');
    await expect.poll(() => chosen(team)).toBe('Nexus');
    await expect.poll(() => chosen(sprint)).toContain('Nexus Sprint 17');
    await expect(card(page, 'NXS-101')).toBeVisible();

    await team.selectOption({ label: 'Orion' });
    await expect(card(page, 'ORB-201')).toBeVisible();
    await expect(card(page, 'NXS-101')).toHaveCount(0);
    await expect.poll(() => chosen(sprint)).toContain('Orion Sprint 3');
    expect(dashboard.requests.some(({ path }) => path === '/api/sprint-tickets?sprint=503')).toBe(
      true,
    );
    // A team change follows that team's active sprint, so it stores no sprint id.
    expect(await storedChoice(page)).toEqual({ version: 1, team: 'Orion', sprint: null });

    await page.reload();
    await expect(page.getByTestId('sprint-board')).toBeVisible();
    await expect.poll(() => chosen(team)).toBe('Orion');
    await expect(card(page, 'ORB-201')).toBeVisible();

    // Only an explicit pick of a sprint other than the active one pins its id.
    await team.selectOption({ label: 'Nexus' });
    await expect(card(page, 'NXS-101')).toBeVisible();
    await sprint.selectOption({ label: 'Nexus Sprint 15 (closed)' });
    await expect(page.getByTestId('sprint-no-matches')).toBeVisible();
    expect(await storedChoice(page)).toEqual({ version: 1, team: 'Nexus', sprint: 415 });
    await sprint.selectOption({ label: 'Nexus Sprint 17' });
    await expect(card(page, 'NXS-101')).toBeVisible();
    expect(await storedChoice(page)).toEqual({ version: 1, team: 'Nexus', sprint: null });
    expect(velocityReads(dashboard)).toEqual([]);
  });

  test('a confirmed groom batch keeps launching after the tab is left', async ({
    page,
    dashboard,
  }) => {
    await page.route('**/api/claude/launch', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await route.fallback();
    });
    await openSprint(page);
    await page.getByTestId('sprint-groom-batch').click();
    const dialog = page.getByTestId('sprint-groom-dialog');
    await dialog.getByRole('button', { name: /confirm/i }).click();
    await page.evaluate(() => {
      location.hash = '#/home';
    });
    await expect(dialog).toBeHidden();
    await expect
      .poll(() => launches(dashboard))
      .toEqual(
        ['NXS-105', 'NXS-106', 'NXS-107', 'NXS-108', 'NXS-109'].map((key) => ({
          key,
          phase: 'groom',
        })),
      );
  });

  test('a truncated team list says the pickers may miss sprints, and with no Claude answer the batch button says it waits', async ({
    page,
    dashboard,
  }) => {
    dashboard.data.sprintBoard.truncated = true;
    await page.route('**/api/claude/tickets*', (route) =>
      route.fulfill({ status: 500, json: { code: 'OPERATION_FAILED', error: 'Unavailable' } }),
    );
    await openSprint(page);
    await expect(page.getByTestId('sprint-board-teams-truncated')).toBeVisible();
    await expect(page.getByTestId('sprint-board-teams-truncated')).toContainText(
      /teams or sprints may be missing/i,
    );
    await expect(page.getByTestId('sprint-truncated')).toHaveCount(0);
    const batch = page.getByTestId('sprint-groom-batch');
    await expect(batch).toBeDisabled();
    await expect(batch).toHaveAccessibleDescription(/waiting/i);
  });

  test('a truncated ticket read says the board may be incomplete, and only that', async ({
    page,
    dashboard,
  }) => {
    dashboard.data.sprintBoard.ticketsTruncated = true;
    await openSprint(page);
    await expect(page.getByTestId('sprint-truncated')).toBeVisible();
    await expect(page.getByTestId('sprint-truncated')).toContainText(/not every ticket/i);
    await expect(page.getByTestId('sprint-board-teams-truncated')).toHaveCount(0);
  });

  test('finished tickets Jira files under Done: Rejected and Duplicate columns sit after Done, with no Groom and no reasons', async ({
    page,
    dashboard,
  }) => {
    withFinishedSprintTickets(dashboard.data);
    const board = await openSprint(page);

    await expect(board.locator('.board-column-title')).toHaveText([
      'Blocked',
      'To Do',
      'In Progress',
      'Code Review',
      'Done',
      'Rejected',
      'Duplicate',
    ]);
    for (const key of ['NXS-112', 'NXS-113', 'NXS-104']) {
      await expect(card(page, key)).toBeVisible();
      await expect(page.getByTestId(`sprint-card-${key}-groom`)).toHaveCount(0);
      await expect(card(page, key).locator('.sprint-board-reason')).toHaveCount(0);
    }
    await expect(page.getByTestId('sprint-card-NXS-101-groom')).toBeVisible();
  });

  test("a ticket's Slack threads show on its card, a reply owed flags it, and a chip opens the thread", async ({
    page,
    dashboard,
  }) => {
    withSprintSlackThreads(dashboard.data);
    const { owed, quiet } = SPRINT_THREAD_TS;
    const board = await openSprint(page);

    // The owed thread is under `mentions` only, so it shows because the board reads mentions too.
    const owedChip = card(page, 'TAP-9301').getByTestId(`slack-thread-link-${owed}`);
    await expect(owedChip).toBeVisible();
    await expect(owedChip).toHaveAccessibleName(/needs reply/);
    await expect(card(page, 'TAP-9302').getByTestId(`slack-thread-link-${quiet}`)).toBeVisible();
    await expect(card(page, 'NXS-101').locator('.slack-thread-link')).toHaveCount(0);
    await expect(page.getByTestId('sprint-board-slack-coverage')).toHaveCount(0);

    await expect(card(page, 'TAP-9301').locator('[data-reason="slack-reply"]')).toHaveText(
      'Slack reply owed',
    );
    await expect(card(page, 'TAP-9302').locator('[data-reason]')).toHaveCount(0);
    const toggle = page.getByTestId('sprint-reason-slack-reply');
    await expect(toggle.locator('.sprint-board-toggle-count')).toHaveText('1');
    await toggle.click();
    await expect.poll(() => cardKeys(board)).toEqual(['TAP-9301']);

    await owedChip.click();
    const close = page.getByTestId('slack-thread-close');
    await expect(close).toBeVisible();
    await expect(page.getByTestId(`slack-thread-message-${owed}`)).toBeVisible();
    await close.click();
    await expect(close).toBeHidden();
    await expect(owedChip).toBeFocused();
  });

  test('an incomplete Slack read says the threads may be missing, and the tickets never wait on it', async ({
    page,
    dashboard,
  }) => {
    withSprintSlackThreads(dashboard.data);
    dashboard.data.slack.threads.partial = true;
    let releaseSlack;
    const slackHeld = new Promise((resolve) => (releaseSlack = resolve));
    await page.route('**/api/slack/threads*', async (route) => {
      await slackHeld;
      await route.fallback();
    });
    await openSprint(page);
    await expect(card(page, 'TAP-9301')).toBeVisible();
    await expect(page.getByTestId('sprint-board-slack-coverage')).toHaveCount(0);

    releaseSlack();
    await expect(page.getByTestId('sprint-board-slack-coverage')).toContainText(/incomplete/i);
    await expect(
      card(page, 'TAP-9301').getByTestId(`slack-thread-link-${SPRINT_THREAD_TS.owed}`),
    ).toBeVisible();
  });
});
