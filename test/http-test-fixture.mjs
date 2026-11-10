import http from 'node:http';
import { once } from 'node:events';

export async function listenHttp(t, handler) {
  const server = http.createServer(handler);
  t.after(async () => {
    try {
      await handler.close?.();
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { origin: `http://127.0.0.1:${server.address().port}`, server };
}

export function requestRaw(
  origin,
  pathname,
  { method = 'GET', headers, body, timeout, timeoutMessage } = {},
) {
  const { hostname, port } = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path: pathname, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    if (timeout !== undefined)
      req.setTimeout(timeout, () => req.destroy(new Error(timeoutMessage)));
    req.on('error', reject);
    req.end(body);
  });
}
