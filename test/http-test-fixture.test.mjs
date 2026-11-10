import test from 'node:test';
import assert from 'node:assert/strict';
import { listenHttp, requestRaw } from './http-test-fixture.mjs';

test('raw HTTP transport preserves literal paths, bytes, optional headers and UTF-8 responses', async (t) => {
  const received = [];
  const { origin } = await listenHttp(t, (req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        method: req.method,
        path: req.url,
        body: Buffer.concat(chunks),
        contentType: req.headers['content-type'],
        origin: req.headers.origin,
        marker: req.headers['x-fixture'],
      });
      res.writeHead(207, { 'content-type': 'text/plain; charset=utf-8', 'x-fixture': 'reply' });
      res.end('raw café 🦊');
    });
  });
  const pathname = '/assets/%2e%2e/%2e%2e/package.json?literal=%2F&space=one%20two';
  const body = Buffer.from([0, 0xff, 0xc3, 0xa9]);
  const response = await requestRaw(origin, pathname, {
    method: 'POST',
    headers: { 'x-fixture': 'request' },
    body,
  });
  assert.deepEqual(received, [
    {
      method: 'POST',
      path: pathname,
      body,
      contentType: undefined,
      origin: undefined,
      marker: 'request',
    },
  ]);
  assert.deepEqual(Object.keys(response).sort(), ['headers', 'status', 'text']);
  assert.equal(response.status, 207);
  assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(response.headers['x-fixture'], 'reply');
  assert.equal(response.text, 'raw café 🦊');
});

test('raw HTTP transport leaves string bodies and JSON parsing to caller adapters', async (t) => {
  const received = [];
  const { origin } = await listenHttp(t, (req, res) => {
    let text = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => (text += chunk));
    req.on('end', () => {
      received.push({ method: req.method, text, contentType: req.headers['content-type'] });
      res.end('{not JSON');
    });
  });
  const rawBody = '{"message":"café","spacing":  1}';
  const response = await requestRaw(origin, '/string', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: rawBody,
  });
  assert.equal(response.text, '{not JSON', 'non-JSON responses must not reject in the collector');
  const empty = await requestRaw(origin, '/empty');
  assert.equal(empty.text, '{not JSON');
  assert.deepEqual(received, [
    { method: 'PUT', text: rawBody, contentType: 'application/json' },
    { method: 'GET', text: '', contentType: undefined },
  ]);
});

test('raw HTTP transport uses the caller timeout and exact error message', async (t) => {
  const { origin } = await listenHttp(t, () => {});
  await assert.rejects(
    requestRaw(origin, '/held-open', {
      timeout: 25,
      timeoutMessage: 'synthetic route request timed out',
    }),
    { message: 'synthetic route request timed out' },
  );
});

test('HTTP listener registers awaited handler and server cleanup', async (t) => {
  let cleanup;
  let cleaned = false;
  let handlerClosed = false;
  const handler = (_req, res) => res.end('ready');
  handler.close = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    handlerClosed = true;
  };
  const { origin, server } = await listenHttp(
    {
      after(callback) {
        cleanup = callback;
      },
    },
    handler,
  );
  t.after(async () => {
    if (!cleaned) await cleanup();
  });
  assert.equal((await requestRaw(origin, '/')).text, 'ready');
  assert.equal(typeof cleanup, 'function');
  await cleanup();
  cleaned = true;
  assert.equal(handlerClosed, true, 'cleanup awaits the caller handler close hook');
  assert.equal(server.listening, false, 'cleanup awaits the loopback server close');
});
