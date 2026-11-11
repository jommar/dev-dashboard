// browser-devtools.test.mjs — the launch/stop/reconcile contract for the DevTools tab.
// Every collaborator that could touch the machine is injected: nothing here spawns a
// process, binds a real port or signals a real pid.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBrowserDevtools, DEFAULT_DEVTOOLS_URL } from '../backend/browser-devtools.mjs';

const NOW = new Date('2026-11-11T09:12:31.004Z');
// Headless is the default: a visible window steals the desktop focus while agents drive the browser.
// `headed: true` opts into a real window.
const HEADLESS = '--headless=new';

function harness({ taken = [], ps = '', env } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devtools-'));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  for (const name of [
    'brave-browser',
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
  ])
    fs.writeFileSync(path.join(bin, name), '');
  const reserved = new Set(taken);
  const bound = new Set();
  let held = null;
  const spawns = [];
  const signals = [];
  let psOutput = ps;
  let n = 0;
  const devtools = createBrowserDevtools({
    home,
    fs,
    env: env ?? { PATH: bin },
    net: {
      createServer() {
        const handlers = {};
        return {
          once(event, fn) {
            handlers[event] = fn;
          },
          listen({ port }, ready) {
            setImmediate(() => {
              if (reserved.has(port) || bound.has(port))
                return handlers.error?.(new Error('EADDRINUSE'));
              held = port;
              bound.add(port);
              ready();
            });
          },
          close(done) {
            if (held !== null) bound.delete(held);
            held = null;
            done?.();
          },
        };
      },
    },
    spawn(binary, args) {
      const child = {
        pid: 4000 + spawns.length + 1,
        exits: [],
        once(event, listener) {
          if (event === 'exit') this.exits.push(listener);
        },
        unref() {},
      };
      spawns.push({ binary, args, child });
      return child;
    },
    kill(pid, signal) {
      signals.push({ pid, signal });
    },
    run: async () => psOutput,
    now: () => NOW,
    randomId: () => `b-0000${++n}`,
  });
  return {
    devtools,
    home,
    root: path.join(home, '.config', 'dev-dashboard', 'browsers'),
    spawns,
    signals,
    setPs(value) {
      psOutput = value;
    },
  };
}

test('allocates the first free port and spawns the required browser', async () => {
  const h = harness({ taken: [9300, 9301] });
  const browser = await h.devtools.launch({ label: 'QA', url: 'https://example.invalid/login' });
  assert.equal(browser.port, 9302);
  assert.equal(browser.status, 'running');
  assert.equal(browser.label, 'QA');
  assert.equal(browser.profileDir, path.join(h.root, 'b-00001', 'profile'));
  assert.equal(h.spawns.length, 1);
  assert.equal(h.spawns[0].binary, path.join(h.home, 'bin', 'brave-browser'));
  // The headless flag has its own test below; its position is not part of this contract.
  assert.deepEqual(
    h.spawns[0].args.filter((arg) => arg !== HEADLESS),
    [
      '--remote-debugging-port=9302',
      `--user-data-dir=${browser.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      'https://example.invalid/login',
    ],
  );
  assert.ok(fs.statSync(browser.profileDir).isDirectory());
  assert.deepEqual(await h.devtools.list(), [browser]);
});

test('defaults the label and URL, and refuses without spawning', async () => {
  const h = harness();
  const browser = await h.devtools.launch({});
  assert.equal(DEFAULT_DEVTOOLS_URL, 'https://traveltrackertrips.transact.com:8443/admin#/');
  assert.equal(browser.url, DEFAULT_DEVTOOLS_URL);
  assert.equal(h.spawns[0].args.at(-1), DEFAULT_DEVTOOLS_URL);
  assert.equal(browser.label, 'Browser 0000');

  await assert.rejects(h.devtools.launch({ url: '--remote-debugging-port=1' }), {
    code: 'INVALID_URL',
    status: 400,
  });
  assert.equal(h.spawns.length, 1, 'a refused launch never spawns');
});

test('an explicit about:blank still launches about:blank', async () => {
  const h = harness();
  const browser = await h.devtools.launch({ url: 'about:blank' });
  assert.equal(browser.url, 'about:blank');
  assert.equal(h.spawns[0].args.at(-1), 'about:blank');
});

test('refuses NO_FREE_PORT and BROWSER_NOT_FOUND without spawning', async () => {
  const taken = [];
  for (let port = 9300; port <= 9399; port += 1) taken.push(port);
  const full = harness({ taken });
  await assert.rejects(full.devtools.launch({}), { code: 'NO_FREE_PORT', status: 409 });
  assert.deepEqual(full.spawns, []);

  const bare = harness({ env: { PATH: path.join(os.tmpdir(), 'devtools-empty-path') } });
  await assert.rejects(bare.devtools.launch({}), { code: 'BROWSER_NOT_FOUND', status: 409 });
  assert.deepEqual(bare.spawns, []);
});

test('stops then starts on the same profile, signalling the group', async () => {
  const h = harness();
  const browser = await h.devtools.launch({ label: 'Keep', url: 'https://example.invalid/' });
  h.setPs(
    `  ${browser.pid} /bin/brave-browser --remote-debugging-port=9300 --user-data-dir=${browser.profileDir}`,
  );

  const stopped = await h.devtools.stop(browser.id);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.pid, null);
  assert.deepEqual(
    h.signals.map((entry) => entry.signal),
    ['SIGTERM', 'SIGKILL'],
    'a pid that survives the grace period is killed',
  );
  assert.equal(h.signals[0].pid, -browser.pid, 'the process group is signalled');
  assert.ok(fs.statSync(browser.profileDir).isDirectory(), 'stop keeps the profile');

  h.setPs('');
  const restarted = await h.devtools.start(browser.id);
  assert.equal(restarted.status, 'running');
  assert.equal(restarted.port, 9300);
  assert.equal(restarted.profileDir, browser.profileDir);
});

test('reconciles a surviving browser, a dead record and an unknown profile dir', async () => {
  const h = harness();
  const browser = await h.devtools.launch({ label: 'Survivor' });
  const stateFile = path.join(h.root, 'instances.json');
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  saved.browsers[0].status = 'stopped';
  saved.browsers[0].pid = null;
  fs.writeFileSync(stateFile, JSON.stringify(saved));

  // A fresh factory over the same home, so reconcile actually runs again.
  const revive = (stdout) =>
    createBrowserDevtools({
      home: h.home,
      fs,
      env: { PATH: path.join(h.home, 'bin') },
      run: async () => stdout,
      now: () => NOW,
    });

  const adopted = await revive(
    `  7777 /bin/brave-browser --remote-debugging-port=9300 --user-data-dir=${browser.profileDir}`,
  ).list();
  assert.equal(adopted[0].status, 'running');
  assert.equal(adopted[0].pid, 7777);

  const dead = await revive('').list();
  assert.equal(dead[0].status, 'stopped');
  assert.equal(dead[0].pid, null);

  const unknownDir = path.join(h.root, 'b-9', 'profile');
  const unknown = await revive(
    `  8888 /bin/brave-browser --remote-debugging-port=9311 --user-data-dir=${unknownDir}`,
  ).list();
  const record = unknown.find((entry) => entry.id === 'b-9');
  assert.ok(record, 'an unknown profile dir is adopted');
  assert.equal(record.port, 9311);
  assert.equal(record.status, 'running');
  assert.equal(record.pid, 8888);
});

test('never signals a recycled pid and never deletes a profile', async () => {
  const h = harness();
  const browser = await h.devtools.launch({ label: 'Recycled' });
  h.setPs(`  ${browser.pid} /usr/bin/something-else --unrelated`);

  const stopped = await h.devtools.stop(browser.id);
  assert.deepEqual(h.signals, [], 'a pid that no longer owns the profile is left alone');
  assert.equal(stopped.status, 'stopped');
  assert.ok(fs.statSync(browser.profileDir).isDirectory(), 'the profile survives the stop');
});

test('reconcile ignores a renderer that only inherits the profile dir', async () => {
  const h = harness();
  const browser = await h.devtools.launch({ label: 'Root only' });
  const root = harness({ ps: '' });
  const file = path.join(root.root, 'instances.json');
  fs.mkdirSync(root.root, { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ version: 1, browsers: [{ ...browser, status: 'stopped', pid: null }] }),
  );
  fs.mkdirSync(browser.profileDir, { recursive: true });

  const rendererOnly = createBrowserDevtools({
    home: h.home,
    fs,
    env: { PATH: path.join(h.home, 'bin') },
    run: async () =>
      `  5150 /bin/brave-browser --type=renderer --user-data-dir=${browser.profileDir}`,
    now: () => NOW,
  });
  const listed = await rendererOnly.list();
  assert.equal(listed[0].status, 'stopped', 'a renderer is not the browser');
  assert.equal(listed[0].pid, null);
});

test('removes a record and its profile, but refuses an unknown id', async () => {
  const h = harness();
  const browser = await h.devtools.launch({ label: 'Tidy' });
  h.setPs('');

  await assert.rejects(h.devtools.remove('b-nope'), { code: 'UNKNOWN_BROWSER', status: 404 });

  await h.devtools.remove(browser.id);
  assert.deepEqual(await h.devtools.list(), []);
  assert.equal(
    fs.existsSync(path.dirname(browser.profileDir)),
    false,
    'removing a row reclaims its profile',
  );
});

test('removing a running browser stops it first', async () => {
  const h = harness();
  const browser = await h.devtools.launch({ label: 'Running' });
  h.setPs(
    `  ${browser.pid} /bin/brave-browser --remote-debugging-port=9300 --user-data-dir=${browser.profileDir}`,
  );

  await h.devtools.remove(browser.id);
  assert.ok(
    h.signals.some((entry) => entry.signal === 'SIGTERM'),
    'an attached browser is not left running',
  );
  assert.deepEqual(await h.devtools.list(), []);
});

test('tells listeners when a browser stops, is removed or exits, and not after they leave', async () => {
  const h = harness();
  const stopped = [];
  const leave = h.devtools.onStopped((id) => stopped.push(id));
  const first = await h.devtools.launch({ label: 'One' });
  const second = await h.devtools.launch({ label: 'Two' });
  const third = await h.devtools.launch({ label: 'Three' });
  h.setPs('');
  assert.deepEqual(stopped, [], 'launching is not stopping');

  await h.devtools.stop(first.id);
  assert.deepEqual(stopped, [first.id]);

  await h.devtools.remove(second.id);
  assert.deepEqual(stopped, [first.id, second.id]);

  // The child exiting under us, which is how a browser closed from its own window ends.
  h.spawns[2].child.exits.forEach((listener) => listener());
  assert.deepEqual(stopped, [first.id, second.id, third.id]);

  leave();
  await h.devtools.stop(third.id);
  assert.equal(stopped.length, 3, 'a listener that left hears nothing more');
});

test('a late exit of a replaced child does not announce the restarted browser as stopped', async () => {
  const h = harness();
  const stopped = [];
  h.devtools.onStopped((id) => stopped.push(id));
  const browser = await h.devtools.launch({ label: 'Restarted' });
  h.setPs('');
  await h.devtools.stop(browser.id);
  await h.devtools.start(browser.id);
  stopped.length = 0;
  h.spawns[0].child.exits.forEach((listener) => listener());
  assert.deepEqual(stopped, [], 'the old process is not the running one');
});

const headlessFlags = (args) => args.filter((arg) => arg.startsWith('--headless'));
const savedBrowsers = (h) =>
  JSON.parse(fs.readFileSync(path.join(h.root, 'instances.json'), 'utf8')).browsers;

test('launches headless by default, beside the debugging port and the profile, URL still last', async () => {
  const h = harness({ taken: [9300] });
  // The e2e dialog's launch goes through the same call, with a label and a URL.
  const e2e = await h.devtools.launch({
    label: 'E2E TAP-9001',
    url: 'https://example.invalid/app',
  });
  const { args } = h.spawns[0];
  assert.deepEqual(headlessFlags(args), [HEADLESS], 'exactly one headless flag, the new mode');
  assert.ok(args.includes(`--remote-debugging-port=${e2e.port}`));
  assert.ok(args.includes(`--user-data-dir=${e2e.profileDir}`));
  assert.equal(args.at(-1), 'https://example.invalid/app');

  // No options, and an explicit headed:false, are the same default.
  await h.devtools.launch({});
  await h.devtools.launch({ headed: false });
  for (const spawned of h.spawns.slice(1))
    assert.deepEqual(headlessFlags(spawned.args), [HEADLESS]);
});

test('headed: true launches a normal window, with no headless flag at all', async () => {
  const h = harness();
  const browser = await h.devtools.launch({ label: 'Window', headed: true });
  const { args } = h.spawns[0];
  assert.deepEqual(headlessFlags(args), []);
  assert.ok(args.includes(`--remote-debugging-port=${browser.port}`));
  assert.ok(args.includes(`--user-data-dir=${browser.profileDir}`));
  assert.equal(args.at(-1), DEFAULT_DEVTOOLS_URL);
});

test('a headed that is not a boolean is refused 400 without spawning or saving a record', async () => {
  const h = harness();
  for (const headed of ['true', 'yes', 1, 0, null, {}, []])
    await assert.rejects(
      h.devtools.launch({ label: 'Bad', headed }),
      { code: 'INVALID_HEADED', status: 400 },
      JSON.stringify(headed),
    );
  assert.deepEqual(h.spawns, []);
  assert.deepEqual(await h.devtools.list(), []);
});

test('the mode is stored as headed: true only when true, and a relaunch keeps it', async () => {
  const h = harness();
  const plain = await h.devtools.launch({ label: 'Plain' });
  const explicit = await h.devtools.launch({ label: 'Explicit', headed: false });
  const shown = await h.devtools.launch({ label: 'Shown', headed: true });
  assert.equal(shown.headed, true);
  for (const record of [plain, explicit])
    assert.ok(!('headed' in record), 'a headless record carries no headed field');
  const saved = savedBrowsers(h);
  assert.equal(saved.find((entry) => entry.id === shown.id).headed, true);
  for (const record of [plain, explicit])
    assert.ok(!('headed' in saved.find((entry) => entry.id === record.id)));

  // Stop then start of the same id: a headed browser stays headed, the others stay headless.
  for (const record of [plain, shown]) {
    h.setPs('');
    await h.devtools.stop(record.id);
    await h.devtools.start(record.id);
  }
  const [, , , relaunchedPlain, relaunchedShown] = h.spawns;
  assert.deepEqual(headlessFlags(relaunchedPlain.args), [HEADLESS]);
  assert.deepEqual(headlessFlags(relaunchedShown.args), []);
  assert.equal(savedBrowsers(h).find((entry) => entry.id === shown.id).headed, true);
});

test('a record saved without the field (before this option) relaunches headless', async () => {
  const h = harness();
  const browser = await h.devtools.launch({ label: 'Old' });
  const stateFile = path.join(h.root, 'instances.json');
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  delete saved.browsers[0].headed;
  saved.browsers[0].status = 'stopped';
  saved.browsers[0].pid = null;
  fs.writeFileSync(stateFile, JSON.stringify(saved));
  h.setPs('');
  await h.devtools.start(browser.id);
  assert.deepEqual(headlessFlags(h.spawns.at(-1).args), [HEADLESS]);
  // Only the exact boolean true opens a window: a tampered stored value stays headless.
  for (const tampered of ['false', 1, {}]) {
    await h.devtools.stop(browser.id);
    const edited = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    edited.browsers[0].headed = tampered;
    fs.writeFileSync(stateFile, JSON.stringify(edited));
    await h.devtools.start(browser.id);
    assert.deepEqual(headlessFlags(h.spawns.at(-1).args), [HEADLESS], JSON.stringify(tampered));
  }
});

test('a headless browser is still found, adopted, stopped and relaunched by its argv', async () => {
  const h = harness();
  const browser = await h.devtools.launch({ label: 'Headless' });
  const argv = (pid) =>
    `  ${pid} /bin/brave-browser ${HEADLESS} --remote-debugging-port=9300 --user-data-dir=${browser.profileDir} --no-first-run about:blank`;

  // Stop recognises it (argv-of-pid) and signals the group.
  h.setPs(argv(browser.pid));
  const stopped = await h.devtools.stop(browser.id);
  assert.equal(stopped.status, 'stopped');
  assert.equal(h.signals[0].pid, -browser.pid, 'the headless process group is signalled');

  // Reconcile adopts a survivor, reading its pid and port from the headless argv.
  const revive = (stdout) =>
    createBrowserDevtools({
      home: h.home,
      fs,
      env: { PATH: path.join(h.home, 'bin') },
      run: async () => stdout,
      now: () => NOW,
    });
  const adopted = await revive(argv(7777)).list();
  assert.equal(adopted[0].status, 'running');
  assert.equal(adopted[0].pid, 7777);
  assert.equal(adopted[0].port, 9300);

  // A headless profile dir nobody recorded is adopted with its port.
  const unknownDir = path.join(h.root, 'b-9', 'profile');
  const unknown = await revive(
    `  8888 /bin/brave-browser ${HEADLESS} --remote-debugging-port=9311 --user-data-dir=${unknownDir}`,
  ).list();
  const record = unknown.find((entry) => entry.id === 'b-9');
  assert.equal(record.port, 9311);
  assert.equal(record.pid, 8888);

  // Its headless renderer inherits the profile but carries no debugging port: not the browser.
  const rendererOnly = await revive(
    `  5150 /bin/brave-browser ${HEADLESS} --type=renderer --user-data-dir=${browser.profileDir}`,
  ).list();
  assert.equal(rendererOnly.find((entry) => entry.id === browser.id).pid, null);

  // And a stopped one relaunches.
  h.setPs('');
  const restarted = await h.devtools.start(browser.id);
  assert.equal(restarted.status, 'running');
});
