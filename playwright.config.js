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
const onCI = Boolean(process.env.CI);
// PW_WORKERS: a count ('2') or a share of the CPU threads ('25%'). `--workers` on the CLI wins.
const workers = process.env.PW_WORKERS?.endsWith('%')
  ? process.env.PW_WORKERS
  : Number(process.env.PW_WORKERS || 4);
// PW_HTML=1 adds the HTML report locally; CI always writes it.
const htmlReport = ['html', { outputFolder: `${artifacts}/playwright-report`, open: 'never' }];

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.js',
  testIgnore: '**/vite-proxy.spec.js',
  fullyParallel: true,
  workers,
  retries: 0,
  timeout: 20_000,
  expect: { timeout: 3_000 },
  outputDir: `${artifacts}/test-results`,
  reporter: onCI || process.env.PW_HTML ? [['list'], htmlReport] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:6517',
    browserName: 'chromium',
    launchOptions: { executablePath },
    viewport: { width: 1440, height: 900 },
    serviceWorkers: 'block',
    screenshot: 'only-on-failure',
    // Tracing is off locally (a full run is about 15 s faster without it) and kept on failure on CI.
    // PW_TRACE=retain-on-failure (or `--trace=retain-on-failure`) turns it on to debug a red test.
    trace: process.env.PW_TRACE || (onCI ? 'retain-on-failure' : 'off'),
    actionTimeout: 5_000,
    navigationTimeout: 10_000,
  },
  webServer: {
    command: 'node e2e/static-server.mjs',
    url: 'http://127.0.0.1:6517',
    reuseExistingServer: false,
    timeout: 30_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 2_000 },
  },
});
