import test from 'node:test';
import assert from 'node:assert/strict';
import { boardColumns, ciSummaryText, reviewText } from '../ui/ticket-board.js';
import { jiraStatusKind } from '../ui/components/pr-card.js';

// Ranks inside each band, in workflow order (lower-cased names).
const RANKED = {
  attention: ['blocked', 'impediment', 'rejected', 'active incident', 'cs escalation'],
  queued: [
    'backlog',
    'parking lot',
    'needs definition',
    'needs grooming',
    'asynchronous grooming',
    'discovery',
    'open',
    'to do',
    'selected for development',
    'ready for scheduling',
    'scheduled',
    'assigned',
    'duplicate',
  ],
  active: [
    'in progress',
    'work in progress',
    'in development',
    'reopened',
    'pending',
    'ready for code review',
    'code review',
    'in review',
    'awaiting merge',
    'ready for testing',
    'testing in progress',
    'testing',
    'qa',
    'in remediation',
    'stakeholder sign off',
    'impact',
    'promote to uat',
    'ready for delivery',
    'delivery',
  ],
  done: [
    'hardening in uat',
    'ready for deployment',
    'deployed',
    'remediated',
    'resolved',
    'complete',
    'done',
    'closed',
  ],
};

const ticket = (key, status, statusCategory = 'To Do') => ({
  key,
  summary: `Summary of ${key}`,
  status,
  statusCategory,
});
const statuses = (columns) => columns.map((column) => column.status);

test('columns follow the workflow: attention, queued, active, review gates, then done', () => {
  const columns = boardColumns([
    ticket('TAP-1', 'Done', 'Done'),
    ticket('TAP-2', 'Code Review', 'In Progress'),
    ticket('TAP-3', 'To Do', 'To Do'),
    ticket('TAP-4', 'Blocked', 'In Progress'),
    ticket('TAP-5', 'In Progress', 'In Progress'),
    ticket('TAP-6', 'Custom Gate', 'In Progress'),
    ticket('TAP-7', 'Weird', 'To Do'),
  ]);
  assert.deepEqual(statuses(columns), [
    'Blocked',
    'To Do',
    'Weird',
    'In Progress',
    'Code Review',
    'Custom Gate',
    'Done',
  ]);
  for (const column of columns) {
    assert.equal(column.kind, jiraStatusKind(column.status), `${column.status} kind`);
    assert.ok(Array.isArray(column.tickets) && column.tickets.length === 1, column.status);
  }
});

test('a column holds its tickets in input order and empty statuses get no column', () => {
  const input = Object.freeze([
    Object.freeze(ticket('TAP-3', 'In Progress', 'In Progress')),
    Object.freeze(ticket('TAP-9', 'To Do')),
    Object.freeze(ticket('TAP-1', 'In Progress', 'In Progress')),
    Object.freeze(ticket('TAP-2', 'In Progress', 'In Progress')),
  ]);
  const columns = boardColumns(input);
  assert.deepEqual(statuses(columns), ['To Do', 'In Progress']);
  assert.deepEqual(
    columns[1].tickets.map((item) => item.key),
    ['TAP-3', 'TAP-1', 'TAP-2'],
  );
  assert.deepEqual(
    columns[0].tickets.map((item) => item.key),
    ['TAP-9'],
  );
  assert.deepEqual(boardColumns([]), []);
});

test('every ranked status lands in the documented order whatever the Jira category says', () => {
  const documented = Object.values(RANKED).flat();
  // Reversed input and a To Do category everywhere: the rank list decides, not
  // the input order and not the category (Jira files several active gates there).
  const input = [...documented]
    .reverse()
    .map((status, index) => ticket(`TAP-${index + 1}`, status, 'To Do'));
  assert.deepEqual(statuses(boardColumns(input)), documented);
});

test('the rank bands agree with the shared Jira status colour map', () => {
  for (const [band, names] of Object.entries(RANKED)) {
    for (const name of names) {
      // Code Review is ranked as active but stays neutral in the shared map on
      // purpose (changing it would recolour the PRs tab).
      if (name === 'code review') {
        assert.equal(jiraStatusKind(name), 'unknown');
        continue;
      }
      assert.equal(jiraStatusKind(name), band, `${name} is ranked in the ${band} band`);
    }
  }
  const columns = boardColumns(
    Object.values(RANKED)
      .flat()
      .map((status, index) => ticket(`TAP-${index + 1}`, status)),
  );
  for (const column of columns) assert.equal(column.kind, jiraStatusKind(column.status));
});

test('an unknown status joins its category band after the ranked ones, A to Z', () => {
  const columns = boardColumns([
    ticket('TAP-1', 'Zeta Gate', 'In Progress'),
    ticket('TAP-2', 'Done', 'Done'),
    ticket('TAP-3', 'Alpha Gate', 'In Progress'),
    ticket('TAP-4', 'Mystery', 'Done'),
    ticket('TAP-5', 'Triage', 'To Do'),
    ticket('TAP-6', 'Odd', 'Unknown'),
    ticket('TAP-7', 'Code Review', 'In Progress'),
    ticket('TAP-8', 'Open', 'To Do'),
    ticket('TAP-9', 'Blocked', 'In Progress'),
    ticket('TAP-10', 'Backlog', 'To Do'),
  ]);
  // Any category other than To Do and Done counts as active.
  assert.deepEqual(statuses(columns), [
    'Blocked',
    'Backlog',
    'Open',
    'Triage',
    'Code Review',
    'Alpha Gate',
    'Odd',
    'Zeta Gate',
    'Done',
    'Mystery',
  ]);
  for (const name of ['Triage', 'Alpha Gate', 'Odd', 'Mystery']) {
    assert.equal(columns.find((column) => column.status === name).kind, 'unknown', name);
  }
});

test('status ranks ignore letter case', () => {
  const columns = boardColumns([
    ticket('TAP-1', 'CODE REVIEW', 'In Progress'),
    ticket('TAP-2', 'in progress', 'In Progress'),
    ticket('TAP-3', 'BLOCKED', 'In Progress'),
  ]);
  assert.deepEqual(statuses(columns), ['BLOCKED', 'in progress', 'CODE REVIEW']);
  assert.equal(columns[1].kind, 'active');
});

test('ciSummaryText drops a count whose bucket is empty', () => {
  assert.equal(
    ciSummaryText({ state: 'failing', passed: 100, failed: 0, pending: 0, failing: [] }),
    'CI failing',
  );
  assert.equal(
    ciSummaryText({ state: 'pending', passed: 1, failed: 0, pending: 0, failing: [] }),
    'CI pending',
  );
  assert.equal(
    ciSummaryText({ state: 'passing', passed: 0, failed: 0, pending: 0, failing: [] }),
    'CI passing',
  );
});

test('ciSummaryText names the state with counts and at most three failing checks', () => {
  assert.equal(
    ciSummaryText({
      state: 'failing',
      passed: 7,
      failed: 2,
      pending: 0,
      failing: ['lint', 'unit-tests'],
    }),
    'CI failing: lint, unit-tests (2 of 9 failed)',
  );
  assert.equal(
    ciSummaryText({ state: 'passing', passed: 9, failed: 0, pending: 0, failing: [] }),
    'CI passing (9 of 9)',
  );
  assert.equal(
    ciSummaryText({ state: 'pending', passed: 6, failed: 0, pending: 3, failing: [] }),
    'CI pending (3 of 9 running)',
  );
  assert.equal(
    ciSummaryText({ state: 'none', passed: 0, failed: 0, pending: 0, failing: [] }),
    'No CI checks',
  );
  assert.equal(ciSummaryText(null), 'CI status unavailable');

  const many = ciSummaryText({
    state: 'failing',
    passed: 7,
    failed: 5,
    pending: 0,
    failing: ['alpha', 'bravo', 'charlie', 'delta', 'echo'],
  });
  assert.match(many, /^CI failing: alpha, bravo, charlie/);
  assert.match(many, /\+2 more/);
  assert.match(many, /\(5 of 12 failed\)/);
  assert.doesNotMatch(many, /delta|echo/);
});

test('reviewText says the review state in words and never throws on unreadable data', () => {
  assert.equal(reviewText({ state: 'approved', approvals: 2 }), 'approved');
  assert.equal(reviewText({ state: 'changes_requested', approvals: 0 }), 'changes requested');
  assert.equal(reviewText({ state: 'awaiting', approvals: 0 }), 'awaiting');
  assert.equal(typeof reviewText(null), 'string');
});
