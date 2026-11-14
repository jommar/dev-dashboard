// upstream-routes.test.mjs — the HTTP layer's side of integration health: the envelope of a classified
// failure, GET /api/health (memory only, before the setup gate), and the one scrubbed `[http]` line an
// unexpected failure leaves. The handler is the production one; integrations are doubles.
import test from 'node:test';
import assert from 'node:assert/strict';
import { listenHttp, requestRaw } from './http-test-fixture.mjs';
import { settingsFixture, accept } from './settings-fixture.mjs';
import { createUpstreamHealth, upstreamError } from '../backend/upstream.mjs';

async function startRoute(t, { ready = true, integrations = {} } = {}) {
  const fixture = settingsFixture(t);
  const store = await fixture.store();
  if (ready) await accept(fixture, store);
  else await store.initialize();
  const { createHttpHandler } = await import('../backend/http-app.mjs');
  const lines = [];
  const manager = { list: () => [], logs: () => '', applySettings: async () => {} };
  const handler = createHttpHandler({
    settings: store,
    manager,
    integrations: { log: (line) => lines.push(line), ...integrations },
  });
  const { origin } = await listenHttp(t, handler);
  const request = async (pathname, method = 'GET', body) => {
    const { status, text } = await requestRaw(origin, pathname, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status, text, json: () => JSON.parse(text) };
  };
  return { request, lines, origin };
}

const failing = (error) => ({
  fetchMyTickets: async () => {
    throw error;
  },
});

test('envelope: a classified failure answers UPSTREAM_FAILED with its kind and a fixed sentence', async (t) => {
  const error = upstreamError('jira', { status: 401 }, 'jira search failed: 401');
  const { request } = await startRoute(t, { integrations: failing(error) });
  const res = await request('/api/my-tickets');
  assert.equal(res.status, 502);
  assert.deepEqual(res.json(), {
    code: 'UPSTREAM_FAILED',
    error: 'Jira rejected the token.',
    errors: ['auth'],
  });
});

test('envelope: a thrown timeout from the wrapper is classified too; a plain error stays OPERATION_FAILED', async (t) => {
  const timeout = Object.assign(new Error('The operation timed out.'), {
    name: 'TimeoutError',
    upstream: { name: 'github', kind: 'timeout' },
  });
  const first = await startRoute(t, { integrations: failing(timeout) });
  assert.deepEqual((await first.request('/api/my-tickets')).json(), {
    code: 'UPSTREAM_FAILED',
    error: 'GitHub did not answer in time.',
    errors: ['timeout'],
  });
  const second = await startRoute(t, { integrations: failing(new Error('boom')) });
  const res = await second.request('/api/my-tickets');
  assert.equal(res.status, 502);
  assert.deepEqual(res.json(), { code: 'OPERATION_FAILED', error: 'OPERATION FAILED', errors: [] });
});

test('health route: answers before setup from memory, with no upstream call and no secrets', async (t) => {
  const health = createUpstreamHealth();
  health.recordResponse('github', 429, new Headers({ 'retry-after': '120' }));
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    calls.push(args);
    throw new Error('no network in this test');
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const { request } = await startRoute(t, {
    ready: false,
    integrations: { upstreamHealth: health },
  });

  const res = await request('/api/health');

  assert.equal(res.status, 200);
  const body = res.json();
  assert.deepEqual(Object.keys(body).sort(), ['generatedAt', 'integrations']);
  assert.ok(Number.isFinite(Date.parse(body.generatedAt)));
  assert.deepEqual(Object.keys(body.integrations), ['github', 'jira', 'slack']);
  assert.equal(body.integrations.github.status, 'degraded');
  assert.equal(body.integrations.github.lastFailure.kind, 'rate_limit');
  assert.equal(body.integrations.github.lastFailure.retryAfterSec, 120);
  assert.equal(body.integrations.jira.status, 'unknown');
  assert.equal(body.integrations.slack.status, 'unknown');
  assert.equal(calls.length, 0, 'no upstream request');
  assert.doesNotMatch(res.text, /https?:|Bearer|Authorization|token/i);
});

test('one log line: a plain error and a 500 each log once; an allow-listed 400 logs none', async (t) => {
  const { request, lines, origin } = await startRoute(t, {
    integrations: {
      ...failing(new Error('boom')),
      claudeChat: {
        stop: async () => {
          throw Object.assign(new Error('server broke'), { status: 500, code: 'ECONNRESET' });
        },
        close() {},
      },
    },
  });

  await request('/api/my-tickets');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[http\] \{/);
  assert.deepEqual(JSON.parse(lines[0].slice('[http] '.length)), {
    method: 'GET',
    route: '/api/my-tickets',
    status: 502,
    code: 'OPERATION_FAILED',
    name: 'Error',
    message: 'boom',
  });

  await request('/api/claude/chat/stop', 'POST', { session: 'x' });
  assert.equal(lines.length, 2);
  const second = JSON.parse(lines[1].slice('[http] '.length));
  assert.equal(second.status, 500);
  assert.equal(second.errCode, 'ECONNRESET');

  const bad = await requestRaw(origin, '/api/claude/chat/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'not json',
  });
  assert.equal(bad.status, 400);
  assert.equal(lines.length, 2, 'the 400 logged nothing');
});

test('holds no body, query, token or chat text', async (t) => {
  const { request, lines } = await startRoute(t, {
    integrations: {
      fetchMyTickets: async () => {
        throw new Error('Bearer ghp_abc123 failed');
      },
      claudeChat: {
        send: async () => {
          throw new Error('send failed CHAT-SENTINEL');
        },
        close() {},
      },
      slackWatcher: {
        isDisabled: () => {
          throw new Error('watch broke CHAT-SENTINEL');
        },
        stop() {},
        start() {},
      },
    },
  });

  await request('/api/my-tickets?jql=SECRET');
  await request('/api/claude/chat/send', 'POST', { message: 'CHAT-SENTINEL', session: 'x' });
  await request('/api/slack/watch/links', 'POST', { links: ['CHAT-SENTINEL'] });

  assert.equal(lines.length, 3);
  const text = lines.join('\n');
  for (const secret of ['SECRET', 'ghp_abc123', 'CHAT-SENTINEL'])
    assert.ok(!text.includes(secret), `${secret} must not be logged`);
  const [mine, chat, watch] = lines.map((line) => JSON.parse(line.slice('[http] '.length)));
  assert.equal(mine.route, '/api/my-tickets');
  assert.equal(mine.message, 'Bearer [token] failed');
  assert.ok(!('message' in chat), 'no message on the chat routes');
  assert.ok(!('message' in watch), 'no message on the Slack routes');
});

test('broken logger: a throwing log never changes the reply', async (t) => {
  const { request } = await startRoute(t, {
    integrations: {
      ...failing(new Error('boom')),
      log: () => {
        throw new Error('log is broken');
      },
    },
  });
  const res = await request('/api/my-tickets');
  assert.equal(res.status, 502);
  assert.deepEqual(res.json(), { code: 'OPERATION_FAILED', error: 'OPERATION FAILED', errors: [] });
});

const parseLine = (line) => JSON.parse(line.slice('[http] '.length));

test('hostile input: client errors log nothing, whatever the query or Host header holds', async (t) => {
  const { request, lines, origin } = await startRoute(t);

  const diff = await request(
    '/api/pr-diff?repo=https%3A%2F%2Fbob%3AQSECRET%40h.example.invalid&number=NSECRET',
  );
  assert.equal(diff.status, 400);
  const host = await requestRaw(origin, '/api/my-tickets?jql=QSECRET', {
    headers: { Host: 'evil.example.invalid' },
  });
  assert.equal(host.status, 403);
  const type = await requestRaw(origin, '/api/claude/chat/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: 'x',
  });
  assert.equal(type.status, 415);

  assert.deepEqual(lines, [], "a status below 500 is the caller's mistake, not a server failure");
});

test('hostile input: a server error scrubs URL userinfo and never carries the query', async (t) => {
  const { request, lines } = await startRoute(t, {
    integrations: failing(
      new Error(
        'git fetch failed: unable to access "https://bob:PWSECRET@h.example.invalid/r.git/"',
      ),
    ),
  });
  await request('/api/my-tickets?jql=QSECRET&token=QSECRET');
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes('PWSECRET'), 'no URL password');
  assert.ok(!lines[0].includes('QSECRET'), 'no query text');
  assert.equal(parseLine(lines[0]).route, '/api/my-tickets');
});

test('hostile input: a SyntaxError quotes its input, so its message is not logged', async (t) => {
  const { request, lines } = await startRoute(t, {
    integrations: failing(
      new SyntaxError('Unexpected token \'A\', "ATATT3xBODYSECRET"... is not valid JSON'),
    ),
  });
  await request('/api/my-tickets');
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes('BODYSECRET'));
  const line = parseLine(lines[0]);
  assert.equal(line.name, 'SyntaxError');
  assert.ok(!('message' in line));
});

test('one log line: a cool-down short-circuit is answered but not logged again', async (t) => {
  const health = createUpstreamHealth();
  health.recordResponse('github', 429, new Headers({ 'retry-after': '300' }));
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('the cool-down must stop the request');
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const { request, lines } = await startRoute(t, {
    integrations: {
      upstreamHealth: health,
      fetchMyTickets: async () => {
        await health.fetch('github', 'https://api.github.com/user');
      },
    },
  });
  const res = await request('/api/my-tickets');
  assert.equal(res.status, 502);
  assert.deepEqual(res.json().errors, ['rate_limit']);
  assert.deepEqual(lines, []);
});
