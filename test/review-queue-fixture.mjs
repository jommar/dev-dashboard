import assert from 'node:assert/strict';
import fs from 'node:fs';
import { githubToken, jiraToken } from './settings-fixture.mjs';

export const API = 'https://api.github.example.invalid';
export const JIRA = 'https://jira.example.invalid';
export const snapshot = (overrides = {}) => ({
  revision: 'synthetic-same-revision',
  github: { api: API, org: 'ExampleOrg', repos: ['app', 'web', 'specs'], maxResults: 17 },
  jira: {
    baseUrl: JIRA,
    email: 'qa@example.invalid',
    sprintField: 'customfield_101',
    pointsField: 'customfield_102',
  },
  credentials: { githubToken, jiraToken },
  minPrApprover: 99,
  ...overrides,
});

// Jira's numeric issue id, which dev-status is keyed by.
export const issueId = (key) => String(10000 + Number(key.split('-').pop()));

export const issue = (key = 'DEMO-1', fields = {}) => ({
  id: issueId(key),
  key,
  fields: {
    summary: `Jira summary for ${key}`,
    status: { name: 'Ready For Code Review', statusCategory: { name: 'In Progress' } },
    priority: { name: 'High' },
    updated: '2026-11-01T12:00:00Z',
    created: '2026-10-01T00:00:00Z',
    customfield_101: [{ id: 5, name: 'Synthetic sprint', state: 'active' }],
    ...fields,
  },
});

export const pull = (repo, number, title, extra = {}) => ({
  number,
  title,
  html_url: `https://github.com/${repo}/pull/${number}`,
  user: { login: 'current-github-user' },
  state: 'open',
  draft: false,
  labels: [],
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-11-01T12:00:00Z',
  ...extra,
});

// A PR that Jira dev-status links to `tickets`. `state` is Jira's copy of the state (GitHub decides).
export const linkedPr = (repo, number, tickets, extra = {}) => ({
  repo,
  number,
  title: `Linked change ${number}`,
  state: 'OPEN',
  tickets,
  updatedAt: '2026-11-01T12:00:00Z',
  ...extra,
});

const GITHUB_INSTANCE = 'oAuth-com.github.integration.production';
const rawOf = (linked) => ({
  id: `#${linked.number}`,
  name: linked.title,
  status: linked.state,
  url: linked.url ?? `https://github.com/${linked.repo}/pull/${linked.number}`,
  repositoryName: linked.repo,
  repositoryUrl: `https://github.com/${linked.repo}`,
  source: { branch: `feature/${linked.number}` },
  destination: { branch: 'ops/development' },
  lastUpdate: linked.updatedAt,
});

// What GitHub says about a linked PR when a test does not care: open, not a draft, one author, no
// reviews and no CI. `details` overrides it per `repo#number`.
export const openDetail = (extra = {}) => ({
  state: 'OPEN',
  isDraft: false,
  mergedAt: null,
  author: { login: 'current-github-user' },
  reviews: { nodes: [], pageInfo: { hasPreviousPage: false } },
  commits: { nodes: [] },
  ...extra,
});

export const opinion = (login, state, day = 1) => ({
  author: { login },
  state,
  submittedAt: `2026-11-${String(day).padStart(2, '0')}T12:00:00Z`,
});

export const reviewPage = (nodes = [], reviewDecision = null, pageInfo = {}) => ({
  reviewDecision,
  reviews: { nodes, pageInfo: { hasNextPage: false, endCursor: null, ...pageInfo } },
});

export function aliasesOf(query) {
  const found = [];
  const pattern =
    /\b([A-Za-z_]\w*)\s*:\s*repository\(\s*owner:\s*("(?:[^"\\]|\\.)*")\s*,\s*name:\s*("(?:[^"\\]|\\.)*")\s*\)\s*\{\s*pullRequest\(\s*number:\s*(\d+)\s*\)/g;
  for (const match of query.matchAll(pattern)) {
    found.push([match[1], `${JSON.parse(match[2])}/${JSON.parse(match[3])}#${match[4]}`]);
  }
  return found;
}

export async function queueLoader() {
  const url = new URL('../backend/review-tickets.mjs', import.meta.url);
  assert.ok(fs.existsSync(url), 'the dedicated Jira-first queue loader must exist');
  const module = await import(url);
  assert.equal(typeof module.fetchReviewTickets, 'function', 'queue loader is exported');
  return module.fetchReviewTickets;
}

export function stubQueue(t, options = {}) {
  const calls = [];
  const unexpected = [];
  const timeouts = [];
  let inFlight = 0;
  const stub = { calls, unexpected, timeouts, maxInFlight: 0 };
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', (ms) => {
    timeouts.push(ms);
    return timeout(ms);
  });
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = new URL(input);
    const call = { url, init, index: calls.length };
    calls.push(call);
    inFlight += 1;
    if (url.pathname === '/graphql') stub.maxInFlight = Math.max(stub.maxInFlight, inFlight);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      if (url.pathname === '/rest/api/3/search/jql') {
        return options.jira
          ? await options.jira(call)
          : Response.json({ issues: options.issues || [issue()], isLast: true });
      }
      const devStatus = /^\/rest\/dev-status\/latest\/issue\/(summary|detail)$/.exec(
        url.pathname,
      )?.[1];
      if (devStatus) {
        call.devStatus = devStatus;
        if (options.devStatus) {
          const override = await options.devStatus(call);
          if (override) return override;
        }
        const id = url.searchParams.get('issueId');
        const linked = (options.linked || []).filter((candidate) =>
          candidate.tickets.some((key) => issueId(key) === id),
        );
        if (devStatus === 'summary')
          return Response.json({
            summary: {
              pullrequest: {
                overall: { count: linked.length },
                byInstanceType: linked.length
                  ? { [GITHUB_INSTANCE]: { count: linked.length, name: 'GitHub' } }
                  : {},
              },
            },
          });
        return Response.json({
          detail: linked.length ? [{ pullRequests: linked.map(rawOf) }] : [],
        });
      }
      if (url.pathname === '/graphql') {
        const { query } = JSON.parse(init.body);
        // The detail read (state, draft, author) is told apart from the review read by its fields.
        if (/\bisDraft\b/.test(query))
          return options.detail
            ? await options.detail(call)
            : Response.json({
                data: Object.fromEntries(
                  aliasesOf(query).map(([alias, id]) => [
                    alias,
                    { pullRequest: (options.details || {})[id] ?? openDetail() },
                  ]),
                ),
              });
        if (options.graphql) return await options.graphql(call);
        return Response.json({
          data: Object.fromEntries(
            aliasesOf(query).map(([alias]) => [alias, { pullRequest: reviewPage() }]),
          ),
        });
      }
      unexpected.push(`${url.origin}${url.pathname}`);
      throw new Error('Unexpected mocked queue request');
    } finally {
      inFlight -= 1;
    }
  });
  return stub;
}
