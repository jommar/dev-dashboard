// needs-you.js — the rules behind the opt-in "Needs you" desktop notification and the tab-title count.
// Pure: no DOM, no storage global. The browser side (Notification, document.title, localStorage) is in
// ui-react/hooks/useNeedsYou.js. Nothing here reads a chat, a ticket title or session output: a
// notification says only the ticket key and one of the bot bar's own callout words.
import { CALLOUT_TEXT, MAX_CALLOUTS } from './bot-bar.js';

// The states that need the user: a session waiting for an answer, or one that failed. Done never notifies.
export const NOTIFY_STATES = Object.freeze(['waiting', 'failed']);
// Only a real ticket key is ever put in a notification (a chat's `chat-<hex>` label never is).
// Must match the backend's ticket key pattern (backend/claude-ticket-state.mjs); ui/ cannot import it.
const TICKET_KEY = /^[A-Z]{1,10}-\d{1,7}$/;
const needsYou = ({ ticket, state }) => TICKET_KEY.test(ticket) && NOTIFY_STATES.includes(state);

// How many of the bar's shown bots need the user: ticket bots only, waiting or failed.
export const needsYouCount = (bots) => bots.filter(needsYou).length;

// `(N) <title>`, or the title itself for none.
export const titleWithCount = (base, count) => (count > 0 ? `(${count}) ${base}` : base);
// The title without a count prefix this module put on it.
export const withoutCount = (title) => title.replace(/^\(\d+\) /, '');

// The one place the tab title is composed: the screen's own title (useRouteChange) and the "(N) " prefix
// (useNeedsYou) both go through `composeTitle`, so a screen change while the count shows keeps both.
// `shownCount` is the prefix now showing (0 for none), set by the hook that owns the count.
let shownCount = 0;
export const setShownCount = (count) => {
  shownCount = count;
};
export const composeTitle = (base) => titleWithCount(base, shownCount);

// The notifications to create for a batch of ready state changes (`settleChanges`' `ready`): none unless
// notifications are `enabled`, the browser `permission` is `granted` and the page is `hidden`; only
// changes to a NOTIFY_STATES state for a valid ticket key; at most MAX_CALLOUTS (like the
// bubbles), the newest kept. An item is `{ key, ticket, phase, tag, body }`, and nothing else of a
// change is read. The tag is the session key, so a repeat replaces the earlier one.
export function notificationsFor(ready, { enabled, permission, hidden } = {}) {
  if (!enabled || permission !== 'granted' || !hidden) return [];
  return ready
    .filter(({ ticket, to }) => TICKET_KEY.test(ticket) && NOTIFY_STATES.includes(to))
    .slice(-MAX_CALLOUTS)
    .map(({ key, ticket, phase, to }) => ({
      key,
      ticket,
      phase,
      tag: key,
      body: `${ticket} · ${CALLOUT_TEXT[to]}`,
    }));
}

// The choice is per viewer, off until the user turns it on, and the page works without storage.
const PREFERENCE_KEY = 'dev-dashboard.needs-you.notify';
export function readPreference(storage) {
  try {
    return storage?.getItem(PREFERENCE_KEY) === '1';
  } catch {
    return false;
  }
}
export function writePreference(storage, on) {
  try {
    storage?.setItem(PREFERENCE_KEY, on ? '1' : '0');
  } catch {
    // Private window or blocked storage: the choice only lasts until reload.
  }
}
