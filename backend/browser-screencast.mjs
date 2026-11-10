// browser-screencast.mjs — watch (and optionally drive) a debug browser from inside the dashboard.
//
// One CDP session per instance, shared by every viewer: opened on the first subscriber, closed
// when the last one leaves or the browser stops. It is two connections: the browser-level one
// (`Target.setDiscoverTargets`) keeps the list of open tabs current by events (titles, which
// Chromium does not announce, are re-read every few seconds), and the page-level
// one carries the screencast of the tab being shown. Chromium pushes `Page.screencastFrame`
// events; each is acked at once (it sends nothing more until it is) and fanned out to the
// subscribers. Input goes back through parseInputEvent, so a viewer can only ever send the
// handful of whitelisted mouse and key commands, never an arbitrary CDP method.
//
// Which tab is shown: by default the newest one opened (auto); a viewer can pin one, and a pinned
// tab that closes falls back to auto. The choice is the session's, so every viewer of the
// instance sees the same tab. A selection is only ever a target the browser itself reported.
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
const TITLE_REFRESH_MS = 3000; // Chromium does not push a tab's title changes, so they are re-read
const MAX_TABS = 20; // tabs sent to a viewer (the shown one always among them)
const MAX_KNOWN = 200; // tabs remembered, so a page opening windows in a loop cannot grow it
const MAX_ID = 128;
const MAX_TITLE = 120;
const MAX_URL = 500;

// The pages worth showing, in the order given: real tabs, not DevTools or extension pages, else
// every page there is.
export function viewableTargets(targets) {
  const pages = (Array.isArray(targets) ? targets : []).filter((target) => target?.type === 'page');
  const real = pages.filter((target) => !NOT_A_VIEW.test(String(target.url || '')));
  return real.length ? real : pages;
}

// The debugger URL as the browser reported it, pinned to this instance's own loopback port.
function socketUrl(webSocketDebuggerUrl, port) {
  const url = new URL(webSocketDebuggerUrl);
  url.protocol = 'ws:';
  url.hostname = HOST;
  url.port = String(port);
  return url.href;
}

// Text from a page is untrusted: no control characters, and a length a strip can show.
const clean = (value, max) =>
  String(value ?? '')
    .replace(/\p{Cc}/gu, ' ')
    .slice(0, max);

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

  // A link is one CDP connection with its own command ids: the session itself is the page link,
  // `session.browser` the browser-level one.
  const newLink = () => ({ ws: null, seq: 0, pending: new Map() });

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

  // The tabs a viewer may pick, oldest first: what is viewable, in the order they were opened.
  const viewable = (session) => viewableTargets([...session.targets.values()]);

  // What the strip shows: `{ mode, tabs }`, the shown tab marked and always included.
  function tabsOf(session) {
    const list = viewable(session);
    const shown = list.filter((tab) => tab.id === session.wanted);
    const kept = list.slice(-MAX_TABS);
    const tabs = (
      shown.length && !kept.includes(shown[0]) ? [shown[0], ...kept.slice(1)] : kept
    ).map((tab) => ({
      id: clean(tab.id, MAX_ID),
      title: clean(tab.title, MAX_TITLE),
      url: clean(tab.url, MAX_URL),
      current: tab.id === session.wanted,
    }));
    return { mode: session.pinned ? 'pinned' : 'auto', tabs };
  }

  // Sent only when it changed, so a title that keeps updating to the same text is not a message.
  function announceTabs(session) {
    const payload = tabsOf(session);
    const text = JSON.stringify(payload);
    if (text === session.tabsText) return;
    session.tabsText = text;
    session.tabsPayload = payload;
    tell(session, 'tabs', payload);
  }

  function rejectPending(link, message) {
    for (const [id, pending] of link.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
      link.pending.delete(id);
    }
  }

  function dropLink(link) {
    const ws = link.ws;
    link.ws = null;
    rejectPending(link, 'The connection closed.');
    try {
      ws?.close();
    } catch {}
  }

  function send(link, method, params = {}) {
    const ws = link.ws;
    if (!ws || ws.readyState !== OPEN) return Promise.reject(new Error('The socket is not open.'));
    return new Promise((resolve, reject) => {
      link.seq += 1;
      const id = link.seq;
      const timer = setTimeout(() => {
        link.pending.delete(id);
        reject(new Error(`${method} timed out.`));
      }, COMMAND_TIMEOUT_MS);
      link.pending.set(id, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        link.pending.delete(id);
        reject(error);
      }
    });
  }

  // A command's answer. True when the message was one.
  function answer(link, message) {
    if (message.id === undefined) return false;
    const pending = link.pending.get(message.id);
    if (!pending) return true;
    link.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message || 'CDP error.'));
    else pending.resolve(message.result);
    return true;
  }

  const parse = (raw) => {
    try {
      return JSON.parse(String(raw));
    } catch {
      return null;
    }
  };

  function onPageMessage(session, ws, raw) {
    if (session.ws !== ws) return;
    const message = parse(raw);
    if (!message || answer(session, message)) return;
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

  // What to show now: the pinned tab while it is open, else the newest. A pin whose tab is gone
  // falls back to auto, and says so on the next live status.
  function chooseTarget(session) {
    const list = viewable(session);
    if (session.pinned) {
      const pinned = list.find((tab) => tab.id === session.pinned);
      if (pinned) return pinned;
      session.pinned = null;
      session.notice = 'tab-closed';
    }
    return list.at(-1) || null;
  }

  // The tab to show changed under a live session (one opened, or the shown one closed): move.
  function follow(session) {
    if (session.closed || !session.browserReady) return;
    const next = chooseTarget(session);
    if (next && next.id !== session.wanted) restart(session);
    else announceTabs(session);
  }

  // Remembers a page target a browser-level message described. A tab not known yet is added only
  // when `add` is set: later messages open tabs, a re-read of the list only refreshes them.
  function note(session, info, add) {
    if (info?.type !== 'page' || typeof info.targetId !== 'string') return false;
    if (info.targetId.length > MAX_ID) return false;
    const known = session.targets.get(info.targetId);
    if (!known && !add) return false;
    // A map keeps insertion order, and an update keeps its place: oldest opened first.
    session.targets.set(info.targetId, {
      id: info.targetId,
      type: 'page',
      title: String(info.title ?? ''),
      url: String(info.url ?? ''),
    });
    session.fresh.add(info.targetId);
    if (!known && session.targets.size > MAX_KNOWN) {
      const oldest = [...session.targets.keys()].find(
        (key) => key !== session.wanted && key !== session.pinned,
      );
      session.targets.delete(oldest);
    }
    return true;
  }

  function onBrowserMessage(session, ws, raw) {
    if (session.browser.ws !== ws) return;
    const message = parse(raw);
    if (!message || answer(session.browser, message)) return;
    const info = message.params?.targetInfo;
    if (message.method === 'Target.targetCreated' || message.method === 'Target.targetInfoChanged')
      note(session, info, true);
    else if (message.method === 'Target.targetDestroyed')
      session.targets.delete(message.params?.targetId);
    else return;
    follow(session);
  }

  // Chromium announces tabs opening and closing, but not a title that changes after the page
  // loaded, so while the browser is watched the titles are read again now and then.
  function refreshTitles(session) {
    clearTimeout(session.refresh);
    session.refresh = setTimeout(async () => {
      session.refresh = null;
      try {
        const { targetInfos } = await send(session.browser, 'Target.getTargets');
        if (session.closed || !session.browserReady) return;
        for (const info of Array.isArray(targetInfos) ? targetInfos : [])
          note(session, info, false);
        follow(session);
      } catch {}
      if (!session.closed && session.browserReady) refreshTitles(session);
    }, TITLE_REFRESH_MS);
  }

  // Resolves once the socket is open and `ready` has run; rejects when it never opens or refuses.
  function open(session, link, url, handle, ready) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      link.ws = ws;
      let opened = false;
      const giveUp = setTimeout(
        () => reject(new Error('The browser did not answer.')),
        OPEN_TIMEOUT_MS,
      );
      ws.addEventListener('open', async () => {
        clearTimeout(giveUp);
        opened = true;
        try {
          await ready();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      ws.addEventListener('message', (event) => handle(session, ws, event.data));
      ws.addEventListener('error', () => {
        clearTimeout(giveUp);
        if (!opened) reject(new Error('The browser could not be reached.'));
      });
      ws.addEventListener('close', () => {
        clearTimeout(giveUp);
        if (!opened) reject(new Error('The browser closed the connection.'));
        else if (link.ws === ws) lose(session);
      });
    });
  }

  const readJson = async (session, path) => {
    const response = await fetch(`http://${HOST}:${session.port}${path}`, {
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Target discovery answered ${response.status}.`);
    return response.json();
  };

  // The browser-level connection: finds its debugger URL, then has it report every tab, those
  // already open first and each later change as it happens.
  //
  // The tabs it names on connecting come in no order that means anything, so the order they were
  // opened in is taken from the browser's own tab list (newest first), and what was known before a
  // reconnect keeps its place.
  async function discover(session) {
    const [version, listed] = await Promise.all([
      readJson(session, '/json/version'),
      readJson(session, '/json/list').catch(() => []),
    ]);
    if (typeof version?.webSocketDebuggerUrl !== 'string')
      throw new Error('The browser has no debugger.');
    const carried = new Set(session.targets.keys());
    session.fresh = new Set();
    await open(
      session,
      session.browser,
      socketUrl(version.webSocketDebuggerUrl, session.port),
      onBrowserMessage,
      () => send(session.browser, 'Target.setDiscoverTargets', { discover: true }),
    );
    const rank = new Map((Array.isArray(listed) ? listed : []).map((tab, at) => [tab?.id, at]));
    const present = [...session.targets.values()].filter((tab) => session.fresh.has(tab.id));
    const added = present
      .filter((tab) => !carried.has(tab.id))
      .sort((a, b) => (rank.get(b.id) ?? -1) - (rank.get(a.id) ?? -1));
    session.targets = new Map(
      [...present.filter((tab) => carried.has(tab.id)), ...added].map((tab) => [tab.id, tab]),
    );
    session.browserReady = true;
    refreshTitles(session);
  }

  // Resolves once the screencast is running; rejects when the socket never opens or refuses.
  function attach(session, target) {
    const url = new URL(`/devtools/page/${encodeURIComponent(target.id)}`, `ws://${HOST}`);
    url.port = String(session.port);
    return open(session, session, url.href, onPageMessage, async () => {
      await send(session, 'Page.enable');
      await send(session, 'Page.startScreencast', SCREENCAST);
    });
  }

  // (Re)starts the whole attachment; a newer call makes an older one still in flight give up.
  async function connect(session) {
    if (session.closed) return;
    session.epoch += 1;
    const epoch = session.epoch;
    const stale = () => session.closed || session.epoch !== epoch;
    try {
      if (!session.browserReady) {
        await discover(session);
        if (stale()) return;
      }
      const target = chooseTarget(session);
      if (!target) throw new Error('The browser has no page to show.');
      session.wanted = target.id;
      announceTabs(session);
      await attach(session, target);
      if (stale()) return;
      session.attempt = 0;
      setTarget(session, {
        id: target.id,
        title: clean(target.title, MAX_TITLE),
        url: clean(target.url, MAX_URL),
      });
      const notice = session.notice;
      session.notice = '';
      setStatus(session, 'live', notice);
    } catch {
      if (stale()) return;
      lose(session);
    }
  }

  // The tab being shown changes: stop its screencast and start the next one, on the same stream.
  function restart(session) {
    if (session.closed) return;
    clearTimeout(session.timer);
    session.timer = null;
    stopScreencast(session);
    session.attempt = 0;
    session.lastFrame = null; // a joiner must not be handed the old tab's picture
    setStatus(session, 'connecting', 'switching');
    connect(session);
  }

  // The page went away (tab closed, navigated across processes, crashed) or never answered:
  // start over, tab discovery included, with a short bounded backoff, then say so rather than freeze.
  function lose(session) {
    if (session.closed) return;
    dropLink(session);
    dropLink(session.browser);
    session.browserReady = false;
    clearTimeout(session.refresh);
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

  function stopScreencast(session) {
    if (session.ws?.readyState === OPEN) {
      try {
        session.ws.send(JSON.stringify({ id: (session.seq += 1), method: 'Page.stopScreencast' }));
      } catch {}
    }
    dropLink(session);
  }

  function close(session) {
    session.closed = true;
    clearTimeout(session.timer);
    clearTimeout(session.refresh);
    stopScreencast(session);
    dropLink(session.browser);
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
      browser: newLink(),
      browserReady: false,
      targets: new Map(), // page targets by id, in the order they were opened
      fresh: new Set(), // the ids the browser named since it was last connected to
      refresh: null,
      wanted: null, // the id being shown (or being attached)
      pinned: null, // the id a viewer chose; null follows the newest
      notice: '', // why the next live status differs, e.g. the pinned tab closed
      tabsText: '',
      tabsPayload: null,
      epoch: 0,
      attempt: 0,
      timer: null,
      closed: false,
    };
    sessions.set(record.id, session);
    connect(session);
    return session;
  }

  // Joins (or starts) the instance's one stream. `listener` may define status, target, tabs, frame
  // and end; a joiner is told the current state, tabs and last frame at once, since a still page
  // sends none.
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
    if (session.tabsPayload) listener.tabs?.(session.tabsPayload);
    if (session.lastFrame) listener.frame?.(session.lastFrame);
    let left = false;
    return () => {
      if (left) return;
      left = true;
      session.subscriptions.delete(subscription);
      if (session.subscriptions.size === 0) close(session);
    };
  }

  // Which tab the viewers see: `targetId` pins that tab, null goes back to following the newest.
  // Choosing a tab also brings it to the front of the browser window, because a background tab
  // may send no frames and ignore input.
  async function selectTab(id, targetId) {
    if (
      targetId !== null &&
      !(typeof targetId === 'string' && targetId && targetId.length <= MAX_ID)
    )
      throw fail('INVALID_TAB', 'Choose a tab, or null for the newest.', 400);
    const session = sessions.get(id);
    if (!session || !session.browserReady || session.status === 'lost')
      throw fail('SCREENCAST_NOT_ACTIVE', 'That browser is not being viewed.', 409);
    if (targetId !== null && !viewable(session).some((tab) => tab.id === targetId))
      throw fail('UNKNOWN_TAB', 'That tab is not open.', 404);
    session.pinned = targetId;
    session.notice = '';
    const next = chooseTarget(session);
    const changes = Boolean(next) && next.id !== session.wanted;
    if (next && (targetId !== null || changes)) {
      try {
        await send(session.browser, 'Target.activateTarget', { targetId: next.id });
      } catch {}
      if (session.closed) return;
    }
    if (changes) restart(session);
    else {
      if (session.status === 'live') setStatus(session, 'live');
      announceTabs(session);
    }
  }

  // `targetId`, when the viewer sends it, is the tab it was looking at: input meant for one tab
  // is refused rather than delivered to another after a switch.
  async function input(id, event, targetId) {
    const { method, params } = parseInputEvent(event);
    const session = sessions.get(id);
    if (!session || session.status !== 'live')
      throw fail('SCREENCAST_NOT_ACTIVE', 'That browser is not being viewed.', 409);
    if (targetId !== undefined && targetId !== session.target?.id)
      throw fail('TAB_CHANGED', 'The viewed tab changed.', 409);
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

  return { check: resolveInstance, subscribe, selectTab, input, close: shutdown };
}
