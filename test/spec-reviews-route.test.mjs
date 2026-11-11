// spec-reviews-route.test.mjs — GET /api/spec-reviews on the production HTTP handler: the field
// whitelist and the same-origin guard. The feed integration is a local double.
import test from 'node:test';
import assert from 'node:assert/strict';
import { listenHttp, requestRaw } from './http-test-fixture.mjs';
import { createHttpHandler } from '../backend/http-app.mjs';
import { settingsFixture, accept, assertNoSecrets, githubToken } from './settings-fixture.mjs';

const SPEC = {
  number: 321,
  title: '[TAP-100] Trip export spec',
  url: 'https://github.com/TransActComm/ezat-specs/pull/321',
  author: 'alice',
  draft: false,
  keys: ['TAP-100'],
  ageDays: 3,
  reviewsByOthers: 2,
  review: 'current',
};
const PAYLOAD = {
  available: true,
  total: 1,
  specs: [SPEC],
  updatedAt: '2026-11-11T12:00:00.000Z',
};

async function endpoint(t, { result = PAYLOAD } = {}) {
  t.mock.method(globalThis, 'fetch', async () =>
    assert.fail('route tests must never contact an upstream'),
  );
  const fixture = settingsFixture(t);
  const settings = await fixture.store();
  await accept(fixture, settings);
  const calls = [];
  const handler = createHttpHandler({
    settings,
    manager: { list: () => [], applySettings() {} },
    integrations: {
      fetchSpecReviews: async (...args) => {
        calls.push(args);
        return structuredClone(result);
      },
    },
  });
  const { origin } = await listenHttp(t, handler);
  const request = async ({ headers = {} } = {}) => {
    const response = await requestRaw(origin, '/api/spec-reviews', {
      headers,
      timeout: 2000,
      timeoutMessage: 'synthetic route request timed out',
    });
    let json = null;
    try {
      json = JSON.parse(response.text);
    } catch {}
    return { ...response, json };
  };
  return { request, calls };
}

test('8. the route serves the whitelisted feed', async (t) => {
  const privateFields = { credentials: { githubToken }, raw: githubToken };
  const result = {
    ...PAYLOAD,
    ...privateFields,
    specs: [{ ...SPEC, ...privateFields, body: 'unlisted field' }],
  };
  const { request, calls } = await endpoint(t, { result });
  const response = await request();
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.json).sort(), ['available', 'specs', 'total', 'updatedAt']);
  assert.equal(response.json.available, true);
  assert.equal(response.json.total, 1);
  assert.deepEqual(response.json.specs, [SPEC]);
  assert.deepEqual(Object.keys(response.json.specs[0]).sort(), Object.keys(SPEC).sort());
  assert.ok(Number.isFinite(Date.parse(response.json.updatedAt)));
  assertNoSecrets(response.text);
  assert.equal(calls.length, 1);
  assert.ok(Object.isFrozen(calls[0][0].snapshot), 'one frozen settings snapshot enters the feed');
});

test('17. the route refuses cross-site reads before the feed runs', async (t) => {
  const { request, calls } = await endpoint(t);
  const response = await request({ headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(response.status, 403);
  // The shared catch sanitizes the guard's internal code, as for every sibling expensive read.
  assert.equal(response.json.code, 'OPERATION_FAILED');
  assert.equal('specs' in response.json, false, 'no spec data is returned');
  assert.deepEqual(calls, []);
});

for (const state of ['none', 'current', 'stale']) {
  test(`20. the route serves review ${state} and no login or commit oid`, async (t) => {
    const leaks = {
      viewer: { login: 'viewer-login-secret' },
      viewerLogin: 'viewer-login-secret',
      headRefOid: 'oid-secret-0123',
      commit: { oid: 'oid-secret-0123' },
    };
    const result = {
      ...PAYLOAD,
      ...leaks,
      specs: [{ ...SPEC, review: state, ...leaks }],
    };
    const { request } = await endpoint(t, { result });
    const response = await request();
    assert.equal(response.status, 200);
    assert.equal(response.json.specs[0].review, state);
    assert.deepEqual(Object.keys(response.json.specs[0]).sort(), Object.keys(SPEC).sort());
    assert.deepEqual(Object.keys(response.json).sort(), [
      'available',
      'specs',
      'total',
      'updatedAt',
    ]);
    assert.ok(!response.text.includes('viewer-login-secret'), 'no login in the response');
    assert.ok(!response.text.includes('oid-secret-0123'), 'no commit oid in the response');
  });
}
