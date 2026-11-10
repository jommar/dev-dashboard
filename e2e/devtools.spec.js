import { test, expect } from './fixtures.js';
import { devtoolsFrame } from './data.js';
import { DEFAULT_DEVTOOLS_URL } from '../ui/devtools-defaults.js';

// The fixture's two rows: one running, one stopped on its own profile.
const RUNNING = 'b-3f9a2c7d';
const STOPPED = 'b-7c1d4e20';

const devtoolsRequests = ({ requests }) =>
  requests.filter(({ path }) => path.startsWith('/api/devtools/'));
const lastCall = ({ data }) => data.devtools.calls.at(-1);
const openDevtools = async (page) => {
  await page.goto('/#/devtools');
  await expect(page.getByTestId('panel-devtools')).toBeVisible();
  await expect(page.getByTestId(`devtools-row-${RUNNING}`)).toBeVisible();
};

test.describe('devtools panel', () => {
  test('panel lists both instances', async ({ page }) => {
    await openDevtools(page);
    await expect(page.getByTestId('devtools-browsers')).toBeVisible();

    const running = page.getByTestId(`devtools-row-${RUNNING}`);
    await expect(running.getByTestId(`devtools-label-${RUNNING}`)).toHaveText('Browser 3f9a');
    await expect(running.getByTestId(`devtools-port-${RUNNING}`)).toHaveText('9300');
    await expect(running.getByTestId(`devtools-url-${RUNNING}`)).toHaveText('about:blank');
    await expect(running.getByTestId(`devtools-pid-${RUNNING}`)).toHaveText('41001');
    await expect(running.getByTestId(`devtools-started-${RUNNING}`)).toHaveText(
      /just now|\d+[mhd] ago/,
    );
    await expect(running.getByTestId(`devtools-status-${RUNNING}`)).toHaveText('running');
    await expect(running.getByTestId(`devtools-status-${RUNNING}`)).toHaveAttribute(
      'data-status',
      'running',
    );
    // The running row stops; the stopped row starts.
    await expect(running.getByTestId(`devtools-stop-${RUNNING}`)).toBeVisible();
    await expect(running.getByTestId(`devtools-start-${RUNNING}`)).toHaveCount(0);

    const stopped = page.getByTestId(`devtools-row-${STOPPED}`);
    await expect(stopped.getByTestId(`devtools-label-${STOPPED}`)).toHaveText('QA login');
    await expect(stopped.getByTestId(`devtools-port-${STOPPED}`)).toHaveText('9301');
    await expect(stopped.getByTestId(`devtools-url-${STOPPED}`)).toHaveText(
      'https://example.invalid/login',
    );
    // A stopped instance has no pid, but the row still carries the cell.
    await expect(stopped.getByTestId(`devtools-pid-${STOPPED}`)).toHaveCount(1);
    await expect(stopped.getByTestId(`devtools-started-${STOPPED}`)).toHaveCount(1);
    await expect(stopped.getByTestId(`devtools-status-${STOPPED}`)).toHaveText('stopped');
    await expect(stopped.getByTestId(`devtools-status-${STOPPED}`)).toHaveAttribute(
      'data-status',
      'stopped',
    );
    await expect(stopped.getByTestId(`devtools-start-${STOPPED}`)).toBeVisible();
    await expect(stopped.getByTestId(`devtools-stop-${STOPPED}`)).toHaveCount(0);
  });

  test('launch adds a row', async ({ page, dashboard }) => {
    await openDevtools(page);
    const { id, port } = dashboard.data.devtools.nextLaunch;
    await expect(page.getByTestId(`devtools-row-${id}`)).toHaveCount(0);

    await expect(page.getByTestId('devtools-url-input')).toHaveAttribute(
      'placeholder',
      DEFAULT_DEVTOOLS_URL,
    );
    await page.getByTestId('devtools-label-input').fill('QA');
    await page.getByTestId('devtools-launch').click();

    await expect(page.getByTestId(`devtools-row-${id}`)).toBeVisible();
    await expect(page.getByTestId(`devtools-label-${id}`)).toHaveText('QA');
    await expect(page.getByTestId(`devtools-url-${id}`)).toHaveText(DEFAULT_DEVTOOLS_URL);
    await expect(page.getByTestId(`devtools-port-${id}`)).toHaveText(String(port));
    expect(lastCall(dashboard)).toMatchObject({
      method: 'POST',
      path: '/api/devtools/browsers',
      body: { label: 'QA' },
    });
  });

  test('stop turns a row stopped', async ({ page, dashboard }) => {
    await openDevtools(page);
    await page.getByTestId(`devtools-stop-${RUNNING}`).click();

    await expect(page.getByTestId(`devtools-status-${RUNNING}`)).toHaveText('stopped');
    await expect(page.getByTestId(`devtools-status-${RUNNING}`)).toHaveAttribute(
      'data-status',
      'stopped',
    );
    // The action flips to Start, and Stop is gone.
    await expect(page.getByTestId(`devtools-start-${RUNNING}`)).toBeVisible();
    await expect(page.getByTestId(`devtools-stop-${RUNNING}`)).toHaveCount(0);
    expect(lastCall(dashboard)).toEqual({
      method: 'POST',
      path: '/api/devtools/browsers/stop',
      body: { id: RUNNING },
    });
  });

  test('inactive tab makes no request', async ({ page, dashboard }) => {
    await page.goto('/#/home');
    await expect(page.getByTestId('panel-home')).toBeVisible();
    await expect(page.getByTestId('home-meta')).not.toContainText('loading');
    expect(devtoolsRequests(dashboard)).toEqual([]);

    // The same tab, opened, does read the registry: the gate is what held it back.
    await page.getByTestId('tab-devtools').click();
    await expect(page.getByTestId(`devtools-row-${RUNNING}`)).toBeVisible();
    await expect.poll(() => devtoolsRequests(dashboard).length).toBeGreaterThan(0);
  });
});

test('tools route', async ({ page }) => {
  await page.goto('/#/devtools');
  await expect(page.getByTestId('panel-devtools')).toBeVisible();
  await expect(page.getByTestId('panel-home')).toBeHidden();
  // The route is a tools entry: current inside the Tools group, never a primary link.
  const tab = page.getByTestId('tab-devtools');
  await expect(tab).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.nav-tools').getByTestId('tab-devtools')).toHaveCount(1);
  expect(
    await page.locator('.nav-primary a').evaluateAll((links) => links.map((el) => el.dataset.tab)),
  ).toEqual(['home', 'my-tickets', 'slack']);

  // Below 1200 px it lives behind the Tools disclosure and navigates on Enter.
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto('/#/home');
  const toggle = page.getByTestId('nav-tools-toggle');
  await expect(toggle).toBeVisible();
  await expect(page.getByTestId('tab-devtools')).toBeHidden();
  await toggle.click();
  await expect(page.getByTestId('tab-devtools')).toBeVisible();
  await page.getByTestId('tab-devtools').focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/devtools$/);
  await expect(page.getByTestId('panel-devtools')).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
});

test('remove drops a row and its profile', async ({ page, dashboard }) => {
  await openDevtools(page);
  await expect(page.getByTestId(`devtools-remove-${STOPPED}`)).toBeVisible();

  await page.getByTestId(`devtools-remove-${STOPPED}`).click();

  await expect(page.getByTestId(`devtools-row-${STOPPED}`)).toHaveCount(0);
  await expect(page.getByTestId(`devtools-row-${RUNNING}`)).toBeVisible();
  expect(lastCall(dashboard)).toEqual({
    method: 'POST',
    path: '/api/devtools/browsers/remove',
    body: { id: STOPPED },
  });
});

// -- the in-app viewer ----------------------------------------------------------------------------
// The page's EventSource is a mock that records each live view, so a spec decides what the browser
// "sent" and reads back what the viewer sent: the whole server side is these helpers.

const emitScreencast = (page, type, payload) =>
  page.evaluate(
    ([name, value]) => window.__dashboardMock.screencasts.at(-1).emit(name, value),
    [type, payload],
  );
const screencastState = (page) =>
  page.evaluate(() =>
    window.__dashboardMock.screencasts.map(({ url, readyState }) => ({ url, readyState })),
  );
const inputs = ({ data }) =>
  data.devtools.calls.filter(({ path }) => path === '/api/devtools/browsers/input');
const openViewer = async (page, id = RUNNING) => {
  await openDevtools(page);
  await page.getByTestId(`devtools-view-${id}`).click();
  await expect(page.getByTestId('devtools-viewer')).toBeVisible();
};
const goLive = async (page, frame = devtoolsFrame()) => {
  await emitScreencast(page, 'status', { status: 'live', reason: '' });
  await emitScreencast(page, 'target', {
    id: 'T1',
    title: 'Home',
    url: 'https://example.invalid/home',
  });
  await emitScreencast(page, 'frame', frame);
  await expect(page.getByTestId('devtools-viewer-status')).toHaveText('Live');
  await expect(page.getByTestId('devtools-viewer-image')).toBeVisible();
};
const takeControl = async (page) => {
  await page.getByTestId('devtools-viewer-control').click();
  await expect(page.getByTestId('devtools-viewer-control')).toHaveAttribute('aria-pressed', 'true');
};
const centreOfImage = async (page) => {
  const box = await page.getByTestId('devtools-viewer-image').boundingBox();
  return { box, x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
const eventTypes = (dashboard) => inputs(dashboard).map(({ body }) => body.event.type);

test.describe('devtools viewer', () => {
  test('only a running row offers View', async ({ page }) => {
    await openDevtools(page);
    await expect(page.getByTestId(`devtools-view-${RUNNING}`)).toBeVisible();
    await expect(page.getByTestId(`devtools-view-${STOPPED}`)).toHaveCount(0);
    await expect(page.getByTestId('devtools-viewer')).toHaveCount(0);
  });

  test('opens a live view of that browser and shows its state', async ({ page, dashboard }) => {
    await openViewer(page);
    await expect(page.getByTestId('devtools-viewer-title')).toHaveText('Browser 3f9a');
    await expect(page.getByTestId('devtools-viewer')).toHaveAttribute('aria-labelledby', /.+/);
    // Nothing has arrived yet: connecting, no picture, and no way to take control.
    await expect(page.getByTestId('devtools-viewer-status')).toHaveText('Connecting…');
    await expect(page.getByTestId('devtools-viewer-status')).toHaveAttribute('role', 'status');
    await expect(page.getByTestId('devtools-viewer-image')).toBeHidden();
    await expect(page.getByTestId('devtools-viewer-control')).toBeDisabled();
    const streams = await screencastState(page);
    expect(streams).toHaveLength(1);
    expect(streams[0].url).toContain(`/api/devtools/browsers/screencast?id=${RUNNING}`);

    await goLive(page);
    await expect(page.getByTestId('devtools-viewer-sub')).toHaveText(
      'Port 9300 · https://example.invalid/home',
    );
    await expect(page.getByTestId('devtools-viewer-hint')).toHaveText('View only.');
    await expect(page.getByTestId('devtools-viewer-control')).toBeEnabled();
    await expect(page.getByTestId('devtools-viewer-control')).toHaveText('Take control');
    await expect(page.getByTestId('devtools-viewer-image')).toHaveAttribute(
      'alt',
      'Live view of Browser 3f9a',
    );
    // Frames arrive on the stream: the dashboard never polls the server for them.
    expect(devtoolsRequests(dashboard).filter(({ path }) => path.includes('screencast'))).toEqual(
      [],
    );
  });

  test('paints each new frame into the same picture', async ({ page }) => {
    await openViewer(page);
    const first = devtoolsFrame([40, 90, 160]);
    const second = devtoolsFrame([160, 90, 40]);
    await goLive(page, first);
    const image = page.getByTestId('devtools-viewer-image');
    await expect(image).toHaveAttribute('src', `data:image/jpeg;base64,${first.data}`);
    await emitScreencast(page, 'frame', second);
    await expect(image).toHaveAttribute('src', `data:image/jpeg;base64,${second.data}`);
  });

  test('is view-only: clicks and keys reach the browser only after Take control', async ({
    page,
    dashboard,
  }) => {
    await openViewer(page);
    await goLive(page);
    const { x, y } = await centreOfImage(page);
    await page.mouse.click(x, y);
    await page.mouse.wheel(0, 120);
    await page.getByTestId('devtools-viewer-stage').focus();
    await page.keyboard.type('hello');
    expect(inputs(dashboard)).toEqual([]);
  });

  test('take control forwards a click as device coordinates through a letterboxed frame', async ({
    page,
    dashboard,
  }) => {
    // A short window caps the picture's height, so the 16:9 image is centred with bars at each side.
    await page.setViewportSize({ width: 1200, height: 560 });
    await openViewer(page);
    await goLive(page);
    await takeControl(page);
    await expect(page.getByTestId('devtools-viewer-stage')).toHaveAttribute('data-control', 'true');
    await expect(page.getByTestId('devtools-viewer-hint')).toContainText('Esc releases control');

    const { box, x, y } = await centreOfImage(page);
    expect(box.width / box.height).toBeGreaterThan(2);
    // A click in a bar is on no point of the page; events go out in order, so if it had been sent
    // it would be the first press below.
    await page.mouse.click(box.x + 10, y);
    await page.mouse.click(x, y);
    await expect.poll(() => eventTypes(dashboard)).toContain('mouseReleased');
    const events = inputs(dashboard).map(({ body }) => body.event);
    const press = events.find(({ type }) => type === 'mousePressed');
    expect(inputs(dashboard)[0].body.id).toBe(RUNNING);
    expect(eventTypes(dashboard).filter((type) => type === 'mousePressed')).toHaveLength(1);
    expect(press).toMatchObject({ button: 'left', clickCount: 1 });
    // One screen pixel is about two page pixels here, so the middle is the middle to within that.
    expect(Math.abs(press.x - 640)).toBeLessThan(4);
    expect(Math.abs(press.y - 360)).toBeLessThan(4);
    expect(events.find(({ type }) => type === 'mouseReleased')).toMatchObject({ button: 'left' });
    expect(eventTypes(dashboard).indexOf('mousePressed')).toBeLessThan(
      eventTypes(dashboard).indexOf('mouseReleased'),
    );

    // A quarter of the way into the drawn picture, not into the element, is a quarter of the page.
    const drawnWidth = (box.height * 16) / 9;
    const left = box.x + (box.width - drawnWidth) / 2;
    await page.mouse.move(left + drawnWidth / 4, box.y + box.height / 4);
    await expect.poll(() => Math.abs(inputs(dashboard).at(-1).body.event.x - 320)).toBeLessThan(4);
    expect(inputs(dashboard).at(-1).body.event.type).toBe('mouseMoved');
    expect(Math.abs(inputs(dashboard).at(-1).body.event.y - 180)).toBeLessThan(4);
  });

  test('take control forwards the wheel and typed keys', async ({ page, dashboard }) => {
    await openViewer(page);
    await goLive(page);
    await takeControl(page);
    const { x, y } = await centreOfImage(page);

    await page.mouse.move(x, y);
    await page.mouse.wheel(0, 120);
    await expect.poll(() => eventTypes(dashboard)).toContain('wheel');
    const wheel = inputs(dashboard)
      .map(({ body }) => body.event)
      .find(({ type }) => type === 'wheel');
    expect(wheel.deltaY).toBe(120);

    await page.keyboard.type('a');
    await page.keyboard.press('ArrowLeft');
    const keys = () =>
      inputs(dashboard)
        .map(({ body }) => body.event)
        .filter((event) => event.key);
    await expect.poll(() => keys().length).toBe(4);
    expect(keys()).toMatchObject([
      { type: 'keyDown', key: 'a', text: 'a' },
      { type: 'keyUp', key: 'a' },
      { type: 'keyDown', key: 'ArrowLeft' },
      { type: 'keyUp', key: 'ArrowLeft' },
    ]);
    expect(keys()[2].text).toBeUndefined();
  });

  test('releasing control stops forwarding; Escape releases before it closes', async ({
    page,
    dashboard,
  }) => {
    await openViewer(page);
    await goLive(page);
    await takeControl(page);
    await page.keyboard.press('Escape');
    // The first Escape is the release: the viewer is still open, and view-only again.
    await expect(page.getByTestId('devtools-viewer-control')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await expect(page.getByTestId('devtools-viewer')).toBeVisible();
    await expect(page.getByTestId('devtools-viewer-hint')).toHaveText('View only.');
    // Escape was never forwarded as a key.
    expect(inputs(dashboard).filter(({ body }) => body.event.key === 'Escape')).toEqual([]);

    const before = inputs(dashboard).length;
    const { x, y } = await centreOfImage(page);
    await page.mouse.click(x, y);
    await page.keyboard.type('x');
    expect(inputs(dashboard).length).toBe(before);

    // The same toggle, by button.
    await takeControl(page);
    await page.getByTestId('devtools-viewer-control').click();
    await expect(page.getByTestId('devtools-viewer-control')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  test('shows a lost connection and gives control back', async ({ page }) => {
    await openViewer(page);
    await goLive(page);
    await takeControl(page);

    await emitScreencast(page, 'status', { status: 'connecting', reason: 'reconnecting' });
    await expect(page.getByTestId('devtools-viewer-status')).toHaveText('Reconnecting…');
    await expect(page.getByTestId('devtools-viewer-status')).toHaveAttribute(
      'data-status',
      'connecting',
    );
    await expect(page.getByTestId('devtools-viewer-control')).toBeDisabled();
    await expect(page.getByTestId('devtools-viewer-stage')).toHaveAttribute(
      'data-control',
      'false',
    );
    // The last picture stays up behind the status, rather than the viewer going blank.
    await expect(page.getByTestId('devtools-viewer-image')).toBeVisible();

    await emitScreencast(page, 'status', { status: 'lost', reason: 'unreachable' });
    await expect(page.getByTestId('devtools-viewer-status')).toHaveText('Browser not reachable');
    await expect(page.getByTestId('devtools-viewer-status')).toHaveAttribute('data-status', 'lost');

    await emitScreencast(page, 'status', { status: 'live', reason: '' });
    await expect(page.getByTestId('devtools-viewer-status')).toHaveText('Live');
    await expect(page.getByTestId('devtools-viewer-control')).toBeEnabled();
  });

  test('a stopped browser ends the stream for good', async ({ page }) => {
    await openViewer(page);
    await goLive(page);
    await emitScreencast(page, 'status', { status: 'lost', reason: 'stopped' });
    await expect(page.getByTestId('devtools-viewer-status')).toHaveText('Browser stopped');
    await expect.poll(async () => (await screencastState(page))[0].readyState).toBe(2);
  });

  test('closing the viewer closes the stream and returns focus to View', async ({ page }) => {
    await openViewer(page);
    await goLive(page);
    await page.getByTestId('devtools-viewer-close').click();
    await expect(page.getByTestId('devtools-viewer')).toHaveCount(0);
    await expect.poll(async () => (await screencastState(page))[0].readyState).toBe(2);
    await expect(page.getByTestId(`devtools-view-${RUNNING}`)).toBeFocused();

    // Opening it again is a new stream, not a revived one.
    await page.getByTestId(`devtools-view-${RUNNING}`).click();
    await expect(page.getByTestId('devtools-viewer')).toBeVisible();
    expect(await screencastState(page)).toHaveLength(2);
  });

  test('Escape closes a view-only viewer', async ({ page }) => {
    await openViewer(page);
    await goLive(page);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('devtools-viewer')).toHaveCount(0);
    await expect.poll(async () => (await screencastState(page))[0].readyState).toBe(2);
  });
});
