import { useCallback, useEffect, useRef, useState } from 'react';
import { answerClaude, approveClaude, getClaudeTickets, launchClaude } from '../lib/api.js';
import { CLAUDE_POLL_MS } from '../../ui/polling.js';

// One shared empty map until the first answer, so the board's props stay equal between ticks.
const NO_TICKETS = Object.freeze({});

// Every ticket's Claude status from one GET /api/claude/tickets, never one request per card.
// It is read when the tab opens, every CLAUDE_POLL_MS while the tab is active and the page is
// visible, and right after a launch, an answer or an approval. A failed read keeps the last map. `byTicket`
// keeps its identity while the answer is equal, so the memoized board is not re-rendered by a poll
// that found nothing new. `launch`, `answer` and `approve` resolve with the API result, whose `ticket` entry
// is put in the map at once: a poll that was already in flight cannot put the old state back.
export function useClaudeTickets({ active }) {
  const [byTicket, setByTicket] = useState(NO_TICKETS);
  const inFlight = useRef(false);
  const latest = useRef(0);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const request = ++latest.current;
    try {
      const result = await getClaudeTickets();
      if (request !== latest.current || !result.ok) return;
      const tickets = result.tickets ?? NO_TICKETS;
      setByTicket((previous) =>
        JSON.stringify(previous) === JSON.stringify(tickets) ? previous : tickets,
      );
    } finally {
      inFlight.current = false;
    }
  }, []);

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
    async (key, phase) => settle(key, await launchClaude(key, phase)),
    [settle],
  );
  const answer = useCallback(
    async (key, answers, options) => settle(key, await answerClaude(key, answers, options)),
    [settle],
  );
  const approve = useCallback(async (key) => settle(key, await approveClaude(key)), [settle]);

  return { byTicket, launch, answer, approve };
}
