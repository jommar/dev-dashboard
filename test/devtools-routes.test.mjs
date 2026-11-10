// devtools-routes.test.mjs — the HTTP contract for the DevTools tab.
// The browser is injected, so nothing here spawns a process or binds a port.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { listenHttp, requestRaw } from './http-test-fixture.mjs';
import { createHttpHandler } from '../backend/http-app.mjs';
import { settingsFixture } from './settings-fixture.mjs';
import { parseInputEvent } from '../backend/screencast-input.mjs';
import { createDevtoolsStreams } from '../backend/devtools-stream.mjs';

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
  const views = { listeners: [], left: 0, qualities: [], inputs: [], tabs: [] };
  const refuse = (code, message, status) => Object.assign(new Error(message), { code, status });
  const browserScreencast = {
    subscribe: async (id, listener, quality) => {
      views.listeners.push(['subscribe', id, listener, quality]);
      if (id !== INSTANCE.id) throw refuse('UNKNOWN_BROWSER', 'Unknown browser.', 404);
      if (overrides.notRunning)
        throw refuse('BROWSER_NOT_RUNNING', 'That browser is not running.', 409);
      listener.status({ status: 'live', reason: '' });
      listener.target({ id: 'T1', title: 'Home', url: 'https://example.invalid/' });
      listener.tabs({
        mode: 'auto',
        tabs: [{ id: 'T1', title: 'Home', url: 'https://example.invalid/', current: true }],
      });
      listener.frame({ data: 'ZnJhbWU=', metadata: { deviceWidth: 1280, deviceHeight: 720 } });
      const leave = () => {
        views.left += 1;
      };
      leave.setQuality = (level) => views.qualities.push(level);
      return leave;
    },
    input: async (id, event, targetId) => {
      const parsed = parseInputEvent(event);
      if (overrides.tabChanged) throw refuse('TAB_CHANGED', 'The viewed tab changed.', 409);
      views.inputs.push([id, parsed, targetId]);
    },
    // The same refusals as the module, so the route's mapping of each is what is under test.
    selectTab: async (id, targetId) => {
      if (targetId !== null && !(typeof targetId === 'string' && targetId))
        throw refuse('INVALID_TAB', 'Choose a tab, or null for the newest.', 400);
      if (overrides.notViewed) throw refuse('SCREENCAST_NOT_ACTIVE', 'Not viewed.', 409);
      if (targetId !== null && targetId !== 'T1' && targetId !== 'T2')
        throw refuse('UNKNOWN_TAB', 'That tab is not open.', 404);
      views.tabs.push([id, targetId]);
    },
  };
  const handler = createHttpHandler({
    settings,
    manager: { list: () => [], applySettings() {} },
    integrations: {
      browserDevtools,
      browserScreencast,
      ...(overrides.maxStreams && {
        devtoolsStreams: createDevtoolsStreams({
          screencast: browserScreencast,
          maxStreams: overrides.maxStreams,
          maxSubscriptions: overrides.maxSubscriptions,
        }),
      }),
    },
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
  // The live view stream, held open: its messages as they arrive and its id from the `hello`.
  // A refused one resolves with its status and body, and nothing to close.
  const live = ({ headers = {} } = {}) =>
    new Promise((resolve, reject) => {
      const req = http.get(origin + '/api/devtools/stream', { headers }, (res) => {
        let text = '';
        const open = {
          status: res.statusCode,
          headers: res.headers,
          get text() {
            return text;
          },
          messages: () => messagesOf(text),
          close: () => req.destroy(),
        };
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
          if (res.statusCode === 200 && !open.id && text.includes('\n\n'))
            resolve(Object.assign(open, { id: messagesOf(text)[0][1].stream }));
        });
        res.on('end', () => res.statusCode !== 200 && resolve(open));
        res.on('error', () => {});
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
  return { request, stream, live, calls, views };
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

const messagesOf = (text) =>
  text
    .trim()
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const [event, data] = block.split('\n');
      return [event.replace('event: ', ''), JSON.parse(data.replace('data: ', ''))];
    });
const subscribe = (request, stream, id = INSTANCE.id, quality = 'tile') =>
  request('/api/devtools/stream/subscribe', { method: 'POST', body: { stream, id, quality } });
const unsubscribe = (request, stream, id = INSTANCE.id) =>
  request('/api/devtools/stream/unsubscribe', { method: 'POST', body: { stream, id } });
const until = async (check) => {
  for (let turn = 0; turn < 100 && !check(); turn += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), 'timed out waiting');
};

test('the stream opens as event-stream, says its id and then sends nothing until asked', async (t) => {
  const { live, views } = await endpoint(t);
  const open = await live();
  assert.equal(open.status, 200);
  assert.match(String(open.headers['content-type']), /text\/event-stream/);
  assert.match(String(open.headers['cache-control']), /no-store/);
  assert.match(open.id, /^[A-Za-z0-9_-]{16,64}$/);
  assert.deepEqual(open.messages(), [['hello', { stream: open.id }]]);
  assert.deepEqual(views.listeners, [], 'no browser is touched by merely opening it');
  open.close();
});

test('subscribing sends that browser’s status, target, tabs and frames, tagged, on the one stream', async (t) => {
  const { live, request, views } = await endpoint(t);
  const open = await live();
  const response = await subscribe(request, open.id);
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { ok: true });
  await until(() => open.messages().some(([event]) => event === 'frame'));
  assert.deepEqual(open.messages().slice(1), [
    ['status', { id: INSTANCE.id, status: 'live', reason: '' }],
    ['target', { id: INSTANCE.id, targetId: 'T1', title: 'Home', url: 'https://example.invalid/' }],
    [
      'tabs',
      {
        id: INSTANCE.id,
        mode: 'auto',
        tabs: [{ id: 'T1', title: 'Home', url: 'https://example.invalid/', current: true }],
      },
    ],
    [
      'frame',
      {
        id: INSTANCE.id,
        data: 'ZnJhbWU=',
        metadata: { deviceWidth: 1280, deviceHeight: 720 },
      },
    ],
  ]);
  assert.deepEqual(
    views.listeners.map(([step, id, , quality]) => [step, id, quality]),
    [['subscribe', INSTANCE.id, 'tile']],
  );
  open.close();
});

test('subscribing again changes the quality; unsubscribing and closing let the browser go', async (t) => {
  const { live, request, views } = await endpoint(t);
  const open = await live();
  await subscribe(request, open.id, INSTANCE.id, 'tile');
  await subscribe(request, open.id, INSTANCE.id, 'full');
  assert.deepEqual(views.qualities, ['full']);
  assert.equal(views.listeners.length, 1, 'one subscription, changed in place');

  const gone = await unsubscribe(request, open.id);
  assert.deepEqual(gone.json, { ok: true });
  assert.equal(views.left, 1);
  assert.equal((await unsubscribe(request, open.id)).status, 200, 'twice is not an error');
  assert.equal(views.left, 1);

  await subscribe(request, open.id);
  open.close();
  await until(() => views.left === 2);
});

test('closing the stream without unsubscribing releases every browser it held', async (t) => {
  const { live, request, views } = await endpoint(t);
  const open = await live();
  await subscribe(request, open.id);
  open.close();
  await until(() => views.left === 1);
  // Its id is dead now.
  const late = await subscribe(request, open.id);
  assert.equal(late.status, 404);
  assert.equal(late.json.code, 'UNKNOWN_STREAM');
});

test('a browser that stops is told so on the stream, which stays open', async (t) => {
  const { live, request, views } = await endpoint(t);
  const open = await live();
  await subscribe(request, open.id);
  await until(() => views.listeners.length === 1);
  views.listeners[0][2].status({ status: 'lost', reason: 'stopped' });
  views.listeners[0][2].end();
  await until(() =>
    open.messages().some(([event, body]) => event === 'status' && body.reason === 'stopped'),
  );
  // Still a stream: it takes a new subscription.
  assert.equal((await subscribe(request, open.id)).status, 200);
  assert.equal(views.listeners.length, 2);
  open.close();
});

test('a subscription needs a stream, a known quality and a running browser', async (t) => {
  const { live, request, views } = await endpoint(t);
  const open = await live();
  const refused = async (body, status, code) => {
    const response = await request('/api/devtools/stream/subscribe', { method: 'POST', body });
    assert.equal(response.status, status, JSON.stringify(body));
    assert.equal(response.json.code, code, JSON.stringify(body));
  };
  const id = INSTANCE.id;
  await refused({ id, quality: 'tile' }, 400, 'INVALID_STREAM');
  await refused({ stream: 'short', id, quality: 'tile' }, 400, 'INVALID_STREAM');
  await refused({ stream: `${open.id}/../x`, id, quality: 'tile' }, 400, 'INVALID_STREAM');
  await refused({ stream: 'a'.repeat(24), id, quality: 'tile' }, 404, 'UNKNOWN_STREAM');
  await refused({ stream: open.id, id, quality: 'huge' }, 400, 'INVALID_QUALITY');
  await refused({ stream: open.id, id }, 400, 'INVALID_QUALITY');
  await refused({ stream: open.id, id: 'b-nope', quality: 'tile' }, 404, 'UNKNOWN_BROWSER');
  await refused({ stream: open.id, id: 7, quality: 'tile' }, 404, 'UNKNOWN_BROWSER');
  assert.deepEqual(
    views.listeners.map(([step, who]) => [step, who]),
    [['subscribe', 'b-nope']],
    'only a well-formed request for a real stream reaches a browser',
  );
  const unstream = await unsubscribe(request, 'short');
  assert.equal(unstream.status, 400);
  assert.equal((await unsubscribe(request, 'a'.repeat(24))).status, 404);
  open.close();

  const stopped = await endpoint(t, { notRunning: true });
  const running = await stopped.live();
  const response = await subscribe(stopped.request, running.id);
  assert.equal(response.status, 409);
  assert.equal(response.json.code, 'BROWSER_NOT_RUNNING');
  running.close();
});

test('the number of streams and of subscriptions on one is capped with a 429', async (t) => {
  const { live, request, views } = await endpoint(t, { maxStreams: 2, maxSubscriptions: 1 });
  const one = await live();
  const two = await live();
  const refused = await live();
  assert.equal(refused.status, 429);
  assert.equal(JSON.parse(refused.text).code, 'TOO_MANY_STREAMS');
  assert.doesNotMatch(String(refused.headers['content-type']), /event-stream/);

  await subscribe(request, one.id);
  // Another browser would be a second on this stream; the one it has already is not.
  const over = await subscribe(request, one.id, 'b-other');
  assert.equal(over.status, 429);
  assert.equal(over.json.code, 'TOO_MANY_SUBSCRIPTIONS');
  assert.equal((await subscribe(request, one.id, INSTANCE.id, 'full')).status, 200);
  assert.equal(views.listeners.length, 1, 'the capped request never reached a browser');
  assert.deepEqual(views.qualities, ['full']);
  // The allowance is per stream.
  assert.equal((await subscribe(request, two.id)).status, 200);
  one.close();
  let room = await live();
  for (let turn = 0; turn < 50 && room.status !== 200; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    room = await live();
  }
  assert.equal(room.status, 200, 'a closed stream frees its place');
  two.close();
  room.close();
});

test('the stream refuses another site, however the browser marks the request', async (t) => {
  const { live, views } = await endpoint(t);
  for (const site of ['cross-site', 'same-site']) {
    const response = await live({ headers: { 'sec-fetch-site': site } });
    assert.equal(response.status, 403, site);
  }
  assert.deepEqual(views.listeners, [], 'a refused request never reaches the browser');
  for (const site of ['same-origin', 'none']) {
    const response = await live({ headers: { 'sec-fetch-site': site } });
    assert.equal(response.status, 200, site);
    response.close();
  }
  const bare = await live(); // curl and older browsers send none
  assert.equal(bare.status, 200);
  bare.close();
});

test('the stream refuses a Host that is not loopback', async (t) => {
  const { live } = await endpoint(t);
  const response = await live({ headers: { host: 'attacker.invalid' } });
  assert.equal(response.status, 403);
});

test('subscribing and unsubscribing are state-changing requests: another origin is refused', async (t) => {
  const { live, request, views } = await endpoint(t);
  const open = await live();
  for (const path of ['subscribe', 'unsubscribe'])
    for (const headers of [
      { origin: 'https://attacker.invalid' },
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
    ]) {
      const response = await request(`/api/devtools/stream/${path}`, {
        method: 'POST',
        body: { stream: open.id, id: INSTANCE.id, quality: 'tile' },
        headers,
      });
      assert.equal(response.status, 403, `${path} ${JSON.stringify(headers)}`);
    }
  assert.deepEqual(views.listeners, []);
  open.close();
});

test('the per-browser screencast route is gone, so nothing opens a stream per browser', async (t) => {
  const { stream, views } = await endpoint(t);
  const response = await stream(`/api/devtools/browsers/screencast?id=${INSTANCE.id}`);
  assert.notEqual(response.status, 200);
  assert.doesNotMatch(String(response.headers['content-type']), /event-stream/);
  assert.deepEqual(views.listeners, []);
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

test('forwards the tab an input was meant for, and answers 409 once it changed', async (t) => {
  const { request, views } = await endpoint(t);
  const event = { type: 'mouseMoved', x: 10, y: 20 };
  const sent = await request('/api/devtools/browsers/input', {
    method: 'POST',
    body: { id: INSTANCE.id, event, targetId: 'T1' },
  });
  assert.equal(sent.status, 200);
  assert.equal(views.inputs[0][2], 'T1');

  const changed = await endpoint(t, { tabChanged: true });
  const response = await changed.request('/api/devtools/browsers/input', {
    method: 'POST',
    body: { id: INSTANCE.id, event, targetId: 'T0' },
  });
  assert.equal(response.status, 409);
  assert.equal(response.json.code, 'TAB_CHANGED');
});

test('selects a tab, or null to follow the newest', async (t) => {
  const { request, views } = await endpoint(t);
  for (const targetId of ['T2', null]) {
    const response = await request('/api/devtools/browsers/tab', {
      method: 'POST',
      body: { id: INSTANCE.id, targetId },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { ok: true });
  }
  assert.deepEqual(views.tabs, [
    [INSTANCE.id, 'T2'],
    [INSTANCE.id, null],
  ]);
});

test('answers 400 for a tab that is not a string or null, 404 for one not open, 409 when not viewed', async (t) => {
  const { request, views } = await endpoint(t);
  for (const body of [
    { id: INSTANCE.id },
    { id: INSTANCE.id, targetId: 7 },
    { id: INSTANCE.id, targetId: '' },
    { id: INSTANCE.id, targetId: { id: 'T1' } },
  ]) {
    const response = await request('/api/devtools/browsers/tab', { method: 'POST', body });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(response.json.code, 'INVALID_TAB');
  }
  const unknown = await request('/api/devtools/browsers/tab', {
    method: 'POST',
    body: { id: INSTANCE.id, targetId: 'T-gone' },
  });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.code, 'UNKNOWN_TAB');
  assert.deepEqual(views.tabs, []);

  const idle = await endpoint(t, { notViewed: true });
  const response = await idle.request('/api/devtools/browsers/tab', {
    method: 'POST',
    body: { id: INSTANCE.id, targetId: 'T1' },
  });
  assert.equal(response.status, 409);
  assert.equal(response.json.code, 'SCREENCAST_NOT_ACTIVE');
});

test('choosing a tab is a state-changing request: another origin is refused', async (t) => {
  const { request, views } = await endpoint(t);
  const body = { id: INSTANCE.id, targetId: 'T1' };
  for (const headers of [
    { origin: 'https://attacker.invalid' },
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' },
  ]) {
    const response = await request('/api/devtools/browsers/tab', {
      method: 'POST',
      body,
      headers,
    });
    assert.equal(response.status, 403, JSON.stringify(headers));
  }
  assert.deepEqual(views.tabs, []);
});

test('choosing a tab needs no setup, like the rest of the live view', async (t) => {
  const { request } = await endpoint(t); // settings.initialize() only: setup is not ready
  const response = await request('/api/devtools/browsers/tab', {
    method: 'POST',
    body: { id: INSTANCE.id, targetId: null },
  });
  assert.equal(response.status, 200);
});
