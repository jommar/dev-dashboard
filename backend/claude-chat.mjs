// claude-chat.mjs — a conversation with a Claude session from the dashboard. A turn is one `claude -p`
// process (stream-json both ways): the message goes in on stdin, the CLI's lines are turned into the
// chat's events (claude-chat-items.mjs) and sent to every stream open on the session, and the
// process ends with the turn. Three kinds of session can be chatted with: a standalone chat, which
// the dashboard keeps a record of under `<stateDir>/chat/<uuid>.json` (no ticket, no listing entry,
// because the CLI does not list a `-p` run), any listed session, which includes every ticket
// session, and an orphan: a session a launch record names that the CLI no longer lists but whose
// transcript is on disk (`orphanSession`). A session is addressed by its UUID only; the directory it
// runs in comes from the record or the listing (`~/pathwise` for an orphan), never from a request.
//
// One writer per session: a turn holds `claudeSessions.beginTurn`, which every other writer (the
// launcher, the Slack watcher, a resume) reads as work in progress. A listed session that is idle is
// stopped first, so the turn continues it instead of copying it; one that is working is never touched.
//
// The module has no HTTP in it: a stream is a sink (`send(event, payload)`, false when the client is
// not keeping up, and `end()`), like the DevTools streams. Nothing is read, written or started until
// a call asks for it. Nothing said is logged: a failure is one `[claude]` line with the step, the
// reason, the exit code and the session's short id (see claude-log.mjs).

import { randomUUID } from 'node:crypto';
import fsDefault from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as spawnDefault } from 'node:child_process';
import { fail as tooMany } from './browser-devtools.mjs';
import { withoutSecrets } from './config.mjs';
import { newestEntries, writeFileAtomic } from './credentials.mjs';
import { defaultClaudeLog, logClaudeFailure } from './claude-log.mjs';
import { historyItems, liveMessages } from './claude-chat-items.mjs';
import {
  CLAUDE_STATE_DIR,
  FINISH_POLL_LIMIT,
  failed,
  invalid,
  pause,
  refused,
} from './claude-launcher.mjs';
import { settleSession } from './claude-sessions.mjs';
import { isSessionId } from './slack-watch-store.mjs';

const MAX_MESSAGE_LENGTH = 32_000;
const MAX_TURNS = 4;
const MAX_STREAMS = 8;
// What a chat keeps: the records read and listed, the items of the turn in flight, the part of the
// transcript read, and the longest stdout line taken (a longer one is dropped).
const MAX_RECORDS = 500;
const MAX_LISTED = 100;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_TURN_ITEMS = 500;
const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
const MAX_LINE_CHARS = 8 * 1024 * 1024;
const TITLE_LENGTH = 60;
// After SIGINT a process that has not closed is ended with SIGTERM.
const STOP_GRACE_MS = 5_000;
// How many finished turns are remembered for `hello`.
const MAX_FINISHED_TURNS = 100;
const OUTCOMES = ['completed', 'stopped', 'failed'];
const TURN_ARGS = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--include-partial-messages',
];

const requireSession = (session) => {
  if (!isSessionId(session)) throw invalid('INVALID_SESSION', 'Invalid session id.');
};

const requireMessage = (message) => {
  if (typeof message !== 'string' || !message.trim() || message.length > MAX_MESSAGE_LENGTH)
    throw invalid('INVALID_MESSAGE', 'Invalid message.');
};

// The first line of the first message, whitespace collapsed.
const titleOf = (message) =>
  message.trim().split('\n')[0].replace(/\s+/g, ' ').slice(0, TITLE_LENGTH);

const isRecord = (value, file) =>
  Boolean(value) &&
  typeof value === 'object' &&
  value.id === path.basename(file, '.json') &&
  isSessionId(value.id) &&
  [value.title, value.cwd].every((text) => typeof text === 'string' && text) &&
  [value.createdAt, value.lastTurnAt].every((time) => Number.isFinite(Date.parse(time))) &&
  (value.lastOutcome === null || OUTCOMES.includes(value.lastOutcome));

export function createClaudeChat({
  claudeSessions,
  spawn = spawnDefault,
  stateDir = CLAUDE_STATE_DIR,
  home = os.homedir(),
  fs = fsDefault,
  now = Date.now,
  timers = { setTimeout, clearTimeout },
  log = defaultClaudeLog,
  // The session name of the dashboard's launch record that has this session's short id, or null:
  // what lets the chat continue a session the CLI listing lost (see `orphanSession`).
  launchedName = () => null,
}) {
  const recordsDir = path.join(stateDir, 'chat');
  const recordFile = (id) => path.join(recordsDir, `${id}.json`);
  // The turns in flight, by session id; the sessions a turn is still being started for; the streams
  // open; the last finished turn of each session this process ran.
  const turns = new Map();
  const starting = new Set();
  const streams = new Set();
  const finished = new Map();

  const iso = () => new Date(now()).toISOString();

  // ---- the standalone store ----

  // The record of a standalone chat, or null when there is none or it is not a record.
  function readRecord(id) {
    const file = recordFile(id);
    try {
      if (fs.statSync(file).size > MAX_RECORD_BYTES) return null;
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      return isRecord(value, file) ? value : null;
    } catch {
      return null;
    }
  }

  const saveRecord = (record) =>
    writeFileAtomic(recordFile(record.id), `${JSON.stringify(record, null, 2)}\n`, fs);

  function readRecords() {
    let names;
    try {
      names = fs.readdirSync(recordsDir).filter((name) => name.endsWith('.json'));
    } catch {
      return [];
    }
    return newestEntries(recordsDir, names, MAX_RECORDS, fs)
      .map((name) => name.slice(0, -'.json'.length))
      .filter(isSessionId)
      .map(readRecord)
      .filter(Boolean);
  }

  const publicChat = (record) => {
    const working = turns.has(record.id) || starting.has(record.id);
    return {
      id: record.id,
      title: record.title,
      state: working ? 'working' : record.lastOutcome === 'failed' ? 'failed' : 'done',
      createdAt: record.createdAt,
      lastActiveAt: record.lastTurnAt,
      goTo: working
        ? null
        : { kind: 'resume', command: `cd ~/pathwise && claude --resume ${record.id}` },
    };
  };

  // The standalone chats, newest turn first.
  async function list() {
    return readRecords()
      .sort((a, b) => Date.parse(b.lastTurnAt) - Date.parse(a.lastTurnAt))
      .slice(0, MAX_LISTED)
      .map(publicChat);
  }

  // ---- what a session is ----

  // What the chat needs to know of a session: a standalone chat (its record) or a listed session (its
  // entry), or the refusal. A listing is read fresh, since a decision rests on it.
  async function resolveSession(id) {
    const record = readRecord(id);
    if (record) return { kind: 'chat', record, title: record.title, cwd: record.cwd };
    const entries = await claudeSessions.entries({ fresh: true });
    if (!entries) throw failed('listing_unavailable');
    const entry = entries.find((candidate) => candidate.sessionId === id);
    if (!entry) return orphanSession(id);
    return {
      kind: 'session',
      entry,
      title: typeof entry.name === 'string' ? entry.name : String(entry.id),
      cwd: entry.cwd,
    };
  }

  // A session the CLI no longer lists (removed or pruned, its conversation kept) that this dashboard
  // launched: some launch record names its short id, and the transcript on disk for that short id is
  // exactly this session. Anything else unlisted is still `session_not_found`. It is idle (it has no
  // process), runs from the standalone directory (the CLI finds a session by id, not by directory),
  // and has no listing entry to stop or wait for.
  async function orphanSession(id) {
    const short = id.slice(0, 8);
    const name = launchedName(id);
    if (name === null || (await claudeSessions.recoverSessionIds([short])).get(short) !== id)
      throw refused('session_not_found');
    return { kind: 'session', orphan: true, title: name, cwd: path.join(home, 'pathwise') };
  }

  // The size of the session's transcript now, 0 when it has none.
  const transcriptSize = (file) => {
    try {
      return file ? fs.statSync(file).size : 0;
    } catch {
      return 0;
    }
  };

  // The items of the transcript up to `end` bytes (all of it when not given), reading at most the last
  // 4 MiB of that.
  function readHistory(file, end) {
    if (!file) return { items: [], truncated: false };
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const limit = Math.min(end ?? Infinity, fs.fstatSync(fd).size);
      const start = Math.max(0, limit - MAX_TRANSCRIPT_BYTES);
      const buffer = Buffer.alloc(limit - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      let text = buffer.toString('utf8');
      // The read may begin inside a line: that line is dropped.
      if (start > 0) text = text.slice(text.indexOf('\n') + 1);
      const history = historyItems(text);
      return { items: history.items, truncated: history.truncated || start > 0 };
    } catch {
      return { items: [], truncated: false };
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  // ---- streams ----

  function broadcast(session, event, payload) {
    for (const stream of streams) {
      if (stream.session !== session || !stream.ready) continue;
      // A delta is dropped for a client that has not drained; an item or a state is always written.
      if (event === 'delta' && stream.congested) continue;
      if (stream.sink.send(event, payload) === false) stream.congested = true;
    }
  }

  // Starts a stream on `sink` for `session`: `hello` first (the history, then the turn in flight),
  // then every event of the session. Reports the client's drain and departure on the handle.
  async function open({ session, sink }) {
    requireSession(session);
    if (streams.size >= MAX_STREAMS)
      throw tooMany('TOO_MANY_STREAMS', 'Too many chat streams are open.', 429);
    const stream = { session, sink, ready: false, congested: false };
    streams.add(stream);
    try {
      // Everything that waits comes first; if a turn started or ended meanwhile it is read again, so
      // the history and the turn's items never overlap or leave a gap.
      for (;;) {
        const turn = turns.get(session);
        const target = turn?.target ?? (await resolveSession(session));
        const history = readHistory(await claudeSessions.transcriptFile(session), turn?.historyEnd);
        if (turns.get(session) !== turn) continue;
        stream.ready = true;
        const hello = {
          session,
          kind: target.kind,
          title: target.title,
          state: turn || target.entry?.state === 'working' ? 'working' : 'idle',
          live: Boolean(turn),
          items: [...history.items, ...(turn?.items ?? [])],
          truncated: history.truncated || Boolean(turn?.truncated),
          turn: finished.get(session) ?? null,
        };
        if (sink.send('hello', hello) === false) stream.congested = true;
        break;
      }
    } catch (error) {
      streams.delete(stream);
      throw error;
    }
    return {
      drained: () => {
        stream.congested = false;
      },
      close: () => streams.delete(stream),
    };
  }

  // ---- a turn ----

  // The turn's items are an upsert by id, the newest 500 kept.
  function remember(turn, item) {
    const at = turn.items.findIndex((known) => known.id === item.id);
    if (at !== -1) turn.items[at] = item;
    else turn.items.push(item);
    if (turn.items.length > MAX_TURN_ITEMS) {
      turn.items.shift();
      turn.truncated = true;
    }
  }

  function takeLine(turn, line) {
    if (line.length > MAX_LINE_CHARS) return;
    for (const { event, data } of liveMessages(line, turn.result)) {
      if (event === 'item') remember(turn, data.item);
      broadcast(turn.session, event, data);
    }
    // The first result ends the turn's input; the process ends it by itself.
    if ('outcome' in turn.result && !turn.input.writableEnded) turn.input.end();
  }

  function takeOutput(turn, chunk) {
    turn.pending += chunk;
    for (let end = turn.pending.indexOf('\n'); end !== -1; end = turn.pending.indexOf('\n')) {
      const line = turn.pending.slice(0, end);
      turn.pending = turn.pending.slice(end + 1);
      if (turn.dropping) turn.dropping = false;
      else takeLine(turn, line);
    }
    // A line that is still open and already over the limit is dropped, to its end.
    if (turn.pending.length > MAX_LINE_CHARS) {
      turn.pending = '';
      turn.dropping = true;
    }
  }

  // The turn is over: its mark is let go, the record and the streams say how it ended.
  function endTurn(turn, { code = null, spawnFailed = false } = {}) {
    if (turn.ended) return;
    turn.ended = true;
    timers.clearTimeout(turn.killTimer);
    if (turn.pending && !turn.dropping) takeLine(turn, turn.pending);
    const { result } = turn;
    const ending = turn.stopped
      ? { outcome: 'stopped', reason: null, error: null }
      : spawnFailed
        ? { outcome: 'failed', reason: 'spawn_failed', error: null }
        : 'outcome' in result
          ? { outcome: result.outcome, reason: result.reason, error: result.error }
          : { outcome: 'failed', reason: 'exited', error: null };
    const summary = { ...ending, denials: result.denials ?? [], costUsd: result.costUsd ?? null };
    if (summary.outcome === 'failed')
      logClaudeFailure(log, {
        step: 'turn',
        reason: summary.reason,
        exitCode: code,
        session: turn.session.slice(0, 8),
      });
    turn.release();
    turns.delete(turn.session);
    finished.delete(turn.session);
    finished.set(turn.session, summary);
    if (finished.size > MAX_FINISHED_TURNS) finished.delete(finished.keys().next().value);
    if (turn.record) recordOutcome(turn.record, summary.outcome);
    broadcast(turn.session, 'state', { state: 'idle', turn: summary });
  }

  function recordOutcome(record, outcome) {
    try {
      saveRecord({ ...record, lastTurnAt: iso(), lastOutcome: outcome });
    } catch {
      logClaudeFailure(log, {
        step: 'record',
        reason: 'not_saved',
        session: record.id.slice(0, 8),
      });
    }
  }

  // Starts the process of a turn and sends the message. Throws `spawn_failed` when it cannot start.
  function startTurn({ session, args, cwd, message, target, record, release, historyEnd }) {
    let child;
    try {
      child = spawn('claude', args, {
        cwd,
        env: withoutSecrets(process.env),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      logClaudeFailure(log, {
        step: 'spawn',
        reason: 'spawn_failed',
        exitCode: error.code ?? null,
        session: session.slice(0, 8),
      });
      throw failed('spawn_failed');
    }
    const turn = {
      session,
      target,
      record,
      release,
      historyEnd,
      input: child.stdin,
      items: [],
      truncated: false,
      result: {},
      pending: '',
      dropping: false,
      stopped: false,
      killTimer: null,
      ended: false,
      child,
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => takeOutput(turn, chunk));
    // What the CLI says on stderr is never read.
    child.stderr.resume();
    child.stdin.on('error', () => {});
    // A process that never started has no pid; any other `error` (a signal that could not be sent)
    // leaves it running, so the turn goes on.
    child.on('error', () => {
      if (child.pid === undefined) endTurn(turn, { spawnFailed: true });
    });
    child.on('close', (code) => endTurn(turn, { code }));
    child.stdin.write(
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: message } })}\n`,
    );
    return turn;
  }

  // Brings a listed session to a stop, so the turn continues it. Answers the entry it settled on.
  async function settle(id) {
    const settled = await settleSession({
      observe: async () => {
        const listing = await claudeSessions.entries({ fresh: true });
        return { listing, session: listing?.find((entry) => entry.sessionId === id) ?? null };
      },
      stop: (session) => claudeSessions.stop({ sessionId: session.sessionId }),
      wait: () => pause(timers),
      limit: FINISH_POLL_LIMIT,
    });
    if (settled.status === 'settled') return settled.session;
    const { reason } = settled;
    if (reason === 'session_running' || reason === 'session_not_found') throw refused(reason);
    // A stop the CLI could not make leaves the session as it was: the turn cannot start.
    throw failed(reason === 'resume_failed' ? 'spawn_failed' : reason);
  }

  // A standalone chat that does not exist yet: its record, as `resolveSession` gives one.
  function newChat(id, message) {
    const record = {
      id,
      title: titleOf(message),
      cwd: path.join(home, 'pathwise'),
      createdAt: iso(),
      lastTurnAt: iso(),
      lastOutcome: null,
    };
    return { kind: 'chat', record, title: record.title, cwd: record.cwd };
  }

  // Sends `message` to the session `session`, or to a new standalone chat when none is given. Answers
  // once the process has started.
  async function send({ message, session }) {
    requireMessage(message);
    if (session !== undefined) requireSession(session);
    const id = session ?? randomUUID();
    if (turns.has(id) || starting.has(id)) throw refused('chat_busy');
    starting.add(id);
    let release = null;
    try {
      const target = session === undefined ? newChat(id, message) : await resolveSession(id);
      // Counted after the session is known, so a listing that fails says so before the cap does.
      if (turns.size + starting.size > MAX_TURNS) throw refused('too_many_turns');
      let { record = null, cwd } = target;
      if (target.kind === 'session' && !target.orphan) {
        if (target.entry.state === 'working') throw refused('session_running');
        cwd = (await settle(id)).cwd;
        // Without a directory the process would run in the dashboard's own.
        if (typeof cwd !== 'string' || !cwd) throw failed('spawn_failed');
      }
      // The mark comes after the stop-poll, not before the listing reads: a held session reads as
      // working (so it could never be told from work elsewhere, or settle). Nothing awaits between the
      // last read and here, and another writer that holds the mark first gives `session_running`; the
      // stop-poll itself, up to FINISH_POLL_LIMIT seconds, is unguarded, as it is for the launcher.
      release = claudeSessions.beginTurn(id);
      if (!release) throw refused('session_running');
      const file = await claudeSessions.transcriptFile(id);
      if (record) {
        record = { ...record, lastTurnAt: iso(), lastOutcome: null };
        saveRecord(record);
      }
      const resuming = target.kind === 'session' || Boolean(file);
      let turn;
      try {
        turn = startTurn({
          session: id,
          args: [...TURN_ARGS, ...(resuming ? ['--resume', id] : ['--session-id', id])],
          cwd,
          message,
          target: { kind: target.kind, title: target.title },
          record,
          release,
          historyEnd: transcriptSize(file),
        });
      } catch (error) {
        if (record) recordOutcome(record, 'failed');
        throw error;
      }
      release = null;
      turns.set(id, turn);
      const user = { id: randomUUID(), kind: 'user', text: message };
      remember(turn, user);
      broadcast(id, 'state', { state: 'working' });
      broadcast(id, 'item', { item: user });
      return { ok: true, session: id, chat: record ? publicChat(record) : null };
    } catch (error) {
      release?.();
      throw error;
    } finally {
      starting.delete(id);
    }
  }

  // One timer that does not keep the process alive.
  const later = (delay, action) => {
    const handle = timers.setTimeout(action, delay);
    handle.unref?.();
    return handle;
  };

  // Interrupts the session's turn: SIGINT, SIGTERM if the process has not closed 5 s later, and
  // SIGKILL 5 s after that, so a process that ignores both cannot hold the session for good.
  async function stop({ session }) {
    requireSession(session);
    const turn = turns.get(session);
    if (!turn) throw refused('no_turn');
    if (!turn.stopped) {
      turn.stopped = true;
      turn.child.kill('SIGINT');
      turn.killTimer = later(STOP_GRACE_MS, () => {
        turn.child.kill('SIGTERM');
        turn.killTimer = later(STOP_GRACE_MS, () => turn.child.kill('SIGKILL'));
      });
    }
    return { ok: true };
  }

  // The service stops: every turn's process is ended and every stream with it.
  function close() {
    for (const turn of turns.values()) {
      timers.clearTimeout(turn.killTimer);
      turn.child.kill('SIGTERM');
    }
    for (const stream of streams) {
      try {
        stream.sink.end();
      } catch {}
    }
    streams.clear();
  }

  return { list, send, stop, open, close };
}
