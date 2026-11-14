import { test, expect } from './fixtures.js';
import { claudeEntry } from './data.js';

// F6: the opt-in "Needs you" desktop notification and tab-title count. The page's Notification and
// document.hidden are replaced by recorders in an init script, so a spec can say "the tab is hidden" and
// read what would have been shown. Invented tickets only.
const POLL = 16_000;
const STORAGE_KEY = 'dev-dashboard.needs-you.notify';
const WORKING = claudeEntry('working', 'running', { phase: 'implement-plan' });
const WAITING = claudeEntry('waiting', 'blocked', { phase: 'implement-plan' });
const FAILED = claudeEntry('failed', 'ended_without_flag', { phase: 'implement-plan' });
const review = (state, reason) => claudeEntry('none', null, { review: { state, reason } });

const seed = ({ data }, sessions) => {
  Object.assign(data.claude.tickets, sessions);
  data.claude.activeSprint.keys = Object.keys(sessions);
};

// `permission` is what Notification.permission starts as, `answer` what requestPermission resolves to,
// `hidden` whether the page starts hidden, `on` whether the stored preference starts on.
async function stubBrowser(
  page,
  { permission = 'granted', answer = 'granted', hidden = true, on = true } = {},
) {
  await page.addInitScript(
    ({ permission, answer, hidden, on, key }) => {
      // Seeded once per tab, so a reload keeps what the page itself stored.
      if (!sessionStorage.getItem('__seeded')) {
        if (on) localStorage.setItem(key, '1');
        else localStorage.removeItem(key);
        sessionStorage.setItem('__seeded', '1');
      }
      window.__notes = [];
      window.__asked = 0;
      window.__focused = 0;
      window.__hidden = hidden;
      // The browser remembers a permission across a reload; the tab's sessionStorage stands in for that.
      let current = sessionStorage.getItem('__permission') ?? permission;
      class FakeNotification {
        static get permission() {
          return current;
        }
        static requestPermission() {
          window.__asked += 1;
          current = answer;
          sessionStorage.setItem('__permission', answer);
          return Promise.resolve(answer);
        }
        constructor(title, options = {}) {
          this.title = title;
          window.__notes.push({ title, body: options.body, tag: options.tag, instance: this });
        }
        close() {}
      }
      window.Notification = FakeNotification;
      window.focus = () => {
        window.__focused += 1;
      };
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__hidden });
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => (window.__hidden ? 'hidden' : 'visible'),
      });
      // The user changes the browser's choice (in its settings) and comes back to the tab.
      window.__setPermission = (value) => {
        current = value;
        sessionStorage.setItem('__permission', value);
        window.dispatchEvent(new Event('focus'));
      };
      window.__setHidden = (value) => {
        window.__hidden = value;
        document.dispatchEvent(new Event('visibilitychange'));
      };
    },
    { permission, answer, hidden, on, key: STORAGE_KEY },
  );
}
const notes = (page) =>
  page.evaluate(() => window.__notes.map(({ title, body, tag }) => ({ title, body, tag })));
const barReads = (dashboard) =>
  dashboard.requests.filter(({ path }) => path === '/api/claude/tickets?surface=bot-bar').length;

test('a session already waiting when the page loads is not news, a later transition notifies once', async ({
  page,
  dashboard,
}) => {
  await stubBrowser(page);
  await page.clock.install();
  seed(dashboard, { 'TAP-1': WAITING, 'TAP-2': WORKING });
  await page.goto('/#/home');
  await expect(page.getByTestId('bot-bar-bot-TAP-2-implement')).toBeVisible();
  expect(await notes(page)).toEqual([]);
  dashboard.data.claude.tickets['TAP-2'] = WAITING;
  await page.clock.runFor(POLL);
  await expect.poll(() => notes(page)).toHaveLength(1);
  const [note] = await notes(page);
  expect(note.body).toBe('TAP-2 · Needs you');
  expect(note.tag).toBe('TAP-2:implement');
  // The same state on the next poll is not news.
  await page.clock.runFor(POLL);
  expect(await notes(page)).toHaveLength(1);
});

test('a failure notifies, working and done never do, and a visible page is not told', async ({
  page,
  dashboard,
}) => {
  await stubBrowser(page);
  await page.clock.install();
  seed(dashboard, {
    'TAP-1': WORKING,
    'TAP-2': WORKING,
    'TAP-3': review('working', 'running'),
  });
  await page.goto('/#/home');
  await expect(page.getByTestId('bot-bar-bot-TAP-1-implement')).toBeVisible();
  dashboard.data.claude.tickets['TAP-1'] = FAILED;
  dashboard.data.claude.tickets['TAP-2'] = claudeEntry('done', 'implemented', {
    phase: 'implement-plan',
  });
  await page.clock.runFor(POLL);
  await expect.poll(() => notes(page)).toHaveLength(1);
  expect((await notes(page))[0].body).toBe('TAP-1 · Failed');
  // Visible: the in-page bubble is enough.
  await page.evaluate(() => window.__setHidden(false));
  dashboard.data.claude.tickets['TAP-3'] = review('waiting', 'blocked');
  await page.clock.runFor(POLL);
  await expect(page.getByTestId('bot-bar-callout-TAP-3-review')).toBeVisible();
  expect(await notes(page)).toHaveLength(1);
});

test('at most three notifications for one poll, and the text never carries anything but key and word', async ({
  page,
  dashboard,
}) => {
  await stubBrowser(page);
  await page.clock.install();
  const keys = ['TAP-1', 'TAP-2', 'TAP-3', 'TAP-4', 'TAP-5'];
  seed(dashboard, Object.fromEntries(keys.map((key) => [key, WORKING])));
  await page.goto('/#/home');
  await expect(page.getByTestId('bot-bar-bot-TAP-5-implement')).toBeVisible();
  for (const key of keys) dashboard.data.claude.tickets[key] = WAITING;
  await page.clock.runFor(POLL);
  await expect.poll(() => notes(page)).toHaveLength(3);
  expect((await notes(page)).map(({ body }) => body)).toEqual([
    'TAP-3 · Needs you',
    'TAP-4 · Needs you',
    'TAP-5 · Needs you',
  ]);
});

test('off or not permitted: nothing is created, and nothing is asked on load', async ({
  page,
  dashboard,
}) => {
  await stubBrowser(page, { on: false });
  await page.clock.install();
  seed(dashboard, { 'TAP-1': WORKING });
  await page.goto('/#/home');
  await expect(page.getByTestId('bot-bar-bot-TAP-1-implement')).toBeVisible();
  dashboard.data.claude.tickets['TAP-1'] = WAITING;
  await page.clock.runFor(POLL);
  await page.evaluate(() => window.__setHidden(false));
  await expect(page.getByTestId('bot-bar-callout-TAP-1-implement')).toBeVisible();
  expect(await notes(page)).toEqual([]);
  expect(await page.evaluate(() => window.__asked)).toBe(0);
});

test('enabling asks permission from the click, persists when granted and says so when blocked', async ({
  page,
  dashboard,
}) => {
  await stubBrowser(page, { permission: 'default', answer: 'granted', hidden: false, on: false });
  seed(dashboard, { 'TAP-1': WORKING });
  await page.goto('/#/home');
  await page.getByTestId('sessions-tab').click();
  const toggle = page.getByTestId('sessions-notify');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => window.__asked)).toBe(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.__asked)).toBe(1);
  await page.reload();
  await page.getByTestId('sessions-tab').click();
  await expect(page.getByTestId('sessions-notify')).toHaveAttribute('aria-pressed', 'true');
  // Pressed again: off, and the choice goes with it.
  await page.getByTestId('sessions-notify').click();
  await expect(page.getByTestId('sessions-notify')).toHaveAttribute('aria-pressed', 'false');
  await page.reload();
  await page.getByTestId('sessions-tab').click();
  await expect(page.getByTestId('sessions-notify')).toHaveAttribute('aria-pressed', 'false');
});

test('enabling when the browser says no stays off and says it is blocked', async ({
  page,
  dashboard,
}) => {
  await stubBrowser(page, { permission: 'default', answer: 'denied', hidden: false, on: false });
  seed(dashboard, { 'TAP-1': WORKING });
  await page.goto('/#/home');
  await page.getByTestId('sessions-tab').click();
  const toggle = page.getByTestId('sessions-notify');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('sessions-notify-note')).toContainText('blocked in the browser');
  await page.reload();
  await page.getByTestId('sessions-tab').click();
  await expect(page.getByTestId('sessions-notify-note')).toContainText('blocked in the browser');
});

test('a browser without notifications has no toggle', async ({ page, dashboard }) => {
  await page.addInitScript(() => {
    delete window.Notification;
  });
  seed(dashboard, { 'TAP-1': WORKING });
  await page.goto('/#/home');
  await page.getByTestId('sessions-tab').click();
  await expect(page.getByTestId('sessions-drawer')).toBeVisible();
  await expect(page.getByTestId('sessions-notify')).toHaveCount(0);
});

test('hidden polling: the bar polls a hidden page only when notifications are on and granted', async ({
  page,
  dashboard,
}) => {
  await stubBrowser(page, { on: false });
  await page.clock.install();
  seed(dashboard, { 'TAP-1': WORKING });
  await page.goto('/#/home');
  await expect(page.getByTestId('bot-bar-bot-TAP-1-implement')).toBeVisible();
  const before = barReads(dashboard);
  await page.clock.runFor(40_000);
  expect(barReads(dashboard), 'off: a hidden page is not polled').toBe(before);

  // On and granted: one read per 15 s tick.
  const on = await page.context().newPage();
  await stubBrowser(on, { on: true });
  await on.clock.install();
  await on.goto('/#/home');
  await expect(on.getByTestId('bot-bar-bot-TAP-1-implement')).toBeVisible();
  const first = barReads(dashboard);
  // A tick at a time, each read answered before the next (a tick skips while a read is in flight).
  await on.clock.runFor(POLL);
  await expect.poll(() => barReads(dashboard)).toBe(first + 1);
  await on.clock.runFor(POLL);
  await expect.poll(() => barReads(dashboard)).toBe(first + 2);
  // Showing the page reads at once; hiding it does not read by itself.
  await on.evaluate(() => window.__setHidden(false));
  await expect.poll(() => barReads(dashboard)).toBe(first + 3);
  await on.evaluate(() => window.__setHidden(true));
  expect(barReads(dashboard)).toBe(first + 3);
});

test('hidden polling: granted but switched off, or switched on but blocked, does not poll', async ({
  page,
  dashboard,
}) => {
  await stubBrowser(page, { on: true, permission: 'denied' });
  await page.clock.install();
  seed(dashboard, { 'TAP-1': WORKING });
  await page.goto('/#/home');
  await expect(page.getByTestId('bot-bar-bot-TAP-1-implement')).toBeVisible();
  const before = barReads(dashboard);
  await page.clock.runFor(40_000);
  expect(barReads(dashboard)).toBe(before);
});

test('title count: while hidden and on it reads (N) before the title, and the title returns when shown', async ({
  page,
  dashboard,
}) => {
  await stubBrowser(page);
  await page.clock.install();
  seed(dashboard, { 'TAP-1': WORKING, 'TAP-2': WORKING, 'TAP-3': WORKING });
  await page.goto('/#/home');
  await expect(page.getByTestId('bot-bar-bot-TAP-3-implement')).toBeVisible();
  const base = await page.title();
  expect(base).not.toMatch(/^\(/);
  dashboard.data.claude.tickets['TAP-1'] = WAITING;
  dashboard.data.claude.tickets['TAP-2'] = FAILED;
  dashboard.data.claude.tickets['TAP-3'] = claudeEntry('done', 'implemented', {
    phase: 'implement-plan',
  });
  await page.clock.runFor(POLL);
  await expect(page).toHaveTitle(`(2) ${base}`);
  await page.evaluate(() => window.__setHidden(false));
  await expect(page).toHaveTitle(base);
  await page.evaluate(() => window.__setHidden(true));
  await expect(page).toHaveTitle(`(2) ${base}`);
});

test('title count: a screen change while hidden keeps the count and the new screen title', async ({
  page,
  dashboard,
}) => {
  await stubBrowser(page);
  seed(dashboard, { 'TAP-1': WAITING });
  await page.goto('/#/home');
  await expect(page).toHaveTitle(/^\(1\) Home/);
  await page.evaluate(() => {
    window.location.hash = '#/slack';
  });
  await expect(page).toHaveTitle(/^\(1\) Slack/);
  await page.evaluate(() => window.__setHidden(false));
  await expect(page).toHaveTitle(/^Slack/);
  await expect(page).not.toHaveTitle(/^\(/);
});

test('title count: nothing while the page is visible or notifications are off', async ({
  page,
  dashboard,
}) => {
  await stubBrowser(page, { hidden: false });
  seed(dashboard, { 'TAP-1': WAITING });
  await page.goto('/#/home');
  await expect(page.getByTestId('bot-bar-bot-TAP-1-implement')).toBeVisible();
  const base = await page.title();
  expect(base).not.toMatch(/^\(/);
  const off = await page.context().newPage();
  await stubBrowser(off, { on: false, hidden: true });
  await off.goto('/#/home');
  await expect(off.getByTestId('bot-bar-bot-TAP-1-implement')).toBeVisible();
  expect(await off.title()).not.toMatch(/^\(/);
});

test('permission revoked while the dashboard is open: the hidden poll and the notifications stop', async ({
  page,
  dashboard,
}) => {
  await stubBrowser(page);
  await page.clock.install();
  seed(dashboard, { 'TAP-1': WORKING });
  await page.goto('/#/home');
  await expect(page.getByTestId('bot-bar-bot-TAP-1-implement')).toBeVisible();
  const before = barReads(dashboard);
  await page.clock.runFor(POLL);
  await expect.poll(() => barReads(dashboard)).toBe(before + 1);
  await page.evaluate(() => window.__setPermission('denied'));
  // Changing the hidden-poll flag re-subscribes the poll, which reads once; let that one land.
  await page.waitForTimeout(500);
  const after = barReads(dashboard);
  dashboard.data.claude.tickets['TAP-1'] = WAITING;
  await page.clock.runFor(40_000);
  // A read the ticks started would be recorded within a moment; give it that moment.
  await page.waitForTimeout(500);
  expect(barReads(dashboard), 'revoked: a hidden page is not polled').toBe(after);
  expect(await notes(page)).toEqual([]);
  // Granted again in the browser's settings: polling and notifying resume.
  await page.evaluate(() => window.__setPermission('granted'));
  // Flipping the hidden-poll flag back re-subscribes the poll, which reads once at once. Let that one
  // land first: whether React has run the effect before or after the clock steps is not ours to
  // order, and a tick of the old (hidden-skipping) timer reads nothing.
  await expect.poll(() => barReads(dashboard)).toBe(after + 1);
  await page.clock.runFor(POLL);
  await expect.poll(() => barReads(dashboard)).toBe(after + 2);
});

test('click opens: a notification click focuses the window and opens that ticket in the Claude dialog', async ({
  page,
  dashboard,
}) => {
  await stubBrowser(page);
  await page.clock.install();
  seed(dashboard, { 'TAP-2': WORKING });
  await page.goto('/#/home');
  await expect(page.getByTestId('bot-bar-bot-TAP-2-implement')).toBeVisible();
  dashboard.data.claude.tickets['TAP-2'] = WAITING;
  await page.clock.runFor(POLL);
  await expect.poll(() => notes(page)).toHaveLength(1);
  await page.evaluate(() => window.__notes[0].instance.onclick(new Event('click')));
  await expect(page.getByTestId('claude-dialog')).toBeVisible();
  await expect(page.getByTestId('claude-dialog')).toContainText('TAP-2');
  expect(await page.evaluate(() => window.__focused)).toBe(1);
});
