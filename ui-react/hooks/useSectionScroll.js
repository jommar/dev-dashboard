import { useCallback, useLayoutEffect, useRef } from 'react';
import { readScroll, writeScroll } from './usePreservedInteraction.js';

// The scrollers of a board: the track (sideways) and every column body (down), keyed by test id.
const scrollersOf = (frame) => frame?.querySelectorAll('.board-track, .board-column-body') || [];

// Each view of a board keeps its own place: the track's sideways scroll and every column's
// scroll position. The caller invokes the returned function just before changing `view`; once
// `view` has changed the places saved for it (the start, when it has none) are put back, which
// is also what returns a board that was unmounted in between (Slack's Watch view) to the column
// it was on. Scrollers are keyed by their test id, so the same column in another view starts from
// its own place.
export function useSectionScroll(frameRef, view) {
  const saved = useRef(new Map());
  useLayoutEffect(() => {
    writeScroll(scrollersOf(frameRef.current), saved.current.get(view) ?? new Map(), [0, 0]);
  }, [frameRef, view]);
  return useCallback(() => {
    saved.current.set(view, readScroll(scrollersOf(frameRef.current)));
  }, [frameRef, view]);
}
