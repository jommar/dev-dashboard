// chat-stream.test.mjs — plan scenario 21: the Chat screen's client of the chat SSE stream.
// `chatReducer(view, event)` folds one event, `{ type, data }` (the SSE event name and its parsed
// JSON), into the view; `createChatStream({ open })` is the hello-first client over an EventSource.
// The source is a fake: nothing here touches a network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chatReducer, costLabel, createChatStream } from '../ui/chat-stream.js';

const SESSION = '3f2b8c1a-5d4e-4f60-9a7b-1c2d3e4f5a6b';
const USER = { id: 'u1', kind: 'user', text: 'hello' };
const ANSWER = { id: 'a1', kind: 'assistant', text: 'Hi there' };
const hello = (overrides = {}) => ({
  session: SESSION,
  kind: 'chat',
  title: 'hello',
  state: 'idle',
  live: false,
  items: [USER],
  truncated: false,
  turn: null,
  ...overrides,
});
const say = (view, type, data) => chatReducer(view, { type, data });

// Freezes a view all the way down: a reducer that edits its input throws instead of passing.
const frozen = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
};

test('scenario 21: hello replaces the whole view, whatever it held', () => {
  const stale = say(say(null, 'hello', hello({ title: 'old' })), 'delta', { text: 'half a sent' });
  const view = say(stale, 'hello', hello({ title: 'new', items: [USER, ANSWER] }));
  assert.equal(view.session, SESSION);
  assert.equal(view.kind, 'chat');
  assert.equal(view.title, 'new');
  assert.equal(view.state, 'idle');
  assert.equal(view.live, false);
  assert.equal(view.truncated, false);
  assert.equal(view.turn, null);
  assert.deepEqual(view.items, [USER, ANSWER]);
  assert.equal(view.tail, '', 'the old tail is gone');
});

test('scenario 21: an item with a known id replaces in place, a new id appends, twice is once', () => {
  let view = say(null, 'hello', hello());
  const tool = { id: 'toolu_1', kind: 'tool', name: 'Read', input: '{}', result: null };
  view = say(view, 'item', { item: tool });
  view = say(view, 'item', { item: ANSWER });
  assert.deepEqual(
    view.items.map(({ id }) => id),
    ['u1', 'toolu_1', 'a1'],
  );
  const done = { ...tool, result: { text: 'ok', isError: false } };
  view = say(view, 'item', { item: done });
  view = say(view, 'item', { item: done });
  assert.deepEqual(
    view.items.map(({ id }) => id),
    ['u1', 'toolu_1', 'a1'],
    'the tool item kept its place',
  );
  assert.deepEqual(view.items[1], done);
});

test('scenario 21: a delta grows the tail; the assistant item or an idle state clears it', () => {
  let view = say(null, 'hello', hello({ state: 'working', live: true }));
  view = say(view, 'delta', { text: 'Hel' });
  view = say(view, 'delta', { text: 'lo' });
  assert.equal(view.tail, 'Hello');
  assert.deepEqual(view.items, [USER], 'the tail is not an item yet');

  const replied = say(view, 'item', { item: { id: 'a2', kind: 'assistant', text: 'Hello' } });
  assert.equal(replied.tail, '');
  assert.equal(replied.items.at(-1).id, 'a2');

  const turn = { outcome: 'stopped', reason: null, error: null, denials: [], costUsd: null };
  const stopped = say(view, 'state', { state: 'idle', turn });
  assert.equal(stopped.tail, '');
});

test('scenario 21: a working state is live; an idle state ends it and keeps the turn', () => {
  let view = say(null, 'hello', hello());
  view = say(view, 'state', { state: 'working' });
  assert.equal(view.state, 'working');
  assert.equal(view.live, true, 'a turn this dashboard runs is one it streams and can stop');
  const turn = {
    outcome: 'completed',
    reason: null,
    error: null,
    denials: ['Write'],
    costUsd: 0.1,
  };
  view = say(view, 'state', { state: 'idle', turn });
  assert.equal(view.state, 'idle');
  assert.equal(view.live, false);
  assert.deepEqual(view.turn, turn);
});

test('scenario 21: events before hello are ignored, and the reducer never edits its input', () => {
  assert.equal(say(null, 'item', { item: ANSWER }), null);
  assert.equal(say(null, 'delta', { text: 'x' }), null);
  assert.equal(say(null, 'state', { state: 'working' }), null);

  const view = frozen(say(null, 'hello', hello()));
  const next = say(view, 'item', { item: ANSWER });
  assert.deepEqual(view.items, [USER]);
  assert.deepEqual(next.items, [USER, ANSWER]);
});

test('an idle state keeps the part of a reply that never became an item, as an assistant item', () => {
  let view = say(null, 'hello', hello({ state: 'working', live: true }));
  const turn = { outcome: 'stopped', reason: null, error: null, denials: [], costUsd: null };
  const quiet = say(view, 'state', { state: 'idle', turn });
  assert.deepEqual(quiet.items, [USER], 'nothing written, nothing kept');

  view = say(view, 'delta', { text: 'One is the loneliest, two' });
  const stopped = say(view, 'state', { state: 'idle', turn });
  assert.equal(stopped.tail, '');
  assert.equal(stopped.items.length, view.items.length + 1);
  assert.equal(stopped.items.at(-1).kind, 'assistant');
  assert.equal(stopped.items.at(-1).text, 'One is the loneliest, two');
});

function fakeSource() {
  const source = {
    readyState: 0,
    closes: 0,
    listeners: {},
    addEventListener(type, listener) {
      (source.listeners[type] ||= []).push(listener);
    },
    close() {
      source.closes += 1;
      source.readyState = 2;
    },
    // What the server sends.
    say(type, payload) {
      const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
      for (const listener of source.listeners[type] || []) listener({ data });
    },
  };
  return source;
}

test('scenario 21: the stream hands on nothing before hello, then every event as it comes', () => {
  const source = fakeSource();
  let opened = 0;
  const stream = createChatStream({
    open: () => {
      opened += 1;
      return source;
    },
  });
  assert.equal(opened, 0, 'nothing is opened until someone listens');
  const heard = [];
  stream.listen((event) => heard.push(event));
  assert.equal(opened, 1);

  source.say('item', { item: ANSWER });
  source.say('delta', { text: 'early' });
  assert.deepEqual(heard, [], 'hello comes first');

  source.say('hello', hello());
  source.say('item', { item: ANSWER });
  source.say('delta', { text: 'x' });
  source.say('state', { state: 'working' });
  assert.deepEqual(heard, [
    { type: 'hello', data: hello() },
    { type: 'item', data: { item: ANSWER } },
    { type: 'delta', data: { text: 'x' } },
    { type: 'state', data: { state: 'working' } },
  ]);

  // The browser reconnects by itself and the server starts over with a hello.
  source.say('hello', hello({ title: 'again' }));
  assert.deepEqual(heard.at(-1), { type: 'hello', data: hello({ title: 'again' }) });
});

test('scenario 21: closing closes the source once and silences the stream', () => {
  const source = fakeSource();
  const stream = createChatStream({ open: () => source });
  const heard = [];
  stream.listen((event) => heard.push(event));
  source.say('hello', hello());
  stream.close();
  stream.close();
  assert.equal(source.closes, 1);
  source.say('item', { item: ANSWER });
  assert.equal(heard.length, 1, 'nothing after close');
});

test('cost label: dollars to the cent, "under $0.01" below a cent, nothing for a non-cost', () => {
  assert.equal(costLabel(0.4213), 'Session cost so far $0.42');
  assert.equal(costLabel(12), 'Session cost so far $12.00');
  assert.equal(costLabel(0.01), 'Session cost so far $0.01');
  assert.equal(costLabel(0.004), 'Session cost so far under $0.01');
  assert.equal(costLabel(0), 'Session cost so far under $0.01');
  for (const bad of [null, undefined, NaN, Infinity, -0.5, '0.42', {}])
    assert.equal(costLabel(bad), '');
});
