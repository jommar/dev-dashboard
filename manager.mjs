// manager.mjs — spawns each configured service as an independent child process,
// captures its stdout+stderr into a per-service rolling ring buffer, writes the
// recent tail to a file (agent-readable), and exposes start/stop/restart.
//
// Zero external deps: node:child_process, node:fs, node:path, node:os.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SERVICES, REPOS_ROOT, LOGS_DIR, BUFFER_BYTES } from './config.mjs';
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

  #tailOf(line, maxBytes) {
    // Keep the trailing bytes of an oversized line.
    let out = line;
    while (Buffer.byteLength(out, 'utf8') > maxBytes && out.length > 1) {
      out = out.slice(1);
    }
    return out;
  }
}

// ── per-service process wrapper ────────────────────────────────────
export class ServiceProcess {
  constructor(def, { root = REPOS_ROOT, logsDir = LOGS_DIR } = {}) {
    this.def = def;
    this.root = root;
    this.logsDir = logsDir;
    this.id = def.id;
    this.buffer = new RingBuffer(BUFFER_BYTES);
    this.proc = null;
    this.status = 'stopped'; // stopped | running | exited
    this.exitCode = null;
    this.startedAt = null;
    this.lastLineAt = null;
  }

  cwd() {
    return path.resolve(this.root, this.def.dir);
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
    const env = { ...process.env };
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'JIRA_API_TOKEN', 'JIRA_TOKEN']) delete env[key];
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
    if (this.proc) return false;
    const dir = this.cwd();

    // Fresh logs on every start/restart so the previous run's output (and any
    // '[dashboard] process exited' note) doesn't linger in the tail or file.
    this.clearLogs();
    const [cmd, ...args] = this.def.command;

    // Free this service's port first so the dashboard can take over a port the
    // app is already running on (e.g. from a run.sh session in another terminal).
    if (typeof this.def.port === 'number') {
      await freePort(this.def.port);
    }

    // `npm`/`node` are resolved from PATH (now pointing at the pinned version).
    this.proc = spawn(cmd, args, { cwd: dir, env, detached: true });

    this.status = 'running';
    this.exitCode = null;
    this.startedAt = Date.now();

    this.proc.stdout?.on('data', (chunk) => this.#write(chunk));
    this.proc.stderr?.on('data', (chunk) => this.#write(chunk));

    this.proc.on('error', (err) => {
      this.#write(`[dashboard] spawn error: ${err.message}\n`);
      this.status = 'exited';
      this.exitCode = err.code ?? 1;
      this.proc = null;
    });

    this.proc.on('exit', (code, signal) => {
      this.status = 'exited';
      this.exitCode = code ?? (signal ? `signal:${signal}` : 1);
      this.#write(`[dashboard] process exited (${code ?? ''} ${signal ?? ''})\n`);
      this.proc = null;
    });

    if (version) {
      this.#write(`[dashboard] Node ${version}: ${nodePath}\n`);
    }
    this.#write(`[dashboard] started (${cmd} ${args.join(' ')})\n`);
    return true;
  }

  #write(chunk) {
    const text = chunk.toString('utf8');
    for (const line of text.split('\n')) {
      if (line === '' && text.endsWith('\n') === false) continue;
      this.buffer.push(line + (line === '' ? '' : '\n'));
    }
    this.lastLineAt = Date.now();
    this.#persist();
    if (this.onUpdate) this.onUpdate(this.id);
  }

  timeoutRef = null;
  #persist() {
    const dir = path.join(this.logsDir, this.id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'out.log');
    // Write the full rolling buffer so the agent can grep/read it.
    try {
      fs.writeFileSync(file, this.buffer.tail().join(''));
    } catch {
      // best effort; logs dir may be unwritable — never crash the manager
    }
  }

  // Wipe the in-memory rolling buffer and the persisted tail file.
  clearLogs() {
    this.buffer.clear();
    const file = path.join(this.logsDir, this.id, 'out.log');
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // best effort; ignore
    }
  }

  stop() {
    if (!this.proc) return false;
    // Kill the whole process group (detached children share it).
    try {
      process.kill(-this.proc.pid, 'SIGTERM');
    } catch {
      try {
        this.proc.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
    return true;
  }

  async restart() {
    // Reject configuration errors before interrupting the existing process.
    const runtime = this.#nodeRuntime();
    this.stop();
    // Give the old process a beat to release ports before starting a new one.
    await new Promise((resolve) => setTimeout(resolve, 800));
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
  } = {}) {
    this.local = structuredClone(local);
    this.logsDir = logsDir;
    this.queue = Promise.resolve();
    this.services = Object.create(null);
    for (const def of local.services) {
      this.services[def.id] = new ServiceProcess(def, { root: local.root, logsDir });
    }
    fs.mkdirSync(logsDir, { recursive: true });
    this.onUpdate = null;
    for (const svc of Object.values(this.services)) {
      svc.onUpdate = (id) => {
        if (this.onUpdate) this.onUpdate(id);
      };
    }
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
        path.resolve(local.root, definition.dir) !== svc.cwd();
      if (!changed && local.root !== svc.root) {
        try {
          const next = new ServiceProcess(definition, { root: local.root, logsDir: this.logsDir });
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
          : new ServiceProcess(def, { root: local.root, logsDir: this.logsDir });
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

  restart(id) {
    return this.withSettingsLock(() => this.restartUnlocked(id));
  }

  async restartUnlocked(id) {
    const svc = this.services[id];
    if (!svc) return { ok: false, error: `unknown service: ${id}` };
    svc.pending = true;
    try {
      await svc.restart();
      return { ok: true };
    } finally {
      svc.pending = false;
    }
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
