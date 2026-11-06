import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHttpHandler } from '../backend/http-app.mjs';
import { settingsFixture, accept, githubToken } from './settings-fixture.mjs';

const PR = {
  repo: 'ExampleOrg/app',
  number: 7,
  title: '[TAP-1] Board card data',
  url: 'https://github.com/ExampleOrg/app/pull/7',
  draft: false,
  updatedAt: '2026-10-06T12:00:00Z',
  review: { state: 'awaiting', approvals: 0 },
  ci: { state: 'passing', passed: 3, failed: 0, pending: 0, failing: [] },
};
const PAYLOAD = {
  available: true,
  login: 'qa',
  total: 1,
  truncated: false,
  byTicket: { 'TAP-1': [PR] },
};
const CONTRACT_KEYS = ['available', 'byTicket', 'login', 'total', 'truncated', 'updatedAt'];

async function ticketPrsEndpoint(t, { ready, result }) {
  const f = settingsFixture(t);
  const settings = await f.store();
  if (ready) await accept(f, settings);
  else await settings.initialize();
  const calls = [];
  const handler = createHttpHandler({
    settings,
    manager: { list: () => [], applySettings() {} },
    integrations: {
      fetchTicketPrs: async (...args) => {
        calls.push(args);
        return structuredClone(result);
      },
    },
  });
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    handler.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const request = (headers = {}, pathname = '/api/ticket-prs') =>
    new Promise((resolve, reject) => {
      const req = http.get(
        `http://127.0.0.1:${server.address().port}${pathname}`,
        { headers },
        (res) => {
          let text = '';
          res.on('data', (chunk) => {
            text += chunk;
          });
          res.on('end', () => {
            try {
              resolve({
                status: res.statusCode,
                headers: res.headers,
                text,
                json: JSON.parse(text),
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.setTimeout(2000, () => req.destroy(new Error('ticket-prs request timed out')));
      req.on('error', reject);
    });
  return { request, calls };
}

test('GET /api/ticket-prs is behind the setup gate and never reaches the integration', async (t) => {
  const { request, calls } = await ticketPrsEndpoint(t, { ready: false, result: PAYLOAD });
  const response = await request();
  assert.equal(response.status, 409);
  assert.equal(response.json.code, 'SETUP_REQUIRED');
  assert.deepEqual(calls, []);
});

test('GET /api/ticket-prs answers 200 with the integration payload and updatedAt only', async (t) => {
  const { request, calls } = await ticketPrsEndpoint(t, {
    ready: true,
    // Whatever else an integration hands back must not reach the wire.
    result: {
      ...PAYLOAD,
      snapshot: { credentials: { githubToken } },
      credentials: { githubToken },
      error: 'upstream error text',
    },
  });
  const response = await request();
  assert.equal(response.status, 200);
  assert.match(String(response.headers['cache-control']), /no-store/);
  assert.deepEqual(Object.keys(response.json).sort(), CONTRACT_KEYS);
  assert.deepEqual(response.json.byTicket, PAYLOAD.byTicket);
  for (const key of ['available', 'login', 'total', 'truncated']) {
    assert.equal(response.json[key], PAYLOAD[key], key);
  }
  assert.ok(Number.isFinite(Date.parse(response.json.updatedAt)), 'updatedAt is a timestamp');
  assert.ok(!response.text.includes(githubToken), 'no token on the wire');
  assert.ok(!response.text.includes('upstream error text'), 'no upstream error text');

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0][0]?.snapshot?.credentials?.githubToken,
    githubToken,
    'the integration reads the saved settings snapshot',
  );
});

test('a degraded integration result is still a 200 the board can render', async (t) => {
  const degraded = { available: false, login: null, total: 0, truncated: false, byTicket: {} };
  const { request } = await ticketPrsEndpoint(t, { ready: true, result: degraded });
  const response = await request();
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.json).sort(), CONTRACT_KEYS);
  assert.equal(response.json.available, false);
  assert.deepEqual(response.json.byTicket, {});
});

test('GET /api/ticket-prs refuses a cross-site or same-site browser request with 403 before any GitHub call', async (t) => {
  const github = [];
  t.mock.method(globalThis, 'fetch', async (...args) => {
    github.push(args);
    return new Response('{}');
  });
  const { request, calls } = await ticketPrsEndpoint(t, { ready: true, result: PAYLOAD });
  for (const site of ['cross-site', 'same-site']) {
    const response = await request({ 'sec-fetch-site': site });
    assert.equal(response.status, 403, site);
    assert.deepEqual(Object.keys(response.json).sort(), ['code', 'error', 'errors'], site);
    assert.ok(!response.text.includes('TAP-1'), `${site}: no ticket data in the refusal`);
  }
  assert.deepEqual(calls, [], 'the integration is never reached');
  assert.deepEqual(github, [], 'nothing is sent to GitHub');

  const config = await request({ 'sec-fetch-site': 'cross-site' }, '/api/config');
  assert.equal(config.status, 200, 'the refusal is for this one route');
});

test('GET /api/ticket-prs still answers a same-origin request, a typed address and a client with no Sec-Fetch-Site', async (t) => {
  const { request, calls } = await ticketPrsEndpoint(t, { ready: true, result: PAYLOAD });
  const cases = [{ 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-site': 'none' }, {}];
  for (const headers of cases) {
    const response = await request(headers);
    assert.equal(response.status, 200, JSON.stringify(headers));
    assert.deepEqual(response.json.byTicket, PAYLOAD.byTicket, JSON.stringify(headers));
  }
  assert.equal(calls.length, cases.length, 'each one reaches the integration');
});
