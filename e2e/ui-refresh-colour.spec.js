import { test, expect } from './fixtures.js';
import { claudeEntry, ticketBoardData } from './data.js';

// Colour roles after the UI refresh: neutral ticket keys, the Jira status-kind colour on My Tickets,
// and lavender (`--support`) for Claude surfaces. Colours are read from the page, so a token's value
// is resolved by `colour(page, '--name')` and never written here.

const colour = (page, token) =>
  page.evaluate((name) => {
    // An undeclared token would resolve to the inherited colour and read as a wrong answer.
    if (!getComputedStyle(document.documentElement).getPropertyValue(name).trim())
      throw new Error(`token ${name} is not declared`);
    const probe = document.createElement('span');
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  }, token);

const KEY = 'TAP-9001';
const PLAN_DONE = {
  'investigate-and-plan': true,
  'implement-plan': false,
  done: true,
  approved: true,
};

test('ticket keys are the bright neutral, not the accent, and the assignee name follows the key', async ({
  page,
  dashboard,
}) => {
  ticketBoardData(dashboard.data);
  await page.goto('/#/my-tickets');
  const myKey = page.getByTestId(`my-tickets-item-link-${KEY}`);
  await expect(myKey).toBeVisible();
  const strong = await colour(page, '--strong');
  const accent = await colour(page, '--accent');
  expect(strong).not.toBe(accent);
  await expect(myKey).toHaveCSS('color', strong);

  dashboard.data.reviewTickets.tickets[0].assignee = 'Alex Example';
  await page.goto('/#/prs');
  const card = page.getByTestId('prs-ticket-DEMO-1');
  await expect(card).toBeVisible();
  const prKey = card.locator('.review-ticket-key').first();
  await expect(prKey).toHaveCSS('color', strong);
  const assignee = page.getByTestId('prs-ticket-assignee-DEMO-1').locator('span');
  await expect(assignee).toHaveText('Alex Example');
  await expect(assignee).toHaveCSS('color', strong);
});

test('status-kind: an active column and its cards are --status-active, an attention column is --red', async ({
  page,
  dashboard,
}) => {
  ticketBoardData(dashboard.data);
  await page.goto('/#/my-tickets');
  await expect(page.getByTestId('my-tickets-board')).toBeVisible();
  const active = await colour(page, '--status-active');
  const accent = await colour(page, '--accent');
  const red = await colour(page, '--red');
  expect(active).not.toBe(accent);

  const rgbOf = (value) =>
    value
      .replace(/^rgba?\(/, '')
      .replace(/\)$/, '')
      .split(',')
      .slice(0, 3);
  for (const [status, expected] of [
    ['In Progress', active],
    ['Blocked', red],
  ]) {
    const head = page.getByTestId(`my-tickets-column-head-${status.replace(/ /g, '-')}`);
    await expect(head).toBeVisible();
    // The column rule is an inset box-shadow in the kind colour.
    const rule = await head.evaluate((element) => getComputedStyle(element).boxShadow);
    expect(rule, `${status} column rule`).toContain(expected);

    // Each card's top bar is a decorative ::before filled with the same colour.
    const card = page
      .getByTestId(`my-tickets-column-body-${status.replace(/ /g, '-')}`)
      .locator('.board-card')
      .first();
    await expect(card).toBeVisible();
    const bar = await card.evaluate((element) => {
      const style = getComputedStyle(element, '::before');
      return {
        content: style.content,
        background: style.backgroundColor,
        height: style.height,
        position: style.position,
      };
    });
    expect(bar.content, `${status} card top bar exists`).not.toBe('none');
    expect(bar.position).toBe('absolute');
    expect(bar.height).toBe('2px');
    expect(rgbOf(bar.background), `${status} card top bar colour`).toEqual(rgbOf(expected));
  }
});

test('Claude colour: the Chat tab, the Sessions tab and the dialog primary use --support', async ({
  page,
  dashboard,
}) => {
  ticketBoardData(dashboard.data);
  Object.assign(dashboard.data.claude.tickets, {
    [KEY]: claudeEntry('done', 'plan_ready', {
      flags: PLAN_DONE,
      approvedAt: '2026-11-10T07:39:13.000Z',
      goTo: { investigate: null, implement: null, groom: null },
      questions: [],
    }),
  });
  await page.goto('/#/chat');
  const support = await colour(page, '--support');
  const accent = await colour(page, '--accent');
  expect(support).not.toBe(accent);

  // The active Chat tab.
  const chatTab = page.getByTestId('tab-chat');
  await expect(chatTab).toHaveClass(/\bactive\b/);
  await expect(chatTab).toHaveCSS('color', support);

  // The Sessions tab, open (its expanded state is the one that was cyan).
  const sessionsTab = page.getByTestId('sessions-tab');
  await sessionsTab.click();
  await expect(sessionsTab).toHaveAttribute('aria-expanded', 'true');
  await expect(sessionsTab).toHaveCSS('color', support);
  await expect(sessionsTab).toHaveCSS('border-top-color', support);
  // The open drawer lies over its own tab, so it closes with Escape.
  await page.keyboard.press('Escape');
  await expect(sessionsTab).toHaveAttribute('aria-expanded', 'false');

  // The Claude dialog's primary step button is filled with the support colour.
  await page.goto('/#/my-tickets');
  await expect(page.getByTestId(`my-tickets-item-${KEY}`)).toBeVisible();
  await page.getByTestId(`claude-icon-${KEY}`).click();
  const dialog = page.getByTestId('claude-dialog');
  await expect(dialog).toBeVisible();
  const primary = dialog.locator('.claude-steps .btn.primary');
  await expect(primary).toHaveCount(1);
  // The dialog is centred, so the pointer left on the icon can end up over the button (its hover tint).
  await page.mouse.move(0, 0);
  await expect(primary).toHaveCSS('background-color', support);
});
