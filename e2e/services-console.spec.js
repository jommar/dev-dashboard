import { test, expect, seedVelocitySnapshot } from './fixtures.js';

const emitServices = (page, services) =>
  page.evaluate(
    (snapshot) => window.__dashboardMock.streams[0].emit('message', snapshot),
    services,
  );

test('shared console reflects process counts without replacing consoles or discovery order @regression', async ({
  page,
  dashboard,
}) => {
  const services = [
    { ...dashboard.data.services[0], port: 4321 },
    { ...dashboard.data.services[1], status: 'stopped' },
    { ...dashboard.data.services[2], status: 'exited', exitCode: 0 },
    { id: 'legacy-ui', label: 'Legacy UI', dir: 'legacy-ui', status: 'stopped', port: 4322 },
  ];
  dashboard.data.services = services;
  dashboard.data.logs['legacy-ui'] = 'Legacy retained output';
  await page.goto('/#/services');
  await expect(page.getByTestId('log-api')).toContainText('line 120');
  await emitServices(page, services);
  await expect(page.getByTestId('services-title')).toHaveText('Services');
  await expect(page.getByTestId('panel-services')).toHaveClass(/board-panel/);
  await expect(page.getByTestId('services-sub')).toContainText(/40.*retained/i);
  await expect(page.getByTestId('services-meta')).toContainText(/1 running/);
  await expect(page.getByTestId('services-meta')).toContainText(/2 stopped/);
  await expect(page.getByTestId('services-meta')).toContainText(/1 exited/);
  await expect(page.getByTestId('status-worker')).toHaveText('exited (0)');
  const port = page.getByTestId('card-api').getByRole('link');
  await expect(port).toHaveAttribute('href', 'http://127.0.0.1:4321');
  await expect(port).toHaveAttribute('target', '_blank');
  await expect(port).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(page.getByTestId('card-legacy-ui').getByRole('link')).toHaveCount(0);
  await page.getByTestId('log-api').evaluate((node) => (node.dataset.consoleIdentity = 'retained'));
  const updated = services.map((service) =>
    service.id === 'api' ? { ...service, status: 'stopped' } : service,
  );
  await emitServices(page, [...updated].reverse());
  await expect(page.getByTestId('status-api')).toHaveText('stopped');
  await expect(page.getByTestId('services-meta')).toContainText(/3 stopped/);
  expect(
    await page
      .getByTestId('service-grid')
      .evaluate((grid) => [...grid.children].map((card) => card.dataset.testid)),
  ).toEqual(services.map(({ id }) => `card-${id}`));
  await expect(page.getByTestId('log-api')).toHaveAttribute('data-console-identity', 'retained');
  for (const { id } of services) await expect(page.getByTestId(`log-${id}`)).toBeAttached();
  const grid = page.getByTestId('service-grid');
  const version = Number(await grid.getAttribute('data-follow-version'));
  await page.getByTestId('follow-api').click();
  await expect(grid).toHaveAttribute('data-follow-version', String(version + 1));
  await expect(page.getByTestId('autoscroll-toggle')).toHaveAttribute('aria-pressed', 'mixed');
});

test('control acceptance leaves stopped status truthful until the feed updates @regression', async ({
  page,
  dashboard,
}) => {
  let command;
  await page.route('**/api/services/worker/start', (route) => (command = route));
  await page.goto('/#/services');
  await page.getByTestId('start-worker').click();
  await expect(page.getByTestId('stop-worker')).toBeDisabled();
  await expect(page.getByTestId('start-all')).toBeDisabled();
  await expect(page.getByTestId('status-worker')).toContainText('stopped');
  await expect.poll(() => Boolean(command)).toBe(true);
  await command.fulfill({ json: { ok: true } });
  await expect(page.getByTestId('control-feedback-worker')).toContainText('Command accepted');
  await expect(page.getByTestId('start-worker')).toBeEnabled();
  await expect(page.getByTestId('status-worker')).toContainText('stopped');
  await emitServices(
    page,
    dashboard.data.services.map((service) =>
      service.id === 'worker' ? { ...service, status: 'running', exitCode: null } : service,
    ),
  );
  await expect(page.getByTestId('status-worker')).toHaveText('running');
});

test('discovery loading and empty success use distinct shared console states @regression', async ({
  page,
}) => {
  let discovery;
  await page.route('**/api/services', (route) => (discovery = route));
  await page.goto('/#/services');
  await expect(page.getByTestId('panel-services')).toContainText('Loading services');
  for (const action of ['start', 'stop', 'restart'])
    await expect(page.getByTestId(`${action}-all`)).toBeDisabled();
  await expect.poll(() => Boolean(discovery)).toBe(true);
  await discovery.fulfill({ json: { services: [] } });
  await expect(page.getByTestId('services-list')).toContainText('No services configured');
  await expect(page.getByTestId('services-list')).not.toContainText('Loading services');
  await expect(page.getByTestId('services-feedback')).toBeEmpty();
  await expect(page.getByTestId('services-retry')).toBeHidden();
  await expect(page.getByTestId('start-all')).toBeDisabled();
  await expect(page.getByTestId('card-api')).toHaveCount(0);
});

test('log status footer stays outside the terminal without shifting output during refresh @regression', async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/services');
  const log = page.getByTestId('log-api');
  const footer = page.getByTestId('log-feedback-api');
  await expect(log).toContainText('line 120');
  await expect(footer).toHaveText('Last 40 lines');
  const bounds = async () => ({
    log: await log.boundingBox(),
    footer: await footer.boundingBox(),
  });
  const before = await bounds();
  expect(before.footer.y).toBeGreaterThanOrEqual(before.log.y + before.log.height);
  const reservedHeight = await footer.evaluate((node) =>
    Number.parseFloat(getComputedStyle(node).minHeight),
  );
  expect(reservedHeight).toBeGreaterThan(0);
  expect(before.footer.height).toBeGreaterThanOrEqual(reservedHeight);
  await expect(log).not.toContainText('Last 40 lines');

  let pending;
  await page.route('**/api/logs/api*', (route) => (pending = route));
  await page.getByTestId('log-retry-api').click();
  await expect.poll(() => Boolean(pending)).toBe(true);
  await expect(footer).toHaveText('Updating output…');
  await expect(footer).toHaveAttribute('data-state', 'pending');
  await expect(log).not.toContainText('Updating output');
  expect(await bounds()).toEqual(before);

  const updated = `${dashboard.data.logs.api}\nnew output after held refresh`;
  await pending.fulfill({ contentType: 'text/plain', body: updated });
  await expect(log).toContainText('new output after held refresh');
  await expect(footer).toHaveText('Last 40 lines');
  await expect(footer).toHaveAttribute('data-state', 'success');
  expect(await bounds()).toEqual(before);
});

test('responsive console wraps long identities and scrolls inside its pane @regression', async ({
  page,
  dashboard,
}, testInfo) => {
  const services = dashboard.data.services.map((service) => ({
    ...service,
    label: `${service.label} ${'LongServiceName'.repeat(5)}`,
    dir: `/workspace/${'long-directory-name/'.repeat(12)}`,
  }));
  await page.goto('/#/services');
  await expect(page.getByTestId('log-api')).toContainText('line 120');
  await emitServices(page, services);
  await expect(page.getByTestId('card-dir-api')).toHaveText(services[0].dir);
  const grid = page.getByTestId('service-grid');
  const pane = grid.locator('..');
  await expect(pane).toHaveClass(/services-pane/);
  for (const [width, columns] of [
    [390, 1],
    [759, 1],
    [760, 2],
    [1024, 2],
    [1699, 2],
    [1700, 3],
  ]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await grid.evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(' ').length),
    ).toBe(columns);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    for (const id of ['start-all', 'autoscroll-toggle', 'card-dir-api']) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await pane.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  await pane.evaluate((node) => (node.scrollTop = 100));
  expect(await pane.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await page.getByTestId('follow-api').click();
  await page.getByTestId('log-api').evaluate((node) => (node.scrollTop = 0));
  expect(await pane.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath('services-mobile.png') });
});

test('keyboard and short viewport keep console controls and output reachable @regression', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/#/services');
  await expect(page.getByTestId('log-api')).toContainText('line 120');
  for (const id of ['api', 'web']) {
    const log = page.getByTestId(`log-${id}`);
    const box = await log.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(200);
    expect(box.y + box.height).toBeLessThanOrEqual(768);
    await expect(log).toHaveAttribute('tabindex', '0');
    await expect(log).not.toHaveAttribute('aria-live');
  }
  await page.screenshot({ path: testInfo.outputPath('services-medium.png') });
  await page.getByTestId('log-retry-api').focus();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('log-api')).toBeFocused();
  await page.setViewportSize({ width: 390, height: 400 });
  await page.getByTestId('panel-services').evaluate((panel) => {
    const nodes = [panel, ...panel.querySelectorAll('*')];
    const sizes = nodes.map((node) => Number.parseFloat(getComputedStyle(node).fontSize));
    nodes.forEach((node, index) => (node.style.fontSize = `${sizes[index] * 2}px`));
  });
  await page.getByTestId('log-retry-worker').focus();
  await page.keyboard.press('Tab');
  const lastLog = page.getByTestId('log-worker');
  await expect(lastLog).toBeFocused();
  const box = await lastLog.boundingBox();
  expect(box.y).toBeLessThan(400);
  expect(box.y + box.height).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('protected screens visual evidence retains their shared shell after leaving Services @regression', async ({
  page,
  dashboard,
}, testInfo) => {
  await seedVelocitySnapshot(page, dashboard.data.teamVelocity);
  await page.goto('/#/services');
  await expect(page.getByTestId('log-api')).toContainText('line 120');
  await page.screenshot({ path: testInfo.outputPath('services-desktop.png') });
  for (const name of ['home', 'my-tickets', 'slack', 'prs']) {
    await page.getByTestId(`tab-${name}`).click();
    await expect(page.getByTestId(`${name}-section`)).toBeVisible();
    await expect(page.getByTestId('panel-services')).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath(`${name}-protected.png`) });
  }
});
