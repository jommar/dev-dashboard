import { build, preview } from 'vite';
import { fileURLToPath } from 'node:url';

// The UI suite runs against a production build of the app, not the Vite dev server: no module
// transform per request, no HMR socket, and the bundle that ships is the bundle under test. The
// build is unminified so a page error keeps readable names, and it goes to its own folder so it
// never touches `dist/`, which `node --test` rebuilds. `appType: 'mpa'` keeps unknown paths a 404
// instead of falling back to index.html, so only the built files are served.
process.env.NODE_ENV = 'production';

const root = fileURLToPath(new URL('../', import.meta.url));
const outDir = fileURLToPath(new URL('../test-results/e2e-dist', import.meta.url));

await build({
  configFile: fileURLToPath(new URL('../vite.config.js', import.meta.url)),
  logLevel: 'warn',
  build: { outDir, emptyOutDir: true, minify: false },
});

const server = await preview({
  configFile: false,
  root,
  appType: 'mpa',
  logLevel: 'warn',
  build: { outDir },
  preview: { host: '127.0.0.1', port: 6517, strictPort: true },
  plugins: [
    {
      name: 'dashboard-playwright-entry',
      configurePreviewServer(vite) {
        vite.middlewares.use((req, res, next) => {
          res.setHeader(
            'Content-Security-Policy',
            "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; frame-src 'none'",
          );
          const pathname = req.url?.split('?')[0] || '';
          if (pathname === '/__proxy-test') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<!doctype html><html><body>proxy test</body></html>');
            return;
          }
          if (
            pathname.startsWith('/api/') ||
            ['/backend/server.mjs', '/backend/manager.mjs', '/package.json'].includes(pathname) ||
            !['GET', 'HEAD'].includes(req.method)
          ) {
            res.writeHead(404).end();
            return;
          }
          next();
        });
      },
    },
  ],
});
console.log('Built React UI fixture: http://127.0.0.1:6517 (APIs require browser mocks)');
process.on('SIGTERM', async () => {
  await server.close();
});
