import { test, expect } from './fixtures.js';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const unifiedDiff = [
  'diff --git a/example.js b/example.js',
  'index 1234567..abcdef0 100644',
  '--- a/example.js',
  '+++ b/example.js',
  '@@ -4,2 +4,3 @@ function example()',
  ' unchanged',
  '-old value',
  '+new value',
  '+<img src=x onerror="window.diffInjected=true">',
  '\\ No newline at end of file',
  'diff --git a/old-name.txt b/new-name.txt',
  'similarity index 100%',
  'rename from old-name.txt',
  'rename to new-name.txt',
  'diff --git a/image.png b/image.png',
  'Binary files a/image.png and b/image.png differ',
  '',
].join('\n');

for (const [route, variant, number] of [
  ['home', 'home-action', 17],
  ['home', 'home-action', 18],
  ['prs', 'pr-open', 17],
  ['prs', 'pr-approval', 18],
]) {
  test(`${variant} ${number} opens shared diff viewer and copies loaded raw text without refetch`, async ({
    page,
    dashboard,
  }) => {
    if (variant === 'pr-open') {
      dashboard.data.diff = {
        ...dashboard.data.diff,
        repo: 'example/workspace',
        number: 17,
        base: 'ops/development',
      };
    }
    await page.goto(`/#/${route}`);
    const trigger = page.getByTestId(`${variant}-view-diff-example/workspace-${number}`);
    await expect(trigger).toHaveAccessibleName('View diff vs origin/ops/development');
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Diff viewer', exact: true });
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('diff-content')).toContainText('example.js');
    await expect(page.getByTestId('diff-copy')).toBeEnabled();
    await expect(dialog).toContainText('Compared against origin/ops/development');
    expect(await page.evaluate(() => window.__dashboardMock.clipboard.writes)).toEqual([]);
    const requests = dashboard.requests.filter((r) => r.path.startsWith('/api/pr-diff'));
    expect(requests).toHaveLength(1);
    const url = new URL(requests[0].path, 'http://127.0.0.1:6517');
    expect(url.searchParams.get('repo')).toBe('example/workspace');
    expect(url.searchParams.get('number')).toBe(String(number));
    await page.getByTestId('diff-copy').click();
    expect(await page.evaluate(() => window.__dashboardMock.clipboard.writes)).toEqual([
      dashboard.data.diff.diff,
    ]);
    expect(dashboard.requests.filter((r) => r.path.startsWith('/api/pr-diff'))).toHaveLength(1);
    await page.getByTestId('diff-close').click();
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });
}

for (const width of [1440, 390]) {
  test(`unified diff is literal and readable without page overflow at ${width}`, async ({
    page,
    dashboard,
  }) => {
    dashboard.data.diff = { diff: unifiedDiff + '+' + 'long-line-'.repeat(100) + '\n' };
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/#/prs');
    await page.getByTestId('pr-open-view-diff-example/workspace-17').click();
    const viewer = page.getByTestId('diff-viewer');
    const content = page.getByTestId('diff-content');
    await expect(viewer).toBeVisible();
    await expect(content).toContainText('@@ -4,2 +4,3 @@ function example()');
    await expect(content).toContainText('-old value');
    await expect(content).toContainText('+new value');
    await expect(content).toContainText('<img src=x onerror="window.diffInjected=true">');
    await expect(content).toContainText('rename from old-name.txt');
    await expect(content).toContainText('rename to new-name.txt');
    await expect(content).toContainText('Binary files a/image.png and b/image.png differ');
    await expect(content.locator('img, script')).toHaveCount(0);
    expect(await page.evaluate(() => window.diffInjected)).toBeUndefined();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const box = await viewer.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y + box.height).toBeLessThanOrEqual(900);
    await expect(page.getByTestId('diff-close')).toBeInViewport();
    await expect(page.getByTestId('diff-copy')).toBeInViewport();
    const directory = new URL(
      '../../docs/dev-dashboard-redesign/verification/screenshots/',
      import.meta.url,
    );
    await mkdir(directory, { recursive: true });
    await page.screenshot({
      path: fileURLToPath(new URL(`diff-viewer-${width}.png`, directory)),
      fullPage: true,
    });
  });
}

test('empty diff is explicit and copy preserves the exact empty payload', async ({
  page,
  dashboard,
}) => {
  dashboard.data.diff = { diff: '' };
  await page.goto('/#/prs');
  await page.getByTestId('pr-open-view-diff-example/workspace-17').click();
  await expect(page.getByTestId('diff-viewer')).toContainText(
    /no (changes|differences)|empty diff/i,
  );
  await expect(page.getByTestId('diff-retry')).toBeHidden();
  await expect(page.getByTestId('diff-copy')).toBeEnabled();
  await page.getByTestId('diff-copy').click();
  expect(await page.evaluate(() => window.__dashboardMock.clipboard.writes)).toEqual(['']);
});

test('large rendering is bounded and warns while copy retains all raw content', async ({
  page,
  dashboard,
}) => {
  const raw =
    'diff --git a/large.txt b/large.txt\n--- a/large.txt\n+++ b/large.txt\n@@ -0,0 +1,20000 @@\n' +
    Array.from({ length: 20_000 }, (_, i) => `+line ${i}`).join('\n') +
    '\n+UNRENDERED_SENTINEL\n';
  dashboard.data.diff = { diff: raw };
  await page.goto('/#/prs');
  await page.getByTestId('pr-open-view-diff-example/workspace-17').click();
  await expect(page.getByTestId('diff-copy')).toBeEnabled();
  await expect(page.getByTestId('diff-viewer')).toContainText(/truncat|preview|limit/i);
  await expect(page.getByTestId('diff-status')).toHaveAttribute('aria-live', 'polite');
  await expect(page.getByTestId('diff-status')).toContainText(/truncat|preview.*limit/i);
  await expect(page.getByTestId('diff-status')).toContainText(
    /cop(y|ies).*?(full|complete)|(full|complete).*?cop(y|ies)/i,
  );
  await expect(page.getByTestId('diff-content')).not.toContainText('UNRENDERED_SENTINEL');
  expect(await page.getByTestId('diff-content').locator('*').count()).toBeLessThan(100_000);
  await page.getByTestId('diff-copy').click();
  expect(await page.evaluate(() => window.__dashboardMock.clipboard.writes)).toEqual([raw]);
  expect(dashboard.requests.filter((r) => r.path.startsWith('/api/pr-diff'))).toHaveLength(1);
});

test('keyboard focus remains contained and Escape restores a reconciled polling trigger', async ({
  page,
  dashboard,
}) => {
  await page.goto('/#/prs');
  const trigger = page.getByTestId('pr-open-view-diff-example/workspace-17');
  await expect(trigger).toBeVisible();
  await page.clock.install();
  await trigger.focus();
  await page.keyboard.press('Enter');
  const viewer = page.getByTestId('diff-viewer');
  await expect(page.getByTestId('diff-copy')).toBeEnabled();
  for (const key of ['Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
    await page.keyboard.press(key);
    expect(
      await viewer.evaluate((el) => ({
        contained: el.contains(document.activeElement),
        active:
          document.activeElement?.getAttribute('data-testid') || document.activeElement?.tagName,
      })),
      `Focus after ${key}`,
    ).toMatchObject({ contained: true });
  }
  await trigger.evaluate((el) => {
    window.__originalDiffTrigger = el;
  });
  dashboard.data.prs.prs[0].title = 'A replacement trigger after polling';
  await page.clock.fastForward(91_000);
  await expect(page.getByTestId('prs-list')).toContainText('A replacement trigger after polling');
  expect(await page.evaluate(() => window.__originalDiffTrigger.isConnected)).toBe(true);
  expect(await viewer.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('closing and reopening ignores a previous pending fetch', async ({ page, dashboard }) => {
  let release;
  let calls = 0;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/api/pr-diff*', async (route) => {
    if (++calls === 1) {
      await pending;
      await route.fulfill({ json: { diff: '+STALE_RESPONSE\n' } });
    } else await route.fulfill({ json: dashboard.data.diff });
  });
  await page.goto('/#/prs');
  await page.getByTestId('pr-open-view-diff-example/workspace-17').click();
  await expect.poll(() => calls).toBe(1);
  await expect(page.getByTestId('diff-copy')).toBeDisabled();
  await page.getByTestId('diff-close').click();
  await page.getByTestId('pr-approval-view-diff-example/workspace-18').click();
  await expect(page.getByTestId('diff-content')).toContainText('example.js');
  const oldResponse = page.waitForResponse(
    (response) => response.url().includes('/api/pr-diff') && response.url().includes('number=17'),
  );
  release();
  await oldResponse;
  await page.getByTestId('diff-copy').click();
  await expect(page.getByTestId('diff-content')).not.toContainText('STALE_RESPONSE');
  expect(await page.evaluate(() => window.__dashboardMock.clipboard.writes)).toEqual([
    dashboard.data.diff.diff,
  ]);
});

test('route changes close the viewer and late fetch results do not reopen it', async ({ page }) => {
  let release;
  let started = false;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/api/pr-diff*', async (route) => {
    started = true;
    await pending;
    await route.fulfill({ json: { diff: '+LATE_ROUTE_RESULT\n' } });
  });
  await page.goto('/#/home');
  await page.getByTestId('home-action-view-diff-example/workspace-17').click();
  await expect.poll(() => started).toBe(true);
  await page.evaluate(() => {
    location.hash = '#/services';
  });
  await expect(page.getByTestId('panel-services')).toBeVisible();
  await expect(page.getByTestId('diff-viewer')).toBeHidden();
  const response = page.waitForResponse('**/api/pr-diff*');
  release();
  await response;
  await page.evaluate(() => {
    location.hash = '#/home';
  });
  await expect(page.getByTestId('home-actions')).toBeVisible();
  await expect(page.getByTestId('diff-viewer')).toBeHidden();
  expect(await page.evaluate(() => window.__dashboardMock.clipboard.writes)).toEqual([]);
});

for (const result of ['success', 'failure']) {
  test(`late clipboard ${result} cannot overwrite a reopened viewer`, async ({ page }) => {
    await page.goto('/#/prs');
    await page.getByTestId('pr-open-view-diff-example/workspace-17').click();
    await expect(page.getByTestId('diff-copy')).toBeEnabled();
    await page.evaluate(() => {
      navigator.clipboard.writeText = () =>
        new Promise((resolve, reject) => {
          window.__finishDiffCopy = (result) =>
            result === 'success' ? resolve() : reject(new Error('STALE_COPY_FAILURE'));
        });
    });
    await page.getByTestId('diff-copy').click();
    await expect(page.getByTestId('diff-copy')).toBeDisabled();
    await page.getByTestId('diff-close').click();
    await page.getByTestId('pr-approval-view-diff-example/workspace-18').click();
    await expect(page.getByTestId('diff-copy')).toBeEnabled();
    const before = await page.getByTestId('diff-status').textContent();
    await page.evaluate((result) => window.__finishDiffCopy(result), result);
    await expect(page.getByTestId('diff-status')).toHaveText(before);
    await expect(page.getByTestId('diff-copy')).toBeEnabled();
    await expect(page.getByTestId('diff-content')).toContainText('example.js');
  });
}

for (const failure of ['load', 'clipboard']) {
  test(`short landscape preserves recovery and full ${failure} diagnostics`, async ({
    page,
    dashboard,
  }) => {
    const message =
      (failure === 'load'
        ? 'Unable to fetch remote revision. '
        : 'Clipboard access was denied. '
      ).repeat(100) + 'END_OF_DIAGNOSTIC';
    dashboard.data.diff = { diff: '@@ -0,0 +1,4000 @@\n' + '+landscape row\n'.repeat(4000) };
    let fail = true;
    if (failure === 'load') {
      await page.route('**/api/pr-diff*', (route) =>
        fail ? route.fulfill({ status: 502, json: { error: message } }) : route.fallback(),
      );
    }
    await page.setViewportSize({ width: 667, height: 375 });
    await page.goto('/#/prs');
    await page.getByTestId('pr-open-view-diff-example/workspace-17').click();
    const content = page.getByTestId('diff-content');
    const status = page.getByTestId('diff-status');
    if (failure === 'clipboard') {
      await expect(page.getByTestId('diff-copy')).toBeEnabled();
      await page.evaluate((message) => {
        window.__dashboardMock.clipboard.error = message;
      }, message);
      await page.getByTestId('diff-copy').click();
    }
    await expect(status).toContainText(message);
    await expect(page.getByTestId('diff-close')).toBeInViewport();
    const recovery = page.getByTestId(failure === 'load' ? 'diff-retry' : 'diff-copy');
    await expect(recovery).toBeEnabled();
    await expect(recovery).toBeInViewport();
    if (failure === 'clipboard') {
      expect((await content.boundingBox()).height).toBeGreaterThanOrEqual(40);
      await expect(content).toBeInViewport();
      await expect(content).toContainText('+landscape row');
      await expect(page.getByTestId('diff-viewer').locator('.diff-truncation')).toBeVisible();
    }
    // Scroll any diagnostic/outer scroller and prove its final text is not clipped.
    expect(
      await status.evaluate((el) => {
        const scrollers = [];
        for (let parent = el; parent; parent = parent.parentElement) {
          if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) {
            parent.scrollTop = parent.scrollHeight;
            scrollers.push(parent);
          }
        }
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let text;
        while (walker.nextNode())
          if (walker.currentNode.textContent.includes('END_OF_DIAGNOSTIC'))
            text = walker.currentNode;
        if (!text) return false;
        const start = text.textContent.indexOf('END_OF_DIAGNOSTIC');
        const range = document.createRange();
        range.setStart(text, start);
        range.setEnd(text, start + 'END_OF_DIAGNOSTIC'.length);
        const rect = range.getBoundingClientRect();
        let top = 0,
          bottom = innerHeight;
        for (let parent = el; parent; parent = parent.parentElement) {
          if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) {
            const bounds = parent.getBoundingClientRect();
            top = Math.max(top, bounds.top);
            bottom = Math.min(bottom, bounds.bottom);
          }
        }
        const reachable = rect.top >= top && rect.bottom <= bottom;
        for (const parent of scrollers) parent.scrollTop = 0;
        return reachable;
      }),
    ).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    fail = false;
    await page.evaluate(() => {
      window.__dashboardMock.clipboard.error = null;
    });
    await recovery.click();
    if (failure === 'load') {
      await expect(page.getByTestId('diff-copy')).toBeEnabled();
      await expect(content).toContainText('+landscape row');
    } else {
      await expect(status).toContainText(/copied/i);
      expect(await page.evaluate(() => window.__dashboardMock.clipboard.writes)).toEqual([
        dashboard.data.diff.diff,
      ]);
    }
    await page.getByTestId('diff-close').click();
    await expect(page.getByTestId('diff-viewer')).toBeHidden();
  });
}

test('a queued hashchange for the current route does not dismiss a newly opened viewer', async ({
  page,
}) => {
  await page.goto('/#/prs');
  await expect(page.getByTestId('pr-open-view-diff-example/workspace-17')).toBeVisible();
  await page.getByTestId('tab-home').click();
  await expect(page.getByTestId('home-actions')).toBeVisible();
  await page.evaluate(async () => {
    const delivered = new Promise((resolve) =>
      window.addEventListener('hashchange', () => setTimeout(resolve, 0), { once: true }),
    );
    location.hash = '#/prs';
    document.querySelector('[data-testid="pr-open-view-diff-example/workspace-17"]').click();
    await delivered;
  });
  await expect(page.getByTestId('panel-prs')).toBeVisible();
  await expect(page.getByTestId('diff-viewer')).toBeVisible();
  await expect(page.getByTestId('diff-copy')).toBeEnabled();
  await expect(page.getByTestId('diff-content')).toContainText('example.js');
});

test('missing clipboard API preserves the loaded patch and offers actionable recovery', async ({
  page,
  dashboard,
}) => {
  await page.goto('/#/prs');
  await page.getByTestId('pr-open-view-diff-example/workspace-17').click();
  await expect(page.getByTestId('diff-copy')).toBeEnabled();
  await page.evaluate(() => {
    window.__savedClipboard = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  });
  await page.getByTestId('diff-copy').click();
  await expect(page.getByTestId('diff-status')).toContainText(/clipboard unavailable/i);
  await expect(page.getByTestId('diff-status')).toContainText(/localhost|HTTPS/);
  await expect(page.getByTestId('diff-content')).toContainText('example.js');
  await expect(page.getByTestId('diff-copy')).toBeEnabled();
  await expect(page.getByTestId('diff-retry')).toBeHidden();
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: window.__savedClipboard,
    }),
  );
  await page.getByTestId('diff-copy').click();
  expect(await page.evaluate(() => window.__dashboardMock.clipboard.writes)).toEqual([
    dashboard.data.diff.diff,
  ]);
  expect(dashboard.requests.filter((r) => r.path.startsWith('/api/pr-diff'))).toHaveLength(1);
});

test('loaded scroll survives polling and a removed opener restores focus to the active tab', async ({
  page,
  dashboard,
}) => {
  dashboard.data.diff = {
    diff: '@@ -0,0 +1,200 @@\n' + ('+' + 'wide-row-'.repeat(100) + '\n').repeat(200),
  };
  await page.goto('/#/prs');
  const trigger = page.getByTestId('pr-open-view-diff-example/workspace-17');
  await expect(trigger).toBeVisible();
  await page.clock.install();
  await trigger.click();
  await expect(page.getByTestId('diff-copy')).toBeEnabled();
  const content = page.getByTestId('diff-content');
  const before = await content.evaluate((el) => {
    el.scrollTop = 500;
    el.scrollLeft = 200;
    window.__loadedDiffContent = el.firstElementChild;
    return { top: el.scrollTop, left: el.scrollLeft };
  });
  expect(before.top).toBeGreaterThan(0);
  expect(before.left).toBeGreaterThan(0);
  dashboard.data.prs.prs = [];
  dashboard.data.prs.groups = {};
  await page.clock.fastForward(91_000);
  await expect(trigger).toHaveCount(0);
  expect(await content.evaluate((el) => ({ top: el.scrollTop, left: el.scrollLeft }))).toEqual(
    before,
  );
  expect(await content.evaluate((el) => el.firstElementChild === window.__loadedDiffContent)).toBe(
    true,
  );
  expect(dashboard.requests.filter((r) => r.path.startsWith('/api/pr-diff'))).toHaveLength(1);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('diff-viewer')).toBeHidden();
  await expect(page.getByTestId('tab-prs')).toBeFocused();
});
