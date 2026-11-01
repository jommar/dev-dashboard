import { test, expect } from './fixtures.js';
import { slackAppThreadLink, slackWatchData, watchLink, watchSession } from './data.js';

const TEAM = 'T0EXAMPLE1';
const CHANNEL = 'C0EXAMPLE1';
const OTHER_CHANNEL = 'C0EXAMPLE2';
const THREAD_TS = '1761900000.000100';
const REPLY_TS = '1761900060.000300';
const OTHER_TS = '1761900500.000200';
const TICKET_KEY = 'TAP-9001';
const ROOT_TEXT = `${TICKET_KEY}: Invented subject for the thread dialog`;
const REPLY_TEXT = 'Invented reply that keeps the conversation going.';
const DIALOG_LINK = slackAppThreadLink(TEAM, CHANNEL, THREAD_TS);
const THREAD_KEY = 'C0EXAMPLE1:1761900000.000100';

const SESSION_HERE_FIRST = '77777777-7777-4777-8777-777777777777';
const SESSION_HERE_SECOND = '88888888-8888-4888-8888-888888888888';
const SESSION_ELSEWHERE_TS = '99999999-9999-4999-8999-999999999999';
const SESSION_ELSEWHERE_CHANNEL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION_FREE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SESSION_UNNAMED = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const WATCH_LIST = '/api/slack/watch';
const WATCH_SESSIONS = '/api/slack/watch/sessions';
const ATTACH_ROUTE = '/api/slack/watch/attach';
const DETACH_ROUTE = '/api/slack/watch/detach';

const WATCH_DISABLED_SENTENCE =
  'Watching is off because the Claude home directory cannot be read. Make it readable, then try again.';
const OPERATION_FAILED_SENTENCE =
  'The dashboard server could not finish that. Try again, and check the server log if it keeps failing.';
const UNREACHABLE_SENTENCE = 'The dashboard server could not be reached.';

const FROZEN_AT = Date.parse('2026-10-31T09:00:00.000Z');
const IDLE_MINUTES = 4;

const SAM = { id: 'U0EXAMPLE1', name: 'Sam Example' };
const RILEY = { id: 'U0EXAMPLE2', name: 'Riley Sample' };

const PICKER_SESSIONS = [
  { sessionId: SESSION_HERE_FIRST, name: 'Sample billing review', state: 'idle' },
  { sessionId: SESSION_HERE_SECOND, name: 'Sample import cleanup', state: 'busy' },
  { sessionId: SESSION_ELSEWHERE_TS, name: 'Sample report polish', state: 'idle' },
  { sessionId: SESSION_ELSEWHERE_CHANNEL, name: 'Sample export check', state: 'busy' },
  { sessionId: SESSION_FREE, name: 'Sample docs tidy', state: 'idle' },
  { sessionId: SESSION_UNNAMED, state: 'busy' },
];

const PICKER_OPTIONS_FOR_THIS_THREAD = [
  ['', 'Choose a session'],
  [SESSION_ELSEWHERE_TS, 'Sample report polish · idle · attached'],
  [SESSION_ELSEWHERE_CHANNEL, 'Sample export check · busy · attached'],
  [SESSION_FREE, 'Sample docs tidy · idle'],
  [SESSION_UNNAMED, `${SESSION_UNNAMED} · busy`],
];

const sorted = (...ids) => [...ids].sort();
const attachedTo = (...sessionIds) => sessionIds.map((sessionId) => watchSession(sessionId));

// This thread is watched under the archive permalink a person pastes, while the dialog's own link is
// the app form, so only the thread key the server hands out as `watchKey` tells them apart from the
// two look-alike threads: one in the same channel with another timestamp, one in another channel
// with the same timestamp.
const defaultWatchLinks = () => [
  watchLink(CHANNEL, THREAD_TS, { sessions: attachedTo(SESSION_HERE_FIRST, SESSION_HERE_SECOND) }),
  watchLink(CHANNEL, OTHER_TS, { sessions: attachedTo(SESSION_ELSEWHERE_TS) }),
  watchLink(OTHER_CHANNEL, THREAD_TS, { sessions: attachedTo(SESSION_ELSEWHERE_CHANNEL) }),
];
const linksOfOtherThreads = () => defaultWatchLinks().slice(1);

const messageAt = (ts) => new Date(Number(ts.split('.')[0]) * 1000).toISOString();
const message = (ts, author, text) => ({ ts, at: messageAt(ts), author, text, mrkdwn: text });

function threadRead(url, extraMessages) {
  const filler = Array.from({ length: extraMessages }, (_, index) =>
    message(
      `${1761900100 + index}.000400`,
      index % 2 ? SAM : RILEY,
      `Invented filler message number ${index + 1}.`,
    ),
  );
  const messages = [
    message(THREAD_TS, SAM, ROOT_TEXT),
    message(REPLY_TS, RILEY, REPLY_TEXT),
    ...filler,
  ];
  return {
    ts: THREAD_TS,
    url,
    watchKey: url ? THREAD_KEY : '',
    channel: { id: CHANNEL, name: 'example_channel' },
    replyCount: messages.length - 1,
    truncated: false,
    updatedAt: '2026-10-31T09:00:00.000Z',
    names: { [SAM.id]: SAM.name, [RILEY.id]: RILEY.name },
    messages,
  };
}

const threadRow = (url, overrides = {}) => ({
  ts: THREAD_TS,
  url,
  watchKey: url ? THREAD_KEY : '',
  text: ROOT_TEXT,
  author: SAM,
  starter: SAM,
  replyCount: 1,
  activityAt: '2026-10-31T08:30:00.000Z',
  latestReplyBy: RILEY,
  needsReply: false,
  ...overrides,
});

function seedThreadScenario(
  data,
  { url = DIALOG_LINK, links = defaultWatchLinks(), watch = {}, extraMessages = 0 } = {},
) {
  const [sampleTicket] = data.tickets.tickets;
  data.tickets.tickets.push({
    ...sampleTicket,
    key: TICKET_KEY,
    summary: 'Invented ticket with a Slack thread',
  });
  data.slack.threads.started = [threadRow(url)];
  data.slack.threads.mentions = [
    threadRow(url, { text: 'Invented mention asking for a quick look.', author: RILEY }),
  ];
  data.slack.threadReads = { [THREAD_TS]: threadRead(url, extraMessages) };
  data.slack.watch = slackWatchData({ links, pickerSessions: PICKER_SESSIONS, ...watch });
}

const dialogWithMessages = async (page) => {
  const dialog = page.getByTestId('slack-thread-dialog');
  await expect(dialog.getByTestId(`slack-thread-message-${THREAD_TS}`)).toBeVisible();
  return dialog;
};
const clickTicketGlyph = async (page) => {
  await page.getByTestId(`slack-thread-link-${THREAD_TS}`).click();
  return dialogWithMessages(page);
};
const openFromTicketRow = async (page) => {
  await page.goto('/#/my-tickets');
  return clickTicketGlyph(page);
};
const openFromMentionsRow = async (page) => {
  await page.goto('/#/slack');
  await page.getByTestId('slack-tab-mentions').click();
  await page.getByTestId(`slack-thread-${THREAD_TS}`).click();
  return dialogWithMessages(page);
};

const sectionOf = (dialog) => dialog.getByTestId('thread-session');
const pickerOf = (panel) => panel.getByTestId('thread-session-picker');
const attachButtonOf = (panel) => panel.getByTestId('thread-session-attach');
const detachButtonOf = (panel, sessionId) =>
  panel.getByTestId(`thread-session-detach-${sessionId}`);
const itemOf = (panel, sessionId) => panel.getByTestId(`thread-session-item-${sessionId}`);

const listedSessionIds = (panel) =>
  panel
    .locator('[data-testid^="thread-session-item-"]')
    .evaluateAll((nodes) =>
      nodes
        .map((node) => node.getAttribute('data-testid').slice('thread-session-item-'.length))
        .sort(),
    );
const pickerOptions = (panel) =>
  pickerOf(panel)
    .locator('option')
    .evaluateAll((options) => options.map((option) => [option.value, option.textContent]));

const readsOf = ({ requests }, path) =>
  requests.filter(({ method, path: requested }) => method === 'GET' && requested === path).length;
const writeCallsOf = ({ data }) => data.slack.watch.calls;

const flushPage = (page) =>
  page.evaluate(() => fetch('/api/config').then((response) => response.json()));
const advanceMinutes = async (page, minutes) => {
  await page.clock.runFor(minutes * 60_000);
  await flushPage(page);
};

const isPath = (path) => (url) => url.pathname === path;
const failure = (status, code) => ({
  status,
  json: { code, error: code.replaceAll('_', ' '), errors: [] },
});

// Answers a route from the spec instead of the shared fake, and keeps the bodies it was sent.
async function answerWith(page, path, respond) {
  const bodies = [];
  await page.route(isPath(path), (route) => {
    bodies.push(route.request().postDataJSON());
    return respond(route);
  });
  return bodies;
}

// Holds every answer for a route until `release`, then lets the shared fake answer it.
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

async function expectThreadControlsStillWork(page, dialog) {
  await expect(dialog.getByTestId(`slack-thread-message-${THREAD_TS}`)).toContainText(ROOT_TEXT);
  await expect(dialog.getByTestId(`slack-thread-message-${REPLY_TS}`)).toContainText(REPLY_TEXT);
  await expect(dialog.getByTestId('slack-thread-open')).toHaveAttribute('href', DIALOG_LINK);
  await dialog.getByTestId('slack-thread-copy').click();
  await expect(dialog.getByTestId('slack-thread-copy')).toHaveText('Copied');
  expect(await page.evaluate(() => window.__dashboardMock.clipboard.writes)).toEqual([DIALOG_LINK]);
}

async function expectUnavailableSection(page, dialog) {
  const panel = sectionOf(dialog);
  await expect(panel).toBeVisible();
  const unavailable = panel.getByTestId('thread-session-unavailable');
  await expect(unavailable).toBeVisible();
  const sentence = (await unavailable.innerText()).trim();
  expect(sentence.length).toBeGreaterThan(0);
  expect(sentence.length).toBeLessThan(160);
  await expect(panel.getByTestId('thread-session-loading')).toHaveCount(0);
  await expect(pickerOf(panel)).toHaveCount(0);
  await expect(attachButtonOf(panel)).toHaveCount(0);
  await expectThreadControlsStillWork(page, dialog);
}

test('thread dialog opens from a ticket row and renders its messages', async ({
  page,
  dashboard,
}) => {
  seedThreadScenario(dashboard.data);
  const dialog = await openFromTicketRow(page);
  await expect(dialog.getByTestId('slack-thread-dialog-title')).toHaveText(
    `${TICKET_KEY} · Slack thread`,
  );
  await expect(dialog.getByTestId(`slack-thread-message-${THREAD_TS}`)).toContainText(ROOT_TEXT);
  await expect(dialog.getByTestId(`slack-thread-message-${REPLY_TS}`)).toContainText(REPLY_TEXT);
  await expect(dialog.getByTestId('slack-thread-open')).toHaveAttribute('href', DIALOG_LINK);
});

test('thread session: list shows only the sessions attached to this thread', async ({
  page,
  dashboard,
}) => {
  seedThreadScenario(dashboard.data);
  const dialog = await openFromTicketRow(page);
  const panel = sectionOf(dialog);
  await expect(panel).toBeVisible();
  await expect(panel.getByText('Claude session', { exact: true })).toBeVisible();
  await expect(panel.getByTestId('thread-session-list')).toBeVisible();
  await expect
    .poll(() => listedSessionIds(panel))
    .toEqual(sorted(SESSION_HERE_FIRST, SESSION_HERE_SECOND));
  for (const sessionId of [SESSION_HERE_FIRST, SESSION_HERE_SECOND]) {
    await expect(itemOf(panel, sessionId)).toContainText(sessionId);
    await expect(detachButtonOf(panel, sessionId)).toHaveText('Detach');
    await expect(itemOf(panel, sessionId).getByRole('button', { name: 'Detach' })).toHaveCount(1);
  }
  await expect(panel.getByTestId('thread-session-empty')).toHaveCount(0);
  await expect(itemOf(panel, SESSION_ELSEWHERE_TS)).toHaveCount(0);
  await expect(itemOf(panel, SESSION_ELSEWHERE_CHANNEL)).toHaveCount(0);
});

test('thread session: list says "No session attached" when nothing is attached to this thread', async ({
  page,
  dashboard,
}) => {
  seedThreadScenario(dashboard.data, { links: linksOfOtherThreads() });
  const dialog = await openFromTicketRow(page);
  const panel = sectionOf(dialog);
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('thread-session-empty')).toHaveText('No session attached');
  await expect(panel.locator('[data-testid^="thread-session-item-"]')).toHaveCount(0);
  await expect(panel.getByTestId('thread-session-loading')).toHaveCount(0);
});

test('thread session: list shows Loading… until the first watch read settles and never flashes the empty state', async ({
  page,
  dashboard,
}) => {
  await page.addInitScript(() => {
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="thread-session-empty"]'))
        window.__sawNoSessionAttached = true;
    }).observe(document, { childList: true, subtree: true });
  });
  seedThreadScenario(dashboard.data);
  const held = await holdResponses(page, WATCH_LIST);
  const dialog = await openFromTicketRow(page);
  const panel = sectionOf(dialog);
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('thread-session-loading')).toHaveText('Loading…');
  await expect(panel.getByTestId('thread-session-empty')).toHaveCount(0);
  await expect.poll(() => held.bodies.length).toBe(1);
  held.release();
  await expect(panel.getByTestId('thread-session-loading')).toHaveCount(0);
  await expect(panel.getByTestId('thread-session-list')).toBeVisible();
  expect(await page.evaluate(() => window.__sawNoSessionAttached)).toBeFalsy();
});

test('thread session: list falls back to the thread read watch key when the row carries none', async ({
  page,
  dashboard,
}) => {
  seedThreadScenario(dashboard.data);
  for (const row of [
    ...dashboard.data.slack.threads.started,
    ...dashboard.data.slack.threads.mentions,
  ])
    delete row.watchKey;
  const dialog = await openFromTicketRow(page);
  const panel = sectionOf(dialog);
  await expect(panel).toBeVisible();
  await expect
    .poll(() => listedSessionIds(panel))
    .toEqual(sorted(SESSION_HERE_FIRST, SESSION_HERE_SECOND));
  await expect(itemOf(panel, SESSION_ELSEWHERE_TS)).toHaveCount(0);
  await expect(itemOf(panel, SESSION_ELSEWHERE_CHANNEL)).toHaveCount(0);
});

test('thread session: list uses the row watch key when the thread read is unavailable', async ({
  page,
  dashboard,
}) => {
  seedThreadScenario(dashboard.data);
  dashboard.data.slack.threadReads = {};
  await page.goto('/#/my-tickets');
  await page.getByTestId(`slack-thread-link-${THREAD_TS}`).click();
  const dialog = page.getByTestId('slack-thread-dialog');
  await expect(dialog.getByTestId('slack-thread-retry')).toBeVisible();
  const panel = sectionOf(dialog);
  await expect(panel).toBeVisible();
  await expect
    .poll(() => listedSessionIds(panel))
    .toEqual(sorted(SESSION_HERE_FIRST, SESSION_HERE_SECOND));
  await expect(itemOf(panel, SESSION_ELSEWHERE_TS)).toHaveCount(0);
  await expect(itemOf(panel, SESSION_ELSEWHERE_CHANNEL)).toHaveCount(0);
});

test('thread session: list stays in view above a long message list', async ({
  page,
  dashboard,
}) => {
  seedThreadScenario(dashboard.data, { extraMessages: 30 });
  const dialog = await openFromTicketRow(page);
  const body = dialog.getByTestId('slack-thread-dialog-body');
  await expect
    .poll(() => body.evaluate((node) => node.scrollHeight > node.clientHeight))
    .toBe(true);
  const panel = sectionOf(dialog);
  await expect(panel).toBeInViewport();
  await expect(pickerOf(panel)).toBeInViewport({ ratio: 1 });
  await expect(attachButtonOf(panel)).toBeInViewport({ ratio: 1 });
});

test('thread session: picker offers the sessions not attached to this thread, labelled like the watch card', async ({
  page,
  dashboard,
}) => {
  seedThreadScenario(dashboard.data);
  const dialog = await openFromTicketRow(page);
  const panel = sectionOf(dialog);
  await expect(panel).toBeVisible();
  await expect(pickerOf(panel)).toHaveJSProperty('tagName', 'SELECT');
  await expect(pickerOf(panel)).toHaveAttribute('aria-label', 'Claude session to attach');
  await expect.poll(() => pickerOptions(panel)).toEqual(PICKER_OPTIONS_FOR_THIS_THREAD);
  await expect(pickerOf(panel)).toHaveValue('');
});

test('thread session: picker keeps Attach disabled until a session is chosen', async ({
  page,
  dashboard,
}) => {
  seedThreadScenario(dashboard.data);
  const dialog = await openFromTicketRow(page);
  const panel = sectionOf(dialog);
  await expect(panel).toBeVisible();
  await expect(attachButtonOf(panel)).toHaveText('Attach');
  await expect(attachButtonOf(panel)).toBeDisabled();
  await expect.poll(() => pickerOptions(panel)).toEqual(PICKER_OPTIONS_FOR_THIS_THREAD);
  await pickerOf(panel).selectOption(SESSION_FREE);
  await expect(attachButtonOf(panel)).toBeEnabled();
  await pickerOf(panel).selectOption('');
  await expect(attachButtonOf(panel)).toBeDisabled();
});

test('thread session: picker returns to the placeholder after a successful attach', async ({
  page,
  dashboard,
}) => {
  seedThreadScenario(dashboard.data);
  const dialog = await openFromTicketRow(page);
  const panel = sectionOf(dialog);
  await expect(panel).toBeVisible();
  await expect.poll(() => pickerOptions(panel)).toEqual(PICKER_OPTIONS_FOR_THIS_THREAD);
  await pickerOf(panel).selectOption(SESSION_FREE);
  await attachButtonOf(panel).click();
  await expect(itemOf(panel, SESSION_FREE)).toBeVisible();
  await expect(pickerOf(panel)).toHaveValue('');
  await expect(attachButtonOf(panel)).toBeDisabled();
});

test('thread session: attach posts this thread link and the chosen session once, then lists it', async ({
  page,
  dashboard,
}) => {
  seedThreadScenario(dashboard.data);
  const dialog = await openFromTicketRow(page);
  const panel = sectionOf(dialog);
  await expect(panel).toBeVisible();
  await expect.poll(() => pickerOptions(panel)).toEqual(PICKER_OPTIONS_FOR_THIS_THREAD);
  await pickerOf(panel).selectOption(SESSION_FREE);
  await attachButtonOf(panel).click();
  await expect(itemOf(panel, SESSION_FREE)).toBeVisible();
  await expect
    .poll(() => listedSessionIds(panel))
    .toEqual(sorted(SESSION_HERE_FIRST, SESSION_HERE_SECOND, SESSION_FREE));
  expect(writeCallsOf(dashboard)).toEqual([
    {
      method: 'POST',
      path: ATTACH_ROUTE,
      body: { link: DIALOG_LINK, sessionId: SESSION_FREE },
    },
  ]);
  const offered = (await pickerOptions(panel)).map(([value]) => value);
  expect(offered).not.toContain(SESSION_FREE);
});

test('thread session: attach adds a thread that is not on the watch list yet with that one call', async ({
  page,
  dashboard,
}) => {
  seedThreadScenario(dashboard.data, { links: linksOfOtherThreads() });
  const dialog = await openFromTicketRow(page);
  const panel = sectionOf(dialog);
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('thread-session-empty')).toHaveText('No session attached');
  await expect
    .poll(async () => (await pickerOptions(panel)).map(([value]) => value))
    .toEqual([
      '',
      SESSION_HERE_FIRST,
      SESSION_HERE_SECOND,
      SESSION_ELSEWHERE_TS,
      SESSION_ELSEWHERE_CHANNEL,
      SESSION_FREE,
      SESSION_UNNAMED,
    ]);
  await pickerOf(panel).selectOption(SESSION_FREE);
  await attachButtonOf(panel).click();
  await expect(itemOf(panel, SESSION_FREE)).toBeVisible();
  await expect(panel.getByTestId('thread-session-empty')).toHaveCount(0);
  expect(writeCallsOf(dashboard)).toEqual([
    {
      method: 'POST',
      path: ATTACH_ROUTE,
      body: { link: DIALOG_LINK, sessionId: SESSION_FREE },
    },
  ]);
  expect(dashboard.data.slack.watch.links.map(({ key }) => key)).toContain(THREAD_KEY);
});

test('thread session: detach posts this thread link and the session once, then removes it', async ({
  page,
  dashboard,
}) => {
  seedThreadScenario(dashboard.data);
  const dialog = await openFromTicketRow(page);
  const panel = sectionOf(dialog);
  await expect(panel).toBeVisible();
  await expect(itemOf(panel, SESSION_HERE_FIRST)).toBeVisible();
  await detachButtonOf(panel, SESSION_HERE_FIRST).click();
  await expect(itemOf(panel, SESSION_HERE_FIRST)).toHaveCount(0);
  await expect(itemOf(panel, SESSION_HERE_SECOND)).toBeVisible();
  expect(writeCallsOf(dashboard)).toEqual([
    {
      method: 'POST',
      path: DETACH_ROUTE,
      body: { link: DIALOG_LINK, sessionId: SESSION_HERE_FIRST },
    },
  ]);
  await expect
    .poll(async () => (await pickerOptions(panel)).map(([value]) => value))
    .toContain(SESSION_HERE_FIRST);
});

test('thread session: detach leaves the thread on the watch list and never calls remove', async ({
  page,
  dashboard,
}) => {
  seedThreadScenario(dashboard.data);
  const dialog = await openFromTicketRow(page);
  const panel = sectionOf(dialog);
  await expect(panel).toBeVisible();
  for (const sessionId of [SESSION_HERE_FIRST, SESSION_HERE_SECOND]) {
    await detachButtonOf(panel, sessionId).click();
    await expect(itemOf(panel, sessionId)).toHaveCount(0);
  }
  await expect(panel.getByTestId('thread-session-empty')).toHaveText('No session attached');
  expect(writeCallsOf(dashboard).map(({ path }) => path)).toEqual([DETACH_ROUTE, DETACH_ROUTE]);
  expect(dashboard.data.slack.watch.links.map(({ key }) => key)).toContain(THREAD_KEY);
});

test('thread session: failure on a refused attach shows the watch card words and keeps the section as it was', async ({
  page,
  dashboard,
}) => {
  seedThreadScenario(dashboard.data);
  const bodies = await answerWith(page, ATTACH_ROUTE, (route) =>
    route.fulfill(failure(409, 'WATCH_DISABLED')),
  );
  const dialog = await openFromTicketRow(page);
  const panel = sectionOf(dialog);
  await expect(panel).toBeVisible();
  await expect.poll(() => pickerOptions(panel)).toEqual(PICKER_OPTIONS_FOR_THIS_THREAD);
  await pickerOf(panel).selectOption(SESSION_FREE);
  await attachButtonOf(panel).click();
  const error = panel.getByTestId('thread-session-error');
  await expect(error).toHaveText(WATCH_DISABLED_SENTENCE);
  await expect(error).toHaveJSProperty('tagName', 'P');
  await expect(error).toHaveAttribute('role', 'alert');
  expect(bodies).toEqual([{ link: DIALOG_LINK, sessionId: SESSION_FREE }]);
  await expect
    .poll(() => listedSessionIds(panel))
    .toEqual(sorted(SESSION_HERE_FIRST, SESSION_HERE_SECOND));
  await expect(pickerOf(panel)).toHaveValue(SESSION_FREE);
  expect(await pickerOptions(panel)).toEqual(PICKER_OPTIONS_FOR_THIS_THREAD);
  await expect(dialog).toBeVisible();
});

test('thread session: failure on an attach that cannot reach the server shows the unreachable words', async ({
  page,
  dashboard,
}) => {
  seedThreadScenario(dashboard.data);
  const bodies = await answerWith(page, ATTACH_ROUTE, (route) => route.abort('failed'));
  const dialog = await openFromTicketRow(page);
  const panel = sectionOf(dialog);
  await expect(panel).toBeVisible();
  await expect.poll(() => pickerOptions(panel)).toEqual(PICKER_OPTIONS_FOR_THIS_THREAD);
  await pickerOf(panel).selectOption(SESSION_FREE);
  await attachButtonOf(panel).click();
  await expect(panel.getByTestId('thread-session-error')).toHaveText(UNREACHABLE_SENTENCE);
  expect(bodies).toHaveLength(1);
  await expect
    .poll(() => listedSessionIds(panel))
    .toEqual(sorted(SESSION_HERE_FIRST, SESSION_HERE_SECOND));
  await expect(pickerOf(panel)).toHaveValue(SESSION_FREE);
  await expect(dialog).toBeVisible();
});

test('thread session: failure on a refused detach shows the watch card words and keeps the list', async ({
  page,
  dashboard,
}) => {
  seedThreadScenario(dashboard.data);
  const bodies = await answerWith(page, DETACH_ROUTE, (route) =>
    route.fulfill(failure(500, 'OPERATION_FAILED')),
  );
  const dialog = await openFromTicketRow(page);
  const panel = sectionOf(dialog);
  await expect(panel).toBeVisible();
  await expect(itemOf(panel, SESSION_HERE_FIRST)).toBeVisible();
  await detachButtonOf(panel, SESSION_HERE_FIRST).click();
  const error = panel.getByTestId('thread-session-error');
  await expect(error).toHaveText(OPERATION_FAILED_SENTENCE);
  await expect(error).toHaveAttribute('role', 'alert');
  expect(bodies).toEqual([{ link: DIALOG_LINK, sessionId: SESSION_HERE_FIRST }]);
  await expect
    .poll(() => listedSessionIds(panel))
    .toEqual(sorted(SESSION_HERE_FIRST, SESSION_HERE_SECOND));
  await expect(dialog).toBeVisible();
});

test('thread session: failure on a detach that cannot reach the server shows the unreachable words', async ({
  page,
  dashboard,
}) => {
  seedThreadScenario(dashboard.data);
  const bodies = await answerWith(page, DETACH_ROUTE, (route) => route.abort('failed'));
  const dialog = await openFromTicketRow(page);
  const panel = sectionOf(dialog);
  await expect(panel).toBeVisible();
  await expect(itemOf(panel, SESSION_HERE_SECOND)).toBeVisible();
  await detachButtonOf(panel, SESSION_HERE_SECOND).click();
  await expect(panel.getByTestId('thread-session-error')).toHaveText(UNREACHABLE_SENTENCE);
  expect(bodies).toHaveLength(1);
  await expect
    .poll(() => listedSessionIds(panel))
    .toEqual(sorted(SESSION_HERE_FIRST, SESSION_HERE_SECOND));
  await expect(dialog).toBeVisible();
});

test('thread session: failure while an attach is in flight disables every control so a double click sends one request', async ({
  page,
  dashboard,
}) => {
  seedThreadScenario(dashboard.data);
  const held = await holdResponses(page, ATTACH_ROUTE);
  const dialog = await openFromTicketRow(page);
  const panel = sectionOf(dialog);
  await expect(panel).toBeVisible();
  await expect.poll(() => pickerOptions(panel)).toEqual(PICKER_OPTIONS_FOR_THIS_THREAD);
  await pickerOf(panel).selectOption(SESSION_FREE);
  await attachButtonOf(panel).dblclick();
  await expect(attachButtonOf(panel)).toBeDisabled();
  await expect(detachButtonOf(panel, SESSION_HERE_FIRST)).toBeDisabled();
  await expect(detachButtonOf(panel, SESSION_HERE_SECOND)).toBeDisabled();
  await expect.poll(() => held.bodies.length).toBe(1);
  held.release();
  await expect(itemOf(panel, SESSION_FREE)).toBeVisible();
  await expect(detachButtonOf(panel, SESSION_HERE_FIRST)).toBeEnabled();
  expect(held.bodies).toHaveLength(1);
  expect(writeCallsOf(dashboard)).toHaveLength(1);
});

test('thread session: failure while a detach is in flight disables every control so a double click sends one request', async ({
  page,
  dashboard,
}) => {
  seedThreadScenario(dashboard.data);
  const held = await holdResponses(page, DETACH_ROUTE);
  const dialog = await openFromTicketRow(page);
  const panel = sectionOf(dialog);
  await expect(panel).toBeVisible();
  await expect.poll(() => pickerOptions(panel)).toEqual(PICKER_OPTIONS_FOR_THIS_THREAD);
  await pickerOf(panel).selectOption(SESSION_FREE);
  await expect(attachButtonOf(panel)).toBeEnabled();
  await detachButtonOf(panel, SESSION_HERE_FIRST).dblclick();
  await expect(attachButtonOf(panel)).toBeDisabled();
  await expect(detachButtonOf(panel, SESSION_HERE_FIRST)).toBeDisabled();
  await expect(detachButtonOf(panel, SESSION_HERE_SECOND)).toBeDisabled();
  await expect.poll(() => held.bodies.length).toBe(1);
  held.release();
  await expect(itemOf(panel, SESSION_HERE_FIRST)).toHaveCount(0);
  await expect(detachButtonOf(panel, SESSION_HERE_SECOND)).toBeEnabled();
  expect(held.bodies).toHaveLength(1);
  expect(writeCallsOf(dashboard)).toHaveLength(1);
});

test('thread session: unavailable when the watcher is disabled, with the thread controls unchanged', async ({
  page,
  dashboard,
}) => {
  seedThreadScenario(dashboard.data, { watch: { disabledReason: 'claude_home_unreadable' } });
  const dialog = await openFromTicketRow(page);
  await expectUnavailableSection(page, dialog);
});

test('thread session: unavailable when the watch list read is refused, with the thread controls unchanged', async ({
  page,
  dashboard,
}) => {
  seedThreadScenario(dashboard.data);
  await answerWith(page, WATCH_LIST, (route) => route.fulfill(failure(500, 'OPERATION_FAILED')));
  const dialog = await openFromTicketRow(page);
  await expectUnavailableSection(page, dialog);
});

test('thread session: unavailable when the watch list read cannot reach the server, with the thread controls unchanged', async ({
  page,
  dashboard,
}) => {
  seedThreadScenario(dashboard.data);
  await answerWith(page, WATCH_LIST, (route) => route.abort('failed'));
  const dialog = await openFromTicketRow(page);
  await expectUnavailableSection(page, dialog);
});

test('thread session: no link keeps the section with attach disabled and the reason shown', async ({
  page,
  dashboard,
}) => {
  seedThreadScenario(dashboard.data, { url: '' });
  const dialog = await openFromMentionsRow(page);
  const panel = sectionOf(dialog);
  await expect(panel).toBeVisible();
  await expect(panel.getByText('Claude session', { exact: true })).toBeVisible();
  await expect(panel.getByTestId('thread-session-no-link')).toHaveText('No link to attach to');
  await expect(pickerOf(panel)).toBeDisabled();
  await expect(attachButtonOf(panel)).toBeDisabled();
  await expect(dialog.getByTestId('slack-thread-open')).toBeDisabled();
  expect(writeCallsOf(dashboard)).toEqual([]);
});

test('thread session: reads the watch list once on open and once after each attach or detach, never on a timer', async ({
  page,
  dashboard,
}) => {
  seedThreadScenario(dashboard.data);
  await page.clock.install({ time: FROZEN_AT });
  await page.goto('/#/my-tickets');
  await expect(page.getByTestId(`slack-thread-link-${THREAD_TS}`)).toBeVisible();
  await advanceMinutes(page, IDLE_MINUTES);
  expect(readsOf(dashboard, WATCH_LIST)).toBe(0);
  expect(readsOf(dashboard, WATCH_SESSIONS)).toBe(0);

  const dialog = await clickTicketGlyph(page);
  const panel = sectionOf(dialog);
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('thread-session-list')).toBeVisible();
  expect(readsOf(dashboard, WATCH_LIST)).toBe(1);
  expect(readsOf(dashboard, WATCH_SESSIONS)).toBe(1);
  await advanceMinutes(page, IDLE_MINUTES);
  expect(readsOf(dashboard, WATCH_LIST)).toBe(1);

  await expect.poll(() => pickerOptions(panel)).toEqual(PICKER_OPTIONS_FOR_THIS_THREAD);
  await pickerOf(panel).selectOption(SESSION_FREE);
  await attachButtonOf(panel).click();
  await expect(itemOf(panel, SESSION_FREE)).toBeVisible();
  await expect.poll(() => readsOf(dashboard, WATCH_LIST)).toBe(2);
  await advanceMinutes(page, IDLE_MINUTES);
  expect(readsOf(dashboard, WATCH_LIST)).toBe(2);

  await detachButtonOf(panel, SESSION_FREE).click();
  await expect(itemOf(panel, SESSION_FREE)).toHaveCount(0);
  await expect.poll(() => readsOf(dashboard, WATCH_LIST)).toBe(3);
  await advanceMinutes(page, IDLE_MINUTES);
  expect(readsOf(dashboard, WATCH_LIST)).toBe(3);

  await dialog.getByTestId('slack-thread-close').click();
  await expect(page.getByTestId('slack-thread-dialog')).toHaveCount(0);
  await advanceMinutes(page, IDLE_MINUTES);
  expect(readsOf(dashboard, WATCH_LIST)).toBe(3);
  expect(readsOf(dashboard, WATCH_SESSIONS)).toBe(1);
});

test('thread session: reads add nothing after a failed attach or a failed detach', async ({
  page,
  dashboard,
}) => {
  seedThreadScenario(dashboard.data);
  await answerWith(page, ATTACH_ROUTE, (route) => route.abort('failed'));
  await answerWith(page, DETACH_ROUTE, (route) => route.fulfill(failure(500, 'OPERATION_FAILED')));
  const dialog = await openFromTicketRow(page);
  const panel = sectionOf(dialog);
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('thread-session-list')).toBeVisible();
  expect(readsOf(dashboard, WATCH_LIST)).toBe(1);
  await expect.poll(() => pickerOptions(panel)).toEqual(PICKER_OPTIONS_FOR_THIS_THREAD);

  await pickerOf(panel).selectOption(SESSION_FREE);
  await attachButtonOf(panel).click();
  await expect(panel.getByTestId('thread-session-error')).toHaveText(UNREACHABLE_SENTENCE);
  await flushPage(page);
  expect(readsOf(dashboard, WATCH_LIST)).toBe(1);

  await detachButtonOf(panel, SESSION_HERE_FIRST).click();
  await expect(panel.getByTestId('thread-session-error')).toHaveText(OPERATION_FAILED_SENTENCE);
  await flushPage(page);
  expect(readsOf(dashboard, WATCH_LIST)).toBe(1);
});

test('thread session: slack tab shows the same sessions and picker from a mentions row', async ({
  page,
  dashboard,
}) => {
  seedThreadScenario(dashboard.data);
  const dialog = await openFromMentionsRow(page);
  const panel = sectionOf(dialog);
  await expect(panel).toBeVisible();
  await expect(panel.getByText('Claude session', { exact: true })).toBeVisible();
  await expect
    .poll(() => listedSessionIds(panel))
    .toEqual(sorted(SESSION_HERE_FIRST, SESSION_HERE_SECOND));
  await expect(itemOf(panel, SESSION_ELSEWHERE_TS)).toHaveCount(0);
  await expect(itemOf(panel, SESSION_ELSEWHERE_CHANNEL)).toHaveCount(0);
  await expect.poll(() => pickerOptions(panel)).toEqual(PICKER_OPTIONS_FOR_THIS_THREAD);
  await expect(attachButtonOf(panel)).toBeDisabled();
});

test('thread session: slack tab attaches and detaches through the same section', async ({
  page,
  dashboard,
}) => {
  seedThreadScenario(dashboard.data);
  const dialog = await openFromMentionsRow(page);
  const panel = sectionOf(dialog);
  await expect(panel).toBeVisible();
  await expect.poll(() => pickerOptions(panel)).toEqual(PICKER_OPTIONS_FOR_THIS_THREAD);
  await pickerOf(panel).selectOption(SESSION_FREE);
  await attachButtonOf(panel).click();
  await expect(itemOf(panel, SESSION_FREE)).toBeVisible();
  await expect(pickerOf(panel)).toHaveValue('');
  await detachButtonOf(panel, SESSION_FREE).click();
  await expect(itemOf(panel, SESSION_FREE)).toHaveCount(0);
  expect(writeCallsOf(dashboard)).toEqual([
    {
      method: 'POST',
      path: ATTACH_ROUTE,
      body: { link: DIALOG_LINK, sessionId: SESSION_FREE },
    },
    {
      method: 'POST',
      path: DETACH_ROUTE,
      body: { link: DIALOG_LINK, sessionId: SESSION_FREE },
    },
  ]);
});
