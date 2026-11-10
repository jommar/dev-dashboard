const JIRA_STATUS_KIND = {
  // Queued (muted): early backlog / not yet in flight.
  'to do': 'queued',
  open: 'queued',
  backlog: 'queued',
  'selected for development': 'queued',
  'parking lot': 'queued',
  'needs definition': 'queued',
  'needs grooming': 'queued',
  'asynchronous grooming': 'queued',
  assigned: 'queued',
  scheduled: 'queued',
  'ready for scheduling': 'queued',
  discovery: 'queued',
  duplicate: 'queued',
  // Active (accent): in flight plus review/test/merge gates. Jira files
  // several of these under the "To Do" category (e.g. Ready For Code Review,
  // Ready For Testing, Awaiting Merge), so they are listed explicitly.
  'in progress': 'active',
  'work in progress': 'active',
  pending: 'active',
  'in development': 'active',
  'in review': 'active',
  'ready for code review': 'active',
  'ready for testing': 'active',
  'testing in progress': 'active',
  testing: 'active',
  qa: 'active',
  'awaiting merge': 'active',
  'stakeholder sign off': 'active',
  'promote to uat': 'active',
  delivery: 'active',
  'ready for delivery': 'active',
  impact: 'active',
  'in remediation': 'active',
  reopened: 'active',
  // Done (green): terminal success states.
  done: 'done',
  complete: 'done',
  deployed: 'done',
  closed: 'done',
  resolved: 'done',
  remediated: 'done',
  'hardening in uat': 'done',
  'ready for deployment': 'done',
  // Attention (red): blocked / negative terminal / escalation states.
  blocked: 'attention',
  impediment: 'attention',
  rejected: 'attention',
  'active incident': 'attention',
  'cs escalation': 'attention',
};

export function jiraStatusKind(status) {
  return JIRA_STATUS_KIND[String(status).trim().toLowerCase()] || 'unknown';
}
