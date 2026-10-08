const SPRINT_DAY = { month: 'short', day: 'numeric' };

export function sprintDay(iso) {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? new Date(time).toLocaleDateString(undefined, SPRINT_DAY) : null;
}

export function sprintCountdown(endDate) {
  const time = Date.parse(endDate);
  if (!Number.isFinite(time)) return '';
  const days = Math.ceil((time - Date.now()) / 86_400_000);
  if (days > 1) return `${days} days left`;
  if (days === 1) return '1 day left';
  if (days === 0) return 'ends today';
  const ago = Math.abs(days);
  return `ended ${ago} day${ago === 1 ? '' : 's'} ago`;
}
