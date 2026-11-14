import { test, expect } from './fixtures.js';
import { degradedHealth, healthyIntegrations } from './data.js';

// A board shows one amber note per degraded integration it depends on, from GET /api/health, and
// nothing otherwise. The health read follows the board's own refresh; it has no timer of its own.
const healthReads = (dashboard) =>
  dashboard.requests.filter(({ path }) => path === '/api/health').length;

const unknownHealth = () => {
  const health = healthyIntegrations();
  for (const name of Object.keys(health.integrations))
    health.integrations[name] = { status: 'unknown', lastOkAt: null, lastFailure: null };
  return health;
};

test('My Tickets names a degraded Jira, and only the integrations it depends on', async ({
  page,
  dashboard,
}) => {
  dashboard.data.health = degradedHealth('jira', 'auth');
  await page.goto('/#/my-tickets');
  await expect(page.getByTestId('jira-upstream')).toHaveText(
    'Jira rejected the token. Check Settings.',
  );
  await expect(page.getByTestId('github-upstream')).toHaveCount(0);
  await expect(page.getByTestId('slack-upstream')).toHaveCount(0);
});

test('Pull Requests names a rate-limited GitHub, and a degraded Slack stays off it', async ({
  page,
  dashboard,
}) => {
  dashboard.data.health = degradedHealth('github', 'rate_limit');
  dashboard.data.health.integrations.slack = degradedHealth('slack', 'auth').integrations.slack;
  await page.goto('/#/prs');
  await expect(page.getByTestId('github-upstream')).toHaveText('GitHub is rate limiting requests.');
  await expect(page.getByTestId('slack-upstream')).toHaveCount(0);
});

test('Slack asks the user to reconnect when the session was rejected', async ({
  page,
  dashboard,
}) => {
  dashboard.data.health = degradedHealth('slack', 'auth');
  await page.goto('/#/slack');
  await expect(page.getByTestId('slack-upstream')).toHaveText(
    'Slack rejected the session. Reconnect Slack.',
  );
});

for (const [label, health] of [
  ['healthy', healthyIntegrations],
  ['unknown', unknownHealth],
]) {
  test(`${label} integrations show no note on any board`, async ({ page, dashboard }) => {
    dashboard.data.health = health();
    for (const screen of ['my-tickets', 'prs', 'slack']) {
      const reads = healthReads(dashboard);
      await page.goto(`/#/${screen}`);
      await expect.poll(() => healthReads(dashboard)).toBeGreaterThan(reads);
      await expect(page.locator('[data-testid$="-upstream"]')).toHaveCount(0);
    }
  });
}

test('a failed health read shows no note', async ({ page }) => {
  let answered = 0;
  await page.route('**/api/health', (route) => {
    answered += 1;
    return route.fulfill({ status: 502, json: { code: 'OPERATION_FAILED', errors: [] } });
  });
  await page.goto('/#/my-tickets');
  await expect.poll(() => answered).toBeGreaterThan(0);
  await expect(page.getByTestId('my-tickets-refresh')).toBeVisible();
  await expect(page.locator('[data-testid$="-upstream"]')).toHaveCount(0);
});

test('the health read follows the board refresh and never a timer', async ({ page, dashboard }) => {
  await page.clock.install({ time: Date.parse('2026-11-14T10:00:00Z') });
  await page.goto('/#/my-tickets');
  await expect(page.getByTestId('my-tickets-refresh')).toBeVisible();
  // The first load changes the board's refresh stamp once, so wait for the reads to settle.
  let settled = -1;
  await expect
    .poll(async () => {
      const now = healthReads(dashboard);
      const stable = now === settled;
      settled = now;
      return stable && now > 0;
    })
    .toBe(true);
  const before = healthReads(dashboard);

  // Less than the 90 s board poll: no refresh, so no health read.
  await page.clock.runFor(60_000);
  expect(healthReads(dashboard)).toBe(before);

  await page.getByTestId('my-tickets-refresh').click();
  await expect.poll(() => healthReads(dashboard)).toBe(before + 1);
});

test('the first visit to a board reads health once, after its first load', async ({
  page,
  dashboard,
}) => {
  for (const screen of ['my-tickets', 'prs']) {
    const before = healthReads(dashboard);
    await page.goto(`/#/${screen}`);
    await expect(page.getByTestId(`${screen}-refresh`)).toBeEnabled();
    // Let any second read arrive: the count must hold at one for a full second.
    await expect.poll(() => healthReads(dashboard) - before).toBe(1);
    await page.waitForTimeout(1000);
    expect(healthReads(dashboard) - before, screen).toBe(1);
  }
});

test('a degraded note appears after a refresh brings a new answer, and goes when it recovers', async ({
  page,
  dashboard,
}) => {
  await page.goto('/#/my-tickets');
  await expect(page.getByTestId('my-tickets-refresh')).toBeVisible();
  await expect(page.getByTestId('jira-upstream')).toHaveCount(0);

  dashboard.data.health = degradedHealth('jira', 'timeout');
  await page.getByTestId('my-tickets-refresh').click();
  await expect(page.getByTestId('jira-upstream')).toHaveText('Jira did not answer in time.');

  dashboard.data.health = healthyIntegrations();
  await page.getByTestId('my-tickets-refresh').click();
  await expect(page.getByTestId('jira-upstream')).toHaveCount(0);
});
