import test from 'node:test';
import assert from 'node:assert/strict';
import { ticketFromQuery, ticketFromText, ticketHref } from '../ui/ticket-link.js';

test('ticketFromQuery accepts a ticket-shaped key, any case, and returns it upper-cased', () => {
  assert.equal(ticketFromQuery('ticket=TAP-9001'), 'TAP-9001');
  assert.equal(ticketFromQuery('ticket=tap-9001'), 'TAP-9001');
  assert.equal(ticketFromQuery('view=list&ticket=DEMO-12'), 'DEMO-12');
  assert.equal(ticketFromQuery('ticket=A1-7'), 'A1-7');
});

test('ticketFromQuery ignores anything that is not a key', () => {
  for (const query of [
    '',
    undefined,
    'ticket=',
    'ticket=not-a-key',
    'ticket=TAP-',
    'ticket=TAP-9001;x',
    'ticket=TAP-9001%20x',
    'ticket=1TAP-9',
    'session=TAP-9001',
  ]) {
    assert.equal(ticketFromQuery(query), null, String(query));
  }
});

test('ticketFromText reads a whole typed key, trimmed, case-insensitively', () => {
  assert.equal(ticketFromText(' tap-9001 '), 'TAP-9001');
  assert.equal(ticketFromText('TAP-9001 done'), null);
  assert.equal(ticketFromText('tap'), null);
  assert.equal(ticketFromText(undefined), null);
});

test('ticketHref builds the My Tickets address for a key', () => {
  assert.equal(ticketHref('TAP-9001'), '#/my-tickets?ticket=TAP-9001');
});
