// manager.mjs — spawns each configured service as an independent child process,
// captures its stdout+stderr into a per-service rolling ring buffer, writes the
// recent tail to a file (agent-readable), and exposes start/stop/restart.
//
// Zero external deps: node:child_process, node:fs, node:path, node:os.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SERVICES, REPOS_ROOT, LOGS_DIR, BUFFER_BYTES, withoutSecrets } from './config.mjs';
import { freePort } from './port.mjs';

// ── rolling ring buffer ────────────────────────────────────────────
// A fixed-size byte buffer. We append lines and discard the oldest once
// we exceed BUFFER_BYTES. Kept as a plain array of strings; we track the
// byte size by summing the utf8 byte lengths.
class RingBuffer {
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
    this.lines = [];
    this.bytes = 0;
  }

  push(line) {
    const size = Buffer.byteLength(line, 'utf8');
    if (size > this.maxBytes) {
      // Single line larger than the whole buffer: clamp to the tail.
      this.lines = [this.#tailOf(line, this.maxBytes)];
      this.bytes = Buffer.byteLength(this.lines[0], 'utf8');
      return;
    }
    this.lines.push(line);
    this.bytes += size;
    while (this.bytes > this.maxBytes && this.lines.length > 1) {
      const dropped = this.lines.shift();
      this.bytes -= Buffer.byteLength(dropped, 'utf8');
    }
  }

  // Return the last n lines, or all lines if n is null/0/negative.
  tail(n) {
    if (!n || n < 0 || n >= this.lines.length) {
      return this.lines.slice();
    }
    return this.lines.slice(-n);
  }

  clear() {
    this.lines = [];
    this.bytes = 0;
  }

  // Keep the trailing bytes of an oversized line, starting on a character boundary.
  #tailOf(line, maxBytes) {
    const bytes = Buffer.from(line, 'utf8');
    let start = Math.max(0, bytes.length - maxBytes);
    while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
    return bytes.subarray(start).toString('utf8');
  }
}

// How long a checkout switch waits for a stopped service to exit before giving up.
const STOP_WAIT_MS = 10_000;
// How long a stopped process gets after SIGTERM before it is sent SIGKILL.
const STOP_GRACE_MS = 5000;
// Output is written to disk and broadcast at most once per window (leading and trailing).
const PERSIST_THROTTLE_MS = 250;

// A checkout store that forgets on exit, for a Manager built without a file-backed one.
function memoryCheckoutStore() {
  const entries = new Map();
  return {
    get: (main) => entries.get(main),
    set(main, checkout) {
      if (checkout === null) entries.delete(main);
      else entries.set(main, checkout);
    },
  };
}

// ── per-service process wrapper ────────────────────────────────────
export class ServiceProcess {
  constructor(def, { root = REPOS_ROOT, logsDir = LOGS_DIR, checkout = null } = {}) {
    this.def = def;
    this.root = root;
    this.logsDir = logsDir;
    this.checkout = checkout; // the worktree this service runs from; null is the main checkout
    this.id = def.id;
    this.buffer = new RingBuffer(BUFFER_BYTES);
    this.proc = null;
    this.closing = false; // set by Manager.stopAll: no start may spawn after shutdown began
    this.status = 'stopped'; // stopped | running | exited
    this.exitCode = null;
    this.startedAt = null;
    this.lastLineAt = null;
  }

  mainCheckout() {
    return path.resolve(this.root, this.def.dir);
  }

  cwd() {
    return this.checkout ?? this.mainCheckout();
  }

  hasNodeModules() {
    // A proxy for "install has been run"; only a warning, not a hard block.
    return fs.existsSync(path.join(this.cwd(), 'node_modules'));
  }

  // Pick the node version to use. Prefers the project .nvmrc, falls back to
  // the monorepo root .nvmrc, then the current node.
  nvmrc() {
    for (const dir of [this.cwd(), this.root]) {
      const file = path.join(dir, '.nvmrc');
      try {
        fs.lstatSync(file);
      } catch (err) {
        if (err.code === 'ENOENT') continue;
        throw new Error(`Cannot inspect ${file}: ${err.code}`, { cause: err });
      }
      try {
        return fs.readFileSync(file, 'utf8').trim();
      } catch (err) {
        throw new Error(`Cannot read ${file}: ${err.code}`, { cause: err });
      }
    }
    return null;
  }

  #nodeRuntime() {
    const env = withoutSecrets(process.env);
    const pin = this.nvmrc();
    if (pin === null) return { env };
    if (!/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(pin)) {
      throw new Error(
        `Unsupported .nvmrc pin ${JSON.stringify(pin)}: expected an exact Node version such as 20.18.0 or v20.18.0`,
      );
    }
    const version = `v${pin.replace(/^v/, '')}`;
    const nvmDir = process.env.NVM_DIR || path.join(os.homedir(), '.nvm');
    const bin = path.resolve(nvmDir, 'versions', 'node', version, 'bin');
    for (const tool of ['node', 'npm']) {
      const file = path.join(bin, tool);
      try {
        if (!fs.statSync(file).isFile()) throw new Error('not a file');
        fs.accessSync(file, fs.constants.X_OK);
      } catch (err) {
        throw new Error(`Node ${version} requires executable ${file}: ${err.code || err.message}`, {
          cause: err,
        });
      }
    }
    env.PATH = `${bin}${path.delimiter}${env.PATH || ''}`;
    return { env, version, nodePath: path.join(bin, 'node') };
  }

  inspectRuntime() {
    const runtime = this.#nodeRuntime();
    const cwd = this.cwd();
    if (!fs.statSync(cwd).isDirectory()) throw new Error('Invalid working directory');
    fs.accessSync(cwd, fs.constants.R_OK | fs.constants.X_OK);
    const tools = new Set(['node', 'npm', this.def.command[0]]);
    for (const tool of tools) {
      const candidates = tool.includes('/')
        ? [path.resolve(cwd, tool)]
        : (runtime.env.PATH || '')
            .split(path.delimiter)
            .map((dir) => path.resolve(dir || cwd, tool));
      if (
        !candidates.some((file) => {
          try {
            fs.accessSync(file, fs.constants.X_OK);
            return fs.statSync(file).isFile();
          } catch {
            return false;
          }
        })
      )
        throw new Error('Configured executable is unavailable');
    }
    return {
      ok: true,
      cwd,
      ...runtime,
      warnings: this.hasNodeModules() ? [] : ['node_modules missing'],
    };
  }

  runtimeIdentity() {
    const runtime = this.#nodeRuntime();
    return JSON.stringify([this.cwd(), runtime.env.PATH, runtime.version]);
  }

  async start() {
    if (this.proc) return false; // already running
    return this.#start(this.#nodeRuntime());
  }

  async #start({ env, version, nodePath }) {
    if (this.proc || this.closing) return false;
    const dir = this.cwd();

    // Fresh logs on every start/restart so the previous run's output (and any
    // '[dashboard] process exited' note) doesn't linger in the tail or file.
    this.clearLogs();
    const [cmd, ...args] = this.def.command;

    // Free this service's port first so the dashboard can take over a port the
    // app is already running on (e.g. from a run.sh session in another terminal).
    if (typeof this.def.port === 'number') {
      await freePort(this.def.port);
      if (this.closing) return false; // shutdown began while the port was being freed
    }

    // `npm`/`node` are resolved from PATH (now pointing at the pinned version).
    this.proc = spawn(cmd, args, { cwd: dir, env, detached: true });

    this.status = 'running';
    this.exitCode = null;
    this.startedAt = Date.now();

    this.proc.stdout?.on('data', (chunk) => this.#write(chunk));
    this.proc.stderr?.on('data', (chunk) => this.#write(chunk));

    this.proc.on('error', (err) => {
      const missing = err.code === 'ENOENT' && !fs.existsSync(dir) ? ` (no directory ${dir})` : '';
      this.#write(`[dashboard] spawn error: ${err.message}${missing}\n`);
      this.status = 'exited';
      this.exitCode = err.code ?? 1;
      this.proc = null;
    });

    this.proc.on('exit', (code, signal) => {
      this.status = 'exited';
      this.exitCode = code ?? (signal ? `signal:${signal}` : 1);
      this.#write(`[dashboard] process exited (${code ?? ''} ${signal ?? ''})\n`);
      this.proc = null;
      this.#flush();
    });

    // One write, so the first persisted file already holds both header lines.
    this.#write(
      (version ? `[dashboard] Node ${version}: ${nodePath}\n` : '') +
        `[dashboard] started (${cmd} ${args.join(' ')})\n`,
    );
    return true;
  }

  #write(chunk) {
    const text = chunk.toString('utf8');
    for (const line of text.split('\n')) {
      if (line === '' && text.endsWith('\n') === false) continue;
      this.buffer.push(line + (line === '' ? '' : '\n'));
    }
    this.lastLineAt = Date.now();
    if (this.#throttleTimer) {
      this.#pending = true;
      return;
    }
    this.#publish();
    this.#armThrottle();
  }

  // Leading+trailing throttle: the first write publishes at once, a burst coalesces into one
  // trailing publish when the window ends, and a quiet window releases the timer.
  #throttleTimer = null;
  #pending = false;
  #armThrottle() {
    this.#throttleTimer = setTimeout(() => {
      this.#throttleTimer = null;
      if (!this.#pending) return;
      this.#pending = false;
      this.#publish();
      this.#armThrottle();
    }, PERSIST_THROTTLE_MS);
    this.#throttleTimer?.unref?.();
  }

  #publish() {
    this.#persist();
    if (this.onUpdate) this.onUpdate(this.id);
  }

  // Publish a pending trailing write now (exit, stop).
  #flush() {
    if (!this.#pending) return;
    clearTimeout(this.#throttleTimer);
    this.#throttleTimer = null;
    this.#pending = false;
    this.#publish();
  }

  #persist() {
    // Write the full rolling buffer so the agent can grep/read it. Best effort: the logs dir
    // may be missing or unwritable, and that must never crash the manager.
    try {
      const dir = path.join(this.logsDir, this.id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'out.log'), this.buffer.tail().join(''));
    } catch {
      // ignore
    }
  }

  // Wipe the in-memory rolling buffer and the persisted tail file; a pending write is dropped.
  clearLogs() {
    clearTimeout(this.#throttleTimer);
    this.#throttleTimer = null;
    this.#pending = false;
    this.buffer.clear();
    const file = path.join(this.logsDir, this.id, 'out.log');
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // best effort; ignore
    }
  }

  // Signal the whole process group (detached children share it).
  #signal(proc, name) {
    try {
      process.kill(-proc.pid, name);
    } catch {
      try {
        proc.kill(name);
      } catch {
        /* already gone */
      }
    }
  }

  stop() {
    if (!this.proc) return false;
    this.#flush();
    this.#signal(this.proc, 'SIGTERM');
    return true;
  }

  // Stop and resolve true once the process has exited; false when it is still running after
  // `timeoutMs`. A process that ignores SIGTERM is sent SIGKILL after `killAfterMs`.
  stopAndWait(timeoutMs, { killAfterMs = STOP_GRACE_MS } = {}) {
    const proc = this.proc;
    if (!proc) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (exited) => {
        settled = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        proc.off('exit', onExit);
        resolve(exited);
      };
      const onExit = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      const killTimer = setTimeout(() => {
        if (!settled) this.#signal(proc, 'SIGKILL');
      }, killAfterMs);
      proc.once('exit', onExit);
      this.stop();
    });
  }

  // Resolves false, without starting a second process, when the old one will not stop.
  async restart() {
    // Reject configuration errors before interrupting the existing process.
    const runtime = this.#nodeRuntime();
    if (!(await this.stopAndWait(STOP_WAIT_MS))) return false;
    await this.#start(runtime);
    return true;
  }

  snapshot() {
    return {
      id: this.id,
      label: this.def.label,
      status: this.status,
      exitCode: this.exitCode,
      port: this.def.port ?? null,
      dir: this.def.dir,
      checkout: this.cwd(),
      checkoutLabel: this.checkout ? path.basename(this.checkout) : null,
      startedAt: this.startedAt,
      lastLineAt: this.lastLineAt,
      lineCount: this.buffer.lines.length,
    };
  }

  logTail(lines) {
    return this.buffer.tail(lines).join('');
  }
}

// ── manager ────────────────────────────────────────────────────────
export class Manager {
  constructor({
    local = { root: REPOS_ROOT, services: Object.values(SERVICES) },
    logsDir = LOGS_DIR,
    checkouts = memoryCheckoutStore(),
  } = {}) {
    this.local = structuredClone(local);
    this.logsDir = logsDir;
    this.checkouts = checkouts;
    this.queue = Promise.resolve();
    this.services = Object.create(null);
    for (const def of local.services) {
      this.services[def.id] = this.buildService(def, local.root);
    }
    fs.mkdirSync(logsDir, { recursive: true });
    this.onUpdate = null;
    for (const svc of Object.values(this.services)) {
      svc.onUpdate = (id) => {
        if (this.onUpdate) this.onUpdate(id);
      };
    }
  }

  // A service that runs from its repo's stored checkout, or the main one when none is stored.
  buildService(def, root) {
    const checkout = this.checkouts.get(path.resolve(root, def.dir)) ?? null;
    return new ServiceProcess(def, { root, logsDir: this.logsDir, checkout });
  }

  withSettingsLock(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  checkSettings(local) {
    for (const svc of Object.values(this.services)) {
      const definition = local.services.find((def) => def.id === svc.id);
      if (!svc.proc && !svc.pending) continue;
      let changed =
        !definition ||
        JSON.stringify(definition) !== JSON.stringify(svc.def) ||
        path.resolve(local.root, definition.dir) !== svc.mainCheckout();
      if (!changed && local.root !== svc.root) {
        try {
          const next = this.buildService(definition, local.root);
          changed = next.runtimeIdentity() !== svc.runtimeIdentity();
        } catch {
          changed = true;
        }
      }
      if (changed)
        throw Object.assign(new Error('Running or pending service cannot change.'), {
          code: 'SERVICE_IN_USE',
          status: 409,
        });
    }
  }

  reconcileSettings(local) {
    this.checkSettings(local);
    const services = Object.create(null);
    for (const def of local.services) {
      const previous = this.services[def.id];
      const svc =
        previous &&
        JSON.stringify(previous.def) === JSON.stringify(def) &&
        (previous.root === local.root || previous.proc)
          ? previous
          : this.buildService(def, local.root);
      svc.root = local.root;
      svc.onUpdate = (id) => this.onUpdate?.(id);
      services[def.id] = svc;
    }
    this.services = services;
    this.local = structuredClone(local);
  }

  applySettings(local) {
    return this.withSettingsLock(() => this.reconcileSettings(local));
  }

  get(id) {
    return this.services[id];
  }

  list() {
    return Object.values(this.services).map((s) => s.snapshot());
  }

  start(id) {
    return this.withSettingsLock(() => this.startUnlocked(id));
  }

  async startUnlocked(id) {
    const svc = this.services[id];
    if (!svc) return { ok: false, error: `unknown service: ${id}` };
    if (!svc.hasNodeModules()) {
      // Soft warning: proceed anyway, the process will fail loudly.
      svc.buffer.push('[dashboard] WARNING: node_modules missing — run npm install first\n');
    }
    svc.pending = true;
    try {
      const started = await svc.start();
      return { ok: true, started };
    } finally {
      svc.pending = false;
    }
  }

  stop(id) {
    return this.withSettingsLock(() => this.stopUnlocked(id));
  }

  stopUnlocked(id) {
    const svc = this.services[id];
    if (!svc) return { ok: false, error: `unknown service: ${id}` };
    svc.stop();
    return { ok: true };
  }

  // Stop every service and resolve the ids still alive at `timeoutMs`. Deliberately outside
  // `withSettingsLock`: shutdown is terminal, so a held lock must not delay it.
  async stopAll({ timeoutMs = STOP_WAIT_MS, killAfterMs } = {}) {
    // Shutdown is terminal: mark every service closing so a start or restart already in flight
    // cannot spawn a detached process after this returns.
    for (const svc of Object.values(this.services)) svc.closing = true;
    const running = Object.values(this.services).filter((svc) => svc.proc);
    await Promise.all(running.map((svc) => svc.stopAndWait(timeoutMs, { killAfterMs })));
    return running.filter((svc) => svc.proc).map((svc) => svc.id);
  }

  restart(id) {
    return this.withSettingsLock(() => this.restartUnlocked(id));
  }

  async restartUnlocked(id) {
    const svc = this.services[id];
    if (!svc) return { ok: false, error: `unknown service: ${id}` };
    svc.pending = true;
    try {
      return (await svc.restart()) ? { ok: true } : { ok: false, error: 'service did not stop' };
    } finally {
      svc.pending = false;
    }
  }

  // The services that share the repo directory `dir` and the main checkout they run from, or null.
  checkoutGroup(dir) {
    const members = Object.values(this.services).filter((svc) => svc.def.dir === dir);
    if (members.length === 0) return null;
    return { main: members[0].mainCheckout(), ids: members.map((svc) => svc.id) };
  }

  // Run every service of the repo `dir` from `checkout` (null: the main checkout). Running members
  // switch only with `restart: true`: they are stopped, awaited, and started again. Call it inside
  // `withSettingsLock`.
  async switchCheckoutUnlocked(dir, checkout, { restart = false } = {}) {
    const group = this.checkoutGroup(dir);
    if (!group)
      throw Object.assign(new Error(`unknown repo: ${dir}`), { code: 'UNKNOWN_REPO', status: 404 });
    const members = group.ids.map((id) => this.services[id]);
    const running = members.filter((svc) => svc.proc);
    if (running.length > 0 && restart !== true)
      throw Object.assign(new Error('A service of this repo is running.'), {
        code: 'CHECKOUT_IN_USE',
        status: 409,
      });
    for (const svc of running) {
      try {
        new ServiceProcess(svc.def, {
          root: svc.root,
          logsDir: this.logsDir,
          checkout,
        }).inspectRuntime();
      } catch (error) {
        throw Object.assign(new Error(`Checkout is not usable: ${error.message}`), {
          code: 'CHECKOUT_UNUSABLE',
          status: 422,
          cause: error,
        });
      }
    }
    await Promise.all(running.map((svc) => svc.stopAndWait(STOP_WAIT_MS)));
    try {
      if (running.some((svc) => svc.proc))
        throw Object.assign(new Error('A service did not stop in time.'), {
          code: 'CHECKOUT_IN_USE',
          status: 409,
        });
      try {
        await this.checkouts.set(group.main, checkout);
      } catch (error) {
        throw Object.assign(new Error('Could not save the checkout.'), {
          code: 'PERSISTENCE_FAILED',
          status: 503,
          cause: error,
        });
      }
    } catch (error) {
      // The old checkout stays in force: bring back the members this switch stopped.
      for (const svc of running) if (!svc.proc) await this.startUnlocked(svc.id).catch(() => {});
      throw error;
    }
    for (const svc of members) svc.checkout = checkout;
    for (const svc of running) await this.startUnlocked(svc.id);
    return {
      checkout: members[0].cwd(),
      checkoutLabel: checkout ? path.basename(checkout) : null,
      restarted: running.map((svc) => svc.id),
    };
  }

  logs(id, lines) {
    const svc = this.services[id];
    if (!svc) return null;
    return svc.logTail(lines);
  }

  tailAll(lines) {
    const out = {};
    for (const id of Object.keys(this.services)) {
      out[id] = this.services[id].logTail(lines);
    }
    return out;
  }
}

// ── nvm-less fallback helper for CLI-less use ──────────────────────
export function defaultManager() {
  return new Manager();
}

export function inspectRuntime(service, local) {
  try {
    return new ServiceProcess(service, { root: local.root }).inspectRuntime();
  } catch {
    return { ok: false };
  }
}
