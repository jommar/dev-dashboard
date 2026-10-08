import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import * as jira from '../backend/jira.mjs';
import { createHttpHandler } from '../backend/http-app.mjs';
import { settingsFixture, accept } from './settings-fixture.mjs';
import { prOpenListHtml } from '../ui/components/pr-open-section.js';
import { prApprovalSectionHtml } from '../ui/components/pr-approval-section.js';
import { prUatPromoteSectionHtml } from '../ui/components/pr-uat-promote-section.js';
import { ticketCardHtml } from '../ui/components/pr-card.js';

const jiraBase = 'https://jira.example.invalid/browse/';
const pr = (number, tickets, draft = false, updatedAt = '2026-10-06T12:00:00Z') => ({
  number,
  tickets,
  draft,
  updatedAt,
  createdAt: '2026-10-01T12:00:00Z',
  repo: 'ExampleOrg/app',
  owner: 'qa',
  title: `Change ${number}`,
  url: `https://github.com/ExampleOrg/app/pull/${number}`,
  labels: [],
});

async function prsEndpoint(t, integrations) {
  const f = settingsFixture(t);
  const settings = await f.store();
  await accept(f, settings);
  const handler = createHttpHandler({
    settings,
    manager: { list: () => [], applySettings() {} },
    integrations,
  });
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    handler.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return () =>
    new Promise((resolve, reject) => {
      const request = http.get(`http://127.0.0.1:${server.address().port}/api/prs`, (response) => {
        let text = '';
        response.on('data', (chunk) => {
          text += chunk;
        });
        response.on('end', () => {
          try {
            resolve({ status: response.statusCode, data: JSON.parse(text) });
          } catch (error) {
            reject(error);
          }
        });
      });
      request.setTimeout(2000, () => request.destroy(new Error('PR request timed out')));
      request.on('error', reject);
    });
}

test('own drafts survive every Jira status while compatible PR inputs and ready rendering stay separate', async (t) => {
  const old = pr(11, ['DEMO-1', 'DEMO-99'], true, '2026-10-02T12:00:00Z');
  const recent = pr(12, ['DEMO-1'], true);
  const reviewDraft = pr(13, ['DEMO-2'], true);
  const unticketed = pr(14, [], true);
  const unknown = pr(15, ['DEMO-3'], true);
  const ready = pr(16, ['DEMO-2']);
  const filtered = pr(17, ['DEMO-1']);
  const approval = {
    ...pr(20, ['DEMO-4']),
    owner: 'teammate',
    reviews: { available: true, approvers: [] },
  };
  const mine = [old, recent, reviewDraft, unticketed, unknown, ready, filtered];
  const statuses = {
    'DEMO-1': 'In Progress',
    'DEMO-2': 'Code Review',
    'DEMO-4': 'Ready For Code Review',
  };
  let unavailable = false;
  const request = await prsEndpoint(t, {
    fetchOpenPRs: async ({ mine: own = true }) => {
      if (unavailable) throw new Error('Synthetic GitHub outage');
      return structuredClone(
        own
          ? {
              login: 'qa',
              prs: mine,
              groups: {
                'DEMO-1': [old, recent, filtered],
                'DEMO-2': [reviewDraft, ready],
                'DEMO-3': [unknown],
                Unticketed: [unticketed],
              },
            }
          : { prs: [approval], groups: { 'DEMO-4': [approval] } },
      );
    },
    fetchTicketStatuses: async () => statuses,
    fetchTicketMetadata: async () => ({ statuses, sprints: {} }),
    enrichOpenPRs: async () => ({ available: true, reviews: {} }),
    fetchUatPromoteCandidates: async () => ({ available: true, groups: {}, total: 0 }),
  });
  const { status, data } = await request();
  assert.equal(status, 200);
  assert.deepEqual(
    data.draftPrs?.map((item) => item.number),
    [12, 13, 14, 15, 11],
  );
  assert.deepEqual(Object.keys(data.draftGroups), ['DEMO-1', 'DEMO-2', 'Unticketed', 'DEMO-3']);
  assert.deepEqual(
    data.draftGroups['DEMO-1'].map((item) => item.number),
    [12, 11],
  );
  assert.equal(data.draftGroups['DEMO-99'], undefined, 'only the first ticket groups a draft');
  assert.deepEqual(
    data.prs.map((item) => item.number),
    [13, 14, 16],
    'Home keeps its existing status-filtered PR inputs, including eligible drafts',
  );
  assert.deepEqual(
    data.groups['DEMO-2'].map((item) => item.number),
    [13, 16],
  );
  assert.equal(data.total, 3);
  assert.deepEqual(
    data.prsNeedingApprovals.map((item) => item.number),
    [20],
  );
  assert.deepEqual(data.uatPromoteGroups, {});
  const open = prOpenListHtml(data, jiraBase);
  assert.match(open, /pr-open-ExampleOrg\/app-16/);
  assert.doesNotMatch(open, /data-pr-state="draft"|pr-open-ExampleOrg\/app-(13|14)/);
  const { prDraftSectionHtml } = await import('../ui/components/pr-draft-section.js');
  const draft = prDraftSectionHtml(data, jiraBase);
  assert.match(draft, /Your draft PRs/);
  assert.match(draft, /data-testid="pr-draft-count">5</);
  assert.match(draft, /data-testid="pr-draft-group-count-DEMO-1">2</);
  assert.match(draft, /data-testid="pr-draft-view-diff-ExampleOrg\/app-12"/);
  assert.ok(
    draft.indexOf('pr-draft-ExampleOrg/app-12') < draft.indexOf('pr-draft-ExampleOrg/app-11'),
  );
  assert.doesNotMatch(draft, /pr-draft-ExampleOrg\/app-(16|20|21)"/);
  assert.match(
    prDraftSectionHtml({ ...data, draftPrs: [], draftGroups: {} }, jiraBase),
    /No draft PRs/,
  );
  unavailable = true;
  const outage = await request();
  assert.equal(outage.status, 200);
  assert.equal(outage.data.prsAvailable, false);
  assert.deepEqual(outage.data.draftPrs, []);
  assert.deepEqual(outage.data.draftGroups, {});
  assert.match(prDraftSectionHtml(outage.data, jiraBase), /GitHub is unavailable/);
});

test('Jira public metadata lookup and PR HTTP response carry configured preferred sprints without changing status maps', async (t) => {
  const f = settingsFixture(t);
  const settings = await f.store();
  await accept(f, settings);
  const snapshot = settings.getSnapshot();
  const active = {
    id: 8,
    name: 'Active sprint',
    state: 'active',
    startDate: '2026-10-01',
    endDate: '2026-10-14',
  };
  const future = { id: 9, name: 'Future sprint', state: 'future' };
  const closed = { id: 7, name: 'Latest closed sprint', state: 'closed', endDate: '2026-09-30' };
  const issues = [
    {
      key: 'DEMO-1',
      fields: { status: { name: 'Code Review' }, customfield_101: [closed, future, active] },
    },
    {
      key: 'DEMO-2',
      fields: { status: { name: 'Ready For Code Review' }, customfield_101: [closed, future] },
    },
    {
      key: 'DEMO-3',
      fields: {
        status: { name: 'Done' },
        customfield_101: [{ name: 'Old', state: 'closed', endDate: '2026-08-01' }, closed],
      },
    },
    { key: 'DEMO-4', fields: { status: { name: 'Code Review' } } },
    { key: 'DEMO-5', fields: { status: { name: 'Promote to UAT' }, customfield_101: [active] } },
    {
      key: 'DEMO-6',
      fields: { status: { name: 'Code Review' }, customfield_101: [null, {}, 'invalid'] },
    },
  ];
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://jira.example.invalid');
    assert.equal(url.pathname, '/rest/api/3/search/jql');
    requests.push(url);
    return Response.json({ issues, isLast: true });
  });
  const keys = ['DEMO-1', 'DEMO-2', 'DEMO-3', 'DEMO-4', 'DEMO-5', 'DEMO-6'];
  const metadata = await jira.fetchTicketMetadata(keys, { snapshot });
  assert.deepEqual(requests[0].searchParams.get('fields').split(',').sort(), [
    'customfield_101',
    'status',
  ]);
  assert.deepEqual(metadata.statuses, {
    'DEMO-1': 'Code Review',
    'DEMO-2': 'Ready For Code Review',
    'DEMO-3': 'Done',
    'DEMO-4': 'Code Review',
    'DEMO-5': 'Promote to UAT',
    'DEMO-6': 'Code Review',
  });
  assert.deepEqual(metadata.sprints['DEMO-1'], active);
  assert.deepEqual(metadata.sprints['DEMO-2'], {
    id: 9,
    name: 'Future sprint',
    state: 'future',
    startDate: null,
    endDate: null,
  });
  assert.deepEqual(metadata.sprints['DEMO-3'], {
    id: 7,
    name: 'Latest closed sprint',
    state: 'closed',
    startDate: null,
    endDate: '2026-09-30',
  });
  assert.equal(metadata.sprints['DEMO-4'], null);
  assert.equal(metadata.sprints['DEMO-6'], null);
  assert.deepEqual(await jira.fetchTicketStatuses(keys, { snapshot }), metadata.statuses);
  const uatTickets = await jira.fetchUatPromoteTickets({ snapshot });
  assert.equal(uatTickets.find((item) => item.key === 'DEMO-5').sprint.name, 'Active sprint');
  assert.ok(requests.at(-1).searchParams.get('fields').split(',').includes('customfield_101'));
  const own = pr(30, ['DEMO-1']);
  const other = {
    ...pr(31, ['DEMO-2']),
    owner: 'teammate',
    reviews: { available: true, approvers: [] },
  };
  const request = await prsEndpoint(t, {
    fetchOpenPRs: async ({ mine = true }) =>
      structuredClone(
        mine
          ? { prs: [own], groups: { 'DEMO-1': [own] } }
          : { prs: [other], groups: { 'DEMO-2': [other] } },
      ),
    enrichOpenPRs: async () => ({ available: true, reviews: {} }),
    fetchUatPromoteCandidates: async () => ({
      available: true,
      total: 1,
      groups: {
        'DEMO-5': {
          ticket: uatTickets.find((item) => item.key === 'DEMO-5'),
          prs: [pr(32, ['DEMO-5'])],
        },
      },
    }),
  });
  const response = await request();
  assert.equal(response.status, 200);
  assert.equal(response.data.ticketStatuses['DEMO-1'], 'Code Review');
  assert.deepEqual(response.data.ticketSprints['DEMO-1'], active);
  assert.equal(response.data.approvalTicketStatuses['DEMO-2'], 'Ready For Code Review');
  assert.equal(response.data.approvalTicketSprints['DEMO-2'].name, 'Future sprint');
  assert.equal(response.data.uatPromoteGroups['DEMO-5'].ticket.sprint.name, 'Active sprint');
  for (const [rawSprints, expectedSprint] of [
    [
      [
        closed,
        {
          name: 'Malformed closed',
          state: 'closed',
          startDate: { toString: null },
          endDate: { toString: null },
        },
      ],
      {
        id: 7,
        name: 'Latest closed sprint',
        state: 'closed',
        startDate: null,
        endDate: '2026-09-30',
      },
    ],
    [
      [{ name: 'Malformed single', state: 'active', startDate: 123, endDate: { toString: null } }],
      { id: null, name: 'Malformed single', state: 'active', startDate: null, endDate: null },
    ],
  ]) {
    await t.test(expectedSprint.name, async () => {
      t.mock.method(globalThis, 'fetch', async (input) => {
        const uat = new URL(input).searchParams.get('jql').includes('Promote to UAT');
        return Response.json({
          issues: [
            {
              key: 'DEMO-7',
              fields: {
                status: { name: uat ? 'Promote to UAT' : 'Code Review' },
                customfield_101: rawSprints,
              },
            },
          ],
        });
      });
      const malformedMetadata = await jira.fetchTicketMetadata(['DEMO-7'], { snapshot });
      assert.deepEqual(malformedMetadata.statuses, { 'DEMO-7': 'Code Review' });
      assert.deepEqual(malformedMetadata.sprints['DEMO-7'], expectedSprint);
      assert.deepEqual(await jira.fetchTicketStatuses(['DEMO-7'], { snapshot }), {
        'DEMO-7': 'Code Review',
      });
      const retainedTickets = await jira.fetchUatPromoteTickets({ snapshot });
      assert.deepEqual(retainedTickets, [
        { key: 'DEMO-7', summary: '', status: 'Promote to UAT', sprint: expectedSprint },
      ]);
      for (const variant of ['pr-open', 'pr-draft', 'pr-approval', 'pr-uat-promote']) {
        const html = ticketCardHtml('DEMO-7', [pr(33, ['DEMO-7'])], 'Code Review', jiraBase, {
          variant,
          sprint: malformedMetadata.sprints['DEMO-7'],
        });
        assert.match(html, /data-testid="[^"]*-ticket-status-DEMO-7">Code Review</);
        assert.ok(html.includes(expectedSprint.name));
        assert.doesNotMatch(html, /Invalid Date|\[object Object\]/);
      }
    });
  }
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Synthetic Jira outage');
  });
  assert.deepEqual(await jira.fetchTicketStatuses(keys, { snapshot }), {});
  assert.deepEqual(await jira.fetchTicketMetadata(keys, { snapshot }), {
    statuses: {},
    sprints: {},
  });
});

test('shared PR headers show optional escaped sprint state and dates in open, draft, approval and UAT sections', async () => {
  const sprint = {
    id: 8,
    name: 'Sprint <img src=x> & "delivery"',
    state: 'active',
    startDate: '2026-10-01T12:00:00Z',
    endDate: '2026-10-14T12:00:00Z',
  };
  const own = pr(40, ['DEMO-1']);
  const draft = pr(41, ['DEMO-1'], true);
  const data = {
    prsAvailable: true,
    prs: [own],
    groups: { 'DEMO-1': [own] },
    ticketStatuses: { 'DEMO-1': 'Code Review' },
    ticketSprints: { 'DEMO-1': sprint },
    draftPrs: [draft],
    draftGroups: { 'DEMO-1': [draft] },
    approvalThreshold: 2,
    reviewDataAvailable: true,
    prsNeedingApprovals: [own],
    approvalGroups: { 'DEMO-1': [own] },
    approvalTicketStatuses: { 'DEMO-1': 'Ready For Code Review' },
    approvalTicketSprints: { 'DEMO-1': sprint },
    uatPromoteAvailable: true,
    uatPromoteTotal: 1,
    uatPromoteGroups: { 'DEMO-1': { prs: [own], ticket: { status: 'Promote to UAT', sprint } } },
  };
  const check = (html, variant) => {
    assert.match(
      html,
      /Sprint &lt;img src=x&gt; &amp; &quot;delivery&quot;/,
      `${variant} must escape the sprint name`,
    );
    assert.match(html, /data-sprint-state="active"/);
    assert.match(html, /data-tooltip="active · [^"]*Oct 1[^"]*Oct 14/);
    assert.match(html, new RegExp(`data-testid="${variant}-ticket-status-DEMO-1"`));
    assert.match(html, new RegExp(`data-testid="${variant}-group-count-DEMO-1">1<`));
    assert.match(html, new RegExp(`data-testid="${variant}-updated-ExampleOrg/app-`));
    assert.doesNotMatch(html, /<img|<script/);
  };
  check(prOpenListHtml(data, jiraBase), 'pr-open');
  const { prDraftSectionHtml } = await import('../ui/components/pr-draft-section.js');
  check(prDraftSectionHtml(data, jiraBase), 'pr-draft');
  check(prApprovalSectionHtml(data, jiraBase), 'pr-approval');
  check(prUatPromoteSectionHtml(data, jiraBase), 'pr-uat-promote');
  for (const variant of ['pr-open', 'pr-draft', 'pr-approval', 'pr-uat-promote']) {
    assert.doesNotMatch(
      ticketCardHtml('DEMO-1', [own], 'Code Review', jiraBase, { variant }),
      /ticket-sprint|No sprint/,
    );
    assert.doesNotMatch(
      ticketCardHtml('Unticketed', [own], null, jiraBase, { variant, sprint }),
      /ticket-sprint|Sprint &lt;/,
    );
    const future = ticketCardHtml('DEMO-1', [own], 'Code Review', jiraBase, {
      variant,
      sprint: { name: 'Next', state: 'future' },
    });
    assert.match(future, /data-sprint-state="future"/);
    assert.doesNotMatch(future, /Invalid Date/);
  }
  const without = {
    ...data,
    ticketSprints: {},
    approvalTicketSprints: {},
    uatPromoteGroups: { 'DEMO-1': { prs: [own], ticket: { status: 'Promote to UAT' } } },
  };
  for (const html of [
    prOpenListHtml(without, jiraBase),
    prDraftSectionHtml(without, jiraBase),
    prApprovalSectionHtml(without, jiraBase),
    prUatPromoteSectionHtml(without, jiraBase),
  ]) {
    assert.doesNotMatch(html, /ticket-sprint|No sprint/);
  }
});
