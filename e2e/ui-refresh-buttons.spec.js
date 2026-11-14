import { test, expect, seedVelocitySnapshot } from './fixtures.js';
import { slackWatchData, watchLink } from './data.js';

// Button hierarchy: neutral by default, filled for the one primary action, red for destructive ones.
// Colours are compared with the tokens as the page resolves them, never with a hex written here.
const RUNNING = 'b-3f9a2c7d';
const CHANNEL = 'C0EXAMPLE1';
const THREAD = '1761900000.000100';
const TRANSPARENT = 'rgba(0, 0, 0, 0)';

// A token as the browser computes it as a colour, so `rgb()` forms compare equal.
const token = (page, name) =>
  page.evaluate((property) => {
    const probe = document.createElement('i');
    probe.style.color = `var(${property})`;
    document.body.append(probe);
    const { color } = getComputedStyle(probe);
    probe.remove();
    return color;
  }, name);
const look = (locator) =>
  locator.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      color: style.color,
      border: style.borderTopColor,
      background: style.backgroundColor,
      classes: node.className,
    };
  });
const expectNeutral = async (page, locator) => {
  await expect(locator).toBeVisible();
  await page.mouse.move(0, 0);
  const [text, edge] = await Promise.all([token(page, '--text'), token(page, '--border-strong')]);
  await expect
    .poll(async () => {
      const { color, border, background } = await look(locator);
      return { color, border, background };
    })
    .toEqual({ color: text, border: edge, background: TRANSPARENT });
};

const expectFilled = async (page, locator) => {
  await expect(locator).toBeVisible();
  await expect(locator).toBeEnabled();
  await page.mouse.move(0, 0);
  const [fill, label] = await Promise.all([token(page, '--accent-fill'), token(page, '--bg')]);
  await expect
    .poll(async () => {
      const { color, background } = await look(locator);
      return { color, background };
    })
    .toEqual({ color: label, background: fill });
};

const expectDanger = async (page, locator) => {
  await expect(locator).toBeVisible();
  await page.mouse.move(0, 0);
  const red = await token(page, '--red');
  await expect(locator).toHaveClass(/\bdanger\b/);
  await expect.poll(async () => (await look(locator)).color).toBe(red);
};

test.describe('neutral default buttons', () => {
  test('My Tickets and Slack Refresh are --text on a --border-strong edge, no fill', async ({
    page,
  }) => {
    await page.goto('/#/my-tickets');
    await expectNeutral(page, page.getByTestId('my-tickets-refresh'));
    await page.goto('/#/slack');
    await expectNeutral(page, page.getByTestId('slack-refresh'));
  });

  test('a running DevTools tile keeps Stop neutral', async ({ page }) => {
    await page.goto('/#/devtools');
    await expectNeutral(page, page.getByTestId(`devtools-stop-${RUNNING}`));
  });
});

test.describe('filled primary buttons', () => {
  test('Generate velocity is filled before any data, and Refresh with data is neutral', async ({
    page,
    dashboard,
  }) => {
    await page.goto('/#/home');
    const refresh = page.getByTestId('home-refresh');
    await expect(refresh).toHaveText('Generate velocity');
    await expectFilled(page, refresh);

    await seedVelocitySnapshot(page, dashboard.data.teamVelocity);
    await page.reload();
    await expect(page.getByTestId('home-velocity-chart')).toBeVisible();
    await expect(refresh).toHaveText('Refresh');
    await expectNeutral(page, refresh);
  });

  test('DevTools Launch is filled', async ({ page }) => {
    await page.goto('/#/devtools');
    await expectFilled(page, page.getByTestId('devtools-launch'));
  });

  test('Services Start all is filled', async ({ page }) => {
    await page.goto('/#/services');
    await expectFilled(page, page.getByTestId('start-all'));
  });

  test('Chat Send is filled once there is a draft', async ({ page }) => {
    await page.goto('/#/chat');
    await page.getByLabel('Message').fill('A draft');
    await expectFilled(page, page.getByTestId('chat-send'));
  });

  test('Connect Slack is filled when Slack is disconnected', async ({ page, dashboard }) => {
    dashboard.data.slack.status = { connected: false, connecting: false };
    await page.goto('/#/slack');
    await expect(page.getByTestId('slack-disconnected')).toBeVisible();
    await expectFilled(page, page.getByTestId('slack-connect'));
  });
});

test.describe('red destructive buttons', () => {
  test('Slack Disconnect is a danger button with a --red label', async ({ page }) => {
    await page.goto('/#/slack');
    await expectDanger(page, page.getByTestId('slack-disconnect'));
  });

  test('DevTools Remove is a danger button with a --red label', async ({ page }) => {
    await page.goto('/#/devtools');
    await expectDanger(page, page.getByTestId(`devtools-remove-${RUNNING}`));
  });

  test('a Slack watch Remove is a danger button with a --red label', async ({
    page,
    dashboard,
  }) => {
    dashboard.data.slack.watch = slackWatchData({ links: [watchLink(CHANNEL, THREAD)] });
    await page.goto('/#/slack');
    await page.getByTestId('slack-tab-watch').click();
    await expectDanger(page, page.getByTestId(`slack-watch-remove-${CHANNEL}:${THREAD}`));
  });
});
