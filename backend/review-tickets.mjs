import { captureConfiguration, freeze } from './settings.mjs';
import { fetchReviewReadyTickets, jiraConfig } from './jira.mjs';
import { PR_DISCOVERY_INCOMPLETE, PR_DISCOVERY_UNAVAILABLE } from './github.mjs';
import { fetchQueueReviewData } from './review.mjs';
import { lookUpPullRequests } from './dev-status.mjs';
import { LOOKUP_TTL_MS, linkedPrs, prsByTicket, readDetails } from './ticket-prs.mjs';
import { canonicalTicketKey } from '../ui/slack-ticket-links.js';

function queueTicket(ticket) {
  const sprints = ticket.sprints.map((sprint) => ({
    ...sprint,
    id: Number.isSafeInteger(sprint.id) || typeof sprint.id === 'string' ? sprint.id : null,
  }));
  return {
    key: canonicalTicketKey(ticket.key),
    summary: ticket.summary,
    assignee: ticket.assignee,
    status: ticket.status,
    statusCategory: typeof ticket.statusCategory === 'string' ? ticket.statusCategory : 'Unknown',
    priority: typeof ticket.priority === 'string' ? ticket.priority : null,
    updated: typeof ticket.updated === 'string' ? ticket.updated : null,
    created: typeof ticket.created === 'string' ? ticket.created : null,
    sprint: sprints[0] || null,
    sprints,
  };
}

// The newest tickets asked about; more than this makes discovery incomplete, never silently short.
const TICKET_LOOKUP_CAP = 100;

const coverage = (available, complete, repos = []) => ({
  available,
  complete,
  repos,
  reasons: complete ? [] : [available ? PR_DISCOVERY_INCOMPLETE : PR_DISCOVERY_UNAVAILABLE],
});

// The open PRs Jira links to the queue's tickets, as My Tickets finds its own: Jira dev-status names
// the PRs of each ticket (any repository), then GitHub says which are open, a draft and by whom.
// Never throws: a Jira or GitHub failure is reported in `prCoverage`, so the queue keeps its tickets.
async function discoverLinkedOpenPrs(issues, config) {
  const jira = jiraConfig(config);
  if (!config.credentials.githubToken || !jira)
    return { prs: [], prCoverage: coverage(false, false) };
  try {
    const withId = issues.filter((issue) => issue.id);
    const entries = withId
      .slice(0, TICKET_LOOKUP_CAP)
      .map((issue) => ({ issueId: issue.id, ticket: issue }));
    const outcomes = await lookUpPullRequests(jira, entries, {
      refresh: false,
      ttlMs: LOOKUP_TTL_MS,
    });
    const failed = entries.filter((entry) => outcomes.get(entry).error).length;
    if (entries.length && failed === entries.length)
      return { prs: [], prCoverage: coverage(false, false) };
    const linked = linkedPrs(entries, outcomes);
    const details = await readDetails(linked, config);
    if (linked.length && details.every((detail) => detail.failed))
      return { prs: [], prCoverage: coverage(false, false) };
    const prs = linked.flatMap((pr, index) =>
      details[index].open
        ? [{ ...pr, owner: details[index].login, draft: details[index].draft }]
        : [],
    );
    const complete =
      failed === 0 &&
      withId.length === issues.length &&
      issues.length <= TICKET_LOOKUP_CAP &&
      !details.some((detail) => detail.failed);
    return {
      prs,
      prCoverage: coverage(true, complete, [...new Set(prs.map((pr) => pr.repo))].sort()),
    };
  } catch {
    return { prs: [], prCoverage: coverage(false, false) };
  }
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
  const { prs, prCoverage } = await discoverLinkedOpenPrs(issues, config);
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
