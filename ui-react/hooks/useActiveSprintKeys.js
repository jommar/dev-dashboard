import { useCallback, useEffect, useRef, useState } from 'react';
import { getActiveSprintTickets } from '../lib/api.js';
import { SPRINT_POLL_MS } from '../../ui/polling.js';
import { nextSprintKeys } from '../../ui/bot-bar.js';

// Which of `ticketKeys` are in a sprint Jira calls active, for the bot bar: a Set of keys, or null
// until the first good answer. It asks when the list of keys changes (a ticket the bar has not
// placed yet), every SPRINT_POLL_MS while the page is visible, and when the page becomes visible
// after that long; the server keeps each ticket's answer for a few minutes, so a repeat costs Jira
// nothing. A failed read, or Jira unavailable or not configured, keeps the last good set: the bar
// then shows no bot for a ticket it never placed, and never guesses.
export function useActiveSprintKeys(ticketKeys) {
  const [sprintKeys, setSprintKeys] = useState(null);
  const inFlight = useRef(false);
  const lastAskedAt = useRef(0);
  const asked = useRef('');
  const wanted = ticketKeys.join(',');
  const latest = useRef(ticketKeys);
  latest.current = ticketKeys;

  const refresh = useCallback(async () => {
    if (inFlight.current || latest.current.length === 0) return;
    inFlight.current = true;
    const keys = latest.current;
    asked.current = keys.join(',');
    try {
      const result = await getActiveSprintTickets(keys);
      lastAskedAt.current = Date.now();
      setSprintKeys((previous) => nextSprintKeys(previous, result));
    } finally {
      inFlight.current = false;
      // Keys that arrived while this was in flight were not part of it.
      if (latest.current.join(',') !== asked.current) refresh();
    }
  }, []);

  useEffect(() => {
    if (wanted && wanted !== asked.current) refresh();
  }, [wanted, refresh]);

  useEffect(() => {
    const tick = () => {
      if (!document.hidden) refresh();
    };
    const resume = () => {
      if (Date.now() - lastAskedAt.current >= SPRINT_POLL_MS) tick();
    };
    const timer = setInterval(tick, SPRINT_POLL_MS);
    document.addEventListener('visibilitychange', resume);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [refresh]);

  return sprintKeys;
}
