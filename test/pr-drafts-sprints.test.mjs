import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import * as jira from '../backend/jira.mjs';
import { createHttpHandler } from '../backend/http-app.mjs';
import { settingsFixture, accept } from './settings-fixture.mjs';

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

async function prsEndpoint(t, integrations, settings) {
  if (!settings) {
    const f = settingsFixture(t);
    settings = await f.store();
    await accept(f, settings);
  }
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
  unavailable = true;
  const outage = await request();
  assert.equal(outage.status, 200);
  assert.equal(outage.data.prsAvailable, false);
  assert.deepEqual(outage.data.draftPrs, []);
  assert.deepEqual(outage.data.draftGroups, {});
});

test(
  'PR aggregation starts eager lanes, sequences metadata and retains one settings snapshot mid-flight',
  { timeout: 5000 },
  async (t) => {
    const f = settingsFixture(t);
    const settings = await f.store();
    await accept(f, settings);
    const mine = Promise.withResolvers();
    const started = Promise.withResolvers();
    const metadataStarted = Promise.withResolvers();
    const metadata = Promise.withResolvers();
    const approvalEnrichment = Promise.withResolvers();
    const enriched = Promise.withResolvers();
    const uat = Promise.withResolvers();
    const calls = [];
    const snapshots = [];
    const record = (name, options) => {
      calls.push(name);
      snapshots.push(options.snapshot);
    };
    const draft = pr(51, ['DEMO-1'], true);
    const own = pr(52, ['DEMO-3']);
    const approval = pr(53, ['DEMO-2']);
    const approved = pr(54, ['DEMO-2']);
    const ownReview = { available: true, approvers: ['reviewer'] };
    const request = await prsEndpoint(
      t,
      {
        fetchUatPromoteCandidates: (options) => {
          record('uat', options);
          return uat.promise;
        },
        fetchOpenPRs: (options) => {
          if (options.mine === false) {
            record('approval-search', options);
            return Promise.resolve({
              prs: [approval, approved],
              groups: { 'DEMO-2': [approval, approved] },
            });
          }
          assert.equal(Object.hasOwn(options, 'mine'), false);
          record('mine-search', options);
          started.resolve();
          return mine.promise;
        },
        fetchTicketMetadata: async (keys, options) => {
          if (keys.includes('DEMO-1')) {
            record('mine-metadata', options);
            assert.deepEqual(keys, ['DEMO-1', 'DEMO-3']);
            metadataStarted.resolve();
            return metadata.promise;
          }
          record('approval-metadata', options);
          assert.deepEqual(keys, ['DEMO-2']);
          return {
            statuses: { 'DEMO-2': 'Ready For Code Review' },
            sprints: { 'DEMO-2': { name: 'Next' } },
          };
        },
        enrichOpenPRs: async (prs, options) => {
          if (prs[0] === approval) {
            record('approval-enrichment', options);
            assert.deepEqual(prs, [approval, approved]);
            approval.reviews = { available: true, approvers: ['one'] };
            approved.reviews = { available: true, approvers: ['one', 'two'] };
            return approvalEnrichment.promise;
          }
          record('mine-enrichment', options);
          assert.deepEqual(prs, [own], 'draft extraction must precede the own status filter');
          enriched.resolve();
          return { available: true, reviews: { 'ExampleOrg/app#52': ownReview } };
        },
      },
      settings,
    );
    const pending = request();
    t.after(async () => {
      mine.resolve({ prs: [], groups: {} });
      metadata.resolve({ statuses: {}, sprints: {} });
      approvalEnrichment.resolve({ available: true, reviews: {} });
      uat.resolve({ available: false, groups: {}, total: 0 });
      await pending.catch(() => {});
    });
    let settled = false;
    pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await started.promise;
    assert.deepEqual(calls, ['uat', 'approval-search', 'mine-search']);
    const captured = snapshots[0];
    assert.equal(captured.minPrApprover, 2);
    await settings.save({
      ...f.configuration,
      minPrApprover: 3,
      expectedRevision: settings.getSetupStatus().revision,
      credentials: { githubToken: 'synthetic-new-midflight-github-token' },
    });
    assert.equal(settings.getSnapshot().minPrApprover, 3);
    mine.resolve({
      login: 'qa',
      total: 999,
      prs: [draft, own],
      groups: { 'DEMO-1': [draft], 'DEMO-3': [own] },
    });
    await metadataStarted.promise;
    assert.deepEqual(calls, ['uat', 'approval-search', 'mine-search', 'mine-metadata']);
    metadata.resolve({
      statuses: { 'DEMO-1': 'In Progress', 'DEMO-3': 'Code Review' },
      sprints: { 'DEMO-3': { name: 'Active' } },
    });
    await enriched.promise;
    assert.deepEqual(calls, [
      'uat',
      'approval-search',
      'mine-search',
      'mine-metadata',
      'approval-metadata',
      'approval-enrichment',
      'mine-enrichment',
    ]);
    assert.equal(
      settled,
      false,
      'own enrichment starts while approval enrichment is still pending',
    );
    approvalEnrichment.resolve({ available: true, reviews: {} });
    await new Promise(setImmediate);
    assert.equal(settled, false, 'response still waits for the eager UAT lane');
    assert.ok(snapshots.every((snapshot) => snapshot === captured));
    assert.notEqual(
      captured.credentials.githubToken,
      settings.getSnapshot().credentials.githubToken,
    );
    uat.resolve({
      available: true,
      groups: { 'DEMO-9': { ticket: { key: 'DEMO-9' }, prs: [] } },
      total: 1,
    });
    const response = await pending;
    assert.equal(response.status, 200);
    assert.equal(own.reviews, ownReview, 'own review attachment remains in-place');
    assert.deepEqual(response.data, {
      login: 'qa',
      total: 1,
      prs: [{ ...own, reviews: ownReview }],
      groups: { 'DEMO-3': [{ ...own, reviews: ownReview }] },
      prsAvailable: true,
      draftPrs: [draft],
      draftGroups: { 'DEMO-1': [draft] },
      ticketStatuses: { 'DEMO-1': 'In Progress', 'DEMO-3': 'Code Review' },
      ticketSprints: { 'DEMO-3': { name: 'Active' } },
      approvalThreshold: 2,
      reviewDataAvailable: true,
      prsNeedingApprovals: [approval],
      approvalGroups: { 'DEMO-2': [approval] },
      approvalTicketStatuses: { 'DEMO-2': 'Ready For Code Review' },
      approvalTicketSprints: { 'DEMO-2': { name: 'Next' } },
      uatPromoteAvailable: true,
      uatPromoteGroups: { 'DEMO-9': { ticket: { key: 'DEMO-9' }, prs: [] } },
      uatPromoteTotal: 1,
    });
  },
);

for (const failedSearch of ['mine', 'approval']) {
  test(`PR ${failedSearch} search failure does not hide the independent successful lane`, async (t) => {
    const own = pr(61, ['DEMO-1'], true);
    const approval = { ...pr(62, ['DEMO-2']), reviews: { available: true, approvers: [] } };
    const metadataKeys = [];
    const enrichNumbers = [];
    const request = await prsEndpoint(t, {
      fetchOpenPRs: async ({ mine = true }) => {
        if (mine === (failedSearch === 'mine')) throw new Error('synthetic search failure');
        return mine
          ? { prs: [own], groups: { 'DEMO-1': [own] } }
          : { prs: [approval], groups: { 'DEMO-2': [approval] } };
      },
      fetchTicketMetadata: async (keys) => {
        metadataKeys.push(keys);
        return {
          statuses: { 'DEMO-1': 'Code Review', 'DEMO-2': 'Ready For Code Review' },
          sprints: {},
        };
      },
      enrichOpenPRs: async (prs) => {
        enrichNumbers.push(prs.map((pr) => pr.number));
        return { available: true, reviews: {} };
      },
      fetchUatPromoteCandidates: async () => ({ available: false, groups: {}, total: 0 }),
    });
    const { status, data } = await request();
    assert.equal(status, 200);
    assert.equal(data.prsAvailable, failedSearch !== 'mine');
    assert.equal(data.reviewDataAvailable, failedSearch !== 'approval');
    assert.deepEqual(
      data.prs.map((pr) => pr.number),
      failedSearch === 'mine' ? [] : [61],
    );
    assert.deepEqual(
      data.draftPrs.map((pr) => pr.number),
      failedSearch === 'mine' ? [] : [61],
    );
    assert.deepEqual(
      data.prsNeedingApprovals.map((pr) => pr.number),
      failedSearch === 'approval' ? [] : [62],
    );
    assert.deepEqual(
      data.approvalGroups,
      failedSearch === 'approval' ? {} : { 'DEMO-2': [approval] },
    );
    assert.deepEqual(metadataKeys, failedSearch === 'mine' ? [[], ['DEMO-2']] : [['DEMO-1'], []]);
    assert.deepEqual(enrichNumbers, failedSearch === 'mine' ? [[62]] : [[61]]);
    assert.equal(data.total, failedSearch === 'mine' ? 0 : 1);
    assert.equal(data.uatPromoteAvailable, false);
  });
}

for (const failedStage of ['metadata', 'enrichment', 'uat']) {
  test(`PR ${failedStage} rejection remains an outer HTTP error rather than a search outage`, async (t) => {
    const fail = async () => {
      throw new Error('synthetic private integration failure');
    };
    const request = await prsEndpoint(t, {
      fetchOpenPRs: async () => ({ prs: [], groups: {} }),
      fetchTicketMetadata:
        failedStage === 'metadata' ? fail : async () => ({ statuses: {}, sprints: {} }),
      enrichOpenPRs:
        failedStage === 'enrichment' ? fail : async () => ({ available: true, reviews: {} }),
      fetchUatPromoteCandidates:
        failedStage === 'uat'
          ? async () =>
              new Promise((resolve, reject) =>
                setImmediate(() => reject(new Error('synthetic private UAT failure'))),
              )
          : async () => ({ available: true, groups: {}, total: 0 }),
    });
    assert.deepEqual(await request(), {
      status: 502,
      data: { code: 'OPERATION_FAILED', error: 'OPERATION FAILED', errors: [] },
    });
  });
}

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
