import { test, expect } from './fixtures.js';

test('shell exposes six semantic navigation links @smoke', async ({ page }) => {
  await page.goto('/#/home');
  await expect(page.getByTestId('panel-home')).toBeVisible();
  const links = await page
    .getByTestId('tabs')
    .getByTestId(/^tab-/)
    .evaluateAll((items) =>
      items.map((item) => ({
        name: item.textContent.trim(),
        tag: item.tagName,
        href: item.getAttribute('href'),
        current: item.getAttribute('aria-current'),
      })),
    );
  expect(links).toEqual([
    { name: 'Home', tag: 'A', href: '#/home', current: 'page' },
    { name: 'Services', tag: 'A', href: '#/services', current: null },
    { name: 'Pull Requests', tag: 'A', href: '#/prs', current: null },
    { name: 'My Tickets', tag: 'A', href: '#/my-tickets', current: null },
    { name: 'Releases', tag: 'A', href: '#/releases', current: null },
    { name: 'Settings', tag: 'A', href: '#/settings', current: null },
  ]);
});

test('shell preserves direct routes, keyboard activation and history @smoke', async ({ page }) => {
  for (const route of ['home', 'services', 'prs', 'my-tickets', 'releases']) {
    await page.goto('/#/' + route);
    await expect(page.getByTestId('panel-' + route)).toBeVisible();
    for (const hidden of ['home', 'services', 'prs', 'my-tickets', 'releases'].filter(
      (id) => id !== route,
    )) {
      await expect(page.getByTestId('panel-' + hidden)).toBeHidden();
    }
  }
  await page.getByTestId('tab-services').focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/services$/);
  await expect(page.getByTestId('panel-services')).toBeVisible();
  await page.getByTestId('tab-prs').click();
  await expect(page.getByTestId('panel-prs')).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId('panel-services')).toBeVisible();
  await page.goForward();
  await expect(page.getByTestId('panel-prs')).toBeVisible();
  await page.goto('/#/unknown');
  await expect(page.getByTestId('panel-home')).toBeVisible();
});

test('populated routes fit a mobile viewport without horizontal overflow @regression', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/home');
  await expect(page.getByTestId('home-meta')).not.toContainText('loading');
  await expect(page.getByTestId('home-actions-loading')).toHaveCount(0);
  await expect(page.getByTestId('home-services-loading')).toHaveCount(0);
  await testInfo.attach('mocked-home-mobile', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
  for (const route of ['home', 'services', 'prs', 'my-tickets', 'releases']) {
    if (route !== 'home') await page.getByTestId('tab-' + route).click();
    await expect(page.getByTestId('panel-' + route)).toBeVisible();
    if (route === 'services') await expect(page.getByTestId('card-api')).toBeVisible();
    if (route === 'prs') await expect(page.getByTestId('prs-loading')).toHaveCount(0);
    if (route === 'my-tickets') await expect(page.getByTestId('my-tickets-loading')).toHaveCount(0);
    if (route === 'releases') await expect(page.getByTestId('releases-loading')).toHaveCount(0);
    const dimensions = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }));
    expect
      .soft(dimensions.content, `${route} must not scroll horizontally`)
      .toBeLessThanOrEqual(dimensions.width);
  }
});
test('skip link preserves the active route @regression', async ({ page }) => {
  await page.goto('/#/services');
  await expect(page.getByTestId('panel-services')).toBeVisible();
  await page.getByTestId('skip-workspace').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('panel-services')).toBeVisible();
  await expect(page).toHaveURL(/#\/services$/);
  expect(await page.evaluate(() => document.activeElement.id)).toBe('workspace');
});
