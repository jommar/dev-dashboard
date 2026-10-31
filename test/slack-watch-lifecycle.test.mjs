import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { OTHER, SESSION_A, flush, tsAt, watchFixture } from './slack-watch-fixture.mjs';

const ONE_HOUR_MS = 3_600_000;
const WRITE_METHODS = new Set(['renameSync', 'writeFileSync', 'appendFileSync', 'writeSync']);

// A watched thread whose newest message is another user's and newer than the attach time,
// so a tick that runs to the end would write an inbox line.
async function watchWithNewMessage(f, index) {
  const threadTs = tsAt(-300, 100 + index);
  return f.watch({
    threadTs,
    sessionIds: [SESSION_A],
    messages: [
      { ts: threadTs, user: OTHER },
      { ts: tsAt(10 + index), user: OTHER },
    ],
  });
}

const SERVER_SOURCE = fs.readFileSync(
  fileURLToPath(new URL('../backend/server.mjs', import.meta.url)),
  'utf8',
);

// The text between the braces of the arrow function handed to `server.listen(`, or null.
function listenCallbackBody(source) {
  const listenAt = source.indexOf('server.listen(');
  const arrowAt = listenAt === -1 ? -1 : source.indexOf('=> {', listenAt);
  if (arrowAt === -1) return null;
  const openAt = arrowAt + '=> '.length;
  let depth = 0;
  for (let index = openAt; index < source.length; index++) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}' && --depth === 0) return source.slice(openAt, index + 1);
  }
  return null;
}

const watchDirectoryWrites = (f) =>
  f.recorder.calls.filter(
    (call) =>
      WRITE_METHODS.has(call.method) &&
      call.args.some((arg) => String(arg).startsWith(f.paths.watchDirectory)),
  );

test('building the handler starts no timer and creates none', async (t) => {
  const f = await watchFixture(t, { http: true });
  assert.equal(f.timers.pending(), 0, 'the fixture handler left no timer pending');
  assert.equal(f.http.handler.slackWatcher, f.watcher, 'the handler exposes the injected watcher');

  const { createHttpHandler } = await import('../backend/http-app.mjs');
  const setTimeoutSpy = t.mock.method(globalThis, 'setTimeout');
  const setIntervalSpy = t.mock.method(globalThis, 'setInterval');
  let built;
  try {
    built = createHttpHandler({
      settings: f.settings,
      manager: { ...f.http.manager },
      integrations: { slack: f.slack, slackWatchStore: f.store, claudeSessions: f.sessions },
    });
  } finally {
    setTimeoutSpy.mock.restore();
    setIntervalSpy.mock.restore();
  }
  t.after(() => built?.close?.());
  assert.equal(setTimeoutSpy.mock.callCount(), 0, 'createHttpHandler called setTimeout');
  assert.equal(setIntervalSpy.mock.callCount(), 0, 'createHttpHandler called setInterval');
  assert.equal(
    typeof built.slackWatcher?.start,
    'function',
    'a watcher is built from the injected parts when none is given',
  );
  assert.doesNotThrow(() => built.close(), 'closing a handler whose watcher never started');
});

test('the server start wiring starts the watcher: one timer with a readable Claude home', async (t) => {
  const f = await watchFixture(t, { http: true });
  const { startSlackWatcher } = await import('../backend/server.mjs');
  assert.equal(typeof startSlackWatcher, 'function');
  assert.equal(f.timers.pending(), 0);
  await startSlackWatcher(f.http.handler);
  assert.equal(f.timers.pending(), 1);
});

test('the server start path calls startSlackWatcher(handler) inside the server.listen callback', () => {
  const callbackBody = listenCallbackBody(SERVER_SOURCE);
  assert.notEqual(callbackBody, null, 'server.mjs hands server.listen a callback');
  assert.match(callbackBody, /\bstartSlackWatcher\(handler\);/);
});

test('the server start wiring starts no timer without a Claude home', async (t) => {
  const f = await watchFixture(t, { http: true, claudeHome: false });
  const { startSlackWatcher } = await import('../backend/server.mjs');
  assert.equal(typeof startSlackWatcher, 'function');
  await startSlackWatcher(f.http.handler);
  assert.equal(f.timers.pending(), 0);
});

test('handler close clears the pending timer, is repeatable and no tick runs afterwards', async (t) => {
  const f = await watchFixture(t, { http: true });
  const { startSlackWatcher } = await import('../backend/server.mjs');
  await watchWithNewMessage(f, 0);
  await startSlackWatcher(f.http.handler);
  assert.equal(f.timers.pending(), 1);

  f.http.handler.close();
  await flush();
  assert.equal(f.timers.pending(), 0, 'close cleared the timer');
  assert.doesNotThrow(() => f.http.handler.close(), 'a second close is harmless');

  await f.timers.advance(ONE_HOUR_MS);
  assert.equal(f.fakeReader.calls.length, 0, 'no tick ran after close');
  assert.equal(f.timers.pending(), 0);
  assert.equal(f.totalLines(), 0);
  assert.deepEqual(f.timers.escapes, []);
});

test('handler close abandons an in-flight tick: no inbox line, no map write, no later read', async (t) => {
  const f = await watchFixture(t, { http: true });
  for (const index of [0, 1, 2, 3]) await watchWithNewMessage(f, index);
  const mapBefore = f.mapText();
  const hold = f.fakeReader.hold();

  const tick = f.watcher.tickOnce();
  tick.then(
    () => {},
    () => {},
  );
  await flush();
  const readsWhileHeld = f.fakeReader.calls.length;
  assert.ok(
    readsWhileHeld >= 1 && readsWhileHeld < 4,
    `the tick is mid-read with at most 3 reads in flight, saw ${readsWhileHeld}`,
  );

  f.http.handler.close();
  f.recorder.clearCalls();
  hold.release();
  await flush(50);
  await f.timers.advance(ONE_HOUR_MS);

  assert.equal(f.totalLines(), 0, 'no inbox line after close');
  assert.equal(f.mapText(), mapBefore, 'map bytes unchanged');
  assert.deepEqual(watchDirectoryWrites(f), [], 'no write into the watch directory after close');
  assert.equal(f.fakeReader.calls.length, readsWhileHeld, 'no further Slack read after close');
  assert.equal(f.timers.pending(), 0, 'the abandoned tick did not re-arm a timer');
  assert.deepEqual(f.timers.escapes, []);
});

test('shutdownServer clears the timer and a second shutdown or close does not throw', async (t) => {
  const f = await watchFixture(t, { http: true });
  const { startSlackWatcher, shutdownServer } = await import('../backend/server.mjs');
  assert.equal(typeof shutdownServer, 'function');
  await watchWithNewMessage(f, 0);
  await startSlackWatcher(f.http.handler);
  assert.equal(f.timers.pending(), 1);

  const { server, manager, handler } = f.http;
  await shutdownServer({ server, manager, handler, timeoutMs: 100 });
  assert.equal(server.listening, false);
  assert.equal(f.timers.pending(), 0, 'shutdown cleared the timer');

  await assert.doesNotReject(shutdownServer({ server, manager, handler, timeoutMs: 100 }));
  assert.doesNotThrow(() => handler.close());

  await f.timers.advance(ONE_HOUR_MS);
  assert.equal(f.fakeReader.calls.length, 0, 'no tick ran after shutdown');
  assert.equal(f.timers.pending(), 0, 'nothing is left pending after shutdown');
});
