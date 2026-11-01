import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { settingsFixture, accept } from './settings-fixture.mjs';

export const SESSION_A = '11111111-1111-4111-8111-111111111111';
export const SESSION_B = '22222222-2222-4222-8222-222222222222';
export const SESSION_C = '33333333-3333-4333-8333-333333333333';
export const SESSION_D = '44444444-4444-4444-8444-444444444444';
export const SESSION_E = '55555555-5555-4555-8555-555555555555';
export const ME = 'U_ME';
export const OTHER = 'U_OTHER';
export const CHANNEL = 'C024BE91L';
export const THREAD_TS = '1793192214.548389';
export const START_MS = 1_793_192_500_000;
export const DEFAULT_TEMPLATE = "There's a new message on {link}";
export const DEFAULT_SLACK_WATCH = {
  intervalSeconds: 180,
  noticeTemplate: DEFAULT_TEMPLATE,
  paused: false,
};
// The fake CLI forks a resume issued this soon after a stop; the real minimum is not measured, so
// the fake uses the worst case seen.
export const TRAP_WINDOW_MS = 60_000;
export const FORK_SENTENCE = 'is already running in the background, so this started a copy as';
export const CLI_OUTPUT_SENTINELS = {
  stop: 'sentinel-stop-output-5c2e',
  forkName: 'sentinel-fork-name-91ab',
  resumeName: 'sentinel-resume-name-3d70',
};

// The watcher's wake timings. Until the watcher exports them this answers the planned values, so a
// test fails on the missing behavior and not on a missing export; `exported` says which it is.
export async function wakeConstants() {
  const watcher = await import('../backend/slack-watcher.mjs');
  const names = ['SETTLE_MS', 'WAKE_GRACE_MS', 'WAKE_DEADLINE_MS'];
  return {
    SETTLE_MS: watcher.SETTLE_MS ?? 90_000,
    WAKE_GRACE_MS: watcher.WAKE_GRACE_MS ?? 60_000,
    WAKE_DEADLINE_MS: watcher.WAKE_DEADLINE_MS ?? 7_200_000,
    exported: names.every((name) => typeof watcher[name] === 'number'),
  };
}

export function tsAt(offsetSeconds, micro = 0) {
  const seconds = Math.floor(START_MS / 1000) + offsetSeconds;
  return `${seconds}.${String(micro).padStart(6, '0')}`;
}

export function compareTs(left, right) {
  const parse = (ts) => {
    const [seconds, fraction = ''] = String(ts).split('.');
    return BigInt(seconds) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  };
  const a = parse(left);
  const b = parse(right);
  return a === b ? 0 : a < b ? -1 : 1;
}

export function threadKey(channelId = CHANNEL, threadTs = THREAD_TS) {
  return `${channelId}:${threadTs}`;
}

export function permalinkFor(channelId = CHANNEL, threadTs = THREAD_TS) {
  return `https://example.slack.com/archives/${channelId}/p${threadTs.replace('.', '')}`;
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

// Gives every pending promise continuation and immediate a chance to run; it
// never waits on wall-clock time.
export async function flush(rounds = 25) {
  for (let round = 0; round < rounds; round++)
    await new Promise((resolve) => setImmediate(resolve));
}

export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function createClock(startMs = START_MS) {
  let current = startMs;
  return {
    now: () => current,
    advance(milliseconds) {
      current += milliseconds;
      return current;
    },
    set(milliseconds) {
      current = milliseconds;
    },
  };
}

// Timers that fire only when a test advances the shared clock. A callback that
// rejects or throws is recorded in `escapes` instead of failing silently.
export function createTimers(clock) {
  let nextId = 1;
  const scheduled = new Map();
  const escapes = [];
  const timers = {
    escapes,
    setTimeout(callback, delay) {
      let referenced = true;
      const handle = {
        id: nextId++,
        unref() {
          referenced = false;
          return handle;
        },
        ref() {
          referenced = true;
          return handle;
        },
        hasRef: () => referenced,
      };
      scheduled.set(handle.id, { callback, delay, due: clock.now() + delay, handle });
      return handle;
    },
    clearTimeout(handle) {
      if (handle && typeof handle === 'object') scheduled.delete(handle.id);
      else scheduled.delete(handle);
    },
    pending: () => scheduled.size,
    // How many pending timers would keep a real process alive: those never unref'ed.
    referenced: () => [...scheduled.values()].filter(({ handle }) => handle.hasRef()).length,
    delays: () => [...scheduled.values()].map((timer) => timer.delay),
    clear: () => scheduled.clear(),
    async advance(milliseconds) {
      const target = clock.now() + milliseconds;
      for (let guard = 0; guard < 10_000; guard++) {
        const next = [...scheduled.entries()]
          .filter(([, timer]) => timer.due <= target)
          .sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        const [id, timer] = next;
        scheduled.delete(id);
        if (timer.due > clock.now()) clock.set(timer.due);
        try {
          await timer.callback();
        } catch (error) {
          escapes.push(error);
        }
        await flush();
      }
      clock.set(target);
    },
  };
  return timers;
}

// A real `fs` that records every call and can be told to fail a call once.
export function recordingFs(real = fs) {
  const calls = [];
  const faults = [];
  const proxy = new Proxy(real, {
    get(target, property) {
      const value = target[property];
      if (typeof value !== 'function') return value;
      return (...args) => {
        calls.push({ method: String(property), args });
        const index = faults.findIndex((fault) => fault.method === property && fault.matches(args));
        if (index !== -1) {
          const fault = faults[index];
          if (fault.once) faults.splice(index, 1);
          throw fault.error;
        }
        return value.apply(target, args);
      };
    },
  });
  return {
    fs: proxy,
    calls,
    failOn(method, match, error = new Error('synthetic fs failure'), { once = true } = {}) {
      const matches =
        typeof match === 'function' ? match : (args) => String(args[0]).includes(String(match));
      faults.push({ method, matches, error, once });
    },
    clearFaults: () => faults.splice(0),
    clearCalls: () => calls.splice(0),
  };
}

export function createThreadModel() {
  const threads = new Map();
  const model = {
    set(key, messages) {
      threads.set(
        key,
        messages.map((message) => ({ ...message })),
      );
    },
    post(key, message) {
      threads.get(key).push({ ...message });
    },
    remove(key, ts) {
      const messages = threads.get(key);
      threads.set(
        key,
        messages.filter((message) => message.ts !== ts),
      );
    },
    messages: (key) => threads.get(key),
    has: (key) => threads.has(key),
    newest(key) {
      const messages = threads.get(key) || [];
      return messages.reduce(
        (best, message) => (!best || compareTs(message.ts, best.ts) > 0 ? message : best),
        null,
      );
    },
    asOf(key, asOfTs) {
      const messages = (threads.get(key) || []).filter(
        (message) => asOfTs === undefined || compareTs(message.ts, asOfTs) <= 0,
      );
      return messages.reduce(
        (best, message) => (!best || compareTs(message.ts, best) > 0 ? message.ts : best),
        null,
      );
    },
  };
  return model;
}

// A reader with the shape of `slack.lastInThread`, scripted from a thread model.
export function createFakeReader({ threads = createThreadModel(), me = ME } = {}) {
  const calls = [];
  let intercept = null;
  let gate = null;
  let inFlight = 0;
  let maxInFlight = 0;
  const reader = {
    threads,
    me,
    calls,
    get maxInFlight() {
      return maxInFlight;
    },
    get inFlight() {
      return inFlight;
    },
    script(handler) {
      intercept = handler;
    },
    failNext(result, times = 1) {
      let remaining = times;
      intercept = () => (remaining-- > 0 ? result : undefined);
    },
    hold() {
      gate = deferred();
      const current = gate;
      return {
        release: () => {
          current.resolve();
          if (gate === current) gate = null;
        },
      };
    },
    async lastInThread(params) {
      calls.push({ ...params });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (gate) await gate.promise;
        const scripted = intercept ? intercept(params, calls.length - 1) : undefined;
        if (scripted) return scripted;
        const key = threadKey(params.channelId, params.threadTs);
        const newest = threads.newest(key);
        if (!newest) return { ok: false, reason: 'unavailable' };
        return {
          ok: true,
          me,
          last: { ...(newest.user ? { user: newest.user } : {}), ts: newest.ts },
          asOf: threads.asOf(key, params.asOfTs),
        };
      } finally {
        inFlight -= 1;
      }
    },
  };
  return reader;
}

// Listing entry in the shape `claude agents --json --all` prints. A live
// session has a numeric `pid`; a finished one has none. `status` (idle, busy or null) is present
// only when given, so an entry built without it stays the status-less live entry of older tests.
export function listingEntry({
  sessionId,
  pid,
  cwd = '/work/example',
  name = 'example session',
  state = 'done',
  status,
  kind = 'background',
}) {
  return {
    id: sessionId.slice(0, 8),
    sessionId,
    name,
    cwd,
    kind,
    startedAt: START_MS,
    state,
    ...(pid !== undefined ? { pid } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}

// An `execFile` double with Node's callback shape. Outcomes:
// { stdout }, { exitCode, stdout, stderr }, { spawnError: 'ENOENT' }, { timeout: true },
// or a promise of any of those. A call is a listing (`agents`), a stop (`stop`) or a resume.
export function createFakeExec() {
  const calls = [];
  const handlers = {
    listing: () => ({ stdout: '[]' }),
    stop: () => ({ stdout: 'stopped' }),
    resume: () => ({ stdout: 'backgrounded' }),
  };
  function execFileImpl(file, args, options, callback) {
    const call = { file, args, options };
    calls.push(call);
    const kind = args[0] === 'agents' ? 'listing' : args[0] === 'stop' ? 'stop' : 'resume';
    let outcome;
    try {
      outcome = handlers[kind](call);
    } catch (error) {
      outcome = Promise.reject(error);
    }
    Promise.resolve(outcome).then(
      (result) => {
        const { stdout = '', stderr = '' } = result || {};
        if (result?.spawnError)
          return callback(Object.assign(new Error('spawn failed'), { code: result.spawnError }));
        if (result?.timeout)
          return callback(
            Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM', code: null }),
            stdout,
            stderr,
          );
        if (result?.exitCode)
          return callback(
            Object.assign(new Error('Command failed'), {
              code: result.exitCode,
              stdout,
              stderr,
            }),
            stdout,
            stderr,
          );
        return callback(null, stdout, stderr);
      },
      (error) => callback(error, '', ''),
    );
    return { kill() {}, on() {}, unref() {} };
  }
  return {
    execFileImpl,
    calls,
    listings: () => calls.filter((call) => call.args[0] === 'agents'),
    stops: () => calls.filter((call) => call.args[0] === 'stop'),
    spawns: () => calls.filter((call) => call.args.includes('--resume')),
    setListing(entries) {
      handlers.listing = () => ({ stdout: JSON.stringify(entries) });
    },
    onListing(handler) {
      handlers.listing = handler;
    },
    onStop(handler) {
      handlers.stop = handler;
    },
    onResume(handler) {
      handlers.resume = handler;
    },
  };
}

function copyIdFor(index) {
  return `ffffffff-ffff-4fff-8fff-${index.toString(16).padStart(12, '0')}`;
}

// A stateful `claude` CLI behind a fake exec, on the shared clock. A session has a pid, a kind
// and a status while it is live; `stop` clears the pid and records the time; a resume forks a copy
// under a new id (exit 0, the real wording) while the session is live or within `trapWindowMs`
// of a stop, and otherwise continues the same id with a new pid. A session this CLI was never
// given is answered like the plain exec double, so older tests keep their static listings.
//   add(sessionId, { kind, status, name, cwd })  status idle | busy, or null for a finished session
//   setStatus / finish / revive / remove         change a session the way the world would
//   override(sessionId, patch)                   change only what the listing prints (drop `status`)
//   failNext(kind, outcome, times) / hold(kind)  kind is listing, stop or resume
//   stops, resumes, forks                        effective calls, in order
export function createFakeCli({ clock, exec = createFakeExec() }) {
  const sessions = new Map();
  const listingOverrides = new Map();
  const failures = { listing: [], stop: [], resume: [] };
  const gates = {};
  const stops = [];
  const resumes = [];
  const forks = [];
  let nextPid = 5000;

  const isLive = (session) => session.pid !== undefined;
  const requireSession = (sessionId) => {
    const session = sessions.get(sessionId);
    assert.ok(session, 'the fake CLI was never given this session');
    return session;
  };
  const byShortId = (shortId) =>
    [...sessions.values()].find((session) => session.sessionId.slice(0, 8) === shortId);

  function entryOf(session) {
    const live = isLive(session);
    return {
      ...listingEntry({
        sessionId: session.sessionId,
        pid: session.pid,
        cwd: session.cwd,
        name: session.name,
        kind: session.kind,
        state: session.status === 'busy' ? 'working' : 'done',
        status: live ? session.status : null,
      }),
      ...listingOverrides.get(session.sessionId),
    };
  }

  function addSession(
    sessionId,
    { kind = 'background', status = 'idle', name = 'example session', cwd = '/work/example' } = {},
  ) {
    const session = {
      sessionId,
      kind,
      name,
      cwd,
      status,
      pid: status === null ? undefined : nextPid++,
      stoppedAtMs: undefined,
    };
    sessions.set(sessionId, session);
    return session;
  }

  async function beforeCall(kind) {
    if (gates[kind]) await gates[kind].promise;
    return failures[kind].shift();
  }

  function forkOf(session) {
    const copyId = copyIdFor(forks.length + 1);
    addSession(copyId, { name: CLI_OUTPUT_SENTINELS.forkName, cwd: session.cwd });
    forks.push({ sessionId: session.sessionId, copyId, atMs: clock.now() });
    resumes.push({ sessionId: session.sessionId, outcome: 'forked', atMs: clock.now() });
    return {
      stdout:
        `session ${session.sessionId.slice(0, 8)} ${FORK_SENTENCE} ${copyId.slice(0, 8)}\n` +
        `${CLI_OUTPUT_SENTINELS.forkName}\n`,
    };
  }

  exec.onListing(async () => {
    const failure = await beforeCall('listing');
    if (failure) return failure;
    return { stdout: JSON.stringify([...sessions.values()].map(entryOf)) };
  });

  exec.onStop(async (call) => {
    const failure = await beforeCall('stop');
    if (failure) return failure;
    const session = byShortId(call.args[1]);
    if (!session || !isLive(session)) return { exitCode: 1, stderr: 'no running session matches' };
    session.pid = undefined;
    session.status = null;
    session.stoppedAtMs = clock.now();
    stops.push({ sessionId: session.sessionId, atMs: clock.now() });
    return { stdout: `stopped ${session.sessionId.slice(0, 8)}\n${CLI_OUTPUT_SENTINELS.stop}\n` };
  });

  exec.onResume(async (call) => {
    const failure = await beforeCall('resume');
    if (failure) return failure;
    const session = sessions.get(call.args[call.args.indexOf('--resume') + 1]);
    if (!session) return { stdout: 'backgrounded' };
    const sinceStop =
      session.stoppedAtMs === undefined ? Infinity : clock.now() - session.stoppedAtMs;
    if (isLive(session) || sinceStop < cli.trapWindowMs) return forkOf(session);
    session.pid = nextPid++;
    session.status = 'busy';
    session.stoppedAtMs = undefined;
    resumes.push({ sessionId: session.sessionId, outcome: 'continued', atMs: clock.now() });
    return {
      stdout:
        `woke session ${session.sessionId.slice(0, 8)} with its saved options (--model)\n` +
        `${CLI_OUTPUT_SENTINELS.resumeName}\n`,
    };
  });

  const cli = {
    exec,
    execFileImpl: exec.execFileImpl,
    trapWindowMs: TRAP_WINDOW_MS,
    stops,
    resumes,
    forks,
    add: addSession,
    setStatus(sessionId, status) {
      const session = requireSession(sessionId);
      assert.ok(isLive(session), 'only a live session has a status');
      session.status = status;
    },
    finish(sessionId) {
      Object.assign(requireSession(sessionId), { pid: undefined, status: null });
    },
    revive(sessionId, status = 'busy') {
      Object.assign(requireSession(sessionId), { pid: nextPid++, status });
    },
    remove: (sessionId) => sessions.delete(sessionId),
    override(sessionId, patch) {
      listingOverrides.set(sessionId, { ...listingOverrides.get(sessionId), ...patch });
    },
    session(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return undefined;
      return { sessionId, pid: session.pid, status: session.status, live: isLive(session) };
    },
    entries: () => [...sessions.values()].map(entryOf),
    entryCount: () => sessions.size,
    failNext(kind, outcome, times = 1) {
      for (let count = 0; count < times; count++) failures[kind].push(outcome);
    },
    hold(kind) {
      const gate = deferred();
      gates[kind] = gate;
      return {
        release() {
          gate.resolve();
          if (gates[kind] === gate) delete gates[kind];
        },
      };
    },
  };
  return cli;
}

// Sessions double with the shape of the real claude-sessions module. An entry's `activity` (idle,
// busy) passes through to the listing; an entry without one lists `null`, a live session that
// is not known to be idle.
export function createFakeSessions() {
  const state = { entries: [], source: 'claude' };
  const resumeOutcomes = new Map();
  const stopOutcomes = new Map();
  const resumeCalls = [];
  const stopCalls = [];
  let listingCalls = 0;
  const scripted = (outcomes, sessionId, args, fallback) => {
    const outcome = outcomes.get(sessionId);
    if (typeof outcome === 'function') return outcome(args);
    if (Array.isArray(outcome)) return outcome.length > 1 ? outcome.shift() : outcome[0];
    return outcome || fallback;
  };
  const sessions = {
    resumeCalls,
    stopCalls,
    get listingCalls() {
      return listingCalls;
    },
    setSessions(entries, source = 'claude') {
      state.entries = entries.map((entry) => ({ ...entry }));
      state.source = source;
    },
    failListing() {
      state.source = 'map';
    },
    // `outcome` is one result, an array consumed one per call (the last repeats), or a function.
    onResume(sessionId, outcome) {
      resumeOutcomes.set(sessionId, outcome);
    },
    onStop(sessionId, outcome) {
      stopOutcomes.set(sessionId, outcome);
    },
    async listSessions() {
      listingCalls += 1;
      return {
        source: state.source,
        sessions: state.entries.map((entry) => ({
          sessionId: entry.sessionId,
          state: state.source === 'map' ? 'unknown' : entry.state,
          name: state.source === 'map' ? undefined : (entry.name ?? 'label'),
          attached: true,
          ...(state.source === 'claude' ? { activity: entry.activity ?? null } : {}),
        })),
      };
    },
    async resume({ sessionId, notice }) {
      resumeCalls.push({ sessionId, notice });
      return scripted(resumeOutcomes, sessionId, { sessionId, notice }, { status: 'delivered' });
    },
    async stop({ sessionId }) {
      stopCalls.push({ sessionId });
      return scripted(stopOutcomes, sessionId, { sessionId }, { status: 'stopped' });
    },
  };
  return sessions;
}

export function createFakeSettings(initial = {}) {
  const slackWatch = { ...DEFAULT_SLACK_WATCH, ...initial };
  return {
    slackWatch,
    getPublicSettings: () => ({ slackWatch: { ...slackWatch } }),
    async saveSlackWatch(patch) {
      Object.assign(slackWatch, patch);
      return { ...slackWatch };
    },
  };
}

export function rateLimitedResponse(retryAfterSeconds = 30) {
  return new Response('{}', {
    status: 429,
    headers: { 'Retry-After': String(retryAfterSeconds) },
  });
}

// A fetch double for the real Slack integration: auth.test and
// conversations.replies answered from a thread model, with every method recorded.
export function createFakeSlackFetch({ threads = createThreadModel(), me = ME } = {}) {
  const calls = [];
  let intercept = null;
  async function fetchImpl(input, init) {
    const url = new URL(input);
    const method = url.pathname.split('/').pop();
    calls.push({ method, url, init });
    const scripted = intercept ? intercept({ method, url, init, index: calls.length - 1 }) : null;
    if (scripted) return scripted;
    if (method === 'auth.test')
      return Response.json({
        ok: true,
        user: 'sentinel-display-name',
        user_id: me,
        team: 'Team',
        team_id: 'T1',
      });
    if (method === 'conversations.replies') {
      const key = threadKey(url.searchParams.get('channel'), url.searchParams.get('ts'));
      if (!threads.has(key)) return Response.json({ ok: false, error: 'thread_not_found' });
      return Response.json({
        ok: true,
        messages: threads.messages(key).map((message) => ({
          ts: message.ts,
          ...(message.user ? { user: message.user } : {}),
          text: message.text ?? 'sentinel-message-text',
        })),
        has_more: false,
      });
    }
    return Response.json({ ok: false, error: 'unknown_method' });
  }
  return {
    threads,
    calls,
    fetchImpl,
    methods: () => calls.map((call) => call.method),
    script(handler) {
      intercept = handler;
    },
  };
}

export function writeSlackSession(
  home,
  { token = 'xoxc-synthetic', cookie = 'xoxd-synthetic' } = {},
) {
  const directory = path.join(home, '.config/slack');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(directory, 'session.json'),
    JSON.stringify({ token, cookie, teamId: 'T1', teamDomain: 'example', savedAt: '2026-01-01' }),
    { mode: 0o600 },
  );
}

export function captureConsole(t) {
  const lines = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'])
    t.mock.method(console, method, (...args) => lines.push(args.map(String).join(' ')));
  return lines;
}

// Every file under `root` that contains one of the needles, as relative paths
// paired with the index of the needle (never the needle itself).
export function findInTree(root, needles) {
  const found = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) {
        const contents = fs.readFileSync(file);
        needles.forEach((needle, index) => {
          if (contents.includes(Buffer.from(needle)))
            found.push({ file: path.relative(root, file), needle: index });
        });
      }
    }
  };
  if (fs.existsSync(root)) visit(root);
  return found;
}

function httpRequest(base, method, pathname, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + pathname, { method, headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => {
        text += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, text, json: () => JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(
      body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    );
  });
}

// The whole watch stack over one temp home, with every boundary injected:
// Slack reader, session listing and resume, clock and timers. Options:
//   settings: 'fake' | 'real'      real = the production settings store over the home
//   sessions: 'fake' | 'real'      real = claude-sessions over a fake execFile, the stateful fake
//                                  CLI on the fixture clock (`f.cli`), sharing `f.exec`
//   reader: 'fake' | 'real'        real = the Slack integration over a fake fetch
//   http: true                     also serves the handler on a loopback port (forces real settings)
//   claudeHome: boolean            what claudeHomeReadable() answers
//   setupAccepted: boolean         real settings only: GitHub and Jira setup completed
//   wrapStore: (store) => store    decorate the store the watcher uses (to fail `append`, say)
//   intervalSeconds, noticeTemplate, paused: initial slackWatch values
export async function watchFixture(t, options = {}) {
  const {
    sessions: sessionsMode = 'fake',
    reader: readerMode = 'fake',
    http: withHttp = false,
    claudeHome = true,
    setupAccepted = true,
    intervalSeconds,
    noticeTemplate,
    paused,
  } = options;
  const settingsMode = withHttp ? 'real' : options.settings || 'fake';
  const initialValues = Object.fromEntries(
    Object.entries({ intervalSeconds, noticeTemplate, paused }).filter(
      ([, value]) => value !== undefined,
    ),
  );
  const clock = createClock(options.startMs);
  const timers = createTimers(clock);
  const recorder = recordingFs(fs);
  const claudeHomeState = { readable: claudeHome };
  const threads = createThreadModel();

  let home;
  let settingsFixtureHandle = null;
  let settings;
  if (settingsMode === 'real') {
    settingsFixtureHandle = settingsFixture(t);
    home = settingsFixtureHandle.home;
    settings = await settingsFixtureHandle.store();
    await settings.initialize();
    if (setupAccepted) await accept(settingsFixtureHandle, settings);
    if (Object.keys(initialValues).length) await settings.saveSlackWatch(initialValues);
  } else {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-watch-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    settings = createFakeSettings(initialValues);
  }

  const slackFetch = createFakeSlackFetch({ threads });
  const fakeReader = createFakeReader({ threads });
  const exec = createFakeExec();
  const cli = sessionsMode === 'real' ? createFakeCli({ clock, exec }) : null;
  const fakeSessions = createFakeSessions();
  const paths = {
    watchDirectory: path.join(home, '.config/dev-dashboard/slack-watch'),
    map: path.join(home, '.config/dev-dashboard/slack-watch/map.json'),
    inboxDirectory: path.join(home, '.config/dev-dashboard/slack-watch/inbox'),
    settings: path.join(home, '.config/dev-dashboard/settings.json'),
  };

  const fixture = {
    home,
    paths,
    clock,
    timers,
    threads,
    recorder,
    exec,
    cli,
    slackFetch,
    claudeHome: claudeHomeState,
    settingsFixture: settingsFixtureHandle,
    fakeReader,
    fakeSessions,
    http: null,
  };

  async function build() {
    const { createSlackWatchStore } = await import('../backend/slack-watch-store.mjs');
    const { createSlackWatcher } = await import('../backend/slack-watcher.mjs');
    fixture.store = createSlackWatchStore({ home, fs: recorder.fs, now: clock.now });
    fixture.settings = settings;
    if (readerMode === 'real') {
      writeSlackSession(home);
      const { createSlackIntegration, slackPaths } = await import('../backend/slack.mjs');
      fixture.slack = createSlackIntegration({
        paths: slackPaths(home),
        fetchImpl: slackFetch.fetchImpl,
        now: clock.now,
      });
    } else fixture.slack = fakeReader;
    if (sessionsMode === 'real') {
      const { createClaudeSessions } = await import('../backend/claude-sessions.mjs');
      fixture.sessions = createClaudeSessions({
        execFileImpl: exec.execFileImpl,
        store: fixture.store,
      });
    } else fixture.sessions = fakeSessions;
    fixture.watcher = createSlackWatcher({
      slack: fixture.slack,
      store: options.wrapStore ? options.wrapStore(fixture.store) : fixture.store,
      settings,
      sessions: fixture.sessions,
      now: clock.now,
      timers,
      claudeHomeReadable: () => claudeHomeState.readable,
    });
  }
  await build();
  t.after(async () => {
    await fixture.watcher?.stop?.();
  });

  Object.assign(fixture, {
    // Adds a link, scripts its thread, and attaches each session at the current clock.
    async watch({ channelId = CHANNEL, threadTs = THREAD_TS, sessionIds = [], messages } = {}) {
      const key = threadKey(channelId, threadTs);
      await fixture.store.addLink({
        key,
        link: permalinkFor(channelId, threadTs),
        channelId,
        threadTs,
      });
      if (messages) threads.set(key, messages);
      for (const sessionId of sessionIds) await fixture.store.attach(key, sessionId);
      return key;
    },
    inboxFile: (sessionId) => path.join(paths.inboxDirectory, `${sessionId}.log`),
    inboxLines(sessionId) {
      const file = path.join(paths.inboxDirectory, `${sessionId}.log`);
      if (!fs.existsSync(file)) return [];
      const text = fs.readFileSync(file, 'utf8');
      return text === '' ? [] : text.replace(/\n$/, '').split('\n');
    },
    totalLines() {
      if (!fs.existsSync(paths.inboxDirectory)) return 0;
      return fs
        .readdirSync(paths.inboxDirectory)
        .filter((name) => name.endsWith('.log'))
        .reduce((sum, name) => {
          const text = fs.readFileSync(path.join(paths.inboxDirectory, name), 'utf8');
          return sum + (text === '' ? 0 : text.replace(/\n$/, '').split('\n').length);
        }, 0);
    },
    mapText: () => (fs.existsSync(paths.map) ? fs.readFileSync(paths.map, 'utf8') : null),
    entry: (key) => fixture.store.snapshot().links[key],
    delivery(key, sessionId) {
      const link = fixture.watcher.list().links.find((item) => item.key === key);
      return link?.sessions.find((item) => item.sessionId === sessionId)?.delivery;
    },
    linkStatus: (key) => fixture.watcher.list().links.find((item) => item.key === key),
    tick: () => fixture.watcher.tickOnce(),
    // A restart: stop the old watcher, rebuild store, settings and watcher over the same home.
    async restart() {
      await fixture.watcher.stop();
      timers.clear();
      if (settingsMode === 'real') {
        settings = await settingsFixtureHandle.store();
        await settings.initialize();
      }
      await build();
      return fixture;
    },
  });

  if (withHttp) {
    const { createHttpHandler } = await import('../backend/http-app.mjs');
    const manager = {
      list: () => [],
      logs: () => '',
      start: async () => ({ ok: true }),
      stop: async () => ({ ok: true }),
      restart: async () => ({ ok: true }),
      applySettings: async () => {},
      onUpdate: null,
    };
    const handler = createHttpHandler({
      settings,
      manager,
      integrations: {
        slack: fixture.slack,
        slackWatchStore: fixture.store,
        claudeSessions: fixture.sessions,
        slackWatcher: fixture.watcher,
      },
    });
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
      handler.close?.();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    fixture.http = {
      base,
      port: server.address().port,
      handler,
      server,
      manager,
      raw: (method, pathname, requestOptions) =>
        httpRequest(base, method, pathname, requestOptions),
      json: (method, pathname, body) =>
        httpRequest(base, method, pathname, {
          body,
          headers: { 'content-type': 'application/json' },
        }),
      // What curl sends without extra flags: no Content-Type, no Origin.
      bare: (method, pathname, body) => httpRequest(base, method, pathname, { body }),
    };
  }
  return fixture;
}

export function assertNoTimers(timers, message = 'no timer may be pending') {
  assert.equal(timers.pending(), 0, message);
}
