// browser-screencast.test.mjs — the live-view contract for the DevTools tab.
// Every collaborator is injected: no fetch, no WebSocket, no timer and no browser is real.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCREENCAST,
  createBrowserScreencast,
  viewableTargets,
} from '../backend/browser-screencast.mjs';
import { createDevtoolsStreams } from '../backend/devtools-stream.mjs';

const RUNNING = { id: 'b-0001', port: 9300, status: 'running', pid: 4001 };
const OTHER = { id: 'b-0002', port: 9301, status: 'running', pid: 4002 };
const STOPPED = { id: 'b-0003', port: 9302, status: 'stopped', pid: null };

const page = (id, url = 'https://example.invalid/', extra = {}) => ({
  id,
  type: 'page',
  title: `Title ${id}`,
  url,
  ...extra,
});
const infoOf = (target) => ({
  targetId: target.id,
  type: target.type,
  title: target.title,
  url: target.url,
});

const settle = async () => {
  for (let turn = 0; turn < 6; turn += 1) await new Promise((resolve) => setImmediate(resolve));
};

function harness({ records = [RUNNING, OTHER, STOPPED], targets = [page('T1')] } = {}) {
  const sockets = []; // page-level connections
  const browsers = []; // browser-level connections
  const fetched = [];
  const timers = [];
  const stopListeners = new Set();
  const state = {
    targets,
    discoveryFails: false,
    listFails: false,
    refuseCommands: false,
    refuseActivate: false,
    hang: false,
    extra: [], // targets only a re-read of the list reveals
  };

  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.browser = url.includes('/devtools/browser/');
      this.readyState = 0;
      this.sent = [];
      this.listeners = {};
      (this.browser ? browsers : sockets).push(this);
      if (this.browser || !state.hang) setImmediate(() => this.open());
    }
    addEventListener(type, listener) {
      (this.listeners[type] ||= []).push(listener);
    }
    emit(type, event = {}) {
      for (const listener of this.listeners[type] || []) listener(event);
    }
    open() {
      if (this.readyState === 3) return; // closed while connecting: it never opens
      this.readyState = 1;
      this.emit('open');
    }
    send(raw) {
      const message = JSON.parse(raw);
      this.sent.push(message);
      // The browser reports every open target before it answers the discovery command, in an
      // order that means nothing (here: newest first, so a wrong guess about it would show).
      if (message.method === 'Target.setDiscoverTargets')
        for (const target of [...state.targets].reverse())
          this.push('Target.targetCreated', { targetInfo: infoOf(target) });
      if (message.method === 'Target.getTargets') {
        setImmediate(() =>
          this.emit('message', {
            data: JSON.stringify({
              id: message.id,
              result: { targetInfos: [...state.targets, ...state.extra].map(infoOf) },
            }),
          }),
        );
        return;
      }
      if (message.id !== undefined && message.method !== 'Page.screencastFrameAck') {
        const refused =
          (state.refuseCommands && message.method.startsWith('Input.')) ||
          (state.refuseActivate && message.method === 'Target.activateTarget');
        setImmediate(() =>
          this.emit('message', {
            data: JSON.stringify(
              refused
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
      // The tab list is newest first, the order the real browser keeps it in.
      const body = url.endsWith('/json/list')
        ? [...state.targets].reverse()
        : { webSocketDebuggerUrl: 'ws://localhost:9222/devtools/browser/BR1' };
      if (url.endsWith('/json/list') && state.listFails) return { ok: false, status: 500 };
      return { ok: true, status: 200, json: async () => body };
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
    const seen = { statuses: [], targets: [], tabs: [], frames: [], ended: 0 };
    return {
      seen,
      status: (value) => seen.statuses.push(value),
      target: (value) => seen.targets.push(value),
      tabs: (value) => seen.tabs.push(value),
      frame: (value) => seen.frames.push(value),
      end: () => {
        seen.ended += 1;
      },
    };
  };
  // What the browser says happened, on the live browser-level connection.
  const browserEvent = (method, params) => browsers.at(-1).push(method, params);
  return {
    screencast,
    sockets,
    browsers,
    fetched,
    state,
    listener,
    stop: (id) => stopListeners.forEach((fn) => fn(id)),
    opened(target) {
      state.targets = [...state.targets, target];
      browserEvent('Target.targetCreated', { targetInfo: infoOf(target) });
    },
    changed(id, fields) {
      state.targets = state.targets.map((target) =>
        target.id === id ? { ...target, ...fields } : target,
      );
      browserEvent('Target.targetInfoChanged', {
        targetInfo: infoOf(state.targets.find((target) => target.id === id)),
      });
    },
    closed(id) {
      state.targets = state.targets.filter((target) => target.id !== id);
      browserEvent('Target.targetDestroyed', { targetId: id });
    },
    // The back-off timers only: the open and command guards are longer and never fire here.
    // The title re-read timer, the only one that long.
    tick: async () => {
      for (const timer of timers.filter((entry) => entry.live && entry.ms === 3000)) {
        timer.live = false;
        await timer.fn();
      }
      await settle();
    },
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

test('lists real tabs ahead of devtools, extension and non-page targets', () => {
  const worker = { id: 'W', type: 'service_worker', url: 'https://x/' };
  const tools = page('D', 'devtools://devtools/bundled/inspector.html');
  const extension = page('E', 'chrome-extension://abc/popup.html');
  const ids = (targets) => viewableTargets(targets).map((target) => target.id);
  assert.deepEqual(ids([worker, tools, extension, page('P1'), page('P2')]), ['P1', 'P2']);
  assert.deepEqual(ids([worker, tools, extension]), ['D', 'E'], 'any page beats none');
  assert.deepEqual(ids([worker]), []);
  assert.deepEqual(ids(undefined), []);
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
  await assert.rejects(portless.screencast.subscribe(RUNNING.id, {}), {
    code: 'BROWSER_NOT_RUNNING',
  });
  assert.deepEqual([h.fetched, h.sockets], [[], []]);
});

test('discovers the page on the registry port and starts a bounded jpeg screencast', async () => {
  const h = harness();
  const viewer = h.listener();
  await h.screencast.subscribe(RUNNING.id, viewer);
  assert.deepEqual(viewer.seen.statuses, [{ status: 'connecting', reason: '' }]);
  await settle();

  assert.deepEqual(h.fetched.sort(), [
    'http://127.0.0.1:9300/json/list',
    'http://127.0.0.1:9300/json/version',
  ]);
  // The browser-level connection is on the registry port whatever host the browser reported.
  assert.equal(h.browsers.length, 1);
  assert.equal(h.browsers[0].url, 'ws://127.0.0.1:9300/devtools/browser/BR1');
  assert.deepEqual(h.browsers[0].methods(), ['Target.setDiscoverTargets']);
  assert.deepEqual(h.browsers[0].sent[0].params, { discover: true });
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
  assert.equal(h.fetched.length, 2, 'the version and the list, once');
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
  assert.deepEqual(h.fetched.filter((url) => url.endsWith('/json/version')).sort(), [
    'http://127.0.0.1:9300/json/version',
    'http://127.0.0.1:9301/json/version',
  ]);
  assert.equal(h.sockets.length, 2);
  h.sockets[0].push('Page.screencastFrame', frame(1, 'YQ=='));
  assert.equal(a.seen.frames.length, 1);
  assert.equal(b.seen.frames.length, 0);
});

// -- quality ---------------------------------------------------------------------------------------
// A browser has one screencast whatever the number of viewers; it runs at the highest quality any of
// them wants and is restarted, on the same page link, when that changes.

const startsOf = (socket) =>
  socket.sent.filter(({ method }) => method === 'Page.startScreencast').map(({ params }) => params);
const methodsAfterEnable = (socket) =>
  socket.methods().slice(socket.methods().indexOf('Page.enable'));

test('a tile is a small, slow, low-quality screencast; full is the sharp one', async () => {
  const tile = harness();
  await tile.screencast.subscribe(RUNNING.id, tile.listener(), 'tile');
  await settle();
  assert.deepEqual(startsOf(tile.sockets[0]), [SCREENCAST.tile]);
  assert.deepEqual(SCREENCAST.tile, {
    format: 'jpeg',
    quality: 40,
    maxWidth: 480,
    maxHeight: 300,
    everyNthFrame: 2,
  });

  const full = harness();
  await full.screencast.subscribe(RUNNING.id, full.listener(), 'full');
  await settle();
  assert.deepEqual(startsOf(full.sockets[0]), [SCREENCAST.full]);
  assert.deepEqual(SCREENCAST.full, {
    format: 'jpeg',
    quality: 60,
    maxWidth: 1280,
    maxHeight: 800,
    everyNthFrame: 1,
  });
});

test('two viewers that want different qualities start it once, at the higher', async () => {
  const h = harness();
  await h.screencast.subscribe(RUNNING.id, h.listener(), 'tile');
  await h.screencast.subscribe(RUNNING.id, h.listener(), 'full');
  await settle();
  assert.deepEqual(startsOf(h.sockets[0]), [SCREENCAST.full]);
  assert.ok(!h.sockets[0].methods().includes('Page.stopScreencast'));
});

test('a viewer that wants more restarts the screencast on the same link, and leaving undoes it', async () => {
  const h = harness();
  const wall = h.listener();
  await h.screencast.subscribe(RUNNING.id, wall, 'tile');
  await settle();
  const fetches = h.fetched.length;
  const statuses = wall.seen.statuses.length;
  assert.deepEqual(startsOf(h.sockets[0]), [SCREENCAST.tile]);

  const viewer = h.listener();
  const leave = await h.screencast.subscribe(RUNNING.id, viewer, 'full');
  await settle();
  assert.deepEqual(methodsAfterEnable(h.sockets[0]), [
    'Page.enable',
    'Page.startScreencast',
    'Page.stopScreencast',
    'Page.startScreencast',
  ]);
  assert.deepEqual(startsOf(h.sockets[0]), [SCREENCAST.tile, SCREENCAST.full]);
  assert.equal(h.sockets.length, 1, 'no re-attach');
  assert.equal(h.browsers.length, 1);
  assert.equal(h.fetched.length, fetches, 'no new discovery');
  assert.equal(wall.seen.statuses.length, statuses, 'no status flicker for anybody');
  assert.equal(h.sockets[0].readyState, 1);

  leave();
  await settle();
  assert.deepEqual(startsOf(h.sockets[0]), [SCREENCAST.tile, SCREENCAST.full, SCREENCAST.tile]);
  assert.equal(h.sockets.length, 1);
  assert.equal(wall.seen.statuses.length, statuses);
});

test('a viewer changing what it wants is the same as one joining or leaving', async () => {
  const h = harness();
  const other = h.listener();
  await h.screencast.subscribe(OTHER.id, other, 'tile');
  const leave = await h.screencast.subscribe(RUNNING.id, h.listener(), 'tile');
  await settle();

  leave.setQuality('full');
  await settle();
  assert.deepEqual(startsOf(h.sockets[1]), [SCREENCAST.tile, SCREENCAST.full]);
  assert.deepEqual(startsOf(h.sockets[0]), [SCREENCAST.tile], 'another browser is untouched');

  leave.setQuality('full'); // already so
  leave.setQuality('huge'); // not a level
  leave.setQuality(undefined);
  await settle();
  assert.equal(startsOf(h.sockets[1]).length, 2);

  leave.setQuality('tile');
  await settle();
  assert.deepEqual(startsOf(h.sockets[1]).at(-1), SCREENCAST.tile);
  leave();
  leave.setQuality('full'); // a viewer that left cannot change anything
  await settle();
  assert.equal(startsOf(h.sockets[1]).length, 3);
});

test('no frame made with the old settings is delivered once the quality changed', async () => {
  const h = harness();
  const wall = h.listener();
  const leave = await h.screencast.subscribe(RUNNING.id, wall, 'tile');
  await settle();
  const [socket] = h.sockets;
  socket.push('Page.screencastFrame', frame(1, 'dGlsZQ=='));
  assert.equal(wall.seen.frames.length, 1);

  leave.setQuality('full');
  // Chromium still had frames in flight: each is acked (it sends nothing more until it is) and
  // dropped, until the answer to the stop says the old screencast is over.
  socket.push('Page.screencastFrame', frame(2, 'b2xk'));
  assert.deepEqual(socket.sent.at(-1).params, { sessionId: 2 }, 'acked');
  assert.equal(wall.seen.frames.length, 1, 'but not delivered');
  await settle();
  socket.push('Page.screencastFrame', frame(3, 'ZnVsbA=='));
  assert.deepEqual(
    wall.seen.frames.map((entry) => entry.data),
    ['dGlsZQ==', 'ZnVsbA=='],
  );

  // A late joiner is handed the last frame that was delivered, never a dropped one.
  const late = h.listener();
  await h.screencast.subscribe(RUNNING.id, late, 'tile');
  assert.equal(late.seen.frames[0].data, 'ZnVsbA==');
});

test('a late tile gets the last frame as it is, even when a viewer has the browser at full size', async () => {
  const h = harness();
  await h.screencast.subscribe(RUNNING.id, h.listener(), 'full');
  await settle();
  h.sockets[0].push('Page.screencastFrame', frame(1, 'YmlnZnJhbWU='));
  const tile = h.listener();
  await h.screencast.subscribe(RUNNING.id, tile, 'tile');
  // The picture is simply scaled by whoever draws it; the screencast stays at full while watched.
  assert.equal(tile.seen.frames[0].data, 'YmlnZnJhbWU=');
  await settle();
  assert.equal(startsOf(h.sockets[0]).length, 1);
});

test('a quality asked for while the page attaches is the one it starts with', async () => {
  const h = harness();
  const wall = h.listener();
  const leave = await h.screencast.subscribe(RUNNING.id, wall, 'tile');
  leave.setQuality('full'); // before the browser has answered at all
  await settle();
  assert.deepEqual(startsOf(h.sockets[0]), [SCREENCAST.full]);
  assert.ok(!h.sockets[0].methods().includes('Page.stopScreencast'));
});

test('a tab switch attaches the new tab at the quality now wanted', async () => {
  const h = harness({ targets: [page('T1'), page('T2')] });
  await h.screencast.subscribe(RUNNING.id, h.listener(), 'tile');
  const leave = await h.screencast.subscribe(RUNNING.id, h.listener(), 'full');
  await settle();
  leave();
  await settle();
  assert.deepEqual(startsOf(h.sockets[0]).at(-1), SCREENCAST.tile);
  await h.screencast.selectTab(RUNNING.id, 'T1');
  await settle();
  assert.equal(h.sockets.length, 2, 'a different page is a new link');
  assert.deepEqual(startsOf(h.sockets[1]), [SCREENCAST.tile]);
});

test('a link that drops while the quality changes recovers at the quality wanted', async () => {
  const h = harness();
  const wall = h.listener();
  const leave = await h.screencast.subscribe(RUNNING.id, wall, 'tile');
  await settle();
  leave.setQuality('full');
  h.sockets[0].readyState = 3;
  h.sockets[0].emit('close');
  await settle();
  assert.deepEqual(wall.seen.statuses.at(-1), { status: 'connecting', reason: 'reconnecting' });
  await h.retry();
  assert.equal(h.sockets.length, 2);
  assert.deepEqual(startsOf(h.sockets[1]), [SCREENCAST.full]);
  assert.equal(wall.seen.statuses.at(-1).status, 'live');
  // Frames flow again: the dropped link's settling did not carry over.
  h.sockets[1].push('Page.screencastFrame', frame(1, 'YQ=='));
  assert.equal(wall.seen.frames.length, 1);
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
  assert.ok(h.fetched.includes('http://127.0.0.1:9305/json/version'));
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

// -- the tab strip and switching ------------------------------------------------------------------

const watch = async (targets, viewer) => {
  const h = harness({ targets });
  const listener = viewer || h.listener();
  await h.screencast.subscribe(RUNNING.id, listener);
  await settle();
  return { h, viewer: listener };
};
const shownId = (h) => h.sockets.at(-1).url.split('/').at(-1);

test('builds the tab list from the page targets, leaving out devtools and extension pages', async () => {
  const worker = { id: 'W', type: 'service_worker', title: 'sw', url: 'https://x/' };
  const { h, viewer } = await watch([
    page('T1'),
    page('D', 'devtools://devtools/bundled/inspector.html'),
    worker,
    page('E', 'chrome-extension://abc/popup.html'),
    page('T2', 'https://example.invalid/two'),
  ]);
  assert.deepEqual(viewer.seen.tabs.at(-1), {
    mode: 'auto',
    tabs: [
      { id: 'T1', title: 'Title T1', url: 'https://example.invalid/', current: false },
      { id: 'T2', title: 'Title T2', url: 'https://example.invalid/two', current: true },
    ],
  });
  assert.equal(shownId(h), 'T2', 'auto shows the newest');

  // When nothing else is open, the internal pages are all there is to show.
  const only = await watch([page('D', 'devtools://devtools/bundled/inspector.html')]);
  assert.deepEqual(
    only.viewer.seen.tabs.at(-1).tabs.map((tab) => tab.id),
    ['D'],
  );
});

test('auto follows the newest tab opened, on the same stream, without stealing focus', async () => {
  const { h, viewer } = await watch([page('T1')]);
  const first = h.sockets[0];
  first.push('Page.screencastFrame', frame(1, 'b2xk'));
  const before = viewer.seen.frames.length;

  h.opened(page('T2', 'https://example.invalid/two'));
  // At once: the old screencast is stopped and the viewer is told it is switching.
  assert.equal(first.methods().at(-1), 'Page.stopScreencast');
  assert.deepEqual(viewer.seen.statuses.at(-1), { status: 'connecting', reason: 'switching' });
  await settle();
  assert.equal(first.readyState, 3);
  assert.equal(h.sockets.length, 2);
  assert.equal(shownId(h), 'T2');
  assert.deepEqual(h.sockets[1].methods(), ['Page.enable', 'Page.startScreencast']);
  assert.deepEqual(viewer.seen.statuses.at(-1), { status: 'live', reason: '' });
  assert.equal(viewer.seen.targets.at(-1).id, 'T2');
  assert.deepEqual(
    viewer.seen.tabs.at(-1).tabs.map(({ id, current }) => [id, current]),
    [
      ['T1', false],
      ['T2', true],
    ],
  );
  // The same subscriber saw all of it, nothing was opened twice, and the old tab's late frames
  // are not painted.
  assert.equal(h.browsers.length, 1);
  assert.equal(h.fetched.length, 2, 'no discovery again for a switch');
  first.push('Page.screencastFrame', frame(2, 'c3RhbGU='));
  assert.equal(viewer.seen.frames.length, before);
  h.sockets[1].push('Page.screencastFrame', frame(1, 'bmV3'));
  assert.equal(viewer.seen.frames.at(-1).data, 'bmV3');

  // Auto never raises a tab: it was opened in front already.
  assert.ok(!h.browsers[0].methods().includes('Target.activateTarget'));
  // A devtools page opening is not a tab to follow, and a title change is not a switch.
  h.opened(page('D', 'devtools://devtools/bundled/inspector.html'));
  h.changed('T2', { title: 'Retitled' });
  await settle();
  assert.equal(h.sockets.length, 2);
  assert.equal(viewer.seen.tabs.at(-1).tabs.find((tab) => tab.id === 'T2').title, 'Retitled');
  assert.ok(!h.browsers[0].methods().includes('Target.activateTarget'));
});

test('a tab that changes nothing visible is not announced again', async () => {
  const { h, viewer } = await watch([page('T1')]);
  const announced = viewer.seen.tabs.length;
  h.changed('T1', { title: 'Title T1' });
  h.changed('T1', { title: 'Title T1' });
  assert.equal(viewer.seen.tabs.length, announced);
  h.changed('T1', { title: 'Next' });
  assert.equal(viewer.seen.tabs.length, announced + 1);
});

test('choosing a tab pins it, brings it to the front and stops following new tabs', async () => {
  const { h, viewer } = await watch([page('T1'), page('T2')]);
  assert.equal(shownId(h), 'T2');
  const old = h.sockets[0];

  await h.screencast.selectTab(RUNNING.id, 'T1');
  const activate = h.browsers[0].sent.find(({ method }) => method === 'Target.activateTarget');
  assert.deepEqual(activate.params, { targetId: 'T1' });
  assert.equal(old.methods().at(-1), 'Page.stopScreencast');
  assert.deepEqual(viewer.seen.statuses.at(-1), { status: 'connecting', reason: 'switching' });
  await settle();
  assert.equal(shownId(h), 'T1');
  assert.deepEqual(viewer.seen.statuses.at(-1), { status: 'live', reason: '' });
  assert.equal(viewer.seen.tabs.at(-1).mode, 'pinned');
  assert.equal(viewer.seen.tabs.at(-1).tabs.find((tab) => tab.current).id, 'T1');

  // A tab opened later does not take the view away from the pinned one.
  h.opened(page('T3'));
  await settle();
  assert.equal(h.sockets.length, 2);
  assert.equal(shownId(h), 'T1');
  assert.equal(viewer.seen.tabs.at(-1).tabs.length, 3);
  assert.equal(viewer.seen.tabs.at(-1).mode, 'pinned');
});

test('choosing the tab already shown pins it without a switch', async () => {
  const { h, viewer } = await watch([page('T1'), page('T2')]);
  await h.screencast.selectTab(RUNNING.id, 'T2');
  await settle();
  assert.equal(h.sockets.length, 1, 'nothing to restart');
  assert.equal(viewer.seen.tabs.at(-1).mode, 'pinned');
  assert.equal(h.browsers[0].methods().at(-1), 'Target.activateTarget', 'it is still raised');
});

test('auto-follow returns to the newest tab, and does nothing when it is already shown', async () => {
  const { h, viewer } = await watch([page('T1'), page('T2')]);
  await h.screencast.selectTab(RUNNING.id, 'T1');
  await settle();
  await h.screencast.selectTab(RUNNING.id, null);
  assert.deepEqual(
    h.browsers[0].sent
      .filter(({ method }) => method === 'Target.activateTarget')
      .map((m) => m.params),
    [{ targetId: 'T1' }, { targetId: 'T2' }],
  );
  await settle();
  assert.equal(shownId(h), 'T2');
  assert.equal(viewer.seen.tabs.at(-1).mode, 'auto');

  const sockets = h.sockets.length;
  const activations = h.browsers[0].methods().filter((m) => m === 'Target.activateTarget').length;
  await h.screencast.selectTab(RUNNING.id, null);
  await settle();
  assert.equal(h.sockets.length, sockets);
  assert.equal(
    h.browsers[0].methods().filter((m) => m === 'Target.activateTarget').length,
    activations,
  );
});

test('a pinned tab that closes falls back to the newest and says so', async () => {
  const { h, viewer } = await watch([page('T1'), page('T2')]);
  await h.screencast.selectTab(RUNNING.id, 'T1');
  await settle();
  h.opened(page('T3'));

  h.closed('T1');
  assert.deepEqual(viewer.seen.statuses.at(-1), { status: 'connecting', reason: 'switching' });
  await settle();
  assert.equal(shownId(h), 'T3');
  assert.deepEqual(viewer.seen.statuses.at(-1), { status: 'live', reason: 'tab-closed' });
  assert.equal(viewer.seen.tabs.at(-1).mode, 'auto');
  assert.deepEqual(
    viewer.seen.tabs.at(-1).tabs.map((tab) => tab.id),
    ['T2', 'T3'],
  );

  // The next choice clears the note, and the note does not come back with a later reconnect.
  await h.screencast.selectTab(RUNNING.id, 'T2');
  await settle();
  assert.deepEqual(viewer.seen.statuses.at(-1), { status: 'live', reason: '' });
});

test('a pinned tab whose page socket closes first still falls back, through the back-off', async () => {
  const { h, viewer } = await watch([page('T1'), page('T2')]);
  await h.screencast.selectTab(RUNNING.id, 'T1');
  await settle();
  // The tab closes: its own socket drops before any target event, and the browser forgets it.
  h.state.targets = h.state.targets.filter((target) => target.id !== 'T1');
  h.sockets.at(-1).readyState = 3;
  h.sockets.at(-1).emit('close');
  assert.deepEqual(viewer.seen.statuses.at(-1), { status: 'connecting', reason: 'reconnecting' });
  await h.retry();
  assert.equal(shownId(h), 'T2');
  assert.deepEqual(viewer.seen.statuses.at(-1), { status: 'live', reason: 'tab-closed' });
  assert.equal(viewer.seen.tabs.at(-1).mode, 'auto');
});

test('when the shown tab closes and none is left, it retries instead of freezing', async () => {
  const { h, viewer } = await watch([page('T1')]);
  h.closed('T1');
  h.sockets[0].readyState = 3;
  h.sockets[0].emit('close');
  assert.equal(viewer.seen.statuses.at(-1).reason, 'reconnecting');
  h.state.targets = [page('T9')];
  await h.retry();
  assert.equal(shownId(h), 'T9');
  assert.equal(viewer.seen.statuses.at(-1).status, 'live');
});

test('a selection must be a tab the browser reported', async () => {
  const worker = { id: 'W', type: 'service_worker', title: 'sw', url: 'https://x/' };
  const { h } = await watch([
    page('T1'),
    page('T2'),
    page('D', 'devtools://devtools/bundled/inspector.html'),
    worker,
  ]);
  const before = h.browsers[0].sent.length;
  for (const targetId of ['NOPE', 'D', 'W', 'ws://127.0.0.1:1/devtools/page/T1'])
    await assert.rejects(
      h.screencast.selectTab(RUNNING.id, targetId),
      { code: 'UNKNOWN_TAB', status: 404 },
      targetId,
    );
  for (const targetId of [undefined, '', 7, {}, ['T1'], 'x'.repeat(200)])
    await assert.rejects(
      h.screencast.selectTab(RUNNING.id, targetId),
      { code: 'INVALID_TAB', status: 400 },
      String(targetId),
    );
  await assert.rejects(h.screencast.selectTab('b-not-viewed', 'T1'), {
    code: 'SCREENCAST_NOT_ACTIVE',
    status: 409,
  });
  assert.equal(h.browsers[0].sent.length, before, 'nothing reached the browser');
  assert.equal(h.sockets.length, 1);

  // A tab that has closed is no longer a valid choice.
  h.closed('T1');
  await assert.rejects(h.screencast.selectTab(RUNNING.id, 'T1'), { code: 'UNKNOWN_TAB' });
});

test('a selection needs a browser being viewed, not one that was left', async () => {
  const h = harness();
  const leave = await h.screencast.subscribe(RUNNING.id, h.listener());
  await settle();
  leave();
  await assert.rejects(h.screencast.selectTab(RUNNING.id, 'T1'), { code: 'SCREENCAST_NOT_ACTIVE' });
});

test('a switch that cannot raise the tab still switches', async () => {
  const { h } = await watch([page('T1'), page('T2')]);
  h.state.refuseActivate = true;
  await h.screencast.selectTab(RUNNING.id, 'T1');
  await settle();
  assert.equal(shownId(h), 'T1');
});

test('rapid switches leave exactly one screencast running', async () => {
  const { h, viewer } = await watch([page('T1'), page('T2'), page('T3')]);
  h.screencast.selectTab(RUNNING.id, 'T1');
  h.screencast.selectTab(RUNNING.id, 'T2');
  await h.screencast.selectTab(RUNNING.id, 'T1');
  await settle();
  const running = h.sockets.filter((socket) => socket.readyState === 1);
  assert.equal(running.length, 1);
  assert.equal(running[0].url.split('/').at(-1), 'T1');
  assert.equal(viewer.seen.statuses.at(-1).status, 'live');
  assert.equal(viewer.seen.targets.at(-1).id, 'T1');
  for (const socket of h.sockets.filter((entry) => entry !== running[0]))
    assert.ok(socket.readyState === 3 || socket.readyState === 0, 'the others were let go');
});

test('input never lands on another tab, nor while a switch is in progress', async () => {
  const { h } = await watch([page('T1'), page('T2')]);
  const event = { type: 'mouseMoved', x: 1, y: 1 };
  await h.screencast.input(RUNNING.id, event, 'T2');
  assert.equal(h.sockets[0].sent.at(-1).method, 'Input.dispatchMouseEvent');
  await h.screencast.input(RUNNING.id, event); // the id is optional

  await h.screencast.selectTab(RUNNING.id, 'T1');
  // Mid-switch: the stream is connecting, so there is nothing to deliver to.
  await assert.rejects(h.screencast.input(RUNNING.id, event, 'T1'), {
    code: 'SCREENCAST_NOT_ACTIVE',
    status: 409,
  });
  await settle();
  const old = h.sockets[0].sent.length;
  // Live again on T1: input for the tab that was shown before is refused.
  await assert.rejects(h.screencast.input(RUNNING.id, event, 'T2'), {
    code: 'TAB_CHANGED',
    status: 409,
  });
  await assert.rejects(h.screencast.input(RUNNING.id, event, null), { code: 'TAB_CHANGED' });
  assert.equal(h.sockets[0].sent.length, old);
  assert.equal(h.sockets[1].methods().includes('Input.dispatchMouseEvent'), false);
  await h.screencast.input(RUNNING.id, event, 'T1');
  assert.equal(h.sockets[1].sent.at(-1).method, 'Input.dispatchMouseEvent');
});

test('the browser-level connection ends with the last viewer, with the page one', async () => {
  const h = harness();
  const leaveFirst = await h.screencast.subscribe(RUNNING.id, h.listener());
  const leaveSecond = await h.screencast.subscribe(RUNNING.id, h.listener());
  await settle();
  assert.equal(h.browsers.length, 1, 'one per instance, not per viewer');
  leaveFirst();
  assert.equal(h.browsers[0].readyState, 1);
  leaveSecond();
  await settle();
  assert.equal(h.browsers[0].readyState, 3);
  assert.equal(h.sockets[0].readyState, 3);

  // Nothing carries over: a new viewer has no pin, and starts its own connections.
  const again = h.listener();
  await h.screencast.subscribe(RUNNING.id, again);
  await settle();
  assert.equal(h.browsers.length, 2);
  assert.equal(again.seen.tabs.at(-1).mode, 'auto');
});

test('the browser-level connection ends when the instance stops or the service shuts down', async () => {
  const h = harness();
  await h.screencast.subscribe(RUNNING.id, h.listener());
  await h.screencast.subscribe(OTHER.id, h.listener());
  await settle();
  h.stop(RUNNING.id);
  await settle();
  assert.deepEqual(
    h.browsers.map((socket) => socket.readyState),
    [3, 1],
  );
  h.screencast.close();
  await settle();
  assert.deepEqual(
    h.browsers.map((socket) => socket.readyState),
    [3, 3],
  );
  // A stopped session does not react to a late event.
  h.sockets[0].emit('close');
  await h.retry();
  assert.equal(h.sockets.length, 2);
});

test('a browser-level connection that drops starts the whole attachment over', async () => {
  const { h, viewer } = await watch([page('T1')]);
  h.browsers[0].readyState = 3;
  h.browsers[0].emit('close');
  assert.deepEqual(viewer.seen.statuses.at(-1), { status: 'connecting', reason: 'reconnecting' });
  assert.equal(h.sockets[0].readyState, 3, 'the page connection is let go too');
  await h.retry();
  assert.equal(h.browsers.length, 2);
  assert.equal(h.sockets.length, 2);
  assert.equal(viewer.seen.statuses.at(-1).status, 'live');
});

test('tab discovery that fails is retried like a page that does not answer', async () => {
  const h = harness();
  const viewer = h.listener();
  h.state.discoveryFails = true;
  await h.screencast.subscribe(RUNNING.id, viewer);
  await settle();
  assert.ok(h.fetched.length >= 1);
  assert.deepEqual(viewer.seen.statuses.at(-1), { status: 'connecting', reason: 'reconnecting' });
  assert.equal(h.browsers.length, 0);
  h.state.discoveryFails = false;
  await h.retry();
  assert.equal(viewer.seen.statuses.at(-1).status, 'live');
});

test('a late joiner is told the tabs along with the state', async () => {
  const { h, viewer } = await watch([page('T1'), page('T2')]);
  await h.screencast.selectTab(RUNNING.id, 'T1');
  await settle();
  const late = h.listener();
  await h.screencast.subscribe(RUNNING.id, late);
  assert.equal(h.browsers.length, 1);
  assert.deepEqual(late.seen.tabs, [viewer.seen.tabs.at(-1)]);
  assert.equal(late.seen.tabs[0].mode, 'pinned');
  assert.deepEqual(late.seen.statuses, [{ status: 'live', reason: '' }]);
  // Every viewer hears a change, not only the one that made it.
  h.opened(page('T3'));
  assert.equal(late.seen.tabs.at(-1).tabs.length, 3);
  assert.equal(viewer.seen.tabs.at(-1).tabs.length, 3);
});

test('what a page says about its tab is cleaned and capped before a viewer sees it', async () => {
  const many = Array.from({ length: 30 }, (_, index) => page(`M${index}`));
  const { h, viewer } = await watch([
    page('First', 'https://example.invalid/', { title: 'a\u0000b\u001b[31mc\nd\u0085e' }),
    ...many,
  ]);
  // The newest is shown, the strip holds the most recent 20, and the oldest are left off.
  const { tabs } = viewer.seen.tabs.at(-1);
  assert.equal(tabs.length, 20);
  assert.deepEqual(
    tabs.map((tab) => tab.id),
    many.slice(10).map((tab) => tab.id),
  );
  assert.ok(tabs.at(-1).current);

  // Pinning an old one keeps it in the strip even though it is beyond the cap.
  await h.screencast.selectTab(RUNNING.id, 'First');
  await settle();
  const pinned = viewer.seen.tabs.at(-1).tabs;
  assert.equal(pinned.length, 20);
  assert.equal(pinned[0].id, 'First');
  assert.equal(pinned[0].title, 'a b [31mc d e');
  assert.ok(pinned.every((tab) => !/\p{Cc}/u.test(tab.title + tab.url + tab.id)));

  h.changed('M29', { title: 't'.repeat(1000), url: `https://example.invalid/${'u'.repeat(2000)}` });
  const long = viewer.seen.tabs.at(-1).tabs.at(-1);
  assert.equal(long.title.length, 120);
  assert.equal(long.url.length, 500);

  // Neither a hostile id nor a flood of tabs gets in: ids over the cap are ignored, and what is
  // remembered is bounded.
  h.opened(page('x'.repeat(500)));
  assert.ok(!JSON.stringify(viewer.seen.tabs.at(-1)).includes('xxxxxxxxxx'));
  for (let index = 0; index < 250; index += 1) h.opened(page(`Z${index}`));
  await assert.rejects(h.screencast.selectTab(RUNNING.id, 'M5'), { code: 'UNKNOWN_TAB' });
  await h.screencast.selectTab(RUNNING.id, 'Z249');
});

test('the order tabs were opened in comes from the browser list, not from how they are announced', async () => {
  // The fake announces newest first; the list says the same, newest first, and auto takes the
  // newest of them: T3, not the first announced.
  const { h, viewer } = await watch([page('T1'), page('T2'), page('T3')]);
  assert.equal(shownId(h), 'T3');
  assert.deepEqual(
    viewer.seen.tabs.at(-1).tabs.map((tab) => tab.id),
    ['T1', 'T2', 'T3'],
  );
  // Without a usable list, a tab still gets in, in the order it was announced.
  const bare = harness({ targets: [page('T1'), page('T2')] });
  bare.state.listFails = true;
  await bare.screencast.subscribe(RUNNING.id, bare.listener());
  await settle();
  assert.equal(bare.sockets.length, 1);
});

test('what was known keeps its order across a reconnect, and a tab opened meanwhile is newest', async () => {
  const { h, viewer } = await watch([page('T1'), page('T2')]);
  await h.screencast.selectTab(RUNNING.id, 'T1');
  await settle();
  h.opened(page('T3'));
  h.browsers[0].readyState = 3;
  h.browsers[0].emit('close');
  h.state.targets = [...h.state.targets, page('T4')]; // opened while the connection was down
  h.state.targets = h.state.targets.filter((target) => target.id !== 'T2'); // and one closed
  await h.retry();
  assert.deepEqual(
    viewer.seen.tabs.at(-1).tabs.map((tab) => tab.id),
    ['T1', 'T3', 'T4'],
  );
  assert.equal(viewer.seen.tabs.at(-1).mode, 'pinned', 'the pin survives a reconnect');
  assert.equal(shownId(h), 'T1');
  await h.screencast.selectTab(RUNNING.id, null);
  await settle();
  assert.equal(shownId(h), 'T4');
});

test('titles are re-read while the browser is watched, because Chromium does not announce them', async () => {
  const { h, viewer } = await watch([page('T1'), page('T2')]);
  const announced = viewer.seen.tabs.length;
  // A page retitles itself: no event reaches the browser-level connection.
  h.state.targets = h.state.targets.map((target) =>
    target.id === 'T1' ? { ...target, title: 'Typed later' } : target,
  );
  h.state.extra = [page('Stray')]; // a tab only the re-read knows: it is not added from there
  await h.tick();
  assert.ok(h.browsers[0].methods().includes('Target.getTargets'));
  assert.equal(viewer.seen.tabs.length, announced + 1);
  const { tabs } = viewer.seen.tabs.at(-1);
  assert.equal(tabs.find((tab) => tab.id === 'T1').title, 'Typed later');
  assert.deepEqual(
    tabs.map((tab) => tab.id),
    ['T1', 'T2'],
  );
  assert.equal(h.sockets.length, 1, 'a new title is not a switch');

  // It goes on while watched and quietly changes nothing when nothing changed.
  await h.tick();
  assert.equal(viewer.seen.tabs.length, announced + 1);
  assert.equal(h.browsers[0].methods().filter((m) => m === 'Target.getTargets').length, 2);
});

test('the title re-read stops with the last viewer and while disconnected', async () => {
  const h = harness();
  const leave = await h.screencast.subscribe(RUNNING.id, h.listener());
  await settle();
  leave();
  await h.tick();
  assert.ok(!h.browsers[0].methods().includes('Target.getTargets'));

  const again = harness();
  await again.screencast.subscribe(RUNNING.id, again.listener());
  await settle();
  again.browsers[0].readyState = 3;
  again.browsers[0].emit('close');
  await again.tick();
  assert.ok(!again.browsers[0].methods().includes('Target.getTargets'));
});

// -- through the shared stream -----------------------------------------------------------------------
// The stream layer multiplexes onto these sessions: one CDP connection per browser, whoever is
// watching it and however many streams they are on.

function wired(options) {
  const h = harness(options);
  const hub = createDevtoolsStreams({ screencast: h.screencast });
  const open = () => {
    const sink = {
      messages: [],
      ended: 0,
      send: (event, payload) => !sink.messages.push([event, payload]),
      end: () => {
        sink.ended += 1;
      },
    };
    return { sink, handle: hub.open(sink) };
  };
  return { h, hub, open };
}

test('streams on one browser share its connection, which runs at the highest quality of them', async () => {
  const { h, hub, open } = wired();
  const wall = open();
  const viewer = open();
  await hub.subscribe(wall.handle.id, RUNNING.id, 'tile');
  await hub.subscribe(wall.handle.id, OTHER.id, 'tile');
  await settle();
  assert.deepEqual(startsOf(h.sockets[0]), [SCREENCAST.tile]);
  assert.deepEqual(startsOf(h.sockets[1]), [SCREENCAST.tile]);

  await hub.subscribe(viewer.handle.id, RUNNING.id, 'full');
  await settle();
  assert.equal(h.sockets.length, 2, 'a second stream shares the session');
  assert.deepEqual(startsOf(h.sockets[0]), [SCREENCAST.tile, SCREENCAST.full]);
  assert.deepEqual(startsOf(h.sockets[1]), [SCREENCAST.tile], 'the other browser stays a tile');

  h.sockets[0].push('Page.screencastFrame', frame(1, 'ZnVsbA=='));
  h.sockets[1].push('Page.screencastFrame', frame(1, 'dGlsZQ=='));
  const framed = (entry) =>
    entry.sink.messages
      .filter(([event]) => event === 'frame')
      .map(([, body]) => [body.id, body.data]);
  assert.deepEqual(framed(wall), [
    [RUNNING.id, 'ZnVsbA=='],
    [OTHER.id, 'dGlsZQ=='],
  ]);
  assert.deepEqual(framed(viewer), [[RUNNING.id, 'ZnVsbA==']]);

  // The viewer's stream goes away: that browser drops back to a tile, and nothing else is touched.
  viewer.handle.close();
  await settle();
  assert.deepEqual(startsOf(h.sockets[0]).at(-1), SCREENCAST.tile);
  assert.equal(h.sockets[0].readyState, 1);
});

test('closing the last stream of a browser stops its screencast and closes its links', async () => {
  const { h, hub, open } = wired();
  const wall = open();
  await hub.subscribe(wall.handle.id, RUNNING.id, 'tile');
  await hub.subscribe(wall.handle.id, OTHER.id, 'tile');
  await settle();
  wall.handle.close();
  await settle();
  for (const socket of h.sockets) {
    assert.equal(socket.methods().at(-1), 'Page.stopScreencast');
    assert.equal(socket.readyState, 3);
  }
  assert.ok(h.browsers.every((socket) => socket.readyState === 3));
});

test('an instance that stops is announced on the stream, torn down, and may be watched again', async () => {
  const { h, hub, open } = wired();
  const wall = open();
  await hub.subscribe(wall.handle.id, RUNNING.id, 'tile');
  await hub.subscribe(wall.handle.id, OTHER.id, 'tile');
  await settle();

  h.stop(RUNNING.id);
  const statuses = wall.sink.messages.filter(([event]) => event === 'status');
  assert.deepEqual(statuses.at(-1), [
    'status',
    { id: RUNNING.id, status: 'lost', reason: 'stopped' },
  ]);
  assert.equal(h.sockets[0].methods().at(-1), 'Page.stopScreencast');
  await settle();
  assert.equal(h.sockets[0].readyState, 3);
  assert.equal(h.sockets[1].readyState, 1, 'the neighbour is untouched');
  assert.equal(wall.sink.ended, 0, 'the stream itself carries on');

  // A new subscription to the same browser starts afresh.
  await hub.subscribe(wall.handle.id, RUNNING.id, 'tile');
  await settle();
  assert.equal(h.sockets.length, 3);
  assert.deepEqual(startsOf(h.sockets[2]), [SCREENCAST.tile]);
});
