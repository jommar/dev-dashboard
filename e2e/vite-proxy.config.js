import { defineConfig } from '@playwright/test';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createHttpHandler } from '../backend/http-app.mjs';

const hostPort = 6519;
const vitePort = 6518;
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const browserCache = path.join(homedir(), '.cache', 'ms-playwright');
const cachedBrowsers = existsSync(browserCache)
  ? readdirSync(browserCache)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort()
      .reverse()
      .map((name) => path.join(browserCache, name, 'chrome-linux64', 'chrome'))
  : [];
const executablePath = ['/usr/bin/chromium', '/usr/bin/chromium-browser', ...cachedBrowsers].find(
  (filename) => existsSync(filename),
);

async function startFixtureServer() {
  let serviceState = 'stopped';
  const settings = {
    getSetupStatus: () => ({ ready: true, revision: 1, errors: [] }),
    getPublicSettings: () => ({ jira: { baseUrl: '' } }),
    getSnapshot: () => ({}),
    refreshReadiness: async () => ({ ready: true, revision: 1, errors: [] }),
    subscribe: () => () => {},
    bindLifecycle: () => {},
    validate: async () => ({ setup: { ready: true, revision: 2 }, validation: 'complete' }),
  };
  const manager = {
    list: () => [{ id: 'app', state: serviceState }],
    logs: () => '',
    start: async (id) => {
      serviceState = 'running';
      return { ok: true, service: id, state: serviceState };
    },
    stop: async (id) => {
      serviceState = 'stopped';
      return { ok: true, service: id, state: serviceState };
    },
    restart: async (id) => {
      serviceState = 'running';
      return { ok: true, service: id, state: serviceState };
    },
  };
  const handler = createHttpHandler({ settings, manager });
  const server = http.createServer(handler);
  server.listen(hostPort, '127.0.0.1');
  await once(server, 'listening');
  console.log(`Real Node proxy fixture listening at http://127.0.0.1:${hostPort}`);
}

if (process.argv.includes('--fixture')) await startFixtureServer();

export default defineConfig({
  testDir: '.',
  testMatch: 'vite-proxy.spec.js',
  fullyParallel: false,
  workers: 1,
  timeout: 20_000,
  expect: { timeout: 3_000 },
  use: {
    baseURL: `http://127.0.0.1:${vitePort}`,
    browserName: 'chromium',
    launchOptions: { executablePath },
  },
  webServer: [
    {
      command: `node ${path.join(path.dirname(fileURLToPath(import.meta.url)), 'vite-proxy.config.js')} --fixture`,
      url: `http://127.0.0.1:${hostPort}/api/config`,
      reuseExistingServer: false,
      timeout: 10_000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 2_000 },
    },
    {
      command: `vite --config ${path.join(repoRoot, 'vite.config.js')} --host 127.0.0.1 --port ${vitePort} --strictPort`,
      url: `http://127.0.0.1:${vitePort}/__proxy-test`,
      reuseExistingServer: false,
      timeout: 15_000,
      env: {
        DASHBOARD_PROXY_TARGET: `http://127.0.0.1:${hostPort}`,
        DASHBOARD_VITE_ORIGIN: `http://127.0.0.1:${vitePort}`,
        DASHBOARD_VITE_PROXY_TEST: '1',
      },
      gracefulShutdown: { signal: 'SIGTERM', timeout: 2_000 },
    },
  ],
});
