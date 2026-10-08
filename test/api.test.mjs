import { test } from 'node:test';
import assert from 'node:assert/strict';
import { control, getLog } from '../ui-react/lib/api.js';

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
