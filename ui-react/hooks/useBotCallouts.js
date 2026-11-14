import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addCallouts,
  announcementText,
  attendCallout,
  liveCallouts,
  nextCalloutChange,
  rememberStates,
  sessionStates,
  settleChanges,
  stateChanges,
} from '../../ui/bot-bar.js';

// The bot bar's callouts and screen reader announcements: what happened when a session's state
// changed between two polls while the page was open. `byTicket` is the Claude status map, `loaded`
// whether it has answered (the first answer is only a baseline, never news) and `bots` the bots now
// shown. A change is held until its bot is shown (its ticket may not be placed in the sprint yet).
// Timers are timeouts, one at a time, cleared on unmount.
//
// Returns `callouts` (the bubbles to draw, `{ key, ticket, state, leaving }`), `announcements` (one
// `{ id, text }` per change of the latest batch, for the one polite live region) and `attend(key)`,
// which starts a waiting or failed bubble on its way out once its bot is hovered, focused or clicked.
// `onReady(ready)`, when given, is told the same batch of changes that gets bubbles (once per batch, in the
// same effect), so the opt-in desktop notification shares the first-load and sprint-filter rules.
export function useBotCallouts(byTicket, loaded, bots, onReady) {
  const baseline = useRef(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const [pending, setPending] = useState([]);
  const [callouts, setCallouts] = useState([]);
  const [announcements, setAnnouncements] = useState([]);
  const [clock, setClock] = useState(0);

  useEffect(() => {
    if (!loaded) return;
    const next = sessionStates(byTicket);
    const changes = stateChanges(baseline.current, next);
    baseline.current = rememberStates(baseline.current, next);
    if (changes.length) {
      const at = Date.now();
      setPending((previous) => [...previous, ...changes.map((change) => ({ ...change, at }))]);
    }
  }, [byTicket, loaded]);

  useEffect(() => {
    if (!pending.length) return;
    const now = Date.now();
    const { ready, waiting } = settleChanges(pending, bots, now);
    if (!ready.length && waiting.length === pending.length) return;
    setPending(waiting);
    if (!ready.length) return;
    setCallouts((previous) => addCallouts(previous, ready, now));
    onReadyRef.current?.(ready);
    setAnnouncements(
      ready.map((change) => ({
        id: `${change.key}@${now}`,
        text: announcementText(
          change,
          bots.find(({ key }) => key === change.key),
        ),
      })),
    );
  }, [pending, bots]);

  // A bubble for a bot that is no longer shown goes with it.
  useEffect(() => {
    const shown = new Set(bots.map(({ key }) => key));
    setCallouts((previous) =>
      previous.every(({ key }) => shown.has(key))
        ? previous
        : previous.filter(({ key }) => shown.has(key)),
    );
  }, [bots]);

  useEffect(() => {
    const wait = nextCalloutChange(callouts, Date.now());
    if (wait === null) return undefined;
    const timer = setTimeout(() => setClock((count) => count + 1), wait + 10);
    return () => clearTimeout(timer);
  }, [callouts, clock]);

  // `clock` is not read: it is what makes the bubbles be worked out again when one is due to go.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- clock is the recompute trigger for a bubble's time, not a value read
  const live = useMemo(() => liveCallouts(callouts, Date.now()), [callouts, clock]);
  const attend = useCallback(
    (key) => setCallouts((previous) => attendCallout(previous, key, Date.now())),
    [],
  );
  return { callouts: live, announcements, attend };
}
