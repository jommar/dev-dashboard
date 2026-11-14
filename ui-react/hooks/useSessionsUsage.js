import { useEffect, useMemo, useState } from 'react';
import { getClaudeUsage } from '../lib/api.js';
import { usageChunks, usageSessionIds } from '../../ui/session-usage.js';

// The token tallies of the Sessions drawer's rows: `{ [sessionId]: { tokens, models, messages, complete } }`
// from GET /api/claude/usage, in batches of the route's size (one request each, in parallel). Asked
// when `active` (the drawer is open) turns true or the rows' sessions change, never while it is shut and
// never on a timer: closing and opening the drawer is how it asks again. A failed batch keeps what the
// others (and the last open) said.
export function useSessionsUsage({ groups, active }) {
  const [usage, setUsage] = useState({});
  const key = useMemo(() => usageSessionIds(groups).join(','), [groups]);
  useEffect(() => {
    if (!active || !key) return undefined;
    let current = true;
    for (const chunk of usageChunks(key.split(','))) {
      getClaudeUsage(chunk).then((result) => {
        if (current && result.ok) setUsage((previous) => ({ ...previous, ...result.sessions }));
      });
    }
    return () => {
      current = false;
    };
  }, [active, key]);
  return usage;
}
