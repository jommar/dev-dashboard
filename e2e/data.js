function releasePr(repo, number, overrides = {}) {
  return {
    repo,
    number,
    title: `Synthetic change ${number}`,
    owner: `pr-owner-${number}`,
    url: `https://github.com/${repo}/pull/${number}`,
    state: 'open',
    base: 'ops/development',
    head: `DEMO-${number}/synthetic-change`,
    updatedAt: '2026-10-06T12:00:00Z',
    countsAsMerged: false,
    ...overrides,
  };
}

function mergedReleasePr(repo, number, overrides = {}) {
  return releasePr(repo, number, { state: 'merged', countsAsMerged: true, ...overrides });
}

function releaseTicket(key, summary, mergeState, prs = [], overrides = {}) {
  return {
    key,
    summary,
    status: 'In Progress',
    issueType: 'Story',
    priority: 'Medium',
    assignee: 'Developer One',
    updated: '2026-10-06T12:00:00Z',
    mergeState,
    prsStatus: 'ok',
    prs,
    ...overrides,
  };
}

function releasesData() {
  const mine = [
    releaseTicket('DEMO-476', 'Clarify reimbursement wording', 'no-pr'),
    releaseTicket('DEMO-1058', 'Update mileage rate lookup', 'partial', [
      mergedReleasePr('example/web', 535),
      mergedReleasePr('example/api', 2075),
      releasePr('example/worker', 451),
    ]),
    releaseTicket('DEMO-1200', 'Fix per diem rounding', 'merged', [
      mergedReleasePr('example/api', 2101),
    ]),
    releaseTicket(
      'DEMO-1398',
      'Estimator rounding for multi-leg trips with mileage caps and long itineraries',
      'open',
      [
        releasePr('example/api', 2110, {
          head: 'DEMO-1398/estimator-rounding-for-multi-leg-trips-with-mileage-caps',
        }),
        releasePr('example/web', 540),
        releasePr('example/worker', 455),
      ],
    ),
    releaseTicket('DEMO-1700', 'Hotfix export header', 'open', [
      mergedReleasePr('example/api', 88, {
        base: 'ops/qa',
        head: 'DEMO-1700/hotfix-export-header',
        countsAsMerged: false,
      }),
    ]),
    releaseTicket('DEMO-1884', 'Sync approvals feed', 'unavailable', [], {
      prsStatus: 'unavailable',
      prsError: 'timeout',
    }),
  ];
  const colleague = { assignee: 'Colleague Two' };
  const all = [
    ...mine,
    releaseTicket(
      'DEMO-1500',
      'Rework approval email',
      'open',
      [releasePr('example/web', 560)],
      colleague,
    ),
    releaseTicket(
      'DEMO-1501',
      'Add audit export',
      'merged',
      [mergedReleasePr('example/api', 2120)],
      colleague,
    ),
    releaseTicket('DEMO-1502', 'Retire legacy flag', 'no-pr', [], colleague),
  ];
  return {
    defaultVersionId: '18741',
    versions: [
      {
        id: '18741',
        name: 'EZAT | Sprint 19.0 | 10/09/26',
        released: false,
        releaseDate: '2026-10-09',
        family: 'EZAT',
      },
      {
        id: '18790',
        name: 'AS | Sprint 12.0 | 10/16/26',
        released: false,
        releaseDate: '2026-10-16',
        family: 'AS',
      },
      {
        id: '18838',
        name: 'EZAT | Sprint 20.0 | 10/23/26',
        released: false,
        releaseDate: '2026-10-23',
        family: 'EZAT',
      },
      {
        id: '18600',
        name: 'EZAT | Sprint 18.0 | 09/25/26',
        released: true,
        releaseDate: '2026-09-25',
        family: 'EZAT',
      },
      {
        id: '18590',
        name: 'AS | Sprint 11.0 | 09/18/26',
        released: true,
        releaseDate: '2026-09-18',
        family: 'AS',
      },
    ],
    tickets: {
      18741: { mine, all },
      18790: {
        mine: [
          releaseTicket('DEMO-4001', 'Reconcile mileage ledger', 'unavailable', [], {
            prsStatus: 'unavailable',
            prsError: 'instance-mismatch',
          }),
          releaseTicket('DEMO-4002', 'Update payee list', 'unavailable', [], {
            prsStatus: 'unavailable',
            prsError: 'timeout',
          }),
          releaseTicket('DEMO-4003', 'Tune export batch size', 'open', [
            releasePr('example/api', 2300),
          ]),
        ],
        all: [
          releaseTicket('DEMO-4001', 'Reconcile mileage ledger', 'unavailable', [], {
            prsStatus: 'unavailable',
            prsError: 'instance-mismatch',
          }),
          releaseTicket('DEMO-4002', 'Update payee list', 'unavailable', [], {
            prsStatus: 'unavailable',
            prsError: 'timeout',
          }),
          releaseTicket('DEMO-4003', 'Tune export batch size', 'open', [
            releasePr('example/api', 2300),
          ]),
          releaseTicket('DEMO-4004', 'Prune stale drafts', 'no-pr', [], colleague),
        ],
      },
      18838: {
        mine: [
          releaseTicket('DEMO-2001', 'Plan export revamp', 'open', [
            releasePr('example/api', 2200),
          ]),
        ],
        all: [
          releaseTicket('DEMO-2001', 'Plan export revamp', 'open', [
            releasePr('example/api', 2200),
          ]),
          releaseTicket('DEMO-2002', 'Spike storage options', 'no-pr', [], colleague),
        ],
      },
      18600: {
        mine: [
          releaseTicket('DEMO-3001', 'Ship quarterly report', 'merged', [
            mergedReleasePr('example/web', 520),
          ]),
        ],
        all: [
          releaseTicket('DEMO-3001', 'Ship quarterly report', 'merged', [
            mergedReleasePr('example/web', 520),
          ]),
          releaseTicket(
            'DEMO-3002',
            'Archive old exports',
            'merged',
            [mergedReleasePr('example/api', 2050)],
            colleague,
          ),
        ],
      },
      // A release cut off by the server's ticket cap.
      18590: {
        truncated: true,
        mine: [
          releaseTicket('DEMO-5001', 'Cap audit log size', 'open', [
            releasePr('example/api', 2400),
          ]),
          releaseTicket('DEMO-5002', 'Index trip search', 'open', [releasePr('example/web', 570)]),
          releaseTicket('DEMO-5003', 'Drop unused column', 'merged', [
            mergedReleasePr('example/api', 2401),
          ]),
          releaseTicket('DEMO-5004', 'Document retention rules', 'no-pr'),
        ],
        all: [
          releaseTicket('DEMO-5001', 'Cap audit log size', 'open', [
            releasePr('example/api', 2400),
          ]),
          releaseTicket('DEMO-5002', 'Index trip search', 'open', [releasePr('example/web', 570)]),
          releaseTicket('DEMO-5003', 'Drop unused column', 'merged', [
            mergedReleasePr('example/api', 2401),
          ]),
          releaseTicket('DEMO-5004', 'Document retention rules', 'no-pr'),
        ],
      },
    },
  };
}

export function dashboardData() {
  const sprint = {
    id: 1,
    name: 'Workspace Sprint',
    state: 'active',
    startDate: '2026-09-01',
    endDate: '2026-09-14',
  };
  const previousSprint = {
    id: 2,
    name: 'Previous Sprint',
    state: 'closed',
    startDate: '2026-08-18',
    endDate: '2026-08-31',
  };
  const services = [
    {
      id: 'api',
      label: 'Workspace API',
      dir: 'workspace-api',
      status: 'running',
      port: null,
      exitCode: null,
    },
    {
      id: 'web',
      label: 'Workspace Web',
      dir: 'workspace-web',
      status: 'running',
      port: null,
      exitCode: null,
    },
    {
      id: 'worker',
      label: 'Background Worker',
      dir: 'workspace-worker',
      status: 'stopped',
      port: null,
      exitCode: 0,
    },
  ];
  const reviews = {
    state: 'changes_requested',
    approvers: [],
    changesRequesters: ['reviewer'],
    available: true,
  };
  const mine = {
    number: 17,
    repo: 'example/workspace',
    title: 'Improve keyboard navigation and preserve focus across refreshed work lists',
    url: 'https://example.invalid/pull/17',
    owner: 'developer',
    draft: false,
    updatedAt: '2026-09-03T10:00:00Z',
    reviews,
  };
  const other = {
    ...mine,
    number: 18,
    owner: 'colleague',
    title: 'Review the shared dashboard shell',
    url: 'https://example.invalid/pull/18',
    reviews: { ...reviews, state: null, changesRequesters: [] },
  };
  const tickets = [
    {
      key: 'sample-active',
      summary: 'Preserve a readable action queue with long summaries across narrow viewports',
      status: 'In Progress',
      statusCategory: 'In Progress',
      storyPoints: 5,
      sprints: [sprint],
      sprint,
    },
    {
      key: 'sample-queued',
      summary: 'Validate keyboard focus and empty list messaging',
      status: 'To Do',
      statusCategory: 'To Do',
      storyPoints: null,
      sprints: [sprint],
      sprint,
    },
    {
      key: 'sample-done',
      summary: 'Complete the previous workspace baseline',
      status: 'Done',
      statusCategory: 'Done',
      storyPoints: 3,
      sprints: [previousSprint, sprint],
      sprint,
    },
  ].map((ticket) => ({
    ...ticket,
    updated: '2026-09-03T10:00:00Z',
    priority: 'Medium',
    issueType: 'Task',
  }));
  return {
    config: {
      defaultTailLines: 40,
      jiraBase: 'https://example.invalid/browse/',
      setup: {
        ready: true,
        errors: [],
        revision: 1,
        origin: 'saved',
        connection: { state: 'verified' },
      },
    },
    settings: {
      schemaVersion: 1,
      revision: 1,
      origin: 'saved',
      github: {
        api: 'https://api.github.com',
        org: 'ExampleOrg',
        repos: ['workspace'],
        maxResults: 50,
      },
      jira: {
        baseUrl: 'https://example.invalid',
        email: 'qa@example.invalid',
        sprintField: 'customfield_101',
        pointsField: 'customfield_102',
      },
      local: {
        root: '/synthetic/workspace',
        services: services.map(({ id, label, dir, port }) => ({
          id,
          label,
          dir,
          port,
          command: ['npm', 'run', 'dev'],
        })),
      },
      minPrApprover: 2,
      credentials: {
        github: { present: true, source: 'file' },
        jira: { present: true, source: 'file' },
      },
    },
    services,
    prs: {
      login: 'developer',
      total: 2,
      prs: [mine],
      groups: { Unticketed: [mine] },
      ticketStatuses: {},
      approvalThreshold: 1,
      reviewDataAvailable: true,
      approvalDataAvailable: true,
      prsNeedingApprovals: [other],
      approvalGroups: { Unticketed: [other] },
      approvalTicketStatuses: {},
    },
    tickets: {
      tickets,
      activeSprints: [sprint],
      allSprints: [sprint, previousSprint],
      truncated: false,
    },
    logs: Object.fromEntries(
      services.map((service) => [
        service.id,
        Array.from(
          { length: 120 },
          (_, index) => `${service.label} line ${index + 1}: <literal> output`,
        ).join('\n'),
      ]),
    ),
    diff: { diff: '--- a/example.js\n+++ b/example.js\n@@ -1 +1 @@\n-old\n+new\n' },
    releases: releasesData(),
  };
}

// Mirrors the server's contract for GET /api/releases: an unknown version or scope answers the generic 400.
function releasesResponse(url, { versions, tickets, defaultVersionId }) {
  const rejected = {
    status: 400,
    json: { code: 'OPERATION_FAILED', error: 'OPERATION FAILED', errors: [] },
  };
  const requested = url.searchParams.get('version');
  const scope = url.searchParams.get('scope') ?? 'mine';
  if (!['mine', 'all'].includes(scope)) return rejected;
  const chosen = versions.find(({ id }) => id === (requested ?? defaultVersionId));
  if (!chosen) return rejected;
  const list = tickets[chosen.id]?.[scope] ?? [];
  const truncated = Boolean(tickets[chosen.id]?.truncated);
  return {
    json: {
      versions,
      version: {
        id: chosen.id,
        name: chosen.name,
        released: chosen.released,
        releaseDate: chosen.releaseDate,
      },
      scope,
      total: list.length,
      truncated,
      updatedAt: '2026-10-08T09:00:00.000Z',
      tickets: list,
    },
  };
}

export function apiResponse(url, method, data, body) {
  if (
    data.statefulSettings &&
    ['/api/settings', '/api/settings/validate'].includes(url.pathname) &&
    ['PUT', 'POST'].includes(method)
  ) {
    if (body?.expectedRevision !== data.settings.revision)
      return {
        status: 409,
        json: { code: 'REVISION_CONFLICT', error: 'Settings changed elsewhere' },
      };
    if (method === 'PUT') {
      for (const field of ['github', 'jira', 'local', 'minPrApprover'])
        data.settings[field] = structuredClone(body[field]);
    }
    const revision = data.settings.revision + 1;
    data.settings.revision = revision;
    data.config.setup = {
      ...data.config.setup,
      ...(method === 'POST' ? data.nextValidationSetup : {}),
      revision,
    };
    data.settings.setup = structuredClone(data.config.setup);
    delete data.nextValidationSetup;
    return { json: structuredClone(data.settings) };
  }
  if (method === 'GET') {
    if (url.pathname === '/api/config') return { json: data.config };
    if (url.pathname === '/api/settings') return { json: data.settings };
    if (url.pathname === '/api/services') return { json: { services: data.services } };
    if (url.pathname === '/api/prs') return { json: data.prs };
    if (url.pathname === '/api/my-tickets') {
      const includeDone = url.searchParams.get('includeDone') === '1';
      const tickets = data.tickets.tickets.filter(
        (ticket) => includeDone || ticket.statusCategory !== 'Done',
      );
      const groupsByCategory = {};
      for (const ticket of tickets) (groupsByCategory[ticket.statusCategory] ||= []).push(ticket);
      return {
        json: { ...data.tickets, tickets, groupsByCategory, total: tickets.length, includeDone },
      };
    }
    if (url.pathname === '/api/releases' && data.releases)
      return releasesResponse(url, data.releases);
    if (url.pathname === '/api/pr-diff') return { json: data.diff };
    const log = url.pathname.match(/^\/api\/logs\/([^/]+)$/);
    if (log && Object.hasOwn(data.logs, log[1])) {
      const value = url.searchParams.get('lines')?.trim();
      const lines = value && !/[^0-9]/.test(value) ? Number(value) : NaN;
      const count = Number.isSafeInteger(lines) ? lines : data.config.defaultTailLines;
      return {
        contentType: 'text/plain',
        body:
          count === 0 ? data.logs[log[1]] : data.logs[log[1]].split('\n').slice(-count).join('\n'),
      };
    }
  }
  if (method === 'PUT' && url.pathname === '/api/settings')
    return data.saveResponse || { json: data.settings };
  if (method === 'POST' && url.pathname === '/api/settings/validate')
    return data.validateResponse || { json: { ...data.settings, setup: data.config.setup } };
  const control = url.pathname.match(/^\/api\/services\/([^/]+)\/(start|stop|restart)$/);
  if (method === 'POST' && control && data.services.some((service) => service.id === control[1])) {
    return { json: { ok: true } };
  }
  return null;
}

export function settingsData(mode = 'fresh') {
  const data = dashboardData();
  data.config.setup = {
    ready: false,
    revision: 1,
    origin: mode === 'migration' ? 'legacy' : 'fresh',
    errors: [
      { field: 'credentials.jira', code: 'REQUIRED', message: 'Add a Jira token to finish setup' },
    ],
    connection: { state: mode === 'migration' ? 'legacy-unverified' : 'unverified' },
  };
  data.settings.origin = data.config.setup.origin;
  data.settings.credentials.jira.present = false;
  if (mode === 'fresh') {
    data.settings.github.repos = [];
    data.settings.jira.baseUrl = '';
    data.settings.jira.email = '';
    data.settings.credentials.github.present = false;
  }
  return data;
}
