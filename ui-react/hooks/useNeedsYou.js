import { useCallback, useEffect, useRef, useState } from 'react';
import {
  needsYouCount,
  notificationsFor,
  readPreference,
  setShownCount,
  titleWithCount,
  withoutCount,
  writePreference,
} from '../../ui/needs-you.js';

// The browser side of the opt-in "Needs you" notification (the rules are in ui/needs-you.js). It is
// per viewer, off until the user turns it on from the Sessions drawer, and never asks for permission
// except from that click.
const NOTIFICATION_TITLE = 'Claude session';

// The page's storage and Notification, or nothing: both can be missing or throw (private window,
// blocked site data, an old browser), and the page works without them.
const storageOrNull = () => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};
const notificationApi = () => (typeof window !== 'undefined' ? window.Notification : undefined);
const permissionNow = () => notificationApi()?.permission ?? 'denied';

// `{ supported, on, permission, active, enable, disable }`. `on` is the stored choice, `permission`
// the browser's, and `active` is both together, the one thing the rest of the bar reads.
export function useNotifyPreference() {
  const supported = Boolean(notificationApi());
  const [on, setOn] = useState(() => supported && readPreference(storageOrNull()));
  const [permission, setPermission] = useState(permissionNow);

  // The browser's choice can change in its settings while the page is open: read it again when the
  // user comes back (shown or focused), so a revoked permission stops the hidden poll.
  useEffect(() => {
    const refresh = () => setPermission(permissionNow());
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  const enable = useCallback(() => {
    const api = notificationApi();
    if (!api) return Promise.resolve();
    // requestPermission is called straight from the click, before anything is awaited.
    const asked = api.permission === 'default' ? api.requestPermission() : api.permission;
    return Promise.resolve(asked)
      .then((answer) => {
        setPermission(answer);
        const granted = answer === 'granted';
        writePreference(storageOrNull(), granted);
        setOn(granted);
      })
      .catch(() => {}); // a browser whose request rejects leaves the toggle off
  }, []);
  const disable = useCallback(() => {
    writePreference(storageOrNull(), false);
    setOn(false);
  }, []);

  return { supported, on, permission, active: on && permission === 'granted', enable, disable };
}

// Whether the page is hidden, kept as state so the title follows the tab.
function useHidden() {
  const [hidden, setHidden] = useState(() => document.hidden);
  useEffect(() => {
    const change = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', change);
    return () => document.removeEventListener('visibilitychange', change);
  }, []);
  return hidden;
}

// While `active`: a desktop notification per ready state change that needs the user while the page is
// hidden, and `(N) <title>` while hidden, N being the shown bots that are waiting or failed. Returns
// `onReady(ready)` for `useBotCallouts`, which hands over the batch that also gets bubbles (so a first
// poll is never news). Clicking a notification focuses the window and calls `onOpen(ticket, phase)`.
export function useNeedsYouAlerts({ active, bots, onOpen }) {
  const hidden = useHidden();
  const latest = useRef({ active, onOpen });
  latest.current = { active, onOpen };
  const count = needsYouCount(bots);

  useEffect(() => {
    if (!active || !hidden) return undefined;
    // useRouteChange composes later screen titles with the count set here (composeTitle).
    setShownCount(count);
    document.title = titleWithCount(withoutCount(document.title), count);
    return () => {
      setShownCount(0);
      document.title = withoutCount(document.title);
    };
  }, [active, hidden, count]);

  return useCallback((ready) => {
    const Notify = notificationApi();
    if (!Notify) return;
    const items = notificationsFor(ready, {
      enabled: latest.current.active,
      permission: Notify.permission,
      hidden: document.hidden,
    });
    for (const { ticket, phase, body, tag } of items) {
      try {
        const note = new Notify(NOTIFICATION_TITLE, { body, tag });
        note.onclick = () => {
          window.focus();
          note.close();
          latest.current.onOpen(ticket, phase);
        };
      } catch {
        // A browser that refuses to build one here (it wants a service worker): the bubble stands.
      }
    }
  }, []);
}
