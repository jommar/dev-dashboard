// home-data.js — the derivation behind the Home overview. Pure and DOM-free on
// purpose: this is the riskiest logic in the feature (urgency ordering, sprint
// scoping, "who still owes a review"), so it lives where node --test can reach
// it. See test/home-data.test.mjs.
//
// Everything here takes the raw /api/prs and /api/my-tickets payloads exactly
// as the server sends them.

export function sprintKeyOf(sprint) {
  return String(sprint.id ?? sprint.name);
}

// Every ticket in the payload, flattened out of groupsByCategory.
export function allTickets(tickets) {
  if (!tickets) return [];
  return Object.values(tickets.groupsByCategory || {}).flat();
}

// Sprint identity: prefer the id, fall back to the name for instances where
// the Greenhopper field omits it.
function sameSprint(a, b) {
  if (!a || !b) return false;
  return a.id != null && b.id != null ? a.id === b.id : a.name === b.name;
}

// Scoped over the ticket's whole `sprints` list rather than its display
// `sprint`: a ticket carried into a later sprint still counts toward the
// active one it belongs to, and a ticket can legitimately sit in two.
export function inSprints(ticket, sprints) {
  if (!ticket || !sprints || !sprints.length) return false;
  const own = ticket.sprints && ticket.sprints.length ? ticket.sprints : [ticket.sprint];
  return own.some((s) => sprints.some((a) => sameSprint(a, s)));
}

// The single band rule. Counts and points both go through it so the two can
// never disagree about which band a ticket belongs to.
export function band(ticket) {
  if (ticket.statusCategory === 'Done') return 'done';
  if (ticket.statusCategory === 'In Progress') return 'active';
  return 'todo';
}

export function countsByCategory(list) {
  const counts = { todo: 0, active: 0, done: 0 };
  for (const t of list) counts[band(t)]++;
  return counts;
}

// Points per band. An unestimated ticket (storyPoints === null) adds nothing
// here — it is reported separately as `unestimated` so it cannot go silently
// missing just because it contributes no width.
export function pointsByCategory(list) {
  const points = { todo: 0, active: 0, done: 0 };
  for (const t of list) {
    if (Number.isFinite(t.storyPoints)) points[band(t)] += t.storyPoints;
  }
  return points;
}

export function unestimatedOf(list) {
  return list.filter((t) => !Number.isFinite(t.storyPoints));
}

// Newest-first: the expanded list is something a human scans.
const byUpdatedDesc = (a, b) => (Date.parse(b.updated) || 0) - (Date.parse(a.updated) || 0);

// One entry per active sprint (a user can span several — one per board).
// `byBand` carries the tickets themselves so the panel can render the
// drill-down without re-deriving the sprint scoping.
export function sprintProgress(tickets) {
  const sprints = (tickets && tickets.activeSprints) || [];
  return sprints.map((sp) => sprintProgressFor(tickets, sp));
}

// Every sprint found on the fetched tickets — the selector source. Prefers the
// server-provided `allSprints` (jira.mjs) and falls back to deriving from the
// ticket payloads so old cached payloads and unit tests keep working.
export function selectableSprints(tickets) {
  if (tickets && Array.isArray(tickets.allSprints) && tickets.allSprints.length) {
    return tickets.allSprints;
  }
  const byId = new Map();
  for (const t of allTickets(tickets)) {
    for (const s of t?.sprints || []) {
      if (!s || typeof s.name !== 'string' || !s.name) continue;
      const key = s.id ?? s.name;
      if (!byId.has(key)) byId.set(key, s);
    }
  }
  const rank = (s) => ({ active: 0, future: 1, closed: 2 })[s.state] ?? 3;
  const endsAt = (s) => {
    const t = Date.parse(s.endDate);
    return Number.isFinite(t) ? t : 0;
  };
  return [...byId.values()].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (a.state === 'future' || b.state === 'future') {
      const ea = endsAt(a) || Number.MAX_SAFE_INTEGER;
      const eb = endsAt(b) || Number.MAX_SAFE_INTEGER;
      if (ea !== eb) return ea - eb;
    } else if (endsAt(a) !== endsAt(b)) {
      return endsAt(b) - endsAt(a);
    }
    return String(a.name).localeCompare(String(b.name));
  });
}

// The progress entry for one sprint, active or closed. sprintProgress() above
// maps this over the active sprints; the Home selector calls it for whichever
// sprint is selected. KPIs intentionally stay active-scoped (see kpiCounts).
export function sprintProgressFor(tickets, sprint) {
  const list = allTickets(tickets).filter((t) => inSprints(t, [sprint]));
  const points = pointsByCategory(list);
  const byBand = { todo: [], active: [], done: [] };
  for (const t of list) byBand[band(t)].push(t);
  // Unestimated is a fourth drill-down, not just a caveat: those tickets add
  // no width to the bar, so the useful thing to do with the number is go and
  // estimate them.
  byBand.unestimated = unestimatedOf(list);
  for (const key of Object.keys(byBand)) byBand[key].sort(byUpdatedDesc);
  return {
    sprint,
    counts: countsByCategory(list),
    total: list.length,
    points,
    pointsTotal: points.todo + points.active + points.done,
    unestimated: byBand.unestimated.length,
    byBand,
  };
}

// Velocity series for the Home chart. A carried ticket contributes to every
// sprint Jira lists for it, matching sprintProgressFor's scoping rule.
export function donePointsBySprint(tickets) {
  const done = allTickets(tickets).filter((t) => band(t) === 'done');
  const series = selectableSprints(tickets)
    .filter((sprint) => sprint.state === 'closed' || sprint.state === 'active')
    .map((sprint) => {
      const list = done.filter((ticket) => inSprints(ticket, [sprint]));
      return {
        sprint,
        points: list.reduce(
          (sum, ticket) => sum + (Number.isFinite(ticket.storyPoints) ? ticket.storyPoints : 0),
          0,
        ),
        count: list.length,
        unestimated: unestimatedOf(list).length,
      };
    });
  const endsAt = (entry) => {
    const time = Date.parse(entry.sprint.endDate);
    return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER;
  };
  series.sort(
    (a, b) => endsAt(a) - endsAt(b) || String(a.sprint.name).localeCompare(String(b.sprint.name)),
  );
  return series;
}

// `reviewDataAvailable` is set from the *non-mine* review fetch
// (server.mjs:141), so it says nothing about my own PRs. If the GraphQL call
// for my PRs failed, every pr.reviews is null and any state-derived count
// would read a misleading 0 — detect that and report unknown instead.
export function myReviewsUnknown(prs) {
  if (!prs) return true;
  const mine = prs.prs || [];
  if (!mine.length) return false;
  return mine.every((p) => !p.reviews);
}

const reviewedBy = (pr) => [
  ...((pr.reviews && pr.reviews.approvers) || []),
  ...((pr.reviews && pr.reviews.changesRequesters) || []),
];

// Other people's open PRs under the approval threshold that I have not already
// reviewed. Drafts are excluded: `is:pr is:open` matches them, but a draft is
// not asking for review yet.
//
// This is deliberately NOT "reviews requested from me" — requested reviewers
// are never fetched (review.mjs asks only for submitted reviews), so that is
// not knowable without a new upstream call.
export function needsMyReview(prs) {
  if (!prs) return [];
  const login = prs.login;
  return (prs.prsNeedingApprovals || []).filter(
    (p) => !p.draft && !(login && reviewedBy(p).includes(login)),
  );
}

export function myPrsWithChangesRequested(prs) {
  return ((prs && prs.prs) || []).filter(
    (p) => p.reviews && p.reviews.state === 'changes_requested',
  );
}

export function myPrsAwaitingApproval(prs) {
  return ((prs && prs.prs) || []).filter(
    (p) =>
      !p.draft &&
      p.reviews &&
      p.reviews.state !== 'changes_requested' &&
      !(p.reviews.approvers || []).length,
  );
}

// Stalest first — the longest-ignored item is the one actually blocking.
const byOldest = (field) => (a, b) => (Date.parse(a[field]) || 0) - (Date.parse(b[field]) || 0);

// The queue, most urgent first. Tiers 1-3 mean somebody is waiting; tier 4 is
// your own current work and reads as context, so it comes last.
export function actionQueue(prs, tickets) {
  const inProgress = allTickets(tickets)
    .filter((t) => t.statusCategory === 'In Progress')
    .sort(byOldest('updated'));
  return [
    {
      id: 'changes-requested',
      reason: 'Your PRs with changes requested',
      kind: 'pr',
      items: myPrsWithChangesRequested(prs).sort(byOldest('updatedAt')),
    },
    {
      id: 'needs-approval',
      reason: `Teammates waiting on a review (${prs ? prs.approvalThreshold : 1} required)`,
      kind: 'pr',
      items: needsMyReview(prs).sort(byOldest('updatedAt')),
    },
    {
      id: 'awaiting-approval',
      reason: 'Your PRs still waiting on approval',
      kind: 'pr',
      items: myPrsAwaitingApproval(prs).sort(byOldest('updatedAt')),
    },
    {
      id: 'in-progress',
      reason: 'Tickets in progress',
      kind: 'ticket',
      items: inProgress,
    },
  ];
}

// Spend a fixed row budget in tier order, so the most urgent rows are never
// the ones truncated away.
export function capTiers(tiers, cap) {
  let budget = cap;
  let hidden = 0;
  const kept = tiers.map((tier) => {
    const take = Math.max(0, Math.min(tier.items.length, budget));
    hidden += tier.items.length - take;
    budget -= take;
    return { ...tier, items: tier.items.slice(0, take) };
  });
  return { tiers: kept, hidden };
}

export function kpiCounts(prs, tickets) {
  const sprints = (tickets && tickets.activeSprints) || [];
  const inSprint = allTickets(tickets).filter((t) => inSprints(t, sprints));
  return {
    myPrs: ((prs && prs.prs) || []).length,
    needsReview: needsMyReview(prs).length,
    sprintTickets: inSprint.length,
    sprintDone: inSprint.filter((t) => t.statusCategory === 'Done').length,
  };
}
