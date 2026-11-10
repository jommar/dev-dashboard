// Every sprint on the fetched tickets, first object per uncoerced id/name.
// Active and closed sort latest end date first, future nearest-first, then name.
const SPRINT_STATE_ORDER = { active: 0, future: 1, closed: 2 };

export function allSprints(tickets) {
  const byId = new Map();
  for (const t of tickets || []) {
    for (const s of t?.sprints || []) {
      if (!s || typeof s.name !== 'string' || !s.name) continue;
      const key = s.id ?? s.name;
      if (!byId.has(key)) byId.set(key, s);
    }
  }
  const endsAt = (s) => {
    const t = Date.parse(s.endDate);
    return Number.isFinite(t) ? t : 0;
  };
  return [...byId.values()].sort((a, b) => {
    const ra = SPRINT_STATE_ORDER[a.state] ?? 3;
    const rb = SPRINT_STATE_ORDER[b.state] ?? 3;
    if (ra !== rb) return ra - rb;
    if (a.state === 'future' || b.state === 'future') {
      // Nearest upcoming first; missing dates sort last within the group.
      const ea = endsAt(a) || Number.MAX_SAFE_INTEGER;
      const eb = endsAt(b) || Number.MAX_SAFE_INTEGER;
      if (ea !== eb) return ea - eb;
    } else if (endsAt(a) !== endsAt(b)) {
      return endsAt(b) - endsAt(a);
    }
    return String(a.name).localeCompare(String(b.name));
  });
}
