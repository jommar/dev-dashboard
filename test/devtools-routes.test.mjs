// devtools-routes.test.mjs — the HTTP contract for the DevTools tab.
// The browser is injected, so nothing here spawns a process or binds a port.
import test from 'node:test';
import assert from 'node:assert/strict';
import { listenHttp, requestRaw } from './http-test-fixture.mjs';
import { createHttpHandler } from '../backend/http-app.mjs';
import { settingsFixture } from './settings-fixture.mjs';

const INSTANCE = {
  id: 'b-3f9a2c7d',
  label: 'QA',
  port: 9300,
  pid: 123456,
  profileDir: '/home/test/.config/dev-dashboard/browsers/b-3f9a2c7d/profile',
  url: 'about:blank',
  startedAt: '2026-11-11T09:12:31.004Z',
  status: 'running',
};

async function endpoint(t, overrides = {}) {
  const fixture = settingsFixture(t);
  const settings = await fixture.store();
  await settings.initialize(); // not ready: the DevTools routes never need setup
  const calls = [];
  const browserDevtools = {
    list: async () => {
      calls.push(['list']);
      return [INSTANCE];
    },
    launch: async (input) => {
      calls.push(['launch', input]);
      if (overrides.launchError) throw overrides.launchError;
      return INSTANCE;
    },
    start: async (id) => {
      calls.push(['start', id]);
      return INSTANCE;
    },
    stop: async (id) => {
      calls.push(['stop', id]);
      if (id !== INSTANCE.id)
        throw Object.assign(new Error('Unknown browser.'), {
          code: 'UNKNOWN_BROWSER',
          status: 404,
        });
      return { ...INSTANCE, status: 'stopped', pid: null };
    },
    remove: async (id) => {
      calls.push(['remove', id]);
      if (id !== INSTANCE.id)
        throw Object.assign(new Error('Unknown browser.'), {
          code: 'UNKNOWN_BROWSER',
          status: 404,
        });
      return { id };
    },
  };
  const handler = createHttpHandler({
    settings,
    manager: { list: () => [], applySettings() {} },
    integrations: { browserDevtools },
  });
  const { origin } = await listenHttp(t, handler);
  const request = async (pathname, { method = 'GET', body } = {}) => {
    const response = await requestRaw(origin, pathname, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeout: 2000,
      timeoutMessage: 'synthetic route request timed out',
    });
    return { ...response, json: JSON.parse(response.text) };
  };
  return { request, calls };
}

test('lists the registry without setup', async (t) => {
  const { request } = await endpoint(t);
  const response = await request('/api/devtools/browsers');
  assert.equal(response.status, 200);
  assert.match(String(response.headers['cache-control']), /no-store/);
  assert.match(String(response.headers['content-type']), /application\/json/);
  assert.deepEqual(response.json, { browsers: [INSTANCE] });
});

test('launches with the posted body and returns the instance', async (t) => {
  const { request, calls } = await endpoint(t);
  const response = await request('/api/devtools/browsers', {
    method: 'POST',
    body: { label: 'QA', url: 'https://example.invalid/login' },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { ok: true, browser: INSTANCE });
  assert.deepEqual(calls, [['launch', { label: 'QA', url: 'https://example.invalid/login' }]]);
});

test('keeps NO_FREE_PORT as a 409 with its code', async (t) => {
  const { request } = await endpoint(t, {
    launchError: Object.assign(new Error('No free debug port.'), {
      code: 'NO_FREE_PORT',
      status: 409,
    }),
  });
  const response = await request('/api/devtools/browsers', { method: 'POST', body: {} });
  assert.equal(response.status, 409);
  assert.equal(response.json.code, 'NO_FREE_PORT');
  assert.equal(response.json.error, 'NO FREE PORT');
});

test('rejects an unknown id on stop', async (t) => {
  const { request, calls } = await endpoint(t);
  const response = await request('/api/devtools/browsers/stop', {
    method: 'POST',
    body: { id: 'b-nope' },
  });
  assert.equal(response.status, 404);
  assert.equal(response.json.code, 'UNKNOWN_BROWSER');
  assert.deepEqual(calls, [['stop', 'b-nope']]);
});

test('removes an instance by id', async (t) => {
  const { request } = await endpoint(t);
  const response = await request('/api/devtools/browsers/remove', {
    method: 'POST',
    body: { id: INSTANCE.id },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { ok: true, id: INSTANCE.id });
});
