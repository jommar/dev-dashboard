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
    reviewTickets: {
      total: 3,
      tickets: [
        [mine, 'DEMO-1'],
        [other, 'DEMO-2'],
        [null, 'DEMO-3'],
      ].map(([pr, key]) => ({
        key,
        summary: pr ? pr.title : 'Review-ready ticket without an open PR',
        status: 'Ready For Code Review',
        statusCategory: 'In Progress',
        priority: 'Medium',
        updated: '2026-11-09T10:00:00Z',
        created: '2026-11-01T10:00:00Z',
        sprint,
        sprints: [sprint],
        prs: pr
          ? [
              {
                repo: pr.repo,
                number: pr.number,
                title: pr.title,
                url: pr.url,
                owner: pr.owner,
                draft: pr.draft,
                updatedAt: pr.updatedAt,
                review: {
                  complete: true,
                  state: pr.reviews.state || 'awaiting',
                  approvers: pr.reviews.approvers,
                  changesRequesters: pr.reviews.changesRequesters,
                  reviewDecision: null,
                },
              },
            ]
          : [],
      })),
      prCoverage: { available: true, complete: true, repos: ['example/workspace'], reasons: [] },
      updatedAt: '2026-11-09T10:00:00Z',
    },
    tickets: {
      tickets,
      activeSprints: [sprint],
      allSprints: [sprint, previousSprint],
      truncated: false,
    },
    ticketPrs: {
      available: true,
      login: 'me',
      total: 0,
      truncated: false,
      byTicket: {},
      updatedAt: '2026-10-08T09:00:00.000Z',
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
    claude: claudeData(),
  };
}

// Keep the invented roots newer than the rolling creation cutoff while their activity is 1h old.
const boardRootSeconds = Math.floor(Date.now() / 1000) - 7200;
export const BOARD_THREAD_TS = {
  needsReply: `${boardRootSeconds}.000100`,
  quiet: `${boardRootSeconds + 200}.000100`,
};

const BOARD_TEAM = 'T0EXAMPLE1';
const BOARD_CHANNEL = 'C0EXAMPLE1';
const BOARD_FAILING_CHECKS = ['lint', 'unit-tests'];

// A review-thread bucket and a PR's `comments` as the backend returns them: `human`, `copilot`
// and `other` hold threads read, unresolved threads and comments in them; `threads` is the total
// GitHub reports and `truncated` says more exist than were read.
const commentBucket = (threads = 0, unresolved = 0, comments = 0) => ({
  threads,
  unresolved,
  comments,
});
const prComments = (overrides = {}) => ({
  human: commentBucket(),
  copilot: commentBucket(),
  other: commentBucket(),
  conversation: 0,
  threads: 0,
  truncated: false,
  ...overrides,
});

// The board's fixture matrix, laid over any `dashboardData()`. It
// replaces the tickets and the ticket-to-PR map and gives two Slack threads. Done tickets stay in
// the list: the mocked /api/my-tickets drops them unless Include Done is on. Pass
// `{ available: false }` for the answer GitHub gives when the PR search failed. Invented data only.
//
//   ticket          status              PRs                                          Slack
//   TAP-9001        In Progress         one, CI failing (lint, unit-tests)           -
//   TAP-9002        Code Review         one, CI passing, approved (green card)       4 replies, needs reply, a session attached
//   TAP-9003        In Progress         one draft, CI pending                        -
//   TAP-9004        To Do               none (sprint: not the current one)           -
//   TAP-9005        Code Review         two: changes requested; ci null (unreadable) 1 reply
//   TAP-9006/9007   In Progress/Blocked the same PR names both (approved: green)     -
//   TAP-9008        Ready For Testing   one, no checks, approved; a ~160 char summary -
//   TAP-9100..9119  To Do               none (twenty tickets in one column)          -
//   TAP-9200        Weird Custom Gate   none (unknown status, category In Progress)  -
//   TAP-9300        Done                none                                         -
//
// Every PR carries `comments`, the field `/api/ticket-prs` returns for it (review threads split
// into human, Copilot and other by who started them, the conversation comment count, the thread
// total and whether the list was cut off), and every Slack thread row carries `attachedSessions`.
// `withFollowUpCases` adds the cases the matrix has no room for.
export function ticketBoardData(data, { available = true } = {}) {
  const hoursAgo = (hours) => new Date(Date.now() - hours * 3_600_000).toISOString();
  const [current] = data.tickets.activeSprints;
  const next = {
    id: 3,
    name: 'Following Sprint',
    state: 'future',
    startDate: '2026-09-15',
    endDate: '2026-09-28',
  };
  const ticket = (key, status, statusCategory, overrides = {}) => ({
    key,
    summary: `Invented work item ${key}`,
    status,
    statusCategory,
    priority: 'Medium',
    issueType: 'Task',
    storyPoints: null,
    sprints: [current],
    sprint: current,
    updated: hoursAgo(2),
    ...overrides,
  });
  const longSummary =
    'Invented ticket whose summary keeps going well past two lines so the card has to clamp it and still show the whole text in a tooltip for anyone who needs it';
  data.tickets.allSprints = [current, next, ...data.tickets.allSprints.slice(1)];
  data.tickets.tickets = [
    ticket('TAP-9001', 'In Progress', 'In Progress', {
      summary: 'Invented fix for the failing export job',
      priority: 'High',
      storyPoints: 5,
    }),
    ticket('TAP-9002', 'Code Review', 'In Progress', {
      summary: 'Invented review of the retry policy',
      priority: 'Highest',
      storyPoints: 3,
      updated: hoursAgo(5),
    }),
    ticket('TAP-9003', 'In Progress', 'In Progress', { storyPoints: 2, updated: hoursAgo(26) }),
    ticket('TAP-9004', 'To Do', 'To Do', {
      priority: 'Low',
      sprints: [next],
      sprint: next,
    }),
    ticket('TAP-9005', 'Code Review', 'In Progress', { priority: 'High', storyPoints: 8 }),
    ticket('TAP-9006', 'In Progress', 'In Progress', { storyPoints: 1 }),
    ticket('TAP-9007', 'Blocked', 'In Progress', { priority: 'Highest' }),
    ticket('TAP-9008', 'Ready For Testing', 'To Do', {
      summary: longSummary,
      priority: 'Low',
      storyPoints: 13,
    }),
    ...Array.from({ length: 20 }, (_, index) =>
      ticket(`TAP-${9100 + index}`, 'To Do', 'To Do', {
        summary: `Invented queued item number ${index + 1}`,
        priority: 'Low',
      }),
    ),
    ticket('TAP-9200', 'Weird Custom Gate', 'In Progress'),
    ticket('TAP-9300', 'Done', 'Done', { updated: hoursAgo(72) }),
  ];

  const ci = (state, passed, failed, pending, failing = []) => ({
    state,
    passed,
    failed,
    pending,
    failing,
  });
  const review = (state, approvals = 0) => ({ state, approvals });
  const pr = (repo, number, title, overrides = {}) => ({
    repo,
    number,
    title,
    url: `https://github.com/${repo}/pull/${number}`,
    draft: false,
    updatedAt: hoursAgo(1),
    review: review('awaiting'),
    ci: ci('passing', 9, 0, 0),
    comments: prComments(),
    ...overrides,
  });
  const failing = pr('ExampleOrg/example-api', 812, 'TAP-9001 Repair the export retry', {
    review: review('awaiting'),
    ci: ci('failing', 7, 2, 0, BOARD_FAILING_CHECKS),
    comments: prComments({
      human: commentBucket(5, 2, 9),
      copilot: commentBucket(4, 0, 6),
      threads: 9,
    }),
  });
  const passing = pr('ExampleOrg/example-web', 904, 'TAP-9002 Cap the retry count', {
    review: review('approved', 2),
    ci: ci('passing', 9, 0, 0),
    comments: prComments({
      human: commentBucket(3, 1, 5),
      copilot: commentBucket(2, 0, 3),
      threads: 5,
    }),
  });
  const pending = pr('ExampleOrg/example-api', 815, 'TAP-9003 Add the audit trail', {
    draft: true,
    review: review('awaiting'),
    ci: ci('pending', 6, 0, 3),
  });
  const changesRequested = pr('ExampleOrg/example-api', 820, 'TAP-9005 Rework the queue', {
    review: review('changes_requested'),
    ci: ci('passing', 9, 0, 0),
    comments: prComments({
      human: commentBucket(3, 2, 5),
      copilot: commentBucket(2, 2, 4),
      threads: 5,
    }),
  });
  const unreadable = pr('ExampleOrg/example-web', 821, 'TAP-9005 Rework the queue view', {
    review: review('awaiting'),
    ci: null,
    comments: null,
  });
  const shared = pr('ExampleOrg/example-web', 931, 'TAP-9006 TAP-9007 Split the settings form', {
    review: review('approved', 1),
    ci: ci('passing', 4, 0, 0),
    comments: prComments({ conversation: 2 }),
  });
  const noChecks = pr('ExampleOrg/example-api', 840, 'TAP-9008 Document the retention rules', {
    review: review('approved', 2),
    ci: ci('none', 0, 0, 0),
    comments: prComments({
      human: commentBucket(4, 0, 6),
      copilot: commentBucket(2, 0, 3),
      threads: 6,
    }),
  });
  const byTicket = {
    'TAP-9001': [failing],
    'TAP-9002': [passing],
    'TAP-9003': [pending],
    'TAP-9005': [unreadable, changesRequested],
    'TAP-9006': [shared],
    'TAP-9007': [shared],
    'TAP-9008': [noChecks],
  };
  data.ticketPrs = available
    ? {
        available: true,
        login: 'me',
        total: 7,
        truncated: false,
        byTicket,
        updatedAt: new Date().toISOString(),
      }
    : {
        available: false,
        login: null,
        total: 0,
        truncated: false,
        byTicket: {},
        updatedAt: new Date().toISOString(),
      };

  const person = (id, name) => ({ id, name });
  const sam = person('U0EXAMPLE1', 'Sam Example');
  const riley = person('U0EXAMPLE2', 'Riley Sample');
  const threadRow = (ts, key, replyCount, needsReply, attachedSessions = 0) => ({
    ts,
    url: slackAppThreadLink(BOARD_TEAM, BOARD_CHANNEL, ts),
    watchKey: `${BOARD_CHANNEL}:${ts}`,
    text: `${key}: Invented subject for the thread`,
    author: sam,
    starter: sam,
    replyCount,
    activityAt: hoursAgo(1),
    latestReplyBy: riley,
    needsReply,
    attachedSessions,
  });
  const threadRead = (row) => ({
    ts: row.ts,
    url: row.url,
    watchKey: row.watchKey,
    channel: { id: BOARD_CHANNEL, name: 'example_channel' },
    replyCount: row.replyCount,
    truncated: false,
    updatedAt: new Date().toISOString(),
    names: { [sam.id]: sam.name, [riley.id]: riley.name },
    messages: [
      { ts: row.ts, at: hoursAgo(2), author: sam, text: row.text, mrkdwn: row.text },
      {
        ts: `${Number(row.ts.split('.')[0]) + 60}.000300`,
        at: hoursAgo(1),
        author: riley,
        text: 'Invented reply asking for an answer.',
        mrkdwn: 'Invented reply asking for an answer.',
      },
    ],
  });
  const needsReply = threadRow(BOARD_THREAD_TS.needsReply, 'TAP-9002', 4, true, 1);
  const quiet = threadRow(BOARD_THREAD_TS.quiet, 'TAP-9005', 1, false);
  data.slack.threads.started = [needsReply, quiet];
  data.slack.threadReads = {
    [needsReply.ts]: threadRead(needsReply),
    [quiet.ts]: threadRead(quiet),
  };
  return data;
}

// The Slack threads `withFollowUpCases` adds, by what each shows on its chip.
export const FOLLOW_UP_THREAD_TS = {
  attached: `${boardRootSeconds + 1000}.000100`,
  unattached: `${boardRootSeconds + 1100}.000100`,
  pairTwo: `${boardRootSeconds + 1200}.000100`,
  pairOne: `${boardRootSeconds + 1300}.000100`,
  green: `${boardRootSeconds + 1400}.000100`,
};

// The matrix plus the cases it has no room for, each on its own card in a column of its own
// (Ready For Delivery) so the matrix counts stay as they are. Invented data only.
//
//   ticket          PRs                                                                    Slack
//   TAP-9401        human threads only (2 open of 5, 9 comments)                           -
//   TAP-9402        Copilot threads only, all resolved (4 of 4)                            -
//   TAP-9403        both: human 1 of 3 open, Copilot 2 of 2 open                           -
//   TAP-9404        both, all resolved                                                     -
//   TAP-9405        comments with no threads at all                                        -
//   TAP-9406        `comments: null` (unknown)                                             -
//   TAP-9407        one thread started by another bot                                      -
//   TAP-9408        63 threads, 50 read (all human, 3 open): cut off                       -
//   TAP-9409        conversation comments only                                             -
//   TAP-9410        the longest line: long repo, changes requested, DRAFT, both chips      -
//   TAP-9420        two PRs, both approved                                                 -
//   TAP-9421        approved + awaiting                                                    -
//   TAP-9422        approved + changes requested                                           -
//   TAP-9423        approved + `review: null`                                              -
//   TAP-9424        one approved draft                                                     -
//   TAP-9425        twelve approved PRs                                                    -
//   TAP-9426        approved, open and resolved comment chips, another sprint, 3 pt        one attached thread
//   TAP-9427        approved, in Done                                                      -
//   TAP-9430        none                                                                   one attached, one not
//   TAP-9431        none                                                                   two attached (2 and 1 sessions)
export function withFollowUpCases(data) {
  const base = data.tickets.tickets.find((ticket) => ticket.key === 'TAP-9001');
  const [prBase] = data.ticketPrs.byTicket['TAP-9001'];
  const [rowBase] = data.slack.threads.started;
  const next = data.tickets.allSprints.find((sprint) => sprint.name === 'Following Sprint');
  const ticket = (key, overrides = {}) => ({
    ...base,
    key,
    summary: `Invented work item ${key}`,
    status: 'Ready For Delivery',
    statusCategory: 'In Progress',
    priority: 'Medium',
    storyPoints: null,
    ...overrides,
  });
  const api = 'ExampleOrg/example-api';
  const pr = (repo, number, overrides = {}) => ({
    ...prBase,
    repo,
    number,
    title: `Invented change ${number}`,
    url: `https://github.com/${repo}/pull/${number}`,
    draft: false,
    review: { state: 'awaiting', approvals: 0 },
    ci: { state: 'passing', passed: 9, failed: 0, pending: 0, failing: [] },
    comments: prComments(),
    ...overrides,
  });
  const approved = { state: 'approved', approvals: 2 };
  const row = (ts, key, attachedSessions) => ({
    ...rowBase,
    ts,
    url: slackAppThreadLink(BOARD_TEAM, BOARD_CHANNEL, ts),
    watchKey: `${BOARD_CHANNEL}:${ts}`,
    text: `${key}: Invented subject for the thread`,
    replyCount: 2,
    needsReply: false,
    attachedSessions,
  });

  const cases = [
    [
      ticket('TAP-9401'),
      [pr(api, 401, { comments: prComments({ human: commentBucket(5, 2, 9), threads: 5 }) })],
    ],
    [
      ticket('TAP-9402'),
      [pr(api, 402, { comments: prComments({ copilot: commentBucket(4, 0, 6), threads: 4 }) })],
    ],
    [
      ticket('TAP-9403'),
      [
        pr(api, 403, {
          comments: prComments({
            human: commentBucket(3, 1, 5),
            copilot: commentBucket(2, 2, 4),
            threads: 5,
          }),
        }),
      ],
    ],
    [
      ticket('TAP-9404'),
      [
        pr(api, 404, {
          comments: prComments({
            human: commentBucket(3, 0, 4),
            copilot: commentBucket(2, 0, 3),
            threads: 5,
          }),
        }),
      ],
    ],
    [ticket('TAP-9405'), [pr(api, 405)]],
    [ticket('TAP-9406'), [pr(api, 406, { comments: null })]],
    [
      ticket('TAP-9407'),
      [pr(api, 407, { comments: prComments({ other: commentBucket(1, 1, 2), threads: 1 }) })],
    ],
    [
      ticket('TAP-9408'),
      [
        pr(api, 408, {
          comments: prComments({ human: commentBucket(50, 3, 61), threads: 63, truncated: true }),
        }),
      ],
    ],
    [ticket('TAP-9409'), [pr(api, 409, { comments: prComments({ conversation: 3 }) })]],
    [
      ticket('TAP-9410'),
      [
        pr('ExampleOrg/example-billing', 1234, {
          draft: true,
          review: { state: 'changes_requested', approvals: 0 },
          comments: prComments({
            human: commentBucket(30, 12, 40),
            copilot: commentBucket(20, 3, 25),
            threads: 63,
            truncated: true,
          }),
        }),
      ],
    ],
    [
      ticket('TAP-9420'),
      [pr(api, 420, { review: approved }), pr('ExampleOrg/example-web', 421, { review: approved })],
    ],
    [ticket('TAP-9421'), [pr(api, 422, { review: approved }), pr(api, 423)]],
    [
      ticket('TAP-9422'),
      [
        pr(api, 424, { review: approved }),
        pr(api, 425, { review: { state: 'changes_requested', approvals: 0 } }),
      ],
    ],
    [ticket('TAP-9423'), [pr(api, 426, { review: approved }), pr(api, 427, { review: null })]],
    [ticket('TAP-9424'), [pr(api, 428, { draft: true, review: approved })]],
    [
      ticket('TAP-9425'),
      Array.from({ length: 12 }, (_, index) => pr(api, 430 + index, { review: approved })),
    ],
    [
      ticket('TAP-9426', { sprints: [next], sprint: next, storyPoints: 3, priority: 'High' }),
      [
        pr(api, 442, {
          review: approved,
          comments: prComments({
            human: commentBucket(5, 2, 9),
            copilot: commentBucket(4, 0, 6),
            threads: 9,
          }),
        }),
      ],
    ],
    [
      ticket('TAP-9427', { status: 'Done', statusCategory: 'Done' }),
      [pr(api, 443, { review: approved })],
    ],
    [ticket('TAP-9430'), []],
    [ticket('TAP-9431'), []],
  ];
  for (const [added, prs] of cases) {
    data.tickets.tickets.push(added);
    if (prs.length) data.ticketPrs.byTicket[added.key] = prs;
  }
  data.ticketPrs.total += cases.reduce((sum, [, prs]) => sum + prs.length, 0);
  data.slack.threads.started.push(
    row(FOLLOW_UP_THREAD_TS.attached, 'TAP-9430', 1),
    row(FOLLOW_UP_THREAD_TS.unattached, 'TAP-9430', 0),
    row(FOLLOW_UP_THREAD_TS.pairTwo, 'TAP-9431', 2),
    row(FOLLOW_UP_THREAD_TS.pairOne, 'TAP-9431', 1),
    row(FOLLOW_UP_THREAD_TS.green, 'TAP-9426', 1),
  );
  return data;
}

// The matrix plus one ticket from another Jira project, PRT-901, with an open PR. The server
// files a PR under its key as written when the project is neither TAP nor TRIPS, so the fixture
// keys the PR the same way. Invented data only.
export function withForeignProjectTicket(data) {
  const base = data.tickets.tickets.find((ticket) => ticket.key === 'TAP-9001');
  const [pr] = data.ticketPrs.byTicket['TAP-9001'];
  data.tickets.tickets.push({
    ...base,
    key: 'PRT-901',
    summary: 'Invented work item PRT-901',
    status: 'In Progress',
  });
  data.ticketPrs.byTicket['PRT-901'] = [
    { ...pr, number: 901, url: pr.url.replace(/\/\d+$/, '/901') },
  ];
  return data;
}

// The matrix plus one ticket under the renamed TRIPS project, TRIPS-901. The server folds TRIPS
// onto TAP, so its open PR is filed under TAP-901, and the card has to find it there. Invented data only.
export function withTripsProjectTicket(data) {
  const base = data.tickets.tickets.find((ticket) => ticket.key === 'TAP-9001');
  const [pr] = data.ticketPrs.byTicket['TAP-9001'];
  data.tickets.tickets.push({
    ...base,
    key: 'TRIPS-901',
    summary: 'Invented work item TRIPS-901',
    status: 'In Progress',
  });
  data.ticketPrs.byTicket['TAP-901'] = [
    { ...pr, number: 903, url: pr.url.replace(/\/\d+$/, '/903') },
  ];
  return data;
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

// The Claude launcher's fake API. `claude.tickets` is what GET /api/claude/tickets lists, by ticket
// key; a ticket with no entry is not started, as on the server. A POST is recorded in `claude.calls`
// and changes `tickets` the way the server's answer would, so a spec can assert what the dialog
// sent and what the icon shows afterwards. Invented data only.
const CLAUDE_ATTACH = { kind: 'attach', command: 'claude attach ab12cd34' };
// `goTo` on an entry is `{ investigate, implement, groom }`: each side is `{ kind, command }` for
// that session, or null when nothing of it can be joined. Groom is not a phase of the workflow: the
// entry's `groom` is `{ state, reason }` of its own (`none`, `working`, `waiting`, `done`, `failed`
// or `unknown`) and the top-level `state` and `reason` follow the workflow only.
const CLAUDE_NO_SESSIONS = { investigate: null, implement: null, groom: null };
const CLAUDE_NO_GROOM = { state: 'none', reason: null };

export function claudeQuestion(id, question, answer = null) {
  return { id, question, answer };
}

// An entry's `unanswered` count and `blocks` follow from its state, phase, flags and questions, as
// the server derives them. While a session works, each phase names the other's reason: the phase
// that runs says a session is running, the other says which phase is. Implement needs the plan
// marked done (`flags.done`) once every question has an answer. `unsent` (the answers are complete
// but were never sent to the session) is not derived: a spec sets it on the entry.
function claudeDerived(entry) {
  const unanswered = entry.questions.filter(({ answer }) => !answer?.trim()).length;
  const planned = entry.flags['investigate-and-plan'] === true;
  const implementing = entry.phase === 'implement-plan';
  const held = {
    working: {
      investigate: implementing ? 'implement_running' : 'session_running',
      implement: implementing ? 'session_running' : 'investigate_running',
      answer: 'session_running',
    },
    unknown: {
      investigate: 'listing_unavailable',
      implement: 'listing_unavailable',
      answer: 'listing_unavailable',
    },
  }[entry.state];
  // A groom session blocks only another groom launch; the workflow never blocks it nor is blocked.
  const groomState = entry.groom?.state ?? 'none';
  const groom =
    groomState === 'working'
      ? 'session_running'
      : groomState === 'unknown' || entry.state === 'unknown'
        ? 'listing_unavailable'
        : null;
  const review = entry.review ?? { state: 'none', reason: null };
  const reviewBlock =
    review.state === 'working'
      ? 'session_running'
      : review.state === 'unknown'
        ? review.reason
        : null;
  // The server's order: open questions, then answers never sent (a stale `done` cannot be trusted),
  // then a plan not marked done.
  const implement = unanswered
    ? 'questions_unanswered'
    : entry.unsent
      ? 'answers_not_sent'
      : entry.flags.done
        ? null
        : 'plan_not_done';
  return {
    ...entry,
    unanswered,
    unsent: Boolean(entry.unsent),
    groom: entry.groom ?? CLAUDE_NO_GROOM,
    review,
    blocks: {
      ...(held ?? {
        investigate: null,
        implement: planned ? implement : 'not_planned',
        answer: entry.questions.length ? null : 'no_questions',
      }),
      groom,
      review: reviewBlock,
    },
  };
}

// One ticket's entry in the shape GET /api/claude/tickets returns. Pass `flags`, `questions`,
// `goTo`, `phase`, `unsent` or `groom` to override the first-launch defaults.
export function claudeEntry(state, reason, overrides = {}) {
  return claudeDerived({
    phase: 'investigate-and-plan',
    state,
    reason,
    flags: { 'investigate-and-plan': false, 'implement-plan': false, done: false },
    questions: [],
    goTo: CLAUDE_NO_SESSIONS,
    ...overrides,
  });
}

// The prompt editor's fake: the three prompt files by name, each an entry as GET /api/claude/prompts
// lists it. `source` is `default` (no file; the built-in text), `custom` (a usable file) or `unusable`
// (a file that cannot be used; the built-in text is shown so a fix can be saved). The texts are
// invented and short; the built-ins hold the placeholders the real ones do, so none of them warns.
const CLAUDE_PROMPT_LABELS = {
  investigate: 'Investigate and plan prompt',
  implement: 'Implement plan prompt',
  answers: 'Answers message',
  groom: 'Groom ticket prompt',
};
const CLAUDE_PROMPT_PLACEHOLDERS = ['{KEY}', '{SLUG}', '{STATUS_FILE}'];
export const CLAUDE_PROMPT_DEFAULTS = {
  investigate: 'Work out the plan for {KEY} and record progress in {STATUS_FILE}.',
  implement: 'Build the plan for {KEY} in the folder {SLUG} and record progress in {STATUS_FILE}.',
  answers:
    'The answers for {KEY} changed. Changes: {CHANGE}. Questions: {QUESTION_IDS}. Update the plan and write {STATUS_FILE}.',
  // Grooming has no status file: its built-in text and placeholders never mention one.
  groom: 'Groom ticket {KEY} and write the result under the folder {SLUG} as groom.md.',
};

export function claudePromptEntry(name, source = 'default', text = CLAUDE_PROMPT_DEFAULTS[name]) {
  return {
    name,
    label: CLAUDE_PROMPT_LABELS[name],
    source,
    text: source === 'custom' ? text : CLAUDE_PROMPT_DEFAULTS[name],
    placeholders:
      name === 'answers'
        ? [...CLAUDE_PROMPT_PLACEHOLDERS, '{QUESTION_IDS}', '{CHANGE}']
        : name === 'groom'
          ? ['{KEY}', '{SLUG}']
          : CLAUDE_PROMPT_PLACEHOLDERS,
  };
}

// What the server answers when it cannot write or remove a prompt file (a folder in its place, a
// prompts folder it cannot write to): a failed Claude action with the reason `prompt_not_changed`,
// for Save and Reset alike. A spec queues it in `prompts.failures`.
export const claudePromptNotChanged = () =>
  claudeFailure(502, 'CLAUDE_FAILED', ['prompt_not_changed']);

// `sends` is a queue of outcomes the next answers saves report as `send`, for a spec that needs a
// failure or a skip the fake would not choose itself. `prompts.failures` is a queue of responses
// the next requests to the prompt routes get instead of the fake's own answer, whatever the method.
function claudeData() {
  return {
    listing: 'ok',
    tickets: {},
    calls: [],
    sends: [],
    prompts: {
      entries: Object.fromEntries(
        Object.keys(CLAUDE_PROMPT_LABELS).map((name) => [name, claudePromptEntry(name)]),
      ),
      failures: [],
    },
  };
}

const claudeFailure = (status, code, errors = []) => ({
  status,
  json: { code, error: code.replaceAll('_', ' '), errors },
});

// What the server's send step reports for an entry whose answers were just saved: nothing goes to
// the session until every question has an answer and the plan has been written.
function claudeSend(entry) {
  if (entry.unanswered) return { status: 'skipped', reason: 'incomplete' };
  if (entry.flags['investigate-and-plan'] !== true)
    return { status: 'skipped', reason: 'not_planned' };
  return { status: 'sent' };
}

// Only the paths the specs drive are modelled: a launch of either phase that starts a session, and
// answers that fill in existing questions. Anything else is left unanswered, so the run aborts it
// as unexpected network and the spec's author extends this.
// GET lists the three prompts; PUT saves one as a custom file (trimmed, non-empty, at most 20,000
// characters, as the server checks); DELETE removes the file so the built-in text applies again.
// A PUT or a DELETE is recorded in `claude.calls`.
function claudePromptsResponse(pathname, method, { prompts, calls }, body) {
  const [, name] =
    pathname.match(/^\/api\/claude\/prompts(?:\/(investigate|implement|answers))?$/) ?? [];
  if (!pathname.startsWith('/api/claude/prompts') || (pathname !== '/api/claude/prompts' && !name))
    return null;
  if (method !== 'GET') calls.push({ method, path: pathname, body: structuredClone(body) });
  const failure = prompts.failures.shift();
  if (failure) return failure;
  if (method === 'GET' && !name)
    return {
      json: {
        ok: true,
        prompts: Object.keys(CLAUDE_PROMPT_LABELS).map((each) =>
          structuredClone(prompts.entries[each]),
        ),
      },
    };
  if (method === 'PUT' && name) {
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text || text.length > 20_000) return claudeFailure(400, 'INVALID_PROMPT');
    prompts.entries[name] = claudePromptEntry(name, 'custom', text);
    return { json: { ok: true, prompt: structuredClone(prompts.entries[name]) } };
  }
  if (method === 'DELETE' && name) {
    prompts.entries[name] = claudePromptEntry(name);
    return { json: { ok: true, prompt: structuredClone(prompts.entries[name]) } };
  }
  return null;
}

function claudeResponse(url, method, { claude }, body) {
  const { pathname } = url;
  const prompts = claudePromptsResponse(pathname, method, claude, body);
  if (prompts) return prompts;
  if (method === 'GET' && pathname === '/api/claude/tickets')
    return {
      json: {
        listing: claude.listing,
        updatedAt: '2026-10-08T09:00:00.000Z',
        tickets: structuredClone(claude.tickets),
      },
    };
  if (method !== 'POST') return null;
  claude.calls.push({ method, path: pathname, body: structuredClone(body) });
  if (pathname === '/api/claude/launch' && body?.phase === 'pr-review-transact') {
    const current = claude.tickets[body.key] ?? claudeEntry('none', null, { phase: null });
    if (current.blocks.review) return claudeFailure(409, 'CLAUDE_REFUSED', [current.blocks.review]);
    const ticket = claudeDerived({
      ...current,
      review: { state: 'working', reason: 'starting' },
    });
    claude.tickets[body.key] = ticket;
    return {
      json: {
        ok: true,
        key: body.key,
        phase: 'pr-review-transact',
        name: `${body.key}-pr-review-transact`,
        id: 'ab12cd34',
        ticket: structuredClone(ticket),
      },
    };
  }
  if (pathname === '/api/claude/launch' && body?.phase === 'groom') {
    // Grooming has a session and a record of its own and leaves the workflow's entry as it was.
    const current = claude.tickets[body.key] ?? claudeEntry('none', null);
    const ticket = claudeDerived({
      ...current,
      groom: { state: 'working', reason: 'starting' },
      goTo: { ...current.goTo, groom: CLAUDE_ATTACH },
    });
    claude.tickets[body.key] = ticket;
    return {
      json: {
        ok: true,
        key: body.key,
        phase: 'groom',
        name: `${body.key}-groom`,
        id: 'ab12cd34',
        ticket: structuredClone(ticket),
      },
    };
  }
  if (
    pathname === '/api/claude/launch' &&
    ['investigate-and-plan', 'implement-plan'].includes(body?.phase)
  ) {
    // An implement launch keeps the plan's flag and questions; only an investigate launch resets them.
    // Either keeps the groom record and its session.
    const current = claude.tickets[body.key];
    const earlier = body.phase === 'implement-plan' ? current : null;
    const ticket = claudeEntry('working', 'starting', {
      phase: body.phase,
      groom: current?.groom ?? CLAUDE_NO_GROOM,
      review: current?.review ?? { state: 'none', reason: null },
      // The launched phase has a live session; an implement launch keeps the investigate side.
      goTo: {
        investigate:
          body.phase === 'implement-plan' ? (earlier?.goTo?.investigate ?? null) : CLAUDE_ATTACH,
        implement: body.phase === 'implement-plan' ? CLAUDE_ATTACH : null,
        groom: current?.goTo?.groom ?? null,
      },
      ...(earlier && {
        flags: { ...earlier.flags, 'implement-plan': false },
        questions: earlier.questions,
      }),
    });
    claude.tickets[body.key] = ticket;
    return {
      json: {
        ok: true,
        key: body.key,
        phase: body.phase,
        name: body.key,
        id: 'ab12cd34',
        ticket: structuredClone(ticket),
      },
    };
  }
  if (pathname === '/api/claude/answers') {
    const entry = claude.tickets[body?.key];
    if (!entry) return claudeFailure(400, 'INVALID_ANSWER');
    for (const [id, value] of Object.entries(body.answers)) {
      const question = entry.questions.find((candidate) => candidate.id === id);
      if (question) question.answer = value === '' ? null : value;
    }
    const answered = claudeDerived(entry);
    const send = claude.sends.shift() ?? claudeSend(answered);
    // A notice that was sent is acted on at once: the session updates the plan and marks it done.
    const ticket =
      send.status === 'sent'
        ? claudeDerived({
            ...answered,
            state: 'done',
            reason: 'plan_ready',
            flags: { ...answered.flags, done: true },
            unsent: false,
          })
        : answered;
    claude.tickets[body.key] = ticket;
    return { json: { ok: true, key: body.key, ticket: structuredClone(ticket), send } };
  }
  return null;
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
  if (url.pathname.startsWith('/api/claude/') && data.claude)
    return claudeResponse(url, method, data, body);
  if (method === 'GET') {
    if (url.pathname === '/api/config') return { json: data.config };
    if (url.pathname === '/api/settings') return { json: data.settings };
    if (url.pathname === '/api/services') return { json: { services: data.services } };
    if (url.pathname === '/api/prs') return { json: data.prs };
    if (url.pathname === '/api/review-tickets') return { json: data.reviewTickets };
    if (url.pathname === '/api/ticket-prs') return { json: data.ticketPrs };
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
