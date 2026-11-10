import { useEffect, useRef, useState } from 'react';
import { openDevtoolsScreencast } from '../lib/api.js';

// The stream ends for good when the browser stopped or could not be attached; the browser's own
// reconnect would only ask again and be refused.
const FINAL_REASONS = ['stopped', 'unavailable'];

const IDLE = { status: 'connecting', reason: '', target: null, tabs: null };

const read = (event) => {
  try {
    return JSON.parse(event.data);
  } catch {
    return null;
  }
};

// One live view of a debug browser. Frames go straight to `onFrame` (no state, so a stream of
// them never re-renders the viewer); what the viewer needs to say about the connection is state.
// The source is closed when the component leaves or `id` changes, which ends the viewing.
export function useScreencast(id, onFrame) {
  const [state, setState] = useState(IDLE);
  const frame = useRef(onFrame);
  useEffect(() => {
    frame.current = onFrame;
  }, [onFrame]);

  useEffect(() => {
    setState(IDLE);
    const source = openDevtoolsScreencast(id);
    source.addEventListener('frame', (event) => {
      const message = read(event);
      if (message?.data) frame.current?.(message);
    });
    source.addEventListener('status', (event) => {
      const message = read(event);
      if (!message) return;
      setState((current) => ({
        ...current,
        status: message.status,
        reason: message.reason || '',
      }));
      if (message.status === 'lost' && FINAL_REASONS.includes(message.reason)) source.close();
    });
    source.addEventListener('target', (event) => {
      const message = read(event);
      if (message) setState((current) => ({ ...current, target: message }));
    });
    // The strip: `{ mode, tabs }`, each tab `{ id, title, url, current }`.
    source.addEventListener('tabs', (event) => {
      const message = read(event);
      if (message && Array.isArray(message.tabs))
        setState((current) => ({ ...current, tabs: message }));
    });
    // A closed source was refused (the browser is gone); a connecting one is retrying by itself.
    source.addEventListener('error', () =>
      setState((current) =>
        source.readyState === EventSource.CLOSED
          ? { ...current, status: 'lost', reason: 'disconnected' }
          : { ...current, status: 'connecting', reason: 'reconnecting' },
      ),
    );
    return () => source.close();
  }, [id]);

  return state;
}
