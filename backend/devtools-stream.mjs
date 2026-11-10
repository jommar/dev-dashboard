// devtools-stream.mjs — one live stream for every browser a dashboard tab is watching.
//
// A browser allows only a handful of server-sent-event connections per host and the dashboard
// already holds one, so a wall of live tiles cannot open one stream per browser. Instead a tab opens
// ONE stream (`open`), is told its id in a first `hello` message, and then subscribes and
// unsubscribes browsers on it with plain POSTs (`subscribe` / `unsubscribe`), each at a quality
// (`tile` or `full`). Every message of a browser carries its id: `status`, `target`, `tabs`, `frame`.
//
// Each subscription joins the browser's one CDP session in browser-screencast.mjs, which is shared
// by every stream and every quality; this layer only multiplexes onto it. Closing the stream
// releases everything it held, so a tab that goes away cannot leave a screencast running.
//
// A stream id is the server's, random, and only a well-formed one is looked up. The number of
// streams and of browsers on one stream are capped, so no page can hold the server's sockets or the
// browsers' CPU open. A frame is dropped, never queued, for a browser whose last write the client
// has not drained.

import { randomBytes } from 'node:crypto';
import { fail } from './browser-devtools.mjs';
import { isQuality } from '../ui/screencast-quality.js';

// What a stream id looks like: the server makes 24 characters of it, a client may only send this.
export const STREAM_ID = /^[A-Za-z0-9_-]{16,64}$/;
export const MAX_STREAMS = 8;
// More than there are debug ports (9300-9399), so it only ever stops a client that is not one.
export const MAX_SUBSCRIPTIONS = 100;

export function createDevtoolsStreams({
  screencast,
  maxStreams = MAX_STREAMS,
  maxSubscriptions = MAX_SUBSCRIPTIONS,
  newId = () => randomBytes(18).toString('base64url'),
} = {}) {
  const streams = new Map();

  // The listener one subscription gives the browser's session: every message tagged with the id.
  function listenerFor(stream, id, held) {
    const emit = (event, payload) => (stream.closed ? true : stream.sink.send(event, payload));
    return {
      status: (status) => emit('status', { id, ...status }),
      // The session's `target.id` is the tab; the message's `id` is the browser, so it moves.
      target: (target) =>
        emit('target', { id, targetId: target.id, title: target.title, url: target.url }),
      tabs: (tabs) => emit('tabs', { id, ...tabs }),
      frame: (frame) => {
        if (held.congested) return;
        if (emit('frame', { id, ...frame }) === false) held.congested = true;
      },
      // The browser stopped: its session ended every viewer. The stream itself carries on.
      end: () => {
        if (stream.subs.get(id) === held) stream.subs.delete(id);
      },
    };
  }

  function release(stream) {
    stream.closed = true;
    for (const held of stream.subs.values()) held.leave?.();
    stream.subs.clear();
    streams.delete(stream.id);
  }

  // Starts a stream on `sink` (`send(event, payload)`, false when the client is not keeping up, and
  // `end()`), and says its id. The caller reports the client's drain and departure on the handle.
  function open(sink) {
    if (streams.size >= maxStreams)
      throw fail('TOO_MANY_STREAMS', 'Too many live views are open.', 429);
    const stream = { id: newId(), sink, subs: new Map(), closed: false };
    streams.set(stream.id, stream);
    sink.send('hello', { stream: stream.id });
    return {
      id: stream.id,
      drained: () => {
        for (const held of stream.subs.values()) held.congested = false;
      },
      close: () => release(stream),
    };
  }

  function find(streamId) {
    if (typeof streamId !== 'string' || !STREAM_ID.test(streamId))
      throw fail('INVALID_STREAM', 'That is not a live view stream.', 400);
    const stream = streams.get(streamId);
    if (!stream) throw fail('UNKNOWN_STREAM', 'That live view stream is closed.', 404);
    return stream;
  }

  // Watches a browser on the stream at `quality`, or changes the quality it is watched at.
  async function subscribe(streamId, id, quality) {
    const stream = find(streamId);
    if (!isQuality(quality)) throw fail('INVALID_QUALITY', 'Choose tile or full.', 400);
    if (typeof id !== 'string') throw fail('UNKNOWN_BROWSER', 'Unknown browser.', 404);
    const known = stream.subs.get(id);
    if (known) {
      known.quality = quality;
      known.leave?.setQuality(quality);
      return;
    }
    if (stream.subs.size >= maxSubscriptions)
      throw fail('TOO_MANY_SUBSCRIPTIONS', 'Too many browsers on one live view.', 429);
    // Held before the session answers, so a second request for the same browser finds it.
    const held = { quality, leave: null, congested: false };
    stream.subs.set(id, held);
    let leave;
    try {
      leave = await screencast.subscribe(id, listenerFor(stream, id, held), quality);
    } catch (error) {
      if (stream.subs.get(id) === held) stream.subs.delete(id);
      throw error;
    }
    if (stream.subs.get(id) !== held) {
      leave(); // unsubscribed, or the stream closed, while the session was answering
      return;
    }
    held.leave = leave;
    if (held.quality !== quality) leave.setQuality(held.quality);
  }

  // Stops watching a browser on the stream. Not watching it already is not an error.
  function unsubscribe(streamId, id) {
    const stream = find(streamId);
    const held = stream.subs.get(id);
    if (!held) return;
    stream.subs.delete(id);
    held.leave?.();
  }

  // The service stops: every stream is ended and everything it held let go.
  function close() {
    for (const stream of [...streams.values()]) {
      release(stream);
      try {
        stream.sink.end();
      } catch {}
    }
  }

  return { open, subscribe, unsubscribe, close };
}
