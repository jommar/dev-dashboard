import { test, expect } from './fixtures.js';
import { settingsData } from './data.js';

for (const setupOnly of [false, true]) {
  test(`the header and browser tab share a served SVG logo${setupOnly ? ' during setup' : ''}`, async ({
    page,
    request,
    dashboard,
  }) => {
    if (setupOnly) Object.assign(dashboard.data, settingsData('migration'));
    await page.goto('/#/home');
    const logo = page.getByTestId('home-link').locator('img');
    await expect(logo).toBeVisible();
    await expect(logo).toHaveAttribute('alt', '');
    await expect(page.getByTestId('home-link')).toHaveAccessibleName('EZAT Dev workspace');
    const icon = page.locator('head link[rel="icon"]');
    await expect(icon).toHaveAttribute('type', 'image/svg+xml');
    await expect(icon).toHaveAttribute('sizes', 'any');
    const src = await logo.getAttribute('src');
    expect(src).toMatch(/^\/assets\/logo-[\w-]+\.svg$/);
    await expect(icon).toHaveAttribute('href', src);
    const response = await request.get(src);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('image/svg+xml');
    expect(await response.text()).toContain('EZAT developer workspace');
    await expect
      .poll(() => logo.evaluate((image) => image.complete && image.naturalWidth > 0))
      .toBe(true);
  });
}
