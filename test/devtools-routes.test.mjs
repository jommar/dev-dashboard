// devtools-routes.test.mjs — the HTTP contract for the DevTools tab.
// The browser is injected, so nothing here spawns a process or binds a port.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { listenHttp, requestRaw } from './http-test-fixture.mjs';
import { createHttpHandler } from '../backend/http-app.mjs';
import { settingsFixture } from './settings-fixture.mjs';
import { parseInputEvent } from '../backend/screencast-input.mjs';

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
  // The live view, with the real input whitelist: it is the part that must answer 400.
  const views = { listeners: [], left: 0, inputs: [] };
  const browserScreencast = {
    check: async (id) => {
      views.listeners.push(['check', id]);
      if (id !== INSTANCE.id)
        throw Object.assign(new Error('Unknown browser.'), {
          code: 'UNKNOWN_BROWSER',
          status: 404,
        });
      if (overrides.notRunning)
        throw Object.assign(new Error('That browser is not running.'), {
          code: 'BROWSER_NOT_RUNNING',
          status: 409,
        });
    },
    subscribe: async (id, listener) => {
      views.listeners.push(['subscribe', id, listener]);
      listener.status({ status: 'live', reason: '' });
      listener.target({ id: 'T1', title: 'Home', url: 'https://example.invalid/' });
      listener.frame({ data: 'ZnJhbWU=', metadata: { deviceWidth: 1280, deviceHeight: 720 } });
      return () => {
        views.left += 1;
      };
    },
    input: async (id, event) => {
      const parsed = parseInputEvent(event);
      views.inputs.push([id, parsed]);
    },
  };
  const handler = createHttpHandler({
    settings,
    manager: { list: () => [], applySettings() {} },
    integrations: { browserDevtools, browserScreencast },
  });
  const { origin } = await listenHttp(t, handler);
  // An event stream never ends, so it is read until `enough(text)` and then dropped.
  const stream = (pathname, { headers = {}, enough = () => true } = {}) =>
    new Promise((resolve, reject) => {
      const req = http.get(origin + pathname, { headers }, (res) => {
        let text = '';
        const finish = () => {
          req.destroy();
          resolve({ status: res.statusCode, headers: res.headers, text });
        };
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
          if (res.statusCode !== 200 || enough(text)) finish();
        });
        res.on('end', finish);
      });
      req.on('error', (error) => (req.destroyed ? undefined : reject(error)));
      req.setTimeout(2000, () => req.destroy(new Error('synthetic stream timed out')));
    });
  const request = async (pathname, { method = 'GET', body, headers = {} } = {}) => {
    const response = await requestRaw(origin, pathname, {
      method,
      headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeout: 2000,
      timeoutMessage: 'synthetic route request timed out',
    });
    return { ...response, json: JSON.parse(response.text) };
  };
  return { request, stream, calls, views };
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

const FRAMED = (text) => text.includes('event: frame');

test('streams status, target and frames as server-sent events without setup', async (t) => {
  const { stream, views } = await endpoint(t);
  const response = await stream(`/api/devtools/browsers/screencast?id=${INSTANCE.id}`, {
    enough: FRAMED,
  });
  assert.equal(response.status, 200);
  assert.match(String(response.headers['content-type']), /text\/event-stream/);
  assert.match(String(response.headers['cache-control']), /no-store/);
  const messages = response.text
    .trim()
    .split('\n\n')
    .map((block) => {
      const [event, data] = block.split('\n');
      return [event.replace('event: ', ''), JSON.parse(data.replace('data: ', ''))];
    });
  assert.deepEqual(messages, [
    ['status', { status: 'live', reason: '' }],
    ['target', { id: 'T1', title: 'Home', url: 'https://example.invalid/' }],
    ['frame', { data: 'ZnJhbWU=', metadata: { deviceWidth: 1280, deviceHeight: 720 } }],
  ]);
  assert.deepEqual(
    views.listeners.map(([step, id]) => [step, id]),
    [
      ['check', INSTANCE.id],
      ['subscribe', INSTANCE.id],
    ],
  );
});

test('unsubscribes when the viewer closes the stream', async (t) => {
  const { stream, views } = await endpoint(t);
  await stream(`/api/devtools/browsers/screencast?id=${INSTANCE.id}`, { enough: FRAMED });
  for (let turn = 0; turn < 50 && views.left === 0; turn += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(views.left, 1);
});

test('ends the stream when the browser stops', async (t) => {
  const { views, stream } = await endpoint(t);
  const reading = stream(`/api/devtools/browsers/screencast?id=${INSTANCE.id}`, {
    enough: () => false,
  });
  for (let turn = 0; turn < 50 && views.listeners.length < 2; turn += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  views.listeners[1][2].status({ status: 'lost', reason: 'stopped' });
  views.listeners[1][2].end();
  const response = await reading;
  assert.match(response.text, /"reason":"stopped"/);
});

test('answers 404 for an unknown browser and 409 for one that is not running', async (t) => {
  const unknown = await endpoint(t);
  const missing = await unknown.stream('/api/devtools/browsers/screencast?id=b-nope');
  assert.equal(missing.status, 404);
  assert.match(String(missing.headers['content-type']), /application\/json/);
  assert.equal(JSON.parse(missing.text).code, 'UNKNOWN_BROWSER');
  const noId = await unknown.stream('/api/devtools/browsers/screencast');
  assert.equal(noId.status, 404);

  const stopped = await endpoint(t, { notRunning: true });
  const response = await stopped.stream(`/api/devtools/browsers/screencast?id=${INSTANCE.id}`);
  assert.equal(response.status, 409);
  assert.equal(JSON.parse(response.text).code, 'BROWSER_NOT_RUNNING');
  assert.equal(
    stopped.views.listeners.some(([step]) => step === 'subscribe'),
    false,
    'nothing subscribed',
  );
});

test('the stream refuses another site, however the browser marks the request', async (t) => {
  const { stream, views } = await endpoint(t);
  for (const site of ['cross-site', 'same-site']) {
    const response = await stream(`/api/devtools/browsers/screencast?id=${INSTANCE.id}`, {
      headers: { 'sec-fetch-site': site },
    });
    assert.equal(response.status, 403, site);
  }
  assert.deepEqual(views.listeners, [], 'a refused request never reaches the browser');
  for (const site of ['same-origin', 'none']) {
    const response = await stream(`/api/devtools/browsers/screencast?id=${INSTANCE.id}`, {
      headers: { 'sec-fetch-site': site },
      enough: FRAMED,
    });
    assert.equal(response.status, 200, site);
  }
});

test('the stream refuses a Host that is not loopback', async (t) => {
  const { stream } = await endpoint(t);
  const response = await stream(`/api/devtools/browsers/screencast?id=${INSTANCE.id}`, {
    headers: { host: 'attacker.invalid' },
  });
  assert.equal(response.status, 403);
});

test('forwards an input event for a viewed browser', async (t) => {
  const { request, views } = await endpoint(t);
  const response = await request('/api/devtools/browsers/input', {
    method: 'POST',
    body: { id: INSTANCE.id, event: { type: 'mousePressed', x: 10, y: 20 } },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { ok: true });
  assert.equal(views.inputs[0][0], INSTANCE.id);
  assert.equal(views.inputs[0][1].method, 'Input.dispatchMouseEvent');
});

test('answers 400 for input that is not whitelisted', async (t) => {
  const { request, views } = await endpoint(t);
  for (const event of [
    { type: 'Page.navigate', url: 'https://evil.invalid' },
    { type: 'mouseMoved', x: -5, y: 1 },
    { type: 'mouseMoved', x: 1, y: 1, extra: true },
    'click',
    undefined,
  ]) {
    const response = await request('/api/devtools/browsers/input', {
      method: 'POST',
      body: { id: INSTANCE.id, event },
    });
    assert.equal(response.status, 400, JSON.stringify(event));
    assert.equal(response.json.code, 'INVALID_INPUT');
  }
  assert.deepEqual(views.inputs, []);
});

test('input is a state-changing request: another origin is refused', async (t) => {
  const { request, views } = await endpoint(t);
  const body = { id: INSTANCE.id, event: { type: 'mouseMoved', x: 1, y: 1 } };
  for (const headers of [
    { origin: 'https://attacker.invalid' },
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' },
  ]) {
    const response = await request('/api/devtools/browsers/input', {
      method: 'POST',
      body,
      headers,
    });
    assert.equal(response.status, 403, JSON.stringify(headers));
  }
  assert.deepEqual(views.inputs, []);
});
