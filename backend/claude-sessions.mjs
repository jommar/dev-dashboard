// claude-sessions.mjs — the Claude CLI's session listing (for the watcher's picker and prune)
// and the resume that wakes a finished session.
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
const RESUME_TIMEOUT_MS = 30_000;
const RESUME_MAX_BYTES = 1024 * 1024;
const UNTRUSTED_WORKSPACE_MARKER = 'Workspace not trusted';

const delivered = (reason) => ({ status: 'delivered', ...(reason && { reason }) });
const failure = (status, reason) => ({ status, reason });

// A live process has a numeric pid, a finished session has none; any other pid is not trusted.
function stateOf(entry) {
  if (typeof entry.pid === 'number') return 'live';
  return 'pid' in entry ? 'unknown' : 'finished';
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

  async function resume({ sessionId, notice }) {
    const entries = await readEntries();
    if (!entries) return failure('failed-transient', 'listing_unavailable');
    const entry = entries.find((candidate) => candidate.sessionId === sessionId);
    if (!entry) return delivered('not_listed');
    if (stateOf(entry) !== 'finished') return failure('failed-permanent', 'live_at_resume');
    if (typeof entry.cwd !== 'string' || !entry.cwd)
      return failure('failed-transient', 'spawn_failed');

    const { error, stdout, stderr } = await run(['--bg', '--resume', sessionId, '--', notice], {
      cwd: entry.cwd,
      timeout: RESUME_TIMEOUT_MS,
      maxBuffer: RESUME_MAX_BYTES,
    });
    if (!error) return delivered();
    if (error.code === 1 && `${stdout}${stderr}`.includes(UNTRUSTED_WORKSPACE_MARKER))
      return failure('failed-permanent', 'untrusted_workspace');
    return failure('failed-transient', error.killed ? 'timed_out' : 'spawn_failed');
  }

  return { listSessions, resume };
}
