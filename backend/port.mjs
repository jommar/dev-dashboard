// port.mjs — shared "free a port before use" helper.
//
// Kills whatever is already listening on a port so a stale process can't block
// a new one. Used by the server (its own dashboard port) and by the manager
// (each service's app port, so the dashboard can take over a port the app is
// already running on).
import { execFile } from 'node:child_process';

// Kill every process listening on `port` (never a client merely connected to it,
// and never this process). Resolves once the socket should be free (graceful kill
// + brief settle). Never throws — best-effort. `run` and `settleMs` are injectable
// for tests.
export function freePort(port, { run = execFile, settleMs = 700 } = {}) {
  return new Promise((resolve) => {
    run('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], (err, stdout) => {
      if (err || !stdout.trim()) {
        resolve(false); // nothing holding it (or lsof unavailable)
        return;
      }
      const pids = stdout
        .trim()
        .split('\n')
        .filter((pidStr) => pidStr && Number(pidStr) !== process.pid);
      if (!pids.length) {
        resolve(false); // only this process listens: nothing to free
        return;
      }
      for (const pidStr of pids) {
        try {
          process.kill(Number(pidStr), 'SIGTERM');
          console.log(`  [dashboard] freed port :${port} → killed stale pid ${pidStr}`);
        } catch {
          /* already gone */
        }
      }
      // Give the killed processes a beat to release the socket.
      setTimeout(() => resolve(true), settleMs);
    });
  });
}
