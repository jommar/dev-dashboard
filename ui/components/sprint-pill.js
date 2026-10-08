import { esc } from '../dom.js';

const SPRINT_DAY = { month: 'short', day: 'numeric' };

function sprintRangeText(sp) {
  const day = (iso) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? new Date(t).toLocaleDateString(undefined, SPRINT_DAY) : null;
  };
  const from = day(sp.startDate);
  const to = day(sp.endDate);
  if (from && to) return `${from} – ${to}`;
  return from || to || '';
}

export function sprintPillHtml(sp, testId) {
  const state = sp ? sp.state : 'none';
  const label = sp ? sp.name : 'No sprint';
  const range = sp ? sprintRangeText(sp) : '';
  const title = sp ? [sp.state, range].filter(Boolean).join(' · ') : 'Not in a sprint';
  return (
    `<span class="pill ticket-sprint" data-sprint-state="${esc(state)}" data-tooltip="${esc(title)}"` +
    ` data-testid="${esc(testId)}">${esc(label)}</span>`
  );
}
