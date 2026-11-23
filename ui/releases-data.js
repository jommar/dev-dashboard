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

const safely = (fn, fallback) => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

export const parseStoredSelection = (raw) =>
  safely(() => {
    const { version, versionId } = JSON.parse(raw) ?? {};
    return version === STORED_SELECTION_VERSION &&
      typeof versionId === 'string' &&
      VERSION_ID_RE.test(versionId)
      ? versionId
      : null;
  }, null);

export const serializeSelection = (versionId) =>
  JSON.stringify({ version: STORED_SELECTION_VERSION, versionId });

export const readStoredSelection = (storage) =>
  safely(() => parseStoredSelection(storage.getItem(RELEASES_STORAGE_KEY)), null);
export const storeSelection = (storage, versionId) =>
  safely(() => storage.setItem(RELEASES_STORAGE_KEY, serializeSelection(versionId)));
export const clearStoredSelection = (storage) =>
  safely(() => storage.removeItem(RELEASES_STORAGE_KEY));

// Matches backend/release-model.mjs headings so plain-text export stays identical without scripts.
const GROUP_TITLES = {
  open: 'Open',
  partial: 'Partly merged',
  'no-pr': 'No PRs',
  unavailable: 'PRs unavailable',
  merged: 'Merged',
};

export const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
export const prMergedText = (prs) => `${prs.merged} of ${plural(prs.total, 'PR')} merged`;

export const SCRIPT_KIND_LABELS = {
  migration: 'Migration',
  script: 'Script',
  'prisma-schema': 'Prisma schema',
};

export const shortRepoName = (repo) => String(repo || '').replace(/^[^/]+\//, '');

export function prRollupLabel(prs) {
  const total = prs?.length ?? 0;
  if (!total) return 'No PRs';
  const merged = prs.filter((pr) => pr.countsAsMerged).length;
  return merged === total && total > 1
    ? `All ${total} PRs merged`
    : `${merged}/${plural(total, 'PR')} merged`;
}

export const formatScriptTarget = (item) =>
  item.path && item.label && !item.path.endsWith(item.label)
    ? `${item.path} (${item.label})`
    : item.path || item.label;

export function formatReleaseText(data, scriptsByTicket = null) {
  if (!data?.version) return 'No release versions found.';
  const { version, tickets } = data;
  const lines = [
    `${version.released ? 'Released' : 'Unreleased'} version ${version.name}${version.releaseDate ? ` (${version.releaseDate})` : ''} - ${data.scope === 'all' ? 'all' : 'your'} tickets`,
    `${plural(data.total, 'ticket')}${data.truncated ? ' (truncated: the release has more)' : ''}`,
  ];
  for (const state of MERGE_STATE_ORDER) {
    const group = tickets.filter((ticket) => ticket.mergeState === state);
    if (!group.length) continue;
    lines.push('', `== ${GROUP_TITLES[state]} (${group.length})`);
    for (const ticket of group) {
      const details = [ticket.issueType, ticket.priority, ticket.assignee]
        .filter(Boolean)
        .join(', ');
      lines.push(
        `  ${ticket.key}  ${(ticket.summary || '').slice(0, 100)}${details ? ` (${details})` : ''}`,
      );
      if (ticket.prsStatus === 'unavailable')
        lines.push(`    PRs unavailable (${ticket.prsError})`);
      for (const pr of ticket.prs)
        lines.push(`    #${pr.number} ${pr.repo} ${pr.state} -> ${pr.base}`);
      for (const item of scriptsByTicket?.[ticket.key] ?? []) {
        const tag = SCRIPT_KIND_LABELS[item.kind] ?? item.kind;
        lines.push(`    [${tag}] ${formatScriptTarget(item)}`);
      }
    }
  }
  return lines.join('\n');
}

// Moves non-done finished columns (Rejected, Duplicate) to the end, after done columns.
export function finishedColumnsLast(columns) {
  const moved = (c) =>
    c.kind !== 'done' &&
    c.tickets.length > 0 &&
    c.tickets.every((t) => t.statusCategory === 'Done');
  return [...columns].sort((a, b) => moved(a) - moved(b));
}
