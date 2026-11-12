import { useCallback, useEffect, useRef, useState } from 'react';
import {
  answerClaude,
  approveClaude,
  getClaudeTickets,
  launchClaude,
  rereviewClaude,
} from '../lib/api.js';
import { CLAUDE_POLL_MS } from '../../ui/polling.js';

// One shared empty map until the first answer, so the board's props stay equal between ticks.
const NO_TICKETS = Object.freeze({});
// The same for `lastActive`, the sessions' last-activity times, until a read has them.
const NO_ACTIVITY = Object.freeze({});

// `previous` while `next` holds the same JSON, so a poll that found nothing new keeps the same object.
const keepIfEqual = (previous, next) =>
  JSON.stringify(previous) === JSON.stringify(next) ? previous : next;

// Every ticket's Claude status from one GET /api/claude/tickets, never one request per card.
// It is read when the tab opens, every CLAUDE_POLL_MS while the tab is active and the page is
// visible, and right after a launch, an answer, an approval or a re-review. A failed read keeps the last map. `byTicket`
// and `lastActive` keep their identity while the answer is equal, so the memoized board is not re-rendered by a poll
// that found nothing new. `launch`, `answer`, `approve` and `rereview` resolve with the API result, whose `ticket` entry
// is put in the map at once: a poll that was already in flight cannot put the old state back.
export function useClaudeTickets({ active, source }) {
  const [byTicket, setByTicket] = useState(NO_TICKETS);
  // Per ticket and phase, the ISO time that session was last written to: `{}` until a read has one.
  const [lastActive, setLastActive] = useState(NO_ACTIVITY);
  // True once a read has answered: before that `byTicket` is the empty map, not an answer.
  const [loaded, setLoaded] = useState(false);
  const inFlight = useRef(false);
  const latest = useRef(0);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const request = ++latest.current;
    try {
      const result = await getClaudeTickets(source);
      if (request !== latest.current || !result.ok) return;
      const tickets = result.tickets ?? NO_TICKETS;
      const activity = result.lastActive ?? NO_ACTIVITY;
      setLoaded(true);
      setByTicket((previous) => keepIfEqual(previous, tickets));
      setLastActive((previous) => keepIfEqual(previous, activity));
    } finally {
      inFlight.current = false;
    }
  }, [source]);

  useEffect(() => {
    if (!active) return undefined;
    refresh();
    const tick = () => {
      if (!document.hidden) refresh();
    };
    const timer = setInterval(tick, CLAUDE_POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [active, refresh]);

  const settle = useCallback(
    (key, result) => {
      if (result.ok && result.ticket) {
        latest.current += 1;
        setByTicket((previous) => ({ ...previous, [key]: result.ticket }));
      }
      refresh();
      return result;
    },
    [refresh],
  );

  const launch = useCallback(
    async (key, phase, options) => settle(key, await launchClaude(key, phase, options)),
    [settle],
  );
  const answer = useCallback(
    async (key, answers, options) => settle(key, await answerClaude(key, answers, options)),
    [settle],
  );
  const approve = useCallback(async (key) => settle(key, await approveClaude(key)), [settle]);
  const rereview = useCallback(async (key) => settle(key, await rereviewClaude(key)), [settle]);

  return { byTicket, lastActive, loaded, launch, answer, approve, rereview };
}
