// devtools-stream-client.test.mjs — the dashboard tab's side of the one shared live-view stream.
// The EventSource and the POSTs are fakes: nothing here touches a network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDevtoolsStream } from '../ui/devtools-stream.js';

const settle = async () => {
  for (let turn = 0; turn < 6; turn += 1) await new Promise((resolve) => setImmediate(resolve));
};

function setup() {
  const sources = [];
  const posts = [];
  const timers = [];
  const state = { fail: false };
  class FakeSource {
    constructor() {
      this.readyState = 0;
      this.listeners = {};
      this.closed = false;
      sources.push(this);
    }
    addEventListener(type, listener) {
      (this.listeners[type] ||= []).push(listener);
    }
    close() {
      this.closed = true;
      this.readyState = 2;
    }
    // What the server sends.
    say(type, payload) {
      for (const listener of this.listeners[type] || [])
        listener({ data: JSON.stringify(payload) });
    }
    hello(stream = 'streamstreamstream01') {
      this.readyState = 1;
      this.say('hello', { stream });
    }
    fail(readyState) {
      this.readyState = readyState;
      for (const listener of this.listeners.error || []) listener({});
    }
  }
  const client = createDevtoolsStream({
    open: () => new FakeSource(),
    subscribe: async (stream, id, quality) => {
      posts.push(['subscribe', stream, id, quality]);
      return { ok: !state.fail };
    },
    unsubscribe: async (stream, id) => {
      posts.push(['unsubscribe', stream, id]);
      return { ok: true };
    },
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, live: true };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      if (timer) timer.live = false;
    },
  });
  const listener = () => {
    const seen = { status: [], target: [], tabs: [], frame: [] };
    return {
      seen,
      status: (value) => seen.status.push(value),
      target: (value) => seen.target.push(value),
      tabs: (value) => seen.tabs.push(value),
      frame: (value) => seen.frame.push(value),
    };
  };
  return { client, sources, posts, timers, state, listener };
}

// The stream closes a moment after its last watcher: this is that moment arriving.
const LINGER = 1500;
const lingering = (timers) => timers.filter((timer) => timer.live && timer.ms === LINGER);
const letLingerPass = (timers) => lingering(timers).forEach((timer) => timer.fn());

const FRAME = { data: 'AAAA', metadata: { deviceWidth: 1280, deviceHeight: 720 } };

test('any number of watchers share one stream, opened by the first and closed after the last', async () => {
  const { client, sources, posts, timers, listener } = setup();
  const stops = ['b-1', 'b-2', 'b-3', 'b-4'].map((id) => client.watch(id, 'tile', listener()));
  assert.equal(sources.length, 1);
  await settle();
  assert.deepEqual(posts, [], 'nothing is subscribed until the server has said the stream id');

  sources[0].hello();
  await settle();
  assert.deepEqual(
    posts.map(([kind, , id, quality]) => [kind, id, quality]),
    [
      ['subscribe', 'b-1', 'tile'],
      ['subscribe', 'b-2', 'tile'],
      ['subscribe', 'b-3', 'tile'],
      ['subscribe', 'b-4', 'tile'],
    ],
  );
  assert.ok(posts.every(([, stream]) => stream === 'streamstreamstream01'));

  stops.slice(0, 3).forEach((stop) => stop());
  assert.equal(sources[0].closed, false);
  stops[3]();
  assert.equal(sources[0].closed, false, 'it waits a moment for the next watcher');
  assert.equal(lingering(timers).length, 1);
  await settle();
  assert.deepEqual(
    posts.slice(4).map(([kind, , id]) => [kind, id]),
    [
      ['unsubscribe', 'b-1'],
      ['unsubscribe', 'b-2'],
      ['unsubscribe', 'b-3'],
      ['unsubscribe', 'b-4'],
    ],
    'every browser is let go of at once, stream or not',
  );
  letLingerPass(timers);
  assert.equal(sources[0].closed, true);
  assert.equal(sources.length, 1);
});

test('a watcher that arrives while the stream lingers keeps it, so a swap of tiles reopens nothing', async () => {
  const { client, sources, posts, timers, listener } = setup();
  const stop = client.watch('b-1', 'tile', listener());
  sources[0].hello();
  await settle();
  stop();
  const next = client.watch('b-2', 'tile', listener());
  assert.equal(lingering(timers).length, 0, 'the wait is over');
  letLingerPass(timers);
  await settle();
  assert.equal(sources[0].closed, false);
  assert.equal(sources.length, 1);
  assert.deepEqual(posts.at(-1), ['subscribe', 'streamstreamstream01', 'b-2', 'tile']);

  // And once everyone has really gone, a new watcher opens a new stream.
  next();
  letLingerPass(timers);
  assert.equal(sources[0].closed, true);
  client.watch('b-3', 'tile', listener());
  assert.equal(sources.length, 2);
});

test('messages go to the watchers of the browser they name, and the target says which tab', async () => {
  const { client, sources, listener } = setup();
  const one = listener();
  const two = listener();
  client.watch('b-1', 'tile', one);
  client.watch('b-2', 'tile', two);
  sources[0].hello();
  sources[0].say('status', { id: 'b-1', status: 'live', reason: '' });
  sources[0].say('target', { id: 'b-1', targetId: 'T1', title: 'Home', url: 'https://x.invalid/' });
  sources[0].say('tabs', { id: 'b-2', mode: 'auto', tabs: [{ id: 'T9', current: true }] });
  sources[0].say('frame', { id: 'b-2', ...FRAME });
  sources[0].say('frame', { id: 'b-unwatched', ...FRAME });
  sources[0].say('frame', { id: 'b-1' }); // no picture in it: not a frame

  assert.deepEqual(one.seen.status, [{ status: 'live', reason: '' }]);
  assert.deepEqual(one.seen.target, [{ id: 'T1', title: 'Home', url: 'https://x.invalid/' }]);
  assert.deepEqual(one.seen.tabs, []);
  assert.deepEqual(one.seen.frame, []);
  assert.deepEqual(two.seen.tabs, [{ mode: 'auto', tabs: [{ id: 'T9', current: true }] }]);
  assert.deepEqual(two.seen.frame, [FRAME]);
  assert.deepEqual(two.seen.status, []);
});

test('two watchers of a browser are on one subscription, at the higher quality of them', async () => {
  const { client, sources, posts, timers, listener } = setup();
  const stopTile = client.watch('b-1', 'tile', listener());
  sources[0].hello();
  await settle();
  const viewer = listener();
  const stopViewer = client.watch('b-1', 'full', viewer);
  await settle();
  assert.equal(sources.length, 1);
  assert.deepEqual(
    posts.map(([kind, , , quality]) => [kind, quality]),
    [
      ['subscribe', 'tile'],
      ['subscribe', 'full'],
    ],
  );

  // The viewer closes: back to a tile, and the tile never left.
  stopViewer();
  await settle();
  assert.deepEqual(posts.at(-1).slice(0, 1).concat(posts.at(-1).slice(3)), ['subscribe', 'tile']);
  assert.equal(sources[0].closed, false);

  // The tile goes (scrolled away) while a viewer has it open: still watched, at full.
  const again = client.watch('b-1', 'full', listener());
  await settle();
  stopTile();
  await settle();
  assert.equal(posts.filter(([kind]) => kind === 'unsubscribe').length, 0);
  again();
  await settle();
  letLingerPass(timers);
  assert.equal(sources[0].closed, true);
});

test('a watcher that joins late hears what is already known; one that left hears nothing more', async () => {
  const { client, sources, listener } = setup();
  const first = listener();
  client.watch('b-1', 'tile', first);
  sources[0].hello();
  sources[0].say('status', { id: 'b-1', status: 'live', reason: '' });
  sources[0].say('target', { id: 'b-1', targetId: 'T1', title: 'Home', url: 'https://x.invalid/' });
  sources[0].say('tabs', { id: 'b-1', mode: 'auto', tabs: [] });
  sources[0].say('frame', { id: 'b-1', ...FRAME });

  const late = listener();
  const stop = client.watch('b-1', 'full', late);
  assert.deepEqual(late.seen.status, [{ status: 'live', reason: '' }]);
  assert.deepEqual(late.seen.target, [{ id: 'T1', title: 'Home', url: 'https://x.invalid/' }]);
  assert.deepEqual(late.seen.tabs, [{ mode: 'auto', tabs: [] }]);
  assert.deepEqual(late.seen.frame, [FRAME]);

  stop();
  stop(); // twice is nothing
  sources[0].say('frame', { id: 'b-1', ...FRAME });
  assert.equal(late.seen.frame.length, 1);
  assert.equal(first.seen.frame.length, 2);
});

test('letting go of a browser unsubscribes it; what it showed is forgotten', async () => {
  const { client, sources, posts, listener } = setup();
  const keep = client.watch('b-2', 'tile', listener());
  const stop = client.watch('b-1', 'tile', listener());
  sources[0].hello();
  sources[0].say('frame', { id: 'b-1', ...FRAME });
  await settle();
  stop();
  await settle();
  assert.deepEqual(posts.at(-1), ['unsubscribe', 'streamstreamstream01', 'b-1']);
  assert.equal(sources[0].closed, false, 'another browser is still watched');

  const back = listener();
  client.watch('b-1', 'tile', back);
  assert.deepEqual(back.seen.frame, [], 'a stale picture is not replayed to a new watcher');
  await settle();
  assert.deepEqual(posts.at(-1).slice(0, 1).concat(posts.at(-1).slice(2)), [
    'subscribe',
    'b-1',
    'tile',
  ]);
  keep();
});

test('quick changes are sent one at a time and the last wanted wins', async () => {
  const { client, sources, posts, listener } = setup();
  const tile = client.watch('b-1', 'tile', listener());
  sources[0].hello();
  // All before the first request has been answered.
  const viewer = client.watch('b-1', 'full', listener());
  viewer();
  const again = client.watch('b-1', 'full', listener());
  await settle();
  const sent = posts.map(([kind, , , quality]) => `${kind}:${quality}`);
  assert.equal(sent[0], 'subscribe:tile');
  assert.equal(sent.at(-1), 'subscribe:full');
  assert.ok(!sent.includes('unsubscribe:undefined'));
  again();
  tile();
});

test('a new connection starts from nothing: everything wanted is subscribed again', async () => {
  const { client, sources, posts, listener } = setup();
  const one = listener();
  client.watch('b-1', 'tile', one);
  client.watch('b-2', 'full', listener());
  sources[0].hello('firststreamidxxxxx');
  await settle();
  assert.equal(posts.length, 2);

  // The connection drops and the browser reconnects it by itself: a different stream id.
  sources[0].fail(0);
  assert.deepEqual(one.seen.status.at(-1), { status: 'connecting', reason: 'reconnecting' });
  sources[0].hello('secondstreamidxxxx');
  await settle();
  assert.deepEqual(
    posts.slice(2).map(([kind, stream, id, quality]) => [kind, stream, id, quality]),
    [
      ['subscribe', 'secondstreamidxxxx', 'b-1', 'tile'],
      ['subscribe', 'secondstreamidxxxx', 'b-2', 'full'],
    ],
  );
  assert.equal(sources.length, 1, 'it is the same EventSource');
});

test('a refused stream says so and is asked for again after a while, not in a loop', async () => {
  const { client, sources, timers, listener } = setup();
  const watcher = listener();
  client.watch('b-1', 'tile', watcher);
  sources[0].fail(2); // closed: the server said no
  assert.deepEqual(watcher.seen.status.at(-1), { status: 'lost', reason: 'disconnected' });
  assert.equal(sources.length, 1);
  const [retry] = timers.filter((timer) => timer.live);
  assert.ok(retry.ms >= 1000);
  retry.fn();
  assert.equal(sources.length, 2);
  sources[1].hello();
  sources[1].say('status', { id: 'b-1', status: 'live', reason: '' });
  assert.deepEqual(watcher.seen.status.at(-1), { status: 'live', reason: '' });

  // Nobody left to want it: the retry is dropped with the stream.
  const quiet = setup();
  const stop = quiet.client.watch('b-1', 'tile', quiet.listener());
  quiet.sources[0].fail(2);
  stop();
  quiet.timers.filter((timer) => timer.live).forEach((timer) => timer.fn());
  assert.equal(quiet.sources.length, 1, 'nothing is opened for nobody');
});

test('a browser the server will not subscribe is shown as not available, and can be tried again', async () => {
  const { client, sources, posts, state, listener } = setup();
  const watcher = listener();
  const stop = client.watch('b-1', 'tile', watcher);
  state.fail = true;
  sources[0].hello();
  await settle();
  assert.deepEqual(watcher.seen.status.at(-1), { status: 'lost', reason: 'unavailable' });
  assert.equal(posts.length, 1, 'no retry loop');

  state.fail = false;
  const second = client.watch('b-1', 'tile', listener());
  await settle();
  assert.equal(posts.length, 2, 'watching again asks again');
  stop();
  second();
});

test('a message after the stream was replaced is ignored', async () => {
  const { client, sources, timers, listener } = setup();
  const watcher = listener();
  client.watch('b-1', 'tile', watcher);
  sources[0].fail(2);
  timers.find((timer) => timer.live).fn();
  sources[0].say('frame', { id: 'b-1', ...FRAME }); // from the old connection
  assert.deepEqual(watcher.seen.frame, []);
});
