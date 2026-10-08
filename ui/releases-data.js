// releases-data.js — DOM-free helpers for the Releases tab: grouping, totals and
// the remembered version choice. Storage is handed in, so this imports under
// plain Node.

export const MERGE_STATE_ORDER = ['open', 'partial', 'no-pr', 'unavailable', 'merged'];

export const RELEASES_STORAGE_KEY = 'dev-dashboard.releases';

const STORED_SELECTION_VERSION = 1;
const VERSION_ID_RE = /^\d{1,12}$/;

const keyNumber = (key) => Number(String(key).match(/-(\d+)$/)?.[1] ?? 0);
const byKeyNumber = (a, b) =>
  keyNumber(a.key) - keyNumber(b.key) || String(a.key).localeCompare(String(b.key));

export function groupByMergeState(tickets) {
  return MERGE_STATE_ORDER.map((state) => ({
    state,
    tickets: tickets.filter((ticket) => ticket.mergeState === state).sort(byKeyNumber),
  })).filter((group) => group.tickets.length);
}

export function summarizeRelease(tickets) {
  const perState = Object.fromEntries(MERGE_STATE_ORDER.map((state) => [state, 0]));
  const prs = { total: 0, merged: 0 };
  for (const ticket of tickets) {
    if (ticket.mergeState in perState) perState[ticket.mergeState] += 1;
    for (const pr of ticket.prs ?? []) {
      prs.total += 1;
      if (pr.countsAsMerged) prs.merged += 1;
    }
  }
  return { tickets: { total: tickets.length, ...perState }, prs };
}

// Only a digit-only id from the current record shape is trusted; anything else
// reads as "nothing remembered".
export function parseStoredSelection(raw) {
  try {
    const stored = JSON.parse(raw);
    const { version, versionId } = stored ?? {};
    if (
      version === STORED_SELECTION_VERSION &&
      typeof versionId === 'string' &&
      VERSION_ID_RE.test(versionId)
    )
      return versionId;
  } catch {
    /* A corrupt record is treated as absent. */
  }
  return null;
}

export function serializeSelection(versionId) {
  return JSON.stringify({ version: STORED_SELECTION_VERSION, versionId });
}

export function readStoredSelection(storage) {
  try {
    return parseStoredSelection(storage.getItem(RELEASES_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function storeSelection(storage, versionId) {
  try {
    storage.setItem(RELEASES_STORAGE_KEY, serializeSelection(versionId));
  } catch {
    /* Storage can be blocked; the choice then lasts for this page only. */
  }
}

export function clearStoredSelection(storage) {
  try {
    storage.removeItem(RELEASES_STORAGE_KEY);
  } catch {
    /* Nothing to clear when storage is blocked. */
  }
}
