import { defineConfig } from '@playwright/test';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const cache = join(homedir(), '.cache', 'ms-playwright');
const cachedBrowsers = existsSync(cache)
  ? readdirSync(cache)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort()
      .reverse()
      .map((name) => join(cache, name, 'chrome-linux64', 'chrome'))
  : [];
const executablePath = ['/usr/bin/chromium', '/usr/bin/chromium-browser', ...cachedBrowsers].find(
  (path) => existsSync(path),
);
const artifacts = 'test/.settings-verification';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.js',
  testIgnore: '**/vite-proxy.spec.js',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 20_000,
  expect: { timeout: 3_000 },
  outputDir: `${artifacts}/test-results`,
  reporter: [['list'], ['html', { outputFolder: `${artifacts}/playwright-report`, open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:6517',
    browserName: 'chromium',
    launchOptions: { executablePath },
    viewport: { width: 1440, height: 900 },
    serviceWorkers: 'block',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node e2e/static-server.mjs',
    url: 'http://127.0.0.1:6517',
    reuseExistingServer: false,
    timeout: 10_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 2_000 },
  },
});
