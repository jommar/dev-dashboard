import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../ui-react/lib/api.js';

const { control, getLog } = api;

test('control rejects HTTP failures with actionable server detail', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (...args) => {
    calls.push(args);
    return new Response(JSON.stringify({ error: 'Process is busy' }), { status: 409 });
  });
  await assert.rejects(control('my service', 'start'), /Process is busy/);
  assert.equal(calls[0][0], '/api/services/my%20service/start');
  assert.equal(calls[0][1].method, 'POST');
});

test('log failures cannot be mistaken for log output; full retained content uses zero', async (t) => {
  let url;
  t.mock.method(globalThis, 'fetch', async (value) => {
    url = value;
    return new Response('temporarily unavailable', { status: 503 });
  });
  await assert.rejects(getLog('api', 0), /503/);
  assert.equal(url, '/api/logs/api?lines=0');
});

test('getTicketPrs returns the payload on 200 and asks the new route', async (t) => {
  const payload = { available: true, login: 'qa', total: 0, truncated: false, byTicket: {} };
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (...args) => {
    calls.push(args);
    return new Response(JSON.stringify(payload), { status: 200 });
  });
  assert.deepEqual(await api.getTicketPrs(), payload);
  assert.equal(calls[0][0], '/api/ticket-prs');
});

test('getTicketPrs resolves to unavailable instead of throwing, so PRs never block tickets', async (t) => {
  for (const respond of [
    () => new Response(JSON.stringify({ code: 'SETUP_REQUIRED' }), { status: 409 }),
    () => new Response('bad gateway', { status: 502 }),
    () => new Response('not json', { status: 200 }),
    () => {
      throw new TypeError('network down');
    },
  ]) {
    t.mock.method(globalThis, 'fetch', async () => respond());
    assert.deepEqual(await api.getTicketPrs(), { available: false });
    t.mock.restoreAll();
  }
});

const jsonResponse = (payload, status = 200) => new Response(JSON.stringify(payload), { status });

test('getTeamVelocity requests one shared team snapshot without filtering parameters', async (t) => {
  const payload = {
    boards: [],
    keep: 8,
    coverage: { completeness: 'unknown', possibleTruncation: false, maxIssuesPerQuery: 5000 },
    updatedAt: '2026-11-09T12:00:00Z',
  };
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (...args) => {
    calls.push(args);
    return jsonResponse(payload);
  });
  assert.deepEqual(await api.getTeamVelocity(), payload);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/team-velocity');
  assert.ok(!calls[0][1]?.method || calls[0][1].method === 'GET');
});

test('getTeamVelocity rejects failures and notifies the existing setup listener', async (t) => {
  let notifications = 0;
  const unsubscribe = api.onSetupRequired(() => notifications++);
  t.after(unsubscribe);
  t.mock.method(globalThis, 'fetch', async () =>
    jsonResponse({ code: 'SETUP_REQUIRED', error: 'Finish setup' }, 409),
  );
  await assert.rejects(() => api.getTeamVelocity(), {
    message: 'Finish setup',
    code: 'SETUP_REQUIRED',
    status: 409,
  });
  assert.equal(notifications, 1);
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () =>
    jsonResponse({ error: 'Velocity unavailable' }, 502),
  );
  await assert.rejects(() => api.getTeamVelocity(), {
    message: 'Velocity unavailable',
    status: 502,
  });
  assert.equal(notifications, 1);
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('network down');
  });
  await assert.rejects(() => api.getTeamVelocity(), /network down/);
});

test('review API: existing launchClaude posts only key/action and preserves independent review entry', async (t) => {
  const calls = [];
  const ticket = {
    state: 'none',
    phase: null,
    review: { state: 'working', reason: 'running' },
    blocks: { review: 'session_running' },
  };
  t.mock.method(globalThis, 'fetch', async (...args) => {
    calls.push(args);
    return jsonResponse({ ok: true, key: 'DEMO-1', phase: 'pr-review-transact', ticket });
  });
  const result = await api.launchClaude('DEMO-1', 'pr-review-transact', 'client prompt override');
  assert.equal(calls.length, 1);
  const [url, options] = calls[0];
  assert.equal(url, '/api/claude/launch');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(options.body), { key: 'DEMO-1', phase: 'pr-review-transact' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ticket, ticket);
});

test('review API: refusal and network failure remain readable nonthrowing results', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    jsonResponse(
      { code: 'CLAUDE_REFUSED', error: 'Review state is unknown', errors: ['unrecognised_state'] },
      409,
    ),
  );
  const refusal = await api.launchClaude('DEMO-1', 'pr-review-transact');
  assert.equal(refusal.ok, false);
  assert.equal(refusal.status, 409);
  assert.equal(refusal.code, 'CLAUDE_REFUSED');
  assert.deepEqual(refusal.errors, ['unrecognised_state']);
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('network down');
  });
  const unreachable = await api.launchClaude('DEMO-1', 'pr-review-transact');
  assert.equal(unreachable.ok, false);
  assert.equal(unreachable.status, 0);
});

test('scenario 27: getClaudeTickets reads the status route and resolves its payload', async (t) => {
  const payload = { listing: 'ok', updatedAt: 1731100000000, tickets: {} };
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (...args) => {
    calls.push(args);
    return jsonResponse(payload);
  });
  const result = await api.getClaudeTickets();
  assert.equal(calls[0][0], '/api/claude/tickets');
  assert.ok(!calls[0][1]?.method || calls[0][1].method === 'GET');
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.listing, 'ok');
  assert.deepEqual(result.tickets, {});
});

test('scenario 23: launchClaude posts the key and phase only as JSON', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (...args) => {
    calls.push(args);
    return jsonResponse({ ok: true, key: 'TAP-1234', id: 'ab12cd34' });
  });
  // A third argument (the summary a caller once passed) is not sent.
  const result = await api.launchClaude('TAP-1234', 'investigate-and-plan', 'Fix the redirect');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/claude/launch');
  assert.equal(calls[0][1].method, 'POST');
  assert.equal(calls[0][1].headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    key: 'TAP-1234',
    phase: 'investigate-and-plan',
  });
  assert.equal(result.ok, true);
  assert.equal(result.id, 'ab12cd34');
});

test('scenario 24: launchClaude resolves a refusal with its code and reasons instead of throwing', async (t) => {
  const refusal = {
    code: 'CLAUDE_FAILED',
    error: 'CLAUDE FAILED',
    errors: ['untrusted_workspace'],
  };
  t.mock.method(globalThis, 'fetch', async () => jsonResponse(refusal, 502));
  const result = await api.launchClaude('TAP-1234', 'investigate-and-plan');
  assert.equal(result.ok, false);
  assert.equal(result.status, 502);
  assert.equal(result.code, 'CLAUDE_FAILED');
  assert.deepEqual(result.errors, ['untrusted_workspace']);
  t.mock.restoreAll();

  t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('network down');
  });
  const unreachable = await api.launchClaude('TAP-1234', 'implement-plan');
  assert.equal(unreachable.ok, false);
  assert.equal(unreachable.status, 0);
});

test('scenario 25: answerClaude posts the key and only the given answers as JSON', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (...args) => {
    calls.push(args);
    return jsonResponse({ ok: true, key: 'TAP-1234', ticket: {} });
  });
  const result = await api.answerClaude('TAP-1234', { q1: 'Portage-backend' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/claude/answers');
  assert.equal(calls[0][1].method, 'POST');
  assert.equal(calls[0][1].headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    key: 'TAP-1234',
    answers: { q1: 'Portage-backend' },
  });
  assert.equal(result.ok, true);
});

test('scenario 49: answerClaude passes the send outcome through with the saved ticket', async (t) => {
  const send = { status: 'failed', reason: 'resume_failed' };
  t.mock.method(globalThis, 'fetch', async () =>
    jsonResponse({ ok: true, key: 'TAP-1234', ticket: { unsent: true }, send }),
  );
  const result = await api.answerClaude('TAP-1234', { q1: 'Portage-backend' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.send, send);
  assert.deepEqual(result.ticket, { unsent: true });
});

test('scenario 49: answerClaude posts an empty answers array to retry a send', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (...args) => {
    calls.push(args);
    return jsonResponse({ ok: true, key: 'TAP-1234', ticket: {}, send: { status: 'sent' } });
  });
  const result = await api.answerClaude('TAP-1234', []);
  assert.equal(calls[0][0], '/api/claude/answers');
  assert.deepEqual(JSON.parse(calls[0][1].body), { key: 'TAP-1234', answers: [] });
  assert.deepEqual(result.send, { status: 'sent' });
});

test('answerClaude posts resend: true only when asked to, so the saved answers go again', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (...args) => {
    calls.push(args);
    return jsonResponse({ ok: true, key: 'TAP-1234', ticket: {}, send: { status: 'sent' } });
  });

  await api.answerClaude('TAP-1234', [], { resend: true });
  await api.answerClaude('TAP-1234', [], { resend: false });

  assert.equal(calls[0][0], '/api/claude/answers');
  assert.deepEqual(JSON.parse(calls[0][1].body), { key: 'TAP-1234', answers: [], resend: true });
  assert.deepEqual(JSON.parse(calls[1][1].body), { key: 'TAP-1234', answers: [] });
});

test('approveClaude posts only the ticket key and passes the send outcome through', async (t) => {
  const calls = [];
  const send = { status: 'failed', reason: 'live_at_resume' };
  t.mock.method(globalThis, 'fetch', async (...args) => {
    calls.push(args);
    return jsonResponse({ ok: true, key: 'TAP-1234', ticket: { flags: {} }, send });
  });

  const result = await api.approveClaude('TAP-1234');

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/claude/approve');
  assert.equal(calls[0][1].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0][1].body), { key: 'TAP-1234' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.send, send);
});

test('rereviewClaude posts only the ticket key and passes the send outcome through', async (t) => {
  const calls = [];
  const send = { status: 'failed', reason: 'resume_failed' };
  t.mock.method(globalThis, 'fetch', async (...args) => {
    calls.push(args);
    return jsonResponse({ ok: true, key: 'TAP-1234', ticket: { review: {} }, send });
  });

  const result = await api.rereviewClaude('TAP-1234');

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/claude/rereview');
  assert.equal(calls[0][1].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0][1].body), { key: 'TAP-1234' });
  assert.deepEqual(result.send, send);
});

test('continueClaude posts only the ticket key and passes the send outcome through', async (t) => {
  const calls = [];
  const send = { status: 'failed', reason: 'resume_failed' };
  t.mock.method(globalThis, 'fetch', async (...args) => {
    calls.push(args);
    return jsonResponse({ ok: true, key: 'TAP-1234', ticket: { state: 'working' }, send });
  });

  const result = await api.continueClaude('TAP-1234');

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/claude/continue');
  assert.equal(calls[0][1].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0][1].body), { key: 'TAP-1234' });
  assert.deepEqual(result.send, send);
});

test('getCheckoutMatches asks the matches route for one ticket key, encoded', async (t) => {
  const calls = [];
  const payload = {
    key: 'TAP-1',
    repos: [{ dir: 'Portage-backend', ids: ['be'], status: 'none' }],
  };
  t.mock.method(globalThis, 'fetch', async (...args) => {
    calls.push(args);
    return jsonResponse(payload);
  });

  assert.deepEqual(await api.getCheckoutMatches('TAP-1'), payload);
  await api.getCheckoutMatches('A B&c');

  assert.equal(calls[0][0], '/api/repos/checkout-matches?key=TAP-1');
  assert.equal(calls[1][0], '/api/repos/checkout-matches?key=A%20B%26c');
  assert.equal(calls[0][1]?.method ?? 'GET', 'GET');
});

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test('checkout 14: setCheckout PUTs JSON, returns the body and locks every id only during the call', async (t) => {
  const calls = [];
  const gate = deferred();
  const body = { ok: true, dir: 'my dir', checkout: '/r/x', checkoutLabel: 'x', restarted: ['a'] };
  t.mock.method(globalThis, 'fetch', async (...args) => {
    calls.push(args);
    await gate.promise;
    return new Response(JSON.stringify(body), { status: 200 });
  });
  const pending = api.setCheckout('my dir', '/r/x', { restart: true, ids: ['a', 'b'] });
  assert.equal(api.isControlPending('a'), true);
  assert.equal(api.isControlPending('b'), true);
  assert.equal(api.isControlPending('c'), false);
  gate.resolve();
  assert.deepEqual(await pending, body);
  assert.equal(api.isControlPending('a'), false);
  assert.equal(api.isControlPending('b'), false);
  assert.equal(calls[0][0], '/api/repos/my%20dir/checkout');
  assert.equal(calls[0][1].method, 'PUT');
  assert.equal(new Headers(calls[0][1].headers).get('content-type'), 'application/json');
  assert.deepEqual(JSON.parse(calls[0][1].body), { path: '/r/x', restart: true });
});

test('checkout 14: setCheckout throws the coded error and releases the ids', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(JSON.stringify({ code: 'CHECKOUT_IN_USE', error: 'CHECKOUT IN USE' }), {
        status: 409,
      }),
  );
  await assert.rejects(api.setCheckout('d', '/r/x', { restart: false, ids: ['a', 'b'] }), {
    code: 'CHECKOUT_IN_USE',
    status: 409,
    message: 'CHECKOUT IN USE',
  });
  assert.equal(api.isControlPending('a'), false);
  assert.equal(api.isControlPending('b'), false);
});

test('checkout 14: setCheckout refuses without a request while one of its ids is pending', async (t) => {
  const calls = [];
  const gate = deferred();
  t.mock.method(globalThis, 'fetch', async (...args) => {
    calls.push(args);
    await gate.promise;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  const start = control('a', 'start');
  await assert.rejects(api.setCheckout('d', '/r/x', { restart: false, ids: ['a', 'b'] }));
  assert.equal(calls.length, 1);
  assert.equal(api.isControlPending('b'), false);
  gate.resolve();
  await start;
});

test('checkout 14: getWorktrees asks the listing route of the encoded dir', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (...args) => {
    calls.push(args);
    return new Response(JSON.stringify({ dir: 'my dir', worktrees: [] }), { status: 200 });
  });
  await api.getWorktrees('my dir');
  assert.equal(calls[0][0], '/api/repos/my%20dir/worktrees');
  assert.ok(!calls[0][1]?.method || calls[0][1].method === 'GET');
});
