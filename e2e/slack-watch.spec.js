import { test, expect } from './fixtures.js';
import {
  WATCH_DEFAULT_TEMPLATE,
  slackWatchData,
  watchLink,
  watchPermalink,
  watchSession,
} from './data.js';

const CHANNEL = 'C0EXAMPLE1';
const THREAD_A = '1761900000.000100';
const THREAD_B = '1761900500.000200';
const KEY_A = `${CHANNEL}:${THREAD_A}`;
const KEY_B = `${CHANNEL}:${THREAD_B}`;
const LINK_A = watchPermalink(CHANNEL, THREAD_A);
const LINK_B = watchPermalink(CHANNEL, THREAD_B);
const SESSION_BILLING = '11111111-1111-4111-8111-111111111111';
const SESSION_FLAKY = '22222222-2222-4222-8222-222222222222';
const SESSION_IDLE = '33333333-3333-4333-8333-333333333333';
const SESSION_MANUAL = '44444444-4444-4444-8444-444444444444';
const CHECKED_AT = '2026-10-31T08:55:00.000Z';

const SETTINGS_ROUTE = '/api/slack/watch/settings';
const INTERVAL_MESSAGE = 'Interval must be whole seconds from 30 to 3600.';
const TEMPLATE_MESSAGE = 'Notice must be one line of at most 200 characters.';
const MALFORMED_SESSION_ID = 'not-a-session-id';
const INVALID_SESSION_SENTENCE =
  'That session id is not valid. Choose a session from the list or paste a full session id.';

const lastCall = ({ data }) => data.slack.watch.calls.at(-1);
const watchRequests = ({ requests }) =>
  requests.filter(({ path }) => path.startsWith('/api/slack/watch'));
const openSlackTab = async (page) => {
  await page.goto('/#/slack');
  await expect(page.getByTestId('slack-watch-card')).toBeVisible();
  await expect(page.getByTestId('slack-watch-state')).toBeVisible();
};
const sessionTestId = (part, key, sessionId) => `slack-watch-session-${part}-${key}-${sessionId}`;

test.describe('watch card', () => {
  test('is mounted for a connected Slack and gone once Slack is not connected', async ({
    page,
    dashboard,
  }) => {
    await openSlackTab(page);
    const card = page.getByTestId('slack-watch-card');
    await expect(card.getByTestId('slack-watch-links-input')).toHaveJSProperty(
      'tagName',
      'TEXTAREA',
    );
    await expect(card.getByTestId('slack-watch-links-add')).toHaveText('Add');
    await expect(card.getByTestId('slack-watch-empty')).toBeVisible();
    await expect(card.getByTestId('slack-watch-links')).toHaveCount(0);
    await expect(card.getByTestId('slack-watch-attach-link')).toHaveJSProperty('tagName', 'SELECT');
    await expect(card.getByTestId('slack-watch-picker')).toHaveJSProperty('tagName', 'SELECT');
    await expect(card.getByTestId('slack-watch-attach-session-id')).toBeVisible();
    await expect(card.getByTestId('slack-watch-attach')).toHaveText('Attach');

    dashboard.requests.length = 0;
    dashboard.data.slack.status = { connected: false, connecting: false };
    await page.reload();
    await expect(page.getByTestId('slack-disconnected')).toBeVisible();
    await expect(page.getByTestId('slack-watch-card')).toHaveCount(0);
    expect(watchRequests(dashboard)).toEqual([]);
  });

  test('adds pasted links one per line and shows each rejection inline', async ({
    page,
    dashboard,
  }) => {
    const channelOnly = `https://example.slack.com/archives/${CHANNEL}`;
    const foreign = `https://example.com/archives/${CHANNEL}/p1761900000000100`;
    await openSlackTab(page);
    await page
      .getByTestId('slack-watch-links-input')
      .fill([LINK_A, '', `  ${channelOnly}  `, foreign].join('\n'));
    await page.getByTestId('slack-watch-links-add').click();

    await expect(page.getByTestId(`slack-watch-row-${KEY_A}`)).toBeVisible();
    expect(lastCall(dashboard)).toEqual({
      method: 'POST',
      path: '/api/slack/watch/links',
      body: { links: [LINK_A, channelOnly, foreign] },
    });
    const rejections = page.getByTestId('slack-watch-rejection');
    await expect(rejections).toHaveCount(2);
    await expect(rejections.nth(0)).toContainText(channelOnly);
    await expect(rejections.nth(0)).toContainText('not_a_thread_link');
    await expect(rejections.nth(1)).toContainText(foreign);
    await expect(rejections.nth(1)).toContainText('not_slack_host');
  });

  test('lists each link in a table with last checked, status and per-session delivery', async ({
    page,
    dashboard,
  }) => {
    dashboard.data.slack.watch = slackWatchData({
      links: [
        watchLink(CHANNEL, THREAD_A, {
          lastCheckedAt: CHECKED_AT,
          lastStatus: 'rate_limited',
          sessions: [
            watchSession(SESSION_BILLING, { status: 'delivered', reason: null, at: CHECKED_AT }),
            watchSession(SESSION_FLAKY, {
              status: 'failed-permanent',
              reason: 'untrusted_workspace',
              at: CHECKED_AT,
            }),
            watchSession(SESSION_IDLE),
          ],
        }),
        watchLink(CHANNEL, THREAD_B),
      ],
    });
    await openSlackTab(page);

    const table = page.getByTestId('slack-watch-links');
    await expect(table).toHaveJSProperty('tagName', 'TABLE');
    for (const name of ['Link', 'Last checked', 'Status', 'Sessions'])
      await expect(table.getByRole('columnheader', { name })).toBeVisible();
    await expect(table.getByTestId(/^slack-watch-row-/)).toHaveCount(2);
    await expect(page.getByTestId(`slack-watch-link-${KEY_A}`)).toContainText(LINK_A);
    await expect(page.getByTestId(`slack-watch-link-${KEY_B}`)).toContainText(LINK_B);

    await expect(page.getByTestId(`slack-watch-checked-${KEY_A}`)).not.toBeEmpty();
    await expect(page.getByTestId(`slack-watch-checked-${KEY_A}`)).not.toHaveText('never');
    await expect(page.getByTestId(`slack-watch-checked-${KEY_B}`)).toHaveText('never');
    await expect(page.getByTestId(`slack-watch-status-${KEY_A}`)).toContainText('rate_limited');
    await expect(page.getByTestId(`slack-watch-status-${KEY_B}`)).not.toHaveText(/null|undefined/);

    const delivered = (part) => page.getByTestId(sessionTestId(part, KEY_A, SESSION_BILLING));
    await expect(delivered('status')).toHaveText('delivered');
    await expect(delivered('time')).not.toBeEmpty();
    await expect(delivered('reason')).toHaveCount(0);
    await expect(page.getByTestId(`slack-watch-session-${KEY_A}-${SESSION_BILLING}`)).toContainText(
      SESSION_BILLING,
    );

    const unreachable = (part) => page.getByTestId(sessionTestId(part, KEY_A, SESSION_FLAKY));
    await expect(unreachable('status')).toHaveText('failed-permanent');
    await expect(unreachable('reason')).toContainText('untrusted_workspace');
    await expect(unreachable('time')).not.toBeEmpty();

    const untried = (part) => page.getByTestId(sessionTestId(part, KEY_A, SESSION_IDLE));
    await expect(untried('status')).toHaveText('no delivery yet');
    await expect(untried('time')).toHaveCount(0);

    for (const sessionId of [SESSION_BILLING, SESSION_FLAKY, SESSION_IDLE])
      await expect(page.getByTestId(`slack-watch-detach-${KEY_A}-${sessionId}`)).toHaveText(
        'Detach',
      );
    for (const key of [KEY_A, KEY_B])
      await expect(page.getByTestId(`slack-watch-remove-${key}`)).toHaveText('Remove');
  });

  test('attaches a picked session and then a manually entered id to a link', async ({
    page,
    dashboard,
  }) => {
    dashboard.data.slack.watch = slackWatchData({
      links: [
        watchLink(CHANNEL, THREAD_A, {
          sessions: [
            watchSession(SESSION_BILLING, { status: 'delivered', reason: null, at: CHECKED_AT }),
          ],
        }),
        watchLink(CHANNEL, THREAD_B),
      ],
      pickerSessions: [
        { sessionId: SESSION_BILLING, state: 'live', name: 'Refactor billing' },
        { sessionId: SESSION_FLAKY, state: 'finished', name: 'Investigate flaky test' },
      ],
    });
    await openSlackTab(page);

    const picker = page.getByTestId('slack-watch-picker');
    const billing = picker.locator(`option[value="${SESSION_BILLING}"]`);
    await expect(billing).toContainText('Refactor billing');
    await expect(billing).toContainText('live');
    await expect(billing).toContainText('attached');
    const flaky = picker.locator(`option[value="${SESSION_FLAKY}"]`);
    await expect(flaky).toContainText('Investigate flaky test');
    await expect(flaky).toContainText('finished');
    await expect(flaky).not.toContainText('attached');

    await page.getByTestId('slack-watch-attach-link').selectOption(LINK_B);
    await picker.selectOption(SESSION_FLAKY);
    await page.getByTestId('slack-watch-attach').click();
    await expect(page.getByTestId(sessionTestId('status', KEY_B, SESSION_FLAKY))).toHaveText(
      'no delivery yet',
    );
    expect(lastCall(dashboard)).toEqual({
      method: 'POST',
      path: '/api/slack/watch/attach',
      body: { link: LINK_B, sessionId: SESSION_FLAKY },
    });

    await page.getByTestId('slack-watch-attach-link').selectOption(LINK_A);
    await picker.selectOption(SESSION_BILLING);
    await page.getByTestId('slack-watch-attach-session-id').fill(SESSION_MANUAL);
    await page.getByTestId('slack-watch-attach').click();
    await expect(page.getByTestId(sessionTestId('status', KEY_A, SESSION_MANUAL))).toBeVisible();
    expect(lastCall(dashboard)).toEqual({
      method: 'POST',
      path: '/api/slack/watch/attach',
      body: { link: LINK_A, sessionId: SESSION_MANUAL },
    });
  });

  test('detaches one session and removes one link', async ({ page, dashboard }) => {
    dashboard.data.slack.watch = slackWatchData({
      links: [
        watchLink(CHANNEL, THREAD_A, {
          sessions: [
            watchSession(SESSION_BILLING, { status: 'delivered', reason: null, at: CHECKED_AT }),
            watchSession(SESSION_FLAKY),
          ],
        }),
        watchLink(CHANNEL, THREAD_B),
      ],
    });
    await openSlackTab(page);

    await page.getByTestId(`slack-watch-detach-${KEY_A}-${SESSION_BILLING}`).click();
    await expect(page.getByTestId(`slack-watch-session-${KEY_A}-${SESSION_BILLING}`)).toHaveCount(
      0,
    );
    await expect(page.getByTestId(`slack-watch-session-${KEY_A}-${SESSION_FLAKY}`)).toBeVisible();
    expect(lastCall(dashboard)).toEqual({
      method: 'POST',
      path: '/api/slack/watch/detach',
      body: { link: LINK_A, sessionId: SESSION_BILLING },
    });

    await page.getByTestId(`slack-watch-remove-${KEY_A}`).click();
    await expect(page.getByTestId(`slack-watch-row-${KEY_A}`)).toHaveCount(0);
    await expect(page.getByTestId(`slack-watch-row-${KEY_B}`)).toBeVisible();
    expect(lastCall(dashboard)).toEqual({
      method: 'POST',
      path: '/api/slack/watch/remove',
      body: { link: LINK_A },
    });
  });

  test('explains a refused action in a plain sentence instead of the server code', async ({
    page,
    dashboard,
  }) => {
    dashboard.data.slack.watch = slackWatchData({ links: [watchLink(CHANNEL, THREAD_A)] });
    await openSlackTab(page);
    const actionError = page.getByTestId('slack-watch-action-error');
    await expect(actionError).toHaveCount(0);

    await page.getByTestId('slack-watch-attach-link').selectOption(LINK_A);
    await page.getByTestId('slack-watch-attach-session-id').fill(MALFORMED_SESSION_ID);
    await page.getByTestId('slack-watch-attach').click();

    await expect(actionError).toHaveText(INVALID_SESSION_SENTENCE);
    expect(lastCall(dashboard)).toEqual({
      method: 'POST',
      path: '/api/slack/watch/attach',
      body: { link: LINK_A, sessionId: MALFORMED_SESSION_ID },
    });
    expect(dashboard.data.slack.watch.links[0].sessions).toEqual([]);
  });

  test('polls only the local list, and only while the tab is active and the document is visible', async ({
    page,
    dashboard,
  }) => {
    const listReads = () =>
      dashboard.requests.filter(
        ({ method, path }) => method === 'GET' && path === '/api/slack/watch',
      ).length;
    const settled = () =>
      page.evaluate(() => fetch('/api/config').then((response) => response.json()));
    const hideDocument = () =>
      page.evaluate(() =>
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }),
      );
    const showDocument = () =>
      page.evaluate(() => {
        delete document.hidden;
      });

    await page.clock.install();
    await openSlackTab(page);
    await expect.poll(listReads).toBeGreaterThan(0);

    let before = listReads();
    await page.clock.runFor(120_000);
    await settled();
    expect(listReads()).toBeGreaterThan(before);

    await hideDocument();
    await settled();
    before = listReads();
    await page.clock.runFor(300_000);
    await settled();
    expect(listReads()).toBe(before);

    await showDocument();
    await page.getByTestId('tab-services').click();
    await settled();
    before = listReads();
    await page.clock.runFor(300_000);
    await settled();
    expect(listReads()).toBe(before);
  });
});

test.describe('watch controls', () => {
  test('show the stored values and pause then resume a running watcher', async ({
    page,
    dashboard,
  }) => {
    await openSlackTab(page);
    const state = page.getByTestId('slack-watch-state');
    await expect(state).toHaveText('Running');
    await expect(state).toHaveAttribute('data-state', 'running');
    await expect(page.getByTestId('slack-watch-reason')).toHaveCount(0);
    await expect(page.getByTestId('slack-watch-interval')).toHaveValue('180');
    await expect(page.getByTestId('slack-watch-template')).toHaveValue(WATCH_DEFAULT_TEMPLATE);
    await expect(page.getByTestId('slack-watch-resume')).toHaveCount(0);

    await expect(page.getByTestId('slack-watch-pause')).toHaveText('Pause');
    await page.getByTestId('slack-watch-pause').click();
    await expect(state).toHaveText('Paused');
    await expect(state).toHaveAttribute('data-state', 'paused');
    expect(lastCall(dashboard)).toMatchObject({ method: 'POST', path: '/api/slack/watch/pause' });
    await expect(page.getByTestId('slack-watch-pause')).toHaveCount(0);
    await expect(page.getByTestId('slack-watch-resume')).toHaveText('Resume');

    await page.getByTestId('slack-watch-resume').click();
    await expect(state).toHaveText('Running');
    expect(lastCall(dashboard)).toMatchObject({ method: 'POST', path: '/api/slack/watch/resume' });
    await expect(page.getByTestId('slack-watch-pause')).toBeVisible();
  });

  test('show a paused watcher and resume it', async ({ page, dashboard }) => {
    dashboard.data.slack.watch.settings.paused = true;
    await openSlackTab(page);
    const state = page.getByTestId('slack-watch-state');
    await expect(state).toHaveText('Paused');
    await expect(state).toHaveAttribute('data-state', 'paused');
    await expect(page.getByTestId('slack-watch-pause')).toHaveCount(0);

    await page.getByTestId('slack-watch-resume').click();
    await expect(state).toHaveText('Running');
    expect(lastCall(dashboard)).toMatchObject({ method: 'POST', path: '/api/slack/watch/resume' });
  });

  test('show the disabled state with its reason', async ({ page, dashboard }) => {
    dashboard.data.slack.watch.disabledReason = 'claude_home_unreadable';
    await openSlackTab(page);
    const state = page.getByTestId('slack-watch-state');
    await expect(state).toHaveText('Disabled');
    await expect(state).toHaveAttribute('data-state', 'disabled');
    await expect(page.getByTestId('slack-watch-reason')).toContainText('claude_home_unreadable');
  });

  test("show the server's field errors for an interval outside 30 to 3600 and a multi-line template", async ({
    page,
    dashboard,
  }) => {
    await openSlackTab(page);
    const interval = page.getByTestId('slack-watch-interval');
    const template = page.getByTestId('slack-watch-template');
    const save = page.getByTestId('slack-watch-settings-save');
    const intervalError = page.getByTestId('slack-watch-interval-error');
    const templateError = page.getByTestId('slack-watch-template-error');
    await expect(save).toHaveText('Save');

    for (const value of ['29', '3601']) {
      await interval.fill(value);
      await save.click();
      await expect(intervalError).toContainText(INTERVAL_MESSAGE);
      await expect(interval).toHaveValue(value);
      await expect(templateError).toHaveCount(0);
    }
    expect(lastCall(dashboard)).toEqual({
      method: 'PUT',
      path: SETTINGS_ROUTE,
      body: { intervalSeconds: 3601, noticeTemplate: WATCH_DEFAULT_TEMPLATE },
    });

    await interval.fill('60');
    await template.fill('line one\nline two');
    await save.click();
    await expect(templateError).toContainText(TEMPLATE_MESSAGE);
    await expect(intervalError).toHaveCount(0);
    expect(lastCall(dashboard).body).toEqual({
      intervalSeconds: 60,
      noticeTemplate: 'line one\nline two',
    });
    expect(dashboard.data.slack.watch.settings).toEqual({
      intervalSeconds: 180,
      noticeTemplate: WATCH_DEFAULT_TEMPLATE,
      paused: false,
    });
  });

  test('warn when the template has no {link} and still save it', async ({ page, dashboard }) => {
    await openSlackTab(page);
    const interval = page.getByTestId('slack-watch-interval');
    const template = page.getByTestId('slack-watch-template');
    const warning = page.getByTestId('slack-watch-template-warning');
    await expect(warning).toHaveCount(0);

    await template.fill('Something changed');
    await expect(warning).toContainText('will not know which thread changed');
    await page.getByTestId('slack-watch-settings-save').click();
    await expect
      .poll(() => lastCall(dashboard)?.body)
      .toEqual({ intervalSeconds: 180, noticeTemplate: 'Something changed' });
    expect(dashboard.data.slack.watch.settings.noticeTemplate).toBe('Something changed');
    await expect(page.getByTestId('slack-watch-interval-error')).toHaveCount(0);
    await expect(page.getByTestId('slack-watch-template-error')).toHaveCount(0);
    await expect(warning).toBeVisible();

    await template.fill('Changed: {link}');
    await expect(warning).toHaveCount(0);
    await interval.fill('60');
    await page.getByTestId('slack-watch-settings-save').click();
    await expect
      .poll(() => lastCall(dashboard)?.body)
      .toEqual({ intervalSeconds: 60, noticeTemplate: 'Changed: {link}' });
    expect(dashboard.data.slack.watch.settings.intervalSeconds).toBe(60);
  });
});
