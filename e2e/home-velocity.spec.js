import { test, expect, seedVelocitySnapshot } from './fixtures.js';
import { homeVelocityData } from './data.js';

const preferenceKey = 'dev-dashboard.home-velocity';
const snapshotKey = 'dev-dashboard.home-velocity.snapshot';
const alexA = `person:${'a'.repeat(64)}`;
const alexB = `person:${'b'.repeat(64)}`;
const team = (page) => page.getByTestId('home-velocity-team');
const person = (page) => page.getByTestId('home-velocity-person');
const sprint = (page) => page.getByTestId('home-velocity-sprint');
const chart = (page) => page.getByTestId('home-velocity-chart');
const refresh = (page) => page.getByTestId('home-refresh');
const reads = (dashboard) =>
  dashboard.requests.filter(({ path }) => path === '/api/team-velocity').length;
const stored = (page, key = snapshotKey) => page.evaluate((key) => localStorage.getItem(key), key);
const record = (snapshot) => JSON.stringify({ version: 2, snapshot });
const noCache = (page) => page.getByTestId('home-velocity-no-snapshot');

async function setStored(page, key, value) {
  await page.evaluate(
    ({ key, value }) => {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    },
    { key, value },
  );
}

async function denySnapshotWrites(page) {
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    window.__restoreVelocityWrites = () => {
      Storage.prototype.setItem = setItem;
    };
    Storage.prototype.setItem = function (key, value) {
      if (key === 'dev-dashboard.home-velocity.snapshot')
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      return setItem.call(this, key, value);
    };
  });
}

test('first visit offers Generate with no implicit velocity request @regression', async ({
  page,
  dashboard,
}) => {
  await page.goto('/#/home');
  await expect(page.getByTestId('home-title')).toHaveText('Velocity');
  await expect(team(page)).toHaveValue('Nexus');
  await expect(team(page)).toHaveAccessibleName('Team');
  await expect(person(page)).toHaveAccessibleName('Person');
  await expect(person(page)).toHaveValue('');
  await expect(noCache(page)).toHaveText(
    'No saved velocity snapshot. Generate velocity to load team sprint history.',
  );
  await expect(refresh(page)).toHaveText('Generate velocity');
  await expect(page.getByTestId('home-velocity-loading')).toHaveCount(0);
  await expect(chart(page)).toHaveCount(0);
  expect(reads(dashboard)).toBe(0);
  await refresh(page).click();
  await expect(chart(page)).toContainText('Nexus Sprint 2');
  await expect(chart(page)).not.toContainText('Mobile Sprint 11');
  await expect(refresh(page)).toHaveText('Refresh');
  await expect(page.getByTestId('home-meta')).toContainText('Generated');
  expect(reads(dashboard)).toBe(1);
  expect(JSON.parse(await stored(page))).toEqual({
    version: 2,
    snapshot: dashboard.data.teamVelocity,
  });
  expect(await stored(page, preferenceKey)).toBeNull();
  for (const id of [
    'home-actions-block',
    'home-services-block',
    'home-kpi-row',
    'home-sprint-block',
    'home-next',
  ]) {
    await expect(page.getByTestId(id)).toHaveCount(0);
  }
  expect(
    dashboard.requests.filter(({ path }) => /^\/api\/(prs|my-tickets)(\?|$)/.test(path)),
  ).toEqual([]);
});

test('persists selected team and original generated snapshot without revalidation @regression', async ({
  page,
  dashboard,
}) => {
  await seedVelocitySnapshot(page, dashboard.data.teamVelocity);
  await page.addInitScript(
    ({ key }) => {
      if (!localStorage.getItem(key))
        localStorage.setItem(key, JSON.stringify({ version: 1, team: 'Mobile' }));
    },
    { key: preferenceKey },
  );
  await page.goto('/#/home');
  await expect(team(page)).toHaveValue('Mobile');
  await expect(chart(page)).toContainText('Mobile Sprint 11');
  const generated = await page.getByTestId('home-meta').textContent();
  expect(generated).toContain('Generated');
  expect(generated).toContain('2026');
  const saved = await stored(page);
  await page.reload();
  await expect(team(page)).toHaveValue('Mobile');
  await expect(chart(page)).toContainText('Mobile Sprint 11');
  await page.getByTestId('tab-services').click();
  await page.getByTestId('tab-home').click();
  await team(page).selectOption('Nexus');
  await expect(chart(page)).toContainText('Nexus Sprint 2');
  await team(page).selectOption('Mobile');
  await expect(chart(page)).toContainText('Mobile Sprint 11');
  await expect(chart(page)).not.toContainText('Nexus Sprint');
  await expect(page.getByTestId('home-meta')).toHaveText(generated);
  expect(reads(dashboard)).toBe(0);
  expect(await stored(page)).toBe(saved);
  expect(JSON.parse(await stored(page, preferenceKey))).toEqual({ version: 1, team: 'Mobile' });
  dashboard.data.teamVelocity.updatedAt = '2026-11-10T01:02:03Z';
  await refresh(page).click();
  await expect(refresh(page)).toBeEnabled();
  expect(reads(dashboard)).toBe(1);
  expect(JSON.parse(await stored(page))).toEqual({
    version: 2,
    snapshot: dashboard.data.teamVelocity,
  });
  await expect(team(page)).toHaveValue('Mobile');
  await expect(chart(page)).toContainText('Mobile Sprint 11');
});

test('storage edge cases fail closed without fetching and keep unsaved successful data usable @regression', async ({
  page,
  context,
  dashboard,
}) => {
  await page.goto('/#/home');
  const personless = homeVelocityData();
  delete personless.boards[0].people;
  const invalid = homeVelocityData();
  invalid.boards[1].series[0].points = -1;
  for (const raw of [
    null,
    '{broken',
    JSON.stringify({ version: 1, snapshot: homeVelocityData() }),
    record(personless),
    record(invalid),
  ]) {
    await test.step(`invalid cache ${raw?.slice(0, 40)}`, async () => {
      await setStored(page, snapshotKey, raw);
      await setStored(page, preferenceKey, JSON.stringify({ version: 1, team: 'Mobile' }));
      await page.reload();
      await expect(noCache(page)).toBeVisible();
      await expect(team(page)).toHaveValue('Mobile');
      await expect(refresh(page)).toHaveText('Generate velocity');
      expect(await stored(page)).toBe(raw);
      expect(reads(dashboard)).toBe(0);
    });
  }
  const cached = homeVelocityData();
  await setStored(page, snapshotKey, record(cached));
  await setStored(page, preferenceKey, JSON.stringify({ version: 1, team: 'Removed Team' }));
  await page.reload();
  await expect(team(page)).toHaveValue('Removed Team');
  await expect(page.getByTestId('home-velocity-empty')).toHaveText(
    'No velocity history for Removed Team.',
  );
  await expect(chart(page)).toHaveCount(0);
  const empty = { ...cached, boards: [] };
  await setStored(page, snapshotKey, record(empty));
  await page.reload();
  await expect(page.getByTestId('home-velocity-empty')).toContainText('Removed Team');
  await expect(page.getByTestId('home-meta')).toContainText('Generated');
  await expect(refresh(page)).toHaveText('Refresh');
  expect(reads(dashboard)).toBe(0);

  await setStored(page, snapshotKey, record(cached));
  await setStored(page, preferenceKey, '{bad team');
  await page.reload();
  await expect(team(page)).toHaveValue('Nexus');
  await expect(chart(page)).toContainText('Nexus Sprint 2');
  const old = await stored(page);
  const oldMeta = await page.getByTestId('home-meta').textContent();
  // Reject personless manual results without replacing a last-good cache or date.
  dashboard.data.teamVelocity = personless;
  await refresh(page).click();
  await expect(page.getByTestId('home-velocity-stale')).toBeVisible();
  expect(await stored(page)).toBe(old);
  await expect(page.getByTestId('home-meta')).toHaveText(oldMeta);

  dashboard.data.teamVelocity = homeVelocityData();
  dashboard.data.teamVelocity.updatedAt = '2026-11-10T01:02:03Z';
  await denySnapshotWrites(page);
  await refresh(page).click();
  await expect(page.getByTestId('home-velocity-save-warning')).toHaveText(
    'Could not save velocity in this browser; this update may not survive reload.',
  );
  await expect(chart(page)).toContainText('Nexus Sprint 2');
  await expect(page.getByTestId('home-meta')).not.toHaveText(oldMeta);
  expect(await stored(page)).toBe(old);
  const beforeOldReload = reads(dashboard);
  await page.reload();
  await expect(chart(page)).toContainText('Nexus Sprint 2');
  await expect(page.getByTestId('home-meta')).toHaveText(oldMeta);
  expect(reads(dashboard)).toBe(beforeOldReload);
  expect(await stored(page)).toBe(old);
  // A later successful save clears an existing warning without discarding the in-memory data.
  await denySnapshotWrites(page);
  await refresh(page).click();
  await expect(page.getByTestId('home-velocity-save-warning')).toBeVisible();
  await page.evaluate(() => window.__restoreVelocityWrites());
  await refresh(page).click();
  await expect(refresh(page)).toBeEnabled();
  await expect(page.getByTestId('home-velocity-save-warning')).toHaveCount(0);
  expect(JSON.parse(await stored(page)).snapshot.updatedAt).toBe('2026-11-10T01:02:03Z');
  const beforeReload = reads(dashboard);
  await page.reload();
  await expect(chart(page)).toBeVisible();
  expect(reads(dashboard)).toBe(beforeReload);

  await context.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw new Error('Storage denied');
    };
    Storage.prototype.setItem = () => {
      throw new Error('Storage denied');
    };
  });
  await page.reload();
  await expect(noCache(page)).toBeVisible();
  expect(reads(dashboard)).toBe(beforeReload);
  await refresh(page).click();
  await expect(chart(page)).toBeVisible();
  await expect(page.getByTestId('home-velocity-save-warning')).toBeVisible();
  await team(page).selectOption('Mobile');
  await expect(chart(page)).toContainText('Mobile Sprint 11');
});

test('loading error retry and stale only follow explicit manual generation @regression', async ({
  page,
  dashboard,
}) => {
  const pending = [];
  await page.route('**/api/team-velocity', (route) => {
    pending.push(route);
  });
  await page.goto('/#/home');
  await expect(noCache(page)).toBeVisible();
  expect(pending).toHaveLength(0);
  await refresh(page).click();
  await expect.poll(() => pending.length).toBe(1);
  await expect(page.getByTestId('home-velocity-loading')).toContainText('Nexus');
  await expect(refresh(page)).toBeDisabled();
  await refresh(page).evaluate((el) => {
    el.click();
    el.click();
  });
  expect(pending).toHaveLength(1);
  await pending[0].fulfill({ status: 502, json: { error: 'Velocity unavailable' } });
  await expect(page.getByTestId('home-velocity-error')).toContainText('Velocity unavailable');
  await expect(refresh(page)).toBeEnabled();
  await expect(refresh(page)).toHaveText('Generate velocity');
  expect(await stored(page)).toBeNull();
  await refresh(page).click();
  await expect.poll(() => pending.length).toBe(2);
  await pending[1].fulfill({ json: dashboard.data.teamVelocity });
  await expect(chart(page)).toContainText('Nexus Sprint 2');
  const old = await stored(page);
  const date = await page.getByTestId('home-meta').textContent();
  await person(page).selectOption(alexA);
  await refresh(page).click();
  await expect.poll(() => pending.length).toBe(3);
  await expect(chart(page)).toContainText('Nexus Sprint 2');
  expect(await stored(page)).toBe(old);
  await expect(person(page)).toBeEnabled();
  await person(page).selectOption(alexB);
  await expect(page.getByTestId('home-velocity-total')).toHaveText(['0', '1.25', '0', '3']);
  await team(page).selectOption('Mobile');
  await expect(person(page)).toHaveValue('');
  await expect(chart(page)).toContainText('Mobile Sprint 11');
  await expect(chart(page)).not.toContainText('Nexus Sprint');
  await pending[2].fulfill({ status: 502, json: { error: 'Refresh unavailable' } });
  await expect(page.getByTestId('home-velocity-stale')).toContainText(
    /stale|last (successful|update)/i,
  );
  await expect(page.getByTestId('home-meta')).toHaveText(date);
  expect(await stored(page)).toBe(old);
  await expect(chart(page)).toContainText('Mobile Sprint 11');
  expect(JSON.parse(await stored(page, preferenceKey)).team).toBe('Mobile');
});

test('honest values expose exact estimates status memberships and uncertainty @regression', async ({
  page,
  dashboard,
}) => {
  dashboard.data.teamVelocity.coverage.possibleTruncation = true;
  await seedVelocitySnapshot(page, dashboard.data.teamVelocity);
  await page.goto('/#/home');
  await expect(chart(page)).toBeVisible();
  const data = page.getByTestId('home-velocity-data');
  for (const value of [
    'Nexus Sprint 1',
    'Nexus Sprint 2',
    'Nexus Sprint 3',
    'active',
    '4.75',
    '2.5',
    '1.25',
    'Completed',
    'In progress',
    'Not started',
    'unestimated',
  ]) {
    await expect(data).toContainText(value);
  }
  await expect(page.getByTestId('home-velocity-methodology')).toContainText(
    /current.*(status|estimates)/i,
  );
  await expect(page.getByTestId('home-velocity-methodology')).toContainText(/sprint names/i);
  await expect(page.getByTestId('home-velocity-methodology')).toContainText(
    /not.*(snapshot|sprint.close)/i,
  );
  await expect(page.getByTestId('home-velocity-coverage')).toContainText(
    /(unverified|not verified|unknown)/i,
  );
  await expect(page.getByTestId('home-velocity-coverage')).toContainText(/(limit|5000|5,000)/i);
  for (const index of [0, 2]) {
    await expect(page.getByTestId('home-velocity-total').nth(index)).toHaveText('0');
    expect(
      await page
        .getByTestId('home-velocity-stack')
        .nth(index)
        .evaluate((el) => el.getBoundingClientRect().height),
    ).toBe(0);
  }
  await expect(page.getByTestId('home-velocity-axis')).toContainText('0');
  await expect(data).not.toContainText('Invalid Date');
  expect(reads(dashboard)).toBe(0);
  dashboard.data.teamVelocity.coverage.possibleTruncation = false;
  await refresh(page).click();
  await expect(refresh(page)).toBeEnabled();
  await expect(page.getByTestId('home-velocity-coverage')).toContainText(
    /(unverified|not verified|unknown)/i,
  );
});

test('responsive keyboard access keeps overflow internal and full data reachable @regression', async ({
  page,
  dashboard,
}) => {
  const longName = 'A very long team identity that must remain available to keyboard users';
  const series = Array.from({ length: 8 }, (_, index) => ({
    ...dashboard.data.teamVelocity.boards[1].series[1],
    sprint: {
      id: index + 20,
      name: `${longName} Sprint ${index + 20}`,
      state: 'closed',
      endDate: null,
    },
  }));
  dashboard.data.teamVelocity.boards.push({
    name: longName,
    series,
    people: [
      {
        id: `name:${'d'.repeat(64)}`,
        displayName: 'A very long person display name for responsive controls',
        series: structuredClone(series),
      },
    ],
  });
  dashboard.data.teamVelocity.boards.sort((a, b) => a.name.localeCompare(b.name));
  await seedVelocitySnapshot(page, dashboard.data.teamVelocity);
  await page.goto('/#/home');
  await expect(chart(page)).toBeVisible();
  for (const [width, height] of [
    [320, 700],
    [390, 844],
    [760, 900],
    [1440, 900],
    [1440, 600],
  ]) {
    await test.step(`${width}x${height}`, async () => {
      await page.setViewportSize({ width, height });
      await team(page).focus();
      await team(page).press('Home');
      await team(page).press('Enter');
      await expect(team(page)).toHaveValue(longName);
      await expect(team(page)).toBeFocused();
      expect(
        await team(page).evaluate((el) => {
          const style = getComputedStyle(el);
          return style.outlineStyle !== 'none' || style.boxShadow !== 'none';
        }),
      ).toBe(true);
      await expect(page.getByTestId('home-velocity-data')).toContainText(`${longName} Sprint 27`);
      await person(page).focus();
      await person(page).press('End');
      await person(page).press('Enter');
      await expect(person(page)).toHaveValue(`name:${'d'.repeat(64)}`);
      await expect(person(page)).toBeFocused();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      const scroll = page.getByTestId('home-velocity-scroll');
      await scroll.focus();
      await scroll.press('End');
      await expect(scroll).toBeFocused();
      expect((await scroll.boundingBox()).width).toBeLessThanOrEqual(width);
      await page.getByTestId('home-velocity-methodology').scrollIntoViewIfNeeded();
      await expect(page.getByTestId('home-velocity-methodology')).toBeInViewport();
      await page.screenshot({
        path: `.orchestrator/home-velocity/scratch/screenshots/manual-home-${width}x${height}.png`,
      });
      await team(page).selectOption('Mobile');
      await expect(chart(page)).toContainText('Mobile Sprint 11');
      await expect(person(page)).toHaveValue('');
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    });
  }
  expect(reads(dashboard)).toBe(0);
});

test('manual snapshot lifecycle never fetches on old invalid or absent cache @regression', async ({
  page,
  dashboard,
}) => {
  const old = homeVelocityData();
  old.updatedAt = '2001-01-02T03:04:05Z';
  const mobile = old.boards[0];
  mobile.series = Array.from({ length: 8 }, (_, index) => ({
    ...structuredClone(mobile.series[0]),
    sprint: { ...mobile.series[0].sprint, id: index + 11, name: `Mobile Sprint ${index + 11}` },
  }));
  mobile.people[0].series = structuredClone(mobile.series);
  await page.clock.install();
  await page.goto('/#/home');
  for (const raw of [null, '{invalid', record(old)]) {
    await test.step(`lifecycle ${raw?.slice(0, 35)}`, async () => {
      await setStored(page, snapshotKey, raw);
      await page.reload();
      if (raw === record(old)) await expect(chart(page)).toBeVisible();
      else await expect(noCache(page)).toBeVisible();
      const meta = await page.getByTestId('home-meta').textContent();
      await page.clock.fastForward(91_000);
      await page.getByTestId('tab-services').click();
      await page.getByTestId('tab-home').click();
      await page.evaluate(() => {
        for (const hidden of [true, false]) {
          Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
          document.dispatchEvent(new Event('visibilitychange'));
        }
        window.dispatchEvent(new Event('focus'));
      });
      await page.clock.fastForward(4 * 24 * 60 * 60 * 1000);
      await expect(page.getByTestId('home-meta')).toHaveText(meta);
      expect(reads(dashboard)).toBe(0);
      expect(await stored(page)).toBe(raw);
      await expect(page.getByTestId('home-next')).toHaveCount(0);
    });
  }
  await team(page).selectOption('Mobile');
  await page.setViewportSize({ width: 390, height: 844 });
  const scroll = page.getByTestId('home-velocity-scroll');
  await scroll.evaluate((el) => {
    el.scrollLeft = 100;
  });
  const before = await scroll.evaluate((el) => el.scrollLeft);
  expect(before).toBeGreaterThan(0);
  await team(page).focus();
  const pending = [];
  await page.route('**/api/team-velocity', (route) => {
    pending.push(route);
  });
  await refresh(page).evaluate((el) => {
    el.click();
    el.click();
  });
  await expect.poll(() => pending.length).toBe(1);
  await page.clock.fastForward(180_000);
  expect(pending).toHaveLength(1);
  await expect(team(page)).toHaveValue('Mobile');
  await expect(team(page)).toBeFocused();
  expect(await scroll.evaluate((el) => el.scrollLeft)).toBe(before);
  await pending[0].fulfill({ json: old });
  await expect(refresh(page)).toBeEnabled();
  await expect(team(page)).toHaveValue('Mobile');
  await expect(team(page)).toBeFocused();
  expect(await scroll.evaluate((el) => el.scrollLeft)).toBe(before);
});

test('person velocity stays local with alphabetical same-window comparison and resets @regression', async ({
  page,
  dashboard,
}) => {
  await seedVelocitySnapshot(page, dashboard.data.teamVelocity);
  await page.goto('/#/home');
  await expect(person(page)).toHaveAccessibleName('Person');
  await expect(person(page)).toHaveValue('');
  await expect(person(page).locator('option[value=""]')).toHaveText('Everyone');
  const comparison = page.getByTestId('home-velocity-people');
  const rows = comparison.getByTestId('home-velocity-person-row');
  await expect(rows).toHaveCount(4);
  const labels = await rows.allTextContents();
  expect(labels[0]).toContain('Alex Example');
  expect(labels[1]).toContain('Alex Example');
  expect(labels[2]).toContain('Unassigned');
  expect(labels[3]).toContain('Unknown assignee');
  await expect(comparison).toContainText('Total points · 4 displayed sprints');
  await expect(rows.locator('strong')).toHaveText(['5.5', '4.25', '3', '0']);
  const personTotal = (await rows.locator('strong').allTextContents()).reduce(
    (total, value) => total + Number(value),
    0,
  );
  const chartTotal = (await page.getByTestId('home-velocity-total').allTextContents()).reduce(
    (total, value) => total + Number(value),
    0,
  );
  expect(personTotal).toBe(chartTotal);
  const expectedPeople = dashboard.data.teamVelocity.boards.find(
    ({ name }) => name === 'Nexus',
  ).people;
  const maximum = Math.max(
    ...expectedPeople.map(({ series }) => series.reduce((total, entry) => total + entry.points, 0)),
  );
  for (const [index, expectedPerson] of expectedPeople.entries()) {
    const meter = rows.nth(index).getByTestId('home-velocity-person-meter');
    await expect(meter).toBeVisible();
    for (const status of ['done', 'inProgress', 'notStarted']) {
      const points = expectedPerson.series.reduce(
        (total, entry) => total + entry.byStatus[status],
        0,
      );
      const segment = meter.locator(`[data-status="${status}"]`);
      const proportion = await segment.evaluate(
        (el) => el.getBoundingClientRect().width / el.parentElement.getBoundingClientRect().width,
      );
      expect(proportion).toBeCloseTo(points / maximum, 2);
      const color = await chart(page)
        .locator(`.home-velocity-swatch[data-status="${status}"]`)
        .evaluate((el) => getComputedStyle(el).backgroundColor);
      await expect(segment).toHaveCSS('background-color', color);
    }
  }
  await expect(rows.nth(1)).toHaveAccessibleName(/0 completed, 4\.25 in progress, 0 not started/);
  await rows.nth(0).click();
  await expect(rows.nth(0)).toBeFocused();
  await expect(person(page)).toHaveValue(alexA);
  await expect(chart(page)).toContainText('Alex Example');
  await expect(page.getByTestId('home-velocity-total')).toHaveText(['0', '2.5', '0', '3']);
  await person(page).selectOption(alexB);
  await expect(page.getByTestId('home-velocity-total')).toHaveText(['0', '1.25', '0', '3']);
  expect(reads(dashboard)).toBe(0);
  await expect(page.getByTestId('home-velocity-methodology')).toContainText(/current assignee/i);
  await expect(page.getByTestId('home-velocity-methodology')).toContainText(
    /(historical|ownership)/i,
  );
  await expect(page.getByTestId('home-velocity-methodology')).toContainText(
    /(name.*(fallback|merge|rename)|fallback.*name)/i,
  );
  await expect(comparison).toContainText(/carried.*(sprint|membership)/i);
  await team(page).selectOption('Mobile');
  await expect(person(page)).toHaveValue('');
  await expect(chart(page)).toContainText('Mobile Sprint 11');
  await team(page).selectOption('Nexus');
  await expect(person(page)).toHaveValue('');
  await person(page).selectOption(alexA);
  await page.reload();
  await expect(person(page)).toHaveValue('');
  expect(reads(dashboard)).toBe(0);
  await person(page).selectOption(alexA);
  await refresh(page).click();
  await expect(refresh(page)).toBeEnabled();
  await expect(person(page)).toHaveValue(alexA);
  // The latest generation transfers the departed person's memberships to the remaining account.
  const nexus = dashboard.data.teamVelocity.boards.find(({ name }) => name === 'Nexus');
  const departed = nexus.people.shift();
  for (const [index, entry] of nexus.people[0].series.entries()) {
    const old = departed.series[index];
    entry.points += old.points;
    entry.count += old.count;
    entry.unestimated += old.unestimated;
    for (const status of ['done', 'inProgress', 'notStarted'])
      entry.byStatus[status] += old.byStatus[status];
  }
  await refresh(page).click();
  await expect(refresh(page)).toBeEnabled();
  await expect(person(page)).toHaveValue('');
  expect(reads(dashboard)).toBe(2);
  expect(
    JSON.parse(await stored(page))
      .snapshot.boards.find(({ name }) => name === 'Nexus')
      .people.map(({ id }) => id),
  ).not.toContain(alexA);
});

test('one sprint compares every person on the same local window and shared scales @regression', async ({
  page,
  dashboard,
}) => {
  const original = structuredClone(dashboard.data.teamVelocity);
  const nexus = original.boards.find(({ name }) => name === 'Nexus');
  await seedVelocitySnapshot(page, original);
  await page.goto('/#/home');
  await expect(sprint(page)).toHaveAccessibleName('Sprint');
  await expect(sprint(page)).toHaveValue('');
  expect(await sprint(page).locator('option').allTextContents()).toEqual([
    'All displayed sprints',
    'Sprint 11',
    'Sprint 4',
    'Sprint 3',
    'Sprint 2',
    'Sprint 1',
  ]);
  const saved = await stored(page);
  const rows = page.getByTestId('home-velocity-person-row');
  const comparison = page.getByTestId('home-velocity-people');
  await sprint(page).selectOption('Sprint 2');
  await expect(page.getByTestId('home-velocity-total')).toHaveText(['4.75']);
  await expect(comparison).toContainText('Total points · Sprint 2');
  await expect(rows.locator('strong')).toHaveText(['2.5', '1.25', '1', '0']);
  const sum = (await rows.locator('strong').allTextContents()).reduce(
    (total, value) => total + Number(value),
    0,
  );
  expect(sum).toBe(Number(await page.getByTestId('home-velocity-total').textContent()));
  const axis = await page.getByTestId('home-velocity-axis').textContent();
  for (const [index, p] of nexus.people.entries()) {
    const meter = rows.nth(index).getByTestId('home-velocity-person-meter');
    for (const status of ['done', 'inProgress', 'notStarted']) {
      const segment = meter.locator(`[data-status="${status}"]`);
      const proportion = await segment.evaluate(
        (el) => el.getBoundingClientRect().width / el.parentElement.getBoundingClientRect().width,
      );
      expect(proportion).toBeCloseTo(p.series[1].byStatus[status] / 2.5, 2);
      const color = await chart(page)
        .locator(`.home-velocity-swatch[data-status="${status}"]`)
        .evaluate((el) => getComputedStyle(el).backgroundColor);
      await expect(segment).toHaveCSS('background-color', color);
    }
    await rows.nth(index).click();
    await expect(person(page)).toHaveValue(p.id);
    await expect(sprint(page)).toHaveValue('Sprint 2');
    await expect(page.getByTestId('home-velocity-total')).toHaveText([String(p.series[1].points)]);
    await expect(page.getByTestId('home-velocity-axis')).toHaveText(axis);
    await expect(rows).toHaveCount(4);
    await expect(rows.locator('strong')).toHaveText(['2.5', '1.25', '1', '0']);
  }
  await person(page).selectOption('');
  await sprint(page).selectOption('Sprint 1');
  await expect(page.getByTestId('home-velocity-total')).toHaveText(['0']);
  await expect(rows.locator('strong')).toHaveText(['0']);
  await expect(comparison).toContainText('Total points · Sprint 1');
  await expect(person(page).locator('option')).toHaveCount(2);
  await sprint(page).selectOption('');
  await expect(comparison).toContainText('Total points · 4 displayed sprints');
  await expect(rows.locator('strong')).toHaveText(['5.5', '4.25', '3', '0']);
  await expect(page.getByTestId('home-velocity-total')).toHaveText(['0', '4.75', '0', '8']);
  expect(await stored(page)).toBe(saved);
  expect(dashboard.data.teamVelocity).toEqual(original);
  expect(reads(dashboard)).toBe(0);
});

test('global sprint cascades team and person locally and retains valid children @regression', async ({
  page,
  dashboard,
}) => {
  const mobile = dashboard.data.teamVelocity.boards[0];
  for (const series of [mobile.series, ...mobile.people.map((p) => p.series)])
    series[0].sprint.name = 'Mobile Sprint 2';
  const original = structuredClone(dashboard.data.teamVelocity);
  await seedVelocitySnapshot(page, original);
  await page.goto('/#/home');
  await expect(sprint(page)).toBeVisible();
  expect(
    await page
      .locator('#panel-home select')
      .evaluateAll((els) => els.map((el) => el.dataset.testid)),
  ).toEqual(['home-velocity-sprint', 'home-velocity-team', 'home-velocity-person']);
  await expect(sprint(page).locator('option')).toHaveText([
    'All displayed sprints',
    'Sprint 4',
    'Sprint 3',
    'Sprint 2',
    'Sprint 1',
  ]);
  const saved = await stored(page);
  await person(page).selectOption(alexA);
  await sprint(page).selectOption('Sprint 2');
  await expect(person(page)).toHaveValue(alexA);
  await expect(sprint(page)).toHaveValue('Sprint 2');
  await expect(team(page).locator('option')).toHaveText(['Mobile', 'Nexus']);
  await team(page).selectOption('Mobile');
  await expect(sprint(page)).toHaveValue('Sprint 2');
  await expect(person(page)).toHaveValue('');
  await expect(page.getByTestId('home-velocity-total')).toHaveText(['7']);
  await expect(chart(page)).toContainText('Mobile Sprint 2');
  await person(page).selectOption(mobile.people[0].id);
  await sprint(page).selectOption('Sprint 1');
  await expect(team(page)).toHaveValue('Nexus');
  await expect(team(page).locator('option')).toHaveText(['Nexus']);
  await expect(person(page)).toHaveValue('');
  await expect(person(page).locator('option')).toHaveCount(2);
  expect(JSON.parse(await stored(page, preferenceKey)).team).toBe('Nexus');
  await sprint(page).selectOption('Sprint 3');
  await expect(person(page).locator('option')).toHaveCount(5);
  await expect(page.getByTestId('home-velocity-person-row').locator('strong')).toHaveText([
    '0',
    '0',
    '0',
    '0',
  ]);
  await person(page).selectOption('unknown');
  await sprint(page).selectOption('Sprint 2');
  await expect(person(page)).toHaveValue('unknown');
  await sprint(page).selectOption('Sprint 1');
  await expect(person(page)).toHaveValue('');
  await sprint(page).selectOption('');
  await expect(team(page).locator('option')).toHaveText(['Mobile', 'Nexus']);
  expect(await stored(page)).toBe(saved);
  expect(dashboard.data.teamVelocity).toEqual(original);
  expect(reads(dashboard)).toBe(0);
});

test('refresh reconciles global sprint and children and reload keeps only team @regression', async ({
  page,
  dashboard,
}) => {
  const mobile = dashboard.data.teamVelocity.boards[0];
  for (const series of [mobile.series, ...mobile.people.map((p) => p.series)])
    series[0].sprint.name = 'Mobile Sprint 2';
  await seedVelocitySnapshot(page, dashboard.data.teamVelocity);
  await page.goto('/#/home');
  await team(page).selectOption('Nexus');
  await sprint(page).selectOption('Sprint 2');
  await person(page).selectOption(alexB);
  await refresh(page).click();
  await expect(refresh(page)).toBeEnabled();
  await expect(sprint(page)).toHaveValue('Sprint 2');
  await expect(person(page)).toHaveValue(alexB);
  const nexus = dashboard.data.teamVelocity.boards.find(({ name }) => name === 'Nexus');
  for (const series of [nexus.series, ...nexus.people.map((p) => p.series)])
    series[1].sprint.name = 'Nexus Sprint 22';
  await refresh(page).click();
  await expect(refresh(page)).toBeEnabled();
  await expect(sprint(page)).toHaveValue('Sprint 2');
  await expect(team(page)).toHaveValue('Mobile');
  await expect(person(page)).toHaveValue('');
  expect(JSON.parse(await stored(page, preferenceKey)).team).toBe('Mobile');
  await expect(sprint(page).locator('option')).toHaveText([
    'All displayed sprints',
    'Sprint 22',
    'Sprint 4',
    'Sprint 3',
    'Sprint 2',
    'Sprint 1',
  ]);
  await sprint(page).selectOption('Sprint 22');
  await expect(team(page)).toHaveValue('Nexus');
  await person(page).selectOption(alexB);
  await expect(page.getByTestId('home-velocity-total')).toHaveText(['1.25']);
  await expect(page.getByTestId('home-velocity-people')).toContainText('Total points · Sprint 22');
  for (const series of [nexus.series, ...nexus.people.map((p) => p.series)]) series.splice(1, 1);
  await refresh(page).click();
  await expect(refresh(page)).toBeEnabled();
  await expect(sprint(page)).toHaveValue('');
  await expect(person(page)).toHaveValue(alexB);
  await expect(page.getByTestId('home-velocity-total')).toHaveText(['0', '0', '3']);
  await expect(page.getByTestId('home-velocity-people')).toContainText(
    'Total points · 3 displayed sprints',
  );
  expect(JSON.parse(await stored(page)).snapshot).toEqual(dashboard.data.teamVelocity);
  await sprint(page).selectOption('Sprint 4');
  await page.reload();
  await expect(sprint(page)).toHaveValue('');
  await expect(person(page)).toHaveValue('');
  expect(reads(dashboard)).toBe(3);
});

test('exact nonstandard sprint names and refreshed membership counts govern people @regression', async ({
  page,
  dashboard,
}) => {
  const nexus = dashboard.data.teamVelocity.boards[1];
  for (const series of [nexus.series, ...nexus.people.map((p) => p.series)])
    series[0].sprint.name = 'Release Alpha';
  await seedVelocitySnapshot(page, dashboard.data.teamVelocity);
  await page.goto('/#/home');
  await sprint(page).selectOption('Release Alpha');
  await expect(team(page).locator('option')).toHaveText(['Nexus']);
  await expect(person(page).locator('option')).toHaveCount(2);
  await person(page).selectOption(alexA);
  nexus.people[0].series[0].count = 0;
  nexus.people[1].series[0].count = 1;
  await refresh(page).click();
  await expect(refresh(page)).toBeEnabled();
  await expect(sprint(page)).toHaveValue('Release Alpha');
  await expect(person(page)).toHaveValue('');
  await expect(person(page).locator('option')).toHaveCount(2);
  await expect(person(page).locator('option').last()).toHaveAttribute('value', alexB);
  await expect(page.getByTestId('home-velocity-person-row').locator('strong')).toHaveText(['0']);
  await expect(page.getByTestId('home-velocity-people')).toContainText(
    'Total points · Release Alpha',
  );
  expect(reads(dashboard)).toBe(1);
});

test('snapshot arithmetic rejects a manual result without replacing last-good chart cache or date @regression', async ({
  page,
  dashboard,
}) => {
  await seedVelocitySnapshot(page, dashboard.data.teamVelocity);
  await page.goto('/#/home');
  await expect(chart(page)).toBeVisible();
  await person(page).selectOption(alexA);
  const saved = await stored(page);
  const date = await page.getByTestId('home-meta').textContent();
  const totals = await page.getByTestId('home-velocity-total').allTextContents();
  const valid = structuredClone(dashboard.data.teamVelocity);
  dashboard.data.teamVelocity.updatedAt = '2026-11-10T01:02:03Z';
  dashboard.data.teamVelocity.boards[1].series[1].byStatus.done = 30;
  expect(reads(dashboard)).toBe(0);
  await refresh(page).click();
  await expect(page.getByTestId('home-velocity-stale')).toContainText(/invalid/i);
  await expect(refresh(page)).toBeEnabled();
  await expect(person(page)).toHaveValue(alexA);
  await expect(page.getByTestId('home-velocity-total')).toHaveText(totals);
  await expect(page.getByTestId('home-meta')).toHaveText(date);
  expect(await stored(page)).toBe(saved);
  expect(reads(dashboard)).toBe(1);
  await page.reload();
  await expect(chart(page)).toBeVisible();
  await expect(page.getByTestId('home-meta')).toHaveText(date);
  expect(await stored(page)).toBe(saved);
  expect(reads(dashboard)).toBe(1);
  dashboard.data.teamVelocity = { ...valid, updatedAt: '2026-11-10T01:02:03Z' };
  await refresh(page).click();
  await expect(page.getByTestId('home-meta').locator('time')).toHaveAttribute(
    'datetime',
    '2026-11-10T01:02:03Z',
  );
  await expect(page.getByTestId('home-velocity-stale')).toHaveCount(0);
  expect(JSON.parse(await stored(page)).snapshot).toEqual(dashboard.data.teamVelocity);
  expect(reads(dashboard)).toBe(2);
});

test('unambiguous person labels reserve aggregate literal suffixes and special bucket names @regression', async ({
  page,
  dashboard,
}) => {
  const names = [
    'Alex',
    'Alex',
    'Alex (1)',
    'Everyone',
    'Everyone (1)',
    'Unassigned',
    'Unassigned',
    'Unknown assignee',
    'Unknown assignee',
  ];
  const expectedLabels = [
    'Alex (2)',
    'Alex (3)',
    'Alex (1)',
    'Everyone (2)',
    'Everyone (1)',
    'Unassigned (2)',
    'Unassigned (1)',
    'Unknown assignee (2)',
    'Unknown assignee (1)',
  ];
  const source = dashboard.data.teamVelocity.boards[1];
  const people = names
    .map((displayName, index) => ({
      id:
        index === 5
          ? 'unassigned'
          : index === 7
            ? 'unknown'
            : `person:${String(index).padStart(64, '0')}`,
      displayName,
      series: [
        {
          ...structuredClone(source.series[1]),
          points: index + 1,
          count: 1,
          unestimated: 0,
          byStatus: { done: index + 1, inProgress: 0, notStarted: 0 },
        },
      ],
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id));
  const labelsById = new Map(people.map((p) => [p.id, expectedLabels[p.series[0].points - 1]]));
  const series = [
    {
      ...structuredClone(source.series[1]),
      points: 45,
      count: 9,
      unestimated: 0,
      byStatus: { done: 45, inProgress: 0, notStarted: 0 },
    },
  ];
  source.people = people;
  source.series = series;
  const original = structuredClone(dashboard.data.teamVelocity);
  await seedVelocitySnapshot(page, original);
  await page.goto('/#/home');
  const options = person(page).locator('option');
  const expected = [
    { value: '', label: 'Everyone' },
    ...people.map((p) => ({ value: p.id, label: labelsById.get(p.id) })),
  ];
  await expect(options).toHaveCount(expected.length);
  const choices = await options.evaluateAll((elements) =>
    elements.map((el) => ({ value: el.value, label: el.textContent })),
  );
  expect(choices).toEqual(expected);
  expect(new Set(choices.map(({ label }) => label)).size).toBe(choices.length);
  const rows = page.getByTestId('home-velocity-person-row');
  await expect(rows).toHaveCount(people.length);
  for (const [index, p] of people.entries()) {
    const label = labelsById.get(p.id);
    await expect(rows.nth(index).locator('.home-velocity-person-name')).toHaveText(label);
    await person(page).focus();
    await person(page).selectOption(p.id);
    await expect(person(page)).toBeFocused();
    await expect(page.getByTestId('home-velocity-total')).toHaveText([String(p.series[0].points)]);
    await expect(chart(page).locator('figcaption p')).toHaveText(`Nexus · ${label}`);
    await expect(page.getByTestId('home-velocity-scroll')).toHaveAccessibleName(
      `Nexus, ${label} sprint history; scroll to see more sprints`,
    );
    await person(page).selectOption('');
    await expect(page.getByTestId('home-velocity-total')).toHaveText(['45']);
    await rows.nth(index).click();
    await expect(rows.nth(index)).toBeFocused();
    await expect(person(page)).toHaveValue(p.id);
    await expect(chart(page).locator('figcaption p')).toHaveText(`Nexus · ${label}`);
    await expect(page.getByTestId('home-velocity-total')).toHaveText([String(p.series[0].points)]);
  }
  expect(reads(dashboard)).toBe(0);
  expect(JSON.parse(await stored(page)).snapshot).toEqual(original);
  expect(dashboard.data.teamVelocity).toEqual(original);
  await page.reload();
  await expect(person(page)).toHaveValue('');
  await expect(options).toHaveCount(expected.length);
  expect(
    await options.evaluateAll((elements) =>
      elements.map((el) => ({ value: el.value, label: el.textContent })),
    ),
  ).toEqual(expected);
  expect(reads(dashboard)).toBe(0);
});

test.describe('explicit sprint inspection', () => {
  test.use({ hasTouch: true });

  test('activated sprint details reveal and focus only after keyboard or touch activation including repeat @regression', async ({
    page,
    dashboard,
  }) => {
    const nexus = dashboard.data.teamVelocity.boards[1];
    const sprint = (index) => ({
      id: index + 20,
      name: `Nexus Sprint ${index + 20}`,
      state: 'closed',
      endDate: null,
    });
    nexus.series = Array.from({ length: 8 }, (_, index) => ({
      ...structuredClone(nexus.series[1]),
      sprint: sprint(index),
    }));
    for (const p of nexus.people)
      p.series = Array.from({ length: 8 }, (_, index) => ({
        ...structuredClone(p.series[1]),
        sprint: sprint(index),
      }));
    await seedVelocitySnapshot(page, dashboard.data.teamVelocity);
    await page.goto('/#/home');
    await expect(chart(page)).toBeVisible();
    const pane = chart(page).locator('..');
    const details = chart(page).locator('details');
    // Keep a real destination offscreen even on a tall desktop; only the inspect action may reveal it.
    await page.addStyleTag({ content: '#home-velocity-details { margin-top: 900px; }' });
    await page.evaluate(() => {
      window.__velocityDetailFocuses = 0;
      document.addEventListener('focusin', (event) => {
        if (event.target.closest('[data-testid="home-velocity-data"]'))
          window.__velocityDetailFocuses++;
      });
    });
    await expect(details).not.toHaveAttribute('open', '');
    expect(await pane.evaluate((el) => el.scrollTop)).toBe(0);
    expect(reads(dashboard)).toBe(0);
    const selected = page.getByTestId('home-velocity-data').locator('li[data-selected="true"]');
    const observations = [];
    for (const [input, width, height] of [
      ['Enter', 1440, 900],
      ['Space', 1440, 900],
      ['touch', 390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      for (const repeat of [false, true]) {
        const bar = chart(page).getByRole('button', {
          name: 'Nexus Sprint 27: 4.75 story points. Inspect sprint details.',
          exact: true,
        });
        await bar.scrollIntoViewIfNeeded();
        if (input === 'touch') await bar.tap();
        else {
          await bar.focus();
          await bar.press(input);
        }
        await expect(details).toHaveAttribute('open', '');
        await expect(selected).toContainText('Nexus Sprint 27');
        await expect(selected.locator('dd').first()).toHaveText('4.75');
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        const state = await selected.evaluate((row) => {
          const heading = row.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"]');
          const pane = row.closest('figure').parentElement.getBoundingClientRect();
          const box = row.getBoundingClientRect();
          const h = heading?.getBoundingClientRect();
          const style = heading && getComputedStyle(heading);
          return {
            heading: heading?.textContent === 'Nexus Sprint 27',
            focused: Boolean(heading && document.activeElement === heading),
            visible: Boolean(
              h && h.top >= Math.max(0, pane.top) && h.bottom <= Math.min(innerHeight, pane.bottom),
            ),
            rowRevealed:
              box.top >= Math.max(0, pane.top) && box.bottom <= Math.min(innerHeight, pane.bottom),
            focusIndicator: Boolean(
              style && (style.outlineStyle !== 'none' || style.boxShadow !== 'none'),
            ),
          };
        });
        await page.keyboard.press('Tab');
        const tabContinues = await page
          .getByTestId('home-velocity-person-row')
          .first()
          .evaluate((el) => el === document.activeElement);
        observations.push({ input, repeat, ...state, tabContinues });
      }
    }
    // An already-selected/open destination must not turn later renders into inspect actions.
    await pane.evaluate((el) => {
      el.scrollTop = 0;
    });
    await person(page).focus();
    const focuses = await page.evaluate(() => window.__velocityDetailFocuses);
    await person(page).selectOption(alexA);
    await expect(person(page)).toBeFocused();
    expect(await pane.evaluate((el) => el.scrollTop)).toBe(0);
    dashboard.data.teamVelocity.updatedAt = '2026-11-10T01:02:03Z';
    await refresh(page).evaluate((el) => el.click());
    await expect(page.getByTestId('home-meta').locator('time')).toHaveAttribute(
      'datetime',
      '2026-11-10T01:02:03Z',
    );
    await expect(person(page)).toBeFocused();
    expect(await pane.evaluate((el) => el.scrollTop)).toBe(0);
    await team(page).focus();
    await team(page).selectOption('Mobile');
    await expect(team(page)).toBeFocused();
    await team(page).selectOption('Nexus');
    await expect(team(page)).toBeFocused();
    expect(await pane.evaluate((el) => el.scrollTop)).toBe(0);
    expect(await page.evaluate(() => window.__velocityDetailFocuses)).toBe(focuses);
    expect(reads(dashboard)).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(observations).toEqual(
      observations.map(({ input, repeat }) => ({
        input,
        repeat,
        heading: true,
        focused: true,
        visible: true,
        rowRevealed: true,
        focusIndicator: true,
        tabContinues: true,
      })),
    );
  });
});
