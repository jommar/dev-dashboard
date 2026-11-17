// slack-ticket-thread-dialog.test.mjs — a thread found by ticket search, in a channel the shared list
// does not read, opens in its own channel and nowhere else.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSlackIntegration, slackPaths } from '../backend/slack.mjs';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const ROOT = '1794905600.296579';
const REPLY = '1794905700.000100';
const LISTED = 'C0CA4BAGF44';
const OWN = 'C0C2DJFKATW';

function fakeFetch(calls) {
  return async (input) => {
    const url = new URL(String(input));
    const method = url.pathname.split('/').pop();
    const params = Object.fromEntries(url.searchParams);
    calls.push({ method, params });
    const reply = (body) => new Response(JSON.stringify({ ok: true, ...body }));
    if (method === 'auth.test')
      return reply({ user: 'me', team: 'Team', team_id: 'T1', user_id: 'U9' });
    if (method === 'users.list')
      return reply({
        members: [
          { id: 'U9', profile: { display_name: 'Alex' } },
          { id: 'U2', profile: { display_name: 'Sam' } },
        ],
      });
    if (method === 'search.messages') {
      if (params.query.startsWith('in:ezat_claudio'))
        return reply({
          messages: { matches: [{ channel: { id: OWN, name: 'ezat_claudio' } }] },
        });
      if (params.query.startsWith('TAP-2356 '))
        return reply({
          messages: {
            matches: [
              {
                ts: ROOT,
                user: 'U9',
                text: 'TAP-2356 review: PR is up',
                channel: { id: LISTED, name: 'piq_claudio' },
                permalink: `https://example.slack.com/archives/${LISTED}/p1794905600296579`,
              },
            ],
            paging: { total: 1 },
          },
        });
      return reply({ messages: { matches: [], paging: { total: 0 } } });
    }
    if (method === 'conversations.replies' && params.channel === LISTED)
      return reply({
        messages: [
          {
            ts: ROOT,
            thread_ts: ROOT,
            user: 'U9',
            text: 'TAP-2356 review: PR is up',
            reply_count: 1,
            latest_reply: REPLY,
          },
          { ts: REPLY, thread_ts: ROOT, user: 'U2', text: 'looks good' },
        ],
      });
    return reply({ messages: [] });
  };
}

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-ticket-dialog-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = slackPaths(home);
  fs.mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    paths.session,
    JSON.stringify({
      token: 'xoxc-synthetic',
      cookie: 'xoxd-synthetic',
      teamId: 'T1',
      teamDomain: 'example',
      savedAt: '2026-01-01T00:00:00.000Z',
    }),
    { mode: 0o600 },
  );
  const calls = [];
  const integration = createSlackIntegration({
    paths,
    now: () => NOW,
    fetchImpl: fakeFetch(calls),
    spawnImpl: () => ({ unref() {}, on() {} }),
  });
  return { integration, calls };
}

test('a thread found by ticket search opens in its own channel', async (t) => {
  const { integration, calls } = setup(t);

  assert.deepEqual(await integration.thread(ROOT, LISTED), { available: false });
  assert.equal(
    calls.filter((call) => call.method === 'conversations.replies').length,
    0,
    'an unlisted thread never reaches Slack',
  );

  const listed = await integration.ticketThreads(['TAP-2356']);
  assert.equal(listed.available, true);
  assert.equal(listed.threads[0].channel.id, LISTED);

  const opened = await integration.thread(ROOT, LISTED);
  assert.equal(opened.available, true);
  assert.deepEqual(opened.thread.channel, { id: LISTED, name: 'piq_claudio', kind: 'channel' });
  assert.equal(opened.thread.messages.length, 2);
  assert.match(opened.thread.url, new RegExp(LISTED));
  const read = calls.filter((call) => call.method === 'conversations.replies').at(-1);
  assert.equal(read.params.channel, LISTED);
});

test('the same timestamp in another channel, a bad id, or no channel reads nothing', async (t) => {
  const { integration } = setup(t);
  await integration.ticketThreads(['TAP-2356']);

  assert.equal((await integration.thread(ROOT, 'C9999999999')).available, false);
  assert.equal((await integration.thread(ROOT, 'not-a-channel')).available, false);
  // Without a channel it is the shared list's own channel, which never verified this thread.
  assert.equal((await integration.thread(ROOT)).available, false);
  // The shared list's own channel id is the same as no channel: still not this thread.
  assert.equal((await integration.thread(ROOT, OWN)).available, false);
});

test('the chip names the channel and the hook tells threads apart by channel', () => {
  const link = fs.readFileSync(
    new URL('../ui-react/components/SlackThreadLink.jsx', import.meta.url),
    'utf8',
  );
  assert.match(link, /where\.kind === 'channel' \? `#\$\{where\.name\}` : where\.name/);
  const hook = fs.readFileSync(
    new URL('../ui-react/hooks/useTicketSlackThreads.jsx', import.meta.url),
    'utf8',
  );
  assert.match(hook, /`\$\{row\.channel\?\.id \?\? ''\}:\$\{row\.ts\}`/);
});
