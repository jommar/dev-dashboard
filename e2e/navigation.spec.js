import { test, expect } from './fixtures.js';
import { settingsData, ticketBoardData } from './data.js';

const primaryRoutes = ['home', 'my-tickets', 'slack'];
const toolRoutes = ['chat', 'prs', 'releases', 'services', 'devtools', 'mascots', 'settings'];

for (const width of [320, 390, 699, 700, 1024, 1199, 1200, 1440]) {
  test(`main navigation keeps the daily route order and fits at ${width}px`, async ({
    page,
    dashboard,
  }) => {
    ticketBoardData(dashboard.data);
    dashboard.data.slack.pending.channel.mentions = 120;
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/#/my-tickets');
    await expect(page.getByTestId('my-tickets-board')).toBeVisible();
    await expect(page.getByTestId('tab-slack-badge')).toHaveText('99+');
    const nav = page.getByTestId('tabs');
    expect(
      await nav.locator('.nav-primary a').evaluateAll((links) => links.map((el) => el.dataset.tab)),
    ).toEqual(primaryRoutes);
    for (const id of primaryRoutes) {
      const link = page.getByTestId(`tab-${id}`);
      await expect(link).toBeInViewport();
      const box = await link.boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
    await expect(page.getByTestId('tab-my-tickets')).toHaveAttribute('aria-current', 'page');
    const toggle = page.getByTestId('nav-tools-toggle');
    if (width < 1200) {
      await expect(toggle).toBeVisible();
      await expect(toggle).toHaveAccessibleName('Tools');
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByTestId('tab-prs')).toBeHidden();
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    } else await expect(toggle).toBeHidden();
    for (const id of toolRoutes) await expect(page.getByTestId(`tab-${id}`)).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(
      true,
    );
    expect((await nav.boundingBox()).y).toBeLessThan(
      (await page.locator('#workspace').boundingBox()).y,
    );
  });
}

test('compact tools support keyboard activation, Escape, outside click and history', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/home');
  const toggle = page.getByTestId('nav-tools-toggle');
  await expect(toggle).toHaveAccessibleName('Tools');
  await toggle.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('tab-prs')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await page.getByTestId('home-link').click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  for (const id of toolRoutes) {
    await toggle.click();
    await page.getByTestId(`tab-${id}`).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`#/${id}$`));
    await expect(page.getByTestId(`panel-${id}`)).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toHaveAttribute('data-active', 'true');
    await expect(toggle).toHaveAccessibleName(/^Tools · Current view: /);
    await expect(toggle).toBeFocused();
  }
  await page.getByTestId('tab-slack').click();
  await expect(toggle).toHaveAccessibleName('Tools');
  await expect(toggle).toHaveAttribute('data-active', 'false');
  await page.goBack();
  await expect(page.getByTestId('panel-settings')).toBeVisible();
  await page.goForward();
  await expect(page.getByTestId('panel-slack')).toBeVisible();
});

test('the compact menu closes when focus leaves or the layout switches to desktop', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto('/#/home');
  const toggle = page.getByTestId('nav-tools-toggle');
  await toggle.click();
  await page.getByTestId('tab-prs').focus();
  await page.getByTestId('tab-home').focus();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByTestId('tab-slack')).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(toggle).toBeHidden();
  await expect(page.getByTestId('tab-services')).toBeVisible();
  await page.setViewportSize({ width: 1024, height: 900 });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('tab-services')).toBeHidden();
});

test('setup keeps Settings directly available and starts no operational polling on mobile', async ({
  page,
  dashboard,
}) => {
  Object.assign(dashboard.data, settingsData('migration'));
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/#/slack');
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(page.getByTestId('tabs').getByRole('link')).toHaveCount(1);
  await expect(page.getByTestId('tab-settings')).toBeInViewport();
  await expect(page.getByTestId('nav-tools-toggle')).toHaveCount(0);
  expect(dashboard.requests.filter(({ path }) => path.startsWith('/api/slack/'))).toEqual([]);
});
