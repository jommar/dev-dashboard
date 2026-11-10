import { useEffect, useRef, useState } from 'react';
import { devtoolsStream } from '../lib/devtools-stream.js';

const IDLE = { status: 'connecting', reason: '', target: null, tabs: null };

// The full live view of one debug browser, on the dashboard's shared stream. Frames go straight to
// `onFrame` (no state, so a stream of them never re-renders the viewer); what the viewer needs to
// say about the connection is state. Watching at `full` is what makes the browser send its sharp
// picture; it goes back to what the wall asked for when the component leaves or `id` changes.
export function useScreencast(id, onFrame) {
  const [state, setState] = useState(IDLE);
  const frame = useRef(onFrame);
  useEffect(() => {
    frame.current = onFrame;
  }, [onFrame]);

  useEffect(() => {
    setState(IDLE);
    return devtoolsStream.watch(id, 'full', {
      frame: (message) => frame.current?.(message),
      status: ({ status, reason }) => setState((current) => ({ ...current, status, reason })),
      target: (target) => setState((current) => ({ ...current, target })),
      // The strip: `{ mode, tabs }`, each tab `{ id, title, url, current }`.
      tabs: (tabs) => setState((current) => ({ ...current, tabs })),
    });
  }, [id]);

  return state;
}
