// claude-chat-fixture.mjs — the doubles for the Claude chat tests: a fake `claude` child process and
// the `spawn` that hands it out, a sessions double with the calls the chat makes, a stream sink,
// builders for the CLI's stream-json lines and for transcript lines, and a chat over temp folders.
//
// No real `claude` ever runs and nothing leaves the machine. The chat module is imported inside the
// helper that needs it, so a scenario fails by itself while the module is missing.
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { START_MS, createClock, createTimers, flush, recordingFs } from './slack-watch-fixture.mjs';

export { START_MS, flush };

// Valid session UUIDs (what `isSessionId` accepts).
export const UUID_1 = '0a1b2c3d-1111-4111-8111-111111111111';
export const UUID_2 = '0a1b2c3d-2222-4222-8222-222222222222';
export const UUID_3 = '0a1b2c3d-3333-4333-8333-333333333333';
export const UUID_4 = '0a1b2c3d-4444-4444-8444-444444444444';
export const UUID_5 = '0a1b2c3d-5555-4555-8555-555555555555';
export const UUID_6 = '0a1b2c3d-6666-4666-8666-666666666666';
export const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The names the dashboard never hands to a process it starts (config.mjs `SECRET_ENV_NAMES`).
export const SECRET_NAMES = ['GH_TOKEN', 'GITHUB_TOKEN', 'JIRA_API_TOKEN', 'JIRA_TOKEN'];

// The spec's fixed argument prefix of every turn.
export const BASE_ARGS = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--include-partial-messages',
];
export const STOP_GRACE_MS = 5_000;

// ---- CLI stream-json lines (one JSON object per stdout line) ----

export const initLine = (session) => ({
  type: 'system',
  subtype: 'init',
  session_id: session,
  tools: ['Read', 'Write'],
  mcp_servers: [{ name: 'SECRET-MCP-NAME', status: 'connected' }],
});
export const textDeltaLine = (text, extra = {}) => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  parent_tool_use_id: null,
  ...extra,
});
export const assistantTextLine = (uuid, text, extra = {}) => ({
  type: 'assistant',
  uuid,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
  parent_tool_use_id: null,
  ...extra,
});
export const thinkingLine = (uuid) => ({
  type: 'assistant',
  uuid,
  message: { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'x' }] },
  parent_tool_use_id: null,
});
export const toolUseLine = (uuid, id, name, input, extra = {}) => ({
  type: 'assistant',
  uuid,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  parent_tool_use_id: null,
  ...extra,
});
export const toolResultLine = (id, content, isError, extra = {}) => ({
  type: 'user',
  uuid: `result-${id}`,
  message: {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) },
    ],
  },
  parent_tool_use_id: null,
  ...extra,
});
export const resultLine = ({
  isError = false,
  result = 'done',
  terminal = 'completed',
  denials = [],
  cost = 0.12,
} = {}) => ({
  type: 'result',
  subtype: isError ? 'error_during_execution' : 'success',
  is_error: isError,
  result,
  terminal_reason: terminal,
  permission_denials: denials.map((tool_name) => ({ tool_name, tool_use_id: 'x', tool_input: {} })),
  total_cost_usd: cost,
});

// ---- transcript lines (`<projects dir>/<project>/<uuid>.jsonl`) ----

export const tUser = (uuid, parentUuid, text, extra = {}) => ({
  type: 'user',
  uuid,
  parentUuid,
  isSidechain: false,
  message: { role: 'user', content: text },
  ...extra,
});
export const tAssistant = (uuid, parentUuid, content, extra = {}) => ({
  type: 'assistant',
  uuid,
  parentUuid,
  isSidechain: false,
  message: { role: 'assistant', model: 'claude-sonnet-5-5', content },
  ...extra,
});
export const tText = (text) => ({ type: 'text', text });
export const tToolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
export const tToolResult = (uuid, parentUuid, id, content, isError) => ({
  type: 'user',
  uuid,
  parentUuid,
  isSidechain: false,
  message: {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) },
    ],
  },
});
export const jsonl = (lines) => `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;

// ---- the fake child process ----

// What `spawn` returns: `stdin` records what is written and whether it was ended, `stdout` and
// `stderr` are streams the test writes lines to, `kill(signal)` is recorded and ends nothing (the
// test decides when the process goes), and `close(code, signal)` is the process ending.
function createFakeChild(pid) {
  const child = new EventEmitter();
  const writes = [];
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({
    write(chunk, _encoding, done) {
      writes.push(String(chunk));
      done();
    },
  });
  child.stdinText = () => writes.join('');
  child.stdinEnded = () => child.stdin.writableEnded;
  child.signals = [];
  child.kill = (signal = 'SIGTERM') => {
    child.signals.push(signal);
    return true;
  };
  child.unref = () => {};
  child.closed = false;
  child.emitLine = async (value) => {
    child.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
    await flush(5);
  };
  child.emitStderr = async (text) => {
    child.stderr.write(text);
    await flush(5);
  };
  child.close = async (code = 0, signal = null) => {
    await flush(5);
    child.closed = true;
    child.emit('exit', code, signal);
    child.emit('close', code, signal);
    await flush(10);
  };
  return child;
}

// `spawn(command, args, options)` as Node's, recording every call and handing out a fake child.
// `failWith(error)` makes the next call throw it (a missing CLI); `failAsync(error)` makes the next
// child emit it as an `error` event instead.
export function createFakeSpawn() {
  const calls = [];
  let throwNext = null;
  let errorNext = null;
  const spawn = (command, args, options) => {
    if (throwNext) {
      const error = throwNext;
      throwNext = null;
      throw error;
    }
    const child = createFakeChild(4000 + calls.length + 1);
    calls.push({ command, args, options, child });
    if (errorNext) {
      const error = errorNext;
      errorNext = null;
      queueMicrotask(() => child.emit('error', error));
    }
    return child;
  };
  return {
    spawn,
    calls,
    last: () => calls.at(-1),
    failWith(error = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })) {
      throwNext = error;
    },
    failAsync(error = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })) {
      errorNext = error;
    },
  };
}

// ---- the sessions double: what the chat asks of `claude-sessions` ----

// `entries({ fresh })`, `stop({ sessionId })`, `beginTurn(id)` and `transcriptFile(id)`, each
// recorded in `events` in order. A session with a pid that has been stopped stays live for
// `liveAfterStop` more listings, then has none. `beginTurn` holds like the real one: a second call
// for a held id is null until the first is released. The listing never shows the mark: what the
// real module does with it is the sessions tests' business.
export function createFakeSessions() {
  const events = [];
  const held = new Set();
  const released = [];
  const state = {
    entries: [],
    transcripts: new Map(),
    liveAfterStop: 0,
    dying: null,
    listingFails: false,
    stopOutcome: null,
  };
  const find = (sessionId) => state.entries.find((entry) => entry.sessionId === sessionId);
  return {
    events,
    held,
    released,
    setEntries(entries) {
      state.entries = entries.map((entry) => ({ ...entry }));
    },
    setTranscript(sessionId, file) {
      state.transcripts.set(sessionId, file);
    },
    failListing() {
      state.listingFails = true;
    },
    liveAfterStop(polls) {
      state.liveAfterStop = polls;
    },
    forceStop(outcome) {
      state.stopOutcome = outcome;
    },
    stops: () => events.filter((event) => event.startsWith('stop')),
    async entries({ fresh = false } = {}) {
      events.push(fresh ? 'entries:fresh' : 'entries');
      if (state.listingFails) return null;
      if (state.dying) {
        if (state.dying.left > 0) state.dying.left -= 1;
        else {
          const entry = find(state.dying.sessionId);
          delete entry.pid;
          Object.assign(entry, { state: 'done', status: null });
          state.dying = null;
        }
      }
      return state.entries.map((entry) => ({ ...entry }));
    },
    async stop({ sessionId }) {
      events.push(`stop:${sessionId}`);
      if (state.stopOutcome) return state.stopOutcome;
      const entry = find(sessionId);
      if (!entry) return { status: 'not_listed' };
      if (typeof entry.pid !== 'number' || entry.status !== 'idle')
        return { status: 'not_idle', activity: entry.status ?? null };
      if (state.liveAfterStop > 0) state.dying = { sessionId, left: state.liveAfterStop };
      else {
        delete entry.pid;
        Object.assign(entry, { state: 'done', status: null });
      }
      return { status: 'stopped' };
    },
    beginTurn(sessionId) {
      events.push(`begin:${sessionId}`);
      if (held.has(sessionId)) return null;
      held.add(sessionId);
      return () => {
        if (!held.delete(sessionId)) return;
        released.push(sessionId);
        events.push(`release:${sessionId}`);
      };
    },
    async transcriptFile(sessionId) {
      return state.transcripts.get(sessionId) ?? null;
    },
  };
}

// ---- a stream sink: `{ send(event, payload) -> bool, end() }` that records what it was sent ----

function createSink({ congested = false } = {}) {
  const messages = [];
  const sink = {
    messages,
    ended: 0,
    congested,
    send(event, payload) {
      messages.push({ event, payload });
      return !sink.congested;
    },
    end() {
      sink.ended += 1;
    },
    of: (event) => messages.filter((message) => message.event === event).map((m) => m.payload),
    events: () => messages.map((message) => message.event),
    last: (event) => messages.filter((message) => message.event === event).at(-1)?.payload,
  };
  return sink;
}

// A temp folder under the work's scratch folder, removed when the test ends.
export function scratchDir(t, prefix) {
  const scratch = fileURLToPath(new URL('../.orchestrator/claude-chat/scratch', import.meta.url));
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// ---- the chat over temp folders and the doubles ----

// A new chat over a temp home (with its `pathwise` folder), a temp state folder (the launcher's: the
// chat keeps its records in `<stateDir>/chat`), the fake sessions, the fake spawn, fake timers on
// a fixed clock, a recording `fs` over the real one and a log that records every line.
// `home/.claude/projects/p` holds the transcripts the sessions double points at (`writeTranscript`).
export async function chatEnvironment(t, { claudeSessions, spawn, withFs = true } = {}) {
  const { createClaudeChat } = await import('../backend/claude-chat.mjs');
  const root = scratchDir(t, 'chat-test-');
  const home = path.join(root, 'home');
  const stateDir = path.join(root, 'claude');
  const projectDir = path.join(root, 'projects', 'p');
  fs.mkdirSync(path.join(home, 'pathwise'), { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  const clock = createClock();
  const timers = createTimers(clock);
  const sessions = claudeSessions ?? createFakeSessions();
  const spawner = createFakeSpawn();
  const recorder = recordingFs(fs);
  const logs = [];
  const chat = createClaudeChat({
    claudeSessions: sessions,
    spawn:
      spawn ??
      ((...args) => {
        sessions.events?.push('spawn');
        return spawner.spawn(...args);
      }),
    stateDir,
    home,
    ...(withFs && { fs: recorder.fs }),
    now: clock.now,
    timers,
    log: (line) => logs.push(String(line)),
  });
  t.after(() => chat.close?.());
  const recordsDir = path.join(stateDir, 'chat');
  const recordFile = (id) => path.join(recordsDir, `${id}.json`);
  return {
    root,
    home,
    stateDir,
    recordsDir,
    projectDir,
    clock,
    timers,
    sessions,
    spawner,
    recorder,
    logs,
    chat,
    pathwise: path.join(home, 'pathwise'),
    recordFile,
    record: (id) => JSON.parse(fs.readFileSync(recordFile(id), 'utf8')),
    records: () => (fs.existsSync(recordsDir) ? fs.readdirSync(recordsDir) : []),
    // Writes a session's transcript and points the sessions double at it.
    writeTranscript(sessionId, lines) {
      const file = path.join(projectDir, `${sessionId}.jsonl`);
      fs.writeFileSync(file, jsonl(lines));
      if ('setTranscript' in sessions) sessions.setTranscript(sessionId, file);
      return file;
    },
    appendTranscript(file, lines) {
      fs.appendFileSync(file, jsonl(lines));
    },
    // Seeds a standalone chat record as the dashboard wrote it.
    seedRecord(id, extra = {}) {
      fs.mkdirSync(recordsDir, { recursive: true });
      fs.writeFileSync(
        recordFile(id),
        JSON.stringify({
          id,
          title: 'seeded chat',
          cwd: path.join(home, 'pathwise'),
          createdAt: new Date(START_MS - 3_600_000).toISOString(),
          lastTurnAt: new Date(START_MS - 3_000_000).toISOString(),
          lastOutcome: 'completed',
          ...extra,
        }),
      );
    },
    // Opens a stream on `session` over a recording sink.
    async openStream(session, sinkOptions) {
      const sink = createSink(sinkOptions);
      const handle = await chat.open({ session, sink });
      return { sink, handle };
    },
  };
}

// The chat tests' own timers advance in fake time only; this lets the fake gap pass while a call
// that waits on it settles.
export async function throughTimers(env, promise) {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const deadline = Date.now() + 5_000;
  while (!settled) {
    if (Date.now() > deadline) throw new Error('the call neither settled nor waited on a timer');
    const delays = env.timers.delays();
    if (delays.length) await env.timers.advance(Math.max(...delays));
    else await flush(5);
  }
  return promise;
}
