import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { Manager } from './manager.mjs';
import { createCheckoutStore } from './checkouts.mjs';
import { freePort } from './port.mjs';
import { createHttpHandler } from './http-app.mjs';
import { defaultLog, logLine, scrubMessage } from './log.mjs';
import { settingsStore } from './settings.mjs';
import { DASHBOARD_HOST, DASHBOARD_PORT, DEFAULT_TAIL_LINES, LOGS_DIR } from './config.mjs';

const DEFAULT_SHUTDOWN_MS = 8000;
const SHUTDOWN_KILL_AFTER_MS = 3000;

export async function shutdownServer({
  server,
  manager,
  handler,
  timeoutMs = DEFAULT_SHUTDOWN_MS,
  killAfterMs = SHUTDOWN_KILL_AFTER_MS,
}) {
  handler.close?.();
  const closed = new Promise((resolve) => server.close(resolve));
  const stopping = manager.stopAll
    ? manager.stopAll({ timeoutMs, killAfterMs })
    : Promise.all(manager.list().map(({ id }) => manager.stop(id)));
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

// The facts of a failure for a `[server]` or `[process]` line: its name, code and scrubbed message,
// never the stack. `reason` may be anything a promise was rejected with.
function describeFailure(reason) {
  return {
    name: typeof reason?.name === 'string' ? reason.name : undefined,
    code: typeof reason?.code === 'string' ? reason.code : undefined,
    // A SyntaxError quotes the text it failed to parse, so its message is never logged.
    message:
      reason?.name === 'SyntaxError'
        ? undefined
        : scrubMessage(reason?.message ?? (typeof reason === 'string' ? reason : '')),
  };
}

// `proc` is the process whose exit code is set; a test passes a plain object.
export function reportListenError(error, { log = defaultLog, proc = process } = {}) {
  logLine(log, 'server', { step: 'listen', port: DASHBOARD_PORT, ...describeFailure(error) });
  proc.exitCode = 1;
}

export function reportStartupFailure(error, { log = defaultLog, proc = process } = {}) {
  logLine(log, 'server', { step: 'startup', ...describeFailure(error) });
  proc.exitCode = 1;
}

// A rejection nobody handled is logged and ignored. An exception nobody caught leaves the process in
// an unknown state, so it is logged, the graceful `shutdown` runs once (it stops the detached
// services, which a hard death would orphan) and the process exits 1; a second one while that runs
// exits at once. Installed by `start()` only, never by importing this module. Returns the remover.
export function installProcessHandlers({
  shutdown,
  log = defaultLog,
  exit = (code) => process.exit(code),
  proc = process,
}) {
  let crashing = false;
  const onRejection = (reason) =>
    logLine(log, 'process', { event: 'unhandledRejection', ...describeFailure(reason) });
  const onException = (error) => {
    if (crashing) {
      exit(1);
      return;
    }
    crashing = true;
    logLine(log, 'process', { event: 'uncaughtException', ...describeFailure(error) });
    let stopping;
    try {
      stopping = Promise.resolve(shutdown());
    } catch {
      stopping = Promise.resolve();
    }
    stopping.catch(() => {}).finally(() => exit(1));
  };
  proc.on('unhandledRejection', onRejection);
  proc.on('uncaughtException', onException);
  return () => {
    proc.off('unhandledRejection', onRejection);
    proc.off('uncaughtException', onException);
  };
}

export function startSlackWatcher(handler) {
  handler.slackWatcher.start();
}

export async function start() {
  await settingsStore.initialize();
  const publicSettings = settingsStore.getPublicSettings();
  const manager = new Manager({
    local: settingsStore.getSetupStatus().ready
      ? publicSettings.local
      : { root: publicSettings.local.root, services: [] },
    checkouts: createCheckoutStore(),
  });
  const handler = createHttpHandler({ settings: settingsStore, manager });
  const server = http.createServer(handler);
  let shuttingDown = false;
  let stopping = null;
  // One graceful stop for a signal and for a crash, so a crash during a shutdown waits for it.
  const stopGracefully = () => (stopping ||= shutdownServer({ server, manager, handler }));
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await stopGracefully();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  installProcessHandlers({ shutdown: stopGracefully });
  await freePort(DASHBOARD_PORT);
  server.on('error', (error) => reportListenError(error));
  server.listen(DASHBOARD_PORT, DASHBOARD_HOST, () => {
    startSlackWatcher(handler);
    console.log(`EZAT Dev Dashboard → http://${DASHBOARD_HOST}:${DASHBOARD_PORT}`);
    console.log(`  tail-by-default: ${DEFAULT_TAIL_LINES} lines; logs dir: ${LOGS_DIR}`);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch((error) => reportStartupFailure(error));
}
