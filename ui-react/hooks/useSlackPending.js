import { useEffect, useRef, useState } from 'react';
import { getSlackPending } from '../lib/api.js';
import { SLACK_POLL_MS } from '../../ui/polling.js';

const SLACK_SESSION_EVENT = 'slack-session-changed';

// The panel announces a connect or disconnect here, so the badge stays truthful
// without the nav holding on to panel state or reaching into the panel's hooks.
export function notifySlackSessionChanged() {
  window.dispatchEvent(new Event(SLACK_SESSION_EVENT));
}

// Polls the pending summary independently of the Slack panel: the badge is
// mounted on every tab, while the panel only loads when the Slack tab is open.
export function useSlackPending() {
  const [pending, setPending] = useState(null);
  const inFlight = useRef(false);

  useEffect(() => {
    let current = true;
    const load = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const result = await getSlackPending();
        // getSlackPending degrades every failure into { available: false }, so a
        // stale badge is the worst outcome and it never needs an error state.
        if (current) setPending(result);
      } finally {
        inFlight.current = false;
      }
    };
    const tick = () => {
      if (!document.hidden) load();
    };
    load();
    const timer = setInterval(tick, SLACK_POLL_MS);
    window.addEventListener(SLACK_SESSION_EVENT, load);
    return () => {
      current = false;
      clearInterval(timer);
      window.removeEventListener(SLACK_SESSION_EVENT, load);
    };
  }, []);

  return { pending };
}
