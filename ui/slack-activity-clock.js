function parseServerTime(value) {
  if (typeof value !== 'string') return NaN;
  const match =
    /^([+-]\d{6}|\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!match) return NaN;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) return NaN;
  return Date.parse(value);
}

export function createSlackActivityClock({
  wallNow = Date.now,
  monotonicNow = () => performance.now(),
} = {}) {
  let anchor = wallNow();
  let anchorAt = monotonicNow();
  let wallAnchor = anchor;
  let lastWall = anchor;
  let latest = anchor;

  function advance(monotonic, wall, observed = -Infinity) {
    const extrapolated = anchor + Math.max(0, monotonic - anchorAt);
    // Wall time usually includes sleep even where performance.now() does not.
    // Compare both elapsed bounds, rather than adding them and double-counting.
    const wallExtrapolated = anchor + Math.max(0, wall - wallAnchor);
    latest = Math.max(latest, extrapolated, wallExtrapolated, wall, observed);
    if (latest > extrapolated || wall < lastWall) {
      anchor = latest;
      anchorAt = monotonic;
      wallAnchor = wall;
    }
    lastWall = wall;
    return latest;
  }

  function now() {
    return advance(monotonicNow(), wallNow());
  }

  function observe(serverTime, requestStartedAt, requestStartedWallAt) {
    const parsed = parseServerTime(serverTime);
    if (!Number.isFinite(parsed) || !Number.isFinite(requestStartedAt)) return;
    const monotonic = monotonicNow();
    const wall = wallNow();
    const wallElapsed = Number.isFinite(requestStartedWallAt) ? wall - requestStartedWallAt : 0;
    advance(monotonic, wall, parsed + Math.max(0, monotonic - requestStartedAt, wallElapsed));
  }

  return { now, observe };
}
