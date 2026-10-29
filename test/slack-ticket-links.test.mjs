// slack-ticket-links.test.mjs — "<KEY>: <subject>" threads to ticket keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTicketKey,
  threadsByTicket,
  ticketKeyFromThread,
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

test('only a key that starts the thread text names the thread', () => {
  assert.equal(ticketKeyFromThread('TAP-1765: CS migration pre-check'), 'TAP-1765');
  assert.equal(ticketKeyFromThread('  TAP-1765: CS migration pre-check'), 'TAP-1765');
  assert.equal(ticketKeyFromThread('\n\tTAP-1765 no subject'), 'TAP-1765');
  assert.equal(ticketKeyFromThread('TRIPS-2165: trips spelling'), 'TAP-2165');
  assert.equal(ticketKeyFromThread('tap-9: lower case'), 'TAP-9');
  assert.equal(ticketKeyFromThread('Trips-9: mixed case'), 'TAP-9');
  assert.equal(ticketKeyFromThread('TAP-1765'), 'TAP-1765');
  assert.equal(ticketKeyFromThread('a note about TAP-1765'), '');
  assert.equal(ticketKeyFromThread('follow-up to TAP-1765 from yesterday'), '');
  assert.equal(ticketKeyFromThread('X-TAP-1765: prefixed'), '');
  assert.equal(ticketKeyFromThread('TicketsTAP-1765'), '');
  assert.equal(ticketKeyFromThread('TAP-1765abc: not a key'), '');
  assert.equal(ticketKeyFromThread('ABC-1: other project'), '');
  assert.equal(ticketKeyFromThread('no ticket here'), '');
  assert.equal(ticketKeyFromThread(''), '');
  assert.equal(ticketKeyFromThread('   '), '');
  assert.equal(ticketKeyFromThread(null), '');
  assert.equal(ticketKeyFromThread(undefined), '');
  assert.equal(ticketKeyFromThread(1765), '');
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

test('threads without a leading key or without a link never join a ticket', () => {
  const started = freezeTree([
    thread({ ts: '1', text: 'note: TAP-1765 came up in standup' }),
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
