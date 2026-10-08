import { test, expect } from '@playwright/test';

test('real Vite proxy preserves Node API reads, mutations, SSE, and direct authority guards', async ({
  page,
  request,
}) => {
  await page.goto('/__proxy-test');

  const config = await page.evaluate(async () => {
    const response = await fetch('/api/config');
    return { status: response.status, body: await response.json() };
  });
  expect(config.status).toBe(200);
  expect(config.body).toMatchObject({ setup: { ready: true, revision: 1 }, jiraBase: '' });

  const connected = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const stream = new EventSource('/api/events');
        window.proxyTestStream = stream;
        window.proxyTestEvents = [];
        stream.onmessage = (event) => {
          window.proxyTestEvents.push(JSON.parse(event.data));
          resolve(window.proxyTestEvents[0]);
        };
        stream.onerror = () => reject(new Error('proxied EventSource connection failed'));
      }),
  );
  expect(connected).toEqual([{ id: 'app', state: 'stopped' }]);

  const mutation = await page.evaluate(async () => {
    const response = await fetch('/api/settings/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 1 }),
    });
    return { status: response.status, body: await response.json() };
  });
  expect(mutation).toEqual({
    status: 200,
    body: { setup: { ready: true, revision: 2 }, validation: 'complete' },
  });

  const rejectedViteOrigin = await request.post('http://127.0.0.1:6518/api/settings/validate', {
    headers: { origin: 'http://untrusted.example.invalid', 'content-type': 'application/json' },
    data: { expectedRevision: 1 },
  });
  expect(rejectedViteOrigin.status()).toBe(403);
  const rejectedViteHost = await request.get('http://127.0.0.1:6518/api/config', {
    headers: { host: 'untrusted.example.invalid' },
  });
  expect(rejectedViteHost.status()).toBe(403);

  const control = await page.evaluate(async () => {
    const response = await fetch('/api/services/app/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    return { status: response.status, body: await response.json() };
  });
  expect(control).toEqual({ status: 200, body: { ok: true, service: 'app', state: 'running' } });

  await page.waitForFunction(() => window.proxyTestEvents.length >= 3, null, { timeout: 3_000 });
  const streamed = await page.evaluate(() => window.proxyTestEvents.at(-1));
  expect(streamed).toEqual([{ id: 'app', state: 'running' }]);
  await page.evaluate(() => window.proxyTestStream.close());

  const directHost = await request.get('http://127.0.0.1:6519/api/config', {
    headers: { host: 'untrusted.example.invalid' },
  });
  expect(directHost.status()).toBe(403);

  const directOrigin = await request.post('http://127.0.0.1:6519/api/settings/validate', {
    headers: { origin: 'http://untrusted.example.invalid', 'content-type': 'application/json' },
    data: { expectedRevision: 1 },
  });
  expect(directOrigin.status()).toBe(403);
});
