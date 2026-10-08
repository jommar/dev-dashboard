import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { parseLines } from '../log-lines.mjs';

test('missing line counts use the supplied default', () => {
  assert.equal(parseLines(null, 120), 120);
  assert.equal(parseLines(undefined, 80), 80);
});

test('positive integer line counts request that tail size', () => {
  for (const [raw, expected] of [
    ['1', 1],
    ['250', 250],
    ['0012', 12],
    [' 20 ', 20],
  ]) {
    assert.equal(parseLines(raw, 120), expected);
  }
});

test('zero requests all retained logs rather than the default tail', () => {
  assert.equal(parseLines('0', 120), 0);
});

test('invalid and negative line counts cannot escape the default', () => {
  for (const raw of [
    '',
    ' ',
    'nope',
    'NaN',
    'Infinity',
    '-Infinity',
    '-1',
    '-0.5',
    '-0',
    '1.5',
    '0.5',
    '12oops',
    '0oops',
    '1e3',
    '0x10',
    '+1',
    '9007199254740992',
    '9'.repeat(400),
  ]) {
    assert.equal(parseLines(raw, 120), 120, `lines=${JSON.stringify(raw)}`);
  }
});

test('HTTP log route honors configured default, explicit zero and positive tails through the production handler', async (t) => {
  const { createHttpHandler } = await import('../http-app.mjs');
  const calls = [];
  const retained = Array.from({ length: 45 }, (_, index) => `line ${index + 1}`).join('\n');
  const settings = {
    getSetupStatus: () => ({ ready: true }),
    getSnapshot: () => ({}),
    getPublicSettings: () => ({ jira: { baseUrl: '' } }),
  };
  const manager = {
    logs(id, lines) {
      calls.push({ id, lines });
      return lines === 0 ? retained : retained.split('\n').slice(-lines).join('\n');
    },
  };
  const server = http.createServer(createHttpHandler({ settings, manager }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const get = (pathname) =>
    new Promise((resolve, reject) => {
      http
        .get({ hostname: '127.0.0.1', port: server.address().port, path: pathname }, (response) => {
          let text = '';
          response.on('data', (chunk) => {
            text += chunk;
          });
          response.on('end', () => resolve({ status: response.statusCode, text }));
        })
        .on('error', reject);
    });
  assert.equal(JSON.parse((await get('/api/config')).text).defaultTailLines, 40);
  for (const [query, lines, first, count] of [
    ['', 40, 'line 6', 40],
    ['?lines=invalid', 40, 'line 6', 40],
    ['?lines=-1', 40, 'line 6', 40],
    ['?lines=0', 0, 'line 1', 45],
    ['?lines=00', 0, 'line 1', 45],
    ['?lines=2', 2, 'line 44', 2],
  ]) {
    const response = await get('/api/logs/app' + query);
    assert.equal(response.status, 200);
    assert.deepEqual(calls.at(-1), { id: 'app', lines });
    assert.equal(response.text.split('\n')[0], first);
    assert.equal(response.text.split('\n').length, count);
    assert.equal(response.text.split('\n').at(-1), 'line 45');
  }
});
