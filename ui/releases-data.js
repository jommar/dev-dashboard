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

const GROUP_TITLES = {
  open: 'Open',
  partial: 'Partly merged',
  'no-pr': 'No PRs',
  unavailable: 'PRs unavailable',
  merged: 'Merged',
};

const STATE_SHORT = {
  merged: 'merged',
  partial: 'partly merged',
  open: 'open',
  'no-pr': 'no PRs',
  unavailable: 'PRs unavailable',
};

const EARLY_STATUS = /^(to do|open|in progress|blocked|impediment)$/i;
const DONE_OR_QA_STATUS = /qa|ready for release|deployed|complete|done/i;
const BUG_TYPE = /^(defect|bug)$/i;
const SAFE_BASE = /^https?:\/\//i;

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

function unpackScripts(scripts) {
  if (!scripts) return { byTicket: {}, state: 'ready', truncated: false };
  if ('byTicket' in scripts) {
    return {
      byTicket: scripts.byTicket ?? {},
      state: scripts.state ?? 'ready',
      truncated: Boolean(scripts.truncated),
    };
  }
  return { byTicket: scripts, state: 'ready', truncated: false };
}

function collectScriptRows(tickets, byTicket) {
  const rows = [];
  for (const ticket of tickets) {
    for (const item of byTicket[ticket.key] ?? []) rows.push({ ticket, item });
  }
  return rows;
}

function repoSummaryLines(tickets) {
  const repos = new Map();
  for (const ticket of tickets) {
    for (const pr of ticket.prs ?? []) {
      if (pr.state === 'declined') continue;
      const name = shortRepoName(pr.repo) || pr.repo || 'unknown';
      const entry = repos.get(name) ?? { name, merged: 0, open: [], app: false };
      if (pr.base === 'ops/development') entry.app = true;
      if (pr.countsAsMerged) entry.merged += 1;
      else entry.open.push(`#${pr.number}`);
      repos.set(name, entry);
    }
  }
  const ordered = [...repos.values()].sort(
    (a, b) => Number(b.app) - Number(a.app) || a.name.localeCompare(b.name),
  );
  return ordered.map(({ name, merged, open }) =>
    open.length
      ? `  ${name}  ${merged} merged, ${open.length} open (${open.join(', ')})`
      : `  ${name}  ${merged} merged [clear]`,
  );
}

function mismatchLines(tickets) {
  const lines = [];
  for (const ticket of tickets) {
    const status = ticket.status || '';
    const who = assigneeLabel(ticket);
    if (
      ticket.mergeState === 'merged' &&
      (ticket.statusCategory === 'To Do' || EARLY_STATUS.test(status))
    ) {
      lines.push(`  ${ticket.key}  All PRs merged, but Jira is "${status}" (${who})`);
    } else if (
      (ticket.mergeState === 'open' || ticket.mergeState === 'partial') &&
      (ticket.statusCategory === 'Done' || DONE_OR_QA_STATUS.test(status))
    ) {
      lines.push(`  ${ticket.key}  Has open PRs, but Jira is "${status}" (${who})`);
    }
  }
  return lines;
}

export function formatReleaseText(data, scripts = null) {
  if (!data?.version) return 'No release versions found.';
  const { version, tickets } = data;
  const rollup = summarizeRelease(tickets);
  const breakdown = ['merged', 'partial', 'open', 'no-pr', 'unavailable']
    .filter((state) => rollup.tickets[state] > 0)
    .map((state) => `${rollup.tickets[state]} ${STATE_SHORT[state]}`)
    .join(', ');
  const lines = [
    `${version.name}${version.releaseDate ? ` (${version.releaseDate})` : ''} — ${version.released ? 'Released' : 'Unreleased'} · ${data.scope === 'all' ? 'all' : 'your'} tickets`,
    `${plural(data.total, 'ticket')}${breakdown ? ` (${breakdown})` : ''}${rollup.prs.total ? ` · ${prMergedText(rollup.prs)}` : ''}${data.truncated ? ' (truncated: the release has more)' : ''}`,
  ];

  const repoLines = repoSummaryLines(tickets);
  if (repoLines.length) lines.push('', '== Repos touched', ...repoLines);

  const scriptInfo = unpackScripts(scripts);
  const scriptRows = collectScriptRows(tickets, scriptInfo.byTicket);
  if (scriptRows.length || scriptInfo.truncated || scriptInfo.state === 'unavailable') {
    lines.push('', `== Scripts & Migrations (${scriptRows.length})`);
    if (scriptInfo.state === 'unavailable')
      lines.push('  Warning: script/migration scan unavailable.');
    if (scriptInfo.truncated)
      lines.push(
        '  Warning: script/migration scan incomplete (truncated); verify large PRs manually.',
      );
    for (const { ticket, item } of scriptRows) {
      const tag = SCRIPT_KIND_LABELS[item.kind] ?? item.kind;
      const where =
        item.repo && item.prNumber ? ` ${shortRepoName(item.repo)}#${item.prNumber}` : '';
      lines.push(`  [${tag}]${where} (${ticket.key})  ${formatScriptTarget(item)}`);
    }
  }

  const mismatches = mismatchLines(tickets);
  if (mismatches.length)
    lines.push('', `== Jira / GitHub Mismatches (${mismatches.length})`, ...mismatches);

  for (const state of MERGE_STATE_ORDER) {
    const group = tickets.filter((ticket) => ticket.mergeState === state).sort(byKeyNumber);
    if (!group.length) continue;
    lines.push('', `== ${GROUP_TITLES[state]} (${group.length})`);
    for (const ticket of group) {
      const details = [ticket.status, ticket.issueType, ticket.priority, ticket.assignee]
        .filter(Boolean)
        .join(' · ');
      lines.push(`  ${ticket.key}  ${ticket.summary || ''}${details ? ` [${details}]` : ''}`);
      if (ticket.prsStatus === 'unavailable')
        lines.push(`    PRs unavailable (${ticket.prsError})`);
      const livePrs = (ticket.prs ?? []).filter((pr) => pr.state !== 'declined');
      const unmerged = livePrs.filter((pr) => !pr.countsAsMerged);
      const merged = livePrs.filter((pr) => pr.countsAsMerged);
      for (const pr of unmerged) {
        const owner = pr.owner ? ` (@${pr.owner})` : '';
        lines.push(
          `    ${(pr.state || 'open').toUpperCase()}  ${shortRepoName(pr.repo)}#${pr.number} -> ${pr.base}${owner}`,
        );
      }
      if (merged.length) {
        lines.push(
          `    merged: ${merged.map((pr) => `${shortRepoName(pr.repo)}#${pr.number}`).join(', ')}`,
        );
      }
    }
  }
  return lines.join('\n');
}

const priorityRank = (priority) => {
  const match = String(priority || '').match(/^P(\d)\b/i);
  return match ? Number(match[1]) : 9;
};

const shortPriority = (priority) => {
  const text = String(priority || '').trim();
  const match = text.match(/^(P\d)\b/i);
  return match ? match[1].toUpperCase() : text;
};

const formatKeyLink = (key, jiraBase) => {
  if (!jiraBase || !SAFE_BASE.test(jiraBase)) return key;
  const href = /\/browse\/?$/i.test(jiraBase)
    ? `${jiraBase.replace(/\/?$/, '/')}${encodeURIComponent(key)}`
    : `${jiraBase.replace(/\/+$/, '')}/browse/${encodeURIComponent(key)}`;
  return `[${key}](${href})`;
};

export function formatReleaseSummary(data, { scripts = null, jiraBase = '' } = {}) {
  if (!data?.version) return 'No release versions found.';
  const { version, tickets } = data;
  const byPriority = (a, b) =>
    priorityRank(a.priority) - priorityRank(b.priority) || byKeyNumber(a, b);
  const bugs = tickets.filter((ticket) => BUG_TYPE.test(ticket.issueType || '')).sort(byPriority);
  const features = tickets
    .filter((ticket) => !BUG_TYPE.test(ticket.issueType || ''))
    .sort(byPriority);

  const counts = [
    features.length && plural(features.length, 'Feature'),
    bugs.length && plural(bugs.length, 'Bug fix'),
  ]
    .filter(Boolean)
    .join(', ');
  const meta = [
    version.releaseDate,
    version.released ? 'Released' : 'Unreleased',
    `${plural(data.total, 'ticket')}${counts ? ` (${counts})` : ''}`,
    data.truncated ? 'Truncated' : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const lines = [`## ${version.name}`, meta];
  const addGroup = (heading, items) => {
    if (!items.length) return;
    lines.push('', `### ${heading} (${items.length})`);
    for (const ticket of items) {
      const prio = shortPriority(ticket.priority);
      const tail = [ticket.status, ticket.assignee].filter(Boolean).join(' · ');
      lines.push(
        `- **${formatKeyLink(ticket.key, jiraBase)}**${prio ? ` (${prio})` : ''} — ${ticket.summary || ''}${tail ? ` — *${tail}*` : ''}`,
      );
    }
  };
  addGroup('Features & Improvements', features);
  addGroup('Bug Fixes', bugs);

  const scriptInfo = unpackScripts(scripts);
  const scriptRows = collectScriptRows(tickets, scriptInfo.byTicket);
  if (scriptRows.length || scriptInfo.truncated) {
    lines.push('', '### Deploy Notes (Scripts & Migrations)');
    if (scriptInfo.truncated)
      lines.push('- *Note: script/migration scan was truncated; verify large PRs manually.*');
    for (const { ticket, item } of scriptRows) {
      const tag = SCRIPT_KIND_LABELS[item.kind] ?? item.kind;
      lines.push(
        `- **${formatKeyLink(ticket.key, jiraBase)}** — \`${tag}\` \`${formatScriptTarget(item)}\``,
      );
    }
  }
  return lines.join('\n');
}

export const assigneeLabel = (ticket) => String(ticket?.assignee || '').trim() || 'Unassigned';

export function sortByAssignee(tickets) {
  return [...tickets].sort((a, b) => {
    const an = String(a.assignee || '').trim();
    const bn = String(b.assignee || '').trim();
    if (!an !== !bn) return an ? -1 : 1;
    return an.localeCompare(bn, undefined, { sensitivity: 'base' }) || byKeyNumber(a, b);
  });
}

// Moves non-done finished columns (Rejected, Duplicate) to the end, after done columns.
export function finishedColumnsLast(columns) {
  const moved = (c) =>
    c.kind !== 'done' &&
    c.tickets.length > 0 &&
    c.tickets.every((t) => t.statusCategory === 'Done');
  return [...columns].sort((a, b) => moved(a) - moved(b));
}
