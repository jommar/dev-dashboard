import { test, expect } from './fixtures.js';

// The route heading takes focus when a screen change leaves it nowhere else (useRouteChange). Its
// ring shows only after keyboard input: a hash change with no input, or after a pointer, shows none.
const outlineOf = (locator) =>
  locator.evaluate((node) => {
    const { outlineStyle, outlineWidth } = getComputedStyle(node);
    return { style: outlineStyle, width: outlineWidth };
  });

test('a route change with no input focuses the heading without a ring', async ({ page }) => {
  await page.goto('/#/home');
  await expect(page.getByTestId('panel-home')).toBeVisible();
  await page.evaluate(() => {
    location.hash = '#/slack';
  });
  const heading = page.locator('#panel-slack h2');
  await expect(heading).toBeFocused();
  expect((await outlineOf(heading)).style).toBe('none');
});

test('a keyboard chord to another screen focuses the heading with a 2px solid ring', async ({
  page,
}) => {
  await page.goto('/#/home');
  await expect(page.getByTestId('panel-home')).toBeVisible();
  await page.keyboard.press('g');
  await page.keyboard.press('s');
  await expect(page).toHaveURL(/#\/slack$/);
  const heading = page.locator('#panel-slack h2');
  await expect(heading).toBeFocused();
  expect(await outlineOf(heading)).toEqual({ style: 'solid', width: '2px' });
});

test('going back after a pointer click focuses the heading without a ring', async ({ page }) => {
  await page.goto('/#/home');
  await expect(page.getByTestId('panel-home')).toBeVisible();
  await page.evaluate(() => {
    location.hash = '#/slack';
  });
  await expect(page.locator('#panel-slack h2')).toBeFocused();
  await page.mouse.click(2, 2);
  await page.goBack();
  await expect(page).toHaveURL(/#\/home$/);
  const heading = page.locator('#panel-home h2');
  await expect(heading).toBeFocused();
  expect((await outlineOf(heading)).style).toBe('none');
});
