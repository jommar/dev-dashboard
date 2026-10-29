// slack-connect.mjs — one-time Slack sign-in capture.
//
// Run by `POST /api/slack/connect` (stdio redirected to
// ~/.config/slack/connect.log). Opens a dedicated Chromium profile, waits for
// the user to sign in to the Slack web client, then copies the web client's own
// credentials — the `xoxc-` token from localStorage plus the `d` session cookie
// — into ~/.config/slack/session.json (mode 600) and closes the window.
//
// The profile is reused on later runs, so a refresh usually needs no sign-in at
// all. Credentials are never printed; the parent process never sees them.
//
// Exit codes: 0 captured, 1 not captured (closed, timed out, or unavailable).

import fs from 'node:fs';
import path from 'node:path';
import { slackPaths } from './slack.mjs';
import { stageTokenFile } from './credentials.mjs';

const TIMEOUT_MS = 10 * 60 * 1000;
const POLL_MS = 2_000;
const WORKSPACE_URL = process.env.SLACK_WORKSPACE || 'https://app.slack.com/client';

function log(message) {
  // connect.log is mode 600; nothing here may contain a token or cookie.
  console.log(`[${new Date().toISOString()}] ${message}`);
}

// @playwright/test is a dev dependency whose bundled browser revision may not be
// the one installed. Prefer whatever Chromium is actually on disk.
function resolveExecutable(chromium) {
  try {
    const bundled = chromium.executablePath();
    if (bundled && fs.existsSync(bundled)) return undefined; // let Playwright decide
  } catch {
    /* fall through to the scan */
  }
  const root = path.join(process.env.HOME || '', '.cache/ms-playwright');
  try {
    const candidates = fs
      .readdirSync(root)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const name of candidates) {
      const executable = path.join(root, name, 'chrome-linux64', 'chrome');
      if (fs.existsSync(executable)) return executable;
    }
  } catch {
    /* no browser cache — launch will fail and be reported below */
  }
  return undefined;
}

async function capture(chromium) {
  const directory = process.env.SLACK_PROFILE_DIR || slackPaths().profile;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  log(`opening ${WORKSPACE_URL} (profile ${directory})`);

  const context = await chromium.launchPersistentContext(directory, {
    headless: false,
    executablePath: resolveExecutable(chromium),
    viewport: null,
  });
  let closed = false;
  context.on('close', () => {
    closed = true;
  });

  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(WORKSPACE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (closed) {
        log('window closed before sign-in completed');
        return 1;
      }
      const credentials = await readCredentials(page, context);
      if (credentials) {
        const target = slackPaths().session;
        const temporary = stageTokenFile(target, JSON.stringify(credentials, null, 2) + '\n', fs);
        fs.renameSync(temporary, target);
        log('session captured');
        return 0;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    log('timed out waiting for sign-in');
    return 1;
  } finally {
    await context.close().catch(() => {});
  }
}

async function readCredentials(page, context) {
  let team;
  try {
    team = await page.evaluate(() => {
      try {
        const config = JSON.parse(localStorage.getItem('localConfig_v2') || '{}');
        for (const candidate of Object.values(config.teams || {}))
          if (typeof candidate?.token === 'string' && candidate.token.startsWith('xoxc-'))
            return {
              token: candidate.token,
              teamId: candidate.id || '',
              teamDomain: candidate.domain || '',
            };
      } catch {
        /* not on the Slack origin yet, or storage still empty */
      }
      return null;
    });
  } catch {
    return null; // navigation in flight
  }
  if (!team) return null;
  let cookie = '';
  try {
    const cookies = await context.cookies(['https://app.slack.com/', 'https://slack.com/']);
    cookie = (cookies.find((entry) => entry.name === 'd') || {}).value || '';
  } catch {
    return null;
  }
  if (!cookie.startsWith('xoxd-')) return null;
  return {
    token: team.token,
    cookie,
    teamId: team.teamId,
    teamDomain: team.teamDomain,
    savedAt: new Date().toISOString(),
  };
}

async function main() {
  let chromium;
  try {
    ({ chromium } = await import('@playwright/test'));
  } catch {
    log('@playwright/test is not installed — run npm install in dev-dashboard');
    return 1;
  }
  try {
    return await capture(chromium);
  } catch (error) {
    log(`could not open a browser: ${error?.message || error}`);
    return 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href
) {
  process.exitCode = await main();
}
