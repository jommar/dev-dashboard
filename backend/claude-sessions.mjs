// claude-sessions.mjs — the Claude CLI's session listing (for the watcher's picker and prune), the
// stop of an idle background session and the resume that continues a finished one.
//
// Everything runs as a fixed argument array with no shell. The listing carries session names and
// working directories; neither is logged, stored or sent beyond the picker's name, and the CLI's
// output and error text never leave this module.

import { execFile } from 'node:child_process';
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

export function createClaudeSessions({ execFileImpl = execFile, store }) {
  let sharedListing = null;

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

  async function buildListing() {
    const attached = attachedSessionIds();
    const entries = await readEntries();
    if (!entries)
      return {
        source: 'map',
        sessions: [...attached].map((sessionId) => ({
          sessionId,
          state: 'unknown',
          attached: true,
        })),
      };
    return {
      source: 'claude',
      sessions: entries.map((entry) => ({
        sessionId: entry.sessionId,
        state: stateOf(entry),
        name: typeof entry.name === 'string' ? entry.name : undefined,
        attached: attached.has(entry.sessionId),
        activity: activityOf(entry),
      })),
    };
  }

  // Calls that arrive while the CLI is running share that one run.
  function listSessions() {
    sharedListing ??= buildListing().finally(() => {
      sharedListing = null;
    });
    return sharedListing;
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
    if (activityOf(entry) !== 'idle') return { status: 'not_idle' };

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
