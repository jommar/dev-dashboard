import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boardOf,
  boardSeries,
  buildTeamBoards,
  fetchTeamIssues,
  renderTeamVelocityHtml,
} from '../team-velocity.mjs';
import { SPRINT_FIELD, POINTS_FIELD } from '../jira.mjs';

const sprint = (id, name, state, endDate) => ({ id, name, state, endDate });
const issue = (key, who, points, sprints) => ({
  key,
  fields: {
    status: { name: 'Done', statusCategory: { name: 'Done' } },
    assignee: who ? { displayName: who } : null,
    [POINTS_FIELD]: points,
    [SPRINT_FIELD]: sprints,
  },
});

test('boardOf strips the sprint suffix and falls back to Other', () => {
  assert.equal(boardOf('Nexus Sprint 17'), 'Nexus');
  assert.equal(boardOf('Mobile Sprint 4'), 'Mobile');
  assert.equal(boardOf('Kanban'), 'Kanban');
  assert.equal(boardOf(''), 'Other');
});

test('buildTeamBoards groups done points by board, sprint and person', () => {
  const boards = buildTeamBoards([
    issue('N-1', 'Ann', 5, [sprint(1404, 'Nexus Sprint 17', 'active', '2026-09-11')]),
    issue('N-2', 'Bob', 3, [sprint(1404, 'Nexus Sprint 17', 'active', '2026-09-11')]),
    issue('N-3', 'Ann', null, [sprint(1404, 'Nexus Sprint 17', 'active', '2026-09-11')]),
    issue('M-1', 'Ann', 8, [sprint(200, 'Mobile Sprint 17', 'active', '2026-09-11')]),
  ]);
  assert.deepEqual([...boards.keys()], ['Nexus', 'Mobile']);
  const nexus = boards.get('Nexus').get('1404');
  assert.equal(nexus.points, 8);
  assert.equal(nexus.count, 3);
  assert.equal(nexus.unestimated, 1);
  assert.deepEqual(nexus.byUser.get('Ann'), { points: 5, count: 2 });
  assert.deepEqual(nexus.byUser.get('Bob'), { points: 3, count: 1 });
});

test('buildTeamBoards skips future sprints and labels missing assignees', () => {
  const boards = buildTeamBoards([
    issue('F-1', null, 5, [sprint(300, 'Nexus Sprint 99', 'future', '2027-01-01')]),
  ]);
  assert.equal(boards.size, 0);
  const boards2 = buildTeamBoards([
    issue('N-9', null, 2, [sprint(1404, 'Nexus Sprint 17', 'active', '2026-09-11')]),
  ]);
  assert.deepEqual(boards2.get('Nexus').get('1404').byUser.get('(unassigned)'), {
    points: 2,
    count: 1,
  });
});

test('buildTeamBoards counts a carried ticket in every listed sprint', () => {
  const boards = buildTeamBoards([
    issue('N-1', 'Ann', 5, [
      sprint(1404, 'Nexus Sprint 17', 'active', '2026-09-11'),
      sprint(1299, 'Nexus Sprint 16', 'closed', '2026-08-28'),
    ]),
  ]);
  assert.equal(boards.get('Nexus').get('1404').points, 5);
  assert.equal(boards.get('Nexus').get('1299').points, 5);
});

test('boardSeries orders chronologically and keeps the most recent', () => {
  const bySprint = new Map([
    [
      '3',
      {
        sprint: sprint(3, 'Nexus Sprint 3', 'closed', '2026-03-01'),
        points: 1,
        count: 1,
        unestimated: 0,
        byUser: new Map(),
      },
    ],
    [
      '1',
      {
        sprint: sprint(1, 'Nexus Sprint 1', 'closed', '2026-01-01'),
        points: 1,
        count: 1,
        unestimated: 0,
        byUser: new Map(),
      },
    ],
    [
      '2',
      {
        sprint: sprint(2, 'Nexus Sprint 2', 'closed', '2026-02-01'),
        points: 1,
        count: 1,
        unestimated: 0,
        byUser: new Map(),
      },
    ],
  ]);
  assert.deepEqual(
    boardSeries(bySprint, 2).map((e) => e.sprint.name),
    ['Nexus Sprint 2', 'Nexus Sprint 3'],
  );
});

test('renderTeamVelocityHtml reuses the dashboard chart and escapes names', () => {
  const byUser = new Map([['<Ann & Co>', { points: 5, count: 1 }]]);
  const boards = new Map([
    [
      'Nexus',
      new Map([
        [
          '1404',
          {
            sprint: sprint(1404, 'Nexus Sprint 17', 'active', '2026-09-11'),
            points: 5,
            count: 1,
            unestimated: 0,
            byUser,
          },
        ],
      ]),
    ],
    ['Empty', new Map()],
  ]);
  const html = renderTeamVelocityHtml(boards, { keep: 8, date: '2026-09-04' });
  assert.match(html, /<h2 class="[^"]*">Nexus<\/h2>/);
  assert.match(html, /data-testid="home-velocity-chart"/);
  assert.match(html, /snapshot 2026-09-04/);
  assert.doesNotMatch(html, /<h2>Empty<\/h2>/);
  assert.doesNotMatch(html, /<Ann/);
  assert.match(html, /&lt;Ann &amp; Co&gt;/);
  // Portable single file: Tailwind via CDN, no relative dashboard links.
  assert.match(html, /https:\/\/cdn\.tailwindcss\.com/);
  assert.doesNotMatch(html, /ui\/styles/);
});

test('fetchTeamIssues throws when Jira is not configured', async () => {
  const prev = {
    base: process.env.JIRA_BASE_URL,
    email: process.env.JIRA_EMAIL,
    token: process.env.JIRA_TOKEN,
  };
  delete process.env.JIRA_BASE_URL;
  delete process.env.JIRA_EMAIL;
  delete process.env.JIRA_TOKEN;
  try {
    await assert.rejects(fetchTeamIssues(), /JIRA_BASE_URL/);
  } finally {
    if (prev.base !== undefined) process.env.JIRA_BASE_URL = prev.base;
    if (prev.email !== undefined) process.env.JIRA_EMAIL = prev.email;
    if (prev.token !== undefined) process.env.JIRA_TOKEN = prev.token;
  }
});
