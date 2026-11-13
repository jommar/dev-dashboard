import { useCallback, useEffect, useReducer, useState } from 'react';
import { openChatStream, sendChat, stopChat } from '../lib/api.js';
import { chatReducer, createChatStream } from '../../ui/chat-stream.js';

// One chat's live view: `{ view, error, send, stop, refresh }`. The stream is open only while `active`
// and a `session` is given, so leaving the Chat screen lets go of it. `view` is null until the
// server's hello (see chatReducer in ui/chat-stream.js); the caller keys the component holding this
// hook by session, so another chat never starts from this one's view. Deltas arrive in bursts, so they
// are gathered and applied once per animation frame; any other event applies at once, after the deltas
// before it. `error` is a sentence while the stream is down, cleared by the next hello. `send` and
// `stop` resolve with the API result; `refresh` opens the stream again, which starts over with a hello.
export function useChatSession({ active, session }) {
  const [view, dispatch] = useReducer(chatReducer, null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!active || !session) return undefined;
    let waiting = '';
    let frame = 0;
    const flush = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      if (!waiting) return;
      dispatch({ type: 'delta', data: { text: waiting } });
      waiting = '';
    };
    const stream = createChatStream({
      open: () => {
        const source = openChatStream(session);
        source.addEventListener('error', () =>
          setError(
            source.readyState === EventSource.CLOSED
              ? 'The chat stream could not be opened. Too many chats may be open, or the session is gone.'
              : 'Reconnecting to the chat stream…',
          ),
        );
        return source;
      },
    });
    stream.listen((event) => {
      if (event.type === 'delta') {
        waiting += event.data.text;
        frame ||= requestAnimationFrame(flush);
        return;
      }
      flush();
      if (event.type === 'hello') setError('');
      dispatch(event);
    });
    return () => {
      stream.close();
      cancelAnimationFrame(frame);
    };
  }, [active, session, attempt]);

  const send = useCallback((message) => sendChat(message, session ?? undefined), [session]);
  const stop = useCallback(() => stopChat(session), [session]);
  const refresh = useCallback(() => setAttempt((count) => count + 1), []);
  return { view, error, send, stop, refresh };
}
