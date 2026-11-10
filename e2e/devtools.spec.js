import { test, expect } from './fixtures.js';
import { devtoolsFrame, devtoolsTabs, devtoolsWallData } from './data.js';
import { DEFAULT_DEVTOOLS_URL } from '../ui/devtools-defaults.js';

// The fixture's four tiles: three running (each on its own port) and one stopped.
const RUNNING = 'b-3f9a2c7d';
const STOPPED = 'b-7c1d4e20';
const CHECKOUT = 'b-a41e90c2';
const REPORTS = 'b-d90b5e13';
const LIVE_IDS = [RUNNING, CHECKOUT, REPORTS];
const STREAM_PATH = '/api/devtools/stream';
// The stream closes a moment after its last watcher (so a scroll that swaps every tile reopens nothing).
const STREAM_CLOSES = { timeout: 5000 };

const devtoolsRequests = ({ requests }) =>
  requests.filter(({ path }) => path.startsWith('/api/devtools/'));
const lastCall = ({ data }) => data.devtools.calls.at(-1);
const subscriptions = ({ data }) => ({ ...data.devtools.subscriptions });
const tile = (page, id) => page.getByTestId(`devtools-tile-${id}`);
const everyTile = async (page, check) => {
  for (const id of LIVE_IDS) await check(tile(page, id), id);
};

const openDevtools = async (page) => {
  await page.goto('/#/devtools');
  await expect(page.getByTestId('panel-devtools')).toBeVisible();
  await expect(tile(page, RUNNING)).toBeVisible();
};
// The wall once every running tile is watching: the stream has said hello and each tile subscribed.
const openWall = async (page, dashboard) => {
  await openDevtools(page);
  await expect
    .poll(() => subscriptions(dashboard))
    .toEqual(Object.fromEntries(LIVE_IDS.map((id) => [id, 'tile'])));
};

// -- what the server says -----------------------------------------------------------------------
// The page's EventSource is a mock that records each live stream, so a spec decides what the server
// "sent" and reads back what the page asked of it: the whole server side is these helpers. Messages
// are tagged with a browser's id, as on the real stream.

const tagged = (type, payload, id) =>
  type === 'target'
    ? { id, targetId: payload.id, title: payload.title, url: payload.url }
    : { id, ...payload };
const emitScreencast = (page, type, payload, id = RUNNING) =>
  page.evaluate(
    ([name, value]) => window.__dashboardMock.screencasts.at(-1).emit(name, value),
    [type, tagged(type, payload, id)],
  );
const screencastState = (page) =>
  page.evaluate(() =>
    window.__dashboardMock.screencasts.map(({ url, readyState }) => ({ url, readyState })),
  );
// A browser that is up, showing a page, with a picture.
const goLiveTile = async (page, id, { title = 'Home', frame = devtoolsFrame() } = {}) => {
  await emitScreencast(page, 'status', { status: 'live', reason: '' }, id);
  await emitScreencast(
    page,
    'target',
    { id: 'T1', title, url: 'https://example.invalid/home' },
    id,
  );
  await emitScreencast(page, 'frame', frame, id);
};
const imageOf = (page, id) => page.getByTestId(`devtools-image-${id}`);
const srcOf = ({ data }) => `data:image/jpeg;base64,${data}`;

// -- the wall -----------------------------------------------------------------------------------

test.describe('devtools wall', () => {
  test('shows a tile for each browser, with its label, port, state and details', async ({
    page,
  }) => {
    await openDevtools(page);
    await expect(page.getByTestId('devtools-browsers')).toBeVisible();
    const wall = page.getByRole('list', { name: 'Debug browsers' });
    await expect(wall.getByRole('listitem')).toHaveCount(4);
    await expect(page.getByTestId('devtools-meta')).toHaveText('3 running · 4 total');

    const running = tile(page, RUNNING);
    await expect(running.getByTestId(`devtools-label-${RUNNING}`)).toHaveText('Browser 3f9a');
    await expect(running.getByTestId(`devtools-port-${RUNNING}`)).toHaveText('9300');
    // Up, but the stream has not said anything yet: written as well as coloured.
    await expect(running.getByTestId(`devtools-status-${RUNNING}`)).toHaveText('Connecting');
    await expect(running.getByTestId(`devtools-status-${RUNNING}`)).toHaveAttribute(
      'data-status',
      'connecting',
    );
    await expect(running.getByTestId(`devtools-stop-${RUNNING}`)).toBeVisible();
    await expect(running.getByTestId(`devtools-restart-${RUNNING}`)).toBeVisible();
    await expect(running.getByTestId(`devtools-start-${RUNNING}`)).toHaveCount(0);
    await expect(running.getByTestId(`devtools-remove-${RUNNING}`)).toBeVisible();

    // What the table showed is a disclosure away: nothing was dropped.
    await expect(running.getByTestId(`devtools-url-${RUNNING}`)).toBeHidden();
    await running.getByText('Details', { exact: true }).click();
    await expect(running.getByTestId(`devtools-url-${RUNNING}`)).toHaveText('about:blank');
    await expect(running.getByTestId(`devtools-pid-${RUNNING}`)).toHaveText('41001');
    await expect(running.getByTestId(`devtools-profile-${RUNNING}`)).toHaveText(
      '/home/example/.config/dev-dashboard/browsers/b-3f9a2c7d/profile',
    );
    await expect(running.getByTestId(`devtools-started-${RUNNING}`)).toHaveText(
      /just now|\d+[mhd] ago/,
    );

    const stopped = tile(page, STOPPED);
    await expect(stopped.getByTestId(`devtools-label-${STOPPED}`)).toHaveText('QA login');
    await expect(stopped.getByTestId(`devtools-port-${STOPPED}`)).toHaveText('9301');
    await expect(stopped.getByTestId(`devtools-status-${STOPPED}`)).toHaveText('Stopped');
    await expect(stopped.getByTestId(`devtools-status-${STOPPED}`)).toHaveAttribute(
      'data-status',
      'stopped',
    );
    await stopped.getByText('Details', { exact: true }).click();
    await expect(stopped.getByTestId(`devtools-url-${STOPPED}`)).toHaveText(
      'https://example.invalid/login',
    );
    await expect(stopped.getByTestId(`devtools-pid-${STOPPED}`)).toHaveText('—');
  });

  test('names each tile and its actions with the label and the port', async ({ page }) => {
    await openDevtools(page);
    await expect(
      page.getByRole('button', { name: 'Open the live view of Browser 3f9a, port 9300' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop Browser 3f9a, port 9300' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Restart Browser 3f9a, port 9300' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Remove Browser 3f9a, port 9300' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start QA login, port 9301' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 3, name: 'QA login' })).toBeVisible();
    await expect(
      page.getByRole('group', { name: 'Actions for Browser 3f9a, port 9300' }),
    ).toBeVisible();
  });

  test('opens exactly one stream, whatever the number of tiles', async ({ page, dashboard }) => {
    await openWall(page, dashboard);
    const streams = await screencastState(page);
    expect(streams).toHaveLength(1);
    expect(new URL(streams[0].url).pathname).toBe(STREAM_PATH);
    expect(streams[0].readyState).toBe(1);
    // One subscription per running tile, at tile quality, each naming the stream the server said.
    const calls = dashboard.data.devtools.streamCalls;
    expect(calls).toHaveLength(3);
    for (const { path, body } of calls) {
      expect(path).toBe('/api/devtools/stream/subscribe');
      expect(body).toMatchObject({ stream: 'e2e-stream-00000001', quality: 'tile' });
    }
    // The old per-browser stream is not there to be asked for.
    expect(devtoolsRequests(dashboard).filter(({ path }) => path.includes('screencast'))).toEqual(
      [],
    );
  });

  test('paints each tile with its own frames, and says its state and page', async ({
    page,
    dashboard,
  }) => {
    await openWall(page, dashboard);
    await expect(imageOf(page, RUNNING)).toBeHidden();
    const first = devtoolsFrame([40, 90, 160]);
    const second = devtoolsFrame([160, 90, 40]);
    await goLiveTile(page, RUNNING, { title: 'Admin home', frame: first });
    await goLiveTile(page, CHECKOUT, { title: 'Checkout', frame: second });

    await expect(imageOf(page, RUNNING)).toBeVisible();
    await expect(imageOf(page, RUNNING)).toHaveAttribute('src', srcOf(first));
    await expect(imageOf(page, CHECKOUT)).toHaveAttribute('src', srcOf(second));
    await expect(page.getByTestId(`devtools-status-${RUNNING}`)).toHaveText('Live');
    await expect(page.getByTestId(`devtools-status-${RUNNING}`)).toHaveAttribute(
      'data-status',
      'live',
    );
    await expect(page.getByTestId(`devtools-title-${RUNNING}`)).toHaveText('Admin home');
    await expect(page.getByTestId(`devtools-title-${CHECKOUT}`)).toHaveText('Checkout');
    // A tile that has heard nothing is unchanged, and a live picture needs no overlay over it.
    await expect(imageOf(page, REPORTS)).toBeHidden();
    await expect(page.getByTestId(`devtools-status-${REPORTS}`)).toHaveText('Connecting');
    await expect(page.getByTestId(`devtools-overlay-${RUNNING}`)).toHaveCount(0);
    await expect(page.getByTestId(`devtools-overlay-${REPORTS}`)).toHaveText('Connecting');

    // The page named is the shown tab of the strip, once the stream sends one.
    await emitScreencast(page, 'tabs', devtoolsTabs('T3'), RUNNING);
    await expect(page.getByTestId(`devtools-title-${RUNNING}`)).toHaveText('Checkout');
    // Frames repaint the same picture.
    const next = devtoolsFrame([90, 160, 40]);
    await emitScreencast(page, 'frame', next, RUNNING);
    await expect(imageOf(page, RUNNING)).toHaveAttribute('src', srcOf(next));
  });

  test('a long page title is cut short, not allowed to widen the tile', async ({
    page,
    dashboard,
  }) => {
    await openWall(page, dashboard);
    const before = await tile(page, RUNNING).boundingBox();
    await goLiveTile(page, RUNNING, { title: 'An extremely long page title '.repeat(12) });
    await expect(page.getByTestId(`devtools-title-${RUNNING}`)).toContainText('An extremely long');
    const after = await tile(page, RUNNING).boundingBox();
    expect(after.width).toBe(before.width);
    expect(after.height).toBe(before.height);
  });

  test('keeps the picture 16:10 whatever shape the frame is, so nothing moves', async ({
    page,
    dashboard,
  }) => {
    await openWall(page, dashboard);
    const frameBox = () => page.getByTestId(`devtools-open-${RUNNING}`).boundingBox();
    const empty = await frameBox();
    expect(Math.abs(empty.width / empty.height - 1.6)).toBeLessThan(0.02);
    await goLiveTile(page, RUNNING);
    await expect(imageOf(page, RUNNING)).toBeVisible();
    const wide = await tile(page, RUNNING).boundingBox();
    await emitScreencast(page, 'frame', devtoolsFrame([40, 160, 90], [90, 160]), RUNNING);
    await expect(imageOf(page, RUNNING)).toHaveAttribute('src', /./);
    const tall = await frameBox();
    expect(tall).toEqual(empty);
    expect(await tile(page, RUNNING).boundingBox()).toEqual(wide);
    // The image is fitted inside the frame, never stretched.
    expect(await imageOf(page, RUNNING).evaluate((el) => getComputedStyle(el).objectFit)).toBe(
      'contain',
    );
  });

  test('a connecting or lost browser shows its state over its last picture', async ({
    page,
    dashboard,
  }) => {
    await openWall(page, dashboard);
    await goLiveTile(page, RUNNING);
    await emitScreencast(page, 'status', { status: 'connecting', reason: 'reconnecting' });
    await expect(page.getByTestId(`devtools-status-${RUNNING}`)).toHaveText('Reconnecting');
    await expect(page.getByTestId(`devtools-overlay-${RUNNING}`)).toHaveText('Reconnecting');
    await expect(imageOf(page, RUNNING)).toBeVisible();

    await emitScreencast(page, 'status', { status: 'lost', reason: 'unreachable' });
    await expect(page.getByTestId(`devtools-status-${RUNNING}`)).toHaveText('Lost · Not reachable');
    await expect(page.getByTestId(`devtools-status-${RUNNING}`)).toHaveAttribute(
      'data-status',
      'lost',
    );
    await expect(imageOf(page, RUNNING)).toBeVisible();

    await emitScreencast(page, 'status', { status: 'live', reason: '' });
    await expect(page.getByTestId(`devtools-status-${RUNNING}`)).toHaveText('Live');
    await expect(page.getByTestId(`devtools-overlay-${RUNNING}`)).toHaveCount(0);
  });

  test('a stopped browser is a placeholder with a Start action, and Start makes it a live tile', async ({
    page,
    dashboard,
  }) => {
    await openWall(page, dashboard);
    await expect(page.getByTestId(`devtools-placeholder-${STOPPED}`)).toBeVisible();
    await expect(page.getByTestId(`devtools-open-${STOPPED}`)).toHaveCount(0);
    await expect(page.getByTestId(`devtools-image-${STOPPED}`)).toHaveCount(0);
    expect(subscriptions(dashboard)[STOPPED]).toBeUndefined();

    await page.getByTestId(`devtools-start-${STOPPED}`).click();
    await expect(page.getByTestId(`devtools-open-${STOPPED}`)).toBeVisible();
    await expect(page.getByTestId(`devtools-placeholder-${STOPPED}`)).toHaveCount(0);
    await expect(page.getByTestId(`devtools-stop-${STOPPED}`)).toBeVisible();
    expect(lastCall(dashboard)).toEqual({
      method: 'POST',
      path: '/api/devtools/browsers/start',
      body: { id: STOPPED },
    });
    // It joined the wall's one stream rather than opening its own.
    await expect.poll(() => subscriptions(dashboard)[STOPPED]).toBe('tile');
    expect(await screencastState(page)).toHaveLength(1);
  });

  test('launch adds a tile', async ({ page, dashboard }) => {
    await openDevtools(page);
    const { id, port } = dashboard.data.devtools.nextLaunch;
    await expect(tile(page, id)).toHaveCount(0);

    await expect(page.getByTestId('devtools-url-input')).toHaveAttribute(
      'placeholder',
      DEFAULT_DEVTOOLS_URL,
    );
    await page.getByTestId('devtools-label-input').fill('QA');
    await page.getByTestId('devtools-launch').click();

    await expect(tile(page, id)).toBeVisible();
    await expect(page.getByTestId(`devtools-label-${id}`)).toHaveText('QA');
    await expect(page.getByTestId(`devtools-port-${id}`)).toHaveText(String(port));
    await tile(page, id).getByText('Details', { exact: true }).click();
    await expect(page.getByTestId(`devtools-url-${id}`)).toHaveText(DEFAULT_DEVTOOLS_URL);
    expect(lastCall(dashboard)).toMatchObject({
      method: 'POST',
      path: '/api/devtools/browsers',
      body: { label: 'QA' },
    });
    await expect.poll(() => subscriptions(dashboard)[id]).toBe('tile');
  });

  test('stop turns a tile into a stopped placeholder and lets its stream go', async ({
    page,
    dashboard,
  }) => {
    await openWall(page, dashboard);
    await goLiveTile(page, RUNNING);
    await page.getByTestId(`devtools-stop-${RUNNING}`).click();

    await expect(page.getByTestId(`devtools-status-${RUNNING}`)).toHaveText('Stopped');
    await expect(page.getByTestId(`devtools-status-${RUNNING}`)).toHaveAttribute(
      'data-status',
      'stopped',
    );
    // The action flips to Start, the picture is gone, and the browser is no longer watched.
    await expect(page.getByTestId(`devtools-start-${RUNNING}`)).toBeVisible();
    await expect(page.getByTestId(`devtools-stop-${RUNNING}`)).toHaveCount(0);
    await expect(page.getByTestId(`devtools-restart-${RUNNING}`)).toHaveCount(0);
    await expect(page.getByTestId(`devtools-placeholder-${RUNNING}`)).toBeVisible();
    await expect(page.getByTestId(`devtools-title-${RUNNING}`)).toHaveText('');
    expect(lastCall(dashboard)).toEqual({
      method: 'POST',
      path: '/api/devtools/browsers/stop',
      body: { id: RUNNING },
    });
    await expect.poll(() => subscriptions(dashboard)[RUNNING]).toBeUndefined();
    expect(subscriptions(dashboard)).toEqual({ [CHECKOUT]: 'tile', [REPORTS]: 'tile' });
  });

  test('restart stops and starts it again, ending with a running tile', async ({
    page,
    dashboard,
  }) => {
    await openWall(page, dashboard);
    await page.getByTestId(`devtools-restart-${RUNNING}`).click();
    await expect(page.getByTestId('devtools-feedback')).toHaveText('Restarted Browser 3f9a.');
    expect(
      dashboard.data.devtools.calls.map(({ path, body }) => [path.split('/').at(-1), body.id]),
    ).toEqual([
      ['stop', RUNNING],
      ['start', RUNNING],
    ]);
    await expect(page.getByTestId(`devtools-stop-${RUNNING}`)).toBeVisible();
    await expect(page.getByTestId(`devtools-open-${RUNNING}`)).toBeVisible();
    await expect.poll(() => subscriptions(dashboard)[RUNNING]).toBe('tile');
  });

  test('remove drops a tile and its profile', async ({ page, dashboard }) => {
    await openWall(page, dashboard);
    await expect(page.getByTestId(`devtools-remove-${STOPPED}`)).toBeVisible();

    await page.getByTestId(`devtools-remove-${STOPPED}`).click();

    await expect(tile(page, STOPPED)).toHaveCount(0);
    await expect(tile(page, RUNNING)).toBeVisible();
    expect(lastCall(dashboard)).toEqual({
      method: 'POST',
      path: '/api/devtools/browsers/remove',
      body: { id: STOPPED },
    });
    await expect(page.getByTestId('devtools-feedback')).toHaveText('Removed.');
  });

  test('removing every browser leaves the empty state, and closes the stream', async ({
    page,
    dashboard,
  }) => {
    await openWall(page, dashboard);
    for (const id of [STOPPED, ...LIVE_IDS])
      await page.getByTestId(`devtools-remove-${id}`).click();
    await expect(page.getByTestId('devtools-empty')).toHaveText(
      'No browsers yet — launch one above, sign in, then tell the agent its port.',
    );
    await expect
      .poll(async () => (await screencastState(page))[0].readyState, STREAM_CLOSES)
      .toBe(2);
    expect(subscriptions(dashboard)).toEqual({});
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
      await page
        .locator('.nav-primary a')
        .evaluateAll((links) => links.map((el) => el.dataset.tab)),
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

  test('inactive tab makes no request and opens no stream', async ({ page, dashboard }) => {
    await page.goto('/#/home');
    await expect(page.getByTestId('panel-home')).toBeVisible();
    await expect(page.getByTestId('home-meta')).not.toContainText('loading');
    expect(devtoolsRequests(dashboard)).toEqual([]);
    expect(await screencastState(page)).toEqual([]);

    // The same tab, opened, does read the registry: the gate is what held it back.
    await page.getByTestId('tab-devtools').click();
    await expect(tile(page, RUNNING)).toBeVisible();
    await expect.poll(() => devtoolsRequests(dashboard).length).toBeGreaterThan(0);
    await expect.poll(async () => (await screencastState(page)).length).toBe(1);

    // Leaving the screen pauses every tile: the stream closes and the server holds nothing.
    await page.getByTestId('tab-home').click();
    await expect
      .poll(async () => (await screencastState(page))[0].readyState, STREAM_CLOSES)
      .toBe(2);
    expect(subscriptions(dashboard)).toEqual({});
  });
});

// -- pausing what cannot be seen ------------------------------------------------------------------

const hideDocument = (page) =>
  page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
const showDocument = (page) =>
  page.evaluate(() => {
    delete document.visibilityState;
    document.dispatchEvent(new Event('visibilitychange'));
  });

test.describe('devtools wall, paused', () => {
  test('a hidden page pauses every tile and keeps its last picture, and showing it resumes', async ({
    page,
    dashboard,
  }) => {
    await openWall(page, dashboard);
    const frame = devtoolsFrame([40, 90, 160]);
    await goLiveTile(page, RUNNING, { frame });
    await expect(imageOf(page, RUNNING)).toHaveAttribute('src', srcOf(frame));

    await hideDocument(page);
    await expect.poll(() => subscriptions(dashboard)).toEqual({});
    await everyTile(page, async (it, id) => {
      await expect(it).toHaveAttribute('data-state', 'paused');
      await expect(page.getByTestId(`devtools-status-${id}`)).toHaveText('Paused');
    });
    // Nothing needs the stream: it is closed, and the picture stays up, marked as paused.
    await expect
      .poll(async () => (await screencastState(page))[0].readyState, STREAM_CLOSES)
      .toBe(2);
    await expect(imageOf(page, RUNNING)).toHaveAttribute('src', srcOf(frame));
    await expect(page.getByTestId(`devtools-overlay-${RUNNING}`)).toHaveText('Paused');
    await expect(page.getByTestId(`devtools-title-${RUNNING}`)).toHaveText('Home');

    await showDocument(page);
    await expect
      .poll(() => subscriptions(dashboard))
      .toEqual(Object.fromEntries(LIVE_IDS.map((id) => [id, 'tile'])));
    const streams = await screencastState(page);
    expect(streams).toHaveLength(2);
    expect(streams[1].readyState).toBe(1);
    await expect(page.getByTestId(`devtools-status-${RUNNING}`)).toHaveText('Connecting');
    await goLiveTile(page, RUNNING);
    await expect(page.getByTestId(`devtools-status-${RUNNING}`)).toHaveText('Live');
  });
});

test.describe('devtools wall, many browsers', () => {
  test.use({ dashboardFixture: { build: () => devtoolsWallData(20) } });
  test.use({ viewport: { width: 1440, height: 700 } });

  // Where each tile is against the scrolling pane, so the spec asserts on what is really on screen.
  const geometry = (page) =>
    page.evaluate(() => {
      const pane = document
        .querySelector('[data-testid="devtools-browsers"]')
        .getBoundingClientRect();
      return [...document.querySelectorAll('[data-testid^="devtools-tile-"]')].map((el) => {
        const box = el.getBoundingClientRect();
        return {
          id: el.dataset.testid.replace('devtools-tile-', ''),
          near: box.bottom > pane.top - 40 && box.top < pane.bottom + 40,
          far: box.bottom < pane.top - 60 || box.top > pane.bottom + 60,
        };
      });
    });
  const expectWatchedAre = async (page, dashboard, pick) => {
    await expect
      .poll(async () => {
        const held = Object.keys(subscriptions(dashboard)).sort();
        const tiles = await geometry(page);
        const near = tiles.filter((it) => it.near).map((it) => it.id);
        const far = tiles.filter((it) => it.far).map((it) => it.id);
        return {
          allNearHeld: near.every((id) => held.includes(id)),
          noneFarHeld: far.every((id) => !held.includes(id)),
          some: near.length > 0 && far.length > 0 && pick(held, near, far),
        };
      })
      .toEqual({ allNearHeld: true, noneFarHeld: true, some: true });
  };

  test('a tile out of the pane lets go, and takes hold again when it scrolls back', async ({
    page,
    dashboard,
  }) => {
    await page.goto('/#/devtools');
    await expect(tile(page, 'b-w001')).toBeVisible();
    // The first row is watched; the rows further down are not.
    await expectWatchedAre(page, dashboard, (held) => held.includes('b-w001'));
    expect(subscriptions(dashboard)['b-w020']).toBeUndefined();
    expect(await screencastState(page)).toHaveLength(1);

    const frame = devtoolsFrame([40, 90, 160]);
    await goLiveTile(page, 'b-w001', { frame });
    await expect(imageOf(page, 'b-w001')).toHaveAttribute('src', srcOf(frame));

    const pane = page.getByTestId('devtools-browsers');
    await pane.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expectWatchedAre(page, dashboard, (held) => held.includes('b-w020'));
    expect(subscriptions(dashboard)['b-w001']).toBeUndefined();
    expect(dashboard.data.devtools.streamCalls).toContainEqual({
      path: '/api/devtools/stream/unsubscribe',
      body: { stream: 'e2e-stream-00000001', id: 'b-w001' },
    });
    // Off screen, its picture is not touched; still one stream for the whole wall.
    expect(await screencastState(page)).toHaveLength(1);

    await pane.evaluate((el) => {
      el.scrollTop = 0;
    });
    await expectWatchedAre(page, dashboard, (held) => held.includes('b-w001'));
    expect(subscriptions(dashboard)['b-w020']).toBeUndefined();
    // Its last picture was kept while it was away, until the browser sends a new one.
    await expect(imageOf(page, 'b-w001')).toHaveAttribute('src', srcOf(frame));
    await expect(page.getByTestId('devtools-status-b-w001')).toHaveText('Connecting');
    expect(await screencastState(page)).toHaveLength(1);
  });

  test('the page never scrolls: only the pane does', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/#/devtools');
    await expect(tile(page, 'b-w001')).toBeVisible();
    const sizes = await page.evaluate(() => {
      const pane = document.querySelector('[data-testid="devtools-browsers"]');
      return {
        page: document.documentElement.scrollHeight - window.innerHeight,
        paneScrolls: pane.scrollHeight > pane.clientHeight,
        overflow: getComputedStyle(pane).overflowY,
      };
    });
    expect(sizes.page).toBeLessThanOrEqual(0);
    expect(sizes.paneScrolls).toBe(true);
    expect(sizes.overflow).toBe('auto');
  });

  test('uses an explicit grid of several columns, and one column on a phone', async ({ page }) => {
    await page.goto('/#/devtools');
    await expect(tile(page, 'b-w001')).toBeVisible();
    const columns = () =>
      page
        .getByTestId('devtools-wall')
        .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
    expect(await columns()).toBeGreaterThanOrEqual(4);
    const display = await page
      .getByTestId('devtools-wall')
      .evaluate((el) => getComputedStyle(el).display);
    expect(display).toBe('grid');

    await page.setViewportSize({ width: 390, height: 800 });
    expect(await columns()).toBe(1);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

// -- tiles are view-only ------------------------------------------------------------------------------

const inputs = ({ data }) =>
  data.devtools.calls.filter(({ path }) => path === '/api/devtools/browsers/input');

test.describe('devtools wall, view-only tiles and keyboard', () => {
  test('tabs through each tile open button, then its actions, then its details', async ({
    page,
  }) => {
    await openDevtools(page);
    await page.getByTestId(`devtools-open-${RUNNING}`).focus();
    const summary = (id) => page.getByTestId(`devtools-details-${id}`).locator('summary');
    const order = [
      page.getByTestId(`devtools-stop-${RUNNING}`),
      page.getByTestId(`devtools-restart-${RUNNING}`),
      page.getByTestId(`devtools-remove-${RUNNING}`),
      summary(RUNNING),
      // The stopped tile has no picture to open: its first stop is Start.
      page.getByTestId(`devtools-start-${STOPPED}`),
      page.getByTestId(`devtools-remove-${STOPPED}`),
      summary(STOPPED),
      page.getByTestId(`devtools-open-${CHECKOUT}`),
    ];
    for (const next of order) {
      await page.keyboard.press('Tab');
      await expect(next).toBeFocused();
    }
    // Nothing else on a tile is a Tab stop: not the item, the picture of a stopped one, nor the text.
    expect(
      await page
        .getByTestId(`devtools-tile-${STOPPED}`)
        .evaluate((el) =>
          [el, ...el.querySelectorAll('*')]
            .filter((child) => child.tabIndex >= 0)
            .map((child) => child.tagName),
        ),
    ).toEqual(['BUTTON', 'BUTTON', 'SUMMARY']);
  });

  test('no input is ever forwarded from a tile', async ({ page, dashboard }) => {
    await openWall(page, dashboard);
    await goLiveTile(page, RUNNING);
    const picture = page.getByTestId(`devtools-open-${RUNNING}`);
    const box = await picture.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 240);
    await picture.focus();
    await page.keyboard.type('hello');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Tab');
    expect(inputs(dashboard)).toEqual([]);
    // Opening the viewer is not input either, and the viewer is view-only until Take control.
    await picture.click();
    await expect(page.getByTestId('devtools-viewer')).toBeVisible();
    await page.keyboard.type('x');
    expect(inputs(dashboard)).toEqual([]);
  });
});

// -- the in-app viewer ----------------------------------------------------------------------------
// Opened from a tile; the viewer watches on the same stream, at full quality while it is open.

const openViewer = async (page, dashboard, id = RUNNING) => {
  await openDevtools(page);
  await expect.poll(() => subscriptions(dashboard)[id]).toBe('tile');
  await page.getByTestId(`devtools-open-${id}`).click();
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
  test('only a running browser has a picture to open', async ({ page }) => {
    await openDevtools(page);
    await expect(page.getByTestId(`devtools-open-${RUNNING}`)).toBeVisible();
    await expect(page.getByTestId(`devtools-open-${STOPPED}`)).toHaveCount(0);
    await expect(page.getByTestId('devtools-viewer')).toHaveCount(0);
  });

  test('a tile opens the viewer at full quality, and closing it returns it to tile', async ({
    page,
    dashboard,
  }) => {
    await openWall(page, dashboard);
    expect(subscriptions(dashboard)[RUNNING]).toBe('tile');
    await goLiveTile(page, RUNNING, { frame: devtoolsFrame([90, 160, 40]) });

    await page.getByTestId(`devtools-open-${RUNNING}`).click();
    await expect(page.getByTestId('devtools-viewer')).toBeVisible();
    await expect(page.getByTestId('devtools-viewer-title')).toHaveText('Browser 3f9a');
    // The viewer is a watcher on the same stream; the browser now streams at full, the rest do not.
    await expect.poll(() => subscriptions(dashboard)[RUNNING]).toBe('full');
    expect(subscriptions(dashboard)[CHECKOUT]).toBe('tile');
    expect(subscriptions(dashboard)[REPORTS]).toBe('tile');
    expect(await screencastState(page)).toHaveLength(1);
    expect(dashboard.data.devtools.streamCalls.at(-1)).toEqual({
      path: '/api/devtools/stream/subscribe',
      body: { stream: 'e2e-stream-00000001', id: RUNNING, quality: 'full' },
    });
    // What the tile already knew is what the viewer opens on, rather than a blank to wait out.
    await expect(page.getByTestId('devtools-viewer-status')).toHaveText('Live');
    await expect(page.getByTestId('devtools-viewer-image')).toBeVisible();
    await expect(page.getByTestId('devtools-viewer-sub')).toHaveText(
      'Port 9300 · https://example.invalid/home',
    );

    await page.getByTestId('devtools-viewer-close').click();
    await expect(page.getByTestId('devtools-viewer')).toHaveCount(0);
    await expect.poll(() => subscriptions(dashboard)[RUNNING]).toBe('tile');
    // Still the wall's stream, still open, and focus is back on the tile that opened it.
    expect(await screencastState(page)).toEqual([
      { url: expect.stringContaining(STREAM_PATH), readyState: 1 },
    ]);
    await expect(page.getByTestId(`devtools-open-${RUNNING}`)).toBeFocused();

    // Opening it again is a watcher on the same stream, not a new one.
    await page.getByTestId(`devtools-open-${RUNNING}`).click();
    await expect(page.getByTestId('devtools-viewer')).toBeVisible();
    await expect.poll(() => subscriptions(dashboard)[RUNNING]).toBe('full');
    expect(await screencastState(page)).toHaveLength(1);
  });

  test('opens a live view of that browser and shows its state', async ({ page, dashboard }) => {
    await openViewer(page, dashboard);
    await expect(page.getByTestId('devtools-viewer')).toHaveAttribute('aria-labelledby', /.+/);
    // Nothing has arrived yet: connecting, no picture, and no way to take control.
    await expect(page.getByTestId('devtools-viewer-status')).toHaveText('Connecting…');
    await expect(page.getByTestId('devtools-viewer-status')).toHaveAttribute('role', 'status');
    await expect(page.getByTestId('devtools-viewer-image')).toBeHidden();
    await expect(page.getByTestId('devtools-viewer-control')).toBeDisabled();

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
    expect(
      devtoolsRequests(dashboard).filter(
        ({ method, path }) => method === 'GET' && path.includes('stream'),
      ),
    ).toEqual([]);
  });

  test('paints each new frame into the same picture', async ({ page, dashboard }) => {
    await openViewer(page, dashboard);
    const first = devtoolsFrame([40, 90, 160]);
    const second = devtoolsFrame([160, 90, 40]);
    await goLive(page, first);
    const image = page.getByTestId('devtools-viewer-image');
    await expect(image).toHaveAttribute('src', srcOf(first));
    await emitScreencast(page, 'frame', second);
    await expect(image).toHaveAttribute('src', srcOf(second));
    // The tile behind it takes the same frames.
    await expect(imageOf(page, RUNNING)).toHaveAttribute('src', srcOf(second));
  });

  test('is view-only: clicks and keys reach the browser only after Take control', async ({
    page,
    dashboard,
  }) => {
    await openViewer(page, dashboard);
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
    await openViewer(page, dashboard);
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
    await openViewer(page, dashboard);
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
    await openViewer(page, dashboard);
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

  test('shows a lost connection and gives control back', async ({ page, dashboard }) => {
    await openViewer(page, dashboard);
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

  test('a stopped browser says so in the viewer, which goes when the wall learns it stopped', async ({
    page,
    dashboard,
  }) => {
    await openViewer(page, dashboard);
    await goLive(page);
    await emitScreencast(page, 'status', { status: 'lost', reason: 'stopped' });
    await expect(page.getByTestId('devtools-viewer-status')).toHaveText('Browser stopped');
    // The wall's stream carries on for every other browser.
    expect((await screencastState(page))[0].readyState).toBe(1);

    // The registry is what the viewer follows: once it says stopped, there is nothing to view.
    dashboard.data.devtools.browsers.find(({ id }) => id === RUNNING).status = 'stopped';
    // The modal covers the page, so the refresh is asked for the way the countdown would.
    await page.getByTestId('devtools-refresh').evaluate((button) => button.click());
    await expect(page.getByTestId('devtools-viewer')).toHaveCount(0);
    await expect(page.getByTestId(`devtools-placeholder-${RUNNING}`)).toBeVisible();
  });

  test('closing the viewer returns focus to the tile', async ({ page, dashboard }) => {
    await openViewer(page, dashboard);
    await goLive(page);
    await page.getByTestId('devtools-viewer-close').click();
    await expect(page.getByTestId('devtools-viewer')).toHaveCount(0);
    await expect(page.getByTestId(`devtools-open-${RUNNING}`)).toBeFocused();
  });

  test('Escape closes a view-only viewer', async ({ page, dashboard }) => {
    await openViewer(page, dashboard);
    await goLive(page);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('devtools-viewer')).toHaveCount(0);
    await expect.poll(() => subscriptions(dashboard)[RUNNING]).toBe('tile');
  });

  test('a viewer over a scrolled-away tile still holds the browser at full', async ({
    page,
    dashboard,
  }) => {
    await openViewer(page, dashboard);
    await hideDocument(page);
    // Every tile pauses, but the viewer is still watching and keeps its browser, at full.
    await expect.poll(() => subscriptions(dashboard)).toEqual({ [RUNNING]: 'full' });
    await showDocument(page);
    await expect.poll(() => subscriptions(dashboard)[CHECKOUT]).toBe('tile');
    expect(subscriptions(dashboard)[RUNNING]).toBe('full');
  });
});

// -- the tab strip ---------------------------------------------------------------------------------
// The server's side is played by the spec: a click only posts the choice, and the strip, the status
// and the shown tab change when the spec emits what the server would have sent back.

const tabCalls = ({ data }) =>
  data.devtools.calls.filter(({ path }) => path === '/api/devtools/browsers/tab');
const tab = (page, tabId) => page.getByTestId(`devtools-viewer-tab-${tabId}`);
const showTabs = (page, ...args) => emitScreencast(page, 'tabs', devtoolsTabs(...args));
const liveOnTabs = async (page, dashboard, ...args) => {
  await openViewer(page, dashboard);
  await goLive(page);
  await showTabs(page, ...args);
  await expect(tab(page, 'T1')).toBeVisible();
};
// What the server sends once it has moved the view to `to`.
const switchedTo = async (page, to, options) => {
  await emitScreencast(page, 'status', { status: 'connecting', reason: 'switching' });
  await emitScreencast(page, 'target', { id: to, title: '', url: 'https://example.invalid/x' });
  await showTabs(page, to, options);
  await emitScreencast(page, 'status', { status: 'live', reason: '' });
  await emitScreencast(page, 'frame', devtoolsFrame([160, 90, 40]));
};

test.describe('devtools viewer tabs', () => {
  test('there is no strip until the browser has sent its tabs', async ({ page, dashboard }) => {
    await openViewer(page, dashboard);
    await goLive(page);
    await expect(page.getByTestId('devtools-viewer-tabs')).toHaveCount(0);
    await expect(page.getByTestId('devtools-viewer-auto')).toHaveCount(0);
  });

  test('shows each tab by title, else its site, with the shown one marked', async ({
    page,
    dashboard,
  }) => {
    await liveOnTabs(page, dashboard, 'T1');
    const strip = page.getByRole('tablist', { name: 'Browser tabs' });
    await expect(strip.getByRole('tab')).toHaveCount(3);
    await expect(tab(page, 'T1')).toHaveText('Admin home');
    await expect(tab(page, 'T2')).toHaveText('reports.example.invalid');
    await expect(tab(page, 'T3')).toHaveText('Checkout');
    await expect(tab(page, 'T1')).toHaveAttribute('aria-selected', 'true');
    await expect(tab(page, 'T2')).toHaveAttribute('aria-selected', 'false');
    // Only the shown tab is a Tab stop; the rest are reached with the arrow keys.
    await expect(tab(page, 'T1')).toHaveAttribute('tabindex', '0');
    await expect(tab(page, 'T3')).toHaveAttribute('tabindex', '-1');
    // The picture is the tab's panel, named by the shown tab.
    const panel = page.getByRole('tabpanel');
    await expect(panel).toHaveCount(1);
    await expect(panel.getByTestId('devtools-viewer-stage')).toHaveCount(1);
    await expect(panel).toHaveAttribute(
      'aria-labelledby',
      (await tab(page, 'T1').getAttribute('id')) ?? '',
    );
    await expect(tab(page, 'T1')).toHaveAttribute(
      'aria-controls',
      (await panel.getAttribute('id')) ?? '',
    );
    // Auto is on, so there is nothing to return to; the hint says what choosing does.
    await expect(page.getByTestId('devtools-viewer-auto')).toBeDisabled();
    await expect(page.getByTestId('devtools-viewer-auto')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('devtools-viewer-tabhint')).toHaveText(
      'Choosing a tab also brings it to the front of the browser window.',
    );
  });

  test('a long title is truncated, not allowed to widen the strip', async ({ page, dashboard }) => {
    await openViewer(page, dashboard);
    await goLive(page);
    const long = devtoolsTabs('T1');
    long.tabs[0].title = 'An extremely long page title '.repeat(12);
    await emitScreencast(page, 'tabs', long);
    await expect(tab(page, 'T1')).toBeVisible();
    expect((await tab(page, 'T1').boundingBox()).width).toBeLessThan(320);
    await expect(tab(page, 'T3')).toBeVisible();
  });

  test('clicking a tab posts that choice, releases control and pins it', async ({
    page,
    dashboard,
  }) => {
    await liveOnTabs(page, dashboard, 'T1');
    await takeControl(page);

    await tab(page, 'T3').click();
    await expect(page.getByTestId('devtools-viewer-control')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await expect(page.getByTestId('devtools-viewer-stage')).toHaveAttribute(
      'data-control',
      'false',
    );
    await expect.poll(() => tabCalls(dashboard)).toHaveLength(1);
    expect(tabCalls(dashboard)[0]).toEqual({
      method: 'POST',
      path: '/api/devtools/browsers/tab',
      body: { id: RUNNING, targetId: 'T3' },
    });

    // The server answers with the new view; the strip follows it and offers to unpin.
    await switchedTo(page, 'T3', { mode: 'pinned' });
    await expect(tab(page, 'T3')).toHaveAttribute('aria-selected', 'true');
    await expect(tab(page, 'T1')).toHaveAttribute('aria-selected', 'false');
    await expect(page.getByTestId('devtools-viewer-auto')).toBeEnabled();
    await expect(page.getByTestId('devtools-viewer-auto')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('devtools-viewer-control')).toBeEnabled();
    await expect(page.getByTestId('devtools-viewer-control')).toHaveText('Take control');
  });

  test('Auto-follow newest posts null and is off once it is on', async ({ page, dashboard }) => {
    await liveOnTabs(page, dashboard, 'T2', { mode: 'pinned' });
    await page.getByTestId('devtools-viewer-auto').click();
    await expect.poll(() => tabCalls(dashboard)).toHaveLength(1);
    expect(tabCalls(dashboard)[0].body).toEqual({ id: RUNNING, targetId: null });

    await switchedTo(page, 'T3');
    await expect(tab(page, 'T3')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('devtools-viewer-auto')).toBeDisabled();
    await expect(page.getByTestId('devtools-viewer-auto')).toHaveAttribute('aria-pressed', 'true');
  });

  test('the arrow keys, Home and End move between tabs and choose them', async ({
    page,
    dashboard,
  }) => {
    await liveOnTabs(page, dashboard, 'T1');
    await tab(page, 'T1').focus();
    const chosen = () => tabCalls(dashboard).map(({ body }) => body.targetId);

    await page.keyboard.press('ArrowRight');
    await expect(tab(page, 'T2')).toBeFocused();
    await page.keyboard.press('End');
    await expect(tab(page, 'T3')).toBeFocused();
    await page.keyboard.press('ArrowRight'); // wraps
    await expect(tab(page, 'T1')).toBeFocused();
    await page.keyboard.press('ArrowLeft'); // wraps back
    await expect(tab(page, 'T3')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(tab(page, 'T1')).toBeFocused();
    await expect.poll(chosen).toEqual(['T2', 'T3', 'T1', 'T3', 'T1']);
  });

  test('a tab that opens joins the strip and, when following, becomes the one shown', async ({
    page,
    dashboard,
  }) => {
    await liveOnTabs(page, dashboard, 'T1', { ids: ['T1', 'T2'] });
    await expect(page.getByRole('tab')).toHaveCount(2);
    await switchedTo(page, 'T4', { ids: ['T1', 'T2', 'T4'] });
    await expect(page.getByRole('tab')).toHaveCount(3);
    await expect(tab(page, 'T4')).toHaveText('Fourth tab');
    await expect(tab(page, 'T4')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('devtools-viewer-sub')).toHaveText(
      'Port 9300 · https://example.invalid/x',
    );
  });

  test('says so when the pinned tab closes and the view follows the newest', async ({
    page,
    dashboard,
  }) => {
    await liveOnTabs(page, dashboard, 'T1', { mode: 'pinned' });
    await emitScreencast(page, 'status', { status: 'connecting', reason: 'switching' });
    await expect(page.getByTestId('devtools-viewer-status')).toHaveText('Switching tab…');
    await expect(page.getByTestId('devtools-viewer-control')).toBeDisabled();

    await emitScreencast(page, 'target', { id: 'T3', title: '', url: 'https://example.invalid/x' });
    await showTabs(page, 'T3', { ids: ['T2', 'T3'] });
    await emitScreencast(page, 'status', { status: 'live', reason: 'tab-closed' });
    await expect(page.getByTestId('devtools-viewer-status')).toHaveText(
      'Live · the pinned tab closed, following the newest',
    );
    await expect(page.getByTestId('devtools-viewer-status')).toHaveAttribute('data-status', 'live');
    await expect(page.getByRole('tab')).toHaveCount(2);
    await expect(page.getByTestId('devtools-viewer-auto')).toBeDisabled();

    // The note goes with the next change of view.
    await switchedTo(page, 'T2', { ids: ['T2', 'T3'] });
    await expect(page.getByTestId('devtools-viewer-status')).toHaveText('Live');
  });

  test('control is released when the shown tab changes, and input is addressed to its tab', async ({
    page,
    dashboard,
  }) => {
    await liveOnTabs(page, dashboard, 'T1');
    await takeControl(page);
    const { x, y } = await centreOfImage(page);
    await page.mouse.move(x, y);
    await expect.poll(() => inputs(dashboard).length).toBeGreaterThan(0);
    expect(inputs(dashboard).every(({ body }) => body.targetId === 'T1')).toBe(true);

    // The view moves on its own (a tab an agent opened): control goes, and stays gone.
    await switchedTo(page, 'T3', { ids: ['T1', 'T2', 'T3'] });
    await expect(page.getByTestId('devtools-viewer-control')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await expect(page.getByTestId('devtools-viewer-stage')).toHaveAttribute(
      'data-control',
      'false',
    );
    const before = inputs(dashboard).length;
    await page.mouse.click(x, y);
    await page.keyboard.type('x');
    expect(inputs(dashboard).length).toBe(before);

    // Taken again, it addresses the tab now shown.
    await takeControl(page);
    await page.mouse.move(x + 3, y + 3);
    await expect.poll(() => inputs(dashboard).length).toBeGreaterThan(before);
    expect(inputs(dashboard).at(-1).body.targetId).toBe('T3');
  });

  test('Escape still releases control before it closes, with the strip showing', async ({
    page,
    dashboard,
  }) => {
    await liveOnTabs(page, dashboard, 'T1');
    await takeControl(page);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('devtools-viewer-control')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await expect(page.getByTestId('devtools-viewer')).toBeVisible();
    await tab(page, 'T1').focus();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('devtools-viewer')).toHaveCount(0);
  });
});
