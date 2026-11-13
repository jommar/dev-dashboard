// chat-stream.js — this dashboard tab's end of one chat's server-sent events (GET
// /api/claude/chat/stream?session=<uuid>).
//
// The server speaks four events, always `hello` first: `hello` (the whole chat so far), `item` (a
// message or tool call, an upsert by id), `delta` (more text of the reply being written) and `state`
// (a turn starts or ends). `chatReducer` folds each into one view; `createChatStream` is the
// hello-first client over an EventSource-like. Both are pure of the page: `open` makes the source.

const KINDS = ['hello', 'item', 'delta', 'state'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The Chat screen's address for a session, and the session an address names (null for none or junk).
export const chatHref = (session) => `#/chat?session=${session}`;
export const chatSessionFromQuery = (query) => {
  const session = new URLSearchParams(query).get('session');
  return UUID.test(session ?? '') ? session : null;
};

// The view after one event, `{ type, data }` (the event's name and its parsed JSON). `view` is null
// before `hello`, and every other event leaves it null: a stream that has not said hello has said
// nothing yet. The view is the hello's fields plus `tail`, the reply being written (not an item until
// the finished assistant item replaces it). Never edits `view`.
export function chatReducer(view, { type, data }) {
  if (type === 'hello') return { ...data, tail: '' };
  if (!view) return null;
  switch (type) {
    case 'item': {
      const { item } = data;
      const at = view.items.findIndex(({ id }) => id === item.id);
      const items =
        at < 0 ? [...view.items, item] : view.items.map((it, index) => (index === at ? item : it));
      return { ...view, items, tail: item.kind === 'assistant' ? '' : view.tail };
    }
    case 'delta':
      return { ...view, tail: view.tail + data.text };
    case 'state':
      // A turn this dashboard runs is one it streams and can stop, so working here is live.
      if (data.state === 'working') return { ...view, state: 'working', live: true };
      // A reply cut short (Stop, a failure) never became an item; what was written stays, as one.
      return {
        ...view,
        state: 'idle',
        live: false,
        turn: data.turn,
        items: view.tail
          ? [
              ...view.items,
              { id: `partial-${view.items.length}`, kind: 'assistant', text: view.tail },
            ]
          : view.items,
        tail: '',
      };
    default:
      return view;
  }
}

// Opens the source on `listen(fn)` and hands `fn({ type, data })` every event after the first hello (a
// later hello, after the browser reconnected, is handed on again). `close()` closes the source once and
// silences the stream.
export function createChatStream({ open }) {
  let source = null;
  let closed = false;

  function listen(fn) {
    const opened = open();
    source = opened;
    let greeted = false;
    for (const type of KINDS)
      opened.addEventListener(type, (event) => {
        if (closed) return;
        let data;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }
        if (type === 'hello') greeted = true;
        if (greeted) fn({ type, data });
      });
  }

  function close() {
    if (closed) return;
    closed = true;
    source?.close();
  }

  return { listen, close };
}
