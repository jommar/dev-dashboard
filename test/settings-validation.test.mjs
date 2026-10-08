import test from 'node:test';
import assert from 'node:assert/strict';
import {
  settingsFixture,
  accept,
  githubToken,
  jiraToken,
  probeResponse,
} from './settings-fixture.mjs';

test('all integration scopes and local fields are required, accepted revisions survive outages, definitive failures revoke', async (t) => {
  for (const failure of [401, 404, 403, 429, 500, 'offline']) {
    const f = settingsFixture(t);
    f.network.route = async (url, init) => {
      if (url.pathname === '/user') {
        if (failure === 'offline') throw new TypeError('synthetic offline');
        return Response.json({ message: 'Synthetic failure' }, { status: failure });
      }
      return probeResponse(url, init);
    };
    const store = await f.store();
    await store.initialize();
    await assert.rejects(
      store.save({
        ...f.configuration,
        expectedRevision: store.getSetupStatus().revision,
        credentials: { githubToken, jiraToken },
      }),
    );
    assert.equal(store.getSetupStatus().ready, false, `first acceptance ${failure}`);
  }
  for (const endpoint of [
    '/repos/ExampleOrg/app',
    '/graphql',
    '/rest/api/3/myself',
    '/rest/api/3/search/jql',
    '/rest/api/3/field',
  ]) {
    const f = settingsFixture(t);
    f.network.route = (url, init) =>
      url.pathname === endpoint
        ? Response.json({ message: 'Synthetic forbidden' }, { status: 401 })
        : probeResponse(url, init);
    const store = await f.store();
    await store.initialize();
    await assert.rejects(
      store.save({
        ...f.configuration,
        expectedRevision: store.getSetupStatus().revision,
        credentials: { githubToken, jiraToken },
      }),
    );
    assert.equal(store.getSetupStatus().ready, false, endpoint);
  }
  for (const invalidRuntime of ['unreadable-root', 'invalid-pin', 'missing-node', 'missing-npm']) {
    const invalid = settingsFixture(t);
    invalid.dependencies.runtimeInspector = async () => ({
      ok: false,
      errors: [
        { field: 'local.services.0.command', code: 'INVALID_RUNTIME', message: invalidRuntime },
      ],
    });
    const invalidStore = await invalid.store();
    await invalidStore.initialize();
    await assert.rejects(
      invalidStore.save({
        ...invalid.configuration,
        expectedRevision: invalidStore.getSetupStatus().revision,
        credentials: { githubToken, jiraToken },
      }),
    );
    assert.equal(invalidStore.getSetupStatus().ready, false);
    assert.equal(invalid.calls.length, 0, 'local failures precede network validation');
  }
  const missingFields = settingsFixture(t);
  missingFields.network.route = (url, init) =>
    url.pathname === '/rest/api/3/field' ? Response.json([]) : probeResponse(url, init);
  const missingFieldsStore = await missingFields.store();
  await missingFieldsStore.initialize();
  await assert.rejects(
    missingFieldsStore.save({
      ...missingFields.configuration,
      expectedRevision: missingFieldsStore.getSetupStatus().revision,
      credentials: { githubToken, jiraToken },
    }),
  );
  assert.equal(
    missingFieldsStore.getSetupStatus().ready,
    false,
    '200 metadata without configured field IDs is not acceptance',
  );
  const f = settingsFixture(t);
  const store = await f.store();
  await accept(f, store);
  assert.deepEqual(
    new Set(f.calls.map(({ url }) => url.pathname)),
    new Set([
      '/user',
      '/repos/ExampleOrg/app',
      '/graphql',
      '/rest/api/3/myself',
      '/rest/api/3/search/jql',
      '/rest/api/3/field',
    ]),
  );
  for (const { init } of f.calls) {
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal, 'each probe has a deadline');
    assert.ok(init.headers.Authorization || init.headers.authorization);
  }
  assert.ok(f.runtimeCalls.length > 0);
  f.calls.length = 0;
  await store.save({
    ...f.configuration,
    minPrApprover: 4,
    expectedRevision: store.getSetupStatus().revision,
  });
  assert.equal(f.calls.length, 0, 'approval-only changes reuse acceptance');
  for (const failure of [429, 500, 'offline', 'rate-limit', 'ambiguous']) {
    f.network.route = async (url, init) => {
      if (url.pathname !== '/user') return probeResponse(url, init);
      if (failure === 'offline') throw new TypeError('synthetic offline');
      return Response.json(
        { message: 'Synthetic outage' },
        {
          status: typeof failure === 'number' ? failure : 403,
          headers: failure === 'rate-limit' ? { 'x-ratelimit-remaining': '0' } : {},
        },
      );
    };
    await store.validate();
    assert.equal(store.getSetupStatus().ready, true);
    assert.match(JSON.stringify(store.getSetupStatus().connection), /degraded|unknown|unavailable/);
    const restart = await f.store();
    await restart.initialize();
    assert.equal(restart.getSetupStatus().ready, true);
  }
  f.network.route = null;
  const unchangedCalls = f.calls.length;
  await store.save({
    ...f.configuration,
    local: {
      ...f.configuration.local,
      services: [{ ...f.configuration.local.services[0], label: 'Local-only change' }],
    },
    expectedRevision: store.getSetupStatus().revision,
  });
  assert.equal(
    f.calls.length,
    unchangedCalls,
    'local-only changes reuse unchanged integration acceptance',
  );
  for (const change of [
    { github: { ...f.configuration.github, repos: [] } },
    {
      jira: {
        ...f.configuration.jira,
        baseUrl: 'https://user:password@jira.example.invalid?q=1#part',
      },
    },
    { jira: { ...f.configuration.jira, email: 'invalid', pointsField: 'wrong' } },
    { local: { ...f.configuration.local, services: [] } },
    { local: { ...f.configuration.local, root: 'relative' } },
    {
      local: {
        ...f.configuration.local,
        services: [{ ...f.configuration.local.services[0], id: '__proto__' }],
      },
    },
    {
      local: {
        ...f.configuration.local,
        services: [{ ...f.configuration.local.services[0], command: [], port: 65536 }],
      },
    },
    {
      local: {
        ...f.configuration.local,
        services: [
          { ...f.configuration.local.services[0], port: 1234 },
          { ...f.configuration.local.services[0], id: 'second', port: 1234 },
        ],
      },
    },
    { minPrApprover: 0 },
  ]) {
    const revision = store.getSetupStatus().revision;
    await assert.rejects(store.save({ ...f.configuration, ...change, expectedRevision: revision }));
    assert.equal(store.getSetupStatus().revision, revision);
    assert.equal(
      store.getSetupStatus().ready,
      true,
      'invalid ready edits preserve active revision',
    );
  }
  f.network.status = 401;
  await store.validate();
  assert.equal(store.getSetupStatus().ready, false);
  const restart = await f.store();
  await restart.initialize();
  assert.equal(restart.getSetupStatus().ready, false, 'revocation survives restart');
});
