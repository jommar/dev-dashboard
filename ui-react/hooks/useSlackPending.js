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
// A tick while the page is hidden asks for nothing; a session change reads at once. getSlackPending
// degrades a failed fetch into { available: false, failed: true }, retried every minute; only the server's
// own { available: false } backs off to five.
const readers = new Set();
let current = null;
let latest = 0;
let timer = null;

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(tick, pendingDelay(current));
}

// The next tick is armed before the request goes out (the first one too), so a slow answer never
// stalls the cadence.
function tick() {
  schedule();
  if (!document.hidden) read();
}

// Every read asks; only the newest one's answer counts, so a read that was overtaken (a session change
// while a tick was out) never overwrites the answer for the new session, and a hung one stalls nothing.
async function read() {
  const mine = ++latest;
  const answer = await getSlackPending();
  if (mine !== latest) return;
  current = answer;
  readers.forEach((notify) => notify());
  if (readers.size) schedule();
}

function subscribe(notify) {
  readers.add(notify);
  if (readers.size === 1) {
    window.addEventListener(SLACK_SESSION_EVENT, read);
    // `current` is still null here, so this first timer is the idle delay until the first answer re-arms it.
    schedule();
    read();
  }
  return () => {
    readers.delete(notify);
    if (readers.size) return;
    window.removeEventListener(SLACK_SESSION_EVENT, read);
    clearTimeout(timer);
  };
}

export function useSlackPending() {
  return { pending: useSyncExternalStore(subscribe, () => current) };
}
