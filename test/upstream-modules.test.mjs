// upstream-modules.test.mjs — the Jira, GitHub and Slack modules keep their error text and gain an
// upstream kind: a failed call rejects with the unchanged message, `code` UPSTREAM_FAILED and
// `errors[0]` set to the kind, and the shared health record learns the outcome. `globalThis.fetch` is
// a stub restored after each test; Slack's own `fetchImpl` is injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { upstreamHealth } from '../backend/upstream.mjs';
import { fetchMyTickets, fetchTicketMetadata, fetchUatPromoteTickets } from '../backend/jira.mjs';
import { fetchTeamIssues } from '../backend/team-velocity.mjs';
import { fetchOpenPRs, fetchPrBase } from '../backend/github.mjs';
import { postGraphql } from '../backend/github-api.mjs';
import { createSlackIntegration, slackPaths } from '../backend/slack.mjs';

const snapshot = {
  revision: 1,
  github: { api: 'https://api.example.invalid', org: 'ExampleOrg', repos: ['app'], maxResults: 5 },
  jira: {
    baseUrl: 'https://jira.example.invalid',
    email: 'qa@example.invalid',
    sprintField: 'customfield_101',
    pointsField: 'customfield_102',
  },
  local: { root: '/tmp', services: [] },
  minPrApprover: 1,
  credentials: { githubToken: 'synthetic-github', jiraToken: 'synthetic-jira' },
};

function stubFetch(t, answer) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return answer(String(url), init, calls.length);
  };
  upstreamHealth.reset();
  t.after(() => {
    globalThis.fetch = original;
    upstreamHealth.reset();
  });
  return calls;
}

const status = (code, headers) => () => new Response('', { status: code, headers });

const JIRA_CASES = [
  [401, 'auth'],
  [429, 'rate_limit'],
  [500, 'upstream'],
];

const readsKind = (code, kind, message) => (error) => {
  assert.equal(error.message, message);
  assert.equal(error.code, 'UPSTREAM_FAILED');
  assert.equal(error.errors[0], kind);
  assert.equal(error.statusHint, 502);
  return true;
};

for (const [code, kind] of JIRA_CASES) {
  test(`jira upstream kind: a ${code} reads ${kind} on every migrated reader`, async (t) => {
    stubFetch(t, status(code));
    const message = `jira search failed: ${code}`;
    await assert.rejects(fetchMyTickets({ snapshot }), readsKind(code, kind, message));
    upstreamHealth.reset();
    await assert.rejects(
      fetchTicketMetadata(['A-1'], { snapshot, strict: true }),
      readsKind(code, kind, message),
    );
    upstreamHealth.reset();
    await assert.rejects(fetchUatPromoteTickets({ snapshot }), readsKind(code, kind, message));
    upstreamHealth.reset();
    await assert.rejects(fetchTeamIssues({ snapshot }), readsKind(code, kind, message));
    assert.equal(upstreamHealth.snapshot().jira.lastFailure.kind, kind);
  });
}

test('jira upstream kind: a non-strict metadata read still answers empty and records the failure', async (t) => {
  stubFetch(t, status(401));
  assert.deepEqual(await fetchTicketMetadata(['A-1'], { snapshot }), { statuses: {}, sprints: {} });
  assert.equal(upstreamHealth.snapshot().jira.status, 'degraded');
});

test('jira upstream kind: a timeout rejects with its kind and keeps the original error', async (t) => {
  const timeout = Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });
  stubFetch(t, () => {
    throw timeout;
  });
  await assert.rejects(fetchMyTickets({ snapshot }), (error) => {
    assert.equal(error, timeout);
    assert.equal(error.upstream.kind, 'timeout');
    return true;
  });
});

function githubStub(t, { search }) {
  return stubFetch(t, (url) => {
    if (url.endsWith('/user')) return Response.json({ login: 'someone' });
    return search(url);
  });
}

test('github upstream: a rate-limited search keeps its text, then blocks without a request', async (t) => {
  const reset = String(Math.floor(Date.now() / 1000) + 60);
  const calls = githubStub(t, {
    search: () =>
      new Response('', {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset },
      }),
  });
  await assert.rejects(
    fetchOpenPRs({ snapshot }),
    readsKind(403, 'rate_limit', 'github search failed: 403'),
  );
  assert.equal(calls.length, 2, '/user and the search');
  await assert.rejects(fetchOpenPRs({ snapshot }), (error) => {
    assert.equal(error.errors[0], 'rate_limit');
    assert.ok(error.upstream.retryAfterSec > 0);
    return true;
  });
  assert.equal(calls.length, 2, 'the second call made no request');
  assert.equal(upstreamHealth.snapshot().github.lastFailure.kind, 'rate_limit');
});

test('github upstream: /user and the pull fetch classify too, with their own text', async (t) => {
  stubFetch(t, status(401));
  await assert.rejects(
    fetchOpenPRs({ snapshot }),
    readsKind(401, 'auth', 'github /user failed: 401'),
  );
  upstreamHealth.reset();
  await assert.rejects(
    fetchPrBase('ExampleOrg/app', 7, { snapshot }),
    readsKind(500, 'auth', 'github pull fetch failed: 401'),
  );
});

test('github upstream: the GraphQL post is recorded', async (t) => {
  stubFetch(t, status(502));
  const res = await postGraphql(snapshot, 'query {}');
  assert.equal(res.status, 502);
  assert.equal(upstreamHealth.snapshot().github.lastFailure.kind, 'upstream');
});

function slackSetup(t, answer) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'upstream-slack-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = slackPaths(home);
  fs.mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    paths.session,
    JSON.stringify({ token: 'xoxc-synthetic', cookie: 'xoxd-synthetic', teamId: 'T1' }),
    { mode: 0o600 },
  );
  upstreamHealth.reset();
  t.after(() => upstreamHealth.reset());
  return createSlackIntegration({ paths, fetchImpl: async () => answer() });
}

test('slack records: a 429 reads rate_limit with its delay and a 500 reads upstream', async (t) => {
  const limited = slackSetup(
    t,
    () => new Response('{}', { status: 429, headers: { 'retry-after': '30' } }),
  );
  assert.equal((await limited.status()).verified, false);
  const { lastFailure, status: state } = upstreamHealth.snapshot().slack;
  assert.equal(state, 'degraded');
  assert.deepEqual([lastFailure.kind, lastFailure.retryAfterSec], ['rate_limit', 30]);

  const broken = slackSetup(t, () => new Response('{}', { status: 500 }));
  await broken.status();
  assert.equal(upstreamHealth.snapshot().slack.lastFailure.kind, 'upstream');
});

test('slack records: a good answer reads ok and a thrown timeout reads timeout', async (t) => {
  const good = slackSetup(
    t,
    () => new Response(JSON.stringify({ ok: true, user: 'u', team: 't', team_id: 'T1' })),
  );
  await good.status();
  assert.equal(upstreamHealth.snapshot().slack.status, 'ok');

  const stalled = slackSetup(t, () => {
    throw Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });
  });
  await stalled.status();
  assert.equal(upstreamHealth.snapshot().slack.lastFailure.kind, 'timeout');
});
