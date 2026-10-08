import { useCallback, useEffect, useRef, useState } from 'react';

export function useActivePolling({ active, interval, load, loaded }) {
  const [lastLoadedAt, setLastLoadedAt] = useState(0);
  const [now, setNow] = useState(Date.now());
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
    const tick = () => {
      setNow(Date.now());
      if (!document.hidden && Date.now() - lastLoadedRef.current >= interval)
        loadOnce({ silent: true });
    };
    const timer = setInterval(tick, 1000);
    const visibility = () => {
      setNow(Date.now());
      if (!document.hidden && Date.now() - lastLoadedRef.current >= interval)
        loadOnce({ silent: true });
    };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [active, interval, loadOnce]);
  const remaining = Math.max(0, interval - (now - lastLoadedAt));
  const countdown =
    !loaded || !lastLoadedAt
      ? ''
      : document.hidden
        ? `refresh paused (${Math.ceil(remaining / 1000)}s)`
        : remaining
          ? `refresh in ${Math.ceil(remaining / 1000)}s`
          : 'refreshing…';
  return { load: loadOnce, countdown };
}
