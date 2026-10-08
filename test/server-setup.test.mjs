import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { settingsFixture, githubToken, jiraToken, assertNoSecrets } from './settings-fixture.mjs';

test('production HTTP handler gates every operation, unlocks setup, closes revoked SSE and bounds sanitized writes', async (t) => {
  const f = settingsFixture(t);
  const store = await f.store();
  await store.initialize();
  const { createHttpHandler } = await import('../backend/http-app.mjs');
  const work = [];
  const spy =
    (name, result) =>
    (...args) => {
      work.push({ name, args });
      return result;
    };
  const manager = {
    list: spy('list', []),
    logs: spy('logs', ''),
    start: spy('start', { ok: true }),
    stop: spy('stop', { ok: true }),
    restart: spy('restart', { ok: true }),
    applySettings: spy('apply', undefined),
  };
  let serviceInUse = false;
  manager.applySettings = async (local) => {
    if (serviceInUse)
      throw Object.assign(new Error('Live service cannot change'), { code: 'SERVICE_IN_USE' });
    work.push({ name: 'apply', args: [local] });
  };
  const handler = createHttpHandler({
    settings: store,
    manager,
    integrations: {
      fetchOpenPRs: spy('prs', { prs: [], groups: {}, total: 0 }),
      fetchMyTickets: spy('tickets', { tickets: [], total: 0 }),
      fetchUatPromoteCandidates: spy('uat', { prs: [] }),
      fetchReviewData: spy('review', { available: true, reviews: {} }),
      fetchTicketStatuses: spy('statuses', {}),
      getOriginDiff: spy('diff', { diff: '' }),
      fetchRelease: spy('releases', {
        versions: [],
        version: null,
        scope: 'mine',
        total: 0,
        truncated: false,
        tickets: [],
      }),
    },
  });
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (pathname, method = 'GET', body) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        base + pathname,
        { method, headers: { 'content-type': 'application/json' } },
        (res) => {
          let text = '';
          res.on('data', (chunk) => {
            text += chunk;
          });
          res.on('end', () =>
            resolve({ status: res.statusCode, text, json: () => JSON.parse(text) }),
          );
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  const operations = [
    ['/api/services'],
    ['/api/events'],
    ['/api/logs/app'],
    ['/api/services/app/start', 'POST'],
    ['/api/services/app/stop', 'POST'],
    ['/api/services/app/restart', 'POST'],
    ['/api/prs'],
    ['/api/my-tickets'],
    ['/api/pr-diff?repo=ExampleOrg/app&number=1'],
    ['/api/releases'],
  ];
  for (const [pathname, method] of operations) {
    const response = await request(pathname, method);
    assert.equal(response.status, 409, pathname);
    assert.equal(response.json().code, 'SETUP_REQUIRED');
  }
  assert.deepEqual(work, []);
  for (const route of ['/api/config', '/api/settings'])
    assert.equal((await request(route)).status, 200, route);
  assert.equal((await request('/')).status, 200);
  assert.equal((await request('/api/settings', 'PUT', '{bad')).status, 400);
  assert.equal(
    (await request('/api/settings', 'PUT', JSON.stringify({ value: 'x'.repeat(65537) }))).status,
    413,
  );
  const saved = await request(
    '/api/settings',
    'PUT',
    JSON.stringify({
      ...f.configuration,
      expectedRevision: store.getSetupStatus().revision,
      credentials: { githubToken, jiraToken },
    }),
  );
  assert.equal(saved.status, 200);
  assertNoSecrets(saved.text);
  assert.equal((await request('/api/config')).json().setup.ready, true);
  assert.equal((await request('/api/services')).status, 200);
  assert.ok(work.some(({ name }) => name === 'list'));
  const stale = await request(
    '/api/settings',
    'PUT',
    JSON.stringify({ ...f.configuration, expectedRevision: -1 }),
  );
  assert.equal(stale.status, 409);
  assert.equal(stale.json().code, 'REVISION_CONFLICT');
  serviceInUse = true;
  const beforeConflict = store.getSetupStatus().revision;
  const conflict = await request(
    '/api/settings',
    'PUT',
    JSON.stringify({
      ...f.configuration,
      local: {
        ...f.configuration.local,
        services: [{ ...f.configuration.local.services[0], label: 'Changed live label' }],
      },
      expectedRevision: beforeConflict,
    }),
  );
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json().code, 'SERVICE_IN_USE');
  assert.equal(
    store.getSetupStatus().revision,
    beforeConflict,
    'conflict must precede persistence',
  );
  assert.equal(store.getPublicSettings().local.services[0].label, 'Application');
  serviceInUse = false;
  for (const section of ['github', 'jira', 'local']) {
    const candidate = { ...f.configuration, expectedRevision: store.getSetupStatus().revision };
    if (section === 'github') candidate.github = { ...candidate.github, repos: [] };
    if (section === 'jira') candidate.jira = { ...candidate.jira, email: '' };
    if (section === 'local') candidate.local = { ...candidate.local, services: [] };
    const invalid = await request('/api/settings', 'PUT', JSON.stringify(candidate));
    assert.equal(invalid.status, 422, section);
    assertNoSecrets(invalid.text);
    assert.equal(
      (await request('/api/config')).json().setup.ready,
      true,
      'invalid ready edits preserve gate',
    );
  }
  let streamText = '';
  let endStream;
  const ended = new Promise((resolve) => {
    endStream = resolve;
  });
  const stream = http.get(base + '/api/events');
  await new Promise((resolve, reject) => {
    stream.on('response', (res) => {
      res.on('data', (chunk) => {
        streamText += chunk;
        resolve();
      });
      res.on('end', endStream);
    });
    stream.on('error', reject);
  });
  t.after(() => stream.destroy());
  f.network.status = 401;
  const validation = await request('/api/settings/validate', 'POST', '{}');
  assertNoSecrets(validation.text);
  await Promise.race([
    ended,
    new Promise((_, reject) => {
      const timeout = setTimeout(() => reject(new Error('revoked SSE was not closed')), 1000);
      timeout.unref();
    }),
  ]);
  assert.match(streamText, /SETUP_REQUIRED|setup-required/);
  const before = work.length;
  for (const [pathname, method] of operations)
    assert.equal((await request(pathname, method)).status, 409);
  assert.equal(work.length, before, 'revocation blocks before collaborators');
  assert.equal(
    work.some(({ name }) => ['start', 'stop', 'restart'].includes(name)),
    false,
  );
});
