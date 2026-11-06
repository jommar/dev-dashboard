import test from 'node:test';
import assert from 'node:assert/strict';
import { createSlackIntegration, slackPaths } from '../backend/slack.mjs';

const NOW = Date.parse('2026-11-07T12:00:00.000Z');
const ACCOUNT_A = {
  token: 'xoxc-account-a-synthetic',
  cookie: 'xoxd-account-a-synthetic',
  teamId: 'T0FIRST',
  teamDomain: 'first',
};
const ACCOUNT_B = {
  token: 'xoxc-account-b-synthetic',
  cookie: 'xoxd-account-b-synthetic',
  teamId: 'T0SECOND',
  teamDomain: 'second',
};
const ROOT_A = '1794052770.000000';
const ROOT_B = '1794052760.000000';

// Every session read and Slack response is synthetic and in memory.
function fixture() {
  let credentials = { ...ACCOUNT_A };
  let holdOldReply = false;
  let signalEntered;
  let releaseReply;
  const entered = new Promise((resolve) => {
    signalEntered = resolve;
  });
  const held = new Promise((resolve) => {
    releaseReply = resolve;
  });
  const paths = slackPaths('/virtual-session-qa-home');
  const calls = [];
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
  const response = (value) => new Response(JSON.stringify(value));
  const fetchImpl = async (url, init) => {
    const target = new URL(url);
    const method = target.pathname.split('/').pop();
    const params = Object.fromEntries(target.searchParams);
    const isB = init.headers.Authorization === `Bearer ${ACCOUNT_B.token}`;
    const channel = isB ? 'CSECOND' : 'CFIRST';
    const user = isB ? 'U2' : 'U1';
    const team = isB ? ACCOUNT_B.teamId : ACCOUNT_A.teamId;
    const ts = isB ? ROOT_B : ROOT_A;
    const root = { ts, thread_ts: ts, user, text: isB ? 'account B' : 'account A', reply_count: 0 };
    calls.push({ method, params, account: isB ? 'B' : 'A' });
    if (method === 'auth.test')
      return response({ ok: true, user, user_id: user, team, team_id: team });
    if (method === 'users.list') return response({ ok: true, members: [] });
    if (method === 'search.messages') {
      if (params.count === '1')
        return response({
          ok: true,
          messages: { matches: [{ channel: { id: channel, name: 'ezat_claudio' } }] },
        });
      return response({ ok: true, messages: { total: 0, matches: [], paging: { pages: 1 } } });
    }
    if (method === 'conversations.history')
      return response({ ok: true, messages: [root], has_more: false, response_metadata: {} });
    if (method === 'conversations.replies') {
      if (!isB && holdOldReply) {
        signalEntered();
        await held;
      }
      return response({ ok: true, messages: [root], has_more: false, response_metadata: {} });
    }
    return response({ ok: false, error: 'unexpected_method' });
  };
  return {
    integration: createSlackIntegration({ paths, fs, fetchImpl, now: () => NOW }),
    calls,
    entered,
    releaseReply,
    holdOldReply: () => {
      holdOldReply = true;
    },
    replace: (value) => {
      credentials = value && { ...value };
    },
    change: (value) => {
      credentials = { ...credentials, ...value };
    },
    snapshot: () => ({ ...credentials }),
  };
}

test('session QA: identical unobserved legacy rewrite is invisible, while detected changes rotate', async () => {
  const f = fixture();
  const initial = await f.integration.status();
  assert.match(initial.sessionVersion, /^[0-9a-f-]{36}$/i);
  assert.equal((await f.integration.status()).sessionVersion, initial.sessionVersion);

  // Both filesystem events happen between reads; the parsed legacy record is identical.
  f.replace(null);
  f.replace(ACCOUNT_A);
  const identical = await f.integration.status();
  assert.equal(identical.sessionVersion, initial.sessionVersion);
  assert.doesNotMatch(JSON.stringify(identical), /xox[cd]-|synthetic/);

  let previous = identical.sessionVersion;
  for (const change of [
    { token: 'xoxc-changed-synthetic' },
    { cookie: 'xoxd-changed-synthetic' },
    { teamId: 'T0CHANGED' },
    { teamDomain: 'changed' },
    { savedAt: '2026-11-07T12:00:00.000Z' },
  ]) {
    f.change(change);
    const status = await f.integration.status();
    assert.notEqual(status.sessionVersion, previous);
    assert.doesNotMatch(JSON.stringify(status), /xox[cd]-|synthetic/);
    previous = status.sessionVersion;
  }
  const sameRecord = f.snapshot();
  f.integration.disconnect();
  assert.equal((await f.integration.status()).connected, false);
  f.replace(sameRecord);
  assert.notEqual((await f.integration.status()).sessionVersion, previous);
});

test('session QA: a detected cross-account replacement rejects an in-flight old dialog', async () => {
  const f = fixture();
  const firstStatus = await f.integration.status();
  assert.deepEqual(
    (await f.integration.threads()).started.map((row) => row.ts),
    [ROOT_A],
  );

  f.holdOldReply();
  const oldDialog = f.integration.thread(ROOT_A);
  await f.entered;
  f.replace(ACCOUNT_B);
  const nextStatus = await f.integration.status();
  assert.notEqual(nextStatus.sessionVersion, firstStatus.sessionVersion);
  assert.notEqual(nextStatus.userId, firstStatus.userId);
  assert.deepEqual(
    (await f.integration.threads()).started.map((row) => row.ts),
    [ROOT_B],
  );

  const before = f.calls.length;
  assert.equal((await f.integration.thread(ROOT_A)).available, false);
  assert.equal(f.calls.length, before, 'a previous-account root cannot trigger a new lookup');
  f.releaseReply();
  assert.equal((await oldDialog).available, false, 'a late previous-account response is rejected');
  assert.deepEqual(
    (await f.integration.threads()).started.map((row) => row.ts),
    [ROOT_B],
  );
  const currentDialog = await f.integration.thread(ROOT_B);
  assert.equal(currentDialog.available, true);
  assert.equal(currentDialog.thread.messages[0].text, 'account B');
});
