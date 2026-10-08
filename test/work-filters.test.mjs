import test from 'node:test';
import assert from 'node:assert/strict';
import { capTiers } from '../ui/home-data.js';

function freezeTree(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeTree);
    Object.freeze(value);
  }
  return value;
}

test('public work filters project groups, match literal AND criteria, preserve sprint history and filter before capping', async (t) => {
  const { filterPrPayload, filterTickets, filterActionTiers } =
    await import('../ui/work-filters.js');
  const active = { id: 1, name: 'Delivery', state: 'active' };
  const previous = { id: 2, name: 'Delivery', state: 'closed' };
  const approved = {
    state: 'approved',
    approvers: ['reviewer'],
    changesRequesters: [],
    available: true,
  };
  const changes = {
    state: 'changes_requested',
    approvers: [],
    changesRequesters: ['reviewer'],
    available: true,
  };
  const awaiting = { state: null, approvers: [], changesRequesters: [], available: true };
  const pr = (number, overrides = {}) => ({
    number,
    repo: 'example/api',
    owner: 'developer',
    title: 'Literal [fix].* <img> & delivery',
    draft: false,
    tickets: ['DEMO-1', 'DEMO-2'],
    reviews: changes,
    ...overrides,
  });
  const target = pr(101);
  const neighbor = pr(102, { repo: 'example/web', reviews: approved, tickets: ['DEMO-1'] });
  const unknown = pr(103, { reviews: null, tickets: ['DEMO-3'] });
  const unavailable = pr(104, { reviews: { ...awaiting, available: false }, tickets: ['DEMO-3'] });
  const pending = pr(105, { reviews: awaiting, tickets: ['DEMO-4'] });
  const draft = pr(106, { draft: true, reviews: null, tickets: ['DEMO-5'] });
  const teammate = pr(107, { owner: 'colleague', reviews: awaiting, tickets: ['DEMO-6'] });
  const candidate = pr(108, { repo: 'example/web', reviews: approved, tickets: ['DEMO-7'] });
  const payload = freezeTree({
    login: 'developer',
    total: 5,
    prsAvailable: true,
    prs: [target, neighbor, unknown, unavailable, pending],
    groups: {
      'DEMO-1': [target, neighbor],
      'DEMO-2': [target],
      'DEMO-3': [unknown, unavailable],
      'DEMO-4': [pending],
    },
    draftPrs: [draft],
    draftGroups: { 'DEMO-5': [draft] },
    prsNeedingApprovals: [teammate],
    approvalGroups: { 'DEMO-6': [teammate] },
    uatPromoteTotal: 1,
    uatPromoteAvailable: true,
    uatPromoteGroups: {
      'DEMO-7': { ticket: { status: 'Promote to UAT', sprint: active }, prs: [candidate] },
    },
    ticketStatuses: { 'DEMO-1': 'Code Review', 'DEMO-2': 'Ready For Testing' },
    ticketSprints: { 'DEMO-1': active, 'DEMO-2': previous },
    approvalThreshold: 2,
    reviewDataAvailable: true,
    approvalDataAvailable: true,
  });
  const ticket = (key, overrides = {}) => ({
    key,
    summary: 'Literal [fix].* <img> & delivery',
    status: 'In Progress',
    statusCategory: 'In Progress',
    priority: 'High',
    issueType: 'Bug',
    sprint: active,
    sprints: [previous, active],
    ...overrides,
  });
  const tickets = freezeTree([
    ticket('DEMO-1'),
    ticket('DEMO-2', { priority: 'Low' }),
    ticket('DEMO-3', { issueType: 'Task' }),
    ticket('DEMO-4', { status: 'To Do', statusCategory: 'To Do' }),
    ticket('DEMO-5', { sprints: [{ id: 3, name: 'Delivery' }] }),
    ticket('DEMO-6', { sprint: previous, sprints: undefined }),
    ticket('DEMO-7', { sprint: null, sprints: [] }),
  ]);
  const originalPayload = structuredClone(payload);
  const originalTickets = structuredClone(tickets);

  await t.test('JSON-decoded group-only context matches retain section flat rows', () => {
    const decoded = JSON.parse(JSON.stringify(payload));
    for (const [section, groups, rows, key, number] of [
      ['open', 'groups', 'prs', 'CONTEXT-OPEN', 101],
      ['draft', 'draftGroups', 'draftPrs', 'CONTEXT-DRAFT', 106],
      ['approval', 'approvalGroups', 'prsNeedingApprovals', 'CONTEXT-APPROVAL', 107],
    ]) {
      decoded[groups] = { [key]: [structuredClone(decoded[rows][0])] };
      const result = filterPrPayload(decoded, { section, search: key });
      assert.deepEqual(
        result[rows].map((pr) => pr.number),
        [number],
      );
      assert.deepEqual(Object.keys(result[groups]), [key]);
    }
  });

  await t.test('production overlapping main and draft arrays exclude drafts from Open', () => {
    const decoded = JSON.parse(
      JSON.stringify({ ...payload, prs: [draft], groups: { Unticketed: [draft] } }),
    );
    const open = filterPrPayload(decoded, { section: 'open' });
    assert.deepEqual(open.prs, []);
    assert.deepEqual(open.groups, {});
    assert.deepEqual(
      filterPrPayload(decoded, { section: 'draft' }).draftPrs.map((pr) => pr.number),
      [106],
    );
  });

  await t.test(
    'PR projection keeps only matching rows in every original group and retains metadata',
    () => {
      const result = filterPrPayload(payload, {
        search: '[FiX].* <IMG> &',
        section: 'open',
        repo: 'example/api',
        review: 'changes_requested',
      });
      assert.deepEqual(
        result.prs.map((item) => item.number),
        [101],
      );
      assert.deepEqual(
        Object.fromEntries(
          Object.entries(result.groups).map(([key, rows]) => [
            key,
            rows.map((item) => item.number),
          ]),
        ),
        { 'DEMO-1': [101], 'DEMO-2': [101] },
      );
      assert.deepEqual(result.draftPrs, []);
      assert.deepEqual(result.draftGroups, {});
      assert.deepEqual(result.prsNeedingApprovals, []);
      assert.deepEqual(result.approvalGroups, {});
      assert.deepEqual(result.uatPromoteGroups, {});
      assert.equal(result.total, 5);
      assert.equal(result.approvalThreshold, 2);
      assert.deepEqual(result.ticketStatuses, originalPayload.ticketStatuses);
      assert.deepEqual(result.ticketSprints, originalPayload.ticketSprints);
      assert.deepEqual(filterPrPayload(payload, { search: 'DEMO-2' }).groups, {
        'DEMO-2': [target],
      });
      assert.deepEqual(filterPrPayload(payload, { search: 'ready for testing' }).groups, {
        'DEMO-2': [target],
      });
      assert.deepEqual(
        filterPrPayload(payload, { search: 'developer', repo: 'missing' }).groups,
        {},
      );
      assert.deepEqual(filterPrPayload(payload, { search: '^Literal' }).groups, {});
      assert.deepEqual(
        filterPrPayload(payload, { search: '101', repo: 'example/api' }).prs.map(
          (item) => item.number,
        ),
        [101],
      );
    },
  );

  await t.test('every section and review state preserves server-provided eligibility', () => {
    assert.deepEqual(
      filterPrPayload(payload, { section: 'draft' }).draftPrs.map((item) => item.number),
      [106],
    );
    assert.deepEqual(
      filterPrPayload(payload, {
        section: 'approval',
        search: 'COLLEAGUE',
      }).prsNeedingApprovals.map((item) => item.number),
      [107],
    );
    const uat = filterPrPayload(payload, {
      section: 'uat',
      repo: 'example/web',
      review: 'approved',
    });
    assert.deepEqual(uat.uatPromoteGroups, {
      'DEMO-7': { ticket: { status: 'Promote to UAT', sprint: active }, prs: [candidate] },
    });
    assert.deepEqual(uat.prs, []);
    assert.deepEqual(
      filterPrPayload(payload, { section: 'open', review: 'approved' }).prs.map(
        (item) => item.number,
      ),
      [102],
    );
    assert.deepEqual(
      filterPrPayload(payload, { section: 'open', review: 'unknown' }).prs.map(
        (item) => item.number,
      ),
      [103, 104],
    );
    assert.deepEqual(
      filterPrPayload(payload, { section: 'open', review: 'awaiting' }).prs.map(
        (item) => item.number,
      ),
      [105],
    );
    assert.deepEqual(filterPrPayload(payload, {}).groups, payload.groups);
    assert.deepEqual(filterPrPayload(null, {}).groups, {});
  });

  await t.test(
    'ticket filters AND all fields and use historical sprint identity rather than the display sprint',
    () => {
      const result = filterTickets(tickets, {
        search: '[FIX].* <IMG> &',
        status: 'In Progress',
        sprint: '2',
        priority: 'High',
        type: 'Bug',
      });
      assert.deepEqual(
        result.map((item) => item.key),
        ['DEMO-1', 'DEMO-6'],
      );
      assert.deepEqual(
        filterTickets(tickets, { sprint: '1' }).map((item) => item.key),
        ['DEMO-1', 'DEMO-2', 'DEMO-3', 'DEMO-4'],
      );
      assert.deepEqual(
        filterTickets(tickets, { search: 'demo-3' }).map((item) => item.key),
        ['DEMO-3'],
      );
      assert.deepEqual(
        filterTickets(tickets, { status: 'To Do', priority: 'High', type: 'Bug' }).map(
          (item) => item.key,
        ),
        ['DEMO-4'],
      );
      assert.deepEqual(
        filterTickets(tickets, { search: 'in progress', priority: 'Low' }).map((item) => item.key),
        ['DEMO-2'],
      );
      assert.deepEqual(
        filterTickets(tickets, { search: 'task', priority: 'High' }).map((item) => item.key),
        ['DEMO-3'],
      );
      assert.deepEqual(
        filterTickets(tickets, { search: 'delivery', sprint: '3' }).map((item) => item.key),
        ['DEMO-5'],
      );
      assert.deepEqual(filterTickets(tickets, { search: '^Literal' }), []);
      assert.deepEqual(filterTickets(tickets, { sprint: 'missing' }), []);
      assert.deepEqual(filterTickets(tickets, {}), tickets);
      assert.deepEqual(filterTickets([], {}), []);
      assert.deepEqual(
        filterTickets([ticket('NAME-1', { sprint: { name: 'Named sprint' }, sprints: [] })], {
          sprint: 'Named sprint',
        }).map((item) => item.key),
        ['NAME-1'],
      );
    },
  );

  await t.test(
    'action tiers keep ordering and metadata and expose a lower tier before the row budget is spent',
    () => {
      const tiers = freezeTree([
        {
          id: 'changes-requested',
          reason: 'Changes requested',
          kind: 'pr',
          items: Array.from({ length: 13 }, (_, index) => pr(200 + index)),
        },
        { id: 'needs-approval', reason: 'Review', kind: 'pr', items: [teammate] },
        {
          id: 'in-progress',
          reason: 'Tickets in progress',
          kind: 'ticket',
          items: [tickets[0], tickets[1]],
        },
      ]);
      const before = structuredClone(tiers);
      const projected = filterActionTiers(tiers, { action: 'in-progress', search: 'DEMO-1' });
      assert.deepEqual(projected, [
        { id: 'changes-requested', reason: 'Changes requested', kind: 'pr', items: [] },
        { id: 'needs-approval', reason: 'Review', kind: 'pr', items: [] },
        { id: 'in-progress', reason: 'Tickets in progress', kind: 'ticket', items: [tickets[0]] },
      ]);
      const capped = capTiers(projected, 12);
      assert.deepEqual(
        capped.tiers[2].items.map((item) => item.key),
        ['DEMO-1'],
      );
      assert.equal(capped.hidden, 0);
      assert.deepEqual(
        filterActionTiers(tiers, { action: 'needs-approval', search: 'colleague' })[1].items.map(
          (item) => item.number,
        ),
        [107],
      );
      assert.deepEqual(
        filterActionTiers(tiers, { search: '^Literal' }).flatMap((tier) => tier.items),
        [],
      );
      assert.deepEqual(filterActionTiers(tiers, {}), tiers);
      assert.deepEqual(filterActionTiers([], {}), []);
      assert.deepEqual(tiers, before);
    },
  );
  assert.deepEqual(payload, originalPayload);
  assert.deepEqual(tickets, originalTickets);
});
