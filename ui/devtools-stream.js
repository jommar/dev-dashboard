// devtools-stream.js — this dashboard tab's end of the one live-view stream.
//
// Everything on screen that shows a browser live (a wall tile, the full viewer) is a *watcher* of
// that browser at a quality. They share ONE event stream (a browser allows only a handful of such
// connections per host): the stream is opened with the first watcher and closed shortly after the
// last, and each browser is subscribed on it, at the highest quality any of its watchers wants, by POST.
// A tab that goes away takes its stream with it, and the server lets go of everything it held.
//
// The server says the stream's id in a `hello` message, every time the connection (re)opens, and
// a new connection holds nothing, so on each `hello` every wanted browser is subscribed again.
// Messages carry the browser's `id` and go to its watchers; the latest of each kind is kept so a
// watcher that joins later (the viewer opening over a tile) starts from where things stand.
//
// Pure of the page: `open` makes an EventSource-like, `subscribe` and `unsubscribe` post to the
// server and resolve `{ ok }`.
import { topQuality } from './screencast-quality.js';

const CLOSED = 2; // EventSource.CLOSED
const RETRY_MS = 3000;
const LINGER_MS = 1500;
const KINDS = ['status', 'target', 'tabs', 'frame'];

const read = (event) => {
  try {
    return JSON.parse(event.data);
  } catch {
    return null;
  }
};

export function createDevtoolsStream({
  open,
  subscribe,
  unsubscribe,
  setTimeout = globalThis.setTimeout,
  clearTimeout = globalThis.clearTimeout,
  lingerMs = LINGER_MS,
}) {
  const entries = new Map(); // browser id -> { watchers, sent, last, busy, dirty }
  let source = null;
  let streamId = null;
  let retry = null; // the timer that asks again after a refusal
  let idle = null; // the timer that closes the stream once nobody has watched for a while

  const hasWatchers = () => [...entries.values()].some((entry) => entry.watchers.size > 0);

  // Tells one browser's watchers, and remembers it for the next one to join.
  function tell(entry, kind, payload) {
    entry.last[kind] = payload;
    for (const watcher of [...entry.watchers]) {
      try {
        watcher.listener[kind]?.(payload);
      } catch {}
    }
  }
  const tellAll = (kind, payload) => {
    for (const entry of entries.values()) tell(entry, kind, payload);
  };

  // Brings what the server holds for a browser to what its watchers want. One request at a time per
  // browser, and it always acts on what is wanted *now*, so quick changes cannot arrive out of order.
  async function flush(id, entry) {
    entry.busy = true;
    try {
      do {
        entry.dirty = false;
        const stream = streamId;
        if (!stream) break;
        const wanted = topQuality([...entry.watchers].map((watcher) => watcher.level));
        if (wanted === entry.sent) continue;
        const result = wanted ? await subscribe(stream, id, wanted) : await unsubscribe(stream, id);
        if (streamId !== stream) continue; // the connection changed; its `hello` subscribes afresh
        if (result?.ok || !wanted) entry.sent = wanted;
        else tell(entry, 'status', { status: 'lost', reason: 'unavailable' });
      } while (entry.dirty);
    } finally {
      entry.busy = false;
      if (!entry.watchers.size && !entry.dirty) entries.delete(id);
    }
  }

  function sync(id) {
    const entry = entries.get(id);
    if (!entry) return;
    if (entry.busy) entry.dirty = true;
    else flush(id, entry);
  }

  function closeSource() {
    clearTimeout(retry);
    retry = null;
    clearTimeout(idle);
    idle = null;
    source?.close();
    source = null;
    streamId = null;
    for (const entry of entries.values()) entry.sent = null;
  }

  function connect() {
    if (source || !hasWatchers()) return;
    clearTimeout(retry);
    retry = null;
    const opened = open();
    source = opened;
    opened.addEventListener('hello', (event) => {
      const message = read(event);
      if (source !== opened || typeof message?.stream !== 'string') return;
      streamId = message.stream;
      for (const [id, entry] of entries) {
        entry.sent = null;
        sync(id);
      }
    });
    for (const kind of KINDS)
      opened.addEventListener(kind, (event) => {
        const message = read(event);
        const entry = source === opened && entries.get(message?.id);
        if (!entry) return;
        if (kind === 'frame') {
          if (message.data)
            tell(entry, 'frame', { data: message.data, metadata: message.metadata });
        } else if (kind === 'target') {
          // The server's `id` names the browser; the tab is `targetId`.
          tell(entry, 'target', { id: message.targetId, title: message.title, url: message.url });
        } else if (kind === 'tabs') {
          if (Array.isArray(message.tabs))
            tell(entry, 'tabs', { mode: message.mode, tabs: message.tabs });
        } else tell(entry, 'status', { status: message.status, reason: message.reason || '' });
      });
    opened.addEventListener('error', () => {
      if (source !== opened) return;
      // Whatever the stream held died with its connection.
      streamId = null;
      for (const entry of entries.values()) entry.sent = null;
      if (opened.readyState === CLOSED) {
        // Refused (too many open, or the server is gone): ask again in a while.
        source = null;
        tellAll('status', { status: 'lost', reason: 'disconnected' });
        retry = setTimeout(() => {
          retry = null;
          connect();
        }, RETRY_MS);
      } else tellAll('status', { status: 'connecting', reason: 'reconnecting' });
    });
  }

  // Shows `id` to `listener` (any of status, target, tabs, frame) at `level` until the returned
  // function is called. The listener first hears what is already known about the browser.
  function watch(id, level, listener) {
    let entry = entries.get(id);
    if (!entry) {
      entry = { watchers: new Set(), sent: null, last: {}, busy: false, dirty: false };
      entries.set(id, entry);
    }
    const watcher = { level, listener };
    entry.watchers.add(watcher);
    clearTimeout(idle);
    idle = null;
    for (const kind of KINDS) if (entry.last[kind]) listener[kind]?.(entry.last[kind]);
    connect();
    sync(id);
    return () => {
      if (!entry.watchers.delete(watcher)) return;
      if (!entry.watchers.size) entry.last = {};
      sync(id); // the browser is let go of at once, whether or not the stream stays
      if (hasWatchers() || idle) return;
      // Scrolling swaps the whole set of tiles within a moment: the stream waits a little for the
      // next watcher rather than closing and opening again. Nothing is held on it meanwhile.
      idle = setTimeout(() => {
        idle = null;
        if (!hasWatchers()) closeSource();
      }, lingerMs);
    };
  }

  return { watch };
}
