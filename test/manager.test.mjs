import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';

const SECRET_NAMES = ['GH_TOKEN', 'GITHUB_TOKEN', 'JIRA_API_TOKEN', 'JIRA_TOKEN'];

async function fixture(t, { customNvm = false, secretNames = SECRET_NAMES } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-dashboard-manager-'));
  const project = path.join(root, 'project');
  const logs = path.join(root, 'logs');
  const home = path.join(root, 'home');
  const nvm = path.join(home, customNvm ? 'custom-nvm' : '.nvm');
  fs.mkdirSync(project);
  const previousNvm = process.env.NVM_DIR;
  if (customNvm) process.env.NVM_DIR = nvm;
  else delete process.env.NVM_DIR;
  t.mock.method(os, 'homedir', () => home);
  const spawns = [];
  const portCalls = [];
  const kills = [];
  t.mock.method(childProcess, 'spawn', (cmd, args, options) => {
    const proc = new EventEmitter();
    proc.pid = 987654;
    spawns.push({ cmd, args, options, proc });
    return proc;
  });
  t.mock.method(childProcess, 'execFile', (cmd, args, callback) => {
    portCalls.push({ cmd, args });
    callback(null, '');
  });
  t.mock.method(process, 'kill', (...args) => {
    kills.push(args);
    spawns.at(-1)?.proc.emit('exit', 0, 'SIGTERM');
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (previousNvm === undefined) delete process.env.NVM_DIR;
    else process.env.NVM_DIR = previousNvm;
    fs.rmSync(root, { recursive: true, force: true });
  });
  // Copy production code unchanged; only configuration paths are isolated.
  for (const file of ['manager.mjs', 'port.mjs']) {
    fs.copyFileSync(new URL(`../backend/${file}`, import.meta.url), path.join(root, file));
  }
  fs.writeFileSync(
    path.join(root, 'config.mjs'),
    `
    export const SERVICES = {};
    export const REPOS_ROOT = ${JSON.stringify(root)};
    export const LOGS_DIR = ${JSON.stringify(logs)};
    export const BUFFER_BYTES = 65536;
    export const SECRET_ENV_NAMES = ${JSON.stringify(secretNames)};
  `,
  );
  const { ServiceProcess, Manager } = await import(pathToFileURL(path.join(root, 'manager.mjs')));
  const service = new ServiceProcess({
    id: 'test',
    dir: 'project',
    command: ['npm', 'run', 'dev'],
    port: 12345,
  });
  function install(version) {
    const bin = path.join(nvm, 'versions', 'node', version, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    for (const executable of ['node', 'npm']) {
      fs.writeFileSync(path.join(bin, executable), '', { mode: 0o755 });
    }
    return bin;
  }
  return { root, project, logs, nvm, service, spawns, portCalls, kills, install, Manager };
}

test('start normalizes a v-prefixed installed pin with default NVM_DIR', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.project, '.nvmrc'), 'v20.18.0\n');
  const bin = f.install('v20.18.0');
  assert.equal(await f.service.start(), true);
  assert.equal(f.spawns[0].options.env.PATH, `${bin}${path.delimiter}${process.env.PATH || ''}`);
  assert.equal(f.spawns[0].options.cwd, f.project);
  assert.equal(f.spawns[0].cmd, 'npm');
  assert.deepEqual(f.spawns[0].args, ['run', 'dev']);
  assert.match(f.service.logTail(), /Node v20\.18\.0/);
  assert.ok(f.service.logTail().includes(path.join(bin, 'node')));
});

test('start honors custom NVM_DIR and an unprefixed project pin over the root pin', async (t) => {
  const f = await fixture(t, { customNvm: true });
  fs.writeFileSync(path.join(f.project, '.nvmrc'), ' 20.18.0\n');
  fs.writeFileSync(path.join(f.root, '.nvmrc'), 'v22.0.0\n');
  const bin = f.install('v20.18.0');
  await f.service.start();
  assert.equal(f.spawns[0].options.env.PATH, `${bin}${path.delimiter}${process.env.PATH || ''}`);
});

test('start uses the root pin only when the project pin is absent', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.root, '.nvmrc'), '22.0.0\n');
  const bin = f.install('v22.0.0');
  await f.service.start();
  assert.equal(f.spawns[0].options.env.PATH, `${bin}${path.delimiter}${process.env.PATH || ''}`);
});

test('start retains inherited PATH when both pin files are absent', async (t) => {
  const f = await fixture(t);
  await f.service.start();
  assert.equal(f.spawns[0].options.env.PATH, process.env.PATH);
  assert.equal(f.spawns[0].cmd, 'npm');
});

// Sets process environment variables for the rest of the test and puts the old values back.
function setEnv(t, variables) {
  const previous = Object.keys(variables).map((name) => [name, process.env[name]]);
  Object.assign(process.env, variables);
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

test('scenario 55: start gives the child none of the dashboard credentials and keeps PATH', async (t) => {
  setEnv(t, Object.fromEntries(SECRET_NAMES.map((name) => [name, `synthetic-${name}`])));
  const f = await fixture(t);
  await f.service.start();
  const { env } = f.spawns[0].options;
  for (const name of SECRET_NAMES) assert.equal(name in env, false, `${name} is not passed on`);
  assert.equal(env.PATH, process.env.PATH);
});

test('scenario 56: start strips the names config.mjs lists as secret, and only those', async (t) => {
  setEnv(t, { SENTINEL_CREDENTIAL: 'synthetic-sentinel', GH_TOKEN: 'synthetic-unlisted' });
  const f = await fixture(t, { secretNames: ['SENTINEL_CREDENTIAL'] });
  await f.service.start();
  const { env } = f.spawns[0].options;
  assert.equal('SENTINEL_CREDENTIAL' in env, false, 'a listed name is stripped');
  assert.equal(
    env.GH_TOKEN,
    'synthetic-unlisted',
    'an unlisted name is not: the list is config.mjs',
  );
});

for (const scenario of [
  { name: 'missing installation', pin: '20.18.0', error: /node.*v20\.18\.0|v20\.18\.0.*node/i },
  { name: 'missing npm', pin: '20.18.0', tool: 'npm', error: /npm/ },
  { name: 'non-executable node', pin: '20.18.0', tool: 'node', mode: 0o644, error: /node/ },
  { name: 'non-executable npm', pin: '20.18.0', tool: 'npm', mode: 0o644, error: /npm/ },
  {
    name: 'directory instead of node',
    pin: '20.18.0',
    tool: 'node',
    directory: true,
    error: /node/,
  },
  { name: 'alias', pin: 'lts/*', error: /exact.*version|unsupported.*pin/i },
  { name: 'partial pin', pin: '20', error: /exact.*version|unsupported.*pin/i },
  { name: 'double prefix', pin: 'vv20.18.0', error: /exact.*version|unsupported.*pin/i },
  { name: 'leading zero', pin: '020.18.0', error: /exact.*version|unsupported.*pin/i },
  { name: 'path traversal', pin: '../../bin', error: /exact.*version|unsupported.*pin/i },
  { name: 'multiple pins', pin: '20.18.0\n22.0.0', error: /exact.*version|unsupported.*pin/i },
  { name: 'empty pin', pin: ' \n', error: /empty|exact.*version|unsupported.*pin/i },
  {
    name: 'unreadable project pin',
    pin: '20.18.0',
    unreadable: true,
    error: /\.nvmrc.*EACCES|EACCES.*\.nvmrc/,
  },
  {
    name: 'unreadable root pin',
    pin: '20.18.0',
    unreadable: true,
    rootPin: true,
    error: /\.nvmrc.*EACCES|EACCES.*\.nvmrc/,
  },
  {
    name: 'broken project pin symlink',
    brokenLink: true,
    error: /\.nvmrc.*ENOENT|ENOENT.*\.nvmrc/,
  },
]) {
  test(`start rejects ${scenario.name} without clearing logs or touching processes/ports`, async (t) => {
    const f = await fixture(t);
    const pinFile = path.join(scenario.rootPin ? f.root : f.project, '.nvmrc');
    if (scenario.brokenLink) fs.symlinkSync(path.join(f.root, 'missing-pin'), pinFile);
    else fs.writeFileSync(pinFile, scenario.pin);
    if (!scenario.rootPin) fs.writeFileSync(path.join(f.root, '.nvmrc'), '22.0.0');
    f.install('v22.0.0');
    if (scenario.tool) {
      const tool = path.join(f.install('v20.18.0'), scenario.tool);
      if (scenario.mode) fs.chmodSync(tool, scenario.mode);
      else {
        fs.unlinkSync(tool);
        if (scenario.directory) fs.mkdirSync(tool);
      }
    }
    if (scenario.unreadable) {
      const readFile = fs.readFileSync;
      t.mock.method(fs, 'readFileSync', (file, ...args) => {
        if (file === pinFile)
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        return readFile(file, ...args);
      });
    }
    const logFile = path.join(f.logs, 'test', 'out.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, 'previous logs\n');
    f.service.buffer.push('previous logs\n');
    await assert.rejects(f.service.start(), scenario.error);
    assert.equal(f.service.logTail(), 'previous logs\n');
    assert.equal(fs.readFileSync(logFile, 'utf8'), 'previous logs\n');
    assert.equal(f.spawns.length, 0);
    assert.equal(f.portCalls.length, 0);
    assert.equal(f.kills.length, 0);
    assert.equal(f.service.status, 'stopped');
    assert.equal(f.service.proc, null);
  });
}

for (const pin of ['lts/*', 'v22.0.0', '']) {
  test(`restart rejects ${JSON.stringify(pin)} before stopping the running process`, async (t) => {
    const f = await fixture(t);
    const pinFile = path.join(f.project, '.nvmrc');
    fs.writeFileSync(pinFile, '20.18.0');
    f.install('v20.18.0');
    await f.service.start();
    const proc = f.service.proc;
    const snapshot = f.service.snapshot();
    const logs = f.service.logTail();
    const logFile = path.join(f.logs, 'test', 'out.log');
    fs.writeFileSync(pinFile, pin);
    t.mock.method(globalThis, 'setTimeout', (callback) => queueMicrotask(callback));
    await assert.rejects(f.service.restart(), /\.nvmrc|executable/);
    assert.equal(f.kills.length, 0);
    assert.equal(f.spawns.length, 1);
    assert.equal(f.portCalls.length, 1);
    assert.equal(f.service.proc, proc);
    assert.deepEqual(f.service.snapshot(), snapshot);
    assert.equal(f.service.logTail(), logs);
    assert.equal(fs.readFileSync(logFile, 'utf8'), logs);
  });
}

test('restart selects the updated pin once before stopping and uses it for the new start', async (t) => {
  const f = await fixture(t, { customNvm: true });
  const pinFile = path.join(f.project, '.nvmrc');
  fs.writeFileSync(pinFile, '20.18.0');
  f.install('v20.18.0');
  const bin = f.install('v22.0.0');
  await f.service.start();
  fs.writeFileSync(pinFile, 'v22.0.0');
  t.mock.method(globalThis, 'setTimeout', (callback) => {
    fs.writeFileSync(pinFile, 'lts/*');
    queueMicrotask(callback);
  });
  assert.equal(await f.service.restart(), true);
  assert.equal(f.kills.length, 1);
  assert.equal(f.spawns.length, 2);
  assert.equal(f.portCalls.length, 2);
  assert.equal(f.spawns[1].options.env.PATH, `${bin}${path.delimiter}${process.env.PATH || ''}`);
  assert.match(f.service.logTail(), /Node v22\.0\.0/);
  assert.ok(f.service.logTail().includes(path.join(bin, 'node')));
  assert.doesNotMatch(f.service.logTail(), /Node v20\.18\.0|process exited/);
});

test('settings apply preserves live logs and children, rejects live and pending changes, and updates stopped definitions without operations', async (t) => {
  const f = await fixture(t);
  const definition = {
    id: 'app',
    label: 'Application',
    dir: 'project',
    command: ['npm', 'run', 'dev'],
    port: null,
  };
  const local = { root: f.root, services: [definition] };
  const manager = new f.Manager({ local, logsDir: f.logs });
  assert.deepEqual(
    manager.list().map(({ id }) => id),
    ['app'],
  );
  await manager.start('app');
  const before = manager.list();
  const logs = manager.logs('app', 0);
  const logPath = path.join(f.logs, 'app', 'out.log');
  const persistedLogs = fs.readFileSync(logPath, 'utf8');
  const counts = [f.spawns.length, f.portCalls.length, f.kills.length];
  for (const change of [
    { root: f.root, services: [] },
    { root: f.root, services: [{ ...definition, label: 'Renamed live service' }] },
    { root: f.root, services: [{ ...definition, command: ['node', 'other.js'] }] },
    { root: f.project, services: [definition] },
  ]) {
    await assert.rejects(manager.applySettings(change), (error) => error.code === 'SERVICE_IN_USE');
    assert.deepEqual(manager.list(), before);
    assert.equal(manager.logs('app', 0), logs);
    assert.equal(fs.readFileSync(logPath, 'utf8'), persistedLogs);
    assert.deepEqual([f.spawns.length, f.portCalls.length, f.kills.length], counts);
  }
  const added = { ...definition, id: 'second', label: 'Second' };
  await manager.applySettings({ root: f.root, services: [definition, added] });
  assert.deepEqual(
    manager.list().map(({ id, status }) => ({ id, status })),
    [
      { id: 'app', status: 'running' },
      { id: 'second', status: 'stopped' },
    ],
  );
  await manager.applySettings({
    root: f.root,
    services: [definition, { ...added, label: 'Updated stopped', command: ['node', 'index.js'] }],
  });
  assert.equal(manager.list().find(({ id }) => id === 'second').label, 'Updated stopped');
  await manager.applySettings(local);
  assert.deepEqual(manager.list(), before);
  assert.equal(manager.logs('app', 0), logs);
  assert.deepEqual([f.spawns.length, f.portCalls.length, f.kills.length], counts);
  let release;
  let reached;
  const waiting = new Promise((resolve) => {
    reached = resolve;
  });
  t.mock.method(childProcess, 'execFile', (_command, _args, callback) => {
    reached();
    release = () => callback(null, '');
  });
  syncBuiltinESMExports();
  const pendingDefinition = { ...added, id: 'pending', port: 12345 };
  await manager.applySettings({ root: f.root, services: [definition, pendingDefinition] });
  const pendingStart = manager.start('pending');
  await waiting;
  const racingApply = manager.applySettings({
    root: f.root,
    services: [definition, { ...pendingDefinition, label: 'Changed while starting' }],
  });
  release();
  await pendingStart;
  await assert.rejects(racingApply, (error) => error.code === 'SERVICE_IN_USE');
  assert.equal(manager.list().find(({ id }) => id === 'pending').label, 'Second');
  assert.equal(f.spawns.length, counts[0] + 1);
  assert.equal(f.kills.length, 0);
  assert.equal(manager.logs('app', 0), logs);
});

// Checkout picker: a repo's services run from a chosen git worktree.

function fakeCheckoutStore(initial = {}) {
  const entries = new Map(Object.entries(initial));
  const sets = [];
  return {
    sets,
    get: (main) => entries.get(main),
    set(main, checkout) {
      sets.push([main, checkout]);
      if (checkout === null) entries.delete(main);
      else entries.set(main, checkout);
    },
  };
}

const repoService = (id, dir, extra = {}) => ({
  id,
  label: id,
  dir,
  command: ['npm', 'run', 'dev'],
  port: null,
  ...extra,
});

// A worktree directory beside the fixture's project, with an optional pin of its own.
function makeWorktree(f, name, pin) {
  const dir = path.join(f.root, 'worktrees', name);
  fs.mkdirSync(dir, { recursive: true });
  if (pin !== undefined) fs.writeFileSync(path.join(dir, '.nvmrc'), pin);
  return dir;
}

// A real process exits after the signal, not inside process.kill: deliver the exit event later.
function deferExit(proc) {
  const emit = proc.emit.bind(proc);
  proc.emit = (event, ...args) => {
    if (event !== 'exit') return emit(event, ...args);
    setImmediate(() => emit(event, ...args));
    return true;
  };
}

// A process that never reports its exit.
function neverExit(proc) {
  const emit = proc.emit.bind(proc);
  proc.emit = (event, ...args) => (event === 'exit' ? true : emit(event, ...args));
}

test('checkout 7: start runs in the override with its own pin, and in the main checkout without one', async (t) => {
  const f = await fixture(t, { customNvm: true });
  fs.writeFileSync(path.join(f.project, '.nvmrc'), '20.18.0');
  f.install('v20.18.0');
  const worktree = makeWorktree(f, 'x', '22.0.0');
  const bin = f.install('v22.0.0');
  const plain = new f.Manager({
    local: { root: f.root, services: [repoService('plain', 'project')] },
    logsDir: f.logs,
  });
  const moved = new f.Manager({
    local: { root: f.root, services: [repoService('moved', 'project')] },
    logsDir: f.logs,
    checkouts: fakeCheckoutStore({ [f.project]: worktree }),
  });
  await plain.start('plain');
  await moved.start('moved');
  assert.equal(f.spawns[0].options.cwd, f.project);
  assert.equal(f.spawns[1].options.cwd, worktree);
  assert.equal(f.spawns[1].options.env.PATH, `${bin}${path.delimiter}${process.env.PATH || ''}`);
});

test('checkout 8: switching a repo moves every service of it and no other in the status', async (t) => {
  const f = await fixture(t);
  const local = {
    root: f.root,
    services: [
      repoService('be', 'Portage-backend'),
      repoService('queue', 'Portage-backend'),
      repoService('fe', 'Portage-frontend'),
    ],
  };
  const manager = new f.Manager({ local, logsDir: f.logs });
  const worktree = makeWorktree(f, 'feature');
  const byId = () => Object.fromEntries(manager.list().map((service) => [service.id, service]));
  assert.equal(byId().be.checkout, path.join(f.root, 'Portage-backend'));
  assert.equal(byId().be.checkoutLabel, null);
  await manager.switchCheckoutUnlocked('Portage-backend', worktree, { restart: false });
  for (const id of ['be', 'queue']) {
    assert.equal(byId()[id].checkout, worktree, id);
    assert.equal(byId()[id].checkoutLabel, 'feature', id);
  }
  assert.equal(byId().fe.checkout, path.join(f.root, 'Portage-frontend'));
  assert.equal(byId().fe.checkoutLabel, null);
});

test('checkout 9: a running repo is refused without restart and nothing changes', async (t) => {
  const f = await fixture(t);
  const store = fakeCheckoutStore();
  const manager = new f.Manager({
    local: { root: f.root, services: [repoService('be', 'project')] },
    logsDir: f.logs,
    checkouts: store,
  });
  await manager.start('be');
  const worktree = makeWorktree(f, 'x');
  await assert.rejects(
    manager.switchCheckoutUnlocked('project', worktree, { restart: false }),
    (error) => error.code === 'CHECKOUT_IN_USE' && error.status === 409,
  );
  assert.equal(f.kills.length, 0);
  assert.equal(f.spawns.length, 1);
  assert.deepEqual(store.sets, []);
  assert.equal(manager.list()[0].checkout, f.project);
});

test('checkout 10: a confirmed restart stops, awaits and respawns the running member only', async (t) => {
  const f = await fixture(t, { customNvm: true });
  f.install('v20.18.0');
  const worktree = makeWorktree(f, 'x', '20.18.0');
  const store = fakeCheckoutStore();
  const manager = new f.Manager({
    local: {
      root: f.root,
      services: [repoService('be', 'project'), repoService('queue', 'project')],
    },
    logsDir: f.logs,
    checkouts: store,
  });
  await manager.start('be');
  deferExit(f.spawns[0].proc);
  manager.services.be.buffer.push('old log line\n');
  const result = await manager.switchCheckoutUnlocked('project', worktree, { restart: true });
  assert.deepEqual(result.restarted, ['be']);
  assert.equal(f.kills.length, 1);
  assert.equal(f.spawns.length, 2);
  assert.equal(f.spawns[1].options.cwd, worktree);
  assert.doesNotMatch(manager.logs('be', 0), /old log line|process exited/);
  assert.deepEqual(store.sets, [[f.project, worktree]]);
  const byId = Object.fromEntries(manager.list().map((service) => [service.id, service]));
  assert.equal(byId.be.status, 'running');
  assert.equal(byId.be.checkout, worktree);
  assert.equal(byId.queue.status, 'stopped');
  assert.equal(byId.queue.checkout, worktree);
});

test('checkout 11: an unusable pin in the worktree leaves the running service alone', async (t) => {
  const f = await fixture(t);
  const store = fakeCheckoutStore();
  const manager = new f.Manager({
    local: { root: f.root, services: [repoService('be', 'project')] },
    logsDir: f.logs,
    checkouts: store,
  });
  await manager.start('be');
  const worktree = makeWorktree(f, 'x', 'lts/*');
  await assert.rejects(
    manager.switchCheckoutUnlocked('project', worktree, { restart: true }),
    (error) => error.code === 'CHECKOUT_UNUSABLE' && error.status === 422,
  );
  assert.equal(f.kills.length, 0);
  assert.equal(f.spawns.length, 1);
  assert.deepEqual(store.sets, []);
  assert.equal(manager.list()[0].checkout, f.project);
});

test('checkout 12: a process that will not exit blocks the switch after the wait', async (t) => {
  const f = await fixture(t);
  const store = fakeCheckoutStore();
  const manager = new f.Manager({
    local: { root: f.root, services: [repoService('be', 'project')] },
    logsDir: f.logs,
    checkouts: store,
  });
  await manager.start('be');
  neverExit(f.spawns[0].proc);
  const worktree = makeWorktree(f, 'x');
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const outcome = assert.rejects(
    manager.switchCheckoutUnlocked('project', worktree, { restart: true }),
    (error) => error.code === 'CHECKOUT_IN_USE' && error.status === 409,
  );
  for (let second = 0; second < 15; second += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(1000);
  }
  await outcome;
  assert.equal(f.spawns.length, 1);
  assert.deepEqual(store.sets, []);
  assert.equal(manager.list()[0].checkout, f.project);
});

test('checkout 10: a store that cannot save brings the stopped member back on the old checkout', async (t) => {
  const f = await fixture(t);
  const store = fakeCheckoutStore();
  store.set = () => {
    throw new Error('disk full');
  };
  const manager = new f.Manager({
    local: { root: f.root, services: [repoService('be', 'project')] },
    logsDir: f.logs,
    checkouts: store,
  });
  await manager.start('be');
  deferExit(f.spawns[0].proc);
  const worktree = makeWorktree(f, 'x');
  await assert.rejects(
    manager.switchCheckoutUnlocked('project', worktree, { restart: true }),
    (error) => error.code === 'PERSISTENCE_FAILED' && error.status === 503,
  );
  assert.equal(f.spawns.length, 2);
  assert.equal(f.spawns[1].options.cwd, f.project);
  assert.equal(manager.list()[0].status, 'running');
  assert.equal(manager.list()[0].checkout, f.project);
});

test('checkout 13: identical settings apply while an overridden service runs, a changed one does not', async (t) => {
  const f = await fixture(t);
  const definition = repoService('be', 'project');
  const local = { root: f.root, services: [definition] };
  const worktree = makeWorktree(f, 'x');
  const manager = new f.Manager({
    local,
    logsDir: f.logs,
    checkouts: fakeCheckoutStore({ [f.project]: worktree }),
  });
  await manager.start('be');
  await manager.applySettings(structuredClone(local));
  assert.equal(manager.list()[0].checkout, worktree);
  await assert.rejects(
    manager.applySettings({
      root: f.root,
      services: [{ ...definition, command: ['node', 'x.js'] }],
    }),
    (error) => error.code === 'SERVICE_IN_USE',
  );
});
