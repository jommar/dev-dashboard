import { useEffect, useState } from 'react';
import { getClaudeUsage } from '../lib/api.js';
import { sumUsage } from '../../ui/format-tokens.js';

// The token tally of `sessions` (session UUIDs, at most 8): `{ usage, total }`. `usage` is the usage
// route's `{ [id]: { tokens, models, messages, complete } }` (null until it answers) and `total` the
// `{ total, complete }` sum of the sessions it answered (null for none), for `tokensLabel`. One request
// when `active` turns true or the sessions change, none while it is false, and never a timer: the
// caller turns `active` off and on again to ask again. A failed request keeps the last answer.
export function useClaudeUsage({ sessions, active }) {
  const [usage, setUsage] = useState(null);
  const ids = sessions.join(',');
  useEffect(() => {
    if (!active || !ids) return undefined;
    let current = true;
    getClaudeUsage(ids.split(',')).then((result) => {
      if (current && result.ok) setUsage(result.sessions);
    });
    return () => {
      current = false;
    };
  }, [active, ids]);
  const answered = ids ? ids.split(',').filter((id) => usage?.[id]) : [];
  return { usage, total: answered.length ? sumUsage(answered.map((id) => usage[id])) : null };
}
