// ticket-specs-route.test.mjs — GET /api/ticket-specs on the production HTTP handler: the setup
// gate, the field whitelist and the same-origin guard. The scan is a local double.
import test from 'node:test';
import assert from 'node:assert/strict';
import { listenHttp, requestRaw } from './http-test-fixture.mjs';
import { createHttpHandler } from '../backend/http-app.mjs';
import { settingsFixture, accept, assertNoSecrets, githubToken } from './settings-fixture.mjs';

const BY_TICKET = {
  'TAP-1': { number: 7, url: 'https://github.com/TransActComm/ezat-specs/pull/7', state: 'OPEN' },
};

async function endpoint(t, { ready = true } = {}) {
  const fixture = settingsFixture(t);
  const settings = await fixture.store();
  if (ready) await accept(fixture, settings);
  else await settings.initialize();
  const calls = [];
  const handler = createHttpHandler({
    settings,
    manager: { list: () => [], applySettings() {} },
    integrations: {
      fetchTicketSpecs: async (...args) => {
        calls.push(args);
        // Whatever else the scan hands back must not reach the wire.
        return { available: true, byTicket: BY_TICKET, credentials: { githubToken } };
      },
    },
  });
  const { origin } = await listenHttp(t, handler);
  const request = async (headers = {}) => {
    const response = await requestRaw(origin, '/api/ticket-specs', {
      headers,
      timeout: 2000,
      timeoutMessage: 'ticket-specs request timed out',
    });
    return { ...response, json: JSON.parse(response.text) };
  };
  return { request, calls };
}

test('GET /api/ticket-specs is behind the setup gate and never reaches the scan', async (t) => {
  const { request, calls } = await endpoint(t, { ready: false });
  const response = await request();
  assert.equal(response.status, 409);
  assert.equal(response.json.code, 'SETUP_REQUIRED');
  assert.deepEqual(calls, []);
});

test('GET /api/ticket-specs answers 200 with available, byTicket and updatedAt only', async (t) => {
  const { request, calls } = await endpoint(t);
  const response = await request();
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.json).sort(), ['available', 'byTicket', 'updatedAt']);
  assert.deepEqual(response.json.byTicket, BY_TICKET);
  assert.ok(Number.isFinite(Date.parse(response.json.updatedAt)));
  assertNoSecrets(response.text);
  assert.equal(calls.length, 1);
  assert.ok(Object.isFrozen(calls[0][0].snapshot), 'one frozen settings snapshot enters the scan');
});

test('GET /api/ticket-specs refuses a cross-site read before the scan runs', async (t) => {
  const { request, calls } = await endpoint(t);
  const response = await request({ 'sec-fetch-site': 'cross-site' });
  assert.equal(response.status, 403);
  assert.equal('byTicket' in response.json, false, 'no spec data is returned');
  assert.deepEqual(calls, []);
});
