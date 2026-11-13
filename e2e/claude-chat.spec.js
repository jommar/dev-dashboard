import { test, expect, chatSay, openChatStreams } from './fixtures.js';
import { CHAT_SESSION_ID, claudeEntry } from './data.js';

// The Chat screen (`#/chat`, `#/chat?session=<uuid>`), the chat bots and the drawer's Chat link:
// plan scenarios 11 to 16. The server's stream is the mock EventSource of fixtures.js; a spec sends
// what the server would (`hello` first) with `chatSay`. Invented sessions only.
//
// Test ids this spec relies on (a contract, so a refactor never renames them):
//   chat-list, chat-new (New chat), chat-list-item-<uuid>
//   chat-main, chat-title, chat-state (the state pill), chat-log (role=log)
//   chat-message-<item id> (data-kind user|assistant), chat-copy-<item id> (Copy on a message)
//   chat-tail (the reply being written), chat-tool-<tool id> (a <details>, data-status running|done|failed)
//   chat-turn-note (an error or denials note under the turn), chat-disabled-reason
//   chat-stop, chat-retry, chat-refresh, chat-send; the composer is the textarea labelled "Message"
//   a code block's button is named "Copy code"
//   bot: bot-bar-bot-chat-<first 8 of the uuid>-chat; drawer: sessions-row-<key>, sessions-open-<key>,
//   sessions-chat-<ticket>:<phase> (the "Chat" link of a ticket row); a chat's key is <uuid>:chat

const SESSION = '8c1d4e7f-3a2b-4c5d-9e6f-0a1b2c3d4e5f';
const USER = { id: 'u1', kind: 'user', text: 'Summarise the build setup' };
const ANSWER = { id: 'a1', kind: 'assistant', text: 'Two steps: install, then build.' };
const hello = (overrides = {}) => ({
  session: SESSION,
  kind: 'chat',
  title: 'Summarise the build setup',
  state: 'idle',
  live: false,
  items: [],
  truncated: false,
  turn: null,
  ...overrides,
});
const turn = (overrides = {}) => ({
  outcome: 'completed',
  reason: null,
  error: null,
  denials: [],
  costUsd: 0.01,
  ...overrides,
});
const composer = (page) => page.getByLabel('Message');
const callsTo = ({ data }, path) => data.claude.calls.filter((call) => call.path === path);
const hour = 60 * 60 * 1000;
const chatEntry = (id, state, ageMs, title) => ({
  id,
  title,
  state,
  createdAt: new Date(Date.now() - ageMs - hour).toISOString(),
  lastActiveAt: new Date(Date.now() - ageMs).toISOString(),
  goTo:
    state === 'working'
      ? null
      : { kind: 'resume', command: `cd ~/pathwise && claude --resume ${id}` },
});

test('scenario 11: a first message starts a chat, replies stream in and render Markdown with a copyable code block', async ({
  page,
  dashboard,
}) => {
  await page.goto('/#/home');
  expect(await openChatStreams(page), 'no chat stream off the Chat screen').toEqual([]);
  await page.getByTestId('tab-chat').click();
  await expect(page.getByTestId('panel-chat')).toBeVisible();
  expect(await openChatStreams(page), 'a new, unsent chat has no stream').toEqual([]);

  await composer(page).fill('Summarise the build');
  await composer(page).press('Shift+Enter');
  await composer(page).pressSequentially('in one paragraph');
  await composer(page).press('Enter');

  // One send, carrying the whole message and no session; the hash follows the new chat.
  await expect(page).toHaveURL(new RegExp(`#/chat\\?session=${CHAT_SESSION_ID}$`));
  const sends = callsTo(dashboard, '/api/claude/chat/send');
  expect(sends).toHaveLength(1);
  expect(sends[0].body).toEqual({ message: 'Summarise the build\nin one paragraph' });

  const user = { id: 'u1', kind: 'user', text: 'Summarise the build\nin one paragraph' };
  await chatSay(
    page,
    CHAT_SESSION_ID,
    'hello',
    hello({ session: CHAT_SESSION_ID, state: 'working', live: true, items: [user] }),
  );
  await expect(page.getByTestId('chat-message-u1')).toContainText('Summarise the build');
  await expect(page.getByTestId('chat-message-u1')).toContainText('in one paragraph');

  // Deltas grow one reply, which the finished item replaces.
  await chatSay(page, CHAT_SESSION_ID, 'delta', { text: 'Run ' });
  await chatSay(page, CHAT_SESSION_ID, 'delta', { text: 'the build' });
  await expect(page.getByTestId('chat-tail')).toHaveText('Run the build');
  await chatSay(page, CHAT_SESSION_ID, 'item', {
    item: {
      id: 'a1',
      kind: 'assistant',
      text: 'Run **the build**:\n\n```sh\nnpm run build\n```\n',
    },
  });
  await chatSay(page, CHAT_SESSION_ID, 'state', { state: 'idle', turn: turn() });
  await expect(page.getByTestId('chat-tail')).toHaveCount(0);
  const reply = page.getByTestId('chat-message-a1');
  await expect(reply.locator('strong')).toHaveText('the build');
  await expect(reply.locator('pre')).toContainText('npm run build');

  await reply.getByRole('button', { name: 'Copy code' }).click();
  expect(await page.evaluate(() => window.__dashboardMock.clipboard.writes.at(-1))).toBe(
    'npm run build',
  );
  expect(await openChatStreams(page)).toEqual([CHAT_SESSION_ID]);

  // The stream belongs to the Chat screen: leaving it lets go of it.
  await page.getByTestId('tab-home').click();
  await expect.poll(() => openChatStreams(page)).toEqual([]);
});

test('scenario 12: a tool call is one collapsible chip, running then done, or failed', async ({
  page,
}) => {
  await page.goto(`/#/chat?session=${SESSION}`);
  await chatSay(page, SESSION, 'hello', hello({ state: 'working', live: true, items: [USER] }));
  const tool = {
    id: 'toolu_1',
    kind: 'tool',
    name: 'Read',
    input: '{"file_path":"/work/package.json"}',
    result: null,
    truncated: false,
  };
  await chatSay(page, SESSION, 'item', { item: tool });
  const chip = page.getByTestId('chat-tool-toolu_1');
  await expect(chip).toContainText('Read');
  await expect(chip).toHaveAttribute('data-status', 'running');
  await expect(chip).toHaveJSProperty('open', false);

  await chatSay(page, SESSION, 'item', {
    item: { ...tool, result: { text: 'name: dev-dashboard', isError: false } },
  });
  await expect(chip).toHaveAttribute('data-status', 'done');
  await expect(page.locator('[data-testid^="chat-tool-"]')).toHaveCount(1);
  await expect(chip).toHaveJSProperty('open', false);

  await chip.locator('summary').click();
  await expect(chip).toHaveJSProperty('open', true);
  await expect(chip).toContainText('/work/package.json');
  await expect(chip).toContainText('name: dev-dashboard');

  await chatSay(page, SESSION, 'item', {
    item: { ...tool, id: 'toolu_2', result: { text: 'no such file', isError: true } },
  });
  await expect(page.getByTestId('chat-tool-toolu_2')).toHaveAttribute('data-status', 'failed');
});

test('scenario 13: a live turn disables the composer and shows Stop, which sends one stop', async ({
  page,
  dashboard,
}) => {
  await page.goto(`/#/chat?session=${SESSION}`);
  await chatSay(page, SESSION, 'hello', hello({ state: 'working', live: true, items: [USER] }));
  await expect(page.getByTestId('chat-state')).toContainText(/working/i);
  await expect(composer(page)).toBeDisabled();
  await page.getByTestId('chat-stop').click();
  await expect.poll(() => callsTo(dashboard, '/api/claude/chat/stop')).toHaveLength(1);
  expect(callsTo(dashboard, '/api/claude/chat/stop')[0].body).toEqual({ session: SESSION });

  await chatSay(page, SESSION, 'state', { state: 'idle', turn: turn({ outcome: 'stopped' }) });
  await expect(page.getByTestId('chat-stop')).toHaveCount(0);
  await expect(composer(page)).toBeEnabled();
});

test('scenario 13: a failed turn shows its error and Retry sends the last message again', async ({
  page,
  dashboard,
}) => {
  await page.goto(`/#/chat?session=${SESSION}`);
  await chatSay(page, SESSION, 'hello', hello({ state: 'working', live: true, items: [USER] }));
  await chatSay(page, SESSION, 'state', {
    state: 'idle',
    turn: turn({ outcome: 'failed', reason: 'api_error', error: 'Credit balance is too low' }),
  });
  await expect(page.getByTestId('chat-turn-note')).toContainText('Credit balance is too low');
  await page.getByTestId('chat-retry').click();
  await expect.poll(() => callsTo(dashboard, '/api/claude/chat/send')).toHaveLength(1);
  expect(callsTo(dashboard, '/api/claude/chat/send')[0].body).toEqual({
    message: USER.text,
    session: SESSION,
  });
});

test('scenario 13: permission denials are named in a note and a message can be copied', async ({
  page,
}) => {
  await page.goto(`/#/chat?session=${SESSION}`);
  await chatSay(
    page,
    SESSION,
    'hello',
    hello({ items: [USER, ANSWER], turn: turn({ denials: ['Write'] }) }),
  );
  await expect(page.getByTestId('chat-turn-note')).toContainText('Write');
  await page.getByTestId('chat-copy-a1').click();
  expect(await page.evaluate(() => window.__dashboardMock.clipboard.writes.at(-1))).toBe(
    ANSWER.text,
  );
});

test('scenario 14: a session running elsewhere is read-only, and Refresh opens the stream again', async ({
  page,
}) => {
  await page.goto(`/#/chat?session=${SESSION}`);
  await chatSay(
    page,
    SESSION,
    'hello',
    hello({ kind: 'session', state: 'working', live: false, items: [USER, ANSWER] }),
  );
  await expect(page.getByTestId('chat-message-a1')).toBeVisible();
  await expect(composer(page)).toBeDisabled();
  await expect(page.getByTestId('chat-disabled-reason')).toContainText(/running outside the chat/i);
  await expect(page.getByTestId('chat-stop')).toHaveCount(0);

  const streamsOpened = () =>
    page.evaluate(
      (id) => window.__dashboardMock.chats.filter((it) => it.session === id).length,
      SESSION,
    );
  expect(await streamsOpened()).toBe(1);
  await page.getByTestId('chat-refresh').click();
  await expect.poll(streamsOpened).toBe(2);
  expect(await openChatStreams(page)).toEqual([SESSION]);

  await chatSay(
    page,
    SESSION,
    'hello',
    hello({ kind: 'session', state: 'idle', items: [USER, ANSWER] }),
  );
  await expect(composer(page)).toBeEnabled();
});

test('scenario 15: a chat has a bot and a drawer row outside the sprint filter, and opens in Chat', async ({
  page,
  dashboard,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const recent = '3f2b8c1a-5d4e-4f60-9a7b-1c2d3e4f5a6b';
  const stale = '9a8b7c6d-1e2f-4a3b-8c4d-5e6f7a8b9c0d';
  // One ticket session in no active sprint, so the sprint is asked about something, and two chats.
  dashboard.data.claude.tickets['BOT-1'] = claudeEntry('working', 'running', {
    phase: 'implement-plan',
  });
  dashboard.data.claude.activeSprint.keys = [];
  dashboard.data.claude.chats = [
    chatEntry(recent, 'done', 2 * hour, 'Plan the release notes'),
    chatEntry(stale, 'done', 25 * hour, 'An old chat'),
  ];
  await page.goto('/#/services');
  const bot = page.getByTestId('bot-bar-bot-chat-3f2b8c1a-chat');
  await expect(bot).toBeVisible();
  await expect(page.getByTestId('bot-bar-bot-chat-9a8b7c6d-chat')).toHaveCount(0);
  await expect(page.getByTestId('bot-bar-bot-BOT-1-implement')).toHaveCount(0);

  // The chat never reaches Jira.
  await expect
    .poll(() =>
      dashboard.requests.some(({ path }) => path.startsWith('/api/active-sprint-tickets')),
    )
    .toBe(true);
  for (const { path } of dashboard.requests.filter(({ path }) =>
    path.startsWith('/api/active-sprint-tickets'),
  ))
    expect(decodeURIComponent(path)).not.toMatch(/chat-|3f2b8c1a|9a8b7c6d/);

  await page.getByTestId('sessions-tab').click();
  await expect(page.getByTestId(`sessions-row-${recent}:chat`)).toContainText(
    'Plan the release notes',
  );
  await expect(page.getByTestId(`sessions-row-${stale}:chat`)).toHaveCount(0);

  // The row and the bot both go to the chat, and neither opens a dialog.
  await page.getByTestId(`sessions-open-${recent}:chat`).click();
  await expect(page).toHaveURL(new RegExp(`#/chat\\?session=${recent}$`));
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await page.getByTestId('tab-services').click();
  await expect(page).toHaveURL(/#\/services$/);
  await bot.click();
  await expect(page).toHaveURL(new RegExp(`#/chat\\?session=${recent}$`));
  await expect(page.locator('dialog[open]')).toHaveCount(0);
});

test('scenario 16: a ticket session opens in Chat from the drawer, and the link survives a reload', async ({
  page,
  dashboard,
}) => {
  dashboard.data.claude.tickets['BOT-1'] = claudeEntry('working', 'running', {
    phase: 'implement-plan',
  });
  dashboard.data.claude.tickets['BOT-2'] = claudeEntry('none', null, {
    review: { state: 'done', reason: 'finished' },
  });
  dashboard.data.claude.activeSprint.keys = ['BOT-1', 'BOT-2'];
  dashboard.data.claude.sessionIds = { 'BOT-1': { implement: SESSION } };
  await page.goto('/#/services');
  await page.getByTestId('sessions-tab').click();

  // Only the row with a session id has a Chat link, and Open still opens the dialog.
  await expect(page.getByTestId('sessions-chat-BOT-1:implement')).toHaveAttribute(
    'href',
    `#/chat?session=${SESSION}`,
  );
  await expect(page.getByTestId('sessions-chat-BOT-2:review')).toHaveCount(0);
  await page.getByTestId('sessions-open-BOT-1:implement').click();
  await expect(page.getByTestId('claude-dialog')).toBeVisible();
  await page.getByTestId('claude-dialog-close').click();

  const history = [USER, ANSWER];
  const opened = hello({ kind: 'session', title: 'BOT-1 implement plan', items: history });
  await page.getByTestId('sessions-chat-BOT-1:implement').click();
  await expect(page).toHaveURL(new RegExp(`#/chat\\?session=${SESSION}$`));
  await chatSay(page, SESSION, 'hello', opened);
  await expect(page.getByTestId('chat-title')).toHaveText('BOT-1 implement plan');
  await expect(page.getByTestId('chat-message-a1')).toContainText(ANSWER.text);

  await page.reload();
  await expect(page).toHaveURL(new RegExp(`#/chat\\?session=${SESSION}$`));
  await chatSay(page, SESSION, 'hello', opened);
  await expect(page.getByTestId('chat-title')).toHaveText('BOT-1 implement plan');
  await expect(page.getByTestId('chat-message-a1')).toContainText(ANSWER.text);
});

// -- review round 1 -----------------------------------------------------------------------------

const OTHER = '3f2b8c1a-5d4e-4f60-9a7b-1c2d3e4f5a6b';

test('switching chats or pressing New chat never leaves the previous conversation on screen', async ({
  page,
  dashboard,
}) => {
  dashboard.data.claude.chats = [
    chatEntry(SESSION, 'done', hour, 'First chat'),
    chatEntry(OTHER, 'done', 2 * hour, 'Second chat'),
  ];
  await page.goto(`/#/chat?session=${SESSION}`);
  await chatSay(
    page,
    SESSION,
    'hello',
    hello({ items: [USER, ANSWER], turn: turn({ outcome: 'failed', error: 'Boom' }) }),
  );
  await expect(page.getByTestId('chat-message-a1')).toBeVisible();
  await expect(page.getByTestId('chat-retry')).toBeVisible();

  // To another chat: nothing of the first shows while the second loads, and the composer waits.
  await page.getByTestId(`chat-list-item-${OTHER}`).click();
  await expect(page).toHaveURL(new RegExp(`#/chat\\?session=${OTHER}$`));
  await expect(page.getByTestId('chat-message-a1')).toHaveCount(0);
  await expect(page.getByTestId('chat-retry')).toHaveCount(0);
  await expect(page.getByTestId('chat-turn-note')).toHaveCount(0);
  await expect(composer(page)).toBeDisabled();

  // To a new chat: the empty page, not the second chat.
  await chatSay(page, OTHER, 'hello', hello({ session: OTHER, title: 'Second chat' }));
  await expect(page.getByTestId('chat-title')).toHaveText('Second chat');
  await page.getByTestId('chat-new').click();
  await expect(page).toHaveURL(/#\/chat$/);
  await expect(page.getByTestId('chat-title')).toHaveText('New chat');
  await expect(page.getByTestId('chat-empty')).toBeVisible();
  await expect(page.locator('[data-testid^="chat-message-"]')).toHaveCount(0);
  await expect(page.getByTestId('chat-state')).toHaveCount(0);
  await expect(composer(page)).toBeEnabled();
});

test('a refused send or stop says why in a sentence, not the envelope code', async ({
  page,
  dashboard,
}) => {
  await page.route('**/api/claude/chat/send', (route) =>
    route.fulfill({
      status: 409,
      json: { code: 'CLAUDE_REFUSED', error: 'CLAUDE REFUSED', errors: ['chat_busy'] },
    }),
  );
  await page.route('**/api/claude/chat/stop', (route) =>
    route.fulfill({
      status: 409,
      json: { code: 'CLAUDE_REFUSED', error: 'CLAUDE REFUSED', errors: ['no_turn'] },
    }),
  );
  await page.goto(`/#/chat?session=${SESSION}`);
  await chatSay(page, SESSION, 'hello', hello({ items: [USER] }));
  await composer(page).fill('again');
  await composer(page).press('Enter');
  await expect(page.getByTestId('chat-send-error')).toHaveText(
    'A turn is already running in this chat.',
  );
  expect(dashboard.data.claude.calls).toEqual([]);
  await expect(composer(page)).toHaveValue('again');

  await chatSay(page, SESSION, 'state', { state: 'working' });
  await page.getByTestId('chat-stop').click();
  await expect(page.getByTestId('chat-send-error')).toHaveText('There is no turn to stop.');
});

test('two submits in one tick send once', async ({ page, dashboard }) => {
  await page.goto(`/#/chat?session=${SESSION}`);
  await chatSay(page, SESSION, 'hello', hello({ items: [USER] }));
  await composer(page).fill('once');
  await page.evaluate(() => {
    const form = document.querySelector('.chat-composer');
    form.requestSubmit();
    form.requestSubmit();
  });
  await expect.poll(() => callsTo(dashboard, '/api/claude/chat/send')).toHaveLength(1);
  await page.waitForTimeout(200);
  expect(callsTo(dashboard, '/api/claude/chat/send')).toHaveLength(1);
});

test('a stopped turn says so and keeps the part of the reply already written', async ({ page }) => {
  await page.goto(`/#/chat?session=${SESSION}`);
  await chatSay(page, SESSION, 'hello', hello({ state: 'working', live: true, items: [USER] }));
  await chatSay(page, SESSION, 'delta', { text: 'One is the loneliest, two' });
  await expect(page.getByTestId('chat-tail')).toHaveText('One is the loneliest, two');
  await chatSay(page, SESSION, 'state', { state: 'idle', turn: turn({ outcome: 'stopped' }) });
  await expect(page.getByTestId('chat-tail')).toHaveCount(0);
  await expect(page.getByText('One is the loneliest, two')).toBeVisible();
  await expect(page.getByTestId('chat-state')).toHaveText('Stopped');
  await expect(page.getByTestId('chat-turn-note')).toContainText(/stopped/i);
  await expect(page.getByTestId('chat-retry')).toBeVisible();
});

test('the chat list and the bot follow a turn to its end without waiting for a poll', async ({
  page,
  dashboard,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  dashboard.data.claude.chats = [chatEntry(SESSION, 'working', 1000, 'Busy chat')];
  await page.goto(`/#/chat?session=${SESSION}`);
  await chatSay(page, SESSION, 'hello', hello({ state: 'working', live: true, items: [USER] }));
  const item = page.getByTestId(`chat-list-item-${SESSION}`);
  const bot = page.getByTestId('bot-bar-bot-chat-8c1d4e7f-chat');
  await expect(item).toContainText('working');
  await expect(bot).toHaveAttribute('data-state', 'working');

  dashboard.data.claude.chats = [chatEntry(SESSION, 'done', 0, 'Busy chat')];
  await chatSay(page, SESSION, 'state', { state: 'idle', turn: turn() });
  await expect(item).toContainText('done');
  await expect(bot).toHaveAttribute('data-state', 'done');
});

test('a chat row in the drawer reads as a chat, and opening a chat closes the drawer', async ({
  page,
  dashboard,
}) => {
  dashboard.data.claude.chats = [chatEntry(SESSION, 'done', hour, 'Plan the release notes')];
  await page.goto('/#/services');
  await page.getByTestId('sessions-tab').click();
  const row = page.getByTestId(`sessions-row-${SESSION}:chat`);
  await expect(row).toContainText('Chat · done');
  await expect(row).not.toContainText('status unavailable');
  await page.getByTestId(`sessions-open-${SESSION}:chat`).click();
  await expect(page).toHaveURL(new RegExp(`#/chat\\?session=${SESSION}$`));
  await expect(page.getByTestId('sessions-drawer')).toBeHidden();

  dashboard.data.claude.tickets['BOT-1'] = claudeEntry('working', 'running', {
    phase: 'implement-plan',
  });
  dashboard.data.claude.activeSprint.keys = ['BOT-1'];
  dashboard.data.claude.sessionIds = { 'BOT-1': { implement: OTHER } };
  await page.goto('/#/services');
  await page.reload();
  await page.getByTestId('sessions-tab').click();
  await page.getByTestId('sessions-chat-BOT-1:implement').click();
  await expect(page).toHaveURL(new RegExp(`#/chat\\?session=${OTHER}$`));
  await expect(page.getByTestId('sessions-drawer')).toBeHidden();
});

test('a message copy button and a code copy button are told apart, and the field names why it waits', async ({
  page,
}) => {
  await page.goto(`/#/chat?session=${SESSION}`);
  await chatSay(
    page,
    SESSION,
    'hello',
    hello({
      state: 'working',
      live: true,
      items: [USER, { id: 'a1', kind: 'assistant', text: '```sh\nnpm run build\n```\n' }],
    }),
  );
  const reply = page.getByTestId('chat-message-a1');
  await expect(reply.getByRole('button', { name: 'Copy reply' })).toHaveText('Copy');
  await expect(reply.getByRole('button', { name: 'Copy code' })).toHaveText('Copy code');
  await expect(page.getByTestId('chat-message-u1').getByRole('button')).toHaveAccessibleName(
    'Copy your text',
  );
  await expect(composer(page)).toHaveAccessibleDescription(/Claude is replying/);

  await reply.getByRole('button', { name: 'Copy code' }).click();
  await expect(reply.getByRole('button', { name: 'Copied' })).toBeVisible();
});

test('a broken stream names the likely causes', async ({ page }) => {
  await page.goto(`/#/chat?session=${SESSION}`);
  await expect.poll(() => openChatStreams(page)).toEqual([SESSION]);
  await page.evaluate((id) => {
    const source = window.__dashboardMock.chats.find((it) => it.session === id);
    source.readyState = 2;
    source.dispatchEvent(new Event('error'));
  }, SESSION);
  await expect(page.getByTestId('chat-stream-error')).toContainText(/too many chats/i);
});

async function longChat(page, count) {
  const items = Array.from({ length: count }, (_, i) =>
    i % 2 === 0
      ? { id: `u${i}`, kind: 'user', text: `Question ${i}` }
      : { id: `a${i}`, kind: 'assistant', text: `Answer ${i}, with some words to fill the line.` },
  );
  await page.goto(`/#/chat?session=${SESSION}`);
  await chatSay(page, SESSION, 'hello', hello({ items }));
  await expect(page.getByTestId(`chat-message-a${count - 1}`)).toBeVisible();
}

for (const width of [1200, 390]) {
  test(`a long chat scrolls inside its log, never the page, at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await longChat(page, 60);
    expect(
      await page.evaluate(() => document.scrollingElement.scrollHeight <= innerHeight),
      'the page does not scroll',
    ).toBe(true);
    const log = page.getByTestId('chat-log');
    expect(await log.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    // It opens at the newest message, and the composer is on screen.
    expect(await log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 2)).toBe(
      true,
    );
    await expect(composer(page)).toBeInViewport();
    if (width < 760) {
      const listBox = await page.getByTestId('chat-list').boundingBox();
      const mainBox = await page.getByTestId('chat-main').boundingBox();
      expect(
        listBox.y + listBox.height,
        'the list stacks above the conversation',
      ).toBeLessThanOrEqual(mainBox.y + 1);
    }
  });
}

test('a bot never covers the composer at 390px', async ({ page, dashboard }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 800 });
  dashboard.data.claude.chats = [chatEntry(SESSION, 'working', 1000, 'Busy chat')];
  await page.goto(`/#/chat?session=${SESSION}`);
  await chatSay(page, SESSION, 'hello', hello({ state: 'working', live: true, items: [USER] }));
  const poster = page.getByTestId('bot-bar-poster-chat-8c1d4e7f-chat');
  await expect(poster).toBeVisible();
  const posterBox = await poster.boundingBox();
  const stopBox = await page.getByTestId('chat-stop').boundingBox();
  const reasonBox = await page.getByTestId('chat-disabled-reason').boundingBox();
  expect(Math.max(stopBox.y + stopBox.height, reasonBox.y + reasonBox.height)).toBeLessThanOrEqual(
    posterBox.y,
  );
});

test('sending while scrolled up follows the new message again', async ({ page }) => {
  await longChat(page, 60);
  await page.getByTestId('chat-log').evaluate(async (el) => {
    el.scrollTop = 0;
    // The scroll event is delivered with the next frame.
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
  await expect(page.getByTestId('chat-message-u99')).toHaveCount(0);
  await chatSay(page, SESSION, 'item', { item: { id: 'u99', kind: 'user', text: 'My next one' } });
  await expect(page.getByTestId('chat-message-u99')).toBeInViewport();
});

// -- review round 2: where the keyboard focus goes ------------------------------------------------

test('the composer keeps the keyboard focus through the first send of a new chat', async ({
  page,
}) => {
  await page.goto('/#/chat');
  await composer(page).focus();
  await composer(page).fill('Start here');
  await composer(page).press('Enter');
  await expect(page).toHaveURL(new RegExp(`#/chat\\?session=${CHAT_SESSION_ID}$`));
  await expect(composer(page)).toBeFocused();
  await chatSay(
    page,
    CHAT_SESSION_ID,
    'hello',
    hello({ session: CHAT_SESSION_ID, state: 'working', live: true, items: [USER] }),
  );
  await expect(composer(page)).toBeFocused();

  // A plain open does not take the focus.
  await page.goto(`/#/chat?session=${SESSION}`);
  await chatSay(page, SESSION, 'hello', hello({ items: [USER] }));
  await expect(composer(page)).not.toBeFocused();
});

test('closing the drawer on a chat hands the focus back to the Sessions tab', async ({
  page,
  dashboard,
}) => {
  dashboard.data.claude.chats = [chatEntry(SESSION, 'done', hour, 'Plan the release notes')];
  dashboard.data.claude.tickets['BOT-1'] = claudeEntry('working', 'running', {
    phase: 'implement-plan',
  });
  dashboard.data.claude.activeSprint.keys = ['BOT-1'];
  dashboard.data.claude.sessionIds = { 'BOT-1': { implement: OTHER } };
  await page.goto('/#/services');
  await page.getByTestId('sessions-tab').click();
  await page.getByTestId(`sessions-open-${SESSION}:chat`).click();
  await expect(page.getByTestId('sessions-drawer')).toBeHidden();
  await expect(page.getByTestId('sessions-tab')).toBeFocused();

  await page.getByTestId('sessions-tab').click();
  await page.getByTestId('sessions-chat-BOT-1:implement').click();
  await expect(page.getByTestId('sessions-drawer')).toBeHidden();
  await expect(page.getByTestId('sessions-tab')).toBeFocused();
});

test('the drawer has a New chat link, with sessions listed or not', async ({ page, dashboard }) => {
  await page.goto('/#/services');
  await page.getByTestId('sessions-tab').click();
  await expect(page.getByTestId('sessions-empty')).toBeVisible();
  const empty = page.getByTestId('sessions-new-chat');
  await expect(empty).toBeVisible();
  await expect(empty).toHaveAccessibleName('New chat');
  await expect(empty).not.toHaveAttribute('title', /.+/);

  dashboard.data.claude.chats = [chatEntry(SESSION, 'done', hour, 'Plan the release notes')];
  await page.reload();
  await page.getByTestId('sessions-tab').click();
  await expect(page.getByTestId(`sessions-row-${SESSION}:chat`)).toBeVisible();
  await expect(page.getByTestId('sessions-new-chat')).toBeVisible();
});

test('New chat in the drawer opens a fresh conversation from another screen and closes the drawer', async ({
  page,
}) => {
  await page.goto('/#/services');
  await page.getByTestId('sessions-tab').click();
  await page.getByTestId('sessions-new-chat').click();
  await expect(page).toHaveURL(/#\/chat$/);
  await expect(page.getByTestId('panel-chat')).toBeVisible();
  await expect(page.getByTestId('chat-title')).toHaveText('New chat');
  await expect(page.getByTestId('chat-empty')).toBeVisible();
  await expect(page.getByTestId('sessions-drawer')).toBeHidden();
  // The drawer-close convention: the focus goes back to the tab that opened it.
  await expect(page.getByTestId('sessions-tab')).toBeFocused();
});

test('New chat in the drawer while reading a chat gives an empty conversation, and the next send is a new session', async ({
  page,
  dashboard,
}) => {
  await page.goto(`/#/chat?session=${SESSION}`);
  await chatSay(
    page,
    SESSION,
    'hello',
    hello({ items: [USER, ANSWER], turn: turn({ outcome: 'failed', error: 'Boom' }) }),
  );
  await expect(page.getByTestId('chat-message-u1')).toBeVisible();
  await expect(page.getByTestId('chat-retry')).toBeVisible();

  await page.getByTestId('sessions-tab').click();
  await page.getByTestId('sessions-new-chat').click();
  await expect(page).toHaveURL(/#\/chat$/);
  await expect(page.getByTestId('sessions-drawer')).toBeHidden();
  await expect(page.getByTestId('chat-title')).toHaveText('New chat');
  await expect(page.getByTestId('chat-empty')).toBeVisible();
  await expect(page.getByTestId('chat-message-u1')).toHaveCount(0);
  await expect(page.getByTestId('chat-message-a1')).toHaveCount(0);
  await expect(page.getByTestId('chat-retry')).toHaveCount(0);
  await expect(page.getByTestId('chat-turn-note')).toHaveCount(0);

  await composer(page).fill('A different question');
  await composer(page).press('Enter');
  await expect(page).toHaveURL(new RegExp(`#/chat\\?session=${CHAT_SESSION_ID}$`));
  const sends = callsTo(dashboard, '/api/claude/chat/send');
  expect(sends).toHaveLength(1);
  expect(sends[0].body).toEqual({ message: 'A different question' });
});

test('New chat in the drawer on a fresh Chat screen closes the drawer and breaks nothing', async ({
  page,
  dashboard,
}) => {
  await page.goto('/#/chat');
  await page.getByTestId('sessions-tab').click();
  await page.getByTestId('sessions-new-chat').click();
  await expect(page).toHaveURL(/#\/chat$/);
  await expect(page.getByTestId('sessions-drawer')).toBeHidden();
  await expect(page.getByTestId('chat-empty')).toBeVisible();
  await composer(page).fill('Still works');
  await composer(page).press('Enter');
  await expect(page).toHaveURL(new RegExp(`#/chat\\?session=${CHAT_SESSION_ID}$`));
  expect(callsTo(dashboard, '/api/claude/chat/send')).toHaveLength(1);
});

test('New chat in the drawer works from the keyboard', async ({ page }) => {
  await page.goto('/#/services');
  await page.getByTestId('sessions-tab').click();
  await page.getByTestId('sessions-new-chat').focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/chat$/);
  await expect(page.getByTestId('sessions-drawer')).toBeHidden();
  await expect(page.getByTestId('sessions-tab')).toBeFocused();
});

// The composer's controls float over the top-right corner of the textarea, so the bot bar's strip and
// the posters along the bottom of the screen never cover them.
const BOT_TICKETS = {
  'BOT-1': claudeEntry('working', 'running', { phase: 'implement-plan' }),
  'BOT-2': claudeEntry('failed', 'ended_without_flag', { phase: 'implement-plan' }),
  'BOT-3': claudeEntry('none', null, { review: { state: 'done', reason: 'finished' } }),
  'BOT-4': claudeEntry('none', null, { review: { state: 'waiting', reason: 'blocked' } }),
};
const overlaps = (a, b) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
// True when the topmost element at the centre of `locator` is the control itself.
const isOnTop = (locator) =>
  locator.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return el === hit || el.contains(hit);
  });

for (const width of [1200, 390]) {
  test(`the composer controls float at the top right of the textarea, clear of the bots, at ${width}px`, async ({
    page,
    dashboard,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width, height: 800 });
    Object.assign(dashboard.data.claude.tickets, BOT_TICKETS);
    dashboard.data.claude.activeSprint.keys = Object.keys(BOT_TICKETS);
    dashboard.data.claude.chats = [chatEntry(SESSION, 'working', 1000, 'Busy chat')];
    await page.goto(`/#/chat?session=${SESSION}`);
    await chatSay(page, SESSION, 'hello', hello({ state: 'working', live: true, items: [USER] }));
    const bots = page.locator('[data-testid^="bot-bar-bot-"], [data-testid^="bot-bar-poster-"]');
    await expect(bots).toHaveCount(10);

    const check = async (control) => {
      const box = await control.boundingBox();
      // A disabled button takes no pointer events, so only an enabled one can be hit.
      const enabled = await control.isEnabled();
      const fieldBox = await composer(page).boundingBox();
      expect(box.x + box.width, 'inside the textarea, right edge').toBeLessThanOrEqual(
        fieldBox.x + fieldBox.width,
      );
      expect(box.x, 'in the right half').toBeGreaterThan(fieldBox.x + fieldBox.width / 2);
      expect(box.y, 'inside the textarea, top edge').toBeGreaterThanOrEqual(fieldBox.y);
      expect(box.y - fieldBox.y, 'in the first third').toBeLessThanOrEqual(fieldBox.height / 3);
      expect(box.y + box.height, 'clear of the resize handle').toBeLessThanOrEqual(
        fieldBox.y + fieldBox.height - 24,
      );
      if (enabled) expect(await isOnTop(control), 'nothing lies over it').toBe(true);
      for (const bot of await bots.all()) {
        expect(overlaps(box, await bot.boundingBox()), 'no bot or poster over it').toBe(false);
      }
      // The text starts below the controls, so a long message never runs under them.
      const paddingTop = await composer(page).evaluate((el) =>
        parseFloat(getComputedStyle(el).paddingTop),
      );
      expect(fieldBox.y + paddingTop, 'text starts below the controls').toBeGreaterThanOrEqual(
        box.y + box.height,
      );
    };

    // Working: the field is read-only, Send waits and Stop is there, both in the corner.
    await check(page.getByTestId('chat-send'));
    await check(page.getByTestId('chat-stop'));
    await composer(page).focus();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('chat-stop'), 'Tab from the field reaches Stop').toBeFocused();

    // Idle with a long message: Send alone, still in the corner, next in the tab order.
    await chatSay(page, SESSION, 'state', { state: 'idle', turn: turn() });
    await composer(page).fill('a long line of words '.repeat(30));
    await check(page.getByTestId('chat-send'));
    await composer(page).focus();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('chat-send'), 'Tab from the field reaches Send').toBeFocused();
    expect(
      await page.evaluate(() => document.scrollingElement.scrollHeight <= innerHeight),
      'the page does not scroll',
    ).toBe(true);
    await expect(composer(page)).toBeInViewport();
  });
}

// A ticket row's Chat link is an icon: no visible text, the same accessible name, "Chat" in the app's
// own tooltip on hover and on focus, and the time, Chat and copy columns line up across rows.
const iconRows = ({ data }) => {
  const attach = { kind: 'attach', command: 'claude attach demo' };
  data.claude.tickets['BOT-1'] = claudeEntry('working', 'running', {
    phase: 'implement-plan',
    goTo: { investigate: null, implement: attach, groom: null },
  });
  data.claude.tickets['BOT-2'] = claudeEntry('none', null, {
    review: { state: 'done', reason: 'finished' },
  });
  data.claude.activeSprint.keys = ['BOT-1', 'BOT-2'];
  data.claude.sessionIds = { 'BOT-1': { implement: SESSION } };
  const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
  data.claude.lastActive = { 'BOT-1': { implement: ago(2) }, 'BOT-2': { review: ago(90) } };
  data.claude.chats = [chatEntry(OTHER, 'done', hour, 'Plan the release notes')];
};

test('a ticket row Chat link is an icon with a tooltip, and the row columns line up', async ({
  page,
  dashboard,
}) => {
  iconRows(dashboard);
  await page.goto('/#/services');
  await page.getByTestId('sessions-tab').click();
  const link = page.getByTestId('sessions-chat-BOT-1:implement');
  await expect(link).toHaveAttribute('href', `#/chat?session=${SESSION}`);
  expect((await link.innerText()).trim(), 'no visible text').toBe('');
  await expect(link.locator('svg[aria-hidden="true"]')).toHaveCount(1);
  await expect(link.locator('title')).toHaveCount(0);
  await expect(link).not.toHaveAttribute('title', /.+/);
  await expect(
    page.getByRole('link', { name: 'Chat with BOT-1 Implement plan session' }),
  ).toHaveCount(1);
  await expect(link).toHaveAccessibleName('Chat with BOT-1 Implement plan session');

  // The tooltip says "Chat" on hover and on keyboard focus.
  await link.hover();
  await expect(page.getByRole('tooltip')).toHaveText('Chat');
  await page.getByTestId('sessions-search').hover();
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await page.getByTestId('sessions-open-BOT-1:implement').focus();
  await page.keyboard.press('Tab');
  await expect(link).toBeFocused();
  await expect(page.getByRole('tooltip')).toHaveText('Chat');

  // Compact, and no smaller than the copy button beside it.
  const box = await link.boundingBox();
  const copy = await page.getByTestId('sessions-copy-BOT-1:implement').boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(copy.height);
  expect(box.width).toBeLessThan(40);

  // Rows without a Chat link or without a copy button keep the columns: time, Chat, copy.
  const right = async (id) => {
    const b = await page.getByTestId(id).boundingBox();
    return Math.round(b.x + b.width);
  };
  expect(await right('sessions-when-BOT-2:review')).toBe(
    await right('sessions-when-BOT-1:implement'),
  );
  expect(await right(`sessions-copy-${OTHER}:chat`)).toBe(
    await right('sessions-copy-BOT-1:implement'),
  );
  await expect(page.getByTestId('sessions-copy-BOT-2:review')).toHaveCount(0);
  await expect(page.getByTestId(`sessions-chat-${OTHER}:chat`)).toHaveCount(0);

  // Enter follows the link and closes the drawer.
  await link.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`#/chat\\?session=${SESSION}$`));
  await expect(page.getByTestId('sessions-drawer')).toBeHidden();
});

// The room kept for the controls follows their real height, the box cannot be dragged below a usable
// text line, and a scrollbar never lies under the controls.
test('the composer keeps room for the controls, a line of text and a scrollbar', async ({
  page,
}) => {
  await page.goto(`/#/chat?session=${SESSION}`);
  await chatSay(page, SESSION, 'hello', hello({ items: [USER] }));
  await composer(page).fill('a long line of words '.repeat(60));
  const send = await page.getByTestId('chat-send').boundingBox();
  const room = await composer(page).evaluate((el) => {
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return {
      top: box.top,
      right: box.right,
      paddingTop: parseFloat(style.paddingTop),
      paddingBottom: parseFloat(style.paddingBottom),
      minHeight: parseFloat(style.minHeight),
      overflows: el.scrollHeight > el.clientHeight,
    };
  });
  expect(room.paddingTop, 'text starts below the controls').toBeGreaterThanOrEqual(
    send.y + send.height - room.top,
  );
  expect(
    room.minHeight - room.paddingTop - room.paddingBottom,
    'the smallest box still has room for a line of text',
  ).toBeGreaterThanOrEqual(20);
  expect(room.overflows, 'the draft overflows the box').toBe(true);
  // Headless Chromium hides scrollbars, so none can be measured here: the controls must end at least
  // 16px (a classic scrollbar, 15-17px; the textarea asks for a thin one) inside the right edge.
  expect(
    room.right - (send.x + send.width),
    'the controls end before where a scrollbar sits',
  ).toBeGreaterThanOrEqual(16);
});

// Headless Chromium cannot emulate `(hover: none)`, so the touch case reads the stylesheet: the room
// kept under that query is the height base.css gives every button under it.
test('the room kept for the controls follows the touch button height', async ({ page }) => {
  await page.goto(`/#/chat?session=${SESSION}`);
  const heights = await page.evaluate(() => {
    const found = { button: null, room: null };
    for (const sheet of document.styleSheets) {
      for (const rule of sheet.cssRules) {
        if (!(rule instanceof CSSMediaRule) || !rule.conditionText.includes('hover: none'))
          continue;
        for (const inner of rule.cssRules) {
          if (inner.selectorText === '.btn') found.button = inner.style.minHeight;
          if (inner.selectorText === '.chat-field')
            found.room = inner.style.getPropertyValue('--chat-actions-h').trim();
        }
      }
    }
    return found;
  });
  expect(heights.button, 'base.css makes buttons taller on touch').toBeTruthy();
  expect(heights.room).toBe(heights.button);
});
