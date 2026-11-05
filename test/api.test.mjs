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
