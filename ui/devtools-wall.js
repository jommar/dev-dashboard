// devtools-wall.js — what a tile of the DevTools wall decides and says. Pure: the tile passes in
// what it knows (is the browser running, is the tile on screen) and gets words and flags back.
import { tabLabel } from './devtools-tabs.js';

// A tile streams only while somebody could be looking at it: its browser runs, the DevTools screen
// is the one shown, the tile is inside the scrolling pane and the page is not in a background tab.
// Anything else pauses it, which lets the browser's screencast stop when no tile needs it.
export const shouldStream = ({ running, active, inView, documentVisible }) =>
  Boolean(running && active && inView && documentVisible);

const REASON_TEXT = {
  reconnecting: 'Reconnecting',
  switching: 'Switching tab',
  stopped: 'Browser stopped',
  unreachable: 'Not reachable',
  unavailable: 'Not available',
  disconnected: 'Disconnected',
};

// The tile's one state, as a key for its colour and the words beside it. A stopped browser and a
// paused tile say so before anything the last stream said, which may be old.
export function tileState({ running, streaming, status, reason }) {
  if (!running) return { key: 'stopped', text: 'Stopped' };
  if (!streaming) return { key: 'paused', text: 'Paused' };
  if (status === 'live') return { key: 'live', text: 'Live' };
  if (status === 'lost')
    return { key: 'lost', text: `Lost · ${REASON_TEXT[reason] || 'No signal'}` };
  return { key: 'connecting', text: REASON_TEXT[reason] || 'Connecting' };
}

// The page a tile shows: the shown tab of the strip, else the page the stream last navigated to.
export function tilePageTitle({ tabs, target }) {
  const shown = (Array.isArray(tabs?.tabs) ? tabs.tabs : []).find((tab) => tab.current);
  const page = shown || target;
  return page ? tabLabel(page) : '';
}
