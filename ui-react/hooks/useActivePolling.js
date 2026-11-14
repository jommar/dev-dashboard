import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// Polls `load` while `active`, once at activation and again each `interval` while the page is
// visible, never two at once. `countdown` is a descriptor, `{ lastLoadedAt, interval, loaded,
// active }`, not text: RefreshControl hands it to BoardCountdown, which owns the 1 s clock and the words. The
// clock lives there so that only a label re-renders per second, never the panel; the tick kept here
// holds no state and exists only to start a poll that has come due.
export function useActivePolling({ active, interval, load, loaded }) {
  const [lastLoadedAt, setLastLoadedAt] = useState(0);
  const inFlight = useRef(false);
  const loadRef = useRef(load);
  const loadedRef = useRef(loaded);
  const lastLoadedRef = useRef(0);
  loadRef.current = load;
  loadedRef.current = loaded;
  const loadOnce = useCallback(async (options) => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      await loadRef.current(options);
    } finally {
      lastLoadedRef.current = Date.now();
      setLastLoadedAt(lastLoadedRef.current);
      inFlight.current = false;
    }
  }, []);
  useEffect(() => {
    if (!active) return undefined;
    if (!loadedRef.current || Date.now() - lastLoadedRef.current >= interval)
      loadOnce({ silent: loadedRef.current });
    const pollIfDue = () => {
      if (!document.hidden && Date.now() - lastLoadedRef.current >= interval)
        loadOnce({ silent: true });
    };
    const timer = setInterval(pollIfDue, 1000);
    document.addEventListener('visibilitychange', pollIfDue);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', pollIfDue);
    };
  }, [active, interval, loadOnce]);
  const countdown = useMemo(
    () => ({ lastLoadedAt, interval, loaded, active }),
    [lastLoadedAt, interval, loaded, active],
  );
  return { load: loadOnce, countdown };
}
