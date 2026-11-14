// board-refresh.js — which board screens can be refreshed from outside their toolbar. A board's
// RefreshControl registers its guarded `load` under the screen's tab id while it is mounted; the command
// palette asks here for the active screen, so Refresh never needs a context, a prop or a second load
// path. A screen with no RefreshControl (Home, Services, Releases, Chat, Mascots) registers nothing and
// so has no Refresh entry.
const refreshers = new Map();

// Registers `load` for the screen `name`; the returned function removes it (only if still its own).
export function registerBoardRefresh(name, load) {
  refreshers.set(name, load);
  return () => {
    if (refreshers.get(name) === load) refreshers.delete(name);
  };
}

export const hasBoardRefresh = (name) => refreshers.has(name);

// Runs the screen's own refresh; false when it registered none.
export function refreshBoard(name) {
  const load = refreshers.get(name);
  if (!load) return false;
  load();
  return true;
}
