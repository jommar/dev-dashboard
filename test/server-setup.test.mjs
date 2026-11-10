import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listenHttp, requestRaw } from './http-test-fixture.mjs';
import { acquireDistTestLock } from './dist-test-lock.mjs';
import { settingsFixture, githubToken, jiraToken, assertNoSecrets } from './settings-fixture.mjs';

const setupPage = '<!doctype html><main id="setup-ui-contract">setup dashboard</main>';

async function setupIndex(t, dist) {
  const releaseDistLock = await acquireDistTestLock();
  const index = path.join(dist, 'index.html');
  let hadDist;
  let original;
  try {
    hadDist = fs.existsSync(dist);
    original = fs.existsSync(index) ? fs.readFileSync(index) : null;
  } catch (error) {
    await releaseDistLock();
    throw error;
  }
  t.after(async () => {
    try {
      if (original === null) fs.rmSync(index, { force: true });
      else fs.writeFileSync(index, original);
      if (!hadDist) {
        try {
          fs.rmdirSync(dist);
        } catch (error) {
          if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error;
        }
      }
    } finally {
      await releaseDistLock();
    }
  });
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(index, setupPage);
}

test('setup index restores absent and preexisting files and releases the lock after failure', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-index-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const state of ['absent', 'empty', 'assets', 'built']) {
    const dist = path.join(root, state);
    const index = path.join(dist, 'index.html');
    const asset = path.join(dist, 'assets', 'keep.bin');
    const original = Buffer.from([0, 0xff, 0xc3, 0xa9]);
    if (state !== 'absent') fs.mkdirSync(dist);
    if (state === 'assets' || state === 'built') {
      fs.mkdirSync(path.dirname(asset));
      fs.writeFileSync(asset, original);
    }
    if (state === 'built') fs.writeFileSync(index, original);
    let cleanup;
    await assert.rejects(
      async () => {
        try {
          await setupIndex({ after: (callback) => (cleanup = callback) }, dist);
          assert.equal(fs.readFileSync(index, 'utf8'), setupPage);
          throw new Error('synthetic test failure');
        } finally {
          await cleanup?.();
        }
      },
      { message: 'synthetic test failure' },
    );
    assert.equal(fs.existsSync(dist), state !== 'absent', state);
    if (state === 'built') assert.deepEqual(fs.readFileSync(index), original);
    else assert.equal(fs.existsSync(index), false, state);
    if (state === 'assets' || state === 'built') assert.deepEqual(fs.readFileSync(asset), original);
    const release = await acquireDistTestLock();
    await release();
  }
});

test('production HTTP handler gates every operation, unlocks setup, closes revoked SSE and bounds sanitized writes', async (t) => {
  await setupIndex(t, fileURLToPath(new URL('../dist', import.meta.url)));
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
      fetchTicketPrs: spy('ticketPrs', {
        available: true,
        login: 'qa',
        total: 0,
        truncated: false,
        byTicket: {},
      }),
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
  const { origin: base } = await listenHttp(t, handler);
  const request = async (pathname, method = 'GET', body) => {
    const { status, text } = await requestRaw(base, pathname, {
      method,
      headers: { 'content-type': 'application/json' },
      body,
    });
    return { status, text, json: () => JSON.parse(text) };
  };
  const operations = [
    ['/api/services'],
    ['/api/events'],
    ['/api/logs/app'],
    ['/api/services/app/start', 'POST'],
    ['/api/services/app/stop', 'POST'],
    ['/api/services/app/restart', 'POST'],
    ['/api/prs'],
    ['/api/my-tickets'],
    ['/api/ticket-prs'],
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
  const root = await request('/');
  assert.equal(root.status, 200);
  assert.match(root.text, /id="setup-ui-contract"/);
  assert.equal(store.getSetupStatus().ready, false, 'root is accessible before setup unlocks');
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
