import { useEffect, useRef, useState } from 'react';
import { composeTitle } from '../../ui/needs-you.js';

export const TITLE_SUFFIX = 'EZAT Dev Dashboard';
// How many animation frames to wait for a lazily loaded screen's heading to appear.
const HEADING_FRAMES = 30;

// Whether focus has nowhere useful to be: on the page, on nothing, on a removed element or inside a
// hidden screen. Focus held by a tab link, the Tools toggle, a composer or a dialog is never "lost".
const focusLost = () => {
  const held = document.activeElement;
  return !held || held === document.body || !held.isConnected || Boolean(held.closest('[hidden]'));
};

// The cues for a screen change, for a screen reader and the keyboard: sets the document title to
// `<label> · EZAT Dev Dashboard` (with the needs-you count in front while that shows); after the first render returns the label for a polite live region (empty
// on first load, so nothing is announced then); and, only when focus was lost, moves focus to the new
// screen's heading (tabIndex -1, no scroll). The heading is looked up in the screen's panel on each
// frame, so a screen still loading gets its focus when it arrives.
export function useRouteChange({ active, tabs }) {
  const label = tabs.find(({ id }) => id === active)?.label ?? '';
  const [announcement, setAnnouncement] = useState('');
  const first = useRef(true);

  useEffect(() => {
    document.title = composeTitle(label ? `${label} · ${TITLE_SUFFIX}` : TITLE_SUFFIX);
    if (first.current) {
      first.current = false;
      return undefined;
    }
    setAnnouncement(label);
    let frame = 0;
    let left = HEADING_FRAMES;
    const focusHeading = () => {
      if (!focusLost()) return;
      const heading = document.querySelector(`#panel-${active} h2`);
      if (!heading) {
        if (--left > 0) frame = requestAnimationFrame(focusHeading);
        return;
      }
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
    };
    frame = requestAnimationFrame(focusHeading);
    return () => cancelAnimationFrame(frame);
  }, [active, label]);

  return announcement;
}
