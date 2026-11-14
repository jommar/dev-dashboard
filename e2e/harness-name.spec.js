import { test, expect } from './fixtures.js';
import { claudeEntry, ticketBoardData } from './data.js';

// The harness words the page says come from `/api/config` `harness`, never a literal: with the Claude
// Code metadata (or none) the wording is the one the other specs pin, and with another harness's
// metadata the same places say its name. Invented sessions only; nothing is started.
//   TAP-9001  no Claude session: its dialog launches (and is refused)
//   TAP-9002  implement session working, in an active sprint: a Sessions drawer row (and a usage read
//             on a harness that has usage)

const KEY = 'TAP-9001';
const WORKING_KEY = 'TAP-9002';
const SESSION = '3f2b8c1e-5d4a-4e7b-9c60-1a2b3c4d5e6f';
const AIDER = {
  id: 'aider',
  label: 'Aider',
  name: 'Aider',
  command: 'aider',
  capabilities: { chat: false, usage: false },
};
const refusal = (status, code, reason) => ({
  status,
  json: { code, error: code.replace('_', ' '), errors: [reason] },
});
const usageRequests = ({ requests }) =>
  requests.filter(({ path }) => path.startsWith('/api/claude/usage'));

async function openBoard({ page }, { data }) {
  ticketBoardData(data);
  Object.assign(data.claude.tickets, {
    [WORKING_KEY]: claudeEntry('working', 'running', { phase: 'implement-plan' }),
  });
  data.claude.activeSprint.keys = [WORKING_KEY];
  data.claude.sessionIds = { [WORKING_KEY]: { implement: SESSION } };
  await page.goto('/#/my-tickets');
  await expect(page.getByTestId(`my-tickets-item-${KEY}`)).toBeVisible();
  await expect(page.getByTestId(`bot-bar-bot-${WORKING_KEY}-implement`)).toBeVisible();
}

async function refuseLaunch(page, response) {
  await page.route(
    (url) => url.pathname === '/api/claude/launch',
    (route) => route.fulfill(response),
  );
  await page.getByTestId(`claude-icon-${KEY}`).click();
  const dialog = page.getByTestId('claude-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('claude-action-investigate').click();
  return page.getByTestId('claude-error');
}

test('another harness: the drawer, the launch refusal and the composer use its name, and no usage is read', async ({
  page,
  dashboard,
}) => {
  dashboard.data.config.harness = AIDER;
  await openBoard({ page }, dashboard);

  // The Sessions drawer is titled by the harness and, having no usage, never asks for tokens.
  await page.getByTestId('sessions-tab').click();
  await expect(page.getByTestId('sessions-drawer').getByRole('heading', { level: 2 })).toHaveText(
    'Aider sessions',
  );
  await expect(page.getByTestId(`sessions-row-${WORKING_KEY}:implement`)).toBeVisible();
  await page.getByTestId('sessions-close').click();
  await expect(page.getByTestId('sessions-drawer')).toBeHidden();

  // A refused launch names the harness, with the article that fits it.
  const error = await refuseLaunch(page, refusal(409, 'CLAUDE_REFUSED', 'session_running'));
  await expect(error).toContainText('An Aider session is already running');
  await page.getByTestId('claude-dialog-close').click();

  // The Chat screen is read-only, in words, because the harness has no chat.
  await page.getByTestId('tab-chat').click();
  await expect(page.getByTestId('panel-chat')).toBeVisible();
  const composer = page.getByLabel('Message');
  await expect(composer).toHaveAttribute('readonly', '');
  await expect(composer).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByTestId('chat-disabled-reason')).toHaveText(
    'Chat is not available with Aider.',
  );
  await expect(page.getByTestId('chat-send')).toBeDisabled();

  expect(usageRequests(dashboard), 'a harness without usage is never asked for tokens').toEqual([]);
});

test('harness_unsupported reads as a sentence in the dialog and in the chat', async ({
  page,
  dashboard,
}) => {
  await openBoard({ page }, dashboard);
  const error = await refuseLaunch(page, refusal(409, 'CLAUDE_REFUSED', 'harness_unsupported'));
  await expect(error).toHaveText('This action is not available with Claude Code.');
  await page.getByTestId('claude-dialog-close').click();

  await page.route(
    (url) => url.pathname === '/api/claude/chat/send',
    (route) => route.fulfill(refusal(409, 'CLAUDE_REFUSED', 'harness_unsupported')),
  );
  await page.getByTestId('tab-chat').click();
  const composer = page.getByLabel('Message');
  await composer.fill('hello');
  await composer.press('Enter');
  await expect(page.getByTestId('chat-send-error')).toHaveText(
    'This action is not available with Claude Code.',
  );
});
