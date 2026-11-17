// slack-ticket-links.test.mjs — Slack threads to ticket keys: any key on the subject line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildThread } from '../backend/slack-model.mjs';
import {
  canonicalTicketKey,
  normalizeTicketKey,
  threadTicketKeys,
  threadsByTicket,
} from '../ui/slack-ticket-links.js';

const URL = 'https://app.slack.com/client/T1/C1/thread/C1-1793192214.548389';

function thread(overrides = {}) {
  return {
    ts: '1793192214.548389',
    url: URL,
    text: 'TAP-1765: CS migration pre-check',
    replyCount: 0,
    activityAt: '2026-10-29T08:43:00.000Z',
    needsReply: false,
    author: { id: 'U1', name: 'You' },
    ...overrides,
  };
}

function freezeTree(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeTree);
    Object.freeze(value);
  }
  return value;
}

test('keys normalise to the renamed TAP project and reject everything else', () => {
  assert.equal(normalizeTicketKey('TAP-2254'), 'TAP-2254');
  assert.equal(normalizeTicketKey('TRIPS-1877'), 'TAP-1877');
  assert.equal(normalizeTicketKey('tap-9'), 'TAP-9');
  assert.equal(normalizeTicketKey('trips-9'), 'TAP-9');
  assert.equal(normalizeTicketKey('  TAP-2254  '), 'TAP-2254');
  assert.equal(normalizeTicketKey('\tTRIPS-1877\n'), 'TAP-1877');
  assert.equal(normalizeTicketKey('ABC-1'), '');
  assert.equal(normalizeTicketKey('2254'), '');
  assert.equal(normalizeTicketKey(''), '');
  assert.equal(normalizeTicketKey('   '), '');
  assert.equal(normalizeTicketKey('TAP'), '');
  assert.equal(normalizeTicketKey('TAP-'), '');
  assert.equal(normalizeTicketKey('TAP-2254x'), '');
  assert.equal(normalizeTicketKey(null), '');
  assert.equal(normalizeTicketKey(undefined), '');
  assert.equal(normalizeTicketKey(2254), '');
});

test('canonical keys fold TRIPS onto TAP and keep every other project key as typed', () => {
  assert.equal(canonicalTicketKey('TAP-12'), 'TAP-12');
  assert.equal(canonicalTicketKey('TRIPS-12'), 'TAP-12');
  assert.equal(canonicalTicketKey('PRT-1543'), 'PRT-1543');
  assert.equal(canonicalTicketKey('  PRT-1543  '), 'PRT-1543');
  assert.equal(canonicalTicketKey(null), '');
  assert.equal(canonicalTicketKey(undefined), '');
  assert.equal(canonicalTicketKey(1543), '');
});

const keysOf = (subjectText) => threadTicketKeys({ subjectText });

test('every ticket key on the subject line names the thread, wherever it sits', () => {
  assert.deepEqual(keysOf('TAP-1765: CS migration pre-check'), ['TAP-1765']);
  assert.deepEqual(keysOf('  TAP-1765: CS migration pre-check'), ['TAP-1765']);
  assert.deepEqual(keysOf('TRIPS-2165: trips spelling'), ['TAP-2165']);
  assert.deepEqual(keysOf('tap-9: lower case'), ['TAP-9']);
  assert.deepEqual(keysOf('Trips-9: mixed case'), ['TAP-9']);
  assert.deepEqual(keysOf('TAP-1765'), ['TAP-1765']);
  assert.deepEqual(keysOf('a note about TAP-1765'), ['TAP-1765']);
  assert.deepEqual(keysOf('follow-up to TAP-1765 from yesterday'), ['TAP-1765']);
  assert.deepEqual(keysOf("TAP-2001's test PRs are not blocked"), ['TAP-2001']);
  assert.deepEqual(keysOf('TAP-1, TAP-2 fix'), ['TAP-1', 'TAP-2']);
  assert.deepEqual(keysOf('TAP-2201 is complete; TAP-2203, TAP-2250 and TAP-1500 are reopened'), [
    'TAP-2201',
    'TAP-2203',
    'TAP-2250',
    'TAP-1500',
  ]);
  assert.deepEqual(keysOf('TAP-1 and TRIPS-1 and tap-1'), ['TAP-1']);
});

test('slack formatting around a key does not hide it', () => {
  for (const subject of [
    '_TAP-123: italic_',
    '*TAP-123: bold*',
    '~TAP-123~ struck',
    '`TAP-123` code',
    ':memo: TAP-123: emoji first',
    '[TAP-123] brackets',
    '(TAP-123) parentheses',
    '> TAP-123 quoted',
    '• TAP-123 bullet',
    'Spec: TAP-123 label first',
    '_Spec and plan: TAP-123 italic label_ Draft PR',
    '@Someone TAP-123 mention first',
    'TAP 123: a space for the hyphen',
    'TAP‑123: non-breaking hyphen',
    '​TAP-123: zero-width space',
    'ＴＡＰ－123: full-width letters',
    'https://pathwise.atlassian.net/browse/TAP-123 a bare link',
    'TAP-123 (pathwise.atlassian.net/browse/TAP-123): link repeats the key',
  ]) {
    assert.deepEqual(keysOf(subject), ['TAP-123'], subject);
  }
});

test('text that only looks like a key names nothing', () => {
  for (const subject of [
    'STAP-123: glued to a letter',
    'laptap-123 and wiretap-5',
    'TAP-123abc: not a key',
    'TAP-: no number',
    'TAP: no number',
    'TAP123: no hyphen',
    'ABC-1: other project',
    'EZAT-123: other project',
    'PR #123 and a tap dance',
    'no ticket here',
    '',
    '   ',
  ]) {
    assert.deepEqual(keysOf(subject), [], subject);
  }
  assert.deepEqual(keysOf('TAP-1234: a longer number is not a shorter one'), ['TAP-1234']);
  for (const value of [null, undefined, 1765, {}]) assert.deepEqual(keysOf(value), []);
  assert.deepEqual(threadTicketKeys(null), []);
  assert.deepEqual(threadTicketKeys(undefined), []);
  assert.deepEqual(threadTicketKeys({}), []);
});

test('a row with only its text is read on its first non-empty line', () => {
  assert.deepEqual(threadTicketKeys({ text: 'TAP-1: first line\nTAP-2: second line' }), ['TAP-1']);
  assert.deepEqual(threadTicketKeys({ text: '\n\r\n  \nSpec: TAP-3 after blank lines\nTAP-4' }), [
    'TAP-3',
  ]);
  assert.deepEqual(threadTicketKeys({ text: 'no key TAP-5 on a Unicode line' }), []);
  assert.deepEqual(threadTicketKeys({ text: 7 }), []);
});

test('threads group under their ticket with the newest activity first', () => {
  const older = thread({
    ts: '1',
    text: 'TRIPS-1877: old spelling',
    activityAt: '2026-10-20T10:00:00.000Z',
  });
  const blankActivity = thread({ ts: '2', text: 'TAP-1877: blank activity', activityAt: '' });
  const newest = thread({
    ts: '3',
    text: 'TAP-1877: new spelling',
    activityAt: '2026-10-28T09:00:00.000Z',
  });
  const tie = thread({
    ts: '4',
    text: 'TAP-1877: same instant as the newest',
    activityAt: '2026-10-28T09:00:00.000Z',
  });
  const missingActivity = thread({
    ts: '5',
    text: 'TAP-1877: no activity field',
    activityAt: undefined,
  });
  const middle = thread({
    ts: '6',
    text: 'TAP-1877: between the two spellings',
    activityAt: '2026-10-22T09:00:00.000Z',
  });
  const badActivity = thread({ ts: '7', text: 'TAP-1877: unparseable', activityAt: 'yesterday' });
  const other = thread({
    ts: '8',
    text: 'TAP-9: unrelated ticket',
    activityAt: '2026-10-01T00:00:00.000Z',
  });
  const started = freezeTree([
    older,
    blankActivity,
    newest,
    tie,
    missingActivity,
    middle,
    badActivity,
    other,
  ]);
  const snapshot = structuredClone(started);

  const grouped = threadsByTicket(started);
  assert.ok(grouped instanceof Map);
  // One entry per ticket, keyed by the normalised spelling so the TRIPS thread
  // and the TAP thread above land together.
  assert.deepEqual([...grouped.keys()], ['TAP-1877', 'TAP-9']);
  assert.equal(grouped.has('TRIPS-1877'), false);
  assert.deepEqual(grouped.get('TAP-1877'), [
    newest,
    tie,
    middle,
    older,
    blankActivity,
    missingActivity,
    badActivity,
  ]);
  assert.deepEqual(grouped.get('TAP-9'), [other]);
  assert.deepEqual(started, snapshot);
});

test('threads without a key or without a link never join a ticket', () => {
  const started = freezeTree([
    thread({ ts: '1', text: 'note: nothing about a ticket came up in standup' }),
    thread({ ts: '2', text: 'TAP-1765: empty link', url: '' }),
    thread({ ts: '3', text: 'TAP-1765: null link', url: null }),
    thread({ ts: '4', text: 'TAP-1765: missing link', url: undefined }),
    thread({ ts: '5', text: '' }),
    thread({ ts: '6', text: null }),
    null,
    undefined,
  ]);
  const snapshot = structuredClone(started);

  assert.equal(threadsByTicket(started).size, 0);
  assert.deepEqual(started, snapshot);
});

test('missing or non-array input yields an empty Map', () => {
  for (const input of [undefined, null, {}, '', 0, 'TAP-1765: text']) {
    const grouped = threadsByTicket(input);
    assert.ok(grouped instanceof Map);
    assert.equal(grouped.size, 0);
  }
  assert.equal(threadsByTicket().size, 0);
  assert.equal(threadsByTicket([]).size, 0);
});

function syntheticKey(project, suffix) {
  return `${project}-${'9'.repeat(30)}${suffix}`;
}

test('one shared thread links to all four listed tickets, including renamed aliases', () => {
  const listed = [
    syntheticKey('trips', 1),
    syntheticKey('TAP', 2),
    syntheticKey('Trips', 3),
    syntheticKey('tap', 4),
  ];
  const expected = [1, 2, 3, 4].map((suffix) => syntheticKey('TAP', suffix));
  const subjectText = ` \t${listed.join(', ')}: Shared work`;
  const shared = thread({ text: subjectText, subjectText });

  assert.deepEqual(threadTicketKeys(shared), expected);
  assert.deepEqual(
    [...threadsByTicket([shared])],
    expected.map((key) => [key, [shared]]),
  );
});

test('repeated leading tickets and their aliases link a thread only once per ticket', () => {
  const first = syntheticKey('TAP', 1);
  const second = syntheticKey('TAP', 2);
  const listed = [
    first,
    syntheticKey('TRIPS', 1),
    syntheticKey('tap', 1),
    syntheticKey('trips', 2),
    second,
  ];
  const subjectText = `${listed.join(', ')}: Shared work`;
  const shared = thread({ text: subjectText, subjectText });

  assert.deepEqual(
    [...threadsByTicket([shared])],
    [
      [first, [shared]],
      [second, [shared]],
    ],
  );
});

test('a ticket named later on the subject line links the thread like a leading one', () => {
  const first = syntheticKey('TAP', 1);
  const second = syntheticKey('TAP', 2);
  const mentionedLater = syntheticKey('TAP', 3);
  const subjectText = `${first}, ${second}: Discussing ${mentionedLater}`;
  const unrelatedText = `Update: ${first}, ${second}`;
  const shared = thread({ text: subjectText, subjectText });
  const unrelated = thread({ text: unrelatedText, subjectText: unrelatedText });
  const grouped = threadsByTicket([shared, unrelated]);

  assert.deepEqual(grouped.get(first), [shared, unrelated]);
  assert.deepEqual(grouped.get(second), [shared, unrelated]);
  assert.deepEqual(grouped.get(mentionedLater), [shared]);
});

test('shared threads retain newest-first ordering and stable ties for every ticket', () => {
  const first = syntheticKey('TAP', 1);
  const second = syntheticKey('TAP', 2);
  const subjectText = `${first}, ${second}: Shared work`;
  const shared = thread({
    ts: 'shared',
    text: subjectText,
    subjectText,
    activityAt: '2026-10-22T09:00:00.000Z',
  });
  const newest = thread({
    ts: 'newest',
    text: `${first}: Newest`,
    activityAt: '2026-10-28T09:00:00.000Z',
  });
  const firstTie = thread({
    ts: 'first-tie',
    text: `${first}: Same activity as shared`,
    activityAt: '2026-10-22T09:00:00.000Z',
  });
  const secondTie = thread({
    ts: 'second-tie',
    text: `${second}: Same activity as shared`,
    activityAt: '2026-10-22T09:00:00.000Z',
  });
  const older = thread({
    ts: 'older',
    text: `${second}: Older`,
    activityAt: '2026-10-20T09:00:00.000Z',
  });
  const unknown = thread({ ts: 'unknown', text: `${second}: Unknown activity`, activityAt: '' });
  const started = freezeTree([unknown, older, shared, firstTie, secondTie, newest]);
  const snapshot = structuredClone(started);
  const grouped = threadsByTicket(started);

  assert.deepEqual(grouped.get(first), [newest, shared, firstTie]);
  assert.deepEqual(started, snapshot);
  assert.deepEqual(grouped.get(second), [shared, secondTie, older, unknown]);
});

test('shared threads without a link do not join any listed ticket', () => {
  const listed = [1, 2, 3, 4].map((suffix) => syntheticKey('TAP', suffix));
  const subjectText = `${listed.join(', ')}: Shared work`;
  const started = freezeTree(
    ['', null, undefined].map((url) => thread({ text: subjectText, subjectText, url })),
  );
  const snapshot = structuredClone(started);

  assert.deepEqual([...threadsByTicket(started)], []);
  assert.deepEqual(started, snapshot);
});

test('keys of other projects on the subject line are skipped, the rest still link', () => {
  const first = syntheticKey('TAP', 1);
  const second = syntheticKey('TAP', 2);
  const otherProject = syntheticKey('OTHER', 3);
  const mentionedLater = syntheticKey('TAP', 4);
  const subjectText = `${first}, ${otherProject}, ${syntheticKey('TRIPS', 2)}: About ${mentionedLater}`;
  const unrelatedText = `${otherProject}, ${first}, ${second}: Different project`;
  const shared = thread({ text: subjectText, subjectText });
  const unrelated = thread({ text: unrelatedText, subjectText: unrelatedText });

  assert.deepEqual(
    [...threadsByTicket([shared, unrelated])],
    [
      [first, [shared, unrelated]],
      [second, [shared, unrelated]],
      [mentionedLater, [shared]],
    ],
  );
});

test('a cached thread without a subject links every key on its first line', () => {
  const first = syntheticKey('TAP', 1);
  const second = syntheticKey('TAP', 2);
  const later = syntheticKey('TAP', 3);
  const cached = thread({
    text: `${syntheticKey('TRIPS', 1)}, ${second}: First line\n${later}: Second line`,
  });

  assert.deepEqual(
    [...threadsByTicket([cached])],
    [
      [first, [cached]],
      [second, [cached]],
    ],
  );
});

test('matching uses the preserved subject instead of a different flattened text', () => {
  const first = syntheticKey('TAP', 1);
  const second = syntheticKey('TAP', 2);
  const unrelated = syntheticKey('TAP', 3);
  const subjectText = `${first}, ${second}: Shared work`;
  const shared = thread({ subjectText, text: `${unrelated}: Different text` });

  assert.deepEqual(
    [...threadsByTicket([shared])],
    [
      [first, [shared]],
      [second, [shared]],
    ],
  );
});

test('a present but empty subject does not fall back to flattened text', () => {
  const first = syntheticKey('TAP', 1);
  const second = syntheticKey('TAP', 2);
  const row = thread({ subjectText: '', text: `${first}, ${second}: Mention text` });

  assert.deepEqual([...threadsByTicket([row])], []);
});

test('a built thread matches every first-line key but not a comma-led later paragraph', () => {
  const first = syntheticKey('TAP', 1);
  const second = syntheticKey('TAP', 2);
  const later = syntheticKey('TAP', 3);
  const subjectText = `${first}, ${syntheticKey('TRIPS', 2)}`;
  const built = buildThread({
    root: {
      ts: '100.0001',
      user: 'U1',
      text: `*${subjectText}*\n\n, ${later}: Later paragraph`,
    },
    channelId: 'C1',
    teamId: 'T1',
    me: 'U1',
    users: {},
  });

  assert.equal(built.text, `${subjectText} , ${later}: Later paragraph`);
  assert.deepEqual(
    [...threadsByTicket([built])],
    [
      [first, [built]],
      [second, [built]],
    ],
  );
  assert.equal(built.subjectText, subjectText);
});

test('a built thread does not match a later paragraph following a trailing subject comma', () => {
  const first = syntheticKey('TAP', 1);
  const later = syntheticKey('TAP', 2);
  const subjectText = `${first},`;
  const built = buildThread({
    root: { ts: '100.0001', user: 'U1', text: `${subjectText}\n\n${later}: Later paragraph` },
    channelId: 'C1',
    teamId: 'T1',
    me: 'U1',
    users: {},
  });

  assert.equal(built.text, `${subjectText} ${later}: Later paragraph`);
  assert.deepEqual([...threadsByTicket([built])], [[first, [built]]]);
  assert.equal(built.subjectText, subjectText);
});

for (const [name, separator] of [
  ['line separator', '\u2028'],
  ['paragraph separator', '\u2029'],
]) {
  test(`a later comma-led ticket after a Unicode ${name} is not linked`, () => {
    const first = syntheticKey('TAP', 1);
    const second = syntheticKey('TAP', 2);
    const later = syntheticKey('TAP', 3);
    const subjectText = `${first}, ${syntheticKey('TRIPS', 2)}`;
    const built = buildThread({
      root: {
        ts: '100.0001',
        user: 'U1',
        text: `${subjectText}${separator}, ${later}: Later details`,
      },
      channelId: 'C1',
      teamId: 'T1',
      me: 'U1',
      users: {},
    });

    assert.equal(built.text, `${subjectText} , ${later}: Later details`);
    assert.deepEqual(
      [...threadsByTicket([built])],
      [
        [first, [built]],
        [second, [built]],
      ],
    );
    assert.equal(built.subjectText, subjectText);
  });
}
