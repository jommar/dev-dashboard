import { test, expect } from './fixtures.js';

test('static fixture denies non-UI paths and mutation methods @smoke', async ({ request }) => {
  for (const path of [
    '/api/config',
    '/api/pr-diff',
    '/server.mjs',
    '/manager.mjs',
    '/package.json',
    '/ui/../server.mjs',
  ]) {
    expect((await request.get(path)).status(), path).toBe(404);
  }
  expect((await request.post('/api/services/api/start')).status()).toBe(404);
  expect((await request.post('/ui-react/main.jsx')).status()).toBe(404);
  expect((await request.get('/ui-react/main.jsx')).status()).toBe(200);
});

test('browser boundaries mock controls, diff, SSE and clipboard and block unknown requests @smoke', async ({
  page,
  dashboard,
}) => {
  await page.goto('/#/home');
  await expect(page.getByTestId('home-meta')).not.toContainText('loading');
  const result = await page.evaluate(async () => {
    const control = await fetch('/api/services/api/start', { method: 'POST' }).then((response) =>
      response.json(),
    );
    const diff = await fetch('/api/pr-diff?repo=example/workspace&number=17').then((response) =>
      response.json(),
    );
    await navigator.clipboard.writeText(diff.diff);
    return {
      control,
      clipboard: window.__dashboardMock.clipboard.writes,
      streams: window.__dashboardMock.streams.length,
    };
  });
  expect(result).toEqual({
    control: { ok: true },
    clipboard: [dashboard.data.diff.diff],
    streams: 1,
  });
  expect(dashboard.unexpected).toEqual([]);
  await page.evaluate(() => fetch('/api/not-a-fixture').catch(() => {}));
  expect(dashboard.unexpected).toEqual(['GET http://127.0.0.1:6517/api/not-a-fixture']);
  dashboard.unexpected.pop();
  await page.evaluate(() => fetch('https://example.invalid/blocked').catch(() => {}));
  await expect.poll(() => dashboard.unexpected).toEqual(['CSP https://example.invalid/blocked']);
  dashboard.unexpected.pop();
});
