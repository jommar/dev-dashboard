// browser-screencast.test.mjs — the live-view contract for the DevTools tab.
// Every collaborator is injected: no fetch, no WebSocket, no timer and no browser is real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserScreencast, pickTarget } from '../backend/browser-screencast.mjs';

const RUNNING = { id: 'b-0001', port: 9300, status: 'running', pid: 4001 };
const OTHER = { id: 'b-0002', port: 9301, status: 'running', pid: 4002 };
const STOPPED = { id: 'b-0003', port: 9302, status: 'stopped', pid: null };

const page = (id, url = 'https://example.invalid/', extra = {}) => ({
  id,
  type: 'page',
  title: `Title ${id}`,
  url,
  webSocketDebuggerUrl: `ws://localhost:9222/devtools/page/${id}`,
  ...extra,
});

const settle = async () => {
  for (let turn = 0; turn < 6; turn += 1) await new Promise((resolve) => setImmediate(resolve));
};

function harness({ records = [RUNNING, OTHER, STOPPED], targets = [page('T1')] } = {}) {
  const sockets = [];
  const fetched = [];
  const timers = [];
  const stopListeners = new Set();
  const state = { targets, discoveryFails: false, refuseCommands: false, hang: false };

  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      this.listeners = {};
      sockets.push(this);
      if (!state.hang) setImmediate(() => this.open());
    }
    addEventListener(type, listener) {
      (this.listeners[type] ||= []).push(listener);
    }
    emit(type, event = {}) {
      for (const listener of this.listeners[type] || []) listener(event);
    }
    open() {
      this.readyState = 1;
      this.emit('open');
    }
    send(raw) {
      const message = JSON.parse(raw);
      this.sent.push(message);
      if (message.id !== undefined && message.method !== 'Page.screencastFrameAck') {
        setImmediate(() =>
          this.emit('message', {
            data: JSON.stringify(
              state.refuseCommands && message.method.startsWith('Input.')
                ? { id: message.id, error: { message: 'refused' } }
                : { id: message.id, result: {} },
            ),
          }),
        );
      }
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      setImmediate(() => this.emit('close'));
    }
    push(method, params) {
      this.emit('message', { data: JSON.stringify({ method, params }) });
    }
    methods() {
      return this.sent.map((message) => message.method);
    }
  }

  const devtools = {
    list: async () => records,
    onStopped(listener) {
      stopListeners.add(listener);
      return () => stopListeners.delete(listener);
    },
  };
  const screencast = createBrowserScreencast({
    devtools,
    fetch: async (url) => {
      fetched.push(url);
      if (state.discoveryFails) throw new Error('ECONNREFUSED');
      return { ok: true, status: 200, json: async () => state.targets };
    },
    WebSocket: FakeSocket,
    setTimeout(fn, ms) {
      const timer = { fn, ms, live: true };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.live = false;
    },
    retryDelays: [10, 20],
  });
  const listener = () => {
    const seen = { statuses: [], targets: [], frames: [], ended: 0 };
    return {
      seen,
      status: (value) => seen.statuses.push(value),
      target: (value) => seen.targets.push(value),
      frame: (value) => seen.frames.push(value),
      end: () => {
        seen.ended += 1;
      },
    };
  };
  return {
    screencast,
    sockets,
    fetched,
    state,
    listener,
    stop: (id) => stopListeners.forEach((fn) => fn(id)),
    // The back-off timers only: the open and command guards are longer and never fire here.
    retry: async () => {
      for (const timer of timers.filter((entry) => entry.live && entry.ms <= 20)) {
        timer.live = false;
        timer.fn();
      }
      await settle();
    },
  };
}

const frame = (sessionId, data = 'AAAA') => ({
  data,
  sessionId,
  metadata: { deviceWidth: 1280, deviceHeight: 720, offsetTop: 0, pageScaleFactor: 1 },
});

test('picks a real tab over devtools, extension and non-page targets', () => {
  const worker = {
    id: 'W',
    type: 'service_worker',
    url: 'https://x/',
    webSocketDebuggerUrl: 'ws://x',
  };
  const tools = page('D', 'devtools://devtools/bundled/inspector.html');
  const extension = page('E', 'chrome-extension://abc/popup.html');
  assert.equal(pickTarget([worker, tools, extension, page('P1'), page('P2')]).id, 'P1');
  assert.equal(pickTarget([worker, tools, extension]).id, 'D', 'any page beats none');
  assert.equal(pickTarget([worker]), null);
  assert.equal(pickTarget([page('N', 'x', { webSocketDebuggerUrl: undefined })]), null);
  assert.equal(pickTarget(undefined), null);
});

test('refuses an unknown or stopped instance before opening anything', async () => {
  const h = harness();
  await assert.rejects(h.screencast.subscribe('b-nope', {}), {
    code: 'UNKNOWN_BROWSER',
    status: 404,
  });
  await assert.rejects(h.screencast.subscribe(STOPPED.id, {}), {
    code: 'BROWSER_NOT_RUNNING',
    status: 409,
  });
  const portless = harness({ records: [{ ...RUNNING, port: null }] });
  await assert.rejects(portless.screencast.check(RUNNING.id), { code: 'BROWSER_NOT_RUNNING' });
  assert.deepEqual([h.fetched, h.sockets], [[], []]);
});

test('discovers the page on the registry port and starts a bounded jpeg screencast', async () => {
  const h = harness();
  const viewer = h.listener();
  await h.screencast.subscribe(RUNNING.id, viewer);
  assert.deepEqual(viewer.seen.statuses, [{ status: 'connecting', reason: '' }]);
  await settle();

  assert.deepEqual(h.fetched, ['http://127.0.0.1:9300/json/list']);
  assert.equal(h.sockets.length, 1);
  // Pinned to this instance's loopback port whatever host the browser reported.
  assert.equal(h.sockets[0].url, 'ws://127.0.0.1:9300/devtools/page/T1');
  assert.deepEqual(h.sockets[0].methods(), ['Page.enable', 'Page.startScreencast']);
  const start = h.sockets[0].sent[1].params;
  assert.equal(start.format, 'jpeg');
  assert.equal(start.everyNthFrame, 1);
  assert.ok(start.quality > 0 && start.quality <= 80);
  assert.ok(start.maxWidth <= 1920 && start.maxHeight <= 1200);

  assert.deepEqual(viewer.seen.statuses.at(-1), { status: 'live', reason: '' });
  assert.deepEqual(viewer.seen.targets.at(-1), {
    id: 'T1',
    title: 'Title T1',
    url: 'https://example.invalid/',
  });
});

test('acks every frame at once and fans it out to every subscriber', async () => {
  const h = harness();
  const first = h.listener();
  const second = h.listener();
  await h.screencast.subscribe(RUNNING.id, first);
  await h.screencast.subscribe(RUNNING.id, second);
  await settle();
  const [socket] = h.sockets;

  socket.push('Page.screencastFrame', frame(7, 'ZnJhbWUx'));
  // The ack went out synchronously with the frame, before any subscriber work could matter.
  assert.deepEqual(socket.sent.at(-1).method, 'Page.screencastFrameAck');
  assert.deepEqual(socket.sent.at(-1).params, { sessionId: 7 });
  socket.push('Page.screencastFrame', frame(8, 'ZnJhbWUy'));
  assert.deepEqual(socket.sent.at(-1).params, { sessionId: 8 });

  for (const viewer of [first, second]) {
    assert.deepEqual(
      viewer.seen.frames.map((entry) => entry.data),
      ['ZnJhbWUx', 'ZnJhbWUy'],
    );
    assert.deepEqual(viewer.seen.frames[0].metadata, {
      deviceWidth: 1280,
      deviceHeight: 720,
      offsetTop: 0,
      pageScaleFactor: 1,
    });
  }
  // Malformed frames and metadata never reach a viewer as junk.
  socket.push('Page.screencastFrame', { sessionId: 9 });
  socket.push('Page.screencastFrame', {
    sessionId: 10,
    data: 'eA==',
    metadata: { deviceWidth: 'x' },
  });
  assert.equal(first.seen.frames.length, 3);
  assert.deepEqual(first.seen.frames[2].metadata, {
    deviceWidth: 0,
    deviceHeight: 0,
    offsetTop: 0,
    pageScaleFactor: 1,
  });
});

test('one connection per instance, stopped when the last viewer leaves', async () => {
  const h = harness();
  const first = h.listener();
  const leaveFirst = await h.screencast.subscribe(RUNNING.id, first);
  await settle();
  h.sockets[0].push('Page.screencastFrame', frame(1, 'bGFzdA=='));

  // A late joiner is told where things stand and gets the last frame, since a still page sends none.
  const late = h.listener();
  const leaveLate = await h.screencast.subscribe(RUNNING.id, late);
  assert.equal(h.sockets.length, 1, 'the second viewer shares the connection');
  assert.equal(h.fetched.length, 1);
  assert.deepEqual(late.seen.statuses, [{ status: 'live', reason: '' }]);
  assert.equal(late.seen.frames[0].data, 'bGFzdA==');

  leaveFirst();
  leaveFirst(); // idempotent
  assert.equal(h.sockets[0].readyState, 1, 'one viewer is still watching');
  assert.ok(!h.sockets[0].methods().includes('Page.stopScreencast'));

  leaveLate();
  assert.equal(h.sockets[0].methods().at(-1), 'Page.stopScreencast');
  await settle();
  assert.equal(h.sockets[0].readyState, 3);

  // Nothing is left behind: a new viewer starts a fresh connection.
  await h.screencast.subscribe(RUNNING.id, h.listener());
  await settle();
  assert.equal(h.sockets.length, 2);
});

test('two instances stream independently', async () => {
  const h = harness();
  const a = h.listener();
  const b = h.listener();
  await h.screencast.subscribe(RUNNING.id, a);
  await h.screencast.subscribe(OTHER.id, b);
  await settle();
  assert.deepEqual(h.fetched.sort(), [
    'http://127.0.0.1:9300/json/list',
    'http://127.0.0.1:9301/json/list',
  ]);
  assert.equal(h.sockets.length, 2);
  h.sockets[0].push('Page.screencastFrame', frame(1, 'YQ=='));
  assert.equal(a.seen.frames.length, 1);
  assert.equal(b.seen.frames.length, 0);
});

test('re-attaches to another page when the target closes, with a status for the viewer', async () => {
  const h = harness({ targets: [page('T1')] });
  const viewer = h.listener();
  await h.screencast.subscribe(RUNNING.id, viewer);
  await settle();
  assert.equal(viewer.seen.statuses.at(-1).status, 'live');

  // The tab closes; the browser still has a different one.
  h.state.targets = [page('T2')];
  h.sockets[0].readyState = 3;
  h.sockets[0].emit('close');
  assert.deepEqual(viewer.seen.statuses.at(-1), { status: 'connecting', reason: 'reconnecting' });
  assert.equal(h.sockets.length, 1, 'it waits for the back-off rather than hammering');

  await h.retry();
  assert.equal(h.sockets.length, 2);
  assert.equal(h.sockets[1].url, 'ws://127.0.0.1:9300/devtools/page/T2');
  assert.deepEqual(viewer.seen.statuses.at(-1), { status: 'live', reason: '' });
  assert.equal(viewer.seen.targets.at(-1).id, 'T2');
});

test('a crashed page re-attaches the same way', async () => {
  const h = harness();
  const viewer = h.listener();
  await h.screencast.subscribe(RUNNING.id, viewer);
  await settle();
  h.sockets[0].push('Inspector.targetCrashed', {});
  assert.equal(viewer.seen.statuses.at(-1).status, 'connecting');
  await h.retry();
  assert.equal(viewer.seen.statuses.at(-1).status, 'live');
});

test('reports lost after the bounded back-off, and a returning viewer starts over', async () => {
  const h = harness();
  const viewer = h.listener();
  await h.screencast.subscribe(RUNNING.id, viewer);
  await settle();
  h.state.discoveryFails = true;
  h.sockets[0].readyState = 3;
  h.sockets[0].emit('close');
  await h.retry(); // attempt 1 fails
  await h.retry(); // attempt 2 fails: out of delays
  assert.deepEqual(viewer.seen.statuses.at(-1), { status: 'lost', reason: 'unreachable' });
  const fetches = h.fetched.length;
  await h.retry();
  assert.equal(h.fetched.length, fetches, 'it stops asking once it has said lost');

  h.state.discoveryFails = false;
  const again = h.listener();
  await h.screencast.subscribe(RUNNING.id, again);
  await settle();
  assert.equal(again.seen.statuses.at(-1).status, 'live');
  assert.equal(viewer.seen.statuses.at(-1).status, 'live', 'every viewer hears it');
});

test('a browser with no page to show is retried, not frozen', async () => {
  const h = harness({ targets: [] });
  const viewer = h.listener();
  await h.screencast.subscribe(RUNNING.id, viewer);
  await settle();
  assert.deepEqual(viewer.seen.statuses.at(-1), { status: 'connecting', reason: 'reconnecting' });
  h.state.targets = [page('T9')];
  await h.retry();
  assert.equal(viewer.seen.statuses.at(-1).status, 'live');
});

test('a page that never answers is given up on', async () => {
  const h = harness();
  h.state.hang = true;
  const viewer = h.listener();
  await h.screencast.subscribe(RUNNING.id, viewer);
  await settle();
  assert.equal(h.sockets.length, 1);
  assert.equal(viewer.seen.statuses.at(-1).status, 'connecting');
  h.sockets[0].emit('error');
  await settle();
  assert.equal(viewer.seen.statuses.at(-1).reason, 'reconnecting');
  assert.equal(h.sockets[0].readyState, 3, 'the dead socket is closed');
});

test('follows the main frame when the page navigates', async () => {
  const h = harness();
  const viewer = h.listener();
  await h.screencast.subscribe(RUNNING.id, viewer);
  await settle();
  h.sockets[0].push('Page.frameNavigated', {
    frame: { id: 'F', parentId: 'M', url: 'https://ad/' },
  });
  assert.equal(viewer.seen.targets.length, 1, 'a sub-frame is not the page');
  h.sockets[0].push('Page.frameNavigated', {
    frame: { id: 'M', url: 'https://example.invalid/next' },
  });
  assert.deepEqual(viewer.seen.targets.at(-1), {
    id: 'T1',
    title: '',
    url: 'https://example.invalid/next',
  });
});

test('tears down when the instance stops, and tells the viewers why', async () => {
  const h = harness();
  const viewer = h.listener();
  const other = h.listener();
  await h.screencast.subscribe(RUNNING.id, viewer);
  await h.screencast.subscribe(OTHER.id, other);
  await settle();

  h.stop(RUNNING.id);
  assert.deepEqual(viewer.seen.statuses.at(-1), { status: 'lost', reason: 'stopped' });
  assert.equal(viewer.seen.ended, 1);
  assert.equal(h.sockets[0].methods().at(-1), 'Page.stopScreencast');
  await settle();
  assert.equal(h.sockets[0].readyState, 3);
  await assert.rejects(
    h.screencast.input(RUNNING.id, { type: 'mouseMoved', x: 1, y: 1 }),
    { code: 'SCREENCAST_NOT_ACTIVE' },
    'the stopped instance has no session left',
  );
  // The neighbour is untouched, and an unrelated id is ignored.
  h.stop('b-unrelated');
  assert.equal(other.seen.ended, 0);
  assert.equal(other.seen.statuses.at(-1).status, 'live');

  // A stopped session must not re-attach on its own.
  await h.retry();
  assert.equal(h.sockets.length, 2);
});

test('shutdown ends every stream and closes every socket', async () => {
  const h = harness();
  const viewer = h.listener();
  await h.screencast.subscribe(RUNNING.id, viewer);
  await h.screencast.subscribe(OTHER.id, h.listener());
  await settle();
  h.screencast.close();
  await settle();
  assert.equal(viewer.seen.ended, 1);
  assert.deepEqual(
    h.sockets.map((socket) => socket.readyState),
    [3, 3],
  );
});

test('a restarted instance on a new port gets a fresh session', async () => {
  const records = [{ ...RUNNING }];
  const h = harness({ records });
  const old = h.listener();
  await h.screencast.subscribe(RUNNING.id, old);
  await settle();
  records[0].port = 9305;
  const fresh = h.listener();
  await h.screencast.subscribe(RUNNING.id, fresh);
  await settle();
  assert.equal(old.seen.ended, 1);
  assert.equal(h.fetched.at(-1), 'http://127.0.0.1:9305/json/list');
  assert.equal(h.sockets.at(-1).url, 'ws://127.0.0.1:9305/devtools/page/T1');
});

test('input is forwarded as a whitelisted CDP command, only to a live viewed browser', async () => {
  const h = harness();
  await assert.rejects(h.screencast.input(RUNNING.id, { type: 'mouseMoved', x: 1, y: 1 }), {
    code: 'SCREENCAST_NOT_ACTIVE',
    status: 409,
  });
  await h.screencast.subscribe(RUNNING.id, h.listener());
  await settle();
  const [socket] = h.sockets;

  await h.screencast.input(RUNNING.id, { type: 'mousePressed', x: 10.5, y: 20, button: 'left' });
  assert.deepEqual(socket.sent.at(-1).method, 'Input.dispatchMouseEvent');
  assert.deepEqual(socket.sent.at(-1).params, {
    type: 'mousePressed',
    x: 10.5,
    y: 20,
    button: 'left',
    clickCount: 1,
    modifiers: 0,
  });
  await h.screencast.input(RUNNING.id, { type: 'keyDown', key: 'a', text: 'a' });
  assert.equal(socket.sent.at(-1).method, 'Input.dispatchKeyEvent');
  assert.equal(socket.sent.at(-1).params.windowsVirtualKeyCode, 65);
});

test('input that is invalid is refused before it reaches the browser', async () => {
  const h = harness();
  await h.screencast.subscribe(RUNNING.id, h.listener());
  await settle();
  const before = h.sockets[0].sent.length;
  for (const event of [
    undefined,
    null,
    'click',
    [],
    { type: 'Page.navigate', url: 'https://evil.invalid' },
    { type: 'mouseMoved', x: Number.NaN, y: 1 },
    { type: 'mouseMoved', x: 1, y: 1, method: 'Runtime.evaluate' },
  ])
    await assert.rejects(
      h.screencast.input(RUNNING.id, event),
      { code: 'INVALID_INPUT', status: 400 },
      JSON.stringify(event),
    );
  assert.equal(h.sockets[0].sent.length, before);
});

test('input the browser rejects is a 502, not a silent success', async () => {
  const h = harness();
  await h.screencast.subscribe(RUNNING.id, h.listener());
  await settle();
  h.state.refuseCommands = true;
  await assert.rejects(h.screencast.input(RUNNING.id, { type: 'mouseMoved', x: 1, y: 1 }), {
    code: 'INPUT_FAILED',
    status: 502,
  });
});

test('input needs the stream to be live, not merely subscribed', async () => {
  const h = harness();
  h.state.hang = true;
  await h.screencast.subscribe(RUNNING.id, h.listener());
  await settle();
  await assert.rejects(h.screencast.input(RUNNING.id, { type: 'mouseMoved', x: 1, y: 1 }), {
    code: 'SCREENCAST_NOT_ACTIVE',
  });
});
