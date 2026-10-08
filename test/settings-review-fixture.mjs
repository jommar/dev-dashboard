import http from 'node:http';
import { once } from 'node:events';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { settingsFixture, accept } from './settings-fixture.mjs';

export function forbidProcessEffects(t) {
  const effects = [];
  for (const name of ['spawn', 'execFile', 'execFileSync', 'spawnSync']) {
    t.mock.method(childProcess, name, () => {
      effects.push(name);
      throw new Error('Unexpected synthetic process operation');
    });
  }
  t.mock.method(process, 'kill', () => {
    effects.push('kill');
    throw new Error('Unexpected synthetic kill');
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return effects;
}

export async function reviewHttp(t, { ready = true, realManager = false, configure } = {}) {
  const f = settingsFixture(t);
  configure?.(f);
  const store = await f.store();
  if (ready) await accept(f, store);
  else await store.initialize();
  const calls = [];
  const manager = realManager
    ? new (await import('../manager.mjs')).Manager({
        local: { root: f.root, services: [] },
        logsDir: f.home + '/logs',
      })
    : {
        list: () => [],
        logs: () => '',
        applySettings: (local) => calls.push(['apply', local]),
        start: () => {
          calls.push(['start']);
          return { ok: true };
        },
        stop: () => {
          calls.push(['stop']);
          return { ok: true };
        },
        restart: () => {
          calls.push(['restart']);
          return { ok: true };
        },
      };
  const { createHttpHandler } = await import('../http-app.mjs');
  const handler = createHttpHandler({ settings: store, manager });
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (pathname, { method = 'GET', body, headers = {} } = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        origin + pathname,
        { method, headers: { 'content-type': 'application/json', ...headers } },
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
      req.end(
        body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      );
    });
  return { f, store, manager, calls, server, handler, origin, request };
}
