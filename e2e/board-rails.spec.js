import { test, expect } from './fixtures.js';

const lane = (page, id) => page.getByTestId(`prs-column-${id}`);
const width = async (locator) => (await locator.boundingBox()).width;
const search = (page) =>
  page.getByTestId('panel-prs').getByRole('searchbox', { name: 'Search', exact: true });

// The default fixture holds two tickets To Review and one Reviewing; Reviewed and Spec review are
// empty, so beside the two populated lanes they are slim rails.
const LANES = [
  ['to-review', 'To Review'],
  ['reviewing', 'Reviewing'],
  ['reviewed', 'Reviewed'],
  ['spec-review', 'Spec review'],
];

test('an empty lane beside a populated one is a slim rail that keeps its name and count', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1700, height: 900 });
  await page.goto('/#/prs');
  await expect(page.getByTestId('prs-ticket-DEMO-1')).toBeVisible();
  await expect(page.getByTestId('prs-board').getByRole('group')).toHaveCount(4);
  for (const id of ['to-review', 'reviewing']) {
    expect(await width(lane(page, id))).toBe(280);
    await expect(lane(page, id)).not.toHaveAttribute('data-empty', /.*/);
  }
  for (const id of ['reviewed', 'spec-review']) {
    expect(await width(lane(page, id))).toBe(44);
    await expect(lane(page, id)).toHaveAttribute('data-empty', 'true');
    await expect(page.getByTestId(`prs-column-count-${id}`)).toHaveText('0');
    await expect(page.getByTestId(`prs-column-count-${id}`)).toBeVisible();
    await expect(page.getByTestId(`prs-column-body-${id}`)).toBeHidden();
  }
  for (const [id, label] of LANES) {
    await expect(lane(page, id)).toHaveAccessibleName(label);
    await expect(lane(page, id).getByRole('heading', { name: label, exact: true })).toBeVisible();
  }
  // A rail heading with a hint is still a Tab stop and still explains the lane.
  const heading = lane(page, 'reviewed').getByRole('heading', { name: 'Reviewed', exact: true });
  await page.getByTestId('prs-board').focus();
  for (
    let step = 0;
    step < 30 && !(await heading.evaluate((node) => node === document.activeElement));
    step += 1
  )
    await page.keyboard.press('Tab');
  await expect(heading).toBeFocused();
  await expect(page.getByRole('tooltip')).toContainText(/approved by anyone/i);
});

test('a board whose columns are all empty keeps full columns', async ({ page }) => {
  await page.setViewportSize({ width: 1700, height: 900 });
  await page.goto('/#/prs');
  await expect(page.getByTestId('prs-ticket-DEMO-1')).toBeVisible();
  // Precondition: with tickets, the empty lanes are rails.
  await expect(lane(page, 'reviewed')).toHaveAttribute('data-empty', 'true');
  await search(page).fill('no matching ticket');
  await expect(page.getByTestId('prs-no-matches')).toBeVisible();
  await expect(page.getByTestId('prs-board').getByRole('group')).toHaveCount(4);
  for (const [id] of LANES) {
    expect(await width(lane(page, id))).toBe(280);
    await expect(lane(page, id)).toHaveAttribute('data-empty', 'true');
    await expect(page.getByTestId(`prs-column-body-${id}`)).toBeVisible();
  }
});

test('a lane holding only a Load more button stays a full column', async ({ page, dashboard }) => {
  dashboard.data.specReviews = {
    available: true,
    total: 0,
    specs: [],
    hasMore: true,
    updatedAt: '2026-11-09T10:00:00Z',
  };
  await page.setViewportSize({ width: 1700, height: 900 });
  await page.goto('/#/prs');
  await expect(page.getByTestId('prs-spec-load-more')).toBeVisible();
  await expect(page.getByTestId('prs-column-count-spec-review')).toHaveText('0');
  await expect(lane(page, 'spec-review')).not.toHaveAttribute('data-empty', /.*/);
  expect(await width(lane(page, 'spec-review'))).toBe(280);
  // The truly empty lane beside it is the rail.
  await expect(lane(page, 'reviewed')).toHaveAttribute('data-empty', 'true');
  expect(await width(lane(page, 'reviewed'))).toBe(44);
});

test('at 390px a rail is 44px wide, snaps to the end and stays reachable, populated lanes stay 82vw', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/#/prs');
  await expect(page.getByTestId('prs-ticket-DEMO-1')).toBeVisible();
  expect(await width(lane(page, 'to-review'))).toBeCloseTo(390 * 0.82, 0);
  expect(await width(lane(page, 'reviewing'))).toBeCloseTo(390 * 0.82, 0);
  for (const id of ['reviewed', 'spec-review']) {
    expect(await width(lane(page, id))).toBe(44);
    // A rail snaps to the end, so the mandatory snap can rest at the track's end.
    expect(await lane(page, id).evaluate((el) => getComputedStyle(el).scrollSnapAlign)).toMatch(
      /^end/,
    );
  }
  expect(
    await lane(page, 'to-review').evaluate((el) => getComputedStyle(el).scrollSnapAlign),
  ).toMatch(/^start/);
  // Scrolled to the end, the last rail is fully on screen (mandatory snap must not pull it back).
  const board = page.getByTestId('prs-board');
  await board.evaluate((el) => el.scrollTo({ left: el.scrollWidth, behavior: 'instant' }));
  await expect
    .poll(async () => {
      const box = await lane(page, 'spec-review').boundingBox();
      return box.x >= 0 && box.x + box.width <= 390;
    })
    .toBe(true);
});
