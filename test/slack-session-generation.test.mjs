import test from 'node:test';
import assert from 'node:assert/strict';
import { createSlackIntegration, slackPaths } from '../backend/slack.mjs';
import { createHttpHandler } from '../backend/http-app.mjs';

// In-memory credentials and a synthetic auth response; never reads disk or Slack.
function fixture({ auth } = {}) {
  let credentials = { token: 'xoxc-first-synthetic', cookie: 'xoxd-first-synthetic', teamId: 'T1' };
  let now = 100_000;
  const paths = slackPaths('/virtual-session-home');
  const fs = {
    lstatSync(file) {
      if (file === paths.session && !credentials)
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return {
        isDirectory: () => file !== paths.session,
        isFile: () => file === paths.session,
        isSymbolicLink: () => false,
      };
    },
    chmodSync() {},
    readFileSync: () => JSON.stringify(credentials),
    rmSync: () => {
      credentials = null;
    },
  };
  const fetchImpl =
    auth ||
    (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          user: 'same-user',
          user_id: 'U1',
          team: 'same-team',
          team_id: 'T1',
        }),
      ));
  const makeIntegration = () => createSlackIntegration({ paths, fs, fetchImpl, now: () => now });
  return {
    integration: makeIntegration(),
    makeIntegration,
    replace: () => {
      credentials = { token: 'xoxc-next-synthetic', cookie: 'xoxd-next-synthetic', teamId: 'T1' };
    },
    advance: () => {
      now += 60_001;
    },
  };
}

test('session version is opaque, stable across polls, and changes for legacy replacements and reconnects', async () => {
  const f = fixture();
  const first = await f.integration.status();
  assert.match(first.sessionVersion, /^[0-9a-f-]{36}$/i);
  assert.equal(first.savedAt, '');
  assert.equal((await f.integration.status()).sessionVersion, first.sessionVersion);
  f.advance();
  assert.equal(
    (await f.integration.status()).sessionVersion,
    first.sessionVersion,
    'auth refresh is not a new session',
  );
  f.replace();
  const next = await f.integration.status();
  assert.equal(next.user, first.user);
  assert.equal(next.savedAt, '');
  assert.notEqual(next.sessionVersion, first.sessionVersion);
  assert.doesNotMatch(JSON.stringify(next), /xox[cd]-|synthetic/);
  f.integration.disconnect();
  assert.equal((await f.integration.status()).connected, false);
  f.replace();
  const reconnected = await f.integration.status();
  assert.notEqual(reconnected.sessionVersion, next.sessionVersion);
  assert.notEqual(
    (await f.makeIntegration().status()).sessionVersion,
    reconnected.sessionVersion,
    'a server restart cannot reuse a browser-visible version',
  );
});

test('session version survives unverified status and rotates during an offline replacement', async () => {
  const f = fixture({
    auth: async () => {
      throw new Error('offline');
    },
  });
  const first = await f.integration.status();
  assert.equal(first.connected, true);
  assert.equal(first.verified, false);
  assert.equal((await f.integration.status()).sessionVersion, first.sessionVersion);
  f.replace();
  const next = await f.integration.status();
  assert.equal(next.verified, false);
  assert.notEqual(next.sessionVersion, first.sessionVersion);
});

test('a late status response cannot expose or reinstate the old session version', async () => {
  let release;
  let started;
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const f = fixture({
    auth: async (_url, init) => {
      if (init.headers.Authorization === 'Bearer xoxc-first-synthetic') {
        started();
        await held;
      }
      return new Response(
        JSON.stringify({ ok: true, user: 'same-user', user_id: 'U1', team_id: 'T1' }),
      );
    },
  });
  const previous = f.integration.status();
  await entered;
  f.replace();
  const current = await f.integration.status();
  release();
  const old = await previous;
  assert.equal(old.connected, false);
  assert.equal(old.sessionVersion, undefined);
  assert.equal((await f.integration.status()).sessionVersion, current.sessionVersion);
});

test('status HTTP contract exposes only the current opaque version', async () => {
  const f = fixture();
  const handler = createHttpHandler({
    settings: {},
    manager: {},
    integrations: {
      slack: f.integration,
      slackWatchStore: {},
      claudeSessions: {},
      slackWatcher: { stop() {} },
    },
  });
  const get = async () => {
    let status;
    let headers;
    let body;
    await handler(
      { method: 'GET', url: '/api/slack/status', headers: { host: 'localhost' }, socket: {} },
      {
        setHeader() {},
        writeHead(code, value) {
          status = code;
          headers = value;
        },
        end(value) {
          body = value;
        },
      },
    );
    assert.equal(status, 200);
    assert.equal(headers['Cache-Control'], 'no-store');
    return JSON.parse(body);
  };
  try {
    const first = await get();
    assert.match(first.sessionVersion, /^[0-9a-f-]{36}$/i);
    f.replace();
    const next = await get();
    assert.notEqual(next.sessionVersion, first.sessionVersion);
    assert.equal(next.user, first.user);
    assert.doesNotMatch(JSON.stringify(next), /xox[cd]-|synthetic/);
  } finally {
    handler.close();
  }
});
