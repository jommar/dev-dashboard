import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { Manager } from './manager.mjs';
import { freePort } from './port.mjs';
import { createHttpHandler } from './http-app.mjs';
import { settingsStore } from './settings.mjs';
import { DASHBOARD_HOST, DASHBOARD_PORT, DEFAULT_TAIL_LINES, LOGS_DIR } from './config.mjs';

export async function shutdownServer({ server, manager, handler, timeoutMs = 1000 }) {
  handler.close?.();
  const closed = new Promise((resolve) => server.close(resolve));
  const stopping = Promise.all(manager.list().map(({ id }) => manager.stop(id)));
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      server.closeAllConnections?.();
      resolve();
    }, timeoutMs);
  });
  try {
    await Promise.race([Promise.all([closed, stopping]), deadline]);
  } finally {
    clearTimeout(timer);
    server.closeAllConnections?.();
  }
}

export async function start() {
  await settingsStore.initialize();
  const publicSettings = settingsStore.getPublicSettings();
  const manager = new Manager({
    local: settingsStore.getSetupStatus().ready
      ? publicSettings.local
      : { root: publicSettings.local.root, services: [] },
  });
  const handler = createHttpHandler({ settings: settingsStore, manager });
  const server = http.createServer(handler);
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await shutdownServer({ server, manager, handler });
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await freePort(DASHBOARD_PORT);
  server.on('error', () => {
    console.error('Dashboard could not listen on its configured port.');
    process.exitCode = 1;
  });
  server.listen(DASHBOARD_PORT, DASHBOARD_HOST, () => {
    console.log(`EZAT Dev Dashboard → http://${DASHBOARD_HOST}:${DASHBOARD_PORT}`);
    console.log(`  tail-by-default: ${DEFAULT_TAIL_LINES} lines; logs dir: ${LOGS_DIR}`);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch(() => {
    console.error('Dashboard startup failed.');
    process.exitCode = 1;
  });
}
