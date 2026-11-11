import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allPrsApproved,
  boardColumns,
  ciSummaryText,
  commentChips,
  commentSummaryText,
  reviewText,
} from '../ui/ticket-board.js';
import { jiraStatusKind } from '../ui/jira-status.js';
import { deepFreeze } from '../e2e/deep-freeze.mjs';

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

// -- a card is all-approved only when every one of its open PRs reads approved ------------------------

const reviewed = (state, extra = {}) => ({
  repo: 'ExampleOrg/example-app',
  number: 1,
  draft: false,
  review: state === null ? null : { state, approvals: state === 'approved' ? 1 : 0 },
  ...extra,
});
const APPROVED = reviewed('approved');

test('allPrsApproved follows the truth table: at least one PR and every one approved', () => {
  const table = [
    ['no PRs', [], false],
    ['one approved', [APPROVED], true],
    ['approved and awaiting', [APPROVED, reviewed('awaiting')], false],
    ['approved and changes requested', [APPROVED, reviewed('changes_requested')], false],
    ['approved and an unreadable review', [APPROVED, reviewed(null)], false],
    ['an approved draft alone', [reviewed('approved', { draft: true })], true],
    [
      'an approved draft and an approved PR',
      [reviewed('approved', { draft: true }), APPROVED],
      true,
    ],
    [
      'twelve approved',
      Array.from({ length: 12 }, (_, i) => reviewed('approved', { number: i + 1 })),
      true,
    ],
    ['one awaiting', [reviewed('awaiting')], false],
    ['one changes requested', [reviewed('changes_requested')], false],
    ['one unreadable review', [reviewed(null)], false],
    [
      'one approved among eleven awaiting',
      [APPROVED, ...Array.from({ length: 11 }, () => reviewed('awaiting'))],
      false,
    ],
  ];
  for (const [name, prs, expected] of table) {
    assert.equal(allPrsApproved(prs), expected, name);
  }
});

// A change request outranks approvals: the backend reports a PR with a standing change request as
// `changes_requested` whatever other reviewers said, and the card then stays plain however many of
// its other PRs are approved.
test('allPrsApproved is false while any one PR reads changes requested, wherever it sits among approved PRs', () => {
  const changes = reviewed('changes_requested');
  assert.equal(allPrsApproved([APPROVED, APPROVED, APPROVED]), true, 'the same list without it');
  const lists = {
    first: [changes, APPROVED, APPROVED],
    middle: [APPROVED, changes, APPROVED],
    last: [APPROVED, APPROVED, changes],
    'a draft that has it': [APPROVED, reviewed('changes_requested', { draft: true })],
  };
  for (const [name, prs] of Object.entries(lists)) {
    assert.equal(allPrsApproved(prs), false, name);
  }
});

test('allPrsApproved never reads a draft as less approved, and a draft is not approved by being a draft', () => {
  assert.equal(allPrsApproved([reviewed('awaiting', { draft: true })]), false);
  assert.equal(
    allPrsApproved([reviewed('approved', { draft: true }), reviewed('awaiting', { draft: true })]),
    false,
  );
});

test('allPrsApproved answers false for anything that is not a list of reviewed PRs, and never throws', () => {
  for (const input of [undefined, null]) assert.equal(allPrsApproved(input), false, String(input));
  assert.equal(
    allPrsApproved([{ repo: 'ExampleOrg/example-app', number: 1 }]),
    false,
    'a PR without a review',
  );
  assert.equal(
    allPrsApproved([{ review: { state: 'unknown-state' } }]),
    false,
    'an unrecognised state',
  );
});

test('allPrsApproved is a pure yes or no: it answers a boolean and leaves its input alone', () => {
  const input = Object.freeze([
    Object.freeze(reviewed('approved')),
    Object.freeze(reviewed('approved')),
  ]);
  assert.strictEqual(allPrsApproved(input), true);
  assert.strictEqual(allPrsApproved(Object.freeze([])), false);
  assert.deepEqual(input, [reviewed('approved'), reviewed('approved')]);
});

// -- the comment chips and the words that name them ----------------------------------------------------

const bucket = (threads = 0, unresolved = 0, comments = 0) => ({ threads, unresolved, comments });
const commentsOf = (overrides = {}) => ({
  human: bucket(),
  copilot: bucket(),
  other: bucket(),
  conversation: 0,
  threads: 0,
  truncated: false,
  ...overrides,
});
// What a chip draws: its author's glyph, its state and its count. Its words (`summary`) have their
// own tests.
const shown = (chip) => ({ author: chip.author, state: chip.state, text: chip.text });

const HUMAN_ONLY = commentsOf({ human: bucket(5, 2, 9), threads: 5 });
const COPILOT_RESOLVED = commentsOf({ copilot: bucket(4, 0, 6), threads: 4 });
const BOTH = commentsOf({ human: bucket(3, 1, 5), copilot: bucket(2, 2, 4), threads: 5 });
const ALL_RESOLVED = commentsOf({ human: bucket(3, 0, 4), copilot: bucket(2, 0, 3), threads: 5 });
const OTHER_BOT = commentsOf({ other: bucket(1, 1, 2), threads: 1 });
const CONVERSATION_ONLY = commentsOf({ conversation: 3 });
const TRUNCATED = commentsOf({ human: bucket(50, 3, 61), threads: 63, truncated: true });
const TRUNCATED_BOTH = commentsOf({
  human: bucket(30, 2, 40),
  copilot: bucket(20, 0, 25),
  threads: 63,
  truncated: true,
});

test('commentChips draws one chip per author with threads: unresolved over total while any is open', () => {
  assert.deepEqual(commentChips(HUMAN_ONLY).map(shown), [
    { author: 'human', state: 'open', text: '2/5' },
  ]);
  assert.deepEqual(commentChips(commentsOf({ copilot: bucket(2, 2, 4), threads: 2 })).map(shown), [
    { author: 'copilot', state: 'open', text: '2/2' },
  ]);
});

test('commentChips reads all resolved as the resolved state with the thread total alone', () => {
  assert.deepEqual(commentChips(COPILOT_RESOLVED).map(shown), [
    {
      author: 'copilot',
      state: 'resolved',
      text: '4',
    },
  ]);
  assert.deepEqual(commentChips(ALL_RESOLVED).map(shown), [
    { author: 'human', state: 'resolved', text: '3' },
    {
      author: 'copilot',
      state: 'resolved',
      text: '2',
    },
  ]);
});

test('commentChips puts the human chip before the Copilot chip whatever order the fields arrive in', () => {
  const reversed = {
    copilot: BOTH.copilot,
    human: BOTH.human,
    other: BOTH.other,
    conversation: 0,
    threads: 5,
    truncated: false,
  };
  for (const input of [BOTH, reversed]) {
    assert.deepEqual(
      commentChips(input).map((chip) => chip.author),
      ['human', 'copilot'],
    );
  }
  assert.deepEqual(commentChips(BOTH).map(shown), [
    { author: 'human', state: 'open', text: '1/3' },
    { author: 'copilot', state: 'open', text: '2/2' },
  ]);
});

test('commentChips draws no chip for an author with no threads, and none for other bots or conversation comments', () => {
  assert.deepEqual(commentChips(commentsOf()), [], 'nothing at all');
  assert.deepEqual(commentChips(OTHER_BOT), [], 'a thread started by another bot has no chip');
  assert.deepEqual(commentChips(CONVERSATION_ONLY), [], 'conversation comments have no chip');
  assert.deepEqual(
    commentChips(HUMAN_ONLY).map((chip) => chip.author),
    ['human'],
    'the author without threads is left out',
  );
});

test('commentChips draws nothing for unknown comments (null or missing) and never throws', () => {
  assert.deepEqual(commentChips(null), []);
  assert.deepEqual(commentChips(undefined), []);
});

test('commentChips marks a cut-off list with a plus and never says resolved', () => {
  assert.deepEqual(commentChips(TRUNCATED).map(shown), [
    { author: 'human', state: 'open', text: '3/50+' },
  ]);
  const [human, copilot] = commentChips(TRUNCATED_BOTH);
  assert.equal(human.text, '2/30+');
  assert.equal(human.state, 'open');
  assert.equal(copilot.text, '0/20+', 'nothing read is open, but the unread threads may be');
  assert.notEqual(copilot.state, 'resolved', 'a cut-off list is never all resolved');
  assert.ok(commentChips(TRUNCATED_BOTH).every((chip) => chip.text.endsWith('+')));
});

test('commentChips names each chip in words and leaves its input alone', () => {
  const [human] = commentChips(HUMAN_ONLY);
  assert.equal(human.summary, 'Human: 2 unresolved, 3 resolved, 9 comments');
  const [copilot] = commentChips(COPILOT_RESOLVED);
  assert.equal(copilot.summary, 'Copilot: 0 unresolved, 4 resolved, 6 comments');
  for (const input of [BOTH, TRUNCATED, TRUNCATED_BOTH, commentsOf()]) {
    const frozen = deepFreeze(structuredClone(input));
    commentChips(frozen);
    assert.deepEqual(frozen, input);
  }
});

test('commentSummaryText says each author in words: unresolved, resolved and comments', () => {
  assert.equal(commentSummaryText(HUMAN_ONLY), 'Human: 2 unresolved, 3 resolved, 9 comments');
  assert.match(
    commentSummaryText(COPILOT_RESOLVED),
    /Copilot: 0 unresolved, 4 resolved, 6 comments/,
  );
  const both = commentSummaryText(BOTH);
  assert.match(both, /Human: 1 unresolved, 2 resolved, 5 comments/);
  assert.match(both, /Copilot: 2 unresolved, 0 resolved, 4 comments/);
  assert.ok(both.indexOf('Human') < both.indexOf('Copilot'), 'human first');
});

test('commentSummaryText names conversation comments and other-bot threads, which have no chip', () => {
  assert.match(commentSummaryText(OTHER_BOT), /Other: 1 unresolved, 0 resolved, 2 comments/);
  assert.match(commentSummaryText(CONVERSATION_ONLY), /Conversation: 3 comments/);
  const all = commentSummaryText(
    commentsOf({ human: bucket(5, 2, 9), other: bucket(1, 1, 2), conversation: 3, threads: 6 }),
  );
  for (const part of [
    /Human: 2 unresolved, 3 resolved, 9 comments/,
    /Other: 1 unresolved, 0 resolved, 2 comments/,
    /Conversation: 3 comments/,
  ]) {
    assert.match(all, part);
  }
});

test('commentSummaryText says when only the first threads were read', () => {
  const text = commentSummaryText(TRUNCATED);
  assert.match(text, /showing the first 50 of 63 threads/);
  assert.match(text, /Human: 3 unresolved, 47 resolved, 61 comments/);
  assert.doesNotMatch(commentSummaryText(HUMAN_ONLY), /showing the first/);
  assert.match(commentSummaryText(TRUNCATED_BOTH), /showing the first 50 of 63 threads/);
});

test('comment counts read "1 comment" for one and plural for zero or more than one', () => {
  const one = commentsOf({ human: bucket(1, 0, 1), threads: 1, conversation: 1 });
  assert.equal(commentChips(one)[0].summary, 'Human: 0 unresolved, 1 resolved, 1 comment');
  assert.equal(
    commentSummaryText(one),
    'Human: 0 unresolved, 1 resolved, 1 comment; Conversation: 1 comment',
  );
  const plural = commentsOf({ human: bucket(2, 1, 2), other: bucket(1, 0, 0), conversation: 2 });
  assert.equal(commentChips(plural)[0].summary, 'Human: 1 unresolved, 1 resolved, 2 comments');
  assert.equal(
    commentSummaryText(plural),
    'Human: 1 unresolved, 1 resolved, 2 comments; Other: 0 unresolved, 1 resolved, 0 comments; Conversation: 2 comments',
  );
});

test('commentSummaryText says comments are unavailable for null, and stays quiet when there is nothing to say', () => {
  assert.equal(commentSummaryText(null), 'comments unavailable');
  // A PR that arrives without the field reads as unknown, not as zero comments, and never throws.
  assert.equal(commentSummaryText(undefined), 'comments unavailable');
  const none = commentSummaryText(commentsOf());
  assert.equal(typeof none, 'string');
  assert.doesNotMatch(none, /unavailable|Human|Copilot|Other|Conversation/);
  for (const input of [HUMAN_ONLY, OTHER_BOT, TRUNCATED]) {
    const frozen = deepFreeze(structuredClone(input));
    commentSummaryText(frozen);
    assert.deepEqual(frozen, input);
  }
});
