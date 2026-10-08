import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import {
  settingsFixture,
  accept,
  probeResponse,
  githubToken,
  jiraToken,
} from './settings-fixture.mjs';
import { reviewHttp, forbidProcessEffects } from './settings-review-fixture.mjs';

for (const cause of ['revoked', 'missing-token'])
  test(`saved validation restores ${cause} readiness with real Manager definitions and no service effects`, async (t) => {
    const effects = forbidProcessEffects(t);
    const f = settingsFixture(t);
    const initial = await f.store();
    await accept(f, initial);
    if (cause === 'revoked') {
      f.network.status = 401;
      await initial.validate({ expectedRevision: initial.getSetupStatus().revision });
    } else fs.rmSync(f.paths.jiraToken);
    const restarted = await f.store();
    await restarted.initialize();
    assert.equal(restarted.getSetupStatus().ready, false);
    if (cause === 'missing-token') f.write(f.paths.jiraToken, jiraToken);
    const { Manager } = await import('../backend/manager.mjs');
    const manager = new Manager({
      local: { root: f.root, services: [] },
      logsDir: f.home + '/logs',
    });
    const { createHttpHandler } = await import('../backend/http-app.mjs');
    const server = http.createServer(createHttpHandler({ settings: restarted, manager }));
    server.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    f.network.status = 200;
    const response = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: server.address().port,
          path: '/api/settings/validate',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify({ expectedRevision: restarted.getSetupStatus().revision }));
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.setup.ready, true);
    assert.deepEqual(
      manager.list().map(({ id, status }) => ({ id, status })),
      [{ id: 'app', status: 'stopped' }],
    );
    assert.deepEqual(effects, []);
    assert.equal(manager.logs('app', 0), '');
  });

test('stale HTTP connection check conflicts before inspection, probes or persisted mutation', async (t) => {
  const h = await reviewHttp(t);
  const old = h.store.getSetupStatus().revision;
  await h.store.save({ ...h.f.configuration, minPrApprover: 3, expectedRevision: old });
  const before = fs.readFileSync(h.f.paths.settings, 'utf8');
  h.f.calls.length = 0;
  h.f.runtimeCalls.length = 0;
  const response = await h.request('/api/settings/validate', {
    method: 'POST',
    body: { expectedRevision: old },
  });
  assert.equal(response.status, 409);
  assert.equal(response.json().code, 'REVISION_CONFLICT');
  assert.equal(h.f.calls.length, 0);
  assert.equal(h.f.runtimeCalls.length, 0);
  assert.equal(fs.readFileSync(h.f.paths.settings, 'utf8'), before);
});

for (const type of ['RATE_LIMITED', 'INTERNAL', 'UNKNOWN_SYNTHETIC']) {
  test(`HTTP200 GraphQL ${type} preserves accepted readiness across restart and cannot grant first acceptance`, async (t) => {
    const f = settingsFixture(t);
    const store = await f.store();
    await accept(f, store);
    f.network.route = (url, init) =>
      url.pathname === '/graphql'
        ? Response.json({
            data: null,
            errors: [{ type, message: 'Synthetic transient GraphQL error' }],
          })
        : probeResponse(url, init);
    await store.validate({ expectedRevision: store.getSetupStatus().revision });
    assert.equal(store.getSetupStatus().ready, true);
    assert.match(JSON.stringify(store.getSetupStatus().connection), /degraded|unknown|unavailable/);
    const restart = await f.store();
    await restart.initialize();
    assert.equal(restart.getSetupStatus().ready, true);
    const fresh = settingsFixture(t);
    fresh.network.route = f.network.route;
    const first = await fresh.store();
    await first.initialize();
    await assert.rejects(
      first.save({
        ...fresh.configuration,
        expectedRevision: first.getSetupStatus().revision,
        credentials: { githubToken, jiraToken },
      }),
    );
    assert.equal(first.getSetupStatus().ready, false);
  });
}

for (const change of ['missing-cwd', 'invalid-runtime', 'invalid-pin']) {
  test(`external ${change} closes operational gate before real Manager effects or log clearing`, async (t) => {
    const effects = forbidProcessEffects(t);
    let runtimeValid = true;
    const { inspectRuntime } = await import('../backend/manager.mjs');
    const h = await reviewHttp(t, {
      realManager: true,
      configure(f) {
        f.dependencies.runtimeInspector =
          change === 'invalid-pin' ? inspectRuntime : async () => ({ ok: runtimeValid });
      },
    });
    await h.manager.applySettings(h.f.configuration.local);
    const log = h.f.home + '/logs/app/out.log';
    h.f.write(log, 'preserved synthetic logs');
    if (change === 'missing-cwd') fs.rmSync(h.f.root + '/app', { recursive: true });
    else if (change === 'invalid-pin') h.f.write(h.f.root + '/app/.nvmrc', 'lts/*');
    else runtimeValid = false;
    const response = await h.request('/api/services/app/start', { method: 'POST', body: {} });
    assert.equal(response.status, 409);
    assert.equal(response.json().code, 'SETUP_REQUIRED');
    assert.equal(h.store.getSetupStatus().ready, false);
    assert.deepEqual(effects, []);
    assert.equal(fs.readFileSync(log, 'utf8'), 'preserved synthetic logs');
    assert.equal(h.manager.list()[0].status, 'stopped');
  });
}

for (const headers of [
  { origin: 'https://foreign.example.invalid' },
  { host: 'rebound.example.invalid' },
  { 'content-type': 'text/plain' },
  { 'sec-fetch-site': 'cross-site' },
]) {
  test(`settings/control boundary rejects ${Object.keys(headers)[0]} before collaborators`, async (t) => {
    const h = await reviewHttp(t);
    const collaborators = [];
    for (const name of ['save', 'validate']) {
      const original = h.store[name];
      t.mock.method(h.store, name, (...args) => {
        collaborators.push(name);
        return original(...args);
      });
    }
    const before = fs.readFileSync(h.f.paths.settings, 'utf8');
    h.f.calls.length = 0;
    h.f.runtimeCalls.length = 0;
    h.calls.length = 0;
    for (const [pathname, method, body] of [
      [
        '/api/settings',
        'PUT',
        { ...h.f.configuration, expectedRevision: h.store.getSetupStatus().revision },
      ],
      ['/api/settings/validate', 'POST', { expectedRevision: h.store.getSetupStatus().revision }],
      ['/api/services/app/start', 'POST', {}],
    ]) {
      const result = await h.request(pathname, { method, body, headers });
      assert.ok([400, 403, 415].includes(result.status), 'reject unsafe request at HTTP boundary');
    }
    if (headers.host)
      assert.ok([400, 403].includes((await h.request('/api/settings', { headers })).status));
    assert.deepEqual(h.calls, []);
    assert.deepEqual(
      collaborators,
      [],
      'no settings mutations or validation even for retained acceptance',
    );
    assert.equal(h.f.calls.length, 0);
    assert.equal(h.f.runtimeCalls.length, 0);
    assert.equal(fs.readFileSync(h.f.paths.settings, 'utf8'), before);
    assert.equal(
      (
        await h.request('/api/settings', {
          method: 'PUT',
          headers: { origin: h.origin },
          body: { ...h.f.configuration, expectedRevision: h.store.getSetupStatus().revision },
        })
      ).status,
      200,
      'same-origin JSON allowed',
    );
    assert.equal(
      (
        await h.request('/api/settings/validate', {
          method: 'POST',
          body: { expectedRevision: h.store.getSetupStatus().revision },
        })
      ).status,
      200,
      'non-browser JSON client allowed',
    );
  });
}

test('production shutdown lifecycle ends active SSE and completes within deadline without starting services', async (t) => {
  const effects = forbidProcessEffects(t);
  const h = await reviewHttp(t, { realManager: true });
  const { shutdownServer } = await import('../backend/server.mjs');
  assert.equal(
    typeof shutdownServer,
    'function',
    'export shutdownServer({server,manager,handler,timeoutMs}) production lifecycle seam',
  );
  await h.manager.applySettings(h.f.configuration.local);
  const stops = [];
  t.mock.method(h.manager, 'stop', async (id) => {
    stops.push(id);
    return { ok: true };
  });
  const stream = http.get(h.origin + '/api/events');
  let end;
  const ended = new Promise((resolve) => {
    end = resolve;
  });
  await new Promise((resolve, reject) => {
    stream.on('response', (response) => {
      response.on('data', resolve);
      response.on('end', end);
      response.on('close', end);
    });
    stream.on('error', reject);
  });
  t.after(() => stream.destroy());
  await Promise.race([
    Promise.all([
      shutdownServer({ server: h.server, manager: h.manager, handler: h.handler, timeoutMs: 100 }),
      ended,
    ]),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('SSE shutdown exceeded 500ms')), 500);
      timer.unref();
    }),
  ]);
  assert.equal(h.server.listening, false);
  assert.deepEqual(
    stops,
    ['app'],
    'shutdown stops each owned service through public Manager control',
  );
  assert.deepEqual(effects, []);
});
