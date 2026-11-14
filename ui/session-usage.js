// session-usage.js — which sessions the Sessions drawer asks tokens for and how a row reads them.
import { sumUsage, tokensLabel } from './format-tokens.js';

// GET /api/claude/usage takes at most this many sessions per request.
export const USAGE_CHUNK = 8;
// At most this many sessions are asked for in all (three requests), so an open drawer stays cheap.
export const MAX_ROW_SESSIONS = 3 * USAGE_CHUNK;

// The distinct session ids of the drawer's rows, in row order, up to MAX_ROW_SESSIONS.
export function usageSessionIds(groups = []) {
  const ids = new Set();
  for (const { rows } of groups) for (const { session } of rows) if (session) ids.add(session);
  return [...ids].slice(0, MAX_ROW_SESSIONS);
}

// `ids` cut into requests of the route's size.
export function usageChunks(ids) {
  const chunks = [];
  for (let at = 0; at < ids.length; at += USAGE_CHUNK) chunks.push(ids.slice(at, at + USAGE_CHUNK));
  return chunks;
}

// A row's label ("~1.2M tokens"), or null when its session has no tally or an empty one.
export function rowUsageLabel(tally) {
  if (!tally?.tokens) return null;
  const sum = sumUsage([tally]);
  return sum.total > 0 ? tokensLabel(sum) : null;
}
