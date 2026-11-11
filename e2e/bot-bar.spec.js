import { test, expect } from './fixtures.js';
import { claudeEntry, settingsData } from './data.js';
import { roamFor, walkStretch } from '../ui/bot-bar.js';

// The bot bar: one mascot per implement or review Claude session of a ticket in the active Jira
// sprint, on every screen, polling /api/claude/tickets itself and asking /api/active-sprint-tickets
// which of its tickets are in an active sprint. Invented tickets only.
//   BOT-1  implement session working      -> "BOT-1 implement: working"
//   BOT-2  review session waiting         -> "BOT-2 review: idle"
//   BOT-3  review session done            -> "BOT-3 review: done"
//   BOT-4  implement session failed       -> "BOT-4 implement: failed"
//   BOT-5  investigate working, groom working, a review that never started: no bot
//   BOT-6  implement session unknown: no bot
//   BOT-7  review working and BOT-8 implement done, but in no active sprint: no bot
//   The active sprint holds BOT-1 to BOT-6.
const SESSIONS = {
  'BOT-1': claudeEntry('working', 'running', { phase: 'implement-plan' }),
  'BOT-2': claudeEntry('none', null, {
    review: { state: 'waiting', reason: 'blocked' },
  }),
  'BOT-3': claudeEntry('none', null, {
    review: { state: 'done', reason: 'finished' },
  }),
  'BOT-4': claudeEntry('failed', 'ended_without_flag', { phase: 'implement-plan' }),
  'BOT-5': claudeEntry('working', 'running', {
    groom: { state: 'working', reason: 'running' },
  }),
  'BOT-6': claudeEntry('unknown', 'listing_unavailable', { phase: 'implement-plan' }),
  'BOT-7': claudeEntry('none', null, { review: { state: 'working', reason: 'running' } }),
  'BOT-8': claudeEntry('done', 'implemented', { phase: 'implement-plan' }),
};
const IN_SPRINT = ['BOT-1', 'BOT-2', 'BOT-3', 'BOT-4', 'BOT-5', 'BOT-6'];
const SPRINT_POLL_MS = 5 * 60 * 1000;
// The sessions and the active sprint the mocked dashboard reports.
const seed = ({ data }, { sessions = SESSIONS, sprint = IN_SPRINT } = {}) => {
  Object.assign(data.claude.tickets, sessions);
  data.claude.activeSprint.keys = [...sprint];
};
const NAMES = [
  'BOT-1 implement: working',
  'BOT-2 review: idle',
  'BOT-3 review: done',
  'BOT-4 implement: failed',
];
const bots = (page) => page.getByTestId('bot-bar').getByRole('button', { name: /^BOT-\d+ / });

test('the bot bar shows one bot per implement or review session on every screen', async ({
  page,
  dashboard,
}) => {
  seed(dashboard);
  await page.goto('/#/home');
  const names = async () =>
    (await bots(page).evaluateAll((all) => all.map((el) => el.getAttribute('aria-label')))).sort();
  await expect.poll(names).toEqual([...NAMES].sort());
  for (const route of ['services', 'prs', 'my-tickets']) {
    await page.goto(`/#/${route}`);
    await expect.poll(names).toEqual([...NAMES].sort());
  }
  // An overlay: it never scrolls the page sideways and takes no room.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const bar = await page.getByTestId('bot-bar').boundingBox();
  expect(bar.y + bar.height).toBeCloseTo(900, 0);
  // Its reads say who asked, so the boards' own reads stay countable.
  expect(
    dashboard.requests.some(({ path }) => path === '/api/claude/tickets?surface=bot-bar'),
  ).toBe(true);
});

test('a bot opens the Claude dialog of its session, and a finished one can be dismissed', async ({
  page,
  dashboard,
}) => {
  // Still poses: a walking bot is a moving target, which Playwright will not click.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  seed(dashboard);
  await page.goto('/#/services');
  await expect(bots(page)).toHaveCount(4);
  await page.getByRole('button', { name: 'BOT-2 review: idle' }).click();
  await expect(page.getByTestId('prs-claude-dialog')).toBeVisible();
  await expect(page.getByTestId('prs-claude-dialog-title')).toContainText('BOT-2');
  await page.getByTestId('prs-claude-dialog-close').click();
  await page.getByRole('button', { name: 'BOT-1 implement: working' }).click();
  await expect(page.getByTestId('claude-dialog')).toBeVisible();
  await page.getByTestId('claude-dialog-close').click();
  // A working bot has no dismiss control; a done and a failed one do.
  await expect(page.getByTestId('bot-bar-dismiss-BOT-1-implement')).toHaveCount(0);
  await page.getByRole('button', { name: 'Dismiss BOT-3 review: done' }).click();
  await expect(bots(page)).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'BOT-3 review: done' })).toHaveCount(0);
});

test('an e2e bot opens the Claude dialog on the E2E row, and a finished one can be dismissed', async ({
  page,
  dashboard,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  seed(dashboard, {
    sessions: {
      'BOT-9': claudeEntry('none', null, { e2e: { state: 'working', reason: 'running' } }),
      'BOT-10': claudeEntry('none', null, { e2e: { state: 'done', reason: 'finished' } }),
    },
    sprint: ['BOT-9', 'BOT-10'],
  });
  await page.goto('/#/services');
  await expect(bots(page)).toHaveCount(2);
  await expect(page.getByTestId('bot-bar-bot-BOT-9-e2e')).toHaveAccessibleName(
    'BOT-9 e2e: working',
  );
  await page.getByTestId('bot-bar-bot-BOT-9-e2e').click();
  const dialog = page.getByTestId('claude-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('claude-dialog-title')).toContainText('BOT-9');
  // The E2E row is where this session lives: its own session is running, so it is held.
  await expect(dialog.getByTestId('claude-action-e2e')).toBeDisabled();
  await page.getByTestId('claude-dialog-close').click();
  // A working bot has no dismiss control; a done one does.
  await expect(page.getByTestId('bot-bar-dismiss-BOT-9-e2e')).toHaveCount(0);
  await page.getByTestId('bot-bar-dismiss-BOT-10-e2e').click();
  await expect(bots(page)).toHaveCount(1);
  await expect(page.getByTestId('bot-bar-bot-BOT-10-e2e')).toHaveCount(0);
});

test('the bar is absent when no session qualifies, and a session appears on the next poll', async ({
  page,
  dashboard,
}) => {
  await page.clock.install();
  seed(dashboard, { sessions: { 'BOT-5': SESSIONS['BOT-5'], 'BOT-6': SESSIONS['BOT-6'] } });
  await page.goto('/#/home');
  await expect
    .poll(() => dashboard.requests.some(({ path }) => path.includes('surface=bot-bar')))
    .toBe(true);
  await expect(page.getByTestId('bot-bar')).toHaveCount(0);
  dashboard.data.claude.tickets['BOT-1'] = SESSIONS['BOT-1'];
  await page.clock.runFor(16_000);
  await expect(bots(page)).toHaveCount(1);
});

test('only tickets in the active sprint get a bot, whatever their session', async ({
  page,
  dashboard,
}) => {
  seed(dashboard);
  await page.goto('/#/home');
  await expect(bots(page)).toHaveCount(4);
  // BOT-7 (review working) and BOT-8 (implement done) qualify by phase and state, but their ticket
  // is in no active sprint: no bot, though the bar asked about them.
  for (const key of ['BOT-7', 'BOT-8'])
    await expect(
      page.getByTestId('bot-bar').getByRole('button', { name: new RegExp(key) }),
    ).toHaveCount(0);
  expect(dashboard.data.claude.activeSprint.asks.at(-1)).toEqual([
    'BOT-1',
    'BOT-2',
    'BOT-3',
    'BOT-4',
    'BOT-7',
    'BOT-8',
  ]);
});

test('no bot shows until the sprint is known, and none for a ticket outside it', async ({
  page,
  dashboard,
}) => {
  seed(dashboard);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/api/active-sprint-tickets*', async (route) => {
    await gate;
    await route.fallback();
  });
  await page.goto('/#/home');
  await expect
    .poll(() =>
      dashboard.requests.some(({ path }) => path.startsWith('/api/claude/tickets?surface=bot-bar')),
    )
    .toBe(true);
  await page.waitForTimeout(500);
  await expect(page.getByTestId('bot-bar')).toHaveCount(0);
  release();
  await expect(bots(page)).toHaveCount(4);
});

test('the bar follows the sprint: a ticket joining or leaving it brings or removes its bot', async ({
  page,
  dashboard,
}) => {
  await page.clock.install();
  seed(dashboard, { sprint: ['BOT-1'] });
  await page.goto('/#/home');
  await expect(bots(page)).toHaveCount(1);
  dashboard.data.claude.activeSprint.keys = ['BOT-1', 'BOT-2', 'BOT-3'];
  await page.clock.runFor(SPRINT_POLL_MS + 1_000);
  await expect(bots(page)).toHaveCount(3);
  dashboard.data.claude.activeSprint.keys = [];
  await page.clock.runFor(SPRINT_POLL_MS + 1_000);
  await expect(page.getByTestId('bot-bar')).toHaveCount(0);
});

test('a ticket the bar has not placed yet is asked about at once, not after five minutes', async ({
  page,
  dashboard,
}) => {
  await page.clock.install();
  seed(dashboard, { sessions: { 'BOT-1': SESSIONS['BOT-1'] } });
  await page.goto('/#/home');
  await expect(bots(page)).toHaveCount(1);
  dashboard.data.claude.tickets['BOT-2'] = SESSIONS['BOT-2'];
  await page.clock.runFor(16_000);
  await expect(bots(page)).toHaveCount(2);
});

test('when Jira cannot say, a ticket with no known sprint gets no bot and the last good set is kept', async ({
  page,
  dashboard,
}) => {
  await page.clock.install();
  const sprint = dashboard.data.claude.activeSprint;
  seed(dashboard);
  sprint.available = false;
  await page.goto('/#/home');
  await expect.poll(() => sprint.asks.length).toBeGreaterThan(0);
  await expect(page.getByTestId('bot-bar')).toHaveCount(0);
  sprint.available = true;
  await page.clock.runFor(SPRINT_POLL_MS + 1_000);
  await expect(bots(page)).toHaveCount(4);
  // Jira goes away again, and the sprint changes meanwhile: the last good set stays.
  sprint.available = false;
  sprint.keys = [];
  await page.clock.runFor(SPRINT_POLL_MS + 1_000);
  await expect(bots(page)).toHaveCount(4);
  // A new session's ticket cannot be placed while Jira is away: no bot for it.
  dashboard.data.claude.tickets['BOT-9'] = claudeEntry('working', 'running', {
    phase: 'implement-plan',
  });
  await page.clock.runFor(16_000);
  await expect(bots(page)).toHaveCount(4);
  await expect(page.getByRole('button', { name: /BOT-9/ })).toHaveCount(0);
});

test('a done bot fades and leaves after ten minutes', async ({ page, dashboard }) => {
  await page.clock.install();
  seed(dashboard, { sessions: { 'BOT-3': SESSIONS['BOT-3'] } });
  await page.goto('/#/home');
  await expect(bots(page)).toHaveCount(1);
  await page.clock.runFor(10 * 60 * 1000 - 21_000);
  await expect(page.locator('.bot-bar-lane[data-fading="true"]')).toHaveCount(0);
  await page.clock.runFor(2_000);
  await expect(page.locator('.bot-bar-lane[data-fading="true"]')).toHaveCount(1);
  await page.clock.runFor(20_000);
  await expect(page.getByTestId('bot-bar')).toHaveCount(0);
});

test('setup-only mode has no bot bar', async ({ page, dashboard }) => {
  Object.assign(dashboard.data, settingsData('fresh'));
  seed(dashboard);
  await page.goto('/#/settings');
  await expect(page.getByTestId('main-nav')).toBeVisible();
  await expect(page.getByTestId('bot-bar')).toHaveCount(0);
});

test('working bots walk, resting bots stand still, and reduced motion stops every walk', async ({
  page,
  dashboard,
}) => {
  seed(dashboard);
  await page.goto('/#/home');
  const working = page.getByTestId('bot-bar-bot-BOT-1-implement');
  const failed = page.getByTestId('bot-bar-bot-BOT-4-implement');
  await expect(working).toBeVisible();
  const x = async (locator) => (await locator.boundingBox()).x;
  const before = { working: await x(working), failed: await x(failed) };
  await expect.poll(() => x(working)).not.toBe(before.working);
  expect(await x(failed)).toBe(before.failed);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const still = await x(working);
  await page.waitForTimeout(400);
  expect(await x(working)).toBe(still);
  // Every still pose is inside the viewport, and no two bots stand on top of each other.
  const boxes = await bots(page).evaluateAll((all) =>
    all.map((el) => el.getBoundingClientRect()).sort((a, b) => a.x - b.x),
  );
  for (const [i, box] of boxes.entries()) {
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(1440);
    if (i) expect(box.x - boxes[i - 1].right).toBeGreaterThanOrEqual(-1);
  }
});

// The done stroll's own keyframes (bot-bar.css): rests at 0-8 %, 30-38 % (halfway), 60-68 % (far end)
// and 90-100 % (home); walks between. Animations are held at a fraction of their cycle by script, so
// the checks do not depend on real time.
const strollAt = (page, key, fraction) =>
  page.evaluate(
    ({ key, fraction }) => {
      const lane = document
        .querySelector(`[data-testid="bot-bar-bot-${key}"]`)
        .closest('.bot-bar-lane');
      const face = lane.querySelector('.bot-bar-face');
      const hold = (element, name) => {
        const animation = element.getAnimations().find((a) => a.animationName === name);
        animation.pause();
        const { duration } = animation.effect.getComputedTiming();
        // Drop the (negative) delay so the current time is the place in the cycle itself; a
        // negative current time would be clamped to zero.
        animation.effect.updateTiming({ delay: 0 });
        animation.currentTime = duration * fraction;
      };
      hold(lane, 'bot-bar-stroll');
      hold(face, 'bot-bar-stroll-turn');
      const bot = lane.querySelector('.bot-bar-bot').getBoundingClientRect();
      const dismiss = lane.querySelector('.bot-bar-dismiss').getBoundingClientRect();
      return {
        x: bot.x,
        gap: dismiss.x - bot.x,
        flipped: getComputedStyle(face).transform.startsWith('matrix(-1'),
      };
    },
    { key, fraction },
  );

test('a done bot strolls with rests at each end and halfway, turning at the ends; a failed bot stands', async ({
  page,
  dashboard,
}) => {
  seed(dashboard);
  await page.goto('/#/home');
  await expect(page.getByTestId('bot-bar-bot-BOT-3-review')).toBeVisible();
  const at = (fraction) => strollAt(page, 'BOT-3-review', fraction);
  const home = await at(0.04);
  const out = await at(0.2);
  const halfA = await at(0.31);
  const halfB = await at(0.37);
  const far = await at(0.64);
  const back = await at(0.8);
  const homeAgain = await at(0.95);
  expect(out.x).toBeGreaterThan(home.x + 5);
  expect(halfA.x).toBeCloseTo(halfB.x, 0);
  expect(halfA.x).toBeGreaterThan(out.x - 1);
  expect(far.x).toBeGreaterThan(halfB.x + 5);
  expect(back.x).toBeLessThan(far.x - 5);
  expect(homeAgain.x).toBeCloseTo(home.x, 0);
  expect([home.flipped, out.flipped, far.flipped, back.flipped, homeAgain.flipped]).toEqual([
    false,
    false,
    true,
    true,
    false,
  ]);
  // The dismiss button stays on its bot all the way.
  for (const spot of [out, halfA, far, back]) expect(spot.gap).toBeCloseTo(home.gap, 0);
  // A done bot's stroll is the stretch of the done zone that its key says, nowhere else.
  const stretch = walkStretch(roamFor('BOT-3:review'), 'done', 1440);
  expect(Math.abs(home.x - stretch.min)).toBeLessThan(1.5);
  expect(Math.abs(far.x - stretch.max)).toBeLessThan(1.5);
  // A failed bot has no walk at all.
  const failed = page.getByTestId('bot-bar-bot-BOT-4-implement');
  expect(await failed.evaluate((el) => el.closest('.bot-bar-lane').getAnimations().length)).toBe(0);
  const standing = (await failed.boundingBox()).x;
  await page.waitForTimeout(300);
  expect((await failed.boundingBox()).x).toBe(standing);
});

test('a strolling done bot is paused by the pointer and walks on when it leaves', async ({
  page,
  dashboard,
}) => {
  seed(dashboard, { sessions: { 'BOT-3': SESSIONS['BOT-3'] } });
  await page.goto('/#/home');
  const bot = page.getByTestId('bot-bar-bot-BOT-3-review');
  await expect(bot).toBeVisible();
  const state = () =>
    bot.evaluate(
      (el) =>
        el
          .closest('.bot-bar-lane')
          .getAnimations()
          .find((a) => a.animationName === 'bot-bar-stroll').playState,
    );
  expect(await state()).toBe('running');
  const box = await bot.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(state).toBe('paused');
  await page.mouse.move(5, 5);
  await expect.poll(state).toBe('running');
  // Keyboard focus pauses it too.
  await bot.focus();
  await expect.poll(state).toBe('paused');
});

// Hover detail and callouts.
const WORKING_IMPLEMENT = claudeEntry('working', 'running', { phase: 'implement-plan' });
const DONE_IMPLEMENT = claudeEntry('done', 'implemented', { phase: 'implement-plan' });
const review = (state, reason) => claudeEntry('none', null, { review: { state, reason } });
const POLL = 16_000;
const callout = (page, key) => page.getByTestId(`bot-bar-callout-${key}`);
const live = (page) => page.getByTestId('bot-bar-live').locator('> *');

test('the hover detail is the app popup, on pointer and on keyboard focus, never a native title', async ({
  page,
  dashboard,
}) => {
  seed(dashboard);
  await page.goto('/#/home');
  const bar = page.getByTestId('bot-bar');
  await expect(bots(page)).toHaveCount(4);
  // Nothing in the bar carries a native tooltip: no title attribute, no SVG <title>, no data-tooltip.
  await expect(bar.locator('[title]')).toHaveCount(0);
  await expect(bar.locator('svg title')).toHaveCount(0);
  await expect(bar.locator('[data-tooltip]')).toHaveCount(0);
  // A bot that is walking: the pointer finds it, it stops, and the popup names it.
  const walker = page.getByTestId('bot-bar-bot-BOT-1-implement');
  const box = await walker.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByRole('tooltip')).toHaveText('BOT-1 implement: working');
  await page.mouse.move(5, 5);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  // Keyboard focus shows it too (and the name of the button stays its own label).
  await page.keyboard.press('Tab');
  await walker.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(walker).toBeFocused();
  await expect(page.getByRole('tooltip')).toHaveText('BOT-1 implement: working');
  await expect(walker).toHaveAccessibleName('BOT-1 implement: working');
  await expect(walker).not.toHaveAttribute('title', /.*/);
});

test('a callout says what just happened, never on first load, and goes by itself when it is working or done', async ({
  page,
  dashboard,
}) => {
  await page.clock.install();
  seed(dashboard, { sessions: { 'BOT-1': WORKING_IMPLEMENT } });
  await page.goto('/#/home');
  await expect(bots(page)).toHaveCount(1);
  await expect(page.locator('[data-testid^="bot-bar-callout-"]')).toHaveCount(0);
  await expect(live(page)).toHaveCount(0);
  dashboard.data.claude.tickets['BOT-1'] = DONE_IMPLEMENT;
  await page.clock.runFor(POLL);
  const bubble = callout(page, 'BOT-1-implement');
  await expect(bubble).toHaveText('BOT-1 · Done ✓');
  await expect(bubble).toHaveAttribute('aria-hidden', 'true');
  // It rides with the lane, outside the mirrored face, and never takes the pointer.
  expect(await bubble.evaluate((el) => Boolean(el.closest('.bot-bar-face')))).toBe(false);
  expect(await bubble.evaluate((el) => el.closest('.bot-bar-lane') !== null)).toBe(true);
  expect(await bubble.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
  // One message per change in the one polite status region.
  await expect(page.getByTestId('bot-bar-live')).toHaveAttribute('aria-live', 'polite');
  await expect(live(page)).toHaveText(['BOT-1 implement: done']);
  // It stays inside the viewport and over its bot.
  const bubbleBox = await bubble.boundingBox();
  expect(bubbleBox.x).toBeGreaterThanOrEqual(0);
  expect(bubbleBox.x + bubbleBox.width).toBeLessThanOrEqual(1440);
  await page.clock.runFor(6_000 + 400);
  await expect(bubble).toHaveCount(0);
  // The announcement is not repeated when nothing changes.
  await page.clock.runFor(POLL);
  await expect(live(page)).toHaveCount(1);
});

test('a waiting or failed callout stays until the bot is attended to; the live region has one message per change', async ({
  page,
  dashboard,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  seed(dashboard, {
    sessions: { 'BOT-1': WORKING_IMPLEMENT, 'BOT-2': review('working', 'running') },
  });
  await page.goto('/#/home');
  await expect(bots(page)).toHaveCount(2);
  dashboard.data.claude.tickets['BOT-2'] = review('waiting', 'blocked');
  dashboard.data.claude.tickets['BOT-1'] = claudeEntry('failed', 'ended_without_flag', {
    phase: 'implement-plan',
  });
  await page.clock.runFor(POLL);
  await expect(callout(page, 'BOT-2-review')).toHaveText('BOT-2 · Needs you');
  await expect(callout(page, 'BOT-1-implement')).toHaveText('BOT-1 · Failed');
  await expect(live(page)).toHaveText(['BOT-1 implement: failed', 'BOT-2 review: idle']);
  // Reduced motion: the bubble still shows, and only fades.
  expect(
    await callout(page, 'BOT-2-review')
      .locator('.bot-bar-callout-bubble')
      .evaluate((el) => getComputedStyle(el).animationName),
  ).toBe('bot-bar-callout-fade-in');
  await page.clock.runFor(120_000);
  await expect(callout(page, 'BOT-2-review')).toBeVisible();
  await expect(callout(page, 'BOT-1-implement')).toBeVisible();
  // Hovering one bot sends its bubble away; the other stays.
  await page.getByTestId('bot-bar-bot-BOT-2-review').hover();
  await page.clock.runFor(500);
  await expect(callout(page, 'BOT-2-review')).toHaveCount(0);
  await expect(callout(page, 'BOT-1-implement')).toBeVisible();
  // Another change of the same bot replaces its bubble: one per bot.
  dashboard.data.claude.tickets['BOT-1'] = DONE_IMPLEMENT;
  await page.clock.runFor(POLL);
  await expect(callout(page, 'BOT-1-implement')).toHaveText('BOT-1 · Done ✓');
  await expect(page.locator('[data-testid^="bot-bar-callout-BOT-1"]')).toHaveCount(1);
  await expect(live(page)).toHaveText(['BOT-1 implement: done']);
});

test('at most three callouts show at once, and a session that starts working gets one', async ({
  page,
  dashboard,
}) => {
  await page.clock.install();
  const keys = ['BOT-1', 'BOT-2', 'BOT-3', 'BOT-4', 'BOT-5'];
  const sessions = Object.fromEntries(keys.map((key) => [key, WORKING_IMPLEMENT]));
  seed(dashboard, { sessions, sprint: [...keys, 'BOT-9'] });
  await page.goto('/#/home');
  await expect(bots(page)).toHaveCount(5);
  for (const key of keys)
    dashboard.data.claude.tickets[key] = claudeEntry('failed', 'ended_without_flag', {
      phase: 'implement-plan',
    });
  await page.clock.runFor(POLL);
  await expect(page.locator('[data-testid^="bot-bar-callout-"]')).toHaveCount(3);
  // The oldest go: the last three by key stay.
  await expect(callout(page, 'BOT-1-implement')).toHaveCount(0);
  await expect(callout(page, 'BOT-5-implement')).toBeVisible();
  // A session that was not running and now is (BOT-9 had no entry) says so.
  dashboard.data.claude.tickets['BOT-9'] = WORKING_IMPLEMENT;
  await page.clock.runFor(POLL);
  await expect(callout(page, 'BOT-9-implement')).toHaveText('BOT-9 · Working on it…');
  await expect(page.locator('[data-testid^="bot-bar-callout-"]')).toHaveCount(3);
});

// The zones (1440px wide): done on the left 20 % (0-288), working and idle in the centre 60 %
// (288-1152), failed on the right 20 % (1152-1440). A bot never leaves its own.
const ZONES_PX = { left: [0, 288], center: [288, 1152], right: [1152, 1440] };
const heldBox = (page, key, name, fraction) =>
  page.evaluate(
    ({ key, name, fraction }) => {
      const lane = document
        .querySelector(`[data-testid="bot-bar-bot-${key}"]`)
        .closest('.bot-bar-lane');
      const animation = lane.getAnimations().find((a) => a.animationName === name);
      animation.pause();
      const { duration } = animation.effect.getComputedTiming();
      // Drop the (negative) delay so the current time is the place in the cycle itself.
      animation.effect.updateTiming({ delay: 0 });
      animation.currentTime = duration * fraction;
      const box = lane.querySelector('.bot-bar-bot').getBoundingClientRect();
      return { left: box.left, right: box.right };
    },
    { key, name, fraction },
  );
const inZone = ({ left, right }, zone) => {
  expect(left).toBeGreaterThanOrEqual(ZONES_PX[zone][0] - 1);
  expect(right).toBeLessThanOrEqual(ZONES_PX[zone][1] + 1);
};
const FRACTIONS = [0, 0.1, 0.2, 0.3, 0.37, 0.5, 0.64, 0.8, 0.95];

test('every state stays in its own zone: done left, working and idle centre, failed right', async ({
  page,
  dashboard,
}) => {
  seed(dashboard);
  await page.goto('/#/home');
  await expect(bots(page)).toHaveCount(4);
  for (const fraction of FRACTIONS) {
    inZone(await heldBox(page, 'BOT-3-review', 'bot-bar-stroll', fraction), 'left');
    inZone(await heldBox(page, 'BOT-1-implement', 'bot-bar-patrol', fraction), 'center');
    inZone(await heldBox(page, 'BOT-2-review', 'bot-bar-wander', fraction), 'center');
  }
  // The ends of each walk are what the pure helper says.
  for (const [key, state, name] of [
    ['BOT-1:implement', 'working', 'bot-bar-patrol'],
    ['BOT-2:review', 'waiting', 'bot-bar-wander'],
  ]) {
    const stretch = walkStretch(roamFor(key), state, 1440);
    const [ticket, phase] = key.split(':');
    const far = await heldBox(page, `${ticket}-${phase}`, name, 0.5);
    expect(Math.abs(far.left - stretch.max)).toBeLessThan(1.5);
  }
  // The failed bot stands inside the right zone and does not move.
  const failed = page.getByTestId('bot-bar-bot-BOT-4-implement');
  const standing = await failed.boundingBox();
  inZone({ left: standing.x, right: standing.x + standing.width }, 'right');
  await page.waitForTimeout(300);
  expect((await failed.boundingBox()).x).toBe(standing.x);
});

test('a bot that changes state jumps into its new zone on the next poll', async ({
  page,
  dashboard,
}) => {
  await page.clock.install();
  seed(dashboard, { sessions: { 'BOT-1': WORKING_IMPLEMENT } });
  await page.goto('/#/home');
  const bot = page.getByTestId('bot-bar-bot-BOT-1-implement');
  await expect(bot).toHaveAttribute('data-state', 'working');
  inZone(await heldBox(page, 'BOT-1-implement', 'bot-bar-patrol', 0.5), 'center');
  const change = async (entry, state, name, zone) => {
    dashboard.data.claude.tickets['BOT-1'] = entry;
    await page.clock.runFor(POLL);
    await expect(bot).toHaveAttribute('data-state', state);
    for (const fraction of [0, 0.5, 0.95])
      inZone(await heldBox(page, 'BOT-1-implement', name, fraction), zone);
  };
  await change(DONE_IMPLEMENT, 'done', 'bot-bar-stroll', 'left');
  dashboard.data.claude.tickets['BOT-1'] = claudeEntry('failed', 'ended_without_flag', {
    phase: 'implement-plan',
  });
  await page.clock.runFor(POLL);
  await expect(bot).toHaveAttribute('data-state', 'failed');
  const failed = await bot.boundingBox();
  inZone({ left: failed.x, right: failed.x + failed.width }, 'right');
  await change(WORKING_IMPLEMENT, 'working', 'bot-bar-patrol', 'center');
});

test('with reduced motion every bot stands still inside its own zone', async ({
  page,
  dashboard,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  seed(dashboard, {
    sessions: {
      ...SESSIONS,
      'BOT-9': review('waiting', 'blocked'),
      'BOT-10': review('done', 'finished'),
    },
    sprint: [...IN_SPRINT, 'BOT-9', 'BOT-10'],
  });
  await page.goto('/#/home');
  await expect(bots(page)).toHaveCount(6);
  const at = async (key) => {
    const box = await page.getByTestId(`bot-bar-bot-${key}`).boundingBox();
    return { left: box.x, right: box.x + box.width };
  };
  const before = {};
  for (const [key, zone] of [
    ['BOT-3-review', 'left'],
    ['BOT-10-review', 'left'],
    ['BOT-1-implement', 'center'],
    ['BOT-2-review', 'center'],
    ['BOT-9-review', 'center'],
    ['BOT-4-implement', 'right'],
  ]) {
    before[key] = await at(key);
    inZone(before[key], zone);
  }
  // Working and idle bots in the centre stand apart, and so do the two done bots.
  const centre = ['BOT-1-implement', 'BOT-2-review', 'BOT-9-review'].map((key) => before[key].left);
  centre.sort((a, b) => a - b);
  for (let i = 1; i < centre.length; i += 1) expect(centre[i] - centre[i - 1]).toBeGreaterThan(40);
  expect(Math.abs(before['BOT-3-review'].left - before['BOT-10-review'].left)).toBeGreaterThan(40);
  await page.waitForTimeout(400);
  for (const key of Object.keys(before)) expect(await at(key)).toEqual(before[key]);
});

test('under 600px wide the zones collapse and every state has the whole width', async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ width: 480, height: 800 });
  seed(dashboard);
  await page.goto('/#/home');
  await expect(bots(page)).toHaveCount(4);
  const edge = 40;
  for (const [key, state, name] of [
    ['BOT-1-implement', 'working', 'bot-bar-patrol'],
    ['BOT-2-review', 'waiting', 'bot-bar-wander'],
    ['BOT-3-review', 'done', 'bot-bar-stroll'],
  ]) {
    const stretch = walkStretch(roamFor(key.replace(/-(?=[a-z]+$)/, ':')), state, 480, { edge });
    const far = await heldBox(page, key, name, name === 'bot-bar-stroll' ? 0.64 : 0.5);
    const home = await heldBox(page, key, name, 0);
    expect(Math.abs(far.left - stretch.max)).toBeLessThan(1.5);
    expect(Math.abs(home.left - stretch.min)).toBeLessThan(1.5);
    expect(home.left).toBeGreaterThanOrEqual(edge - 1);
    expect(far.right).toBeLessThanOrEqual(480 - edge + 1);
  }
  const failed = await page.getByTestId('bot-bar-bot-BOT-4-implement').boundingBox();
  expect(failed.x).toBeGreaterThanOrEqual(edge - 1);
  expect(failed.x + failed.width).toBeLessThanOrEqual(480 - edge + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('many bots in one zone overlap, and the one you point at comes to the front with its x reachable', async ({
  page,
  dashboard,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const keys = Array.from({ length: 8 }, (_, i) => `BOT-${20 + i}`);
  const sessions = Object.fromEntries(
    keys.flatMap((key, i) => [[key, i < 4 ? review('done', 'finished') : review('failed', 'x')]]),
  );
  seed(dashboard, { sessions, sprint: keys });
  await page.goto('/#/home');
  await expect(bots(page)).toHaveCount(8);
  const zoneOf = (i) => (i < 4 ? 'left' : 'right');
  for (const [i, key] of keys.entries()) {
    const box = await page.getByTestId(`bot-bar-bot-${key}-review`).boundingBox();
    inZone({ left: box.x, right: box.x + box.width }, zoneOf(i));
  }
  // Pointing at a bot raises it above its neighbours, so its dismiss button takes the click.
  for (const key of ['BOT-23', 'BOT-27']) {
    await page.getByTestId(`bot-bar-bot-${key}-review`).hover();
    const box = await page.getByTestId(`bot-bar-dismiss-${key}-review`).boundingBox();
    const top = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid]')?.dataset.testid,
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    );
    expect(top).toBe(`bot-bar-dismiss-${key}-review`);
  }
  await page.getByTestId('bot-bar-dismiss-BOT-27-review').click();
  await expect(bots(page)).toHaveCount(7);
});

// ---- posters ------------------------------------------------------------------------------------
// Every bot carries a poster with its ticket key above its head (BotPoster.jsx, the registry in
// ui-react/components/posters/index.js, which this runner cannot import: the checks are generic).
const poster = (page, key) => page.getByTestId(`bot-bar-poster-${key}`);
const posters = (page) => page.getByTestId('bot-bar').locator('[data-testid^="bot-bar-poster-"]');
const POSTER_KEYS = [
  ['BOT-1', 'implement', 'working'],
  ['BOT-2', 'review', 'waiting'],
  ['BOT-3', 'review', 'done'],
  ['BOT-4', 'implement', 'failed'],
];

test('every bot carries exactly one poster with its ticket key, the same one after a re-poll', async ({
  page,
  dashboard,
}) => {
  await page.clock.install();
  seed(dashboard);
  await page.goto('/#/home');
  await expect(bots(page)).toHaveCount(4);
  await expect(posters(page)).toHaveCount(4);
  const read = () =>
    posters(page).evaluateAll((all) =>
      all.map((el) => ({
        id: el.dataset.testid.replace('bot-bar-poster-', ''),
        poster: el.dataset.poster,
        text: [...el.querySelectorAll('svg text')].map((node) => node.textContent),
        svgs: el.querySelectorAll('svg').length,
        lane: el.closest('.bot-bar-lane').querySelectorAll('.bot-bar-poster').length,
      })),
    );
  const before = await read();
  for (const { id, poster: kind, text, svgs, lane } of before) {
    expect(text, id).toEqual([id.replace(/-(implement|review)$/, '')]);
    expect(svgs).toBe(1);
    expect(lane, 'one poster per bot').toBe(1);
    expect(kind).toMatch(/^[a-z0-9]+$/);
  }
  // A poll that finds nothing new changes nothing: same posters, same text.
  await page.clock.runFor(POLL);
  await page.clock.runFor(POLL);
  expect(await read()).toEqual(before);
  // It is decorative: hidden from assistive tech, no native tooltip source anywhere in the bar.
  await expect(posters(page).first()).toHaveAttribute('aria-hidden', 'true');
  await expect(posters(page).first().locator('svg')).toHaveAttribute('focusable', 'false');
  await expect(page.getByTestId('bot-bar').locator('[title]')).toHaveCount(0);
  await expect(page.getByTestId('bot-bar').locator('svg title, svg desc')).toHaveCount(0);
  // No poster adds a name: the bots are still the only buttons.
  await expect(bots(page)).toHaveCount(4);
});

test('a poster is never inside the mirrored face and is not mirrored when the bot faces left', async ({
  page,
  dashboard,
}) => {
  seed(dashboard);
  await page.goto('/#/home');
  await expect(posters(page)).toHaveCount(4);
  for (const [ticket, phase] of POSTER_KEYS) {
    const node = poster(page, `${ticket}-${phase}`);
    expect(await node.evaluate((el) => el.closest('.bot-bar-face'))).toBeNull();
    expect(await node.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
  }
  // Hold the patrol at its far end, where the face is turned to look left: the face is mirrored, the
  // poster and its text are not (their screen transform keeps a positive x scale).
  const held = await page.evaluate(() => {
    const lane = document
      .querySelector('[data-testid="bot-bar-bot-BOT-1-implement"]')
      .closest('.bot-bar-lane');
    const face = lane.querySelector('.bot-bar-face');
    const turn = face.getAnimations().find((a) => a.animationName === 'bot-bar-patrol-turn');
    turn.pause();
    const { duration } = turn.effect.getComputedTiming();
    turn.effect.updateTiming({ delay: 0 });
    turn.currentTime = duration * 0.75;
    const text = lane.querySelector('.bot-bar-poster svg text');
    return {
      face: getComputedStyle(face).transform,
      scale: text.getScreenCTM().a,
      shear: text.getScreenCTM().c,
    };
  });
  expect(held.face.startsWith('matrix(-1')).toBe(true);
  expect(held.scale).toBeGreaterThan(0);
  expect(Math.abs(held.shear)).toBeLessThan(0.2);
});

test('a poster sways only while its bot walks, and not at all with reduced motion', async ({
  page,
  dashboard,
}) => {
  seed(dashboard);
  await page.goto('/#/home');
  await expect(posters(page)).toHaveCount(4);
  const sway = (key) =>
    poster(page, key).evaluate((el) => {
      const root = el.querySelector('svg');
      const group = root.querySelector('[class$="-sway"]');
      return {
        moving: /--moving(\s|$)/.test(root.getAttribute('class')),
        animation: getComputedStyle(group).animationName,
      };
    });
  // Working, idle and done bots walk; the failed one stands.
  for (const [ticket, phase, state] of POSTER_KEYS) {
    const now = await sway(`${ticket}-${phase}`);
    expect(now.moving, state).toBe(state !== 'failed');
    expect(now.animation === 'none', state).toBe(state === 'failed');
  }
  // A walking bot you point at stands still, and so does its poster.
  const walker = page.getByTestId('bot-bar-bot-BOT-1-implement');
  const box = await walker.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  expect(
    await poster(page, 'BOT-1-implement').evaluate(
      (el) => getComputedStyle(el.querySelector('[class$="-sway"]')).animationPlayState,
    ),
  ).toBe('paused');
  await page.mouse.move(5, 5);
  // Reduced motion: no bot walks and no poster sways, whatever the modifier class says.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const [ticket, phase] of POSTER_KEYS)
    expect((await sway(`${ticket}-${phase}`)).animation).toBe('none');
});

test('a poster stands over its bot, inside the viewport, and the callout sits above it', async ({
  page,
  dashboard,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  seed(dashboard, { sessions: { 'BOT-1': WORKING_IMPLEMENT } });
  await page.goto('/#/home');
  await expect(bots(page)).toHaveCount(1);
  dashboard.data.claude.tickets['BOT-1'] = DONE_IMPLEMENT;
  await page.clock.runFor(POLL);
  const bubble = callout(page, 'BOT-1-implement');
  await expect(bubble).toBeVisible();
  const bot = await page.getByTestId('bot-bar-bot-BOT-1-implement').boundingBox();
  const sign = await poster(page, 'BOT-1-implement').boundingBox();
  const bubbleBox = await bubble.boundingBox();
  // Centred over the bot, its foot on the bot's head (a little overlap), none of it clipped.
  expect(Math.abs(sign.x + sign.width / 2 - (bot.x + bot.width / 2))).toBeLessThan(1);
  expect(sign.y + sign.height).toBeGreaterThan(bot.y);
  expect(sign.y + sign.height).toBeLessThan(bot.y + bot.height / 2);
  expect(sign.y).toBeGreaterThanOrEqual(0);
  expect(sign.x).toBeGreaterThanOrEqual(0);
  expect(sign.x + sign.width).toBeLessThanOrEqual(1440);
  // The bubble clears the poster instead of covering it.
  expect(bubbleBox.y + bubbleBox.height).toBeLessThanOrEqual(sign.y + 1);
  expect(bubbleBox.x).toBeGreaterThanOrEqual(0);
});

test('on a narrow screen every poster is drawn and nothing overflows sideways', async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ width: 480, height: 800 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  seed(dashboard);
  await page.goto('/#/home');
  await expect(posters(page)).toHaveCount(4);
  for (const box of await posters(page).evaluateAll((all) =>
    all.map((el) => el.getBoundingClientRect().toJSON()),
  )) {
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(480);
    expect(box.top).toBeGreaterThanOrEqual(0);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('the focused bot comes to the front with its poster, and no poster covers an x', async ({
  page,
  dashboard,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const keys = Array.from({ length: 6 }, (_, i) => `BOT-${40 + i}`);
  seed(dashboard, {
    sessions: Object.fromEntries(keys.map((key) => [key, review('done', 'finished')])),
    sprint: keys,
  });
  await page.goto('/#/home');
  await expect(bots(page)).toHaveCount(6);
  const lane = (key) =>
    page.getByTestId(`bot-bar-poster-${key}-review`).locator('xpath=ancestor::*[@data-state]');
  // A focused bot is raised, and its poster rides in its lane.
  for (const key of keys) {
    await page.getByTestId(`bot-bar-bot-${key}-review`).focus();
    expect(await lane(key).evaluate((el) => getComputedStyle(el).zIndex)).toBe('100');
  }
  // The board of every poster ends above every dismiss button (only a pole foot reaches the bots).
  const xs = await page
    .locator('.bot-bar-dismiss')
    .evaluateAll((all) => all.map((el) => el.getBoundingClientRect().top));
  expect(xs).toHaveLength(6);
  for (const board of await posters(page).evaluateAll((all) =>
    all.map((el) => {
      const box = el.getBoundingClientRect();
      return box.top + (box.height * 32) / 50;
    }),
  ))
    for (const top of xs) expect(board).toBeLessThanOrEqual(top);
});

test('the hover popup stands above the poster instead of covering it', async ({
  page,
  dashboard,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  seed(dashboard);
  await page.goto('/#/home');
  await expect(posters(page)).toHaveCount(4);
  await page.getByTestId('bot-bar-bot-BOT-4-implement').hover();
  const tip = await page.getByRole('tooltip').boundingBox();
  const sign = await poster(page, 'BOT-4-implement').boundingBox();
  expect(tip.y + tip.height).toBeLessThanOrEqual(sign.y + 1);
});
