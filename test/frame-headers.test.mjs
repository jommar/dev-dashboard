// frame-headers.test.mjs — the dashboard must not be embeddable in another page: every reply its
// server sends carries `X-Frame-Options: DENY` and a `Content-Security-Policy` of
// `frame-ancestors 'none'` and nothing else, and the headers a reply already had are kept.
//
// The static files and the index page are the copy's (see `dashboardSandbox`): a temp copy of the
// dashboard is served by its own handler in a child process, so no test depends on, or writes to,
// the dashboard's own `dist` folder. The prompt routes are checked in this process over a temp
// prompts folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpHandler } from '../backend/http-app.mjs';
import { claudeHttpFixture, dashboardSandbox } from './claude-launcher-fixture.mjs';

// The directives of a Content-Security-Policy header, without empty ones.
const directives = (policy) =>
  String(policy)
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);

function assertFramed(reply, label) {
  assert.equal(reply.headers['x-frame-options'], 'DENY', `${label}: X-Frame-Options`);
  assert.deepEqual(
    directives(reply.headers['content-security-policy']),
    ["frame-ancestors 'none'"],
    `${label}: the policy forbids framing and restricts nothing else`,
  );
}

function framedSandbox(t) {
  const sandbox = dashboardSandbox(t);
  sandbox.write(
    'dist/index.html',
    '<!doctype html><title>built</title><main>built dashboard</main>',
  );
  sandbox.write('dist/assets/frame-probe.js', 'export const probe = 1;');
  sandbox.write('ui/frame-probe.js', 'export const probe = 2;');
  return sandbox;
}

test('scenario 160: the replies of the API carry the frame headers and keep their own', (t) => {
  const sandbox = framedSandbox(t);

  const replies = sandbox.requests([
    { label: 'config', path: '/api/config' },
    { label: 'settings', path: '/api/settings' },
    { label: 'services', path: '/api/services' },
  ]);

  for (const [label, reply] of Object.entries(replies)) {
    assert.equal(reply.status, 200, label);
    assertFramed(reply, label);
    assert.equal(reply.headers['content-type'], 'application/json; charset=utf-8', label);
    assert.equal(reply.headers['cache-control'], 'no-store', label);
  }
});

test('scenario 161: a static file carries the frame headers and keeps its own', (t) => {
  const sandbox = framedSandbox(t);

  const replies = sandbox.requests([
    { label: 'ui file', path: '/ui/frame-probe.js' },
    { label: 'built asset', path: '/assets/frame-probe.js' },
  ]);

  assert.equal(replies['ui file'].status, 200);
  assert.equal(replies['ui file'].text, 'export const probe = 2;');
  assert.equal(replies['ui file'].headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(replies['ui file'].headers['cache-control'], 'no-store');
  assert.equal(replies['built asset'].status, 200);
  assert.equal(replies['built asset'].text, 'export const probe = 1;');
  assert.equal(
    replies['built asset'].headers['cache-control'],
    'public, max-age=31536000, immutable',
  );
  for (const [label, reply] of Object.entries(replies)) {
    assertFramed(reply, label);
    assert.equal(reply.headers['x-content-type-options'], 'nosniff', label);
  }
});

test('scenario 162: the index page carries the frame headers and keeps its own', (t) => {
  const sandbox = framedSandbox(t);

  const { index } = sandbox.requests([{ label: 'index', path: '/' }]);

  assert.equal(index.status, 200);
  assert.ok(index.text.includes('built dashboard'), 'the built index page');
  assert.equal(index.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(index.headers['cache-control'], 'no-store');
  assertFramed(index, 'index');
});

test('scenario 163: a path that is not found carries the frame headers, API or not, file or not', (t) => {
  const sandbox = framedSandbox(t);

  const replies = sandbox.requests([
    { label: 'unknown path', path: '/nope' },
    { label: 'unknown api path', path: '/api/nope' },
    { label: 'missing ui file', path: '/ui/missing.js' },
    { label: 'missing built asset', path: '/assets/missing.js' },
  ]);

  for (const [label, reply] of Object.entries(replies)) {
    assert.equal(reply.status, 404, label);
    assertFramed(reply, label);
  }
});

test('scenario 164: a refusal carries the frame headers: bad host, cross-site, wrong type, bad JSON', (t) => {
  const sandbox = framedSandbox(t);
  const json = { 'content-type': 'application/json' };

  const replies = sandbox.requests([
    { label: 'bad host', path: '/api/config', headers: { host: 'evil.example' } },
    {
      label: 'cross-site',
      method: 'POST',
      path: '/api/settings/validate',
      headers: { ...json, 'sec-fetch-site': 'cross-site' },
      body: '{}',
    },
    {
      label: 'wrong type',
      method: 'POST',
      path: '/api/settings/validate',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    },
    {
      label: 'bad JSON',
      method: 'POST',
      path: '/api/settings/validate',
      headers: json,
      body: '{',
    },
  ]);

  assert.deepEqual(
    Object.values(replies).map(({ status }) => status),
    [403, 403, 415, 400],
  );
  for (const [label, reply] of Object.entries(replies)) assertFramed(reply, label);
});

test('scenario 165: the log text and the event stream carry the frame headers as well', (t) => {
  const sandbox = framedSandbox(t);

  const replies = sandbox.requests([
    { label: 'log text', path: '/api/logs/example' },
    { label: 'event stream', path: '/api/events', headersOnly: true },
  ]);

  assert.equal(replies['log text'].status, 200);
  assert.equal(replies['log text'].headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(replies['event stream'].status, 200);
  assert.equal(replies['event stream'].headers['content-type'], 'text/event-stream');
  assert.equal(replies['event stream'].headers['cache-control'], 'no-store');
  for (const [label, reply] of Object.entries(replies)) assertFramed(reply, label);
});

test('scenario 166: the replies of the Claude and prompt routes carry the frame headers, success and refusal', async (t) => {
  const f = await claudeHttpFixture(t);
  const json = { 'content-type': 'application/json' };
  const put = (name, headers, body) =>
    f.http.raw('PUT', `/api/claude/prompts/${name}`, { headers, body: JSON.stringify(body) });

  const replies = {
    'ticket list': await f.http.bare('GET', '/api/claude/tickets'),
    'prompt list': await f.http.bare('GET', '/api/claude/prompts'),
    'prompt saved': await put('implement', json, { text: 'a text' }),
    'prompt invalid': await put('implement', json, { text: '   ' }),
    'prompt reset': await f.http.bare('DELETE', '/api/claude/prompts/implement'),
    'prompt unknown': await put('nothing', json, { text: 'a text' }),
    'prompt cross-site': await put(
      'implement',
      { ...json, 'sec-fetch-site': 'cross-site' },
      {
        text: 'a text',
      },
    ),
  };

  assert.deepEqual(
    Object.values(replies).map(({ status }) => status),
    [200, 200, 200, 400, 200, 404, 403],
  );
  for (const [label, reply] of Object.entries(replies)) assertFramed(reply, label);
});

// The handler over doubles only, as the Slack route tests build it, to see what it asks of the
// response object it is given.
function handlerOverDoubles() {
  return createHttpHandler({
    settings: {},
    manager: {},
    integrations: {
      slack: { status: async () => ({ connected: false }) },
      slackWatchStore: {},
      claudeSessions: {},
      claudeLauncher: {},
      claudePrompts: {},
      slackWatcher: { isDisabled: () => true, stop() {} },
    },
  });
}
const statusRequest = {
  method: 'GET',
  url: '/api/slack/status',
  headers: { host: 'localhost' },
  socket: {},
};

test('scenario 167: the handler sets both frame headers on the response with setHeader, before it writes the head', async () => {
  const handler = handlerOverDoubles();
  const events = [];
  const response = {
    setHeader: (name, value) => events.push(['setHeader', name.toLowerCase(), value]),
    writeHead: (status) => events.push(['writeHead', status]),
    end: () => events.push(['end']),
  };

  await handler(statusRequest, response);
  handler.close();

  assert.deepEqual(
    events.map(([kind]) => kind),
    ['setHeader', 'setHeader', 'writeHead', 'end'],
    'both headers are set before the head is written',
  );
  assert.deepEqual(
    events
      .filter(([kind]) => kind === 'setHeader')
      .map(([, name, value]) => [name, value])
      .sort(),
    [
      ['content-security-policy', "frame-ancestors 'none'"],
      ['x-frame-options', 'DENY'],
    ],
  );
});

test('scenario 168: a response that cannot take a header is an error, never a reply sent without the frame headers', async () => {
  const handler = handlerOverDoubles();
  const sent = [];
  const response = { writeHead: (status) => sent.push(status), end: () => sent.push('end') };

  await assert.rejects(handler(statusRequest, response), /setHeader/);
  handler.close();

  assert.deepEqual(sent, [], 'nothing was sent');
});
