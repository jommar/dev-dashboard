import { createServer as createViteServer } from 'vite';

const server = await createViteServer({
  configFile: false,
  root: new URL('../', import.meta.url).pathname,
  appType: 'spa',
  server: { host: '127.0.0.1', port: 6517, strictPort: true },
  plugins: [
    {
      name: 'dashboard-playwright-entry',
      configureServer(vite) {
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
          if (pathname === '/') req.url = '/ui-react/index.html';
          next();
        });
      },
      transformIndexHtml(html) {
        return html.replace('src="./main.jsx"', 'src="/ui-react/main.jsx"');
      },
    },
  ],
});
await server.listen();
console.log('Vite React UI fixture: http://127.0.0.1:6517 (APIs require browser mocks)');
process.on('SIGTERM', async () => {
  await server.close();
});
