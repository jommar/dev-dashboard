// slack-watch-leak.test.mjs — over one full scenario nothing from Slack, the session listing or a
// failed spawn reaches disk, a response body or the console. The only place a session label may
// appear is the picker route's own reply.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  CHANNEL,
  FORK_SENTENCE,
  OTHER,
  SESSION_A,
  SESSION_B,
  THREAD_TS,
  captureConsole,
  findInTree,
  listingEntry,
  permalinkFor,
  rateLimitedResponse,
  threadKey,
  tsAt,
  wakeConstants,
  watchFixture,
  writeSlackSession,
} from './slack-watch-fixture.mjs';

const SENTINELS = {
  messageText: 'SENTINEL-MESSAGE-TEXT-7f3a',
  olderMessageText: 'SENTINEL-OLDER-TEXT-2d41',
  authDisplayName: 'sentinel-display-name',
  replyDisplayName: 'SENTINEL-DISPLAY-NAME-5d1e',
  replyRealName: 'SENTINEL-REAL-NAME-8a07',
  token: 'xoxc-SENTINEL-TOKEN-91c2',
  cookie: 'xoxd-SENTINEL-COOKIE-44b0',
  cwdFinished: '/work/SENTINEL-CWD-FINISHED-3c5d',
  cwdLive: '/work/SENTINEL-CWD-LIVE-6e92',
  spawnFailure: 'SENTINEL-SPAWN-FAILURE-1e6c',
  stopOutput: 'SENTINEL-STOP-OUTPUT-4b9d',
  forkSessionName: 'SENTINEL-FORK-NAME-c2e8',
};
const LABELS = {
  finishedName: 'SENTINEL-NAME-FINISHED-b7a4',
  liveName: 'SENTINEL-NAME-LIVE-0f58',
};
const ALL_NEEDLES = { ...SENTINELS, ...LABELS };
const NEEDLE_NAMES = Object.keys(ALL_NEEDLES);
const NEEDLE_VALUES = Object.values(ALL_NEEDLES);
const LABEL_VALUES = Object.values(LABELS);
const SESSION_FILE = path.join('.config', 'slack', 'session.json');
const PICKER_PATH = '/api/slack/watch/sessions';
const STORED_THREAD_KEYS = [
  'key',
  'link',
  'channelId',
  'threadTs',
  'addedAt',
  'baselineAt',
  'lastNotifiedTs',
  'sessionIds',
];
const DEFAULT_NOTICE_PREFIX = "There's a new message on ";
const LIVE_PID = 4242;
const SLACK_RATE_LIMIT_SECONDS = 30;
const IDLE_GAP_MS = 1_000_000;
const { SETTLE_MS } = await wakeConstants();

function needlesIn(text, allowedValues = []) {
  return NEEDLE_NAMES.filter(
    (name) => !allowedValues.includes(ALL_NEEDLES[name]) && text.includes(ALL_NEEDLES[name]),
  );
}

// Runs add link, attach, baseline, wake (with a failing resume spawn), 429, pause, resume, list,
// picker and detach through the real handler, scanning every sink after each step. Directories
// are scanned at each step because a detach removes an inbox for good.
async function runScenario(t) {
  const consoleLines = captureConsole(t);
  const f = await watchFixture(t, { http: true, reader: 'real', sessions: 'real' });
  writeSlackSession(f.home, { token: SENTINELS.token, cookie: SENTINELS.cookie });
  const key = threadKey();
  const link = permalinkFor();
  const evidence = {
    f,
    key,
    link,
    hits: [],
    responses: [],
    snapshots: [],
    inboxAfterWake: {},
    inboxBeforeDetach: {},
    repliesServed: 0,
    rateLimitedServed: 0,
    spawnFailuresServed: 0,
    forkOutputsServed: 0,
  };

  const record = (step, sink, names) =>
    names.forEach((name) => evidence.hits.push(`${step} | ${sink} | ${name}`));

  function checkpoint(step) {
    for (const { file, needle } of findInTree(f.paths.watchDirectory, NEEDLE_VALUES))
      record(step, `watch directory: ${file}`, [NEEDLE_NAMES[needle]]);
    assert.ok(fs.existsSync(f.paths.settings), `${step}: settings.json exists to be scanned`);
    record(step, 'settings.json', needlesIn(fs.readFileSync(f.paths.settings, 'utf8')));
    for (const { file, needle } of findInTree(f.home, NEEDLE_VALUES))
      if (file !== SESSION_FILE) record(step, `home: ${file}`, [NEEDLE_NAMES[needle]]);
    record(step, 'console', needlesIn(consoleLines.join('\n')));
    const spawnArgv = f.exec.spawns().map(({ file, args }) => ({ file, args }));
    record(step, 'spawn argv', needlesIn(JSON.stringify(spawnArgv)));
    evidence.snapshots.push(f.store.snapshot());
  }

  async function request(method, pathname, body) {
    const response =
      body === undefined
        ? await f.http.bare(method, pathname)
        : await f.http.json(method, pathname, body);
    evidence.responses.push({ method, pathname, status: response.status, text: response.text });
    const allowed = pathname === PICKER_PATH ? LABEL_VALUES : [];
    record(`${method} ${pathname}`, 'response body', needlesIn(response.text, allowed));
    assert.equal(response.status, 200, `${method} ${pathname} answered ${response.status}`);
    return response;
  }

  f.exec.setListing([
    listingEntry({
      sessionId: SESSION_A,
      name: LABELS.finishedName,
      cwd: SENTINELS.cwdFinished,
    }),
    listingEntry({
      sessionId: SESSION_B,
      pid: LIVE_PID,
      state: 'working',
      name: LABELS.liveName,
      cwd: SENTINELS.cwdLive,
    }),
  ]);
  let spawnsFail = true;
  f.exec.onStop(() => ({ stdout: `stopped ${SENTINELS.stopOutput}` }));
  f.exec.onResume(() => {
    if (!spawnsFail) {
      evidence.forkOutputsServed += 1;
      return { stdout: `session x ${FORK_SENTENCE} y ${SENTINELS.forkSessionName}` };
    }
    evidence.spawnFailuresServed += 1;
    return { exitCode: 1, stderr: `${SENTINELS.spawnFailure} failure text` };
  });
  let slackRateLimited = false;
  f.slackFetch.script(({ method, url }) => {
    if (slackRateLimited) {
      evidence.rateLimitedServed += 1;
      return rateLimitedResponse(SLACK_RATE_LIMIT_SECONDS);
    }
    if (method !== 'conversations.replies') return null;
    const thread = threadKey(url.searchParams.get('channel'), url.searchParams.get('ts'));
    if (!f.threads.has(thread)) return null;
    evidence.repliesServed += 1;
    return Response.json({
      ok: true,
      messages: f.threads.messages(thread).map((message) => ({
        ts: message.ts,
        user: message.user,
        text: message.text,
        username: SENTINELS.replyRealName,
        user_profile: {
          display_name: SENTINELS.replyDisplayName,
          real_name: SENTINELS.replyRealName,
        },
      })),
      has_more: false,
    });
  });
  f.threads.set(key, [{ ts: tsAt(-600), user: OTHER, text: SENTINELS.olderMessageText }]);

  const added = await request('POST', '/api/slack/watch/links', { links: [link] });
  assert.equal(added.json().results[0].ok, true, 'the permalink was accepted');
  await request('POST', '/api/slack/watch/attach', { link, sessionId: SESSION_A });
  await request('POST', '/api/slack/watch/attach', { link, sessionId: SESSION_B });
  checkpoint('attach');

  await f.tick();
  checkpoint('baseline tick');

  f.clock.advance(SETTLE_MS + 1_000);
  f.threads.post(key, { ts: tsAt(30), user: OTHER, text: SENTINELS.messageText });
  await f.tick();
  checkpoint('wake');
  for (const sessionId of [SESSION_A, SESSION_B])
    evidence.inboxAfterWake[sessionId] = f.inboxLines(sessionId);

  slackRateLimited = true;
  f.clock.advance(IDLE_GAP_MS);
  await f.tick();
  checkpoint('429 tick');
  slackRateLimited = false;
  spawnsFail = false;

  await request('POST', '/api/slack/watch/pause');
  checkpoint('pause');
  f.clock.advance(IDLE_GAP_MS);
  await f.tick();
  checkpoint('paused tick');
  await request('POST', '/api/slack/watch/resume');
  checkpoint('resume');

  await request('GET', '/api/slack/watch');
  await request('GET', PICKER_PATH);
  checkpoint('list and picker');
  for (const sessionId of [SESSION_A, SESSION_B])
    evidence.inboxBeforeDetach[sessionId] = f.inboxLines(sessionId);

  await request('POST', '/api/slack/watch/detach', { link, sessionId: SESSION_A });
  await request('POST', '/api/slack/watch/detach', { link, sessionId: SESSION_B });
  checkpoint('detach');
  await request('GET', '/api/slack/watch');

  // The scenario must have exercised every planted path, or a clean scan proves nothing.
  const authorizations = f.slackFetch.calls.map(({ init }) => new Headers(init.headers));
  assert.ok(
    authorizations.some((headers) => headers.get('authorization')?.includes(SENTINELS.token)),
    'a Slack call carried the planted token',
  );
  assert.ok(
    authorizations.some((headers) => headers.get('cookie')?.includes(SENTINELS.cookie)),
    'a Slack call carried the planted cookie',
  );
  assert.ok(evidence.repliesServed >= 1, 'Slack answered with message text and display names');
  assert.ok(evidence.rateLimitedServed >= 1, 'a 429 was served');
  assert.ok(evidence.spawnFailuresServed >= 1, 'a spawn failure message was produced');
  assert.ok(evidence.forkOutputsServed >= 1, 'a resume output naming a session was produced');
  assert.ok(
    f.exec.spawns().some((spawn) => spawn.options.cwd === SENTINELS.cwdFinished),
    'the finished session was resumed from its listed cwd',
  );
  for (const sessionId of [SESSION_A, SESSION_B])
    assert.ok(
      evidence.inboxBeforeDetach[sessionId].length >= 1,
      `${sessionId} received at least one inbox line`,
    );
  return evidence;
}

test('leak: no sentinel reaches the watch directory, settings, the home tree, a body or the console', async (t) => {
  const { f, hits } = await runScenario(t);
  assert.deepEqual(hits, []);
  const planted = findInTree(f.home, [SENTINELS.token, SENTINELS.cookie]).map(({ file }) => file);
  assert.deepEqual(
    planted,
    [SESSION_FILE, SESSION_FILE],
    'the scan does find the token and cookie in the Slack session file',
  );
});

test('leak: stored per-thread data is only key, ids, timestamps and session ids', async (t) => {
  const { f, key, snapshots } = await runScenario(t);
  assert.ok(snapshots.length >= 5, 'a snapshot was taken after every step');
  for (const snapshot of snapshots) {
    const entries = Object.values(snapshot.links);
    assert.equal(entries.length, 1, 'one watched thread');
    const [entry] = entries;
    assert.deepEqual(Object.keys(entry).sort(), [...STORED_THREAD_KEYS].sort());
    assert.equal(entry.key, key);
    assert.equal(entry.channelId, CHANNEL);
    assert.equal(entry.threadTs, THREAD_TS);
    assert.equal(typeof entry.link, 'string');
    for (const field of ['addedAt', 'baselineAt'])
      assert.ok(entry[field] === null || !Number.isNaN(Date.parse(entry[field])), field);
    assert.ok(entry.lastNotifiedTs === null || /^\d+\.\d+$/.test(entry.lastNotifiedTs));
    for (const sessionId of entry.sessionIds) assert.ok([SESSION_A, SESSION_B].includes(sessionId));
  }
  const onDisk = JSON.parse(f.mapText());
  assert.equal(Object.keys(onDisk.links).length, 1, 'the map on disk holds the one thread');
  for (const entry of Object.values(onDisk.links))
    for (const field of Object.keys(entry))
      assert.ok(STORED_THREAD_KEYS.includes(field), `map.json stores only known fields: ${field}`);
});

test('leak: every inbox line is the rendered default notice for the stored link', async (t) => {
  const { key, snapshots, inboxAfterWake, inboxBeforeDetach } = await runScenario(t);
  const stored = snapshots.find((snapshot) => snapshot.links[key]).links[key].link;
  assert.equal(typeof stored, 'string');
  for (const lines of [inboxAfterWake, inboxBeforeDetach])
    for (const sessionId of [SESSION_A, SESSION_B]) {
      assert.ok(lines[sessionId].length >= 1, `${sessionId} has a line`);
      for (const line of lines[sessionId]) assert.equal(line, `${DEFAULT_NOTICE_PREFIX}${stored}`);
    }
});

test('leak: the session label is in the picker reply and in no other route reply', async (t) => {
  const { responses } = await runScenario(t);
  const picker = responses.filter(({ pathname }) => pathname === PICKER_PATH);
  assert.equal(picker.length, 1);
  for (const label of LABEL_VALUES)
    assert.ok(picker[0].text.includes(label), 'the picker carries the label');
  for (const { method, pathname, text } of responses.filter(
    ({ pathname }) => pathname !== PICKER_PATH,
  ))
    for (const label of LABEL_VALUES)
      assert.ok(!text.includes(label), `${method} ${pathname} must not carry a session label`);
  for (const name of NEEDLE_NAMES.filter((name) => !(name in LABELS)))
    assert.ok(!picker[0].text.includes(ALL_NEEDLES[name]), `the picker must not carry ${name}`);
});
