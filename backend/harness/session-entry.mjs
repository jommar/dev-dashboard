// session-entry.mjs — the generic algorithms over the session-entry contract (see README "Harness
// adapter contract"): how a listed entry reads as live or finished, and how a live session is brought
// to a stop so a resume continues it instead of starting a copy. Neither knows a CLI: the launcher and
// the chat import them for whichever harness is active.

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
