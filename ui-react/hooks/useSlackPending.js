import { useSyncExternalStore } from 'react';
import { getSlackPending } from '../lib/api.js';
import { pendingDelay } from '../../ui/polling.js';

const SLACK_SESSION_EVENT = 'slack-session-changed';

// The panel announces a connect or disconnect here, so the badge stays truthful
// without the nav holding on to panel state or reaching into the panel's hooks.
export function notifySlackSessionChanged(source) {
  window.dispatchEvent(new CustomEvent(SLACK_SESSION_EVENT, { detail: { source } }));
}

// One store for every reader (the Slack tab's badge and the Slack drawer's edge tab): one timer, and
// the first reader starts it while the last one stops it. After each answer the next read is
// pendingDelay(answer): SLACK_POLL_MS, a minute, or SLACK_IDLE_POLL_MS, five, while Slack is unavailable.
// A tick while the page is hidden asks for nothing; a session change, or the page becoming visible again,
// reads at once (read() re-arms the one timer, so the cadence stays a request a minute). getSlackPending
// degrades a failed fetch into { available: false, failed: true }, retried every minute; only the server's
// own { available: false } backs off to five. Every arm of the timer publishes a new snapshot { pending, ms,
// cycle } (ms: this cycle's length, cycle: the timer's own id, so it changes exactly when the timer is re-armed),
// which the Slack edge tab's border animates as a CSS-only countdown: no second timer, no per-second render.
const readers = new Set();
let current = null;
let state = {};
let latest = 0;
let timer;

// The next tick is armed before the request goes out (the first one too), so a slow answer never
// stalls the cadence. A hidden page asks for nothing: a tick lands there, and so does the visibilitychange of
// leaving the tab.
function schedule() {
  clearTimeout(timer);
  const ms = pendingDelay(current);
  timer = setTimeout(() => {
    schedule();
    readIfVisible();
  }, ms);
  state = { pending: current, ms, cycle: timer };
  readers.forEach((notify) => notify());
}

const readIfVisible = () => document.hidden || read();

// Every read asks; only the newest one's answer counts, so a read that was overtaken (a session change
// while a tick was out) never overwrites the answer for the new session, and a hung one stalls nothing.
async function read() {
  const mine = ++latest;
  const answer = await getSlackPending();
  if (mine !== latest) return;
  current = answer;
  if (readers.size) schedule();
}

function subscribe(notify) {
  readers.add(notify);
  if (readers.size === 1) {
    window.addEventListener(SLACK_SESSION_EVENT, read);
    document.addEventListener('visibilitychange', readIfVisible);
    // `current` is still null here, so this first timer is the idle delay until the first answer re-arms it.
    schedule();
    read();
  }
  return () => {
    readers.delete(notify);
    if (readers.size) return;
    window.removeEventListener(SLACK_SESSION_EVENT, read);
    document.removeEventListener('visibilitychange', readIfVisible);
    clearTimeout(timer);
  };
}

export function useSlackPending() {
  return useSyncExternalStore(subscribe, () => state);
}
