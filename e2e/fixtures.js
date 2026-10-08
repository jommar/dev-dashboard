import { test as base, expect } from '@playwright/test';
import { apiResponse, dashboardData } from './data.js';

export async function installDashboardMocks(context, baseURL, data = dashboardData()) {
  const requests = [];
  const unexpected = [];
  const pageErrors = [];
  context.on('page', (page) =>
    page.on('pageerror', (error) => pageErrors.push(`${error.message}\n${error.stack || ''}`)),
  );
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    requests.push({ method, path: url.pathname + url.search });
    if (url.origin !== baseURL && method === 'GET') return route.continue();
    if (url.origin === baseURL) {
      const response = apiResponse(
        url,
        method,
        data,
        request.postData() ? request.postDataJSON() : undefined,
      );
      if (response) return route.fulfill(response);
      if (
        method === 'GET' &&
        (url.pathname === '/' ||
          url.pathname.startsWith('/@') ||
          url.pathname.startsWith('/node_modules/') ||
          url.pathname.startsWith('/ui-react/') ||
          url.pathname.startsWith('/ui/'))
      ) {
        return route.continue();
      }
      if (url.pathname.startsWith('/api/')) {
        unexpected.push(`${method} ${url.href}`);
        await route.abort('blockedbyclient');
        return;
      }
      if (method === 'GET' && url.pathname === '/favicon.ico')
        return route.fulfill({ status: 204 });
    }
    unexpected.push(`${method} ${url.href}`);
    await route.abort('blockedbyclient');
  });
  await context.routeWebSocket('**/*', (socket) => {
    if (!socket.url().includes('/?token=')) unexpected.push(`WebSocket ${socket.url()}`);
    socket.close();
  });
  await context.exposeBinding('__unexpectedDashboardNetwork', (_source, url) =>
    unexpected.push(url),
  );
  await context.addInitScript(
    ({ services }) => {
      document.addEventListener('securitypolicyviolation', (event) => {
        window.__unexpectedDashboardNetwork(`CSP ${event.blockedURI}`);
      });
      const streams = [];
      const clipboard = { writes: [], error: null };
      class MockEventSource extends EventTarget {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSED = 2;
        CONNECTING = 0;
        OPEN = 1;
        CLOSED = 2;
        constructor(url) {
          super();
          this.url = new URL(url, location.href).href;
          this.readyState = 0;
          this.onopen = null;
          this.onmessage = null;
          this.onerror = null;
          if (this.url !== location.origin + '/api/events') {
            window.__unexpectedDashboardNetwork(`EventSource ${this.url}`);
            this.readyState = 2;
            return;
          }
          streams.push(this);
          setTimeout(() => {
            if (this.readyState === 2) return;
            this.emit('open');
            this.emit('message', services);
          }, 0);
        }
        emit(type, snapshot) {
          if (this.readyState === 2) return;
          if (type === 'open') this.readyState = 1;
          if (type === 'error') this.readyState = 0;
          const event =
            type === 'message' || type === 'setup-required'
              ? new MessageEvent(type, { data: JSON.stringify(snapshot) })
              : new Event(type);
          this.dispatchEvent(event);
          this['on' + type]?.(event);
        }
        close() {
          this.readyState = 2;
        }
      }
      window.EventSource = MockEventSource;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          async writeText(text) {
            if (clipboard.error) throw new Error(clipboard.error);
            clipboard.writes.push(text);
          },
          async readText() {
            return clipboard.writes.at(-1) || '';
          },
        },
      });
      window.__dashboardMock = { streams, clipboard };
    },
    { services: data.services },
  );
  return { data, requests, unexpected, pageErrors };
}

export const test = base.extend({
  dashboardFixture: [null, { option: true }],
  dashboard: [
    async ({ context, baseURL, dashboardFixture }, use) => {
      const mock = await installDashboardMocks(
        context,
        baseURL,
        dashboardFixture || dashboardData(),
      );
      await use(mock);
      expect(mock.unexpected, 'Unexpected network was blocked').toEqual([]);
      expect(mock.pageErrors, 'Browser runtime errors').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
