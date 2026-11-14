// session-lock.mjs — the one-writer mark every sessions service builds on: the sessions a chat turn
// or a resume is writing to right now, in this process. A held session reads `working`, so the
// launcher's guards, the ticket card and the bot bar all see it as work in progress.

export function createSessionLock() {
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

  // Whether a chat turn or a resume in this process is writing to the session now. `overlay` shows
  // that on a listed session; this is for one the listing no longer shows.
  const isHeld = (sessionId) => held.has(sessionId);

  // Copies of `entries` with every held session read as working.
  const overlay = (entries) =>
    entries.map((entry) => (held.has(entry.sessionId) ? { ...entry, state: 'working' } : entry));

  return { beginTurn, isHeld, overlay };
}
