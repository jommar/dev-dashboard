// slack-watch-readonly.test.mjs — the watcher only ever reads from Slack: the recorded method names
// over a full scenario and the source of every new module hold no write-capable name.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  OTHER,
  SESSION_A,
  SESSION_B,
  listingEntry,
  permalinkFor,
  rateLimitedResponse,
  threadKey,
  tsAt,
  watchFixture,
} from './slack-watch-fixture.mjs';

const READ_ONLY_WATCH_METHODS = ['auth.test', 'conversations.replies'];
const NEW_MODULES = [
  'backend/slack-link.mjs',
  'backend/slack-notice.mjs',
  'backend/slack-watch-store.mjs',
  'backend/claude-sessions.mjs',
  'backend/slack-watcher.mjs',
];
const SLACK_MODULE = 'backend/slack.mjs';
// Method names Slack's web API offers for changing something, as a literal or a URL path segment.
// A bare identifier such as a `files` variable is not a method name, hence the quote or slash.
const WRITE_METHOD_NAME =
  /(?<=['"`/])(?:(?:chat|reactions|files|pins|stars|reminders|dnd|usergroups)\.[A-Za-z]|conversations\.(?:mark|join|invite|open|archive)|users\.setPresence)/g;
const WRITE_METHOD_SAMPLES = [
  'chat.postMessage',
  'reactions.add',
  'files.upload',
  'conversations.mark',
  'conversations.join',
  'conversations.invite',
  'conversations.open',
  'conversations.archive',
  'pins.add',
  'stars.add',
  'reminders.add',
  'users.setPresence',
  'dnd.setSnooze',
  'usergroups.update',
];
// Every method name that `backend/slack.mjs` hands to `call(` or `paged(` before this feature; the
// watch reader may use only `auth.test` and `conversations.replies` of them.
const METHODS_BEFORE_WATCH = [
  'auth.test',
  'users.list',
  'search.messages',
  'conversations.list',
  'conversations.history',
  'conversations.replies',
  'client.counts',
];
const METHOD_LITERAL = /\b(?:call|paged)\(\s*(?:credentials,\s*)?['"`]([a-z]+\.[A-Za-z.]+)['"`]/g;
const LIVE_PID = 4242;
const IDLE_GAP_MS = 1_000_000;

function writeMethodNames(source) {
  return source.match(WRITE_METHOD_NAME) || [];
}

function readSource(relativePath) {
  return fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

// Add link, attach, baseline, wake with a resume spawn, 429, pause, resume, picker and detach,
// through the real handler, the real reader and the real session listing.
async function runFullScenario(t) {
  const f = await watchFixture(t, { http: true, reader: 'real', sessions: 'real' });
  const key = threadKey();
  const link = permalinkFor();
  f.exec.setListing([
    listingEntry({ sessionId: SESSION_A }),
    listingEntry({ sessionId: SESSION_B, pid: LIVE_PID, state: 'working' }),
  ]);
  f.threads.set(key, [{ ts: tsAt(-600), user: OTHER }]);
  let rateLimited = false;
  let rateLimitedServed = 0;
  f.slackFetch.script(() => {
    if (!rateLimited) return null;
    rateLimitedServed += 1;
    return rateLimitedResponse(30);
  });

  async function request(method, pathname, body) {
    const response =
      body === undefined
        ? await f.http.bare(method, pathname)
        : await f.http.json(method, pathname, body);
    assert.equal(response.status, 200, `${method} ${pathname} answered ${response.status}`);
    return response;
  }

  await request('POST', '/api/slack/watch/links', { links: [link] });
  await request('POST', '/api/slack/watch/attach', { link, sessionId: SESSION_A });
  await request('POST', '/api/slack/watch/attach', { link, sessionId: SESSION_B });
  await f.tick();
  f.clock.advance(60_000);
  f.threads.post(key, { ts: tsAt(30), user: OTHER });
  await f.tick();
  rateLimited = true;
  f.clock.advance(IDLE_GAP_MS);
  await f.tick();
  rateLimited = false;
  await request('POST', '/api/slack/watch/pause');
  f.clock.advance(IDLE_GAP_MS);
  await f.tick();
  await request('POST', '/api/slack/watch/resume');
  await request('GET', '/api/slack/watch/sessions');
  await request('POST', '/api/slack/watch/detach', { link, sessionId: SESSION_A });
  await request('POST', '/api/slack/watch/detach', { link, sessionId: SESSION_B });

  assert.ok(f.exec.spawns().length >= 1, 'the wake resumed the finished session');
  assert.ok(rateLimitedServed >= 1, 'a 429 was served');
  return f;
}

test('read-only: a full scenario asks Slack only auth.test and conversations.replies', async (t) => {
  const f = await runFullScenario(t);
  const methods = f.slackFetch.methods();
  assert.ok(methods.length > 0, 'the scenario reached Slack');
  assert.ok(methods.includes('conversations.replies'), 'the thread was read');
  const outsideReadOnlySet = [...new Set(methods)].filter(
    (method) => !READ_ONLY_WATCH_METHODS.includes(method),
  );
  assert.deepEqual(outsideReadOnlySet, []);
});

test('read-only: every new module exists and holds no write-capable Slack method name', () => {
  for (const file of NEW_MODULES) {
    assert.ok(fs.existsSync(new URL(`../${file}`, import.meta.url)), `${file} exists`);
    assert.ok(readSource(file).trim().length > 0, `${file} is not empty`);
  }
  // The scan itself must see each name, or an empty result would prove nothing.
  for (const name of WRITE_METHOD_SAMPLES) {
    assert.equal(writeMethodNames(`await call('${name}', {}, credentials)`).length, 1, name);
    assert.equal(writeMethodNames(`const url = \`\${API_URL}/${name}\``).length, 1, name);
  }
  assert.deepEqual(writeMethodNames('files.length; profiles.json; "inbox".chat.x; pins. next'), []);
  for (const file of NEW_MODULES) assert.deepEqual(writeMethodNames(readSource(file)), [], file);
});

test('read-only: backend/slack.mjs gains only the reader and no write-capable name', async () => {
  const source = readSource(SLACK_MODULE);
  assert.ok(source.trim().length > 0, `${SLACK_MODULE} is not empty`);
  const { createSlackIntegration, slackPaths } = await import('../backend/slack.mjs');
  const integration = createSlackIntegration({
    paths: slackPaths('/nonexistent-home-for-the-read-only-test'),
    fetchImpl: async () => {
      throw new Error('no network in this test');
    },
  });
  assert.equal(typeof integration.lastInThread, 'function');
  assert.deepEqual(writeMethodNames(source), []);
  const literals = [...source.matchAll(METHOD_LITERAL)].map((match) => match[1]);
  assert.ok(literals.length >= METHODS_BEFORE_WATCH.length, 'the method literals were found');
  const added = [...new Set(literals)].filter((name) => !METHODS_BEFORE_WATCH.includes(name));
  assert.deepEqual(added, [], 'no Slack method beyond the read-only ones in use today');
});
