// my-tickets-card.test.mjs — the "in the current sprint" card highlight. The
// marking itself is the only new logic (it reuses home-data.js's inSprints, so
// the scoping rule is already tested there); what can silently regress here is
// the flag reaching the wrong rows, and Home's drill-down reusing this row
// starting to carry a highlight it never asked for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { myTicketsHtml, ticketRowHtml } from '../ui/components/my-tickets-card.js';

const JIRA_BASE = 'https://jira.example.invalid/browse/';

const ACTIVE = {
  id: 1404,
  name: 'Nexus Sprint 17',
  state: 'active',
  startDate: '2026-08-24',
  endDate: '2026-09-06',
};
const CLOSED = {
  id: 1299,
  name: 'Nexus Sprint 16',
  state: 'closed',
  startDate: '2026-08-10',
  endDate: '2026-08-23',
};

const ticket = (key, sprints) => ({
  key,
  summary: `${key} summary`,
  status: 'In Progress',
  statusCategory: 'In Progress',
  updated: '2026-09-01T00:00:00Z',
  sprints,
  // What the server picks to display: active first, else the latest.
  sprint: sprints[0] || null,
});

const htmlFor = (tickets, currentSprints) =>
  myTicketsHtml({ 'In Progress': tickets }, JIRA_BASE, currentSprints);
// The row testid keeps the raw Jira key (only the rail/pill markup is slugged),
// so match on the key exactly as it was handed in.
const rowFor = (key, html) =>
  html.match(new RegExp(`<div class="my-ticket"[^>]*data-testid="my-tickets-item-${key}"`))?.[0] ||
  '';

test('a ticket in the active sprint is marked on the card', () => {
  const html = htmlFor([ticket('A-1', [ACTIVE])], [ACTIVE]);
  assert.match(rowFor('A-1', html), /data-in-current-sprint="true"/);
});

test('a ticket only in a closed sprint is not marked', () => {
  const html = htmlFor([ticket('B-1', [CLOSED])], [ACTIVE]);
  assert.doesNotMatch(rowFor('B-1', html), /data-in-current-sprint/);
});

test('a ticket carried over from a closed sprint is still marked', () => {
  // `sprint` is the closed one, so the naive `t.sprint === active` check would
  // miss a ticket that is genuinely committed to the current sprint.
  const html = htmlFor([ticket('C-1', [CLOSED, ACTIVE])], [ACTIVE]);
  assert.match(rowFor('C-1', html), /data-in-current-sprint="true"/);
});

test('a backlog ticket with no sprint is not marked', () => {
  const html = htmlFor([ticket('D-1', [])], [ACTIVE]);
  assert.doesNotMatch(rowFor('D-1', html), /data-in-current-sprint/);
});

test('sprint identity is matched by id, not by display name', () => {
  const renamed = { ...ACTIVE, name: 'Renamed Sprint' };
  const html = htmlFor([ticket('E-1', [ACTIVE])], [renamed]);
  assert.match(rowFor('E-1', html), /data-in-current-sprint="true"/);
});

test('with no active sprint nothing is marked', () => {
  const html = htmlFor([ticket('F-1', [ACTIVE])], []);
  assert.doesNotMatch(html, /data-in-current-sprint/);
});

test("Home's drill-down rows carry no highlight", () => {
  // That caller passes no currentSprints — every row there is already in the
  // sprint being expanded, so a rail on all of them would be pure noise.
  const html = ticketRowHtml(ticket('G-1', [ACTIVE]), JIRA_BASE, {
    showSprint: false,
    testIdPrefix: 'sprint-tickets-item',
  });
  assert.doesNotMatch(html, /data-in-current-sprint/);
});

test('the status pill keeps its own color on a highlighted card', () => {
  // The two signals are independent: a Done ticket can still be in the sprint.
  const done = { ...ticket('H-1', [ACTIVE]), status: 'Done', statusCategory: 'Done' };
  const html = myTicketsHtml({ Done: [done] }, JIRA_BASE, [ACTIVE]);
  assert.match(rowFor('H-1', html), /data-in-current-sprint="true"/);
  assert.match(html, /<span class="pill ticket-status" data-jira-status-kind="done"/);
});
