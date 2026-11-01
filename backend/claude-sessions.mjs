// claude-sessions.mjs — the Claude CLI's session listing (for the watcher's picker and prune), the
// stop of an idle background session and the resume that continues a finished one.
//
// Everything runs as a fixed argument array with no shell. The listing carries session names and
// working directories; neither is logged, stored or sent beyond the picker's name, and the CLI's
// output and error text never leave this module.

import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isSessionId } from './slack-watch-store.mjs';

const CLAUDE_BIN = 'claude';
const LISTING_ARGS = ['agents', '--json', '--all'];
const LISTING_TIMEOUT_MS = 15_000;
const LISTING_MAX_BYTES = 8 * 1024 * 1024;
const STOP_TIMEOUT_MS = 30_000;
const STOP_MAX_BYTES = 1024 * 1024;
const RESUME_TIMEOUT_MS = 30_000;
const RESUME_MAX_BYTES = 1024 * 1024;
const UNTRUSTED_WORKSPACE_MARKER = 'Workspace not trusted';
// What the CLI prints when a resume found the session running and continued it as a copy.
const FORK_MARKER = 'started a copy';

const delivered = (reason) => ({ status: 'delivered', ...(reason && { reason }) });
const failure = (status, reason) => ({ status, reason });

// A live process has a numeric pid, a finished session has none; any other pid is not trusted.
function stateOf(entry) {
  if (typeof entry.pid === 'number') return 'live';
  return 'pid' in entry ? 'unknown' : 'finished';
}

// Only a background process with a trusted pid has an activity the watcher may act on.
function activityOf(entry) {
  if (entry.kind !== 'background' || typeof entry.pid !== 'number') return null;
  return entry.status === 'idle' || entry.status === 'busy' ? entry.status : null;
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
  metadataIO = { readdir, readFile },
}) {
  let sharedListing = null;
  let activityCache = new Map();
  let pickerRequest = 0;
  let cachedPickerRequest = 0;
  const pendingActivities = new Map();

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

  async function transcriptPaths(entries) {
    const ids = new Set(entries.map(({ sessionId }) => sessionId));
    const found = new Map();
    let incomplete = false;
    let projects;
    try {
      projects = await metadataIO.readdir(projectsDir, { withFileTypes: true });
    } catch (error) {
      return { paths: found, incomplete: error.code !== 'ENOENT' };
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
        const sessionId = file.name.slice(0, -'.jsonl'.length);
        if (!ids.has(sessionId)) continue;
        if (!found.has(sessionId)) found.set(sessionId, []);
        found.get(sessionId).push(path.join(directory, file.name));
      }
    }
    return { paths: found, incomplete };
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
  async function stop({ sessionId }) {
    if (!isSessionId(sessionId)) return { status: 'not_listed' };
    const entries = await readEntries();
    if (!entries) return failure('failed-transient', 'listing_unavailable');
    const shortId = sessionId.slice(0, 8);
    const sharedShortId = entries.some(
      (entry) => entry.sessionId !== sessionId && entry.sessionId.slice(0, 8) === shortId,
    );
    if (sharedShortId) return failure('failed-permanent', 'ambiguous_id');
    const entry = entries.find((candidate) => candidate.sessionId === sessionId);
    if (!entry || entry.id !== shortId) return { status: 'not_listed' };
    const activity = activityOf(entry);
    if (activity !== 'idle') return { status: 'not_idle', activity };

    const { error } = await run(['stop', shortId], {
      timeout: STOP_TIMEOUT_MS,
      maxBuffer: STOP_MAX_BYTES,
    });
    if (!error) return { status: 'stopped' };
    return failure('failed-transient', error.killed ? 'timed_out' : 'stop_failed');
  }

  async function resume({ sessionId, notice }) {
    const entries = await readEntries();
    if (!entries) return failure('failed-transient', 'listing_unavailable');
    const entry = entries.find((candidate) => candidate.sessionId === sessionId);
    if (!entry) return delivered('not_listed');
    if (stateOf(entry) !== 'finished') return { status: 'waiting', reason: 'live_at_resume' };
    if (typeof entry.cwd !== 'string' || !entry.cwd)
      return failure('failed-transient', 'spawn_failed');

    const { error, stdout, stderr } = await run(['--bg', '--resume', sessionId, '--', notice], {
      cwd: entry.cwd,
      timeout: RESUME_TIMEOUT_MS,
      maxBuffer: RESUME_MAX_BYTES,
    });
    const output = `${stdout}${stderr}`;
    // A copy may exist even when the CLI exits with an error, and a retry would start another.
    if (output.includes(FORK_MARKER)) return failure('failed-permanent', 'resume_forked');
    if (!error) return delivered('resumed');
    if (error.code === 1 && output.includes(UNTRUSTED_WORKSPACE_MARKER))
      return failure('failed-permanent', 'untrusted_workspace');
    return failure('failed-transient', error.killed ? 'timed_out' : 'spawn_failed');
  }

  return { listSessions, stop, resume };
}
