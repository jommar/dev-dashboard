import { test, expect } from './fixtures.js';

// The Mascots tab: every registered mascot in four states at two sizes, toolbar toggles, a replay
// and a roaming preview. Static: the page asks the server for nothing. The registry is JSX, which
// this runner cannot import, so the card count is read from the page's own "N registered" line.
const STATES = ['working', 'waiting', 'done', 'failed'];
const grid = (page) => page.getByTestId('mascots-grid');
const cards = (page) => grid(page).getByTestId(/^mascot-card-/);
const registered = async (page) => {
  const sub = await page.getByTestId('mascots-sub').textContent();
  return Number(sub.match(/^(\d+) mascots? registered$/)[1]);
};

test('the Mascots tab lists one card per registered mascot, each with four states at two sizes', async ({
  page,
  dashboard,
}) => {
  const errors = [];
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  await page.goto('/#/home');
  await expect(page.getByTestId('panel-home')).toBeVisible();
  const before = dashboard.requests.length;
  await page.getByTestId('tab-mascots').click();
  await expect(page).toHaveURL(/#\/mascots$/);
  await expect(page.getByTestId('tab-mascots')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('panel-mascots')).toBeVisible();
  await expect(page.getByTestId('mascots-title')).toHaveText('Mascots');

  const count = await registered(page);
  expect(count).toBeGreaterThan(0);
  await expect(cards(page)).toHaveCount(count);
  for (const card of await cards(page).all()) {
    await expect(card.locator('h3')).not.toBeEmpty();
    await expect(card.locator('code')).not.toBeEmpty();
    await expect(card.locator('figure')).toHaveCount(8);
    await expect(card.locator('figure svg')).toHaveCount(8);
    for (const size of ['bar', 'large'])
      await expect(card.locator(`[data-size="${size}"] figcaption`)).toHaveText([
        'working',
        'idle',
        'done',
        'failed',
      ]);
  }
  // Both sizes really are drawn at their size.
  const first = cards(page).first();
  const heights = async (size) =>
    first
      .locator(`[data-size="${size}"] svg`)
      .evaluateAll((all) => all.map((svg) => Math.round(svg.getBoundingClientRect().height)));
  expect(await heights('bar')).toEqual(Array(4).fill(56));
  expect(await heights('large')).toEqual(Array(4).fill(160));
  for (const state of STATES)
    await expect(first.locator(`[data-testid$="-bar-${state}"] svg`)).toBeVisible();

  // The cards are a real grid: one card per row here and a second column when the pane is wide.
  const columns = await grid(page).evaluate(
    (node) => getComputedStyle(node).gridTemplateColumns.split(' ').length,
  );
  expect(columns).toBe(2);

  // It fills the viewport and scrolls inside itself, never the page.
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(
    true,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const pane = page.getByTestId('mascots-pane');
  expect(await pane.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);

  // No fetch came from opening it, and nothing it printed is an error.
  await page.waitForTimeout(500);
  // (the Slack badge and the bot bar poll on every screen; nothing else may be asked for)
  const background = /^\/api\/slack\/pending|surface=bot-bar|^\/assets\//;
  expect(dashboard.requests.slice(before).filter(({ path }) => !background.test(path))).toEqual([]);
  expect(errors).toEqual([]);
});

test('the facing and moving toggles reach every picture, and Replay remounts them', async ({
  page,
}) => {
  await page.goto('/#/mascots');
  await expect(cards(page).first()).toBeVisible();
  const right = page.getByTestId('mascots-facing-right');
  const left = page.getByTestId('mascots-facing-left');
  const faces = (side) =>
    grid(page).evaluateAll((all, name) => {
      const roots = all[0].querySelectorAll('svg');
      return [...roots].every((svg) => svg.getAttribute('class').includes(`--${name}`));
    }, side);
  await expect(right).toHaveAttribute('aria-pressed', 'true');
  await expect(left).toHaveAttribute('aria-pressed', 'false');
  expect(await faces('right')).toBe(true);
  await left.click();
  await expect(left).toHaveAttribute('aria-pressed', 'true');
  await expect(right).toHaveAttribute('aria-pressed', 'false');
  expect(await faces('left')).toBe(true);
  await right.click();
  expect(await faces('right')).toBe(true);

  const moving = page.getByTestId('mascots-moving');
  const classes = () =>
    grid(page).evaluate((node) =>
      [...node.querySelectorAll('svg')].map((s) => s.getAttribute('class')),
    );
  const still = await classes();
  await expect(moving).toHaveAttribute('aria-pressed', 'false');
  await moving.click();
  await expect(moving).toHaveAttribute('aria-pressed', 'true');
  expect(await classes()).not.toEqual(still);
  await moving.click();
  expect(await classes()).toEqual(still);

  await grid(page).evaluate((node) => (node.firstElementChild.dataset.before = 'yes'));
  await page.getByTestId('mascots-replay').click();
  await expect(cards(page).first()).not.toHaveAttribute('data-before', 'yes');
  await expect(cards(page)).not.toHaveCount(0);
});

test('the roaming preview uses the bar lanes and a typed key shows its mascot', async ({
  page,
}) => {
  await page.goto('/#/mascots');
  const roam = page.getByTestId('mascots-roam');
  await expect(roam).toBeVisible();
  const lanes = roam.locator('.bot-bar-lane');
  expect(await lanes.count()).toBeGreaterThanOrEqual(await registered(page));
  const box = await roam.boundingBox();
  // Walkers animate with the real bar's keyframes, and the bots stay inside the strip.
  const walker = roam.locator('.bot-bar-lane[data-state="working"]').first();
  expect(await walker.evaluate((node) => getComputedStyle(node).animationName)).toBe(
    'bot-bar-patrol',
  );
  for (const face of await roam.locator('.bot-bar-face').all()) {
    const at = await face.boundingBox();
    expect(at.x).toBeGreaterThanOrEqual(box.x - 1);
    expect(at.x + at.width).toBeLessThanOrEqual(box.x + box.width + 1);
  }

  const result = page.getByTestId('mascots-pick-result');
  await expect(result).toHaveText('');
  await page.getByTestId('mascots-pick-input').fill('TAP-1234:implement');
  await expect(result).toHaveText(/\(.+\)$/);
  await expect(page.locator('[data-picked="true"]')).toHaveCount(1);
  await expect(page.locator('[data-picked="true"]')).toContainText('Picked');
  await page.getByTestId('mascots-pick-input').fill('');
  await expect(page.locator('[data-picked="true"]')).toHaveCount(0);
});

test('with reduced motion the roaming preview stands still', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/#/mascots');
  const walker = page.getByTestId('mascots-roam').locator('.bot-bar-lane[data-state="working"]');
  await expect(walker.first()).toBeVisible();
  expect(await walker.first().evaluate((node) => getComputedStyle(node).animationName)).toBe(
    'none',
  );
});

test('the Posters section lists one card per registered poster, still and swaying', async ({
  page,
}) => {
  await page.goto('/#/mascots');
  const posterCards = page.getByTestId('posters-grid').getByTestId(/^poster-card-/);
  await expect(posterCards.first()).toBeVisible();
  // The registry is JSX this runner cannot import, so the count comes from the page's own line.
  const sub = await page.getByTestId('posters-sub').textContent();
  const count = Number(sub.match(/^(\d+) posters? registered$/)[1]);
  expect(count).toBeGreaterThan(0);
  await expect(posterCards).toHaveCount(count);
  const ids = [];
  for (const card of await posterCards.all()) {
    await expect(card.locator('h3')).not.toBeEmpty();
    await expect(card.locator('code')).not.toBeEmpty();
    ids.push(await card.locator('code').textContent());
    // Bar size and large, still and swaying, plus the shortest and the longest key.
    await expect(card.locator('figure svg')).toHaveCount(6);
    await expect(card.locator('figure svg text')).toHaveText([
      'TAP-1451',
      'TAP-1451',
      'TAP-1451',
      'TAP-1451',
      'AB-1',
      'TRIPS-12345',
    ]);
    await expect(card.locator('svg[class*="--moving"]')).toHaveCount(2);
    await expect(card.locator('[title], svg title, svg desc')).toHaveCount(0);
    for (const box of await card
      .locator('figure svg')
      .evaluateAll((all) => all.map((el) => el.getBoundingClientRect().toJSON()))) {
      expect(box.width).toBeGreaterThan(80);
      expect(box.left).toBeGreaterThanOrEqual(0);
    }
  }
  expect(new Set(ids).size).toBe(count);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // A swaying copy sways, a still copy does not.
  const sway = (testId) =>
    page
      .getByTestId(testId)
      .locator('svg')
      .evaluate((svg) => getComputedStyle(svg.querySelector('[class$="-sway"]')).animationName);
  expect(await sway(`poster-figure-${ids[0]}-bar-swaying`)).toMatch(/-sway$/);
  expect(await sway(`poster-figure-${ids[0]}-bar-still`)).toBe('none');
});

test('every bot of the roaming preview carries a poster with its own ticket key', async ({
  page,
}) => {
  await page.goto('/#/mascots');
  const roam = page.getByTestId('mascots-roam');
  await expect(roam).toBeVisible();
  const lanes = await roam.locator('.bot-bar-lane').count();
  await expect(roam.locator('.bot-bar-poster')).toHaveCount(lanes);
  const texts = await roam.locator('.bot-bar-poster svg text').allTextContents();
  expect(new Set(texts).size).toBe(lanes);
  for (const text of texts) expect(text).toMatch(/^TAP-\d+$/);
  // Outside the mirrored face, and inside the strip.
  expect(
    await roam
      .locator('.bot-bar-poster')
      .evaluateAll((all) => all.some((el) => el.closest('.bot-bar-face'))),
  ).toBe(false);
  const strip = await roam.boundingBox();
  for (const box of await roam
    .locator('.bot-bar-poster')
    .evaluateAll((all) => all.map((el) => el.getBoundingClientRect().toJSON()))) {
    expect(box.top).toBeGreaterThanOrEqual(strip.y - 1);
  }
});

test('with reduced motion no poster on the Mascots page sways', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/#/mascots');
  await expect(page.getByTestId('posters-grid')).toBeVisible();
  const swaying = await page
    .getByTestId('panel-mascots')
    .locator('svg[class^="poster-"][class*="--moving"]')
    .evaluateAll(
      (all) =>
        all.filter(
          (svg) => getComputedStyle(svg.querySelector('[class$="-sway"]')).animationName !== 'none',
        ).length,
    );
  expect(swaying).toBe(0);
});
