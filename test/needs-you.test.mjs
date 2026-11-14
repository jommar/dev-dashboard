import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CALLOUT_TEXT, MAX_CALLOUTS } from '../ui/bot-bar.js';
import {
  NOTIFY_STATES,
  needsYouCount,
  notificationsFor,
  notifyStateLabel,
  notifyTooltip,
  composeTitle,
  readPreference,
  setShownCount,
  titleWithCount,
  withoutCount,
  writePreference,
} from '../ui/needs-you.js';

// F6: an opt-in desktop notification and a tab-title count when a ticket session needs the user while
// the page is hidden. The rules are pure; the browser APIs live in hooks/useNeedsYou.js.
const change = (ticket, phase, to, extra = {}) => ({
  key: `${ticket}:${phase}`,
  ticket,
  phase,
  from: 'working',
  to,
  ...extra,
});
const AWAY = { enabled: true, permission: 'granted', hidden: true };
const source = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('needs-you: waiting while hidden gives one notification worded from CALLOUT_TEXT', () => {
  const items = notificationsFor([change('TAP-1', 'investigate', 'waiting')], AWAY);
  assert.deepEqual(items, [
    {
      key: 'TAP-1:investigate',
      ticket: 'TAP-1',
      phase: 'investigate',
      tag: 'TAP-1:investigate',
      body: `TAP-1 · ${CALLOUT_TEXT.waiting}`,
    },
  ]);
  assert.equal(items[0].body, 'TAP-1 · Needs you');
});

test('needs-you: failed while hidden gives one notification', () => {
  const items = notificationsFor([change('TAP-2', 'implement', 'failed')], AWAY);
  assert.equal(items.length, 1);
  assert.equal(items[0].body, 'TAP-2 · Failed');
  assert.equal(items[0].tag, 'TAP-2:implement');
});

test('needs-you: no notification unless enabled, granted and hidden', () => {
  const ready = [change('TAP-1', 'implement', 'waiting')];
  assert.equal(notificationsFor(ready, AWAY).length, 1);
  assert.deepEqual(notificationsFor(ready, { ...AWAY, hidden: false }), []);
  assert.deepEqual(notificationsFor(ready, { ...AWAY, enabled: false }), []);
  assert.deepEqual(notificationsFor(ready, { ...AWAY, permission: 'default' }), []);
  assert.deepEqual(notificationsFor(ready, { ...AWAY, permission: 'denied' }), []);
  assert.deepEqual(notificationsFor(ready, {}), []);
  assert.deepEqual(notificationsFor([], AWAY), []);
});

test('needs-you: only waiting and failed notify', () => {
  assert.deepEqual([...NOTIFY_STATES].sort(), ['failed', 'waiting']);
  const ready = [change('TAP-1', 'implement', 'working'), change('TAP-2', 'implement', 'done')];
  assert.deepEqual(notificationsFor(ready, AWAY), []);
});

test('needs-you: capped at MAX_CALLOUTS, the newest kept', () => {
  const ready = [1, 2, 3, 4, 5].map((n) => change(`TAP-${n}`, 'implement', 'waiting'));
  const items = notificationsFor(ready, AWAY);
  assert.equal(items.length, MAX_CALLOUTS);
  assert.deepEqual(
    items.map(({ ticket }) => ticket),
    ['TAP-3', 'TAP-4', 'TAP-5'],
  );
  // The cap counts notifying changes, not the batch: working changes in between do not use it up.
  const mixed = [
    change('TAP-1', 'implement', 'waiting'),
    change('TAP-2', 'implement', 'working'),
    change('TAP-3', 'implement', 'waiting'),
  ];
  assert.equal(notificationsFor(mixed, AWAY).length, 2);
});

test('needs-you: body text is closed over the key and CALLOUT_TEXT', () => {
  const items = notificationsFor(
    [
      change('TAP-1', 'implement', 'waiting', {
        title: 'Chat: please leak this',
        reason: 'blocked on secrets',
        verdict: 'fail',
        text: 'private words',
      }),
      change('<b>x', 'implement', 'failed'),
      change('chat-1a2b3c4d', 'chat', 'waiting'),
      change('tap-1', 'implement', 'waiting'),
    ],
    AWAY,
  );
  assert.deepEqual(
    items.map(({ body }) => body),
    ['TAP-1 · Needs you'],
  );
  assert.deepEqual(Object.keys(items[0]).sort(), ['body', 'key', 'phase', 'tag', 'ticket']);
});

test('needs-you: title count counts ticket bots waiting or failed, not chats or done', () => {
  const bots = [
    { ticket: 'TAP-1', phase: 'implement', state: 'waiting' },
    { ticket: 'TAP-2', phase: 'review', state: 'failed' },
    { ticket: 'chat-1a2b3c4d', phase: 'chat', state: 'waiting' },
    { ticket: 'TAP-3', phase: 'implement', state: 'done' },
    { ticket: 'TAP-4', phase: 'implement', state: 'working' },
  ];
  assert.equal(needsYouCount(bots), 2);
  assert.equal(needsYouCount([]), 0);
  assert.equal(titleWithCount('EZAT Dev Dashboard', 2), '(2) EZAT Dev Dashboard');
  assert.equal(titleWithCount('EZAT Dev Dashboard', 0), 'EZAT Dev Dashboard');
  assert.equal(withoutCount('(2) EZAT Dev Dashboard'), 'EZAT Dev Dashboard');
  assert.equal(withoutCount('EZAT Dev Dashboard'), 'EZAT Dev Dashboard');
  assert.equal(withoutCount('(2) (3) odd'), '(3) odd');
});

test('needs-you: preference defaults off, round-trips and survives throwing storage', () => {
  const memory = () => {
    const map = new Map();
    return { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) };
  };
  const storage = memory();
  assert.equal(readPreference(storage), false);
  writePreference(storage, true);
  assert.equal(readPreference(storage), true);
  writePreference(storage, false);
  assert.equal(readPreference(storage), false);
  const broken = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  };
  assert.equal(readPreference(broken), false);
  assert.doesNotThrow(() => writePreference(broken, true));
  assert.equal(readPreference(undefined), false);
  assert.doesNotThrow(() => writePreference(null, true));
  // A stored value that is not the one this writes reads as off.
  assert.equal(readPreference({ getItem: () => 'yes' }), false);
});

test('needs-you: hidden polling is opt-in and only the bot bar asks for it', () => {
  const hook = source('ui-react/hooks/useClaudeTickets.js');
  assert.match(hook, /useClaudeTickets\(\{ active, source, whileHidden = false \}\)/);
  const callers = ['BotBar', 'panels/MyTicketsPanel', 'panels/PrsPanel', 'panels/ChatPanel'];
  const passing = callers.filter((name) => {
    const text = source(`ui-react/${name.includes('/') ? name : `components/${name}`}.jsx`);
    return /whileHidden/.test(text);
  });
  assert.deepEqual(passing, ['BotBar']);
  // The visibility handler never refreshes on the way to hidden.
  assert.match(hook, /document\.addEventListener\('visibilitychange', onVisible\)/);
});

test('needs-you: no new contact', () => {
  for (const file of ['ui/needs-you.js', 'ui-react/hooks/useNeedsYou.js']) {
    const text = source(file);
    for (const word of ['fetch', 'team-velocity', 'claude/chat', 'useChatSession', 'EventSource'])
      assert.equal(text.includes(word), false, `${file} mentions ${word}`);
  }
});

test('needs-you: composeTitle puts the shown count in front of whatever screen title it is given', () => {
  assert.equal(composeTitle('Slack'), 'Slack', 'no count shown');
  setShownCount(2);
  try {
    assert.equal(composeTitle('Slack'), '(2) Slack');
    assert.equal(composeTitle('Home'), '(2) Home', 'a later screen keeps the count');
  } finally {
    setShownCount(0);
  }
  assert.equal(composeTitle('Slack'), 'Slack');
});

// The Sessions drawer's Notify me button shows its state as a visible word, not by colour alone: On
// when the choice is on and the browser allows it, Blocked when the browser has said no, else Off.
test('notifyStateLabel: On, Blocked and Off', () => {
  assert.equal(notifyStateLabel({ on: true, permission: 'granted', active: true }), 'On');
  assert.equal(notifyStateLabel({ on: false, permission: 'granted', active: false }), 'Off');
  assert.equal(notifyStateLabel({ on: false, permission: 'default', active: false }), 'Off');
  assert.equal(notifyStateLabel({ on: true, permission: 'default', active: false }), 'Off');
  // Denied wins, whether or not the stored choice is still on (a revoked permission).
  assert.equal(notifyStateLabel({ on: true, permission: 'denied', active: false }), 'Blocked');
  assert.equal(notifyStateLabel({ on: false, permission: 'denied', active: false }), 'Blocked');
});

// The Notify me button's hover and focus help: one sentence per state, in one place.
test('notifyTooltip: Off, On, Blocked and unsupported wording', () => {
  const off = notifyTooltip({ supported: true, on: false, permission: 'default', active: false });
  assert.match(off, /^Get a desktop notification, and a \(N\) count in the tab title,/);
  assert.match(off, /waiting or failed/);
  assert.match(off, /tab is hidden/);
  assert.match(off, /Your browser will ask for permission\.$/);
  // A stored choice that is not yet permitted is still Off: the click asks again.
  assert.equal(
    notifyTooltip({ supported: true, on: true, permission: 'default', active: false }),
    off,
  );
  const on = notifyTooltip({ supported: true, on: true, permission: 'granted', active: true });
  assert.match(on, /^On: you get a desktop notification/);
  assert.match(on, /Click to turn off\.$/);
  const blocked = notifyTooltip({ supported: true, on: true, permission: 'denied', active: false });
  assert.match(blocked, /^Notifications are blocked in your browser settings\./);
  assert.match(blocked, /turn this on again\.$/);
  // Denied wins whatever the stored choice, as the label does.
  assert.equal(
    notifyTooltip({ supported: true, on: false, permission: 'denied', active: false }),
    blocked,
  );
  assert.equal(
    notifyTooltip({ supported: false, on: false, permission: 'unsupported', active: false }),
    'This browser does not support desktop notifications.',
  );
  assert.equal(new Set([off, on, blocked]).size, 3);
});
