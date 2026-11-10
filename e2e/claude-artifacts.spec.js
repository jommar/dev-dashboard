import { test, expect } from './fixtures.js';
import { claudeEntry, ticketBoardData } from './data.js';

// The Markdown viewer opened from the Claude dialog (View plan, View groom notes, Files). The files
// are what GET /api/claude/artifacts and /artifact answer from `claude.artifacts` (e2e/data.js);
// the fixture also fails a test that reaches any other origin, which is how "never fetches a
// remote image" is checked. Invented data only.
const KEY = 'TAP-9001';
const PLAN_FINISHED = {
  'investigate-and-plan': true,
  'implement-plan': false,
  done: true,
  approved: true,
};
const PLAN = `# Invented plan

Intro with **bold**, \`inline code\` and an [external link](https://example.com/docs).

- [x] first step done
- [ ] second step open

| Step | Owner |
| ---- | ----- |
| one  | alex  |

\`\`\`js
const answer = 42;
\`\`\`

[bad link](javascript:alert(1))

![remote picture](https://tracker.example/pixel.png)

<img src="https://tracker.example/raw.png" onerror="window.__injected = true">
<script>window.__injected = true</script>
`;
const CHECKLIST = '# Checklist\n\n- [ ] write the test\n';

const iconOf = (page) => page.getByTestId(`claude-icon-${KEY}`);

async function openClaudeDialog(page, dashboard, { entry, artifacts = {} } = {}) {
  ticketBoardData(dashboard.data);
  dashboard.data.claude.tickets[KEY] =
    entry ?? claudeEntry('done', 'plan_ready', { flags: PLAN_FINISHED });
  dashboard.data.claude.artifacts[KEY] = artifacts;
  await page.goto('/#/my-tickets');
  await expect(page.getByTestId(`my-tickets-item-${KEY}`)).toBeVisible();
  await iconOf(page).click();
  const dialog = page.getByTestId('claude-dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

test('View plan opens the plan rendered as Markdown, safely', async ({ page, dashboard }) => {
  const dialog = await openClaudeDialog(page, dashboard, {
    artifacts: { '02-plan.md': PLAN, '02-checklist.md': CHECKLIST },
  });
  await dialog.getByTestId('claude-view-plan').click();
  const viewer = page.getByTestId('artifact-viewer');
  await expect(viewer).toBeVisible();
  await expect(page.getByTestId('artifact-viewer-title')).toContainText('02-plan.md');
  const body = page.getByTestId('artifact-markdown');
  await expect(body.getByRole('heading', { level: 1, name: 'Invented plan' })).toBeVisible();
  await expect(body.locator('strong')).toHaveText('bold');
  await expect(body.locator('pre code')).toContainText('const answer = 42;');
  // GitHub-flavoured: a table (inside its own scroller) and a read-only task list.
  await expect(body.locator('.markdown-table-scroll table th')).toHaveText(['Step', 'Owner']);
  const boxes = body.locator('input[type="checkbox"]');
  await expect(boxes).toHaveCount(2);
  await expect(boxes.first()).toBeChecked();
  await expect(boxes.first()).toBeDisabled();
  // An http(s) link opens in a new tab without the opener; a script link is not a link at all.
  const link = body.getByRole('link', { name: 'external link' });
  await expect(link).toHaveAttribute('href', 'https://example.com/docs');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /noopener/);
  await expect(body.getByRole('link', { name: 'bad link' })).toHaveCount(0);
  await expect(body).toContainText('bad link');
  // An image is never fetched (the fixture fails the test on any other origin) and raw HTML does
  // not become elements or run.
  await expect(body).toContainText('[image: remote picture]');
  await expect(body.locator('img, script')).toHaveCount(0);
  expect(await page.evaluate(() => window.__injected)).toBeUndefined();
  await expect(page.getByTestId('artifact-meta')).toContainText('updated');
});

test('the files switch, Reload re-reads, and Escape closes only the viewer', async ({
  page,
  dashboard,
}) => {
  const dialog = await openClaudeDialog(page, dashboard, {
    artifacts: { 'groom.md': '# Groom\n', '02-checklist.md': CHECKLIST, '02-plan.md': PLAN },
  });
  await dialog.getByTestId('claude-files-open').click();
  const viewer = page.getByTestId('artifact-viewer');
  await expect(viewer).toBeVisible();
  // The plan is first and open; the rest follow by name.
  const files = viewer.getByRole('navigation', { name: 'Files' }).getByRole('button');
  await expect(files).toHaveText(['02-plan.md', '02-checklist.md', 'groom.md']);
  await expect(files.first()).toHaveAttribute('aria-current', 'true');
  await files.nth(1).click();
  await expect(page.getByTestId('artifact-viewer-title')).toContainText('02-checklist.md');
  await expect(page.getByTestId('artifact-markdown')).toContainText('write the test');
  await expect(files.nth(1)).toHaveAttribute('aria-current', 'true');
  await expect(files.first()).not.toHaveAttribute('aria-current', 'true');

  // A session that is still writing: Reload shows the new text without closing anything.
  dashboard.data.claude.artifacts[KEY]['02-checklist.md'] = '# Checklist\n\n- [x] written\n';
  await page.getByTestId('artifact-reload').click();
  await expect(page.getByTestId('artifact-markdown')).toContainText('written');

  // Copy path copies the file's real location.
  await page.getByTestId('artifact-copy-path').click();
  await expect(page.getByTestId('artifact-status')).toHaveText('Path copied');
  expect(await page.evaluate(() => window.__dashboardMock.clipboard.writes.at(-1))).toBe(
    '~/pathwise/.orchestrator/tap-9001/02-checklist.md',
  );

  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('claude-files-open')).toBeFocused();
});

test('a ticket with no files says so, also once its only file is deleted', async ({
  page,
  dashboard,
}) => {
  const dialog = await openClaudeDialog(page, dashboard);
  await dialog.getByTestId('claude-files-open').click();
  await expect(page.getByTestId('artifact-empty')).toHaveText(
    'No Markdown files for this ticket yet.',
  );
  await expect(page.getByTestId('artifact-copy-path')).toBeDisabled();
  await page.getByTestId('artifact-close').click();
  await expect(page.getByTestId('artifact-viewer')).toHaveCount(0);

  // The plan is listed, then deleted before it is read: the viewer says so, and keeps working.
  dashboard.data.claude.artifacts[KEY] = { '02-plan.md': PLAN };
  await dialog.getByTestId('claude-view-plan').click();
  await expect(page.getByTestId('artifact-markdown')).toBeVisible();
  delete dashboard.data.claude.artifacts[KEY]['02-plan.md'];
  await page.getByTestId('artifact-reload').click();
  await expect(page.getByTestId('artifact-empty')).toBeVisible();
});

test('groom notes open from the groom result', async ({ page, dashboard }) => {
  const dialog = await openClaudeDialog(page, dashboard, {
    entry: claudeEntry('none', 'not_started', { groom: { state: 'done', reason: null } }),
    artifacts: { 'groom.md': '# Groomed ticket\n\n- looks small\n' },
  });
  await dialog.getByTestId('claude-view-groom').click();
  await expect(page.getByTestId('artifact-viewer-title')).toContainText('groom.md');
  await expect(page.getByTestId('artifact-markdown')).toContainText('looks small');
});

test('front matter is a metadata row, and links to sibling files switch files', async ({
  page,
  dashboard,
}) => {
  const plan = [
    '---',
    'kind: plan',
    'slug: tap-9001',
    'status: DONE',
    '---',
    '# Plan with front matter',
    '',
    'See [the checklist](./02-checklist.md), [the spec](tap-9001/02-spec.md#top),',
    '[a file that is not there](./02-missing.md), [up a folder](../secret.md)',
    'and [a path in the app](/etc/passwd.md).',
    '',
  ].join('\n');
  const dialog = await openClaudeDialog(page, dashboard, {
    artifacts: { '02-plan.md': plan, '02-checklist.md': CHECKLIST, '02-spec.md': '# Spec\n' },
  });
  await dialog.getByTestId('claude-files-open').click();
  const body = page.getByTestId('artifact-markdown');
  // The block is a labelled row, not a rule and a paragraph of raw lines.
  const facts = page.getByTestId('markdown-front-matter');
  await expect(facts).toContainText('kind');
  await expect(facts).toContainText('plan');
  await expect(facts).toContainText('DONE');
  await expect(body.locator('hr')).toHaveCount(0);
  await expect(body.getByRole('heading', { level: 1 })).toHaveText('Plan with front matter');
  await expect(body).not.toContainText('kind: plan');
  // Only a sibling the viewer has is a live link; the rest read as plain text.
  for (const dead of ['a file that is not there', 'up a folder', 'a path in the app'])
    await expect(body.getByRole('button', { name: dead })).toHaveCount(0);
  await expect(body.getByRole('link')).toHaveCount(0);
  await body.getByRole('button', { name: 'the spec' }).click();
  await expect(page.getByTestId('artifact-viewer-title')).toContainText('02-spec.md');
  await expect(page.getByTestId('artifact-markdown')).toContainText('Spec');
  await expect(page.getByTestId('artifact-file-02-spec.md')).toHaveAttribute(
    'aria-current',
    'true',
  );
});

test('many files stay on one line that scrolls sideways and keeps the open file in view', async ({
  page,
  dashboard,
}) => {
  const names = [
    '02-plan.md',
    ...Array.from(
      { length: 24 },
      (_, index) => `0${(index % 9) + 1}-investigation-part-${index}.md`,
    ),
    'zz-last-report.md',
  ];
  const dialog = await openClaudeDialog(page, dashboard, {
    artifacts: Object.fromEntries(names.map((name) => [name, `# ${name}\n`])),
  });
  await dialog.getByTestId('claude-files-open').click();
  const row = page.getByRole('navigation', { name: 'Files' });
  const buttons = row.getByRole('button');
  await expect(buttons).toHaveCount(names.length);
  // One line: the row is no taller than a single button row, and it overflows sideways.
  const metrics = await row.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    scrolls: element.scrollWidth > element.clientWidth,
    overflowX: getComputedStyle(element).overflowX,
    top: Math.min(...[...element.children].map((child) => child.getBoundingClientRect().top)),
    bottom: Math.max(...[...element.children].map((child) => child.getBoundingClientRect().top)),
  }));
  expect(metrics.height).toBeLessThan(60);
  expect(metrics.scrolls).toBe(true);
  expect(metrics.overflowX).toBe('auto');
  expect(metrics.bottom, 'every file sits on the same line').toBe(metrics.top);
  // The last file starts out of sight; opening it (by keyboard) scrolls it into view.
  const last = row.getByRole('button', { name: 'zz-last-report.md' });
  const visible = () =>
    last.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const frame = element.parentElement.getBoundingClientRect();
      return box.left >= frame.left - 1 && box.right <= frame.right + 1;
    });
  expect(await visible()).toBe(false);
  await last.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('artifact-viewer-title')).toContainText('zz-last-report.md');
  await expect.poll(visible).toBe(true);
  // A wheel over the row moves it sideways.
  const before = await row.evaluate((element) => element.scrollLeft);
  await row.hover();
  await page.mouse.wheel(0, -400);
  await expect.poll(() => row.evaluate((element) => element.scrollLeft)).toBeLessThan(before);
});

test('switching files never shows the previous file’s text under the new name', async ({
  page,
  dashboard,
}) => {
  const dialog = await openClaudeDialog(page, dashboard, {
    artifacts: { '02-plan.md': '# Plan text\n', '02-checklist.md': CHECKLIST },
  });
  await dialog.getByTestId('claude-files-open').click();
  await expect(page.getByTestId('artifact-markdown')).toContainText('Plan text');
  // Every state the viewer passes through (a polling assertion would miss a one-frame flash):
  // the title and the body text after each DOM change, recorded from the click on.
  await page.evaluate(() => {
    const viewer = document.querySelector('[data-testid="artifact-viewer"]');
    const states = [];
    const note = () =>
      states.push([
        viewer.querySelector('[data-testid="artifact-viewer-title"]').textContent,
        viewer.querySelector('[data-testid="artifact-body"]').textContent,
      ]);
    new MutationObserver(note).observe(viewer, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    window.__viewerStates = states;
    viewer.querySelector('[data-testid="artifact-file-02-checklist.md"]').click();
    note();
  });
  await expect(page.getByTestId('artifact-markdown')).toContainText('write the test');
  const states = await page.evaluate(() => window.__viewerStates);
  expect(states.length).toBeGreaterThan(1);
  const stale = states.filter(
    ([title, body]) => title.includes('02-checklist.md') && body.includes('Plan text'),
  );
  expect(stale, 'the plan text was shown under the checklist’s name').toEqual([]);
});
