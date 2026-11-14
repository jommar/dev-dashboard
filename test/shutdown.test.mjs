// shutdown.test.mjs — shutdownServer stops the services, outside the settings lock and
// within a cap. Nothing here spawns a process or signals a real pid.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const definition = {
  id: 'app',
  label: 'App',
  dir: 'project',
  command: ['npm', 'start'],
  port: null,
};

// A started Manager whose one service is a fake process; `onSignal(proc, name)` decides what
// each signal does to it.
async function fixture(t, onSignal) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-dashboard-shutdown-'));
  fs.mkdirSync(path.join(root, 'project'));
  const signals = [];
  let proc;
  t.mock.method(childProcess, 'spawn', () => {
    proc = new EventEmitter();
    proc.pid = 987654;
    return proc;
  });
  t.mock.method(process, 'kill', (pid, name) => {
    signals.push(name);
    onSignal(proc, name);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const { Manager } = await import('../backend/manager.mjs');
  const { shutdownServer } = await import('../backend/server.mjs');
  const manager = new Manager({
    local: { root, services: [definition] },
    logsDir: path.join(root, 'logs'),
  });
  await manager.start('app');
  const server = { close: (done) => done(), closeAllConnections() {} };
  return {
    manager,
    signals,
    shutdown: (options) => shutdownServer({ server, handler: {}, manager, ...options }),
  };
}

test('shutdown waits for a service to exit, without waiting for the settings lock', async (t) => {
  const f = await fixture(t, (proc, name) => {
    if (name === 'SIGTERM') setTimeout(() => proc.emit('exit', 0, 'SIGTERM'), 200);
  });
  f.manager.withSettingsLock(() => new Promise(() => {})); // held for good
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let done = false;
  const shutting = f.shutdown({ timeoutMs: 2000 }).then(() => {
    done = true;
  });
  await tick();
  t.mock.timers.tick(199);
  await tick();
  assert.equal(done, false, 'not before the service exited');
  assert.equal(f.manager.get('app').status, 'running');
  t.mock.timers.tick(1);
  await shutting;
  assert.equal(f.manager.get('app').proc, null);
  assert.deepEqual(f.signals, ['SIGTERM']);
});

test('shutdown kills a service that ignores SIGTERM and stays within the cap', async (t) => {
  const f = await fixture(t, () => {}); // never exits
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let done = false;
  const shutting = f.shutdown({ timeoutMs: 300, killAfterMs: 50 }).then(() => {
    done = true;
  });
  await tick();
  t.mock.timers.tick(49);
  assert.deepEqual(f.signals, ['SIGTERM']);
  t.mock.timers.tick(1);
  assert.deepEqual(f.signals, ['SIGTERM', 'SIGKILL']);
  await tick();
  assert.equal(done, false);
  t.mock.timers.tick(250);
  await shutting;
  assert.ok(f.manager.get('app').proc, 'the survivor does not hold shutdown past the cap');
});

test('shutdown falls back to per-id stop for a manager without stopAll', async () => {
  const { shutdownServer } = await import('../backend/server.mjs');
  const stopped = [];
  const manager = {
    list: () => [{ id: 'a' }],
    stop: async (id) => {
      stopped.push(id);
      return { ok: true };
    },
  };
  const server = { close: (done) => done(), closeAllConnections() {} };
  await shutdownServer({ server, handler: {}, manager, timeoutMs: 100 });
  assert.deepEqual(stopped, ['a']);
});
