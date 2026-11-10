// browser-devtools.mjs — visible, CDP-attachable debug browsers.
//
// The DevTools tab launches a real Chromium-family window with
// `--remote-debugging-port`, so a human signs in and an agent attaches with
// `agent-browser connect <port>`. Playwright is deliberately not used: it owns
// the debugging port in its own argv, which would hide the port being read out.
//
// State lives in ~/.config/dev-dashboard/browsers/instances.json. A profile dir
// is kept across restarts and across stop, so a relaunch stays signed in.

import fsDefault from 'node:fs';
import netDefault from 'node:net';
import path from 'node:path';
import { spawn as spawnDefault } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileAtomic } from './credentials.mjs';

const PORT_FIRST = 9300;
const PORT_LAST = 9399;
const GRACE_MS = 3000;
const POLL_MS = 100;
const BINARIES = [
  'brave-browser',
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
];
const VERSION = 1;

function fail(code, message, status) {
  return Object.assign(new Error(message), { code, status });
}

const formatLabel = (id) => `Browser ${String(id).replace(/^b-/, '').slice(0, 4)}`;

// The root browser process is the only one carrying the debugging port; its
// renderers inherit `--user-data-dir` too, so matching that alone would pick the
// wrong pid and a Stop would signal a renderer.
function findLive(psOutput, profileDir) {
  const stem = `--user-data-dir=${profileDir}`;
  for (const line of String(psOutput || '').split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match || !match[2].includes('--remote-debugging-port=')) continue;
    const args = match[2];
    const at = args.indexOf(stem);
    if (at < 0) continue;
    const after = args.slice(at + stem.length, at + stem.length + 1);
    if (after && !/\s/.test(after)) continue;
    return { pid: Number(match[1]), args };
  }
  return null;
}

// argv of a live pid, or null when the pid is gone or owns something else.
function argvOf(psOutput, pid) {
  for (const line of String(psOutput || '').split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match && Number(match[1]) === pid) return match[2];
  }
  return null;
}

export function createBrowserDevtools({
  home = process.env.HOME || '',
  fs = fsDefault,
  env = process.env,
  net = netDefault,
  spawn = spawnDefault,
  kill = process.kill.bind(process),
  run = null,
  now = () => new Date(),
  randomId = () => `b-${randomBytes(4).toString('hex')}`,
} = {}) {
  const root = path.join(home, '.config', 'dev-dashboard', 'browsers');
  const stateFile = path.join(root, 'instances.json');
  const children = new Map();
  let reconciled = false;

  // `ps -eo pid=,args=` is the only source of truth for a live browser, because
  // the record outlives the process that spawned it.
  const ps =
    run ||
    (async () =>
      (await import('node:child_process')).execFileSync('ps', ['-eo', 'pid=,args='], {
        encoding: 'utf8',
      }));

  function readState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      return Array.isArray(parsed?.browsers) ? parsed.browsers : [];
    } catch {
      return [];
    }
  }

  function writeState(browsers) {
    writeFileAtomic(stateFile, JSON.stringify({ version: VERSION, browsers }, null, 2) + '\n', fs);
  }

  function resolveBinary() {
    const dirs = String(env.PATH || '')
      .split(path.delimiter)
      .filter(Boolean);
    for (const name of BINARIES)
      for (const dir of dirs) {
        const candidate = path.join(dir, name);
        try {
          fs.accessSync(candidate);
          return candidate;
        } catch {}
      }
    throw fail('BROWSER_NOT_FOUND', 'No Chromium-family browser on PATH.', 409);
  }

  function probePort(port) {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen({ port, host: '127.0.0.1' }, () => {
        server.close(() => resolve(true));
      });
    });
  }

  async function findFreePort() {
    for (let port = PORT_FIRST; port <= PORT_LAST; port += 1)
      if (await probePort(port)) return port;
    throw fail('NO_FREE_PORT', `No free debug port in ${PORT_FIRST}-${PORT_LAST}.`, 409);
  }

  async function start(browsers, record) {
    const binary = resolveBinary();
    const port = await findFreePort();
    const profileDir = record.profileDir;
    fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    const logPath = path.join(root, record.id, 'browser.log');
    const log = fs.openSync(logPath, 'a', 0o600);
    let child;
    try {
      child = spawn(
        binary,
        [
          `--remote-debugging-port=${port}`,
          `--user-data-dir=${profileDir}`,
          '--no-first-run',
          '--no-default-browser-check',
          record.url,
        ],
        { detached: true, stdio: ['ignore', log, log] },
      );
    } catch (error) {
      throw fail('LAUNCH_FAILED', error?.message || 'Could not start the browser.', 502);
    } finally {
      try {
        fs.closeSync(log);
      } catch {}
    }
    if (!child.pid) throw fail('LAUNCH_FAILED', 'The browser exited immediately.', 502);
    child.unref?.();
    children.set(record.id, child);
    const settle = () => {
      const current = readState();
      const found = current.find((entry) => entry.id === record.id);
      if (found && found.pid === child.pid) {
        found.status = 'stopped';
        found.pid = null;
        writeState(current);
      }
    };
    child.once?.('exit', settle);
    child.once?.('error', settle);
    record.port = port;
    record.pid = child.pid;
    record.startedAt = now().toISOString();
    record.status = 'running';
    if (!browsers.some((entry) => entry.id === record.id)) browsers.push(record);
    writeState(browsers);
    return record;
  }

  function normalizeUrl(input) {
    if (input === undefined || input === null || input === '') return 'about:blank';
    const value = String(input).trim();
    if (value === 'about:blank') return value;
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw fail('INVALID_URL', 'Enter an http or https URL.', 400);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      throw fail('INVALID_URL', 'Enter an http or https URL.', 400);
    return value;
  }

  function normalizeLabel(input, id) {
    const value = String(input ?? '')
      .trim()
      .slice(0, 60);
    return value || formatLabel(id);
  }

  // Adopt browsers that outlived the dashboard: a nodemon restart must not leave
  // a window running that nothing can stop.
  async function reconcile() {
    if (reconciled) return;
    reconciled = true;
    const browsers = readState();
    let dirty = false;
    let output = '';
    try {
      output = String((await ps()) || '');
    } catch {
      return;
    }
    for (const record of browsers) {
      const live = findLive(String(output), record.profileDir);
      if (live) {
        if (record.status !== 'running' || record.pid !== live.pid) {
          record.status = 'running';
          record.pid = live.pid;
          dirty = true;
        }
      } else if (record.status !== 'stopped' || record.pid !== null) {
        record.status = 'stopped';
        record.pid = null;
        dirty = true;
      }
    }
    for (const line of String(output).split('\n')) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!match || !match[2].includes(`${root}${path.sep}`)) continue;
      if (!match[2].includes('--remote-debugging-port=')) continue;
      const profileDir = new RegExp(
        `${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${path.sep}[^\\s]+${path.sep}profile`,
      ).exec(match[2]);
      if (!profileDir || browsers.some((entry) => entry.profileDir === profileDir[0])) continue;
      const portMatch = /--remote-debugging-port=(\d+)/.exec(match[2]);
      const url =
        match[2]
          .trim()
          .split(/\s+/)
          .filter((arg) => !arg.startsWith('-'))
          .pop() || 'about:blank';
      const id = path.basename(path.dirname(profileDir[0]));
      browsers.push({
        id,
        label: formatLabel(id),
        port: portMatch ? Number(portMatch[1]) : null,
        pid: Number(match[1]),
        profileDir: profileDir[0],
        url: /^(https?|about):/.test(url) ? url : 'about:blank',
        startedAt: now().toISOString(),
        status: 'running',
      });
      dirty = true;
    }
    if (dirty) writeState(browsers);
  }

  async function list() {
    await reconcile();
    return readState().sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  }

  async function launch({ label, url } = {}) {
    await reconcile();
    const browsers = readState();
    const id = randomId();
    const record = {
      id,
      label: normalizeLabel(label, id),
      port: null,
      pid: null,
      profileDir: path.join(root, id, 'profile'),
      url: normalizeUrl(url),
      startedAt: now().toISOString(),
      status: 'stopped',
    };
    await start(browsers, record);
    return record;
  }

  async function startById(id) {
    await reconcile();
    const browsers = readState();
    const record = browsers.find((entry) => entry.id === id);
    if (!record) throw fail('UNKNOWN_BROWSER', 'Unknown browser.', 404);
    if (record.status === 'running') return record;
    await start(browsers, record);
    return record;
  }

  async function stop(id) {
    await reconcile();
    const browsers = readState();
    const record = browsers.find((entry) => entry.id === id);
    if (!record) throw fail('UNKNOWN_BROWSER', 'Unknown browser.', 404);
    const pid = record.pid;
    if (record.status === 'running' && pid) {
      let output = '';
      try {
        output = String((await ps()) || '');
      } catch {}
      // Never signal a recycled pid: it must still own this profile dir.
      if ((argvOf(output, pid) || '').includes(record.profileDir)) {
        const signal = (name) => {
          try {
            kill(-pid, name);
          } catch {
            try {
              kill(pid, name);
            } catch {}
          }
        };
        signal('SIGTERM');
        for (let waited = 0; waited < GRACE_MS; waited += POLL_MS) {
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
          let current = '';
          try {
            current = String((await ps()) || '');
          } catch {}
          if (!argvOf(current, pid)) break;
        }
        let stillThere = '';
        try {
          stillThere = String((await ps()) || '');
        } catch {}
        if (argvOf(stillThere, pid)) signal('SIGKILL');
      }
    }
    children.delete(id);
    record.status = 'stopped';
    record.pid = null;
    writeState(browsers);
    return record;
  }

  // Remove is the only path that deletes a profile: Stop keeps it so Start stays
  // signed in, but a row nobody wants should not leave a profile behind.
  async function remove(id) {
    await reconcile();
    const record = readState().find((entry) => entry.id === id);
    if (!record) throw fail('UNKNOWN_BROWSER', 'Unknown browser.', 404);
    if (record.status === 'running' && record.pid) await stop(id);
    fs.rmSync(path.dirname(record.profileDir), { recursive: true, force: true });
    writeState(readState().filter((entry) => entry.id !== id));
    return { id };
  }

  return { list, launch, start: startById, stop, remove };
}
