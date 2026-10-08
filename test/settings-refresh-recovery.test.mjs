import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import { settingsFixture, accept, jiraToken } from './settings-fixture.mjs';
import { forbidProcessEffects } from './settings-review-fixture.mjs';

async function recoveryHttp(t, { failApply = false } = {}) {
  const effects = forbidProcessEffects(t);
  const f = settingsFixture(t);
  const accepted = await f.store();
  await accept(f, accepted);
  const persisted = fs.readFileSync(f.paths.settings, 'utf8');
  fs.rmSync(f.paths.jiraToken);
  const settings = await f.store();
  await settings.initialize();
  assert.equal(
    settings.getSetupStatus().ready,
    false,
    'missing accepted token closes startup gate',
  );
  const { Manager } = await import('../manager.mjs');
  const manager = new Manager({ local: { root: f.root, services: [] }, logsDir: f.home + '/logs' });
  assert.deepEqual(manager.list(), [], 'startup manager has no wrappers');
  const log = f.home + '/logs/app/out.log';
  f.write(log, 'retained synthetic service logs\n');
  const applyCalls = [];
  const reconcile = manager.reconcileSettings.bind(manager);
  t.mock.method(manager, 'reconcileSettings', async (local) => {
    applyCalls.push(structuredClone(local));
    if (failApply) throw new Error('Synthetic reconciliation failure');
    return reconcile(local);
  });
  const publishedReadiness = [];
  settings.subscribe((status) =>
    publishedReadiness.push({ ready: status.ready, ids: manager.list().map(({ id }) => id) }),
  );
  const { createHttpHandler } = await import('../http-app.mjs');
  const handler = createHttpHandler({ settings, manager });
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    handler.close?.();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const request = (pathname, method = 'GET') =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: server.address().port,
          path: pathname,
          method,
          headers: { 'content-type': 'application/json' },
        },
        (response) => {
          let text = '';
          response.on('data', (chunk) => {
            text += chunk;
          });
          response.on('end', () =>
            resolve({ status: response.statusCode, text, json: () => JSON.parse(text) }),
          );
        },
      );
      req.on('error', reject);
      req.end(method === 'POST' ? '{}' : undefined);
    });
  f.write(f.paths.jiraToken, jiraToken);
  f.calls.length = 0;
  return { f, settings, manager, effects, applyCalls, publishedReadiness, persisted, log, request };
}

test('operational refresh restores saved IDs after identical accepted token recovery with no process or log effects', async (t) => {
  const h = await recoveryHttp(t);
  const response = await h.request('/api/services');
  assert.equal(response.status, 200);
  assert.deepEqual(
    response.json().services.map(({ id, status }) => ({ id, status })),
    [{ id: 'app', status: 'stopped' }],
  );
  assert.equal(h.settings.getSetupStatus().ready, true);
  assert.deepEqual(
    h.manager.list().map(({ id }) => id),
    ['app'],
  );
  assert.deepEqual(
    h.applyCalls,
    [h.f.configuration.local],
    'saved definitions applied before readiness publication',
  );
  assert.deepEqual(
    h.publishedReadiness,
    [{ ready: true, ids: ['app'] }],
    'wrappers exist when readiness is published',
  );
  assert.equal((await h.request('/api/services')).status, 200);
  assert.equal(h.applyCalls.length, 1, 'unchanged ready refresh preserves existing wrappers');
  assert.deepEqual(h.effects, []);
  assert.equal(h.f.calls.length, 0, 'identical accepted credentials require no remote probes');
  assert.equal(fs.readFileSync(h.log, 'utf8'), 'retained synthetic service logs\n');
  assert.equal(
    fs.readFileSync(h.f.paths.settings, 'utf8'),
    h.persisted,
    'refresh does not rewrite saved acceptance',
  );
});

test('operational token recovery reconciliation failure keeps readiness closed before all service effects', async (t) => {
  const h = await recoveryHttp(t, { failApply: true });
  const response = await h.request('/api/services');
  assert.ok(
    [409, 503].includes(response.status),
    'failed restoration cannot return an operational success',
  );
  assert.equal(h.settings.getSetupStatus().ready, false);
  assert.equal(h.applyCalls.length, 1, 'injected public reconciliation failure exercised');
  assert.equal(
    h.publishedReadiness.some(({ ready }) => ready),
    false,
    'never publish readiness before successful reconciliation',
  );
  assert.deepEqual(h.manager.list(), []);
  const control = await h.request('/api/services/app/start', 'POST');
  assert.ok([409, 503].includes(control.status));
  assert.equal(h.settings.getSetupStatus().ready, false);
  assert.deepEqual(h.effects, []);
  assert.equal(h.f.calls.length, 0);
  assert.equal(fs.readFileSync(h.log, 'utf8'), 'retained synthetic service logs\n');
  assert.equal(fs.readFileSync(h.f.paths.settings, 'utf8'), h.persisted);
});
