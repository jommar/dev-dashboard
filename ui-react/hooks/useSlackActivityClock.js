import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { nextSlackActivityChange } from '../../ui/slack-activity.js';
import { createSlackActivityClock } from '../../ui/slack-activity-clock.js';

// Never let an old snapshot or a slow browser clock extend the server's cutoff.
// A fast browser may expire a row early, which is safer than reviving an old one.
export function useSlackActivityClock(snapshot, active, openThread) {
  const [tick, setTick] = useState(0);
  const clock = useRef(null);
  if (!clock.current) clock.current = createSlackActivityClock();
  const currentTime = useCallback(() => clock.current.now(), []);
  const now = useMemo(() => {
    clock.current.observe(
      snapshot?.serverTime,
      snapshot?._requestStartedAt,
      snapshot?._requestStartedWallAt,
    );
    return currentTime();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- active and tick are triggers to read the clock again, not values read
  }, [snapshot, active, tick, currentTime]);

  useEffect(() => {
    const rows = [...(snapshot?.started || []), ...(snapshot?.mentions || [])];
    if (openThread) rows.push(openThread);
    const delay = Math.max(1, nextSlackActivityChange(rows, now) - now);
    const refresh = () => setTick((value) => value + 1);
    const timer = setTimeout(refresh, delay);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [snapshot, active, openThread, tick, now]);

  return [now, currentTime];
}
