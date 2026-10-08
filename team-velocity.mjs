// team-velocity.mjs — whole-team sprint velocity, rebuilt on demand into
// team-velocity.html (CLI `team-velocity`). Same Jira Cloud auth as jira.mjs
// (JIRA_BASE_URL + JIRA_EMAIL + JIRA_TOKEN) and the same story-points field,
// so anyone the token can browse issues for shows up — no per-user tokens.
//
// Fetching is capped like my-tickets (TEAM_VELOCITY_MAX_ISSUES per query), so
// very old history is a floor, not a total. Everything below the fetch is
// pure and DOM-free so node --test can reach it (see
// test/team-velocity.test.mjs); charts render through the dashboard's own
// velocityChartHtml so the report can never drift from the Home tab.
import fs from 'node:fs';
import { jiraConfig } from './jira.mjs';
import { captureConfiguration } from './settings.mjs';
import { velocityChartHtml } from './ui/components/home-cards.js';

export const TEAM_VELOCITY_MAX_ISSUES = 200;
export const DEFAULT_KEEP_SPRINTS = 8;

function authorization(email, token) {
  const b64 = Buffer.from(`${email}:${token}`, 'utf8').toString('base64');
  return `Basic ${b64}`;
}

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

// Raw Done issues across closed sprints plus everything in open sprints (the
// caller filters to Done — open sprints still hold in-progress work).
export async function fetchTeamIssues({ max = TEAM_VELOCITY_MAX_ISSUES, snapshot } = {}) {
  const cfg = jiraConfig(snapshot);
  if (!cfg) {
    throw new Error('no JIRA_BASE_URL, JIRA_EMAIL, or JIRA_TOKEN in environment — will not prompt');
  }
  const [openIssues, doneClosed] = await Promise.all([
    searchJql(cfg, 'sprint in openSprints() ORDER BY updated DESC', max),
    searchJql(
      cfg,
      'statusCategory = Done AND sprint in closedSprints() ORDER BY updated DESC',
      max,
    ),
  ]);
  return [
    ...doneClosed,
    ...openIssues.filter((i) => i?.fields?.status?.statusCategory?.name === 'Done'),
  ];
}

function storyPointsOf(raw) {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null;
}

// Board -> sprintKey -> { sprint, points, count, unestimated, byUser }. A
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
        });
      }
      const entry = bySprint.get(key);
      entry.points += pts || 0;
      entry.count += 1;
      if (pts === null) entry.unestimated += 1;
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

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shortSprint(name) {
  const m = String(name).match(/(Sprint\s+\d+)\s*$/i);
  return m ? m[1] : name;
}

// boards: Map of board -> sprint Map, as built by buildTeamBoards.
//
// The report is a single portable file: Tailwind via CDN for the page shell,
// and a self-contained <style> block (dashboard tokens + the velocity-chart
// rules, same values as ui/styles) for the chart, whose markup still comes
// from velocityChartHtml. No relative links — the file can be passed around
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
    sections += `<section class="mb-8">\n<h2 class="text-[13px] font-semibold mb-3">${esc(board)}</h2>\n${velocityChartHtml(series)}\n<div class="tv-table-wrap"><table class="tv-table">${head}${rows}</table></div>\n</section>`;
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
  .velocity-bar { display: block; width: 100%; min-height: 2px; border-radius: var(--radius-sm) var(--radius-sm) 0 0; background: var(--green); }
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
  <p class="text-[12px] mb-6" style="color: var(--muted)">Done story points by sprint, per person. Last ${keep} sprints per board · snapshot ${esc(date)}.</p>
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
