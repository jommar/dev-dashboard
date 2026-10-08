import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeSprints,
  allSprints,
  buildMyTicketsJql,
  fetchMyTickets,
  groupTicketsByStatus,
  mapSprints,
  MY_TICKETS_FIELDS,
  POINTS_FIELD,
  SPRINT_FIELD,
} from '../jira.mjs';

test('my-tickets JQL uses currentUser and filters Done by default', () => {
  const open = buildMyTicketsJql();
  assert.match(open, /assignee = currentUser\(\)/);
  assert.match(open, /statusCategory != Done/);
  const all = buildMyTicketsJql({ includeDone: true });
  assert.match(all, /assignee = currentUser\(\)/);
  assert.doesNotMatch(all, /statusCategory/);
});

test('my-tickets groups by category and sorts by status name', () => {
  const { groupsByCategory, groupsByStatus } = groupTicketsByStatus([
    { key: 'A-3', status: 'Done', statusCategory: 'Done', updated: '2026-01-03T00:00:00Z' },
    {
      key: 'A-1',
      status: 'In Progress',
      statusCategory: 'In Progress',
      updated: '2026-01-01T00:00:00Z',
    },
    { key: 'A-2', status: 'Backlog', statusCategory: 'To Do', updated: '2026-01-02T00:00:00Z' },
    {
      key: 'A-4',
      status: 'Selected for Development',
      statusCategory: 'To Do',
      updated: '2026-01-04T00:00:00Z',
    },
  ]);
  assert.deepEqual(Object.keys(groupsByCategory), ['To Do', 'In Progress', 'Done']);
  assert.deepEqual(
    groupsByCategory['To Do'].map((t) => t.key),
    ['A-2', 'A-4'],
  );
  assert.deepEqual(Object.keys(groupsByStatus), [
    'Backlog',
    'Done',
    'In Progress',
    'Selected for Development',
  ]);
});

test('my-tickets fetch throws when Jira is not configured', async () => {
  const prev = {
    base: process.env.JIRA_BASE_URL,
    email: process.env.JIRA_EMAIL,
    token: process.env.JIRA_TOKEN,
  };
  delete process.env.JIRA_BASE_URL;
  delete process.env.JIRA_EMAIL;
  delete process.env.JIRA_TOKEN;
  try {
    await assert.rejects(fetchMyTickets(), /JIRA_BASE_URL/);
  } finally {
    if (prev.base !== undefined) process.env.JIRA_BASE_URL = prev.base;
    if (prev.email !== undefined) process.env.JIRA_EMAIL = prev.email;
    if (prev.token !== undefined) process.env.JIRA_TOKEN = prev.token;
  }
});

test('my-tickets fetch maps issues and paginates', async () => {
  const prev = {
    base: process.env.JIRA_BASE_URL,
    email: process.env.JIRA_EMAIL,
    token: process.env.JIRA_TOKEN,
    fetch: globalThis.fetch,
  };
  process.env.JIRA_BASE_URL = 'https://example.atlassian.net';
  process.env.JIRA_EMAIL = 'me@example.com';
  process.env.JIRA_TOKEN = 'tok';
  let calls = 0;
  try {
    globalThis.fetch = async (url) => {
      calls++;
      const u = decodeURIComponent(String(url)).replace(/\+/g, ' ');
      assert.match(u, /assignee = currentUser\(\)/);
      if (calls === 1) {
        assert.doesNotMatch(u, /nextPageToken/);
        return {
          ok: true,
          json: async () => ({
            isLast: false,
            nextPageToken: 'page-2',
            issues: [
              {
                key: 'PRT-1',
                fields: {
                  summary: 'First',
                  status: { name: 'In Progress', statusCategory: { name: 'In Progress' } },
                  priority: { name: 'High' },
                  issuetype: { name: 'Story' },
                  updated: '2026-02-01T00:00:00Z',
                  created: '2026-01-01T00:00:00Z',
                },
              },
            ],
          }),
        };
      }
      assert.match(u, /nextPageToken=page-2/);
      return {
        ok: true,
        json: async () => ({
          isLast: true,
          issues: [
            {
              key: 'PRT-2',
              fields: {
                summary: 'Second',
                status: { name: 'To Do', statusCategory: { name: 'To Do' } },
                priority: { name: 'Medium' },
                issuetype: { name: 'Task' },
                updated: '2026-02-02T00:00:00Z',
                created: '2026-01-02T00:00:00Z',
              },
            },
          ],
        }),
      };
    };
    const data = await fetchMyTickets();
    assert.equal(calls, 2);
    assert.equal(data.total, 2);
    assert.equal(data.tickets[0].key, 'PRT-1');
    assert.equal(data.tickets[0].priority, 'High');
    assert.deepEqual(Object.keys(data.groupsByCategory), ['To Do', 'In Progress']);
  } finally {
    if (prev.base === undefined) delete process.env.JIRA_BASE_URL;
    else process.env.JIRA_BASE_URL = prev.base;
    if (prev.email === undefined) delete process.env.JIRA_EMAIL;
    else process.env.JIRA_EMAIL = prev.email;
    if (prev.token === undefined) delete process.env.JIRA_TOKEN;
    else process.env.JIRA_TOKEN = prev.token;
    globalThis.fetch = prev.fetch;
  }
});

test('my-tickets requests the sprint field', () => {
  assert.match(SPRINT_FIELD, /^customfield_\d+$/);
  assert.ok(MY_TICKETS_FIELDS.split(',').includes(SPRINT_FIELD));
});

test('my-tickets requests the story-points field', () => {
  assert.match(POINTS_FIELD, /^customfield_\d+$/);
  assert.ok(MY_TICKETS_FIELDS.split(',').includes(POINTS_FIELD));
});

test('the fields list has no empty segment', () => {
  // An unset-but-present JIRA_*_FIELD would otherwise emit a trailing comma
  // and Jira 400s the whole query.
  assert.ok(MY_TICKETS_FIELDS.split(',').every((f) => f.trim().length));
});

test('storyPoints keeps 0 but rejects strings, negatives and absence', async () => {
  const prev = {
    base: process.env.JIRA_BASE_URL,
    email: process.env.JIRA_EMAIL,
    token: process.env.JIRA_TOKEN,
    fetch: globalThis.fetch,
  };
  process.env.JIRA_BASE_URL = 'https://example.atlassian.net';
  process.env.JIRA_EMAIL = 'a@b.c';
  process.env.JIRA_TOKEN = 't';
  const issue = (key, raw) => ({
    key,
    fields: {
      summary: key,
      status: { name: 'To Do', statusCategory: { name: 'To Do' } },
      ...(raw === undefined ? {} : { [POINTS_FIELD]: raw }),
    },
  });
  try {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        isLast: true,
        issues: [
          issue('PT-0', 0),
          issue('PT-3', 3),
          issue('PT-HALF', 0.5),
          issue('PT-NULL', null),
          issue('PT-STR', '3'),
          issue('PT-NEG', -1),
          issue('PT-MISSING', undefined),
        ],
      }),
    });
    const data = await fetchMyTickets();
    const points = Object.fromEntries(data.tickets.map((t) => [t.key, t.storyPoints]));
    // 0 is a real estimate; everything else here means "not estimated", and a
    // string means the configured field id is wrong rather than "worth 3".
    assert.equal(points['PT-0'], 0);
    assert.equal(points['PT-3'], 3);
    assert.equal(points['PT-HALF'], 0.5);
    assert.equal(points['PT-NULL'], null);
    assert.equal(points['PT-STR'], null);
    assert.equal(points['PT-NEG'], null);
    assert.equal(points['PT-MISSING'], null);
    assert.equal(data.truncated, false);
  } finally {
    if (prev.base === undefined) delete process.env.JIRA_BASE_URL;
    else process.env.JIRA_BASE_URL = prev.base;
    if (prev.email === undefined) delete process.env.JIRA_EMAIL;
    else process.env.JIRA_EMAIL = prev.email;
    if (prev.token === undefined) delete process.env.JIRA_TOKEN;
    else process.env.JIRA_TOKEN = prev.token;
    globalThis.fetch = prev.fetch;
  }
});

test('my-tickets orders by recency so the cap drops stalest, not To Do', () => {
  // Alphabetical status order dropped To Do first (Done < In Progress < To
  // Do), biasing every derived total toward "finished".
  assert.match(buildMyTicketsJql(), /ORDER BY updated DESC$/);
  assert.doesNotMatch(buildMyTicketsJql(), /ORDER BY status/);
});

test('mapSprints orders active before future before closed', () => {
  const mapped = mapSprints([
    { id: 3, name: 'Sprint 16', state: 'closed', endDate: '2026-08-23T05:00:00Z' },
    { id: 4, name: 'Sprint 18', state: 'future' },
    { id: 5, name: 'Sprint 17', state: 'active', endDate: '2026-09-06T05:00:00Z' },
    { id: 2, name: 'Sprint 15', state: 'closed', endDate: '2026-08-09T05:00:00Z' },
  ]);
  assert.deepEqual(
    mapped.map((s) => s.name),
    ['Sprint 17', 'Sprint 18', 'Sprint 16', 'Sprint 15'],
  );
});

test('mapSprints tolerates a missing or malformed sprint field', () => {
  assert.deepEqual(mapSprints(undefined), []);
  assert.deepEqual(mapSprints(null), []);
  assert.deepEqual(mapSprints([null, {}, { name: '' }, 'nope']), []);
  // Jira sometimes hands back a lone object rather than an array.
  assert.deepEqual(
    mapSprints({ id: 1, name: 'Solo', state: 'active' }).map((s) => s.name),
    ['Solo'],
  );
});

test('activeSprints dedupes across tickets and ignores non-active states', () => {
  const active = { id: 1404, name: 'Nexus Sprint 17', state: 'active' };
  const found = activeSprints([
    { key: 'A-1', sprints: [active, { id: 1299, name: 'Nexus Sprint 16', state: 'closed' }] },
    { key: 'A-2', sprints: [active] },
    { key: 'A-3', sprints: [{ id: 1405, name: 'Nexus Sprint 18', state: 'future' }] },
    { key: 'A-4', sprints: [] },
    { key: 'A-5' },
  ]);
  assert.deepEqual(
    found.map((s) => s.id),
    [1404],
  );
  assert.deepEqual(activeSprints([]), []);
});

test('allSprints orders active, future, then closed most-recent-first', () => {
  const found = allSprints([
    {
      key: 'A-1',
      sprints: [{ id: 2, name: 'Sprint 15', state: 'closed', endDate: '2026-08-09T05:00:00Z' }],
    },
    {
      key: 'A-2',
      sprints: [{ id: 3, name: 'Sprint 16', state: 'closed', endDate: '2026-08-23T05:00:00Z' }],
    },
    {
      key: 'A-3',
      sprints: [{ id: 5, name: 'Sprint 17', state: 'active', endDate: '2026-09-06T05:00:00Z' }],
    },
    { key: 'A-4', sprints: [{ id: 4, name: 'Sprint 18', state: 'future' }] },
    {
      key: 'A-5',
      sprints: [{ id: 5, name: 'Sprint 17', state: 'active', endDate: '2026-09-06T05:00:00Z' }],
    },
  ]);
  assert.deepEqual(
    found.map((s) => s.name),
    ['Sprint 17', 'Sprint 18', 'Sprint 16', 'Sprint 15'],
  );
  assert.deepEqual(allSprints([]), []);
});

test('my-tickets fetch derives the ticket sprint and the active sprint', async () => {
  const prev = {
    base: process.env.JIRA_BASE_URL,
    email: process.env.JIRA_EMAIL,
    token: process.env.JIRA_TOKEN,
    fetch: globalThis.fetch,
  };
  process.env.JIRA_BASE_URL = 'https://example.atlassian.net';
  process.env.JIRA_EMAIL = 'me@example.com';
  process.env.JIRA_TOKEN = 'tok';
  const s17 = {
    id: 1404,
    name: 'Nexus Sprint 17',
    state: 'active',
    endDate: '2026-09-06T05:00:00Z',
  };
  const s16 = {
    id: 1299,
    name: 'Nexus Sprint 16',
    state: 'closed',
    endDate: '2026-08-23T05:00:00Z',
  };
  const s18 = { id: 1405, name: 'Nexus Sprint 18', state: 'future' };
  const issue = (key, sprint) => ({
    key,
    fields: {
      summary: key,
      status: { name: 'To Do', statusCategory: { name: 'To Do' } },
      updated: '2026-09-01T00:00:00Z',
      [SPRINT_FIELD]: sprint,
    },
  });
  try {
    globalThis.fetch = async (url) => {
      assert.match(decodeURIComponent(String(url)), new RegExp(SPRINT_FIELD));
      return {
        ok: true,
        json: async () => ({
          isLast: true,
          issues: [
            issue('PRT-1', [s16, s17]),
            issue('PRT-2', [s18]),
            issue('PRT-3', [s16]),
            issue('PRT-4', null),
          ],
        }),
      };
    };
    const data = await fetchMyTickets();
    const byKey = Object.fromEntries(data.tickets.map((t) => [t.key, t]));
    // active wins over closed, future over nothing, latest closed as fallback.
    assert.equal(byKey['PRT-1'].sprint.name, 'Nexus Sprint 17');
    assert.equal(byKey['PRT-1'].sprints.length, 2);
    assert.equal(byKey['PRT-2'].sprint.name, 'Nexus Sprint 18');
    assert.equal(byKey['PRT-3'].sprint.name, 'Nexus Sprint 16');
    assert.equal(byKey['PRT-4'].sprint, null);
    assert.deepEqual(byKey['PRT-4'].sprints, []);
    assert.deepEqual(
      data.activeSprints.map((s) => s.name),
      ['Nexus Sprint 17'],
    );
    assert.deepEqual(
      data.allSprints.map((s) => s.name),
      ['Nexus Sprint 17', 'Nexus Sprint 18', 'Nexus Sprint 16'],
    );
  } finally {
    if (prev.base === undefined) delete process.env.JIRA_BASE_URL;
    else process.env.JIRA_BASE_URL = prev.base;
    if (prev.email === undefined) delete process.env.JIRA_EMAIL;
    else process.env.JIRA_EMAIL = prev.email;
    if (prev.token === undefined) delete process.env.JIRA_TOKEN;
    else process.env.JIRA_TOKEN = prev.token;
    globalThis.fetch = prev.fetch;
  }
});
