// team-velocity.mjs — whole-team sprint velocity, rebuilt on demand into
// team-velocity.html (CLI `team-velocity`). Same Jira Cloud auth as jira.mjs
// (JIRA_BASE_URL + JIRA_EMAIL + JIRA_TOKEN) and the same story-points field,
// so anyone the token can browse issues for shows up — no per-user tokens.
//
// Fetching is capped like my-tickets (TEAM_VELOCITY_MAX_ISSUES per query), so
// very old history is a floor, not a total. Everything below the fetch is
// pure and DOM-free so node --test can reach it (see
// test/team-velocity.test.mjs). The per-board chart is a stacked column by
// status, local to this report (the Home tab keeps its own velocity chart).
import fs from 'node:fs';
import { jiraConfig, authorization, storyPointsOf } from './jira.mjs';
import { captureConfiguration } from './settings.mjs';
import { esc } from '../ui/dom.js';

export const TEAM_VELOCITY_MAX_ISSUES = 5000;
export const DEFAULT_KEEP_SPRINTS = 8;

// Board name is the sprint-name prefix ("Nexus Sprint 17" -> "Nexus"), so one
// Jira board's sprints stay together without a board-id lookup.
export function boardOf(sprintName) {
  const board = String(sprintName || '')
    .replace(/\s+Sprint\s+\d+\s*$/i, '')
    .trim();
  return board || 'Other';
}

async function searchJql(cfg, jql, max) {
  const fields = ['status', 'assignee', 'updated', cfg.sprintField, cfg.pointsField]
    .filter(Boolean)
    .join(',');
  const issues = [];
  let nextPageToken = null;
  for (;;) {
    const url = new URL(`${cfg.baseUrl}/rest/api/3/search/jql`);
    url.searchParams.set('jql', jql);
    url.searchParams.set('fields', fields);
    url.searchParams.set('maxResults', '100');
    if (nextPageToken) url.searchParams.set('nextPageToken', nextPageToken);
    const res = await fetch(url, {
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        Authorization: authorization(cfg.email, cfg.token),
      },
    });
    if (!res.ok) throw new Error(`jira search failed: ${res.status}`);
    const data = await res.json();
    issues.push(...(data.issues || []));
    if (issues.length >= max || data.isLast || !data.nextPageToken) break;
    nextPageToken = data.nextPageToken;
  }
  return issues.slice(0, max);
}

// Every issue (any status) in closed and open sprints.
export async function fetchTeamIssues({ max = TEAM_VELOCITY_MAX_ISSUES, snapshot } = {}) {
  const cfg = jiraConfig(snapshot);
  if (!cfg) {
    throw new Error('no JIRA_BASE_URL, JIRA_EMAIL, or JIRA_TOKEN in environment — will not prompt');
  }
  const [openIssues, closedIssues] = await Promise.all([
    searchJql(cfg, 'sprint in openSprints() ORDER BY updated DESC', max),
    searchJql(cfg, 'sprint in closedSprints() ORDER BY updated DESC', max),
  ]);
  return [...closedIssues, ...openIssues];
}

// Jira status category -> chart band. Anything that is neither Done nor In
// Progress (To Do, or no category) counts as not started.
function statusBandOf(issue) {
  const category = issue?.fields?.status?.statusCategory?.name;
  if (category === 'Done') return 'done';
  if (category === 'In Progress') return 'inProgress';
  return 'notStarted';
}

// Board -> sprintKey -> { sprint, points, count, unestimated, byUser, byStatus }. A
// carried ticket counts toward every listed sprint, matching
// sprintProgressFor's scoping rule in ui/home-data.js.
export function buildTeamBoards(issues, { snapshot } = {}) {
  const { sprintField, pointsField } = captureConfiguration(snapshot).jira;
  const boards = new Map();
  for (const issue of issues || []) {
    const fields = issue?.fields || {};
    const raw = fields[sprintField];
    const sprints = (Array.isArray(raw) ? raw : []).filter((s) => s && s.name);
    const pts = storyPointsOf(fields[pointsField]);
    const who = fields.assignee?.displayName || '(unassigned)';
    const band = statusBandOf(issue);
    for (const sp of sprints) {
      if (sp.state !== 'closed' && sp.state !== 'active') continue;
      const board = boardOf(sp.name);
      if (!boards.has(board)) boards.set(board, new Map());
      const bySprint = boards.get(board);
      const key = String(sp.id ?? sp.name);
      if (!bySprint.has(key)) {
        bySprint.set(key, {
          sprint: {
            id: sp.id ?? null,
            name: sp.name,
            state: sp.state,
            endDate: sp.endDate || null,
          },
          points: 0,
          count: 0,
          unestimated: 0,
          byUser: new Map(),
          byStatus: { done: 0, inProgress: 0, notStarted: 0 },
        });
      }
      const entry = bySprint.get(key);
      entry.points += pts || 0;
      entry.count += 1;
      if (pts === null) entry.unestimated += 1;
      entry.byStatus[band] += pts || 0;
      if (!entry.byUser.has(who)) entry.byUser.set(who, { points: 0, count: 0 });
      const cell = entry.byUser.get(who);
      cell.points += pts || 0;
      cell.count += 1;
    }
  }
  return boards;
}

// Chronological series for one board, keeping the most recent `keep`.
export function boardSeries(bySprint, keep = DEFAULT_KEEP_SPRINTS) {
  const endsAt = (entry) => {
    const t = Date.parse(entry.sprint.endDate);
    return Number.isFinite(t) ? t : 0;
  };
  return [...(bySprint || new Map()).values()]
    .sort(
      (a, b) => endsAt(a) - endsAt(b) || String(a.sprint.name).localeCompare(String(b.sprint.name)),
    )
    .slice(-keep);
}

function shortSprint(name) {
  const m = String(name).match(/(Sprint\s+\d+)\s*$/i);
  return m ? m[1] : name;
}

// Stack order, bottom to top: finished work at the base, not-started on top.
const STATUS_BANDS = [
  { key: 'done', label: 'Completed', color: '#41d07c' },
  { key: 'inProgress', label: 'In progress', color: '#4aa6ff' },
  { key: 'notStarted', label: 'Not started', color: '#7d8794' },
];

function fmtPoints(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// Stacked column per sprint: completed (green), in progress (blue) and not
// started (grey) points, in the same order in every column.
export function stackedStatusChartHtml(series) {
  const entries = series || [];
  if (!entries.length) return '<p class="tv-empty">No sprint data yet</p>';
  const max = Math.max(0, ...entries.map((e) => e.points));
  const unestimated = entries.reduce((sum, e) => sum + e.unestimated, 0);
  const sumOf = (key) => entries.reduce((sum, e) => sum + e.byStatus[key], 0);
  const legend = STATUS_BANDS.map(
    (b) =>
      `<span class="tv-legend-item"><span class="tv-swatch" style="background:${b.color}"></span>${b.label} <span class="tv-n">${esc(fmtPoints(sumOf(b.key)))}</span></span>`,
  ).join('');
  const columns = entries
    .map((e) => {
      const height = max > 0 ? (e.points / max) * 100 : 0;
      const parts = STATUS_BANDS.filter((b) => e.byStatus[b.key] > 0);
      const hint = `${e.sprint.name}: ${fmtPoints(e.points)} points — ${STATUS_BANDS.map((b) => `${b.label.toLowerCase()} ${fmtPoints(e.byStatus[b.key])}`).join(', ')}`;
      const segments = parts
        .map(
          (b) =>
            `<span class="tv-seg" style="flex:${e.byStatus[b.key]} 1 0;background:${b.color}" title="${b.label}: ${esc(fmtPoints(e.byStatus[b.key]))}"></span>`,
        )
        .join('');
      return (
        `<div class="velocity-column" role="listitem" aria-label="${esc(hint)}">` +
        `<span class="velocity-value">${esc(fmtPoints(e.points))}</span>` +
        `<div class="velocity-track"><div class="tv-stack" style="height:${height.toFixed(2).replace(/\.00$/, '')}%" title="${esc(hint)}">${segments}</div></div>` +
        `<span class="velocity-label" title="${esc(e.sprint.name)}">${esc(shortSprint(e.sprint.name))}</span>` +
        '</div>'
      );
    })
    .join('');
  const total = entries.reduce((sum, e) => sum + e.points, 0);
  const note = unestimated ? `<span class="velocity-note">${unestimated} unestimated</span>` : '';
  return (
    '<div class="velocity-chart">' +
    `<div class="tv-legend">${legend}</div>` +
    `<div class="velocity-bars" role="list" aria-label="Story points by sprint and status">${columns}</div>` +
    `<div class="velocity-summary"><span>${esc(fmtPoints(total))} pts total</span>${note}</div>` +
    '</div>'
  );
}

// boards: Map of board -> sprint Map, as built by buildTeamBoards.
//
// The report is a single portable file: Tailwind via CDN for the page shell,
// and a self-contained <style> block (dashboard tokens + the chart rules) for
// the stacked chart. No relative links — the file can be passed around
// and opened anywhere with internet access.
export function renderTeamVelocityHtml(
  boards,
  { keep = DEFAULT_KEEP_SPRINTS, date = new Date().toISOString().slice(0, 10) } = {},
) {
  let sections = '';
  for (const [board, bySprint] of [...(boards || new Map()).entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const series = boardSeries(bySprint, keep);
    if (!series.length) continue;
    const users = [...new Set(series.flatMap((e) => [...e.byUser.keys()]))].sort((a, b) => {
      const total = (u) => series.reduce((s, e) => s + (e.byUser.get(u)?.points || 0), 0);
      return total(b) - total(a);
    });
    const head =
      '<tr><th scope="col">Who</th>' +
      series
        .map(
          (e) =>
            `<th scope="col">${esc(shortSprint(e.sprint.name))}<br><span class="tv-state">${esc(e.sprint.state)}</span></th>`,
        )
        .join('') +
      '</tr>';
    const rows = users
      .map((u) => {
        const cells = series
          .map((e) => {
            const c = e.byUser.get(u);
            return `<td>${c ? `${c.points}<span class="tv-n"> (${c.count})</span>` : '—'}</td>`;
          })
          .join('');
        return `<tr><th scope="row">${esc(u)}</th>${cells}</tr>`;
      })
      .join('');
    sections += `<section class="mb-8">\n<h2 class="text-[13px] font-semibold mb-3">${esc(board)}</h2>\n${stackedStatusChartHtml(series)}\n<div class="tv-table-wrap"><table class="tv-table">${head}${rows}</table></div>\n</section>`;
  }
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Team velocity</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  :root {
    --bg: #0f1419; --panel: #161b22; --panel2: #1c232d; --border: #2a323d;
    --text: #d7dde4; --muted: #7d8794; --accent: #4aa6ff; --green: #41d07c;
    --red: #ff5c6a; --amber: #ffb454;
    --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 24px; --s6: 32px;
    --radius: 10px; --radius-sm: 6px;
    --fs-xs: 10px; --fs-sm: 11px; --fs-md: 12px; --fs-lg: 13px;
  }
  body { background: var(--bg); color: var(--text); font-family: ui-sans-serif, system-ui, sans-serif; }
  .velocity-chart { padding: var(--s4); border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); overflow: hidden; margin-bottom: var(--s3); }
  .velocity-bars { display: flex; align-items: stretch; gap: var(--s3); min-height: 180px; overflow-x: auto; padding-top: var(--s2); }
  .velocity-column { display: grid; grid-template-rows: auto 1fr auto; gap: var(--s1); flex: 1 0 52px; min-width: 0; max-width: 140px; text-align: center; }
  @media (min-width: 1200px) {
    .velocity-column { flex: 1 1 0; min-width: calc((100% - 29 * var(--s3)) / 30); }
  }
  .velocity-value { color: var(--text); font-size: var(--fs-sm); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .velocity-track { display: flex; align-items: flex-end; min-height: 120px; border-bottom: 1px solid var(--border); background: linear-gradient(to top, var(--panel2), transparent 65%); border-radius: var(--radius-sm) var(--radius-sm) 0 0; }
  .tv-stack { display: flex; flex-direction: column-reverse; width: 100%; min-height: 2px; border-radius: var(--radius-sm) var(--radius-sm) 0 0; overflow: hidden; }
  .tv-seg { display: block; min-height: 1px; }
  .tv-legend { display: flex; flex-wrap: wrap; gap: var(--s4); margin-bottom: var(--s3); font-size: var(--fs-sm); }
  .tv-legend-item { display: inline-flex; align-items: center; gap: var(--s2); }
  .tv-swatch { width: 10px; height: 10px; border-radius: 2px; }
  .velocity-label { overflow: hidden; color: var(--muted); font-size: var(--fs-xs); line-height: 1.25; text-overflow: ellipsis; white-space: nowrap; }
  .velocity-summary { display: flex; justify-content: space-between; gap: var(--s3); margin-top: var(--s3); color: var(--muted); font-size: var(--fs-sm); font-variant-numeric: tabular-nums; }
  .velocity-note { color: var(--amber); }
  .tv-table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); }
  .tv-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
  .tv-table th, .tv-table td { padding: var(--s2) var(--s3); text-align: right; border-top: 1px solid var(--border); font-variant-numeric: tabular-nums; }
  .tv-table tr:first-child th { border-top: 0; }
  .tv-table th[scope="row"] { text-align: left; color: var(--text); font-weight: 600; }
  .tv-table th[scope="col"] { color: var(--muted); font-weight: 400; }
  .tv-state { font-size: var(--fs-xs); }
  .tv-n { color: var(--muted); }
</style>
</head>
<body class="max-w-[1400px] mx-auto p-6">
  <h1 class="text-lg font-semibold">Team velocity</h1>
  <p class="text-[12px] mb-6" style="color: var(--muted)">Story points of all tickets (any status) by sprint, per person. Last ${keep} sprints per board · snapshot ${esc(date)}.</p>
  ${sections}
</body>
</html>
`;
}

// Fetch, build, render and write the report. Returns the written path.
export async function rebuildTeamVelocity({ keep = DEFAULT_KEEP_SPRINTS, outPath, snapshot } = {}) {
  if (!outPath) throw new Error('rebuildTeamVelocity requires outPath');
  const captured = captureConfiguration(snapshot);
  const issues = await fetchTeamIssues({ snapshot: captured });
  const html = renderTeamVelocityHtml(buildTeamBoards(issues, { snapshot: captured }), { keep });
  fs.writeFileSync(outPath, html);
  return outPath;
}
