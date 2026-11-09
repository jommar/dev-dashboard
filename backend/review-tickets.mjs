import { captureConfiguration, freeze } from './settings.mjs';
import { fetchReviewReadyTickets } from './jira.mjs';
import { fetchAllOpenPRs } from './github.mjs';
import { fetchQueueReviewData } from './review.mjs';
import { prsByTicket } from './ticket-prs.mjs';
import { canonicalTicketKey } from '../ui/slack-ticket-links.js';

function queueTicket(ticket) {
  const sprints = ticket.sprints.map((sprint) => ({
    ...sprint,
    id: Number.isSafeInteger(sprint.id) || typeof sprint.id === 'string' ? sprint.id : null,
  }));
  return {
    key: canonicalTicketKey(ticket.key),
    summary: ticket.summary,
    status: ticket.status,
    statusCategory: typeof ticket.statusCategory === 'string' ? ticket.statusCategory : 'Unknown',
    priority: typeof ticket.priority === 'string' ? ticket.priority : null,
    updated: typeof ticket.updated === 'string' ? ticket.updated : null,
    created: typeof ticket.created === 'string' ? ticket.created : null,
    sprint: sprints[0] || null,
    sprints,
  };
}

export async function fetchReviewTickets({ snapshot } = {}) {
  const config = freeze(structuredClone(captureConfiguration(snapshot)));
  const options = { snapshot: config };
  const issues = await fetchReviewReadyTickets(options);
  const ticketsByKey = new Map();
  for (const issue of issues) {
    const ticket = queueTicket(issue);
    if (!ticketsByKey.has(ticket.key)) ticketsByKey.set(ticket.key, ticket);
  }
  const { prs, prCoverage } = await fetchAllOpenPRs(options);
  const eligible = prs.filter((pr) =>
    pr.tickets.some((key) => ticketsByKey.has(canonicalTicketKey(key))),
  );
  const { reviews } = await fetchQueueReviewData(eligible, options);
  const byTicket = prsByTicket(
    eligible.map((pr) => ({
      repo: pr.repo,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      owner: pr.owner,
      draft: pr.draft,
      updatedAt: typeof pr.updatedAt === 'string' ? pr.updatedAt : null,
      review: reviews[`${pr.repo}#${pr.number}`],
      tickets: pr.tickets,
    })),
  );
  const tickets = [...ticketsByKey.values()]
    .sort(
      (a, b) =>
        (Date.parse(b.updated) || 0) - (Date.parse(a.updated) || 0) || a.key.localeCompare(b.key),
    )
    .map((ticket) => ({ ...ticket, prs: byTicket[ticket.key] || [] }));
  return { total: tickets.length, tickets, prCoverage, updatedAt: new Date().toISOString() };
}
