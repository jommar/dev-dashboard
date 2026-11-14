// upstream.test.mjs — the one classification of Jira, GitHub and Slack failures, the per-integration
// health record, the fetch wrapper that feeds both, and the one-line log helpers. `fetch` is a stub
// installed on globalThis per test; the clock is injected, so nothing here sleeps or touches a network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyError,
  classifyResponse,
  createUpstreamHealth,
  upstreamError,
  upstreamSentence,
} from '../backend/upstream.mjs';
import { logLine, scrubMessage } from '../backend/log.mjs';

const headers = (values) => new Headers(values);
const NOW = Date.parse('2026-11-14T10:00:00.000Z');

function stubFetch(t, answer) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return typeof answer === 'function' ? answer(url, init, calls.length) : answer;
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

function clock(start = NOW) {
  const state = { at: start };
  return { now: () => state.at, advance: (ms) => (state.at += ms) };
}

test('classifyResponse: auth, rate_limit and upstream by status and headers', () => {
  const kind = (status, h) => classifyResponse(status, h, NOW);
  assert.equal(kind(401, headers()).kind, 'auth');
  assert.equal(kind(403, headers()).kind, 'auth');
  const limited = kind(403, headers({ 'x-ratelimit-remaining': '0' }));
  assert.equal(limited.kind, 'rate_limit');
  const retry = kind(429, headers({ 'retry-after': '30' }));
  assert.deepEqual([retry.kind, retry.retryAfterSec], ['rate_limit', 30]);
  const reset = kind(
    403,
    headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(NOW / 1000 + 90) }),
  );
  assert.deepEqual([reset.kind, reset.retryAfterSec], ['rate_limit', 90]);
  assert.equal(kind(403, headers({ 'retry-after': '12' })).kind, 'rate_limit');
  assert.equal(kind(429, headers()).retryAfterSec, null, 'no retry time when none is given');
  assert.equal(kind(500, headers()).kind, 'upstream');
  assert.equal(kind(404, headers()).kind, 'upstream');
});

test('classifyError: timeout, abort and network failures; classifyResponse tolerates headerless stubs (headerless)', () => {
  const timeout = Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const refused = new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
  assert.equal(classifyError(timeout).kind, 'timeout');
  assert.equal(classifyError(abort).kind, 'timeout');
  assert.equal(classifyError(refused).kind, 'network');
  assert.equal(classifyError(new Error('anything else')).kind, 'network');
  assert.equal(classifyError(undefined).kind, 'network');
  assert.doesNotThrow(() => classifyResponse(500, undefined));
  assert.equal(classifyResponse(500, undefined).kind, 'upstream');
  assert.equal(classifyResponse(401, {}).kind, 'auth', 'a plain-object headers value');
});

test('upstreamFetch records a success and returns the response untouched', async (t) => {
  const response = new Response('{}', { status: 200 });
  const calls = stubFetch(t, response);
  const health = createUpstreamHealth({ now: clock().now });
  assert.equal(health.snapshot().jira.status, 'unknown');

  const init = { headers: { Accept: 'application/json' } };
  const result = await health.fetch('jira', 'https://jira.example.invalid/x', init);

  assert.equal(result, response);
  assert.ok(calls[0].init.signal instanceof AbortSignal, 'a timeout signal was added');
  assert.equal(calls[0].init.headers, init.headers);
  const entry = health.snapshot().jira;
  assert.equal(entry.status, 'ok');
  assert.equal(entry.lastOkAt, new Date(NOW).toISOString());
  assert.equal(entry.lastFailure, null);
});

test('upstreamFetch rethrows classified errors and does not replace a caller signal', async (t) => {
  const timeout = Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });
  const calls = stubFetch(t, () => {
    throw timeout;
  });
  const health = createUpstreamHealth({ now: clock().now });
  const signal = AbortSignal.timeout(60_000);

  await assert.rejects(
    () => health.fetch('github', 'https://api.example.invalid/x', { signal }),
    (error) => {
      assert.equal(error, timeout, 'the original error object');
      assert.deepEqual(error.upstream, { name: 'github', kind: 'timeout' });
      return true;
    },
  );
  assert.equal(calls[0].init.signal, signal);
  const entry = health.snapshot().github;
  assert.equal(entry.status, 'degraded');
  assert.equal(entry.lastFailure.kind, 'timeout');
  assert.equal(entry.lastFailure.at, new Date(NOW).toISOString());
});

test('upstreamFetch records a non-ok response as a failure and still returns it', async (t) => {
  stubFetch(t, new Response('no', { status: 401 }));
  const health = createUpstreamHealth({ now: clock().now });
  const res = await health.fetch('jira', 'https://jira.example.invalid/x', {});
  assert.equal(res.status, 401);
  const { lastFailure, status } = health.snapshot().jira;
  assert.equal(status, 'degraded');
  assert.equal(lastFailure.kind, 'auth');
  assert.equal(lastFailure.status, 401);
});

test('a later success clears a degraded record; a failure after a success degrades it', async (t) => {
  let status = 500;
  stubFetch(t, () => new Response('', { status }));
  const c = clock();
  const health = createUpstreamHealth({ now: c.now });
  await health.fetch('jira', 'https://x.invalid/', {});
  assert.equal(health.snapshot().jira.status, 'degraded');
  c.advance(1000);
  status = 200;
  await health.fetch('jira', 'https://x.invalid/', {});
  assert.equal(health.snapshot().jira.status, 'ok');
  c.advance(1000);
  status = 502;
  await health.fetch('jira', 'https://x.invalid/', {});
  const entry = health.snapshot().jira;
  assert.equal(entry.status, 'degraded');
  assert.ok(entry.lastOkAt, 'the earlier success is remembered');
});

test('the record holds no url, header, body or secret', async (t) => {
  stubFetch(t, new Response('', { status: 429, headers: { 'retry-after': '5' } }));
  const health = createUpstreamHealth({ now: clock().now });
  await health.fetch('github', 'https://api.example.invalid/secret-path?q=SECRET', {
    headers: { Authorization: 'Bearer SECRET-TOKEN' },
  });
  const text = JSON.stringify(health.snapshot());
  assert.ok(!text.includes('SECRET'));
  assert.ok(!text.includes('example.invalid'));
});

test('a rate-limit cool-down blocks later calls without a request', async (t) => {
  let answered = 0;
  const calls = stubFetch(t, () => {
    answered += 1;
    return answered === 1
      ? new Response('', { status: 429, headers: { 'retry-after': '60' } })
      : new Response('{}', { status: 200 });
  });
  const c = clock();
  const health = createUpstreamHealth({ now: c.now });

  await health.fetch('github', 'https://api.example.invalid/a', {});
  c.advance(30_000);
  await assert.rejects(
    () => health.fetch('github', 'https://api.example.invalid/a', {}),
    (error) => {
      assert.equal(error.code, 'UPSTREAM_FAILED');
      assert.deepEqual(error.errors, ['rate_limit']);
      assert.equal(error.statusHint, 502);
      assert.deepEqual(error.upstream, { name: 'github', kind: 'rate_limit', retryAfterSec: 30 });
      return true;
    },
  );
  assert.equal(calls.length, 1, 'no request during the cool-down');
  assert.equal(health.snapshot().github.lastFailure.status, 429, 'the record is not rewritten');

  await health.fetch('jira', 'https://jira.example.invalid/a', {});
  assert.equal(calls.length, 2, 'another integration is not blocked');

  c.advance(31_000);
  await health.fetch('github', 'https://api.example.invalid/a', {});
  assert.equal(calls.length, 3, 'the request goes out once the time has passed');
  assert.equal(health.snapshot().github.status, 'ok');
});

test('a cool-down is capped at 15 minutes', async (t) => {
  const calls = stubFetch(t, new Response('', { status: 429, headers: { 'retry-after': '7200' } }));
  const c = clock();
  const health = createUpstreamHealth({ now: c.now });
  await health.fetch('github', 'https://api.example.invalid/a', {});
  c.advance(899_000);
  await assert.rejects(() => health.fetch('github', 'https://api.example.invalid/a', {}));
  assert.equal(calls.length, 1);
  c.advance(2_000);
  await health.fetch('github', 'https://api.example.invalid/a', {});
  assert.equal(calls.length, 2);
});

test('a rate limit without a retry time does not start a cool-down', async (t) => {
  const calls = stubFetch(t, new Response('', { status: 429 }));
  const health = createUpstreamHealth({ now: clock().now });
  await health.fetch('github', 'https://api.example.invalid/a', {});
  await health.fetch('github', 'https://api.example.invalid/a', {});
  assert.equal(calls.length, 2);
});

test('upstreamError keeps the caller message and adds code, kind and a 502 hint', () => {
  const res = { status: 401, headers: headers() };
  const error = upstreamError('jira', res, 'jira search failed: 401');
  assert.equal(error.message, 'jira search failed: 401');
  assert.equal(error.code, 'UPSTREAM_FAILED');
  assert.deepEqual(error.errors, ['auth']);
  assert.equal(error.statusHint, 502);
  assert.deepEqual(error.upstream, { name: 'jira', kind: 'auth' });
  const limited = upstreamError(
    'github',
    { status: 429, headers: headers({ 'retry-after': '9' }) },
    'x',
  );
  assert.equal(limited.upstream.retryAfterSec, 9);
  assert.equal(upstreamError('jira', { status: 500 }, 'x').errors[0], 'upstream', 'headerless');
});

test('upstreamSentence is a fixed sentence per integration and kind', () => {
  assert.equal(upstreamSentence('jira', 'auth'), 'Jira rejected the token.');
  assert.equal(upstreamSentence('github', 'rate_limit'), 'GitHub is rate limiting requests.');
  assert.equal(upstreamSentence('slack', 'timeout'), 'Slack did not answer in time.');
  assert.equal(upstreamSentence('jira', 'network'), 'Jira could not be reached.');
  assert.equal(upstreamSentence('jira', 'upstream'), 'Jira is having trouble answering.');
});

test('the snapshot lists github, jira and slack, unknown until an outcome', () => {
  const health = createUpstreamHealth({ now: clock().now });
  assert.deepEqual(Object.keys(health.snapshot()), ['github', 'jira', 'slack']);
  assert.deepEqual(health.snapshot().slack, {
    status: 'unknown',
    lastOkAt: null,
    lastFailure: null,
  });
});

test('recordResponse feeds the record from a status and headers, for Slack', () => {
  const c = clock();
  const health = createUpstreamHealth({ now: c.now });
  health.recordResponse('slack', 429, headers({ 'retry-after': '30' }));
  const { lastFailure } = health.snapshot().slack;
  assert.deepEqual([lastFailure.kind, lastFailure.retryAfterSec], ['rate_limit', 30]);
  health.recordResponse('slack', 200, headers());
  assert.equal(health.snapshot().slack.status, 'ok');
  health.recordFailure('slack', { kind: 'timeout' });
  assert.equal(health.snapshot().slack.lastFailure.kind, 'timeout');
});

test('scrubMessage keeps the first line, hides tokens and url queries, cuts to 200', () => {
  assert.equal(scrubMessage('Bearer ghp_abc123 failed'), 'Bearer [token] failed');
  assert.equal(
    scrubMessage('token ghp_abcDEF123 and github_pat_11AAA_bbb'),
    'token [token] and [token]',
  );
  assert.equal(scrubMessage('xoxc-1-2-abc and xoxd-9%2Bz'), '[token] and [token]');
  assert.equal(scrubMessage('Basic dXNlcjpwYXNz leaked'), 'Basic [token] leaked');
  assert.equal(
    scrubMessage('GET https://x.example.invalid/a?jql=SECRET#frag failed'),
    'GET https://x.example.invalid/a failed',
  );
  assert.equal(scrubMessage('first\nsecond ghp_zzz'), 'first');
  // URL userinfo (a password in a remote) is hidden, also when the password holds an '@'.
  assert.equal(
    scrubMessage('fatal: unable to access "https://bob:s3cret@host.example.invalid/r.git/"'),
    'fatal: unable to access "https://[token]@host.example.invalid/r.git/"',
  );
  assert.equal(
    scrubMessage('ssh://deploy:p@ss@host.example.invalid/r.git?x=1 failed'),
    'ssh://[token]@host.example.invalid/r.git failed',
  );
  assert.equal(
    scrubMessage('see https://host.example.invalid/a@b'),
    'see https://host.example.invalid/a@b',
  );
  assert.equal(scrubMessage('a'.repeat(500)).length, 200);
  assert.equal(scrubMessage(undefined), '');
  assert.equal(scrubMessage({ not: 'text' }), '');
});

test('upstream health keeps only its fixed fields, never a url or header a caller hands it', () => {
  const health = createUpstreamHealth();
  health.recordFailure('jira', {
    kind: 'auth',
    status: 401,
    url: 'https://u:p@h.example.invalid/?q=SECRET',
    headers: { authorization: 'Bearer SECRET' },
  });
  const entry = health.snapshot().jira;
  assert.deepEqual(Object.keys(entry.lastFailure).sort(), [
    'at',
    'kind',
    'retryAfterSec',
    'status',
  ]);
  assert.doesNotMatch(JSON.stringify(health.snapshot()), /SECRET|https?:/);
});

test('logLine writes one tagged JSON line and never throws', () => {
  const lines = [];
  logLine((line) => lines.push(line), 'http', { method: 'GET', status: 502, skipped: undefined });
  assert.deepEqual(lines, ['[http] {"method":"GET","status":502}']);
  const multi = [];
  logLine((line) => multi.push(line), 'http', { message: 'a\nb' });
  assert.equal(multi.length, 1);
  assert.ok(!multi[0].includes('\n'), 'a newline is escaped inside the JSON');
  assert.doesNotThrow(() =>
    logLine(
      () => {
        throw new Error('broken');
      },
      'http',
      {},
    ),
  );
  const circular = {};
  circular.self = circular;
  assert.doesNotThrow(() => logLine(() => {}, 'http', circular));
});
