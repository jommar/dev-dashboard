import { useEffect, useState } from 'react';
import { getHealth } from '../lib/api.js';

// The last good `/api/health` body, or null until one arrives. One read when `active` turns true and
// again whenever `refreshKey` changes (a board passes the stamp of its own refresh), none while it is
// false, and nothing on a clock. A `refreshKey` of 0 is a board that has not finished its first load:
// the read waits for that load (which then changes the key) instead of reading twice. A failed read keeps the previous body, so a screen with none shows
// no note rather than a wrong one.
export function useUpstreamHealth({ active = true, refreshKey } = {}) {
  const [health, setHealth] = useState(null);
  useEffect(() => {
    if (!active || refreshKey === 0) return undefined;
    let current = true;
    getHealth()
      .then((body) => {
        if (current) setHealth(body);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [active, refreshKey]);
  return health;
}
