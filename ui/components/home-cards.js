// home-cards.js — pure markup helpers for the Home overview. No fetching and
// no state: every function takes already-shaped data and returns an HTML
// string, so home-panel.js can diff whole regions against their last render.
import { esc, slug, timeAgo } from '../dom.js';
import { jiraStatusKind } from './pr-card.js';
import { ticketRowHtml } from './my-tickets-card.js';
import { listboxHtml } from './listbox.js';
import { filterTickets } from '../work-filters.js';
import { sprintKeyOf } from '../home-data.js';

// ── KPI tiles ───────────────────────────────────────────────────────────────

// A tile whose value is unknown renders an em dash plus the reason, rather
// than a zero — "no review data" and "nothing to review" are not the same.
export function kpiTileHtml({ id, label, value, unknown, hint, target }) {
  const shown = unknown ? '—' : String(value);
  const tip = hint ? ` data-tooltip="${esc(hint)}"` : '';
  const inner =
    `<span class="kpi-value" data-testid="kpi-value-${esc(id)}">${esc(shown)}</span>` +
    `<span class="kpi-label">${esc(label)}</span>`;
  const attrs =
    `class="kpi-tile"${tip} data-testid="kpi-${esc(id)}"` + (unknown ? ' data-unknown="true"' : '');
  return target
    ? `<a href="#/${esc(target)}" ${attrs}>${inner}</a>`
    : `<div ${attrs}>${inner}</div>`;
}

export function kpiRowHtml(tiles) {
  return (
    '<div class="kpi-row" data-testid="home-kpis">' + tiles.map(kpiTileHtml).join('') + '</div>'
  );
}

// ── Sprint progress ─────────────────────────────────────────────────────────

// Stacked bar of one sprint's tickets by statusCategory. Widths are
// percentages of the total so the bar always fills; a zero-count band is
// dropped entirely rather than rendered at 0% (which browsers still hairline).
// Points are frequently fractional (0.5, 1.5) and float sums drift, so every
// figure is rounded at display time only — never in the summation.
function fmtPoints(n) {
  return String(Math.round(n * 100) / 100);
}

// Stable per-sprint key. Two boards routinely both run a "Sprint 17", so this
// uses the same identity rule as home-data.js rather than the display slug.
export { sprintKeyOf };

// The Sprint-block selector, built on the reusable listbox component. Lists
// every sprint found on the fetched tickets (active + previous); the value is
// the stable sprintKeyOf so same-name sprints on different boards stay
// distinct. Label carries the state so a closed sprint never reads as
// current; the open list colors states apart AND highlights the selected row
// (see ui-react/styles/listbox.css). Button keeps the `home-sprint-select` testid
// the native <select> used, so existing selectors keep working.
export function sprintListboxHtml(sprints, selectedKey, { open = false, activeValue = null } = {}) {
  const options = (sprints || []).map((sp) => ({
    value: sprintKeyOf(sp),
    label: `${sp.name}${sp.state && sp.state !== 'active' ? ` · ${sp.state}` : ''}`,
    state: sp.state || null,
  }));
  return (
    `<div class="sprint-select-row">` +
    listboxHtml({
      id: 'home-sprint-select',
      testId: 'home-sprint-select',
      label: 'Sprint',
      options,
      selectedValue: selectedKey,
      open,
      activeValue,
    }) +
    `</div>`
  );
}

export function sprintBarHtml(entry, testId, { expanded, jiraBase, listFilters } = {}) {
  const { sprint, counts, total, points, pointsTotal, unestimated, byBand } = entry;
  if (!total) {
    return `<p class="home-empty" data-testid="${esc(testId)}-empty">No tickets in this sprint</p>`;
  }
  const open = expanded || new Set();
  const sprintKey = sprintKeyOf(sprint);
  const isOpen = (band) => open.has(`${sprintKey}:${band}`);
  const listId = (band) => `sprint-${slug(sprintKey)}-list-${band}`;

  // Points weight the bar — that is the whole reason this view exists. But a
  // sprint where nothing is estimated would render as three empty bands, which
  // reads as "no work"; fall back to counting tickets and label the fallback.
  const byPoints = pointsTotal > 0;
  const denom = byPoints ? pointsTotal : total;
  const bands = [
    { key: 'todo', label: 'To Do', kind: 'queued' },
    { key: 'active', label: 'In Progress', kind: 'active' },
    { key: 'done', label: 'Done', kind: 'done' },
  ].map((b) => ({
    ...b,
    n: counts[b.key],
    pts: points[b.key],
    w: byPoints ? points[b.key] : counts[b.key],
  }));

  const bar = bands
    .filter((b) => b.w > 0)
    .map(
      (b) =>
        `<span class="sprint-band" data-kind="${b.kind}"` +
        ` style="width:${((b.w / denom) * 100).toFixed(2)}%"` +
        ` data-tooltip="${esc(bandText(b, denom, byPoints))}"` +
        ` data-testid="${esc(testId)}-band-${b.key}"></span>`,
    )
    .join('');

  // The legend keeps every band that has tickets, even one worth zero points.
  // Dropping a zero-width band would remove the only route to those tickets.
  const shown = bands.filter((b) => b.n > 0);
  const legend = shown
    .map((b) => {
      const label = byPoints ? `${fmtPoints(b.pts)} pts · ${b.n} ${b.label}` : `${b.n} ${b.label}`;
      return toggleHtml({
        cls: 'sprint-legend-item',
        kind: b.kind,
        band: b.key,
        sprintKey,
        listId: listId(b.key),
        open: isOpen(b.key),
        label,
        // tooltip.js listens on mouseover only, so the hint would be invisible
        // to a keyboard user; aria-label carries the same sentence, generated
        // from the same call so the two cannot drift.
        hint: bandText(b, denom, byPoints),
        testId: `${testId}-count-${b.key}`,
      });
    })
    .join('');

  const totalText = byPoints
    ? `${fmtPoints(points.done)} of ${fmtPoints(pointsTotal)} pts · ${total} tickets`
    : `${total} tickets`;

  let note = '';
  if (!byPoints) {
    note = `<span class="sprint-legend-note" data-tooltip="No ticket in this sprint has a story-point estimate, so the bar counts tickets instead." data-testid="${esc(testId)}-nopoints">no estimates</span>`;
  } else if (unestimated) {
    const hint = `${unestimated} of your ${total} sprint tickets have no story points, so they add no width to the bar and are not in the pts figures.`;
    note = toggleHtml({
      cls: 'sprint-legend-note',
      band: 'unestimated',
      sprintKey,
      listId: listId('unestimated'),
      open: isOpen('unestimated'),
      label: `${unestimated} unestimated`,
      hint,
      testId: `${testId}-unestimated`,
    });
  }

  const lists = [...shown.map((b) => b.key), 'unestimated']
    .filter((key) => isOpen(key) && (byBand[key] || []).length)
    .map((key) =>
      sprintTicketListHtml(
        listFilters ? filterTickets(byBand[key], listFilters) : byBand[key],
        jiraBase,
        listId(key),
        bandLabel(key),
      ),
    )
    .join('');

  return (
    `<div class="sprint-bar" data-testid="${esc(testId)}-bar">${bar}</div>` +
    `<div class="sprint-legend">${legend}` +
    `<span class="sprint-legend-total" data-testid="${esc(testId)}-total">${esc(totalText)}</span>` +
    `${note}</div>` +
    lists
  );
}

const BAND_LABEL = {
  todo: 'To Do',
  active: 'In Progress',
  done: 'Done',
  unestimated: 'Unestimated',
};
function bandLabel(key) {
  return BAND_LABEL[key] || key;
}

// One disclosure trigger. The legend is the control rather than the 8px bar:
// a band is too small to be a reliable hit target, and a focus ring on one
// would be clipped by the bar's own overflow:hidden.
function toggleHtml({ cls, kind, band, sprintKey, listId, open, label, hint, testId }) {
  return (
    `<button type="button" class="${cls}"${kind ? ` data-kind="${kind}"` : ''}` +
    ` data-band="${esc(band)}" data-sprint="${esc(sprintKey)}"` +
    ` aria-expanded="${open}" aria-controls="${esc(listId)}"` +
    ` aria-label="${esc(`${label}. ${hint}`)}" data-tooltip="${esc(hint)}"` +
    ` data-testid="${esc(testId)}">${esc(label)}` +
    '<span class="sprint-caret" aria-hidden="true">▾</span></button>'
  );
}

function bandText(b, denom, byPoints) {
  const pct = denom ? Math.round((b.w / denom) * 100) : 0;
  const tickets = `${b.n} ${b.n === 1 ? 'ticket' : 'tickets'}`;
  return byPoints
    ? `${b.label}: ${fmtPoints(b.pts)} of ${fmtPoints(denom)} points (${pct}%) across ${tickets}`
    : `${b.label}: ${tickets} of ${denom} (${pct}%)`;
}

// The tickets behind one band. Rows come from my-tickets-card.js so a ticket
// looks the same wherever it appears; only the points pill is added here, and
// the testid prefix is re-namespaced because both panels sit in the DOM at once.
export function sprintTicketListHtml(tickets, jiraBase, listId, label) {
  const list = tickets || [];
  const rows = list
    .map((t) =>
      ticketRowHtml(t, jiraBase, {
        showSprint: false,
        testIdPrefix: `${listId}-item`,
        extraMeta: pointsPillHtml(t, `${listId}-points-${slug(t.key)}`),
      }),
    )
    .join('');
  // A visible heading, not just the aria-label: two bands can be open at once
  // and the lists would otherwise run together with nothing saying which is
  // which.
  return (
    `<div class="sprint-tickets" id="${esc(listId)}" role="region"` +
    ` aria-label="${esc(label)} tickets" data-testid="${esc(listId)}">` +
    `<h5 class="sprint-tickets-head" data-testid="${esc(listId)}-head">${esc(label)}` +
    `<span class="sprint-tickets-count">${list.length}</span></h5>` +
    `<div class="sprint-tickets-rows" data-testid="${esc(listId)}-rows">${rows}</div>` +
    '</div>'
  );
}

function pointsPillHtml(t, testId) {
  const has = Number.isFinite(t.storyPoints);
  return (
    `<span class="pill sprint-points"${has ? '' : ' data-unestimated="true"'}` +
    ` data-tooltip="${has ? 'Story points' : 'No story-point estimate'}"` +
    ` data-testid="${esc(testId)}">${has ? esc(fmtPoints(t.storyPoints) + ' pts') : 'no estimate'}</span>`
  );
}

export function sprintCardHtml(entry, { range, countdown, expanded, jiraBase, listFilters }) {
  const testId = `home-sprint-${slug(entry.sprint.name)}`;
  const when = [range, countdown].filter(Boolean).join(' · ');
  return (
    `<article class="sprint-card" data-testid="${esc(testId)}">` +
    '<header class="sprint-head">' +
    `<h3 class="sprint-name" data-testid="${esc(testId)}-name">${esc(entry.sprint.name)}</h3>` +
    (when
      ? `<span class="sprint-when" data-testid="${esc(testId)}-when">${esc(when)}</span>`
      : '') +
    '</header>' +
    sprintBarHtml(entry, testId, { expanded, jiraBase, listFilters }) +
    '</article>'
  );
}

// ── completed story points by sprint ────────────────────────────────────────

export function velocityChartHtml(series) {
  const entries = series || [];
  if (!entries.length) {
    return '<p class="home-empty" data-testid="home-velocity-empty">No completed sprint data yet</p>';
  }
  const max = Math.max(0, ...entries.map((entry) => entry.points));
  const total = entries.reduce((sum, entry) => sum + entry.points, 0);
  const unestimated = entries.reduce((sum, entry) => sum + entry.unestimated, 0);
  const bars = entries
    .map((entry) => {
      const key = sprintKeyOf(entry.sprint);
      const height = max > 0 ? (entry.points / max) * 100 : 0;
      const tickets = `${entry.count} ${entry.count === 1 ? 'ticket' : 'tickets'}`;
      const missing = entry.unestimated ? `, ${entry.unestimated} unestimated` : '';
      const hint = `${entry.sprint.name}: ${fmtPoints(entry.points)} points across ${tickets}${missing}`;
      return (
        `<div class="velocity-column" role="listitem" aria-label="${esc(hint)}"` +
        ` data-testid="home-velocity-column-${esc(key)}">` +
        `<span class="velocity-value">${esc(fmtPoints(entry.points))}</span>` +
        '<div class="velocity-track">' +
        `<span class="velocity-bar" style="height:${height.toFixed(2).replace(/\.00$/, '')}%"` +
        ` data-tooltip="${esc(hint)}" data-testid="home-velocity-bar-${esc(key)}"></span>` +
        '</div>' +
        `<span class="velocity-label" title="${esc(entry.sprint.name)}">${esc(entry.sprint.name)}</span>` +
        '</div>'
      );
    })
    .join('');
  const note =
    max <= 0
      ? '<span class="velocity-note">no estimates</span>'
      : unestimated
        ? `<span class="velocity-note">${unestimated} unestimated</span>`
        : '';
  return (
    '<div class="velocity-chart" data-testid="home-velocity-chart">' +
    `<div class="velocity-bars" role="list" aria-label="Done story points by sprint">${bars}</div>` +
    '<div class="velocity-summary">' +
    `<span>${esc(fmtPoints(total))} pts total</span>${note}` +
    '</div>' +
    '</div>'
  );
}

// ── Action-needed queue ─────────────────────────────────────────────────────

// One ticket row. PR rows reuse prItemHtml from pr-card.js instead, so the two
// views can never drift on how a PR is presented.
export function actionTicketHtml(t, jiraBase) {
  const kind = jiraStatusKind(t.status);
  // jiraBase already ends in /browse/ — concatenate, like my-tickets-card.js.
  const href = jiraBase ? jiraBase + t.key : null;
  const key = href
    ? `<a class="jira-link" href="${esc(href)}" target="_blank" data-testid="home-action-key-${esc(t.key)}">${esc(t.key)}</a>`
    : `<span data-testid="home-action-key-${esc(t.key)}">${esc(t.key)}</span>`;
  return (
    `<div class="action-ticket" data-testid="home-action-ticket-${esc(t.key)}">` +
    `<span class="action-ticket-key">${key}</span>` +
    `<span class="action-ticket-summary">${esc(t.summary || '')}</span>` +
    '<div class="action-ticket-meta">' +
    `<span class="pill" data-jira-status-kind="${esc(kind)}">${esc(t.status)}</span>` +
    (t.issueType ? `<span class="action-dim">${esc(t.issueType)}</span>` : '') +
    `<span class="updated">${esc(timeAgo(t.updated))}</span>` +
    '</div>' +
    '</div>'
  );
}

// A reason group: the shared "why is this here" header plus its rows.
export function actionGroupHtml({ id, reason, rows }) {
  if (!rows.length) return '';
  return (
    `<section class="action-group" data-testid="home-action-group-${esc(id)}">` +
    `<h4 class="action-reason" data-testid="home-action-reason-${esc(id)}">${esc(reason)}` +
    `<span class="action-count">${rows.length}</span></h4>` +
    rows.join('') +
    '</section>'
  );
}

// ── Service health strip ────────────────────────────────────────────────────

// legacy-ui has no browsable port of its own, so it gets no link — same rule
// as service-card.js.
function stripPort(s) {
  if (!s.port || s.id === 'legacy-ui') return '';
  return (
    `<a class="port" href="http://127.0.0.1:${esc(s.port)}" target="_blank"` +
    ` data-testid="home-svc-port-${esc(s.id)}">:${esc(s.port)}</a>`
  );
}

export function serviceStripRowHtml(s) {
  const id = esc(s.id);
  const running = s.status === 'running';
  const label =
    s.status + (s.exitCode != null && s.exitCode !== s.status ? ` (${s.exitCode})` : '');
  return (
    `<div class="svc-row" data-testid="home-svc-${id}">` +
    `<span class="pill status" data-status="${esc(s.status)}" data-testid="home-svc-status-${id}">${esc(label)}</span>` +
    `<span class="svc-name" data-testid="home-svc-name-${id}">${esc(s.label)}</span>` +
    stripPort(s) +
    '<span class="svc-spacer"></span>' +
    `<button class="btn ${running ? 'stop' : 'start'}" data-action="${running ? 'stop' : 'start'}"` +
    ` data-service="${id}" data-testid="home-svc-toggle-${id}">${running ? 'Stop' : 'Start'}</button>` +
    '</div>'
  );
}

export function serviceStripHtml(services) {
  return services.map(serviceStripRowHtml).join('');
}
