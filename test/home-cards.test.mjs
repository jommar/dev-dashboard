// home-cards.test.mjs — the sprint bar renders numbers a human acts on, so the
// arithmetic and the honesty rules (unestimated is never hidden, the count
// fallback is always labelled) are pinned here rather than eyeballed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sprintBarHtml,
  sprintCardHtml,
  sprintKeyOf,
  sprintListboxHtml,
  velocityChartHtml,
} from '../ui/components/home-cards.js';
import { sprintProgress } from '../ui/home-data.js';

const ACTIVE = { id: 1404, name: 'Nexus Sprint 17', state: 'active' };
const PREV = { id: 1299, name: 'Nexus Sprint 16', state: 'closed' };

const ticket = (key, statusCategory, storyPoints) => ({
  key,
  summary: key + ' summary',
  status: statusCategory,
  statusCategory,
  updated: '2026-09-01T00:00:00Z',
  sprints: [ACTIVE],
  sprint: ACTIVE,
  storyPoints,
});

const entryFor = (list) => {
  const groups = {};
  for (const t of list) (groups[t.statusCategory] ||= []).push(t);
  return sprintProgress({ groupsByCategory: groups, activeSprints: [ACTIVE] })[0];
};

const widths = (html) => [...html.matchAll(/width:([\d.]+)%/g)].map((m) => Number(m[1]));

test('band widths are points-weighted and sum to 100', () => {
  const entry = entryFor([
    ticket('P-1', 'To Do', 10),
    ticket('P-2', 'In Progress', 7),
    ticket('P-3', 'Done', 83),
  ]);
  const html = sprintBarHtml(entry, 'tid');
  const w = widths(html);
  assert.equal(w.length, 3);
  assert.equal(
    w.reduce((a, b) => a + b, 0),
    100,
  );
  // One 83-point ticket must dominate two others, not sit at a third.
  assert.equal(w[2], 83);
  assert.match(html, /100 pts · 3 tickets/);
});

test('one big done ticket outweighs many small open ones', () => {
  // The bug this feature exists to fix: by ticket count this reads 1 of 3
  // done (33%), by points 13 of 15 (87%).
  const entry = entryFor([
    ticket('W-1', 'Done', 13),
    ticket('W-2', 'To Do', 1),
    ticket('W-3', 'To Do', 1),
  ]);
  assert.equal(entry.counts.done, 1);
  assert.equal(entry.points.done, 13);
  assert.match(sprintBarHtml(entry, 'tid'), /13 of 15 pts/);
});

test('an unestimated sprint falls back to counting tickets and says so', () => {
  const entry = entryFor([ticket('U-1', 'To Do', null), ticket('U-2', 'Done', null)]);
  const html = sprintBarHtml(entry, 'tid');
  assert.deepEqual(widths(html), [50, 50]);
  assert.match(html, /no estimates/);
  assert.match(html, /2 tickets/);
  // No pts figure may appear when none exists.
  assert.doesNotMatch(html, / pts/);
});

test('unestimated tickets are surfaced, not silently zero-width', () => {
  const entry = entryFor([ticket('X-1', 'Done', 5), ticket('X-2', 'To Do', null)]);
  const html = sprintBarHtml(entry, 'tid');
  // The bar is all-green because the To Do ticket has no points...
  assert.deepEqual(widths(html), [100]);
  // ...so the count must be stated rather than left to look complete.
  assert.match(html, /1 unestimated/);
  assert.match(html, /data-testid="tid-unestimated"/);
});

test('a band with tickets but zero points keeps its legend toggle', () => {
  // Otherwise those tickets would be unreachable: no bar band, no legend, no
  // way to drill in.
  const entry = entryFor([ticket('Z-1', 'Done', 5), ticket('Z-2', 'To Do', null)]);
  const html = sprintBarHtml(entry, 'tid');
  assert.match(html, /data-testid="tid-count-todo"/);
  assert.match(html, /data-band="todo"/);
});

test('expanding a band renders its tickets and flips aria-expanded', () => {
  const entry = entryFor([ticket('A-1', 'Done', 5), ticket('A-2', 'To Do', 3)]);
  const closed = sprintBarHtml(entry, 'tid', { expanded: new Set() });
  assert.match(closed, /data-testid="tid-count-done"[^>]*/);
  assert.doesNotMatch(closed, /A-1 summary/);

  const open = sprintBarHtml(entry, 'tid', {
    expanded: new Set([`${sprintKeyOf(ACTIVE)}:done`]),
    jiraBase: 'https://j/browse/',
  });
  assert.match(open, /A-1 summary/);
  assert.doesNotMatch(open, /A-2 summary/);
  assert.match(open, /aria-expanded="true"/);
  // Two bands can be open at once, so each list states which one it is.
  assert.match(open, /class="sprint-tickets-head"[^>]*>Done/);
  assert.match(open, /href="https:\/\/j\/browse\/A-1"/);
  // Rows carry their own points and no redundant sprint pill.
  assert.match(open, /5 pts</);
});

test('fractional points do not leak float noise', () => {
  const entry = entryFor([
    ticket('F-1', 'Done', 0.1),
    ticket('F-2', 'Done', 0.2),
    ticket('F-3', 'To Do', 0.5),
  ]);
  const html = sprintBarHtml(entry, 'tid');
  assert.doesNotMatch(html, /0\.30000000000000004/);
  assert.match(html, /0\.3 of 0\.8 pts/);
});

test('an empty sprint says so instead of dividing by zero', () => {
  const html = sprintBarHtml(entryFor([]), 'tid');
  assert.match(html, /No tickets in this sprint/);
  assert.deepEqual(widths(html), []);
});

test('sprint identity comes from the id, not the display name', () => {
  assert.equal(sprintKeyOf({ id: 1404, name: 'Nexus Sprint 17' }), '1404');
  assert.equal(sprintKeyOf({ id: null, name: 'Nexus Sprint 17' }), 'Nexus Sprint 17');
});

test('ticket summaries are escaped into the expanded list', () => {
  const t = ticket('E-1', 'Done', 1);
  t.summary = '<img src=x onerror=alert(1)>';
  const entry = entryFor([t]);
  const html = sprintCardHtml(entry, {
    range: 'Aug 24 – Sep 6',
    countdown: '2 days left',
    expanded: new Set([`${sprintKeyOf(ACTIVE)}:done`]),
    jiraBase: 'https://j/browse/',
  });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  assert.match(html, /Aug 24 – Sep 6 · 2 days left/);
});

test('sprint listbox button shows the selection and its state', () => {
  const html = sprintListboxHtml([ACTIVE, PREV], '1299');
  assert.match(html, /data-testid="home-sprint-select"/);
  assert.match(html, /aria-haspopup="listbox"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /data-state="closed"/);
  assert.match(html, /Nexus Sprint 16 · closed/);
  // Closed popup renders no options at all.
  assert.doesNotMatch(html, /role="option"/);
});

test('sprint listbox open state colors states apart and highlights the selection', () => {
  const html = sprintListboxHtml([ACTIVE, PREV], '1299', { open: true });
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /role="listbox"/);
  assert.match(html, /Nexus Sprint 17/);
  assert.match(html, /data-state="active"/);
  assert.match(html, /data-state="closed"/);
  assert.match(html, /data-value="1299"[^>]*aria-selected="true"/);
  assert.match(html, /data-value="1404"[^>]*aria-selected="false"/);
});

test('sprint listbox escapes names and keeps same-name boards distinct', () => {
  const evil = { id: 7, name: '<Sprint & 7>', state: 'closed' };
  const twin = { id: 99, name: 'Nexus Sprint 17', state: 'active' };
  const html = sprintListboxHtml([ACTIVE, twin, evil], '99', { open: true });
  assert.doesNotMatch(html, /<Sprint/);
  assert.match(html, /&lt;Sprint &amp; 7&gt;/);
  assert.match(html, /data-value="1404"/);
  assert.match(html, /data-value="99"[^>]*aria-selected="true"/);
});

test('velocity chart scales bars to the largest sprint and reports unestimated work', () => {
  const html = velocityChartHtml([
    { sprint: PREV, points: 4, count: 2, unestimated: 1 },
    { sprint: ACTIVE, points: 8, count: 1, unestimated: 0 },
  ]);
  assert.match(html, /data-testid="home-velocity-chart"/);
  assert.match(html, /height:50%[^>]*data-testid="home-velocity-bar-1299"/);
  assert.match(html, /height:100%[^>]*data-testid="home-velocity-bar-1404"/);
  assert.match(html, /1 unestimated/);
  assert.match(html, /12 pts total/);
  assert.match(html, /role="list" aria-label="Done story points by sprint"/);
  assert.match(
    html,
    /role="listitem" aria-label="Nexus Sprint 16: 4 points across 2 tickets, 1 unestimated"/,
  );
});

test('velocity chart handles empty and all-unestimated series honestly', () => {
  assert.match(velocityChartHtml([]), /No completed sprint data yet/);
  const html = velocityChartHtml([{ sprint: PREV, points: 0, count: 2, unestimated: 2 }]);
  assert.match(html, /no estimates/);
  assert.match(html, /height:0%/);
});

test('velocity chart escapes sprint names in visible and accessible text', () => {
  const html = velocityChartHtml([
    { sprint: { id: 7, name: '<Sprint & 7>' }, points: 3, count: 1, unestimated: 0 },
  ]);
  assert.doesNotMatch(html, /<Sprint/);
  assert.match(html, /&lt;Sprint &amp; 7&gt;/);
});
