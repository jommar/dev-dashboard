import { test, expect } from './fixtures.js';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

async function capture(page, name) {
  const directory = new URL(
    '../../docs/dev-dashboard-redesign/verification/screenshots/',
    import.meta.url,
  );
  await mkdir(directory, { recursive: true });
  await page.screenshot({
    path: fileURLToPath(new URL(`fix-1-${name}.png`, directory)),
    fullPage: true,
  });
}

test('viewer errors survive changed polling and retry clears the message @regression', async ({
  page,
  dashboard,
}) => {
  let fail = true;
  await page.route('**/api/pr-diff*', (route) =>
    fail ? route.fulfill({ status: 503, json: { error: 'Diff unavailable' } }) : route.fallback(),
  );
  await page.goto('/#/home');
  await page.clock.install();
  const button = page.getByTestId('home-action-view-diff-example/workspace-17');
  const note = page.getByTestId('diff-status');
  await button.click();
  await expect(note).toContainText('Diff unavailable');
  dashboard.data.prs.prs[0].title = 'Updated after failed diff';
  await page.clock.fastForward(91_000);
  await expect(page.getByTestId('home-actions')).toContainText('Updated after failed diff');
  await expect(note).toContainText('Diff unavailable');
  fail = false;
  await page.getByTestId('diff-retry').click();
  await expect(page.getByTestId('diff-copy')).toBeEnabled();
  await expect(note).not.toContainText('Diff unavailable');
  await page.keyboard.press('Escape');
  await expect(button).toBeFocused();
});

test('stale empty source cannot become an all-clear after refresh @regression', async ({
  page,
  dashboard,
}) => {
  dashboard.data.prs = {
    ...dashboard.data.prs,
    prs: [],
    groups: {},
    prsNeedingApprovals: [],
    approvalGroups: {},
  };
  dashboard.data.tickets = { tickets: [], activeSprints: [], allSprints: [], truncated: false };
  await page.goto('/#/home');
  await expect(page.getByTestId('home-actions-empty')).toBeVisible();
  await page.route('**/api/prs', (route) => route.fulfill({ status: 503, body: 'Unavailable' }));
  await page.getByTestId('home-refresh').click();
  await expect(page.getByTestId('home-actions')).toContainText('GitHub unavailable');
  await expect(page.getByTestId('home-actions-empty')).toHaveCount(0);
});

for (const width of [390, 1440]) {
  test(`dense ticket hierarchy stays readable at ${width} @regression`, async ({
    page,
    dashboard,
  }) => {
    const base = dashboard.data.tickets.tickets[0];
    dashboard.data.tickets.tickets.push(
      ...Array.from({ length: 12 }, (_, i) => ({
        ...base,
        key: `work-${i}`,
        summary: `Workspace maintenance item ${i}`,
      })),
    );
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/#/my-tickets');
    await expect(page.getByTestId('my-tickets-category-count-In-Progress')).toHaveText('13');
    await expect(page.getByTestId('my-tickets-status-head-In-Progress-In-Progress')).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await capture(page, `tickets-dense-${width}`);
  });
}

for (const route of ['home', 'prs']) {
  for (const failure of ['API', 'clipboard']) {
    test(`${route} ${failure} diff failure explains recovery inside the viewer @regression`, async ({
      page,
      dashboard,
    }) => {
      if (route === 'prs') {
        const base = dashboard.data.prs.prs[0];
        const extra = Array.from({ length: 23 }, (_, i) => ({
          ...base,
          number: i + 100,
          title: `Additional change ${i}`,
        }));
        dashboard.data.prs.prs.push(...extra);
        dashboard.data.prs.groups.Unticketed.push(...extra);
      }
      if (failure === 'API')
        await page.route('**/api/pr-diff*', (r) =>
          r.fulfill({ status: 503, json: { error: 'Diff unavailable' } }),
        );
      await page.goto(`/#/${route}`);
      if (failure === 'clipboard')
        await page.evaluate(() => {
          window.__dashboardMock.clipboard.error = 'Clipboard denied';
        });
      const id = `${route === 'home' ? 'home-action' : 'pr-open'}-view-diff-example/workspace-17`;
      const button = page.getByTestId(id);
      await button.focus();
      await page.keyboard.press('Enter');
      if (failure === 'clipboard') {
        await expect(page.getByTestId('diff-copy')).toBeEnabled();
        await page.getByTestId('diff-copy').click();
      }
      const feedback = page.getByTestId('diff-status');
      await expect(feedback).toContainText(
        failure === 'API' ? 'Diff unavailable' : 'Clipboard denied',
      );
      await expect(page.getByTestId(failure === 'API' ? 'diff-retry' : 'diff-copy')).toBeEnabled();
      expect(
        await page.getByTestId('diff-viewer').evaluate((el) => el.contains(document.activeElement)),
      ).toBe(true);
      const box = await feedback.boundingBox();
      expect(box.y + box.height).toBeLessThanOrEqual(900);
      await capture(page, `${route}-${failure}-diff-error`);
      await page.keyboard.press('Escape');
      await expect(button).toBeFocused();
    });
  }
}

test('ticket groups omit only redundant status headers and retain distinct subgroups @regression', async ({
  page,
  dashboard,
}) => {
  await page.goto('/#/my-tickets');
  await expect(page.getByTestId('my-tickets-category-count-In-Progress')).toHaveText('1');
  await expect(page.getByTestId('my-tickets-status-head-In-Progress-In-Progress')).toBeHidden();
  await expect(page.getByTestId('my-tickets-item-status-sample-active')).toHaveText('In Progress');
  const base = dashboard.data.tickets.tickets[0];
  dashboard.data.tickets.tickets.push({ ...base, key: 'sample-review', status: 'In Review' });
  await page.getByTestId('my-tickets-refresh').click();
  await expect(page.getByTestId('my-tickets-category-count-In-Progress')).toHaveText('2');
  await expect(page.getByTestId('my-tickets-status-head-In-Progress-In-Progress')).toBeVisible();
  await expect(page.getByTestId('my-tickets-status-head-In-Progress-In-Review')).toBeVisible();
});

test.describe('touch input', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  test('sprint controls keep touch-sized targets @regression', async ({ page }) => {
    await page.goto('/#/home');
    expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true);
    for (const id of [
      'home-sprint-select',
      'home-sprint-Workspace-Sprint-count-active',
      'home-sprint-Workspace-Sprint-unestimated',
    ]) {
      const control = page.getByTestId(id);
      await expect(control).toBeVisible();
      expect((await control.boundingBox()).height).toBeGreaterThanOrEqual(44);
    }
    await capture(page, 'home-touch');
  });
});

test('sprint popup closes across a quick route round-trip @regression', async ({ page }) => {
  await page.goto('/#/home');
  const selector = page.getByTestId('home-sprint-select');
  await selector.click();
  await expect(selector).toHaveAttribute('aria-expanded', 'true');
  await page.evaluate(() => {
    location.hash = '#/services';
  });
  await expect(page.getByTestId('panel-services')).toBeVisible();
  await page.evaluate(() => {
    location.hash = '#/home';
  });
  await expect(selector).toHaveAttribute('aria-expanded', 'false');
  await selector.click();
  await expect(selector).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(selector).toHaveAttribute('aria-expanded', 'false');
  await selector.click();
  await expect(selector).toHaveAttribute('aria-expanded', 'true');
  await selector.click();
  await expect(selector).toHaveAttribute('aria-expanded', 'false');
});

test('dense sprint band preserves scroll and focus through refresh and sibling expansion @regression', async ({
  page,
  dashboard,
}) => {
  const base = dashboard.data.tickets.tickets[0];
  dashboard.data.tickets.tickets.push(
    ...Array.from({ length: 35 }, (_, index) => ({
      ...base,
      key: `dense-${index}`,
      summary: `Active work item ${index}`,
    })),
  );
  await page.goto('/#/home');
  const active = page.getByTestId('home-sprint-Workspace-Sprint-count-active');
  await active.click();
  const band = page.getByTestId('sprint-1-list-active');
  const rows = band.locator('.sprint-tickets-rows');
  expect(await rows.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await rows.evaluate((el) => {
    el.scrollTop = 600;
  });
  const top = await rows.evaluate((el) => el.scrollTop);
  await active.focus();
  await page.clock.install();
  dashboard.data.tickets.tickets[0].summary = 'Changed without losing your place';
  await page.clock.fastForward(91_000);
  await expect(band).toContainText('Changed without losing your place');
  expect(await rows.evaluate((el) => el.scrollTop)).toBe(top);
  await expect(active).toBeFocused();
  const done = page.getByTestId('home-sprint-Workspace-Sprint-count-done');
  await done.click();
  await expect(done).toBeFocused();
  await expect(done).toHaveAttribute('aria-expanded', 'true');
  expect(await rows.evaluate((el) => el.scrollTop)).toBe(top);
  await capture(page, 'dense-sprint-scroll');
});

for (const missing of ['GitHub', 'Jira', 'reviews']) {
  test(`empty action queue discloses missing ${missing} @regression`, async ({
    page,
    dashboard,
  }) => {
    dashboard.data.prs = {
      ...dashboard.data.prs,
      prs: [],
      groups: {},
      prsNeedingApprovals: [],
      approvalGroups: {},
    };
    dashboard.data.tickets = { tickets: [], activeSprints: [], allSprints: [], truncated: false };
    if (missing === 'reviews') dashboard.data.prs.reviewDataAvailable = false;
    else
      await page.route(missing === 'GitHub' ? '**/api/prs' : '**/api/my-tickets*', (route) =>
        route.fulfill({ status: 503, body: 'Unavailable' }),
      );
    await page.goto('/#/home');
    await expect(page.getByTestId('home-actions')).toContainText(
      missing === 'reviews' ? 'Review data unavailable' : `${missing} unavailable`,
    );
    await expect(page.getByTestId('home-actions-empty')).toHaveCount(0);
  });
}

for (const control of ['individual', 'global']) {
  test(`${control} Follow resumes at latest output after scrolling up @regression`, async ({
    page,
    dashboard,
  }) => {
    await page.goto('/#/services');
    const log = page.getByTestId('log-api');
    await expect(log).toContainText('line 120');
    const toggle = page.getByTestId(control === 'global' ? 'autoscroll-toggle' : 'follow-api');
    await toggle.click();
    await log.evaluate((el) => {
      el.scrollTop = 0;
    });
    if (control === 'individual') {
      await page.getByTestId('follow-web').click();
      await page.getByTestId('log-web').evaluate((el) => {
        el.scrollTop = 0;
      });
    }
    await toggle.click();
    expect(
      await log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight),
    ).toBeLessThan(12);
    dashboard.data.logs.api += '\nresumed output';
    await page.evaluate(() =>
      window.__dashboardMock.streams[0].emit('message', [{ id: 'api', status: 'running' }]),
    );
    await expect(log).toContainText('resumed output');
    expect(
      await log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight),
    ).toBeLessThan(12);
    if (control === 'individual')
      expect(await page.getByTestId('log-web').evaluate((el) => el.scrollTop)).toBe(0);
  });
}
