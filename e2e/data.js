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
    slack: slackData(),
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

export const WATCH_DEFAULT_TEMPLATE = "There's a new message on {link}";

const WATCH_INTERVAL_BOUNDS = { min: 30, max: 3600 };
const WATCH_TEMPLATE_MAX_LENGTH = 200;
const WATCH_PERMALINK =
  /^https:\/\/[a-z0-9-]+\.slack\.com\/archives\/(C[A-Z0-9]+)\/p(\d{10})(\d{6})$/;
const WATCH_ARCHIVE_MESSAGE_PATH = /^\/archives\/[CDG][A-Z0-9]{8,}\/[^/]+$/;
const WATCH_APP_THREAD =
  /^https:\/\/[a-z0-9-]+\.slack\.com\/client\/[A-Z][A-Z0-9]{8,}\/(C[A-Z0-9]+)\/thread\/\1-(\d{10}\.\d{6})$/;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function watchPermalink(channelId, threadTs) {
  return `https://example.slack.com/archives/${channelId}/p${threadTs.replace('.', '')}`;
}

// The link the server's thread read hands the dialog: the app form, not the archive permalink a
// person pastes into the watch card, though both name the same thread key.
export function slackAppThreadLink(teamId, channelId, threadTs) {
  return `https://app.slack.com/client/${teamId}/${channelId}/thread/${channelId}-${threadTs}`;
}

export function watchSession(sessionId, delivery = null) {
  return { sessionId, delivery };
}

// A delivery as the server sends it: the status, the reason and the time of the last change.
export function watchDelivery(status, reason, at) {
  return { status, reason, at };
}

export function watchLink(channelId, threadTs, overrides = {}) {
  return {
    key: `${channelId}:${threadTs}`,
    link: watchPermalink(channelId, threadTs),
    lastCheckedAt: null,
    lastStatus: null,
    sessions: [],
    ...overrides,
  };
}

export function slackWatchData(overrides = {}) {
  return {
    disabledReason: null,
    settings: {
      intervalSeconds: 180,
      noticeTemplate: WATCH_DEFAULT_TEMPLATE,
      paused: false,
    },
    nextCheckAt: null,
    links: [],
    pickerSource: 'claude',
    pickerSessions: [],
    calls: [],
    ...overrides,
  };
}

function slackData() {
  return {
    status: { connected: true, connecting: false, user: 'developer', team: 'Example Workspace' },
    pending: {
      available: true,
      channel: { id: 'C0EXAMPLE1', name: 'ezat_claudio', mentions: 0, unread: false },
      mentionsTotal: 0,
      updatedAt: '2026-10-31T09:00:00.000Z',
    },
    threads: {
      available: true,
      enriched: true,
      updatedAt: '2026-10-31T09:00:00.000Z',
      started: [],
      mentions: [],
    },
    watch: slackWatchData(),
  };
}

function watchState({ disabledReason, settings }) {
  if (disabledReason) return 'disabled';
  return settings.paused ? 'paused' : 'running';
}

const isSlackHost = ({ hostname, port }) =>
  port === '' && (hostname === 'slack.com' || hostname.endsWith('.slack.com'));

// The reason codes and their order are the server's. Only the top-level message permalink and the
// app thread link are accepted here, so the other forms the server accepts read as
// `not_a_thread_link`.
function watchLinkRejection(link) {
  let url;
  try {
    url = new URL(link);
  } catch {
    return 'not_a_link';
  }
  if (/\s/.test(link)) return 'extra_text';
  if (url.protocol !== 'https:') return 'not_https';
  if (url.username || url.password) return 'credentials_not_allowed';
  if (!isSlackHost(url)) return 'not_slack_host';
  return WATCH_ARCHIVE_MESSAGE_PATH.test(url.pathname) ? 'invalid_timestamp' : 'not_a_thread_link';
}

function parseWatchLink(text) {
  const link = text.trim();
  const match = WATCH_PERMALINK.exec(link);
  if (match) return { key: `${match[1]}:${match[2]}.${match[3]}`, link };
  const appThread = WATCH_APP_THREAD.exec(link);
  if (appThread) return { key: `${appThread[1]}:${appThread[2]}`, link };
  return { reason: watchLinkRejection(link) };
}

const hasControlCharacter = (text) =>
  [...text].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });

function watchSettingsErrors({ intervalSeconds, noticeTemplate }) {
  const errors = [];
  const { min, max } = WATCH_INTERVAL_BOUNDS;
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < min || intervalSeconds > max)
    errors.push({
      field: 'slackWatch.intervalSeconds',
      code: 'INVALID_FIELD',
      message: `Interval must be whole seconds from ${min} to ${max}.`,
    });
  if (
    typeof noticeTemplate !== 'string' ||
    noticeTemplate.length > WATCH_TEMPLATE_MAX_LENGTH ||
    hasControlCharacter(noticeTemplate)
  )
    errors.push({
      field: 'slackWatch.noticeTemplate',
      code: 'INVALID_TEMPLATE',
      message: `Notice must be one line of at most ${WATCH_TEMPLATE_MAX_LENGTH} characters.`,
    });
  return errors;
}

// The server answers a failure with its code, the code with underscores as spaces, and any field errors.
const watchFailure = (status, code, errors = []) => ({
  status,
  json: { code, error: code.replaceAll('_', ' '), errors },
});

// Mirrors the server's contract for the Slack routes. Mutations change the fixture's own watch
// state and are recorded in `watch.calls`, so a spec can assert exactly what the card sent.
function slackResponse(url, method, { slack }, body) {
  const watch = slack.watch;
  const { pathname } = url;
  if (method === 'GET') {
    if (pathname === '/api/slack/status') return { json: slack.status };
    if (pathname === '/api/slack/threads') return { json: slack.threads };
    if (pathname === '/api/slack/pending') return { json: slack.pending };
    if (pathname === '/api/slack/thread') {
      const thread = slack.threadReads?.[url.searchParams.get('ts')];
      return {
        json: thread ? { available: true, thread: structuredClone(thread) } : { available: false },
      };
    }
    if (pathname === '/api/slack/watch')
      return {
        json: {
          state: watchState(watch),
          reason: watch.disabledReason,
          settings: structuredClone(watch.settings),
          nextCheckAt: watchState(watch) === 'running' ? watch.nextCheckAt : null,
          links: structuredClone(watch.links),
        },
      };
    if (pathname === '/api/slack/watch/sessions') {
      const attached = new Set(
        watch.links.flatMap((entry) => entry.sessions.map((s) => s.sessionId)),
      );
      return {
        json: {
          source: watch.pickerSource,
          sessions: watch.pickerSessions.map((session) => ({
            ...session,
            attached: attached.has(session.sessionId),
          })),
          ...(watch.attachedNames && { attachedNames: structuredClone(watch.attachedNames) }),
        },
      };
    }
    return null;
  }
  if (!pathname.startsWith('/api/slack/watch/')) return null;
  watch.calls.push({ method, path: pathname, body: structuredClone(body) });
  const action = pathname.slice('/api/slack/watch/'.length);
  const disabled = watchFailure(409, 'WATCH_DISABLED');
  if (method === 'PUT' && action === 'settings') {
    const errors = watchSettingsErrors(body ?? {});
    if (errors.length) return watchFailure(422, 'INVALID_SETTINGS', errors);
    watch.settings.intervalSeconds = body.intervalSeconds;
    watch.settings.noticeTemplate = body.noticeTemplate;
    return { json: { ok: true, settings: structuredClone(watch.settings) } };
  }
  if (method !== 'POST') return null;
  if (action === 'pause' || action === 'resume') {
    watch.settings.paused = action === 'pause';
    return { json: { state: watchState(watch) } };
  }
  if (action === 'check') {
    if (watch.disabledReason) return disabled;
    return { json: { ok: true, state: watchState(watch), checked: true } };
  }
  if (action === 'links') {
    if (watch.disabledReason) return disabled;
    const results = body.links.map((input) => {
      const parsed = parseWatchLink(input);
      if (parsed.reason) return { input, ok: false, reason: parsed.reason };
      const added = !watch.links.some((entry) => entry.key === parsed.key);
      if (added) watch.links.push(watchLinkFromParsed(parsed));
      return { input, ok: true, key: parsed.key, added };
    });
    return { json: { results } };
  }
  if (action === 'remove') {
    if (watch.disabledReason) return disabled;
    const parsed = parseWatchLink(body.link);
    if (parsed.reason) return watchFailure(400, 'INVALID_LINK');
    watch.links = watch.links.filter((entry) => entry.key !== parsed.key);
    return { json: { ok: true } };
  }
  if (action === 'attach' || action === 'detach') {
    if (action === 'attach' && watch.disabledReason) return disabled;
    const parsed = parseWatchLink(body.link);
    if (parsed.reason) return watchFailure(400, 'INVALID_LINK');
    if (!SESSION_ID.test(body.sessionId)) return watchFailure(400, 'INVALID_SESSION');
    let entry = watch.links.find(({ key }) => key === parsed.key);
    if (action === 'attach') {
      if (!entry) watch.links.push((entry = watchLinkFromParsed(parsed)));
      if (!entry.sessions.some(({ sessionId }) => sessionId === body.sessionId))
        entry.sessions.push(watchSession(body.sessionId));
      return {
        json: {
          ok: true,
          key: entry.key,
          inbox: `/home/example/.config/dev-dashboard/slack-watch/inbox/${body.sessionId}.log`,
        },
      };
    }
    if (entry)
      entry.sessions = entry.sessions.filter(({ sessionId }) => sessionId !== body.sessionId);
    return { json: { ok: true } };
  }
  return null;
}

function watchLinkFromParsed({ key, link }) {
  const [channelId, threadTs] = key.split(':');
  return { ...watchLink(channelId, threadTs), link };
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
  if (url.pathname.startsWith('/api/slack/') && data.slack)
    return slackResponse(url, method, data, body);
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
