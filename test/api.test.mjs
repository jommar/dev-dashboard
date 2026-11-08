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
