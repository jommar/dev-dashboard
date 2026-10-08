// uat-promote.mjs — cross-reference Jira tickets in Promote-to-UAT status
// against open PRs grouped by ticket, keeping only PRs whose base branch is
// the ops/development promotion target. Fetches its own PR groups via a
// dedicated fetchOpenPRs() call, independent of whatever the main /api/prs
// list is doing — so this lookup's success or failure never depends on, and
// never affects, the main PR fetch. Never throws: any failure (Jira
// unconfigured/unreachable, the GitHub fetch failing, a per-PR lookup
// failing) degrades to an empty, unavailable result so /api/prs never breaks
// because of this lookup.
import { fetchUatPromoteTickets } from './jira.mjs';
import { fetchPrBase, fetchOpenPRs } from './github.mjs';
import { DIFF_BASE } from './diff.mjs';
import { captureConfiguration } from './settings.mjs';

export async function fetchUatPromoteCandidates({ snapshot } = {}) {
  const options = { snapshot: captureConfiguration(snapshot) };
  try {
    const { groups: prGroupsByTicket } = await fetchOpenPRs(options);
    const tickets = await fetchUatPromoteTickets(options);
    const groups = {};
    let total = 0;
    for (const ticket of tickets) {
      const prs = prGroupsByTicket?.[ticket.key];
      if (!prs || !prs.length) continue;
      const enriched = await Promise.all(
        prs.map(async (pr) => ({
          ...pr,
          base: await fetchPrBase(pr.repo, pr.number, options).catch(() => null),
        })),
      );
      const matching = enriched.filter((pr) => pr.base === DIFF_BASE);
      if (!matching.length) continue;
      groups[ticket.key] = { ticket, prs: matching };
      total += matching.length;
    }
    return { available: true, groups, total };
  } catch {
    return { available: false, groups: {}, total: 0 };
  }
}
