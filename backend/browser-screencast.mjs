// browser-screencast.mjs — watch (and optionally drive) a debug browser from inside the dashboard.
//
// One CDP connection per instance, shared by every viewer: opened on the first subscriber,
// closed when the last one leaves or the browser stops. Chromium pushes `Page.screencastFrame`
// events; each is acked at once (it sends nothing more until it is) and fanned out to the
// subscribers. Input goes back through parseInputEvent, so a viewer can only ever send the
// handful of whitelisted mouse and key commands, never an arbitrary CDP method.
//
// Only ever talks to 127.0.0.1. Node's built-in `fetch` and `WebSocket` are the defaults, and
// every collaborator is injectable so a test binds nothing.

import { fail } from './browser-devtools.mjs';
import { parseInputEvent } from './screencast-input.mjs';

const HOST = '127.0.0.1';
const RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000];
const DISCOVERY_TIMEOUT_MS = 2000;
const OPEN_TIMEOUT_MS = 4000;
const COMMAND_TIMEOUT_MS = 3000;
const SCREENCAST = {
  format: 'jpeg',
  quality: 60,
  maxWidth: 1280,
  maxHeight: 800,
  everyNthFrame: 1,
};
const OPEN = 1; // WebSocket.OPEN
const NOT_A_VIEW = /^(devtools|chrome-extension):/;

// The page worth showing: a real tab, not DevTools or an extension page, else any page at all.
export function pickTarget(targets) {
  const pages = (Array.isArray(targets) ? targets : []).filter(
    (target) => target?.type === 'page' && typeof target.webSocketDebuggerUrl === 'string',
  );
  return pages.find((target) => !NOT_A_VIEW.test(String(target.url || ''))) || pages[0] || null;
}

// The debugger URL as the browser reported it, pinned to this instance's own loopback port.
function socketUrl(target, port) {
  const url = new URL(target.webSocketDebuggerUrl);
  url.protocol = 'ws:';
  url.hostname = HOST;
  url.port = String(port);
  return url.href;
}

const finite = (value) => (Number.isFinite(value) ? value : 0);

function frameOf(params) {
  const { deviceWidth, deviceHeight, offsetTop, pageScaleFactor } = params.metadata || {};
  return {
    data: params.data,
    metadata: {
      deviceWidth: finite(deviceWidth),
      deviceHeight: finite(deviceHeight),
      offsetTop: finite(offsetTop),
      pageScaleFactor: finite(pageScaleFactor) || 1,
    },
  };
}

export function createBrowserScreencast({
  devtools,
  fetch = globalThis.fetch,
  WebSocket = globalThis.WebSocket,
  setTimeout = globalThis.setTimeout,
  clearTimeout = globalThis.clearTimeout,
  retryDelays = RETRY_DELAYS_MS,
} = {}) {
  const sessions = new Map();

  // The instance a viewer may attach to: known, running and with a debugging port.
  async function resolveInstance(id) {
    const record = (await devtools.list()).find((entry) => entry.id === id);
    if (!record) throw fail('UNKNOWN_BROWSER', 'Unknown browser.', 404);
    if (record.status !== 'running' || !Number.isInteger(record.port))
      throw fail('BROWSER_NOT_RUNNING', 'That browser is not running.', 409);
    return record;
  }

  function tell(session, event, payload) {
    for (const subscription of [...session.subscriptions]) {
      try {
        subscription.listener[event]?.(payload);
      } catch {}
    }
  }

  function setStatus(session, status, reason = '') {
    if (session.status === status && session.reason === reason) return;
    session.status = status;
    session.reason = reason;
    tell(session, 'status', { status, reason });
  }

  function setTarget(session, target) {
    session.target = target;
    tell(session, 'target', target);
  }

  function rejectPending(session, message) {
    for (const [id, pending] of session.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
      session.pending.delete(id);
    }
  }

  function dropSocket(session) {
    const ws = session.ws;
    session.ws = null;
    rejectPending(session, 'The connection closed.');
    try {
      ws?.close();
    } catch {}
  }

  function send(session, method, params = {}) {
    const ws = session.ws;
    if (!ws || ws.readyState !== OPEN) return Promise.reject(new Error('The socket is not open.'));
    return new Promise((resolve, reject) => {
      session.seq += 1;
      const id = session.seq;
      const timer = setTimeout(() => {
        session.pending.delete(id);
        reject(new Error(`${method} timed out.`));
      }, COMMAND_TIMEOUT_MS);
      session.pending.set(id, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        session.pending.delete(id);
        reject(error);
      }
    });
  }

  function onMessage(session, ws, raw) {
    if (session.ws !== ws) return;
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const pending = session.pending.get(message.id);
      if (!pending) return;
      session.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || 'CDP error.'));
      else pending.resolve(message.result);
      return;
    }
    const params = message.params || {};
    if (message.method === 'Page.screencastFrame' && typeof params.data === 'string') {
      // Acked before anything else: Chromium holds the next frame until it is.
      try {
        session.seq += 1;
        ws.send(
          JSON.stringify({
            id: session.seq,
            method: 'Page.screencastFrameAck',
            params: { sessionId: params.sessionId },
          }),
        );
      } catch {}
      session.lastFrame = frameOf(params);
      tell(session, 'frame', session.lastFrame);
    } else if (message.method === 'Page.frameNavigated' && !params.frame?.parentId) {
      setTarget(session, {
        id: session.target?.id,
        title: '',
        url: String(params.frame?.url || ''),
      });
    } else if (
      message.method === 'Inspector.detached' ||
      message.method === 'Inspector.targetCrashed'
    ) {
      lose(session);
    }
  }

  async function discover(session) {
    const response = await fetch(`http://${HOST}:${session.port}/json/list`, {
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Target discovery answered ${response.status}.`);
    const target = pickTarget(await response.json());
    if (!target) throw new Error('The browser has no page to show.');
    return target;
  }

  // Resolves once the screencast is running; rejects when the socket never opens or refuses.
  function attach(session, target) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(socketUrl(target, session.port));
      session.ws = ws;
      let opened = false;
      const giveUp = setTimeout(
        () => reject(new Error('The page did not answer.')),
        OPEN_TIMEOUT_MS,
      );
      ws.addEventListener('open', async () => {
        clearTimeout(giveUp);
        opened = true;
        try {
          await send(session, 'Page.enable');
          await send(session, 'Page.startScreencast', SCREENCAST);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      ws.addEventListener('message', (event) => onMessage(session, ws, event.data));
      ws.addEventListener('error', () => {
        clearTimeout(giveUp);
        if (!opened) reject(new Error('The page could not be reached.'));
      });
      ws.addEventListener('close', () => {
        clearTimeout(giveUp);
        if (!opened) reject(new Error('The page closed the connection.'));
        else if (session.ws === ws) lose(session);
      });
    });
  }

  async function connect(session) {
    if (session.closed) return;
    try {
      const target = await discover(session);
      if (session.closed) return;
      await attach(session, target);
      if (session.closed) return;
      session.attempt = 0;
      setTarget(session, { id: target.id, title: target.title || '', url: target.url || '' });
      setStatus(session, 'live');
    } catch {
      if (session.closed) return;
      lose(session);
    }
  }

  // The page went away (tab closed, navigated across processes, crashed) or never answered:
  // look for a page again with a short bounded backoff, then say so rather than freeze.
  function lose(session) {
    if (session.closed) return;
    dropSocket(session);
    const delay = retryDelays[session.attempt];
    if (delay === undefined) {
      setStatus(session, 'lost', 'unreachable');
      return;
    }
    session.attempt += 1;
    setStatus(session, 'connecting', 'reconnecting');
    clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      session.timer = null;
      connect(session);
    }, delay);
  }

  function close(session) {
    session.closed = true;
    clearTimeout(session.timer);
    const ws = session.ws;
    if (ws?.readyState === OPEN) {
      try {
        ws.send(JSON.stringify({ id: (session.seq += 1), method: 'Page.stopScreencast' }));
      } catch {}
    }
    dropSocket(session);
    if (sessions.get(session.id) === session) sessions.delete(session.id);
  }

  // The browser is gone: tell every viewer why and end their streams.
  function release(session, reason) {
    setStatus(session, 'lost', reason);
    for (const subscription of [...session.subscriptions]) {
      try {
        subscription.listener.end?.();
      } catch {}
    }
    session.subscriptions.clear();
    close(session);
  }

  function create(record) {
    const session = {
      id: record.id,
      port: record.port,
      subscriptions: new Set(),
      status: 'connecting',
      reason: '',
      target: null,
      lastFrame: null,
      ws: null,
      seq: 0,
      pending: new Map(),
      attempt: 0,
      timer: null,
      closed: false,
    };
    sessions.set(record.id, session);
    connect(session);
    return session;
  }

  // Joins (or starts) the instance's one stream. `listener` may define status, target, frame and
  // end; a joiner is told the current state and last frame at once, since a still page sends none.
  async function subscribe(id, listener) {
    const record = await resolveInstance(id);
    let session = sessions.get(id);
    if (session && session.port !== record.port) {
      release(session, 'stopped');
      session = null;
    }
    const fresh = !session;
    session = session || create(record);
    const subscription = { listener };
    session.subscriptions.add(subscription);
    if (!fresh && session.status === 'lost') {
      session.attempt = 0;
      setStatus(session, 'connecting');
      connect(session);
    }
    listener.status?.({ status: session.status, reason: session.reason });
    if (session.target) listener.target?.(session.target);
    if (session.lastFrame) listener.frame?.(session.lastFrame);
    let left = false;
    return () => {
      if (left) return;
      left = true;
      session.subscriptions.delete(subscription);
      if (session.subscriptions.size === 0) close(session);
    };
  }

  async function input(id, event) {
    const { method, params } = parseInputEvent(event);
    const session = sessions.get(id);
    if (!session || session.status !== 'live')
      throw fail('SCREENCAST_NOT_ACTIVE', 'That browser is not being viewed.', 409);
    try {
      await send(session, method, params);
    } catch {
      throw fail('INPUT_FAILED', 'The browser did not accept that input.', 502);
    }
  }

  const forgetStopped = devtools.onStopped?.((id) => {
    const session = sessions.get(id);
    if (session) release(session, 'stopped');
  });

  function shutdown() {
    forgetStopped?.();
    for (const session of [...sessions.values()]) release(session, 'stopped');
  }

  return { check: resolveInstance, subscribe, input, close: shutdown };
}
