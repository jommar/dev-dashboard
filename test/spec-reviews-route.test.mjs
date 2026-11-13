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
  reviewRequested: true,
};
const PAYLOAD = {
  available: true,
  total: 1,
  specs: [SPEC],
  hasMore: true,
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
  const request = async ({ headers = {}, query = '' } = {}) => {
    const response = await requestRaw(origin, `/api/spec-reviews${query}`, {
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
    issueCount: 999,
    cursor: 'private-cursor',
    specs: [{ ...SPEC, ...privateFields, body: 'unlisted field', createdAt: 'private-created-at' }],
  };
  const { request, calls } = await endpoint(t, { result });
  const response = await request();
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.json).sort(), [
    'available',
    'hasMore',
    'specs',
    'total',
    'updatedAt',
  ]);
  assert.equal(response.json.available, true);
  assert.equal(response.json.total, 1);
  assert.equal(response.json.hasMore, true);
  assert.deepEqual(response.json.specs, [SPEC]);
  assert.deepEqual(Object.keys(response.json.specs[0]).sort(), Object.keys(SPEC).sort());
  assert.ok(Number.isFinite(Date.parse(response.json.updatedAt)));
  assertNoSecrets(response.text);
  assert.equal(calls.length, 1);
  assert.ok(Object.isFrozen(calls[0][0].snapshot), 'one frozen settings snapshot enters the feed');
  assert.equal(calls[0][0].limit, 3);
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
      'hasMore',
      'specs',
      'total',
      'updatedAt',
    ]);
    assert.ok(!response.text.includes('viewer-login-secret'), 'no login in the response');
    assert.ok(!response.text.includes('oid-secret-0123'), 'no commit oid in the response');
  });
}

test('paging: bounded counts and sanitized pagination pass through while invalid and foreign-site reads stop before integration', async (t) => {
  await t.test('default and bounded counts reach one frozen-snapshot integration', async (t) => {
    const { request, calls } = await endpoint(t);
    for (const [query, expected] of [
      ['', 3],
      ['?limit=3', 3],
      ['?limit=6', 6],
      ['?limit=1000', 1000],
    ]) {
      const response = await request({ query });
      assert.equal(response.status, 200);
      assert.equal(calls.at(-1)[0].limit, expected);
      assert.ok(Object.isFrozen(calls.at(-1)[0].snapshot));
      assert.deepEqual(response.json, PAYLOAD);
    }
    assert.equal(calls.length, 4, 'one integration per accepted request');
  });
  await t.test('invalid and repeated counts never invoke integration', async (t) => {
    const { request, calls } = await endpoint(t);
    for (const query of [
      '?limit=',
      '?limit=3&limit=6',
      '?limit=03',
      '?limit=%2B3',
      '?limit=-3',
      '?limit=3.0',
      '?limit=3e0',
      '?limit=%203%20',
      '?limit=0',
      '?limit=1001',
      '?limit=nope',
    ]) {
      const response = await request({ query });
      assert.equal(response.status, 400, query);
      assert.equal(response.json.code, 'INVALID_SPEC_LIMIT', query);
      assert.equal('specs' in response.json, false);
    }
    assert.deepEqual(calls, []);
  });
  await t.test('foreign-site guard precedes invalid count parsing', async (t) => {
    const { request, calls } = await endpoint(t);
    for (const site of ['same-site', 'cross-site']) {
      const response = await request({ query: '?limit=bad', headers: { 'sec-fetch-site': site } });
      assert.equal(response.status, 403, 'origin guard precedes count parsing');
      assert.equal(response.json.code, 'OPERATION_FAILED');
    }
    assert.deepEqual(calls, []);
  });

  for (const reason of ['search_limit', 'private-upstream-error']) {
    await t.test(`unavailable reason ${reason}`, async (t) => {
      const unavailable = { ...PAYLOAD, available: false, total: 0, specs: [], hasMore: false };
      const endpointFixture = await endpoint(t, {
        result: { ...unavailable, reason, viewerLogin: 'viewer-secret', issueCount: 1001 },
      });
      const response = await endpointFixture.request();
      assert.equal(response.status, 200);
      assert.deepEqual(response.json, {
        ...unavailable,
        ...(reason === 'search_limit' ? { reason } : {}),
      });
    });
  }
});

for (const reviewRequested of [true, false]) {
  test(`the route whitelists reviewRequested ${reviewRequested} without request identities`, async (t) => {
    const leaks = {
      viewer: { login: 'viewer-login-secret' },
      viewerLogin: 'viewer-login-secret',
      reviewRequests: {
        nodes: [{ requestedReviewer: { __typename: 'User', login: 'reviewer-login-secret' } }],
      },
      requestedReviewers: ['reviewer-login-secret'],
    };
    const result = {
      ...PAYLOAD,
      ...leaks,
      specs: [{ ...SPEC, reviewRequested, ...leaks }],
    };
    const { request } = await endpoint(t, { result });
    const response = await request();
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { ...PAYLOAD, specs: [{ ...SPEC, reviewRequested }] });
    assert.ok(!response.text.includes('viewer-login-secret'), 'no viewer login in the response');
    assert.ok(
      !response.text.includes('reviewer-login-secret'),
      'no request identity in the response',
    );
  });
}
