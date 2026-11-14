// claude-sessions.mjs — the Claude CLI's session listing (for the watcher's picker and prune), the
// stop of an idle background session, the resume that continues a finished one and the launch of a
// new background session, and the one-writer mark (`beginTurn`) that keeps a chat turn and a resume
// off the same session.
//
// `lastActive` reads only file modification times (stat, never content). Only the times it returns,
// keyed by session id, leave this module; no name, path or cwd does. `transcriptFile` is the one
// other call that looks at a transcript, and it too only stats: it gives the chat the path to read.
// `transcriptFiles` is the same for the usage tally: names and directory listings, never content.
//
// Everything runs as a fixed argument array with no shell. The listing carries session names and
// working directories; neither is logged, stored or sent beyond the picker's name. The CLI's output
// and error text never leave this module either, with one exception: a stop or a resume that does
// not go through logs one line (see claude-log.mjs) with the exit code and a truncated copy of the
// output, so a lost send can be diagnosed. Only a dashboard send (a call that names its ticket) logs;
// the Slack wake's calls log nothing. The notice is cut out of that copy and never logged.

import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withoutSecrets } from './config.mjs';
import { isSessionId } from './slack-watch-store.mjs';
import { cliOutputForLog, defaultClaudeLog, logClaudeFailure } from './claude-log.mjs';

const CLAUDE_BIN = 'claude';
const LISTING_ARGS = ['agents', '--json', '--all'];
const LISTING_TIMEOUT_MS = 15_000;
const LISTING_MAX_BYTES = 8 * 1024 * 1024;
const STOP_TIMEOUT_MS = 30_000;
const STOP_MAX_BYTES = 1024 * 1024;
const RESUME_TIMEOUT_MS = 30_000;
const RESUME_MAX_BYTES = 1024 * 1024;
const LAUNCH_TIMEOUT_MS = 30_000;
const LAUNCH_MAX_BYTES = 1024 * 1024;
const UNTRUSTED_WORKSPACE_MARKER = 'Workspace not trusted';
// What the CLI prints when a resume found the session running and continued it as a copy.
const FORK_MARKER = 'started a copy';
// The short id a background start prints: a standalone token, not a part of a longer id.
const STARTED_ID = /(?<![\w-])[0-9a-f]{8}(?![\w-])/;

const SHORT_ID = /^[0-9a-f]{8}$/;

const delivered = (reason) => ({ status: 'delivered', ...(reason && { reason }) });
const failure = (status, reason) => ({ status, reason });

// How a stop that did not stop is reported by `settleSession`: a session that is not idle or no longer
// listed is said so, any other failure of the CLI is a failed resume.
const STOP_FAILURES = { not_idle: 'session_running', not_listed: 'session_not_found' };

// A live process has a numeric pid, a finished session has none; any other pid is not trusted. The
// one exception is a session the CLI lists as `stopped` (ended with `claude stop`), which it reports
// with `pid: null`: that is finished, and without it such a session could never be resumed.
export function stateOf(entry) {
  if (typeof entry.pid === 'number') return 'live';
  if (entry.pid === null && entry.state === 'stopped') return 'finished';
  return 'pid' in entry ? 'unknown' : 'finished';
}

// Only a background process with a trusted pid has an activity the watcher may act on.
function activityOf(entry) {
  if (entry.kind !== 'background' || typeof entry.pid !== 'number') return null;
  return entry.status === 'idle' || entry.status === 'busy' ? entry.status : null;
}

// Brings a session to a stop, so that a resume continues it instead of starting a copy of it: a live
// session is stopped, then its entry is polled until it has no pid (the CLI's stop returns before the
// process is gone), at most `limit` observations with `wait()` between them. `observe()` reads the
// listing again and answers `{ listing, session }` (no listing: unavailable; no session: not listed),
// `stop(session)` stops the session just read. Answers `{ status: 'settled', session }` or
// `{ status: 'failed', reason }`.
export async function settleSession({ observe, stop, wait, limit }) {
  const unsettled = (reason) => ({ status: 'failed', reason });
  let { listing, session } = await observe();
  if (!listing) return unsettled('listing_unavailable');
  if (!session) return unsettled('session_not_found');
  if (typeof session.pid === 'number') {
    const stopped = await stop(session);
    if (stopped.status !== 'stopped')
      return unsettled(STOP_FAILURES[stopped.status] ?? 'resume_failed');
  }
  for (let attempt = 1; ; attempt += 1) {
    ({ listing, session } = await observe());
    if (!listing) return unsettled('listing_unavailable');
    if (!session) return unsettled('session_not_found');
    if (stateOf(session) === 'finished') return { status: 'settled', session };
    if (attempt >= limit) return unsettled('live_at_resume');
    await wait();
  }
}

const fingerprint = ({ dev, ino, size, mtimeMs, ctimeMs }) =>
  [dev, ino, size, mtimeMs, ctimeMs].join(':');

// Cache only activity and title metadata, never conversation content. Files fail independently.
export async function readTranscriptActivities(
  files,
  cache,
  io = { stat, readFile },
  pending = new Map(),
) {
  const result = new Map();
  for (const file of files) {
    try {
      const before = await io.stat(file);
      if (!before.isFile()) continue;
      const key = fingerprint(before);
      const cached = cache.get(file);
      if (cached?.fingerprint === key) {
        result.set(file, cached);
        continue;
      }
      let reading = pending.get(file);
      if (!reading || reading.fingerprint !== key) {
        const promise = (async () => {
          let latest = null;
          let title;
          let titlePriority = 0;
          let trailingIncomplete = false;
          const sessionId = path.basename(file, '.jsonl');
          const text = await io.readFile(file, 'utf8');
          const lines = text.split('\n');
          for (const [index, line] of lines.entries()) {
            let record;
            try {
              record = JSON.parse(line);
            } catch {
              // An unterminated invalid record may still be in the middle of a write.
              if (index === lines.length - 1 && line.trim()) trailingIncomplete = true;
              continue;
            }
            if (!record || typeof record !== 'object') continue;
            const time = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
            if (Number.isFinite(time) && (latest === null || time > latest)) latest = time;
            const priority =
              record.type === 'custom-title' ? 2 : record.type === 'ai-title' ? 1 : 0;
            const name = priority === 2 ? record.customTitle : record.aiTitle;
            if (
              priority >= titlePriority &&
              priority > 0 &&
              (record.sessionId === undefined || record.sessionId === sessionId) &&
              typeof name === 'string' &&
              name.trim()
            ) {
              title = name;
              titlePriority = priority;
            }
          }
          const after = await io.stat(file);
          return {
            fingerprint: fingerprint(after) === key ? key : null,
            timestamp: latest,
            title,
            titlePriority,
            trailingIncomplete,
          };
        })();
        reading = { fingerprint: key, promise };
        pending.set(file, reading);
        promise
          .finally(() => {
            if (pending.get(file) === reading) pending.delete(file);
          })
          .catch(() => {});
      }
      result.set(file, await reading.promise);
    } catch {
      // Other copies of the same session may still be readable.
    }
  }
  return result;
}

export function createClaudeSessions({
  execFileImpl = execFile,
  store,
  projectsDir = path.join(
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
    'projects',
  ),
  sessionsDir = path.join(path.dirname(projectsDir), 'sessions'),
  readActivities = readTranscriptActivities,
  metadataIO = { readdir, readFile, stat },
  log = defaultClaudeLog,
}) {
  let sharedListing = null;
  let activityCache = new Map();
  let pickerRequest = 0;
  let cachedPickerRequest = 0;
  const pendingActivities = new Map();
  // The sessions a chat turn or a resume is writing to right now, in this process.
  const held = new Set();

  // The one-writer mark: a release function, or null while another writer holds the session. The
  // release lets go once, so a late call never frees a mark someone else took since.
  function beginTurn(sessionId) {
    if (held.has(sessionId)) return null;
    held.add(sessionId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      held.delete(sessionId);
    };
  }

  // Whether a chat turn or a resume in this process is writing to the session now. `entries` shows
  // that on a listed session; this is for one the listing no longer shows.
  const isHeld = (sessionId) => held.has(sessionId);

  function run(args, options) {
    return new Promise((resolve) => {
      try {
        execFileImpl(CLAUDE_BIN, args, options, (error, stdout, stderr) =>
          resolve({ error, stdout, stderr }),
        );
      } catch (error) {
        resolve({ error, stdout: '', stderr: '' });
      }
    });
  }

  // The CLI's entries that carry a session UUID, or null when the CLI gave no usable listing.
  async function readEntries() {
    const { error, stdout } = await run(LISTING_ARGS, {
      timeout: LISTING_TIMEOUT_MS,
      maxBuffer: LISTING_MAX_BYTES,
    });
    if (error) return null;
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return null;
    }
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((entry) => entry && isSessionId(entry.sessionId));
  }

  function attachedSessionIds() {
    const links = Object.values(store.snapshot().links);
    return new Set(links.flatMap((link) => link.sessionIds));
  }

  // Calls `visit(sessionId, file)` for every regular `<name>.jsonl` file in a project folder (a
  // folder of the same name, such as a session's subagents, is not one). Only directory listings are
  // read. `incomplete` says some folder could not be listed.
  async function scanTranscripts(visit) {
    let incomplete = false;
    let projects;
    try {
      projects = await metadataIO.readdir(projectsDir, { withFileTypes: true });
    } catch (error) {
      return { incomplete: error.code !== 'ENOENT' };
    }
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const directory = path.join(projectsDir, project.name);
      let files;
      try {
        files = await metadataIO.readdir(directory, { withFileTypes: true });
      } catch {
        incomplete = true;
        continue;
      }
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
        visit(file.name.slice(0, -'.jsonl'.length), path.join(directory, file.name));
      }
    }
    return { incomplete };
  }

  async function transcriptPaths(entries) {
    const ids = new Set(entries.map(({ sessionId }) => sessionId));
    const found = new Map();
    const { incomplete } = await scanTranscripts((sessionId, file) => {
      if (!ids.has(sessionId)) return;
      if (!found.has(sessionId)) found.set(sessionId, []);
      found.get(sessionId).push(file);
    });
    return { paths: found, incomplete };
  }

  // The full session id of each short id (8 hex) whose transcript is on disk, as a Map. The CLI drops
  // a removed or pruned session from its listing but keeps the conversation, and a launch record
  // keeps only the short id. A short id counts only when every transcript that starts with it is the
  // same session (a copy in another project folder is the same id); two different ids behind one
  // prefix, or none, leave it out. Directory listings only, never an error: an unreadable folder
  // recovers nothing.
  async function recoverSessionIds(shortIds) {
    const wanted = new Set(shortIds.filter((id) => typeof id === 'string' && SHORT_ID.test(id)));
    const found = new Map();
    if (!wanted.size) return found;
    await scanTranscripts((sessionId) => {
      const short = sessionId.slice(0, 8);
      if (!wanted.has(short) || !isSessionId(sessionId)) return;
      found.set(short, [...(found.get(short) ?? []), sessionId]);
    });
    const unique = new Map();
    for (const [short, ids] of found) if (new Set(ids).size === 1) unique.set(short, ids[0]);
    return unique;
  }

  // The newest modification time, in ms, of the files that can be stat'ed, or null when none can.
  async function newestMtime(files) {
    let newest = null;
    for (const file of files) {
      try {
        const { mtimeMs } = await metadataIO.stat(file);
        if (newest === null || mtimeMs > newest) newest = mtimeMs;
      } catch {
        // The other files of the same session may still be readable.
      }
    }
    return newest;
  }

  // The transcripts of a session's subagents, which sit beside its transcript in its project folder.
  async function subagentPaths(projectDirectory, sessionId) {
    try {
      const files = await metadataIO.readdir(path.join(projectDirectory, sessionId, 'subagents'), {
        withFileTypes: true,
      });
      return files
        .filter((file) => file.isFile() && file.name.endsWith('.jsonl'))
        .map((file) => path.join(projectDirectory, sessionId, 'subagents', file.name));
    } catch {
      return [];
    }
  }

  // Each listed session's last activity in ms, keyed by session id: the newest modification time of
  // its transcript copies, and for a working session also of its subagents' transcripts, since a
  // session waiting on a long subagent writes only there. A session with no readable file has no
  // entry. Only stat is used, so no transcript content is read.
  async function lastActive(entries) {
    const times = new Map();
    if (!entries.length) return times;
    const { paths } = await transcriptPaths(entries);
    await Promise.all(
      entries.map(async ({ sessionId, state }) => {
        const copies = paths.get(sessionId) ?? [];
        const files = [...copies];
        if (state === 'working') {
          for (const copy of copies)
            files.push(...(await subagentPaths(path.dirname(copy), sessionId)));
        }
        const newest = await newestMtime(files);
        if (newest !== null) times.set(sessionId, newest);
      }),
    );
    return times;
  }

  async function registryNames(attached) {
    const names = new Map();
    let incomplete = false;
    if (!attached.size) return { names, incomplete };
    let files;
    try {
      files = await metadataIO.readdir(sessionsDir, { withFileTypes: true });
    } catch (error) {
      return { names, incomplete: error.code !== 'ENOENT' };
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue;
      let text;
      try {
        text = await metadataIO.readFile(path.join(sessionsDir, file.name), 'utf8');
      } catch {
        incomplete = true;
        continue;
      }
      try {
        const { sessionId, name } = JSON.parse(text);
        if (attached.has(sessionId) && typeof name === 'string' && name.trim())
          names.set(sessionId, name);
      } catch {
        // A stale or malformed record must not hide the rest.
      }
    }
    return { names, incomplete };
  }

  async function buildListing() {
    const attached = attachedSessionIds();
    const entries = await readEntries();
    if (!entries)
      return {
        entries,
        attached,
        listing: {
          source: 'map',
          sessions: [...attached].map((sessionId) => ({
            sessionId,
            state: 'unknown',
            attached: true,
          })),
        },
      };
    return {
      entries,
      attached,
      listing: {
        source: 'claude',
        sessions: entries.map((entry) => ({
          sessionId: entry.sessionId,
          state: stateOf(entry),
          name: typeof entry.name === 'string' ? entry.name : undefined,
          attached: attached.has(entry.sessionId),
          activity: activityOf(entry),
        })),
      },
    };
  }

  async function sortListing({ entries, listing, attached }, request) {
    const sortable = entries ?? listing.sessions;
    const allIds = new Set(sortable.map(({ sessionId }) => sessionId));
    const extra = [...attached]
      .filter((sessionId) => !allIds.has(sessionId))
      .map((sessionId) => ({ sessionId }));
    const [transcripts, registry] = await Promise.all([
      transcriptPaths([...sortable, ...extra]),
      registryNames(attached),
    ]);
    const { paths } = transcripts;
    const { names } = registry;
    const listedNames = new Map(listing.sessions.map(({ sessionId, name }) => [sessionId, name]));
    const needsMetadata = [...attached].filter((sessionId) => {
      const name = listedNames.get(sessionId);
      return typeof name !== 'string' || !name.trim();
    });
    const needsTranscript = needsMetadata.filter((sessionId) => !names.has(sessionId));
    const scanIds = new Set([
      ...allIds,
      ...extra.filter(({ sessionId }) => !names.has(sessionId)).map(({ sessionId }) => sessionId),
    ]);
    const files = [...scanIds].flatMap((sessionId) => paths.get(sessionId) ?? []);
    let activities;
    try {
      activities = await readActivities(files, activityCache, undefined, pendingActivities);
    } catch {
      // The listing remains usable even if transcript scanning fails.
      activities = new Map();
    }
    if (request > cachedPickerRequest) {
      cachedPickerRequest = request;
      activityCache =
        transcripts.incomplete || files.some((file) => !activities.has(file))
          ? new Map([...activityCache, ...activities])
          : activities;
    }
    const namesIncomplete =
      (needsMetadata.length > 0 && registry.incomplete) ||
      (needsTranscript.length > 0 && transcripts.incomplete) ||
      needsTranscript.some((sessionId) =>
        (paths.get(sessionId) ?? []).some((file) => {
          const activity = activities.get(file);
          return !activity || activity.fingerprint === null || activity.trailingIncomplete;
        }),
      );
    const times = new Map();
    for (const entry of sortable) {
      let timestamp = null;
      for (const file of paths.get(entry.sessionId) ?? []) {
        const time = activities.get(file)?.timestamp;
        if (time != null && (timestamp === null || time > timestamp)) timestamp = time;
      }
      times.set(
        entry.sessionId,
        timestamp ?? (Number.isFinite(entry.startedAt) ? entry.startedAt : -Infinity),
      );
    }
    const sessions = [...listing.sessions].sort((left, right) => {
      const a = times.get(left.sessionId);
      const b = times.get(right.sessionId);
      return a === b ? 0 : a > b ? -1 : 1;
    });
    const attachedNames = {};
    for (const sessionId of attached) {
      if (typeof listedNames.get(sessionId) === 'string' && listedNames.get(sessionId).trim())
        continue;
      let best;
      for (const file of paths.get(sessionId) ?? []) {
        const candidate = activities.get(file);
        if (
          candidate?.title &&
          (!best ||
            candidate.titlePriority > best.titlePriority ||
            (candidate.titlePriority === best.titlePriority &&
              (candidate.timestamp ?? -Infinity) > (best.timestamp ?? -Infinity)))
        )
          best = candidate;
      }
      const name = names.get(sessionId) ?? best?.title;
      if (name) attachedNames[sessionId] = name;
    }
    return {
      ...listing,
      sessions,
      ...(Object.keys(attachedNames).length && { attachedNames }),
      ...(namesIncomplete && { namesIncomplete: true }),
    };
  }

  // The watcher shares only an active CLI run; it never waits on or reuses a completed sort.
  function rawListing() {
    if (!sharedListing) {
      const current = buildListing().finally(() => {
        if (sharedListing === current) sharedListing = null;
      });
      sharedListing = current;
    }
    return sharedListing;
  }

  function listSessions({ sortByActivity = true } = {}) {
    if (!sortByActivity) return rawListing().then(({ listing }) => listing);
    const request = ++pickerRequest;
    return buildListing().then((result) => sortListing(result, request));
  }

  // The CLI stops a session by the first eight characters of its id, so a listed session that
  // shares them makes the short id ambiguous. The fresh listing must show this exact session idle.
  // `ticket` is the ticket key of a dashboard send: a caller that gives one gets a failure logged
  // with it, and a caller that does not (the Slack wake) logs nothing.
  async function stop({ sessionId, ticket }) {
    if (!isSessionId(sessionId)) return { status: 'not_listed' };
    const shortId = sessionId.slice(0, 8);
    const failed = (result, extra = {}) => {
      if (ticket !== undefined)
        logClaudeFailure(log, {
          step: 'stop',
          reason: result.reason ?? result.status,
          session: shortId,
          ticket,
          ...extra,
        });
      return result;
    };
    const entries = await readEntries();
    if (!entries) return failed(failure('failed-transient', 'listing_unavailable'));
    const sharedShortId = entries.some(
      (entry) => entry.sessionId !== sessionId && entry.sessionId.slice(0, 8) === shortId,
    );
    if (sharedShortId) return failed(failure('failed-permanent', 'ambiguous_id'));
    const entry = entries.find((candidate) => candidate.sessionId === sessionId);
    if (!entry || entry.id !== shortId) return { status: 'not_listed' };
    const activity = activityOf(entry);
    if (activity !== 'idle') return failed({ status: 'not_idle', activity });

    const { error, stdout, stderr } = await run(['stop', shortId], {
      timeout: STOP_TIMEOUT_MS,
      maxBuffer: STOP_MAX_BYTES,
    });
    if (!error) return { status: 'stopped' };
    return failed(failure('failed-transient', error.killed ? 'timed_out' : 'stop_failed'), {
      exitCode: error.code ?? null,
      output: cliOutputForLog(`${stdout}${stderr}`),
    });
  }

  // `ticket` has the same meaning as for `stop`. The notice is never logged. The session is held for
  // the length of its CLI call, and a session someone else holds is waited on as if it were live.
  async function resume({ sessionId, notice, ticket }) {
    const shortId = typeof sessionId === 'string' ? sessionId.slice(0, 8) : undefined;
    const failed = (result, extra = {}) => {
      if (ticket !== undefined)
        logClaudeFailure(log, {
          step: 'resume',
          reason: result.reason ?? result.status,
          session: shortId,
          ticket,
          ...extra,
        });
      return result;
    };
    const entries = await readEntries();
    if (!entries) return failed(failure('failed-transient', 'listing_unavailable'));
    const entry = entries.find((candidate) => candidate.sessionId === sessionId);
    if (!entry) return delivered('not_listed');
    if (stateOf(entry) !== 'finished')
      return failed({ status: 'waiting', reason: 'live_at_resume' }, { pid: entry.pid ?? null });
    if (typeof entry.cwd !== 'string' || !entry.cwd)
      return failed(failure('failed-transient', 'spawn_failed'));

    const release = beginTurn(sessionId);
    if (!release) return failed({ status: 'waiting', reason: 'live_at_resume' }, { pid: null });
    const { error, stdout, stderr } = await run(['--bg', '--resume', sessionId, '--', notice], {
      cwd: entry.cwd,
      env: withoutSecrets(process.env),
      timeout: RESUME_TIMEOUT_MS,
      maxBuffer: RESUME_MAX_BYTES,
    });
    release();
    const output = `${stdout}${stderr}`;
    const detail = () => ({
      exitCode: error?.code ?? 0,
      output: cliOutputForLog(output, notice),
    });
    // A copy may exist even when the CLI exits with an error, and a retry would start another.
    if (output.includes(FORK_MARKER))
      return failed(failure('failed-permanent', 'resume_forked'), detail());
    if (!error) return delivered('resumed');
    if (error.code === 1 && output.includes(UNTRUSTED_WORKSPACE_MARKER))
      return failed(failure('failed-permanent', 'untrusted_workspace'), detail());
    return failed(
      failure('failed-transient', error.killed ? 'timed_out' : 'spawn_failed'),
      detail(),
    );
  }

  // The CLI's entries from the listing that concurrent callers share, or from a read of their own
  // when a decision must not rest on an answer that was already in flight. Null when unavailable.
  // A session that is held (a chat turn, a resume under way) reads as working, so the launcher's
  // guards, the ticket card and the bot bar all see it as work in progress.
  async function entries({ fresh = false } = {}) {
    const listed = fresh ? await readEntries() : (await rawListing()).entries;
    if (!listed) return listed;
    return listed.map((entry) =>
      held.has(entry.sessionId) ? { ...entry, state: 'working' } : entry,
    );
  }

  // The path of the newest copy of a session's transcript, or null when it has none. Only stat is
  // used, so no transcript content is read here; the chat reads the file itself.
  async function transcriptFile(sessionId) {
    if (!isSessionId(sessionId)) return null;
    const { paths } = await transcriptPaths([{ sessionId }]);
    let newest = null;
    let newestMs = -Infinity;
    for (const file of paths.get(sessionId) ?? []) {
      try {
        const { mtimeMs } = await metadataIO.stat(file);
        if (mtimeMs > newestMs) [newest, newestMs] = [file, mtimeMs];
      } catch {
        // The other copies may still be there.
      }
    }
    return newest;
  }

  // The transcript files that make up a session's usage: its newest transcript copy, then the
  // transcripts of its subagents beside that copy. Several copies of one session are not summed (they
  // are the same conversation). Names and directory listings only; empty for a session with none.
  async function transcriptFiles(sessionId) {
    const main = await transcriptFile(sessionId);
    if (!main) return [];
    return [main, ...(await subagentPaths(path.dirname(main), sessionId))];
  }

  // Starts a background session named `name` that runs `prompt` from `cwd`, with access to `addDir`
  // when one is given, the built-in `tools` only when given, none of `disallowedTools` when given, and
  // only the MCP servers in the `mcpConfig` file when given (`--strict-mcp-config`).
  // The prompt follows `--`, so it is never read as an option. Returns the id the CLI printed, or
  // null when it printed none.
  async function launch({ name, prompt, cwd, addDir, tools, disallowedTools, mcpConfig }) {
    const env = withoutSecrets(process.env);
    const { error, stdout, stderr } = await run(
      [
        '--bg',
        ...(addDir ? ['--add-dir', addDir] : []),
        ...(tools ? ['--tools', tools.join(',')] : []),
        ...(disallowedTools ? ['--disallowedTools', disallowedTools.join(',')] : []),
        ...(mcpConfig ? ['--strict-mcp-config', '--mcp-config', mcpConfig] : []),
        '-n',
        name,
        '--',
        prompt,
      ],
      { cwd, env, timeout: LAUNCH_TIMEOUT_MS, maxBuffer: LAUNCH_MAX_BYTES },
    );
    if (!error) return { ...delivered(), id: stdout.match(STARTED_ID)?.[0] ?? null };
    if (error.code === 1 && `${stdout}${stderr}`.includes(UNTRUSTED_WORKSPACE_MARKER))
      return failure('failed-permanent', 'untrusted_workspace');
    return failure('failed-transient', error.killed ? 'timed_out' : 'spawn_failed');
  }

  return {
    listSessions,
    stop,
    resume,
    entries,
    launch,
    lastActive,
    beginTurn,
    isHeld,
    transcriptFile,
    transcriptFiles,
    recoverSessionIds,
  };
}
