// devtools-stream.test.mjs — the one live stream many browsers share, for the DevTools wall.
// The browsers' sessions are a fake, so nothing here opens a socket or starts a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { STREAM_ID, createDevtoolsStreams } from '../backend/devtools-stream.mjs';

const refuse = (code, status) => Object.assign(new Error(code), { code, status });

// A stand-in for browser-screencast.mjs: it hands out subscriptions and lets a test say what a
// browser sent. `gate` holds every subscribe open until the test lets it through.
function fakeScreencast({ known = ['b-1', 'b-2', 'b-3'], gate = false } = {}) {
  const live = []; // every subscription ever made
  const waiting = [];
  const screencast = {
    async subscribe(id, listener, quality) {
      if (gate) await new Promise((resolve) => waiting.push(resolve));
      if (!known.includes(id)) throw refuse('UNKNOWN_BROWSER', 404);
      if (id === 'b-stopped') throw refuse('BROWSER_NOT_RUNNING', 409);
      const entry = { id, listener, quality, left: false, qualities: [quality] };
      live.push(entry);
      const leave = () => {
        entry.left = true;
      };
      leave.setQuality = (level) => {
        entry.quality = level;
        entry.qualities.push(level);
      };
      return leave;
    },
  };
  return {
    screencast,
    live,
    release: () => waiting.splice(0).forEach((resolve) => resolve()),
    active: () => live.filter((entry) => !entry.left),
    // What the browser `id` sends, to everyone watching it.
    say: (id, event, payload) => {
      for (const entry of live.filter((item) => item.id === id && !item.left))
        entry.listener[event](payload);
    },
  };
}

// A client's end of a stream: every message it was sent, and a switch for being slow.
function sinkOf(options = {}) {
  const sink = {
    messages: [],
    ended: 0,
    slow: options.slow || (() => false),
    send(event, payload) {
      sink.messages.push([event, payload]);
      return !sink.slow(event, payload);
    },
    end() {
      sink.ended += 1;
    },
    named: (event) =>
      sink.messages.filter(([name]) => name === event).map(([, payload]) => payload),
  };
  return sink;
}

const setup = (options = {}, streamOptions = {}) => {
  const browsers = fakeScreencast(options);
  const hub = createDevtoolsStreams({ screencast: browsers.screencast, ...streamOptions });
  return { browsers, hub };
};

const FRAME = { data: 'AAAA', metadata: { deviceWidth: 1280, deviceHeight: 720 } };

test('opening a stream says its id first, a random one that a client could send back', () => {
  const { hub } = setup();
  const first = sinkOf();
  const second = sinkOf();
  const one = hub.open(first);
  const two = hub.open(second);
  assert.deepEqual(first.messages, [['hello', { stream: one.id }]]);
  assert.match(one.id, STREAM_ID);
  assert.equal(one.id.length, 24);
  assert.notEqual(one.id, two.id);
});

test('several browsers share one stream, each message tagged with its browser', async () => {
  const { hub, browsers } = setup();
  const sink = sinkOf();
  const { id: stream } = hub.open(sink);
  await hub.subscribe(stream, 'b-1', 'tile');
  await hub.subscribe(stream, 'b-2', 'tile');
  assert.equal(browsers.active().length, 2);

  browsers.say('b-1', 'status', { status: 'live', reason: '' });
  browsers.say('b-2', 'status', { status: 'connecting', reason: 'reconnecting' });
  // The session's target is a tab, with its own `id`; the message's `id` is the browser.
  browsers.say('b-1', 'target', { id: 'T1', title: 'Home', url: 'https://example.invalid/' });
  browsers.say('b-2', 'tabs', {
    mode: 'auto',
    tabs: [{ id: 'T9', title: 'x', url: 'https://x.invalid/', current: true }],
  });
  browsers.say('b-1', 'frame', FRAME);
  browsers.say('b-2', 'frame', { ...FRAME, data: 'BBBB' });

  assert.deepEqual(sink.messages.slice(1), [
    ['status', { id: 'b-1', status: 'live', reason: '' }],
    ['status', { id: 'b-2', status: 'connecting', reason: 'reconnecting' }],
    ['target', { id: 'b-1', targetId: 'T1', title: 'Home', url: 'https://example.invalid/' }],
    [
      'tabs',
      {
        id: 'b-2',
        mode: 'auto',
        tabs: [{ id: 'T9', title: 'x', url: 'https://x.invalid/', current: true }],
      },
    ],
    ['frame', { id: 'b-1', ...FRAME }],
    ['frame', { id: 'b-2', ...FRAME, data: 'BBBB' }],
  ]);
});

test('streams are isolated: what one holds, another neither sees nor loses', async () => {
  const { hub, browsers } = setup();
  const mine = sinkOf();
  const yours = sinkOf();
  const a = hub.open(mine);
  const b = hub.open(yours);
  await hub.subscribe(a.id, 'b-1', 'tile');
  await hub.subscribe(a.id, 'b-2', 'tile');
  await hub.subscribe(b.id, 'b-1', 'full');
  assert.equal(browsers.active().length, 3, 'a browser both watch has one subscription each');

  browsers.say('b-2', 'frame', FRAME);
  assert.equal(mine.named('frame').length, 1);
  assert.equal(yours.named('frame').length, 0, 'b-2 is not on that stream');
  browsers.say('b-1', 'frame', FRAME);
  assert.equal(mine.named('frame').length, 2);
  assert.equal(yours.named('frame').length, 1);

  hub.unsubscribe(a.id, 'b-1');
  assert.equal(browsers.live.find((entry) => entry.quality === 'full').left, false);
  browsers.say('b-1', 'frame', FRAME);
  assert.equal(yours.named('frame').length, 2, 'still delivered to the stream that kept it');
  assert.equal(mine.named('frame').length, 2);

  a.close();
  assert.deepEqual(
    browsers.active().map((entry) => [entry.id, entry.quality]),
    [['b-1', 'full']],
    'closing one stream lets go of its own subscriptions only',
  );
});

test('a browser is watched at the quality asked, and asking again changes it', async () => {
  const { hub, browsers } = setup();
  const { id: stream } = hub.open(sinkOf());
  await hub.subscribe(stream, 'b-1', 'tile');
  assert.equal(browsers.live[0].quality, 'tile');
  await hub.subscribe(stream, 'b-1', 'full');
  await hub.subscribe(stream, 'b-1', 'full');
  await hub.subscribe(stream, 'b-1', 'tile');
  assert.equal(browsers.live.length, 1, 'one subscription, changed in place');
  assert.deepEqual(browsers.live[0].qualities, ['tile', 'full', 'full', 'tile']);
});

test('only tile and full are qualities, and a refusal takes nothing', async () => {
  const { hub, browsers } = setup();
  const { id: stream } = hub.open(sinkOf());
  for (const quality of ['huge', '', undefined, null, 1, 'FULL'])
    await assert.rejects(hub.subscribe(stream, 'b-1', quality), {
      code: 'INVALID_QUALITY',
      status: 400,
    });
  assert.deepEqual(browsers.live, []);
});

test('unsubscribing lets the browser go, and doing it twice is not an error', async () => {
  const { hub, browsers } = setup();
  const { id: stream } = hub.open(sinkOf());
  await hub.subscribe(stream, 'b-1', 'tile');
  await hub.subscribe(stream, 'b-2', 'tile');
  hub.unsubscribe(stream, 'b-1');
  hub.unsubscribe(stream, 'b-1');
  hub.unsubscribe(stream, 'b-never-watched');
  assert.deepEqual(
    browsers.active().map((entry) => entry.id),
    ['b-2'],
  );
  await hub.subscribe(stream, 'b-1', 'tile');
  assert.equal(browsers.live.length, 3, 'it can be watched again');
});

test('closing the stream releases everything it held, once', async () => {
  const { hub, browsers } = setup();
  const sink = sinkOf();
  const handle = hub.open(sink);
  await hub.subscribe(handle.id, 'b-1', 'tile');
  await hub.subscribe(handle.id, 'b-2', 'full');
  handle.close();
  handle.close();
  assert.deepEqual(browsers.active(), []);
  assert.equal(sink.ended, 0, 'the client went away: there is nobody to end');
  // Nothing more reaches a closed stream, and its id means nothing now.
  const before = sink.messages.length;
  browsers.say('b-1', 'frame', FRAME);
  assert.equal(sink.messages.length, before);
  await assert.rejects(hub.subscribe(handle.id, 'b-1', 'tile'), {
    code: 'UNKNOWN_STREAM',
    status: 404,
  });
  assert.throws(() => hub.unsubscribe(handle.id, 'b-1'), { code: 'UNKNOWN_STREAM' });
});

test('shutting the service down ends every stream and lets every browser go', async () => {
  const { hub, browsers } = setup();
  const one = sinkOf();
  const two = sinkOf();
  const a = hub.open(one);
  const b = hub.open(two);
  await hub.subscribe(a.id, 'b-1', 'tile');
  await hub.subscribe(b.id, 'b-2', 'tile');
  hub.close();
  assert.deepEqual([one.ended, two.ended], [1, 1]);
  assert.deepEqual(browsers.active(), []);
  await assert.rejects(hub.subscribe(a.id, 'b-1', 'tile'), { code: 'UNKNOWN_STREAM' });
});

test('only so many streams are open at once, and a closed one frees its place', () => {
  const { hub } = setup({}, { maxStreams: 2 });
  const first = hub.open(sinkOf());
  hub.open(sinkOf());
  const refused = sinkOf();
  assert.throws(() => hub.open(refused), { code: 'TOO_MANY_STREAMS', status: 429 });
  assert.deepEqual(refused.messages, [], 'a refused stream is sent nothing');
  first.close();
  assert.doesNotThrow(() => hub.open(sinkOf()));
  // The default is eight.
  const { hub: roomy } = setup();
  for (let at = 0; at < 8; at += 1) roomy.open(sinkOf());
  assert.throws(() => roomy.open(sinkOf()), { code: 'TOO_MANY_STREAMS' });
});

test('only so many browsers are on one stream; another stream has its own allowance', async () => {
  const { hub, browsers } = setup({ known: ['b-1', 'b-2', 'b-3'] }, { maxSubscriptions: 2 });
  const { id: stream } = hub.open(sinkOf());
  await hub.subscribe(stream, 'b-1', 'tile');
  await hub.subscribe(stream, 'b-2', 'tile');
  await assert.rejects(hub.subscribe(stream, 'b-3', 'tile'), {
    code: 'TOO_MANY_SUBSCRIPTIONS',
    status: 429,
  });
  await hub.subscribe(stream, 'b-2', 'full'); // one it already has is not another
  hub.unsubscribe(stream, 'b-1');
  await hub.subscribe(stream, 'b-3', 'tile');
  const { id: other } = hub.open(sinkOf());
  await hub.subscribe(other, 'b-1', 'tile');
  assert.equal(browsers.active().length, 3);
});

test('a refused browser takes no place on the stream', async () => {
  const { hub } = setup({ known: ['b-1', 'b-stopped'] }, { maxSubscriptions: 1 });
  const { id: stream } = hub.open(sinkOf());
  await assert.rejects(hub.subscribe(stream, 'b-nope', 'tile'), { code: 'UNKNOWN_BROWSER' });
  await assert.rejects(hub.subscribe(stream, 'b-stopped', 'tile'), {
    code: 'BROWSER_NOT_RUNNING',
    status: 409,
  });
  await assert.rejects(hub.subscribe(stream, 7, 'tile'), { code: 'UNKNOWN_BROWSER', status: 404 });
  await assert.doesNotReject(hub.subscribe(stream, 'b-1', 'tile'));
});

test('a stream id has to be well formed before it is looked up', async () => {
  const { hub } = setup();
  const real = hub.open(sinkOf()).id;
  const malformed = [
    undefined,
    null,
    42,
    {},
    '',
    'short',
    'x'.repeat(15),
    'x'.repeat(65),
    `${real.slice(0, 20)}../x`,
    `${real.slice(0, 20)} abc`,
    `${real.slice(0, 20)}\n\n`,
  ];
  for (const id of malformed) {
    await assert.rejects(hub.subscribe(id, 'b-1', 'tile'), { code: 'INVALID_STREAM', status: 400 });
    assert.throws(() => hub.unsubscribe(id, 'b-1'), { code: 'INVALID_STREAM', status: 400 });
  }
  // Well formed but nobody's: 404, and the edges of the allowed length and alphabet pass.
  for (const id of ['x'.repeat(16), 'A-z_0'.repeat(12) + 'abcd', '0'.repeat(64)])
    await assert.rejects(hub.subscribe(id, 'b-1', 'tile'), { code: 'UNKNOWN_STREAM', status: 404 });
});

test('a client that is not keeping up misses frames of that browser only, never a status', async () => {
  const slow = new Set(['b-1']);
  const { hub, browsers } = setup();
  const sink = sinkOf({ slow: (event, payload) => event === 'frame' && slow.has(payload.id) });
  const handle = hub.open(sink);
  await hub.subscribe(handle.id, 'b-1', 'full');
  await hub.subscribe(handle.id, 'b-2', 'tile');

  browsers.say('b-1', 'frame', { ...FRAME, data: 'one' }); // written, but the client is behind
  browsers.say('b-1', 'frame', { ...FRAME, data: 'two' }); // dropped, not queued
  browsers.say('b-1', 'frame', { ...FRAME, data: 'three' });
  browsers.say('b-2', 'frame', { ...FRAME, data: 'other' }); // another browser is judged on its own
  browsers.say('b-1', 'status', { status: 'live', reason: '' });
  browsers.say('b-1', 'tabs', { mode: 'auto', tabs: [] });
  assert.deepEqual(
    sink.named('frame').map((frame) => frame.data),
    ['one', 'other'],
  );
  assert.equal(sink.named('status').length, 1);
  assert.equal(sink.named('tabs').length, 1);

  slow.clear();
  handle.drained();
  browsers.say('b-1', 'frame', { ...FRAME, data: 'four' });
  assert.deepEqual(
    sink.named('frame').map((frame) => frame.data),
    ['one', 'other', 'four'],
  );
});

test('slowness on one stream does not hold back another stream of the same browser', async () => {
  const { hub, browsers } = setup();
  const behind = sinkOf({ slow: (event) => event === 'frame' });
  const keeping = sinkOf();
  const a = hub.open(behind);
  const b = hub.open(keeping);
  await hub.subscribe(a.id, 'b-1', 'tile');
  await hub.subscribe(b.id, 'b-1', 'tile');
  for (const data of ['1', '2', '3']) browsers.say('b-1', 'frame', { ...FRAME, data });
  assert.equal(behind.named('frame').length, 1);
  assert.equal(keeping.named('frame').length, 3);
});

test('a browser that stops is told so on the stream, which carries on without it', async () => {
  const { hub, browsers } = setup();
  const sink = sinkOf();
  const { id: stream } = hub.open(sink);
  await hub.subscribe(stream, 'b-1', 'tile');
  await hub.subscribe(stream, 'b-2', 'tile');
  // What browser-screencast does when an instance stops: the status, then the end of every viewer.
  browsers.say('b-1', 'status', { status: 'lost', reason: 'stopped' });
  browsers.say('b-1', 'end');
  assert.deepEqual(sink.named('status').at(-1), { id: 'b-1', status: 'lost', reason: 'stopped' });
  assert.equal(sink.ended, 0);

  browsers.say('b-2', 'frame', FRAME);
  assert.equal(sink.named('frame').length, 1, 'the neighbour is untouched');
  // It is not held any more, so leaving it is fine and watching it again is a new subscription.
  hub.unsubscribe(stream, 'b-1');
  await hub.subscribe(stream, 'b-1', 'tile');
  assert.equal(browsers.live.filter((entry) => entry.id === 'b-1').length, 2);
});

test('a browser asked for twice at once is one subscription', async () => {
  const { hub, browsers } = setup({ gate: true });
  const { id: stream } = hub.open(sinkOf());
  const first = hub.subscribe(stream, 'b-1', 'tile');
  const second = hub.subscribe(stream, 'b-1', 'full');
  browsers.release();
  await Promise.all([first, second]);
  assert.equal(browsers.live.length, 1);
  assert.equal(browsers.live[0].quality, 'full', 'the later ask wins');
});

test('letting go while the browser is still answering is honoured when it does', async () => {
  const { hub, browsers } = setup({ gate: true });
  const handle = hub.open(sinkOf());
  const pending = hub.subscribe(handle.id, 'b-1', 'tile');
  hub.unsubscribe(handle.id, 'b-1');
  browsers.release();
  await pending;
  assert.equal(browsers.live[0].left, true, 'it was let go the moment it arrived');

  const closing = hub.subscribe(hub.open(sinkOf()).id, 'b-2', 'tile');
  hub.close();
  browsers.release();
  await closing;
  assert.deepEqual(browsers.active(), []);
});
