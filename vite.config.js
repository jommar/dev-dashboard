import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { DASHBOARD_HOST, DASHBOARD_PORT } from './config.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.resolve(root, 'ui-react');
const proxyTarget = new URL(
  process.env.DASHBOARD_PROXY_TARGET || `http://${DASHBOARD_HOST}:${DASHBOARD_PORT}`,
);
if (
  proxyTarget.protocol !== 'http:' ||
  !['127.0.0.1', 'localhost', '[::1]'].includes(proxyTarget.hostname) ||
  proxyTarget.username ||
  proxyTarget.password ||
  !proxyTarget.port ||
  proxyTarget.pathname !== '/' ||
  proxyTarget.search ||
  proxyTarget.hash
) {
  throw new Error('DASHBOARD_PROXY_TARGET must be an explicit loopback HTTP authority.');
}
const proxyOrigin = proxyTarget.origin;
const proxyAuthority = proxyTarget.host;
const devOrigin = new URL(process.env.DASHBOARD_VITE_ORIGIN || 'http://localhost:5173').origin;
const devAuthority = new URL(devOrigin).host;

const proxyTestPlugin = {
  name: 'vite-proxy-test-page',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url?.split('?')[0].startsWith('/api/')) {
        let requestOrigin;
        try {
          requestOrigin = req.headers.origin ? new URL(req.headers.origin).origin : null;
        } catch {}
        if (req.headers.host !== devAuthority || (requestOrigin && requestOrigin !== devOrigin)) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(
            JSON.stringify({
              code: req.headers.host !== devAuthority ? 'INVALID_HOST' : 'INVALID_ORIGIN',
              error: 'Invalid authority.',
            }),
          );
          return;
        }
      }
      if (
        process.env.DASHBOARD_VITE_PROXY_TEST !== '1' ||
        req.method !== 'GET' ||
        req.url !== '/__proxy-test'
      )
        return next();
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(
        '<!doctype html><html><head><title>Vite proxy integration</title></head><body>proxy test</body></html>',
      );
    });
  },
};

export default defineConfig({
  root: uiRoot,
  plugins: [proxyTestPlugin],
  build: {
    outDir: path.resolve(root, 'dist'),
    emptyOutDir: true,
    rolldownOptions: {
      input: path.resolve(uiRoot, 'index.html'),
      onLog(level, log, defaultHandler) {
        const source = log.id ?? log.loc?.file ?? '';
        const fromMui = /(?:^|[/\\])node_modules[/\\]@mui[/\\]/.test(source);
        if (
          level === 'warn' &&
          log.code === 'MODULE_LEVEL_DIRECTIVE' &&
          fromMui &&
          log.message.includes('"use client"')
        ) {
          return;
        }
        defaultHandler(level, log);
      },
    },
  },
  server: {
    proxy: {
      '^/api(?:/|$)': {
        target: proxyOrigin,
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (proxyRequest, req) => {
            const requestOrigin = req.headers.origin;
            if (requestOrigin) proxyRequest.setHeader('origin', proxyOrigin);
            proxyRequest.setHeader('host', proxyAuthority);
          });
        },
      },
    },
  },
});
