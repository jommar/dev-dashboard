import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { settingsFixture } from './settings-fixture.mjs';
import { acquireDistTestLock } from './dist-test-lock.mjs';

const dashboardRoot = fileURLToPath(new URL('../', import.meta.url));

function request(origin, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(origin + pathname, options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

test('production Node handler serves built assets safely without swallowing API routes', async (t) => {
  const releaseDistLock = await acquireDistTestLock();
  const dist = path.join(dashboardRoot, 'dist');
  const fixtureAsset = 'ui-migration-contract-fixture';
  const fixtureFiles = [
    [
      'index.html',
      '<!doctype html><html><body><main id="built-ui-contract">built dashboard</main><link rel="stylesheet" href="/assets/' +
        fixtureAsset +
        '.css"><script type="module" src="/assets/' +
        fixtureAsset +
        '.js"></script></body></html>',
    ],
    [`assets/${fixtureAsset}.js`, 'document.documentElement.dataset.builtUi = "served";'],
    [`assets/${fixtureAsset}.css`, '#built-ui-contract { color: rgb(1, 2, 3); }'],
  ];
  const originals = new Map();
  for (const [relative] of fixtureFiles) {
    const filename = path.join(dist, relative);
    originals.set(filename, fs.existsSync(filename) ? fs.readFileSync(filename) : null);
  }
  t.after(async () => {
    for (const [filename, contents] of originals) {
      if (contents === null) fs.rmSync(filename, { force: true });
      else fs.writeFileSync(filename, contents);
    }
    for (const directory of [path.join(dist, 'assets'), dist]) {
      try {
        fs.rmdirSync(directory);
      } catch {}
    }
    await releaseDistLock();
  });
  for (const [relative, contents] of fixtureFiles) {
    const filename = path.join(dist, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, contents);
  }

  const fixture = settingsFixture(t);
  const settings = await fixture.store();
  await settings.initialize();
  const { createHttpHandler } = await import('../http-app.mjs');
  const manager = {
    list: () => [],
    logs: () => '',
    start: () => ({ ok: true }),
    stop: () => ({ ok: true }),
    restart: () => ({ ok: true }),
    applySettings: () => {},
  };
  const handler = createHttpHandler({ settings, manager });
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    handler.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const failures = [];

  const page = await request(origin, '/');
  if (page.status !== 200 || !page.body.includes('id="built-ui-contract"'))
    failures.push('GET / must serve dist/index.html');

  const script = await request(origin, `/assets/${fixtureAsset}.js`);
  if (
    script.status !== 200 ||
    !/^text\/javascript\b/.test(script.headers['content-type'] || '') ||
    !script.body.includes('builtUi')
  )
    failures.push('GET built JavaScript asset must return its contents with JavaScript MIME');

  const stylesheet = await request(origin, `/assets/${fixtureAsset}.css`);
  if (
    stylesheet.status !== 200 ||
    !/^text\/css\b/.test(stylesheet.headers['content-type'] || '') ||
    !stylesheet.body.includes('built-ui-contract')
  )
    failures.push('GET built CSS asset must return its contents with CSS MIME');

  const config = await request(origin, '/api/config');
  if (config.status !== 200 || JSON.parse(config.body).setup.ready !== false)
    failures.push('GET /api/config must retain its setup payload and route precedence');

  const invalidHost = await request(origin, '/api/config', {
    headers: { host: 'example.invalid' },
  });
  if (invalidHost.status !== 403)
    failures.push('direct requests with a non-loopback Host must remain rejected');
  const invalidOrigin = await request(origin, '/api/settings/validate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://example.invalid' },
    body: JSON.stringify({ expectedRevision: settings.getSetupStatus().revision }),
  });
  if (invalidOrigin.status !== 403) failures.push('cross-origin mutations must remain rejected');

  if ((await request(origin, '/assets/missing.css')).status !== 404)
    failures.push('missing built asset must return 404');
  const traversal = await request(origin, '/assets/%2e%2e/%2e%2e/package.json');
  if (traversal.status !== 404 || traversal.body.includes('"name": "dev-dashboard"'))
    failures.push('traversal must not expose a file outside dist/');
  assert.deepEqual(failures, [], failures.join('\n'));
});
