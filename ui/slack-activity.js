import { parseSlackTs } from './slack-timestamp.js';

// The shared list is scoped by root creation, not the time of its latest reply.
const DAY = 24 * 60 * 60 * 1000;
const THREE_HOURS = 3 * 60 * 60 * 1000;
export const SLACK_WINDOW_MS = 28 * DAY;

export const ACTIVITY_GROUPS = [
  { id: 'last-3-hours', label: 'Last 3 hours' },
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'past-week', label: 'Past week' },
  { id: 'past-month', label: 'Past month' },
];

// The opaque backend version tracks credential changes even for legacy records.
// The fallbacks retain compatibility with an older backend during rollout.
export function slackSessionIdentity(status, previous = '') {
  if (!status?.connected) return '';
  if (typeof status.sessionVersion === 'string' && status.sessionVersion)
    return `version:${status.sessionVersion}`;
  if (status.savedAt) return `session:${status.teamDomain || ''}:${status.savedAt}`;
  if (status.verified === false) return previous;
  const team = status.teamId || status.team || '';
  const user = status.userId || status.user || '';
  return team || user ? `account:${team}:${user}` : previous;
}

// Slack timestamps are decimal seconds, not floating-point numbers. Preserve all
// six fractional digits for eligibility, ordering and exact boundary checks.
function slackMicros(value) {
  const parts = parseSlackTs(value);
  return parts ? parts[0] * 1000000n + parts[1] : null;
}

export function eligibleSlackRoot(ts, now) {
  const root = slackMicros(ts);
  if (root === null || !Number.isFinite(now)) return false;
  const current = BigInt(Math.trunc(now)) * 1000n;
  return root <= current && root >= current - BigInt(SLACK_WINDOW_MS) * 1000n;
}

function activityMicros(thread, now) {
  const root = slackMicros(thread?.ts);
  if (root === null) return null;
  let activity;
  if (thread.activityTs === null) return null;
  if (thread.activityTs !== undefined) {
    activity = slackMicros(thread.activityTs);
    // Both representations must describe the same millisecond.
    const iso = Date.parse(thread.activityAt);
    if (activity === null || !Number.isFinite(iso) || activity / 1000n !== BigInt(iso)) return null;
  } else if (thread.activityAt) {
    const iso = Date.parse(thread.activityAt);
    if (!Number.isFinite(iso)) return null;
    activity = BigInt(iso) * 1000n;
  } else if (thread.replyCount === 0 && thread.activityTs === undefined) {
    activity = root;
  } else return null;
  if (activity < root || (thread.replyCount > 0 && activity <= root)) return null;
  if (activity > BigInt(Math.trunc(now)) * 1000n) return null;
  return activity;
}

function localMidnight(now, daysAgo = 0) {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - daysAgo).getTime();
}

export function groupSlackActivity(threads, now) {
  const groups = ACTIVITY_GROUPS.map((group) => ({ ...group, threads: [] }));
  const unknown = [];
  const today = localMidnight(now);
  const yesterday = localMidnight(now, 1);
  const weekStart = localMidnight(now, 7);
  const monthStart = localMidnight(now, 30);
  for (const thread of threads || []) {
    if (!eligibleSlackRoot(thread?.ts, now)) continue;
    const activity = activityMicros(thread, now);
    if (activity === null) {
      unknown.push({ thread, activity });
      continue;
    }
    const ms = Number(activity / 1000n);
    const index =
      activity >= BigInt(Math.trunc(now - THREE_HOURS)) * 1000n
        ? 0
        : ms >= today
          ? 1
          : ms >= yesterday
            ? 2
            : ms >= weekStart
              ? 3
              : ms >= monthStart
                ? 4
                : -1;
    (index < 0 ? unknown : groups[index].threads).push({ thread, activity });
  }
  const sort = (left, right) => {
    if (left.activity !== right.activity) {
      if (left.activity === null) return 1;
      if (right.activity === null) return -1;
      return left.activity > right.activity ? -1 : 1;
    }
    return String(left.thread.ts).localeCompare(String(right.thread.ts));
  };
  for (const group of groups) group.threads = group.threads.sort(sort).map((item) => item.thread);
  return { groups, unknown: unknown.sort(sort).map((item) => item.thread) };
}

// Wake at a boundary, not just at the next network poll. Equality is included,
// so the actual transition is one millisecond after the boundary.
export function nextSlackActivityChange(threads, now) {
  let next = Math.min(now + 60_000, localMidnight(now, -1));
  for (const thread of threads || []) {
    const root = slackMicros(thread?.ts);
    if (root !== null) {
      const expiry = Number(root / 1000n) + SLACK_WINDOW_MS + 1;
      if (expiry > now) next = Math.min(next, expiry);
    }
    const activity = activityMicros(thread, now);
    if (activity !== null) {
      const expiry = Number(activity / 1000n) + THREE_HOURS + 1;
      if (expiry > now) next = Math.min(next, expiry);
    }
  }
  return next;
}
