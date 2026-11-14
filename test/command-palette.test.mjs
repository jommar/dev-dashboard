import test from 'node:test';
import assert from 'node:assert/strict';
import { filterEntries, paletteEntries, tabLabelWithChord } from '../ui/command-palette.js';

const TABS = [
  { id: 'home', label: 'Home' },
  { id: 'my-tickets', label: 'My Tickets' },
  { id: 'releases', label: 'Releases' },
  { id: 'chat', label: 'Chat' },
];
const GROUPS = [
  {
    state: 'working',
    title: 'Working',
    rows: [
      {
        key: 'BOT-1:implement',
        ticket: 'BOT-1',
        phase: 'implement',
        state: 'working',
        reason: 'running',
      },
      {
        key: '5b0c7e3a-2d41-4c8e-9f16-0a7d3b9e4c21:chat',
        ticket: 'chat-5b0c7e3a',
        phase: 'chat',
        title: 'Plan the export',
        state: 'working',
        reason: null,
      },
    ],
  },
];
const entries = (more = {}) =>
  paletteEntries({ tabs: TABS, groups: GROUPS, active: 'home', refresh: null, query: '', ...more });
const ids = (list) => list.map(({ id }) => id);

test('entries: Go to every tab with its chord, then sessions, then New chat', () => {
  const list = entries();
  assert.deepEqual(ids(list), [
    'tab-home',
    'tab-my-tickets',
    'tab-releases',
    'tab-chat',
    'session-BOT-1:implement',
    'session-5b0c7e3a-2d41-4c8e-9f16-0a7d3b9e4c21:chat',
    'new-chat',
  ]);
  const tab = list.find(({ id }) => id === 'tab-my-tickets');
  assert.equal(tab.name, 'Go to My Tickets');
  assert.equal(tab.hint, 'g t');
  assert.deepEqual(tab.action, { type: 'tab', id: 'my-tickets' });
});

test('session entries are named like the drawer rows and carry what openBot needs', () => {
  const list = entries();
  const ticket = list.find(({ id }) => id === 'session-BOT-1:implement');
  assert.equal(ticket.name, 'Open BOT-1 Implement plan session');
  assert.deepEqual(ticket.action, { type: 'session', ticket: 'BOT-1', phase: 'implement' });
  const chat = list.find(({ id }) => id.endsWith(':chat'));
  assert.equal(chat.name, 'Open Plan the export Chat session');
  assert.deepEqual(chat.action, { type: 'session', ticket: 'chat-5b0c7e3a', phase: 'chat' });
});

test('New chat and the active board refresh are actions; refresh only when the screen has one', () => {
  assert.deepEqual(entries().find(({ id }) => id === 'new-chat').action, { type: 'new-chat' });
  assert.equal(
    entries().some(({ id }) => id === 'refresh'),
    false,
  );
  const refresh = entries({ active: 'my-tickets', refresh: true }).find(
    ({ id }) => id === 'refresh',
  );
  assert.equal(refresh.name, 'Refresh My Tickets');
  assert.deepEqual(refresh.action, { type: 'refresh', id: 'my-tickets' });
  // No Home Refresh unless the caller says the screen registered one.
  assert.equal(
    entries({ active: 'home', refresh: false }).some(({ id }) => id === 'refresh'),
    false,
  );
});

test('a typed ticket key adds an Open in My Tickets entry after the sessions, and it survives filtering', () => {
  const list = entries({ query: 'tap-9001' });
  const open = list.find(({ id }) => id === 'ticket-TAP-9001');
  assert.equal(open.name, 'Open TAP-9001 in My Tickets');
  assert.deepEqual(open.action, { type: 'ticket', key: 'TAP-9001' });
  assert.ok(list.indexOf(open) > ids(list).indexOf('session-BOT-1:implement'));
  // A session of the typed key still comes first.
  assert.equal(
    ids(filterEntries(entries({ query: 'bot-1' }), 'bot-1'))[0],
    'session-BOT-1:implement',
  );
  assert.deepEqual(ids(filterEntries(list, 'tap-9001')), ['ticket-TAP-9001']);
  assert.equal(
    entries({ query: 'tap' }).some(({ id }) => id.startsWith('ticket-')),
    false,
  );
});

test('filtering: every whitespace term must appear, case-insensitively, in the whole entry text', () => {
  const list = entries();
  assert.deepEqual(ids(filterEntries(list, 'rel')), ['tab-releases']);
  assert.deepEqual(ids(filterEntries(list, 'REL go')), ['tab-releases']);
  assert.deepEqual(ids(filterEntries(list, 'bot-1 implement')), ['session-BOT-1:implement']);
  assert.deepEqual(ids(filterEntries(list, 'export')), [
    'session-5b0c7e3a-2d41-4c8e-9f16-0a7d3b9e4c21:chat',
  ]);
  assert.deepEqual(ids(filterEntries(list, 'zzz')), []);
  assert.equal(filterEntries(list, '   ').length, list.length);
  assert.equal(filterEntries(list, undefined).length, list.length);
});

test('tabLabelWithChord words the tooltip', () => {
  assert.equal(tabLabelWithChord('My Tickets', 'my-tickets'), 'My Tickets (g then t)');
  assert.equal(tabLabelWithChord('Settings', 'settings'), 'Settings (g then ,)');
  assert.equal(tabLabelWithChord('Odd', 'unknown'), 'Odd');
});
