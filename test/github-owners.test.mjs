import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPrOwners } from '../backend/github.mjs';
import { settingsFixture, accept, githubToken } from './settings-fixture.mjs';

const prs = Array.from({ length: 51 }, (_, index) => ({
  repo: index === 0 ? 'Org"\\name/app"\\repo' : 'ExampleOrg/app',
  number: index + 1,
}));

function ownerPage(length, start = 1) {
  return Response.json({
    data: Object.fromEntries(
      Array.from({ length }, (_, index) => [
        `a${index}`,
        { pullRequest: { author: { login: `owner-${start + index}` } } },
      ]),
    ),
  });
}

test('owner lookup keeps captured GraphQL transport, escaping, order and batch-local aliases', async (t) => {
  const f = settingsFixture(t, { env: { GH_TOKEN: 'synthetic-unused-env-token' } });
  const settings = await f.store();
  await accept(f, settings);
  const snapshot = settings.getSnapshot();
  const requests = [];
  const timeouts = [];
  const timeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', (milliseconds) => {
    timeouts.push(milliseconds);
    return timeout(milliseconds);
  });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, init });
    return requests.length === 1 ? ownerPage(50) : ownerPage(1, 51);
  });
  const owners = await fetchPrOwners(
    [null, { repo: 'invalid', number: 1 }, { repo: 'ExampleOrg/app', number: 0 }, ...prs, prs[0]],
    { snapshot },
  );
  assert.equal(requests.length, 2, '51 distinct valid PRs require exactly two requests');
  assert.deepEqual(timeouts, [15000, 15000]);
  for (const { url, init } of requests) {
    assert.equal(url, 'https://api.github.com/graphql');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.deepEqual(init.headers, {
      Authorization: `Bearer ${githubToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json',
      'User-Agent': 'dev-dashboard',
    });
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    assert.deepEqual(Object.keys(JSON.parse(init.body)), ['query']);
  }
  const first = JSON.parse(requests[0].init.body).query;
  assert.ok(
    first.startsWith(
      'query {\na0: repository(owner: "Org\\"\\\\name", name: "app\\"\\\\repo") {\n' +
        'pullRequest(number: 1) { author { login } }\n}\n',
    ),
    'repository quotes and backslashes remain GraphQL string escapes',
  );
  assert.deepEqual(
    [...first.matchAll(/a(\d+): repository/g)].map((match) => Number(match[1])),
    Array.from({ length: 50 }, (_, index) => index),
  );
  assert.deepEqual(
    [...first.matchAll(/pullRequest\(number: (\d+)\)/g)].map((match) => Number(match[1])),
    Array.from({ length: 50 }, (_, index) => index + 1),
  );
  assert.equal(
    JSON.parse(requests[1].init.body).query,
    'query {\na0: repository(owner: "ExampleOrg", name: "app") {\n' +
      'pullRequest(number: 51) { author { login } }\n}\n}',
  );
  assert.deepEqual(
    owners,
    Object.fromEntries(prs.map((pr, index) => [`${pr.repo}#${pr.number}`, `owner-${index + 1}`])),
  );
});

for (const failure of ['HTTP', 'GraphQL', 'fetch', 'JSON']) {
  test(`owner lookup later ${failure} failure preserves its existing catch boundary`, async (t) => {
    const f = settingsFixture(t);
    const settings = await f.store();
    await accept(f, settings);
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      if (++calls === 1) return ownerPage(50);
      if (failure === 'HTTP') return new Response('unavailable', { status: 503 });
      if (failure === 'GraphQL')
        return Response.json({ data: {}, errors: [{ message: 'denied' }] });
      if (failure === 'fetch') throw new Error('synthetic fetch failure');
      return new Response('{malformed');
    });
    const owners = await fetchPrOwners(prs, { snapshot: settings.getSnapshot() });
    assert.equal(calls, 2);
    assert.deepEqual(
      owners,
      failure === 'HTTP' || failure === 'GraphQL'
        ? Object.fromEntries(
            prs.slice(0, 50).map((pr, index) => [`${pr.repo}#${pr.number}`, `owner-${index + 1}`]),
          )
        : {},
    );
  });
}
