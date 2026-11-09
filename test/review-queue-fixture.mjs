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

export const issue = (key = 'DEMO-1', fields = {}) => ({
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
      if (/^\/repos\/[^/]+\/[^/]+\/pulls$/.test(url.pathname)) {
        return options.pulls ? await options.pulls(call) : Response.json([]);
      }
      if (url.pathname === '/graphql') {
        if (options.graphql) return await options.graphql(call);
        const { query } = JSON.parse(init.body);
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
