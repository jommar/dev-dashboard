import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { once } from 'node:events';
import {
  CHANNEL,
  DEFAULT_SLACK_WATCH,
  DEFAULT_TEMPLATE,
  OTHER,
  SESSION_A,
  SESSION_B,
  SESSION_C,
  SESSION_D,
  START_MS,
  THREAD_TS,
  flush,
  permalinkFor,
  threadKey,
  tsAt,
  wakeConstants,
  watchFixture,
} from './slack-watch-fixture.mjs';

const WATCH = '/api/slack/watch';
const SNAKE_CASE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const SECOND_THREAD_TS = tsAt(-400, 200);
const SECOND_KEY = threadKey(CHANNEL, SECOND_THREAD_TS);
const SECOND_LINK = permalinkFor(CHANNEL, SECOND_THREAD_TS);
const CHANNEL_ONLY_LINK = `https://example.slack.com/archives/${CHANNEL}`;
const NON_SLACK_LINK = 'https://example.com/archives/C024BE91L/p1793192214548389';
const APP_THREAD_LINK = `https://app.slack.com/client/T024BE7LD/${CHANNEL}/thread/${CHANNEL}-${THREAD_TS}`;
const SETTINGS_BODY = { intervalSeconds: 60, noticeTemplate: 'Ping {link}' };
const POLL_INTERVAL_MS = 180_000;
const PARTWAY_MS = 100_000;
const STOP_AFTER_LINE_MS = 60_000;
const RESUME_AFTER_STOP_MS = 90_000;
const NO_STEP = { step: null, steps: null, nextStepAt: null };
const REFUSAL_KEYS = ['code', 'error', 'errors'];
const FIXED_CODE = /^[A-Z]+(?:_[A-Z]+)+$/;

const post = (f, route, body) => f.http.json('POST', `${WATCH}/${route}`, body);
const readIfPresent = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
const inboxListing = (f) =>
  fs.existsSync(f.paths.inboxDirectory) ? fs.readdirSync(f.paths.inboxDirectory).sort() : null;

async function listOf(f) {
  const res = await f.http.bare('GET', WATCH);
  assert.equal(res.status, 200, 'GET /api/slack/watch answers 200');
  return res.json();
}

// Everything a refused request must leave alone: the list as served, the map
// bytes, the settings file bytes and the inbox directory.
async function stateOf(f) {
  return {
    list: (await f.http.bare('GET', WATCH)).text,
    map: f.mapText(),
    settings: readIfPresent(f.paths.settings),
    inbox: inboxListing(f),
  };
}

async function assertRefused(f, route, body, { status, code }) {
  const label = `${route} ${JSON.stringify(body)}`;
  const before = await stateOf(f);
  const res = await post(f, route, body);
  assert.equal(res.status, status, `${label}: status`);
  assert.equal(res.json().code, code, `${label}: code`);
  assert.deepEqual(await stateOf(f), before, `${label}: nothing changed`);
}

function assertNoSlackReads(f) {
  assert.equal(f.fakeReader.calls.length, 0, 'the routes make no Slack call');
}

function inboxLiteral(f, sessionId) {
  return `${f.home}/.config/dev-dashboard/slack-watch/inbox/${sessionId}.log`;
}

function distinctLinks(count) {
  return Array.from({ length: count }, (_, index) =>
    permalinkFor(CHANNEL, `1793192214.${String(100_000 + index)}`),
  );
}

// A thread whose newest message comes from another user after the attach time.
async function watchWithNewMessage(f, sessionIds) {
  return f.watch({
    sessionIds,
    messages: [
      { ts: THREAD_TS, user: OTHER },
      { ts: tsAt(10), user: OTHER },
    ],
  });
}

test('links routes store an accepted link once and report the others rejected with reasons', async (t) => {
  const f = await watchFixture(t, { http: true });
  const inputs = [permalinkFor(), CHANNEL_ONLY_LINK, NON_SLACK_LINK];
  const res = await post(f, 'links', { links: inputs });
  assert.equal(res.status, 200);
  const { results } = res.json();
  assert.equal(results.length, 3);
  assert.equal(results[0].input, inputs[0]);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].key, threadKey());
  assert.equal(results[0].added, true);
  for (const index of [1, 2]) {
    assert.equal(results[index].input, inputs[index]);
    assert.equal(results[index].ok, false, `link ${index} is rejected`);
    assert.match(results[index].reason, SNAKE_CASE, `link ${index} carries a reason code`);
    assert.equal(results[index].key, undefined, `link ${index} has no key`);
  }
  const { links } = await listOf(f);
  assert.equal(links.length, 1);
  assert.equal(links[0].key, threadKey());
  assert.equal(f.entry(threadKey()).channelId, CHANNEL);
  assertNoSlackReads(f);
});

test('links routes add nothing for the dashboard thread form of a stored thread', async (t) => {
  const f = await watchFixture(t, { http: true });
  await post(f, 'links', { links: [permalinkFor()] });
  const before = await stateOf(f);
  const res = await post(f, 'links', { links: [APP_THREAD_LINK] });
  assert.equal(res.status, 200);
  const [result] = res.json().results;
  assert.equal(result.ok, true);
  assert.equal(result.key, threadKey());
  assert.equal(result.added, false);
  assert.equal((await listOf(f)).links.length, 1);
  assert.deepEqual(await stateOf(f), before);
  assertNoSlackReads(f);
});

test('links routes store the same link twice in one request once', async (t) => {
  const f = await watchFixture(t, { http: true });
  const res = await post(f, 'links', { links: [permalinkFor(), permalinkFor()] });
  assert.equal(res.status, 200);
  const { results } = res.json();
  assert.deepEqual(
    results.map((result) => [result.ok, result.key, result.added]),
    [
      [true, threadKey(), true],
      [true, threadKey(), false],
    ],
  );
  assert.equal((await listOf(f)).links.length, 1);
  assertNoSlackReads(f);
});

test('links routes refuse 51 links with nothing stored and accept 50', async (t) => {
  const f = await watchFixture(t, { http: true });
  const before = await stateOf(f);
  const refused = await post(f, 'links', { links: distinctLinks(51) });
  assert.equal(refused.status, 400);
  assert.equal(refused.json().code, 'INVALID_LINK');
  assert.deepEqual(await stateOf(f), before);
  assert.deepEqual((await listOf(f)).links, []);

  const accepted = await post(f, 'links', { links: distinctLinks(50) });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.json().results.length, 50);
  assert.equal(
    accepted.json().results.every((result) => result.ok && result.added),
    true,
  );
  assert.equal((await listOf(f)).links.length, 50);
  assertNoSlackReads(f);
});

test('links routes refuse a body over 64 KB with nothing stored', async (t) => {
  const f = await watchFixture(t, { http: true });
  const before = await stateOf(f);
  const res = await post(f, 'links', { links: [permalinkFor(), 'x'.repeat(70_000)] });
  assert.equal(res.status, 413);
  assert.equal(res.json().code, 'BODY_TOO_LARGE');
  assert.deepEqual(await stateOf(f), before);
  assert.deepEqual((await listOf(f)).links, []);
});

test('links routes answer a non-JSON body with INVALID_JSON', async (t) => {
  const f = await watchFixture(t, { http: true });
  await f.watch({ sessionIds: [SESSION_A] });
  for (const route of ['links', 'remove']) {
    await assertRefused(f, route, 'this is { not json', { status: 400, code: 'INVALID_JSON' });
  }
});

test('links routes list answers from memory with state, settings and a delivery slot per session', async (t) => {
  const f = await watchFixture(t, { http: true });
  const key = await f.watch({ sessionIds: [SESSION_A] });
  const body = await listOf(f);
  assert.equal(body.state, 'running');
  assert.deepEqual(body.settings, DEFAULT_SLACK_WATCH);
  assert.equal(body.links.length, 1);
  const [link] = body.links;
  assert.equal(link.key, key);
  assert.equal(typeof link.link, 'string');
  assert.equal(link.lastCheckedAt, null, 'unchecked before any read');
  assert.equal(link.lastStatus, null);
  assert.deepEqual(link.sessions, [{ sessionId: SESSION_A, delivery: null }]);
  await listOf(f);
  assertNoSlackReads(f);
});

test('links routes list carries the last check and each session delivery status after a tick', async (t) => {
  const { SETTLE_MS } = await wakeConstants();
  const tickedAt = new Date(START_MS + SETTLE_MS + 1_000).toISOString();
  const f = await watchFixture(t, { http: true });
  const key = await watchWithNewMessage(f, [SESSION_A, SESSION_B]);
  f.fakeSessions.setSessions([{ sessionId: SESSION_A, state: 'finished' }]);
  f.fakeSessions.onResume(SESSION_A, { status: 'failed-permanent', reason: 'untrusted_workspace' });
  f.clock.advance(SETTLE_MS + 1_000);
  await f.tick();

  const [link] = (await listOf(f)).links;
  assert.equal(link.key, key);
  assert.equal(link.lastStatus, 'ok');
  assert.equal(link.lastCheckedAt, tickedAt);
  const delivery = Object.fromEntries(
    link.sessions.map((session) => [session.sessionId, session.delivery]),
  );
  assert.equal(delivery[SESSION_A].status, 'failed-permanent');
  assert.equal(delivery[SESSION_A].reason, 'untrusted_workspace');
  assert.equal(delivery[SESSION_A].at, tickedAt);
  assert.equal(delivery[SESSION_B].status, 'delivered');
  assert.equal(delivery[SESSION_B].at, tickedAt);
});

test('links routes remove drops the link, its sessions and its inbox', async (t) => {
  const f = await watchFixture(t, { http: true });
  const key = await f.watch({ sessionIds: [SESSION_A] });
  assert.equal(fs.existsSync(f.inboxFile(SESSION_A)), true, 'the session has an inbox first');

  const res = await post(f, 'remove', { link: permalinkFor() });
  assert.equal(res.status, 200);
  assert.equal(res.json().ok, true);
  assert.equal(res.json().removed, true);
  assert.deepEqual((await listOf(f)).links, []);
  assert.equal(f.entry(key), undefined);
  assert.equal(fs.existsSync(f.inboxFile(SESSION_A)), false, 'its inbox is gone');
  assertNoSlackReads(f);
});

test('links routes remove keeps the inbox of a session still on another link', async (t) => {
  const f = await watchFixture(t, { http: true });
  await f.watch({ sessionIds: [SESSION_A] });
  await f.watch({ threadTs: SECOND_THREAD_TS, sessionIds: [SESSION_A] });

  const res = await post(f, 'remove', { link: permalinkFor() });
  assert.equal(res.status, 200);
  assert.deepEqual(
    (await listOf(f)).links.map((link) => link.key),
    [SECOND_KEY],
  );
  assert.deepEqual(f.entry(SECOND_KEY).sessionIds, [SESSION_A]);
  assert.equal(fs.existsSync(f.inboxFile(SESSION_A)), true);
});

test('links routes remove refuses a bad link and reports an unknown thread as not removed', async (t) => {
  const f = await watchFixture(t, { http: true });
  await f.watch({ sessionIds: [SESSION_A] });
  await assertRefused(
    f,
    'remove',
    { link: CHANNEL_ONLY_LINK },
    { status: 400, code: 'INVALID_LINK' },
  );
  await assertRefused(f, 'remove', {}, { status: 400, code: 'INVALID_LINK' });

  const before = await stateOf(f);
  const res = await post(f, 'remove', { link: SECOND_LINK });
  assert.equal(res.status, 200);
  assert.equal(res.json().ok, true);
  assert.equal(res.json().removed, false);
  assert.deepEqual(await stateOf(f), before);
});

test('links routes map an unexpected failure to OPERATION_FAILED without echoing its text', async (t) => {
  const f = await watchFixture(t, { http: true });
  t.mock.method(f.store, 'addLink', async () => {
    throw new Error('boom sentinel-route-failure');
  });
  const res = await post(f, 'links', { links: [permalinkFor()] });
  assert.ok(res.status >= 400, `a failure status, got ${res.status}`);
  assert.equal(res.json().code, 'OPERATION_FAILED');
  assert.equal(res.text.includes('boom'), false);
  assert.equal(res.text.includes('sentinel-route-failure'), false);
});

test('links routes remove maps an unexpected failure to OPERATION_FAILED without echoing its text', async (t) => {
  const f = await watchFixture(t, { http: true });
  await f.watch({ sessionIds: [SESSION_A] });
  t.mock.method(f.store, 'removeLink', async () => {
    throw new Error('boom sentinel-remove-failure');
  });
  const res = await post(f, 'remove', { link: permalinkFor() });
  assert.ok(res.status >= 400, `a failure status, got ${res.status}`);
  assert.equal(res.json().code, 'OPERATION_FAILED');
  assert.equal(res.text.includes('boom'), false);
  assert.equal(res.text.includes('sentinel-remove-failure'), false);
});

test('links routes answer WATCH_DISABLED without a Claude home and change nothing', async (t) => {
  const f = await watchFixture(t, { http: true, claudeHome: false });
  await f.watch({ sessionIds: [SESSION_A] });
  const before = await stateOf(f);

  await assertRefused(
    f,
    'links',
    { links: [SECOND_LINK] },
    { status: 409, code: 'WATCH_DISABLED' },
  );
  await assertRefused(
    f,
    'attach',
    { link: SECOND_LINK, sessionId: SESSION_B },
    { status: 409, code: 'WATCH_DISABLED' },
  );
  await assertRefused(
    f,
    'remove',
    { link: permalinkFor() },
    { status: 409, code: 'WATCH_DISABLED' },
  );
  assert.deepEqual(await stateOf(f), before);

  const body = await listOf(f);
  assert.equal(body.state, 'disabled');
  assert.match(body.reason, SNAKE_CASE);
  assert.equal(body.links.length, 1);

  const sessions = await f.http.bare('GET', `${WATCH}/sessions`);
  assert.equal(sessions.status, 200);

  const detached = await post(f, 'detach', { link: permalinkFor(), sessionId: SESSION_A });
  assert.equal(detached.status, 200);
  assert.deepEqual(f.entry(threadKey()).sessionIds, []);
});

test('attach route adds an unknown link and answers the key and the inbox path with no Slack call', async (t) => {
  const f = await watchFixture(t, { http: true });
  const res = await post(f, 'attach', { link: permalinkFor(), sessionId: SESSION_A });
  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.key, threadKey());
  assert.equal(body.inbox, inboxLiteral(f, SESSION_A));

  const [link] = (await listOf(f)).links;
  assert.equal(link.key, threadKey());
  assert.deepEqual(link.sessions, [{ sessionId: SESSION_A, delivery: null }]);
  assert.equal(fs.existsSync(body.inbox), true, 'the inbox exists');
  assert.equal(fs.readFileSync(body.inbox, 'utf8'), '', 'the inbox starts empty');
  assertNoSlackReads(f);
});

test('attach route works while paused and still makes no Slack call', async (t) => {
  const f = await watchFixture(t, { http: true, paused: true });
  const res = await post(f, 'attach', { link: permalinkFor(), sessionId: SESSION_A });
  assert.equal(res.status, 200);
  assert.equal(res.json().key, threadKey());
  assert.equal(res.json().inbox, inboxLiteral(f, SESSION_A));

  const body = await listOf(f);
  assert.equal(body.state, 'paused');
  assert.deepEqual(body.links[0].sessions, [{ sessionId: SESSION_A, delivery: null }]);
  assert.equal(fs.existsSync(inboxLiteral(f, SESSION_A)), true);
  assertNoSlackReads(f);
});

test('attach route repeated changes nothing', async (t) => {
  const f = await watchFixture(t, { http: true });
  const request = { link: permalinkFor(), sessionId: SESSION_A };
  const first = await post(f, 'attach', request);
  assert.equal(first.status, 200);
  const before = await stateOf(f);
  const inboxBefore = fs.readFileSync(inboxLiteral(f, SESSION_A), 'utf8');
  f.recorder.clearCalls();

  const again = await post(f, 'attach', request);
  assert.equal(again.status, 200);
  assert.equal(again.json().key, threadKey());
  assert.equal(again.json().inbox, inboxLiteral(f, SESSION_A));
  assert.deepEqual(await stateOf(f), before);
  assert.equal(fs.readFileSync(inboxLiteral(f, SESSION_A), 'utf8'), inboxBefore);
  assert.deepEqual(f.entry(threadKey()).sessionIds, [SESSION_A], 'one attachment, not two');
  assert.deepEqual(
    f.recorder.calls.filter((call) => call.method === 'renameSync'),
    [],
    'the map is not rewritten',
  );
  assertNoSlackReads(f);
});

test('attach route to a link already in the list behaves the same', async (t) => {
  const f = await watchFixture(t, { http: true });
  await post(f, 'links', { links: [permalinkFor()] });
  const res = await post(f, 'attach', { link: permalinkFor(), sessionId: SESSION_A });
  assert.equal(res.status, 200);
  assert.equal(res.json().ok, true);
  assert.equal(res.json().key, threadKey());
  assert.equal(res.json().inbox, inboxLiteral(f, SESSION_A));

  const { links } = await listOf(f);
  assert.equal(links.length, 1, 'the known link is not duplicated');
  assert.deepEqual(links[0].sessions, [{ sessionId: SESSION_A, delivery: null }]);
  assert.equal(fs.existsSync(inboxLiteral(f, SESSION_A)), true);
  assertNoSlackReads(f);
});

test('attach route refuses a session id that is not a UUID and changes nothing', async (t) => {
  const f = await watchFixture(t, { http: true });
  await f.watch({ sessionIds: [SESSION_B] });
  for (const sessionId of ['fc6372e4', '../x', '', 12345]) {
    await assertRefused(
      f,
      'attach',
      { link: SECOND_LINK, sessionId },
      { status: 400, code: 'INVALID_SESSION' },
    );
  }
  await assertRefused(f, 'attach', { link: SECOND_LINK }, { status: 400, code: 'INVALID_SESSION' });
  assert.equal(f.entry(SECOND_KEY), undefined, 'the unknown link was not added');
  assertNoSlackReads(f);
});

test('attach route refuses a bad link and changes nothing', async (t) => {
  const f = await watchFixture(t, { http: true });
  await f.watch({ sessionIds: [SESSION_B] });
  for (const link of [CHANNEL_ONLY_LINK, NON_SLACK_LINK]) {
    await assertRefused(
      f,
      'attach',
      { link, sessionId: SESSION_A },
      { status: 400, code: 'INVALID_LINK' },
    );
  }
  await assertRefused(f, 'attach', { sessionId: SESSION_A }, { status: 400, code: 'INVALID_LINK' });
  assert.equal(fs.existsSync(inboxLiteral(f, SESSION_A)), false, 'no inbox for a refused attach');
  assertNoSlackReads(f);
});

test('attach route maps an unexpected failure to OPERATION_FAILED without echoing its text', async (t) => {
  const f = await watchFixture(t, { http: true });
  t.mock.method(f.store, 'attach', async () => {
    throw new Error('boom sentinel-attach-failure');
  });
  const res = await post(f, 'attach', { link: permalinkFor(), sessionId: SESSION_A });
  assert.ok(res.status >= 400, `a failure status, got ${res.status}`);
  assert.equal(res.json().code, 'OPERATION_FAILED');
  assert.equal(res.text.includes('boom'), false);
  assert.equal(res.text.includes('sentinel-attach-failure'), false);
});

test('attach routes: detach takes the session off the link and removes its inbox with its last link', async (t) => {
  const f = await watchFixture(t, { http: true });
  await f.watch({ sessionIds: [SESSION_A, SESSION_B] });
  await f.watch({ threadTs: SECOND_THREAD_TS, sessionIds: [SESSION_A] });

  const first = await post(f, 'detach', { link: permalinkFor(), sessionId: SESSION_A });
  assert.equal(first.status, 200);
  assert.equal(first.json().ok, true);
  assert.deepEqual(f.entry(threadKey()).sessionIds, [SESSION_B]);
  assert.deepEqual(f.entry(SECOND_KEY).sessionIds, [SESSION_A]);
  assert.equal(fs.existsSync(f.inboxFile(SESSION_A)), true, 'kept: another link holds the session');
  assert.equal(fs.existsSync(f.inboxFile(SESSION_B)), true);

  const last = await post(f, 'detach', { link: SECOND_LINK, sessionId: SESSION_A });
  assert.equal(last.status, 200);
  assert.deepEqual(f.entry(SECOND_KEY).sessionIds, []);
  assert.notEqual(f.entry(SECOND_KEY), undefined, 'the link itself stays listed');
  assert.equal(fs.existsSync(f.inboxFile(SESSION_A)), false, 'removed: it was the last link');
  assert.equal(fs.existsSync(f.inboxFile(SESSION_B)), true);
  assertNoSlackReads(f);
});

test('attach routes: detaching an unattached pair is a 200 no-op', async (t) => {
  const f = await watchFixture(t, { http: true });
  await f.watch({ sessionIds: [SESSION_B] });
  const before = await stateOf(f);
  f.recorder.clearCalls();

  const notAttached = await post(f, 'detach', { link: permalinkFor(), sessionId: SESSION_A });
  assert.equal(notAttached.status, 200);
  assert.equal(notAttached.json().ok, true);
  const unknownLink = await post(f, 'detach', { link: SECOND_LINK, sessionId: SESSION_A });
  assert.equal(unknownLink.status, 200);
  assert.equal(unknownLink.json().ok, true);

  assert.deepEqual(await stateOf(f), before);
  assert.equal(f.entry(SECOND_KEY), undefined, 'a detach never adds a link');
  assert.deepEqual(
    f.recorder.calls.filter((call) => call.method === 'renameSync'),
    [],
    'the map is not rewritten',
  );
});

test('settings routes store a valid interval and template and the next tick uses them', async (t) => {
  const f = await watchFixture(t, { http: true });
  await f.watcher.start();
  assert.deepEqual(f.timers.delays(), [180_000]);

  const res = await f.http.json('PUT', `${WATCH}/settings`, SETTINGS_BODY);
  const stored = { intervalSeconds: 60, noticeTemplate: 'Ping {link}', paused: false };
  assert.equal(res.status, 200);
  assert.deepEqual(res.json(), { ok: true, settings: stored });
  assert.deepEqual(JSON.parse(fs.readFileSync(f.paths.settings, 'utf8')).slackWatch, stored);
  assert.deepEqual((await listOf(f)).settings, stored);
  assert.deepEqual(f.timers.delays(), [60_000], 'one timer, re-armed at the new period');

  const key = await watchWithNewMessage(f, [SESSION_A]);
  await f.tick();
  assert.deepEqual(f.inboxLines(SESSION_A), [`Ping ${f.entry(key).link}`]);
});

test('settings routes reject invalid values with field errors and leave the settings file alone', async (t) => {
  const f = await watchFixture(t, { http: true });
  const cases = [
    [{ intervalSeconds: 29, noticeTemplate: 'Ping {link}' }, 'slackWatch.intervalSeconds'],
    [{ intervalSeconds: 3601, noticeTemplate: 'Ping {link}' }, 'slackWatch.intervalSeconds'],
    [{ intervalSeconds: 90.5, noticeTemplate: 'Ping {link}' }, 'slackWatch.intervalSeconds'],
    [{ intervalSeconds: '90', noticeTemplate: 'Ping {link}' }, 'slackWatch.intervalSeconds'],
    [{ intervalSeconds: 60, noticeTemplate: 'first line\n{link}' }, 'slackWatch.noticeTemplate'],
    [
      { intervalSeconds: 60, noticeTemplate: '{link}'.padEnd(201, 'x') },
      'slackWatch.noticeTemplate',
    ],
  ];
  for (const [body, field] of cases) {
    const fileBefore = fs.readFileSync(f.paths.settings, 'utf8');
    const res = await f.http.json('PUT', `${WATCH}/settings`, body);
    const label = JSON.stringify(body).slice(0, 80);
    assert.equal(res.status, 422, `${label}: status`);
    assert.equal(res.json().code, 'INVALID_SETTINGS', `${label}: code`);
    const { errors } = res.json();
    assert.equal(
      errors.some((error) => error.field === field),
      true,
      `${label}: an error for ${field}`,
    );
    assert.equal(
      errors.every((error) => error.field.startsWith('slackWatch.')),
      true,
      `${label}: only slackWatch fields`,
    );
    assert.equal(fs.readFileSync(f.paths.settings, 'utf8'), fileBefore, `${label}: file bytes`);
    assert.deepEqual((await listOf(f)).settings, DEFAULT_SLACK_WATCH, `${label}: stored values`);
  }
});

test('settings routes pause and resume answer a header-less POST and are idempotent', async (t) => {
  const f = await watchFixture(t, { http: true });
  const persistedPaused = () =>
    JSON.parse(fs.readFileSync(f.paths.settings, 'utf8')).slackWatch.paused;

  const paused = await f.http.bare('POST', `${WATCH}/pause`);
  assert.equal(paused.status, 200);
  assert.equal(paused.json().ok, true);
  assert.equal(paused.json().state, 'paused');
  assert.equal(persistedPaused(), true);
  assert.equal((await listOf(f)).state, 'paused');
  const pausedFile = fs.readFileSync(f.paths.settings, 'utf8');

  const pausedAgain = await f.http.bare('POST', `${WATCH}/pause`);
  assert.equal(pausedAgain.status, 200);
  assert.equal(pausedAgain.text, paused.text, 'a repeated pause answers the same');
  assert.equal(fs.readFileSync(f.paths.settings, 'utf8'), pausedFile, 'and writes the same bytes');

  const resumed = await f.http.bare('POST', `${WATCH}/resume`);
  assert.equal(resumed.status, 200);
  assert.equal(resumed.json().ok, true);
  assert.equal(resumed.json().state, 'running');
  assert.equal(persistedPaused(), false);
  assert.equal((await listOf(f)).state, 'running');
  const resumedFile = fs.readFileSync(f.paths.settings, 'utf8');

  const resumedAgain = await f.http.bare('POST', `${WATCH}/resume`);
  assert.equal(resumedAgain.status, 200);
  assert.equal(resumedAgain.text, resumed.text, 'a repeated resume answers the same');
  assert.equal(fs.readFileSync(f.paths.settings, 'utf8'), resumedFile, 'and writes the same bytes');
});

test('settings routes pause and resume accept a JSON content type with no body or an object', async (t) => {
  const f = await watchFixture(t, { http: true });
  for (const body of [undefined, {}]) {
    const paused = await f.http.json('POST', `${WATCH}/pause`, body);
    assert.equal(paused.status, 200, `pause with body ${JSON.stringify(body)}`);
    assert.equal(paused.json().state, 'paused');
    const resumed = await f.http.json('POST', `${WATCH}/resume`, body);
    assert.equal(resumed.status, 200, `resume with body ${JSON.stringify(body)}`);
    assert.equal(resumed.json().state, 'running');
  }
});

// What a header-less client (curl) sends, as one table: route, JSON body.
const localRequests = () => [
  { route: 'links', body: { links: [permalinkFor()] } },
  { route: 'attach', body: { link: permalinkFor(), sessionId: SESSION_A } },
  { route: 'pause', body: undefined },
];

const sendBare = (f, { route, body }) =>
  f.http.bare('POST', `${WATCH}/${route}`, body && JSON.stringify(body));

const sendWith = (f, { route, body }, headers) =>
  f.http.raw('POST', `${WATCH}/${route}`, { body: body && JSON.stringify(body), headers });

async function assertTrustedRefusal(t, makeHeaders, expectedStatus) {
  const f = await watchFixture(t, { http: true });
  const before = await stateOf(f);
  for (const request of localRequests()) {
    const res = await sendWith(f, request, makeHeaders(f));
    assert.equal(res.status, expectedStatus, `${request.route}: status`);
  }
  assert.deepEqual(await stateOf(f), before, 'no map, settings or inbox change');
  assert.deepEqual(f.entry(threadKey()), undefined, 'no link stored');
  assertNoSlackReads(f);

  // The same requests without the offending header go through, so the refusals above
  // were about the header and not a missing route.
  for (const request of localRequests()) {
    const res = await sendBare(f, request);
    assert.equal(res.status, 200, `${request.route}: header-less control`);
  }
  assert.notDeepEqual(await stateOf(f), before, 'the control requests do change state');
}

test('endpoint trust: header-less local POSTs to the link, session and pause routes succeed and change state', async (t) => {
  const f = await watchFixture(t, { http: true });
  const [links, session, pause] = localRequests();

  const added = await sendBare(f, links);
  assert.equal(added.status, 200);
  assert.equal(added.json().results[0].ok, true);
  assert.equal(f.entry(threadKey()).channelId, CHANNEL);

  const joined = await sendBare(f, session);
  assert.equal(joined.status, 200);
  assert.deepEqual(f.entry(threadKey()).sessionIds, [SESSION_A]);

  const paused = await sendBare(f, pause);
  assert.equal(paused.status, 200);
  assert.equal(f.settings.getPublicSettings().slackWatch.paused, true);
  assert.equal((await listOf(f)).state, 'paused');
});

test('endpoint trust: a same-origin JSON POST from the dashboard page succeeds', async (t) => {
  const f = await watchFixture(t, { http: true });
  const headers = { origin: f.http.base, 'content-type': 'application/json' };
  for (const request of localRequests()) {
    const res = await sendWith(f, request, headers);
    assert.equal(res.status, 200, `${request.route}: same-origin`);
  }
  assert.deepEqual(f.entry(threadKey()).sessionIds, [SESSION_A]);
  assert.equal((await listOf(f)).state, 'paused');
});

test('endpoint trust: a foreign Origin is refused with 403 and changes nothing', async (t) => {
  await assertTrustedRefusal(t, () => ({ origin: 'http://evil.example' }), 403);
});

test('endpoint trust: a cross-site fetch is refused with 403 and changes nothing', async (t) => {
  await assertTrustedRefusal(t, () => ({ 'sec-fetch-site': 'cross-site' }), 403);
});

test('endpoint trust: a non-loopback Host is refused with 403 and changes nothing', async (t) => {
  await assertTrustedRefusal(t, (f) => ({ host: `evil.example:${f.http.port}` }), 403);
});

test('endpoint trust: a non-JSON content type is refused with 415 and changes nothing', async (t) => {
  await assertTrustedRefusal(t, () => ({ 'content-type': 'text/plain' }), 415);
});

test('endpoint trust: with setup incomplete every slack watch route answers while services still need setup', async (t) => {
  const f = await watchFixture(t, { http: true, setupAccepted: false });
  const gated = await f.http.bare('GET', '/api/services');
  assert.equal(gated.status, 409);
  assert.equal(gated.json().code, 'SETUP_REQUIRED');

  const link = permalinkFor();
  const body = { link, sessionId: SESSION_A };
  const requests = [
    ['GET', WATCH],
    ['GET', `${WATCH}/sessions`],
    ['POST', `${WATCH}/links`, { links: [link] }],
    ['POST', `${WATCH}/attach`, body],
    ['POST', `${WATCH}/detach`, body],
    ['POST', `${WATCH}/pause`],
    ['POST', `${WATCH}/resume`],
    ['PUT', `${WATCH}/settings`, SETTINGS_BODY],
    ['POST', `${WATCH}/remove`, { link }],
  ];
  for (const [method, pathname, requestBody] of requests) {
    const res = await f.http.json(method, pathname, requestBody);
    assert.equal(res.status, 200, `${method} ${pathname}`);
    assert.notEqual(res.json().code, 'SETUP_REQUIRED', `${method} ${pathname}`);
  }
  assert.equal((await f.http.bare('GET', '/api/services')).status, 409, 'the gate is unchanged');
});

const isoAt = (offsetMs) => new Date(START_MS + offsetMs).toISOString();

async function nextCheckAtOf(f) {
  const body = await listOf(f);
  assert.ok('nextCheckAt' in body, 'the list carries nextCheckAt');
  return body.nextCheckAt;
}

async function deliveryOf(f, key, sessionId) {
  const link = (await listOf(f)).links.find((item) => item.key === key);
  return link.sessions.find((session) => session.sessionId === sessionId).delivery;
}

// A delivery without its own timestamp: the status, the reason and the three step fields.
function stepView(delivery) {
  if (delivery === null) return null;
  const { status, reason, step, steps, nextStepAt } = delivery;
  return { status, reason, step, steps, nextStepAt };
}

async function stepViewOf(f, key, sessionId) {
  return stepView(await deliveryOf(f, key, sessionId));
}

// Background sessions of the stateful fake CLI on one link whose newest message is new.
async function watchStepFixture(t, sessionOptions) {
  const f = await watchFixture(t, { http: true, sessions: 'real' });
  for (const [sessionId, options] of Object.entries(sessionOptions)) f.cli.add(sessionId, options);
  const key = await watchWithNewMessage(f, Object.keys(sessionOptions));
  return { f, key };
}

test('next check: state is null before start and the armed poll time once started', async (t) => {
  const f = await watchFixture(t, { http: true });
  assert.equal(await nextCheckAtOf(f), null, 'nothing is armed before start');

  await f.watcher.start();
  assert.equal(await nextCheckAtOf(f), isoAt(POLL_INTERVAL_MS));
  assertNoSlackReads(f);
});

test('next check: state is null while a poll is running and armed again once it ends', async (t) => {
  const f = await watchFixture(t, { http: true });
  await watchWithNewMessage(f, [SESSION_A]);
  await f.watcher.start();
  const hold = f.fakeReader.hold();

  const polling = f.timers.advance(POLL_INTERVAL_MS);
  await flush();
  assert.equal(f.fakeReader.inFlight, 1, 'the timed poll is reading');
  assert.equal(await nextCheckAtOf(f), null, 'no next check while the poll runs');

  hold.release();
  await polling;
  assert.equal(await nextCheckAtOf(f), isoAt(2 * POLL_INTERVAL_MS));
});

test('next check: state is null while paused and while disabled', async (t) => {
  const paused = await watchFixture(t, { http: true });
  await paused.watcher.start();
  assert.equal(await nextCheckAtOf(paused), isoAt(POLL_INTERVAL_MS), 'armed while running');
  assert.equal((await post(paused, 'pause')).json().state, 'paused');
  assert.equal(await nextCheckAtOf(paused), null, 'no next check while paused');

  const disabled = await watchFixture(t, { http: true });
  await disabled.watcher.start();
  assert.equal(await nextCheckAtOf(disabled), isoAt(POLL_INTERVAL_MS), 'armed while readable');
  disabled.claudeHome.readable = false;
  assert.equal((await listOf(disabled)).state, 'disabled');
  assert.equal(await nextCheckAtOf(disabled), null, 'no next check while disabled');
});

test('wake step: a woken session reports step 1 of 3, then 2 of 3, then 3 of 3 with the next step time', async (t) => {
  const { f, key } = await watchStepFixture(t, { [SESSION_A]: {} });
  assert.equal(await deliveryOf(f, key, SESSION_A), null, 'no delivery before the first poll');

  await f.tick();
  assert.deepEqual(await stepViewOf(f, key, SESSION_A), {
    status: 'waiting',
    reason: 'awaiting_wake',
    step: 1,
    steps: 3,
    nextStepAt: isoAt(STOP_AFTER_LINE_MS),
  });

  f.clock.advance(STOP_AFTER_LINE_MS);
  await f.tick();
  assert.deepEqual(await stepViewOf(f, key, SESSION_A), {
    status: 'waiting',
    reason: 'settling',
    step: 2,
    steps: 3,
    nextStepAt: isoAt(STOP_AFTER_LINE_MS + RESUME_AFTER_STOP_MS),
  });

  f.clock.advance(RESUME_AFTER_STOP_MS);
  await f.tick();
  assert.deepEqual(await stepViewOf(f, key, SESSION_A), {
    status: 'delivered',
    reason: 'resumed',
    step: 3,
    steps: 3,
    nextStepAt: null,
  });
});

test('wake step: a session that woke itself, an inbox-only session and a session with no delivery carry no step', async (t) => {
  const { f, key } = await watchStepFixture(t, {
    [SESSION_B]: { kind: 'interactive', status: 'idle' },
    [SESSION_C]: {},
  });
  const quietKey = await f.watch({
    threadTs: SECOND_THREAD_TS,
    sessionIds: [SESSION_D],
    messages: [{ ts: SECOND_THREAD_TS, user: OTHER }],
  });

  await f.tick();
  assert.deepEqual(await stepViewOf(f, key, SESSION_B), {
    status: 'delivered',
    reason: 'inbox_only',
    ...NO_STEP,
  });
  assert.equal(await deliveryOf(f, quietKey, SESSION_D), null, 'nothing was owed to this session');

  f.cli.setStatus(SESSION_C, 'busy');
  f.clock.advance(1_000);
  await f.tick();
  assert.deepEqual(await stepViewOf(f, key, SESSION_C), {
    status: 'delivered',
    reason: 'woke_itself',
    ...NO_STEP,
  });
  assert.equal((await stepViewOf(f, key, SESSION_B)).step, null, 'still no step');
  assert.equal(await deliveryOf(f, quietKey, SESSION_D), null);
});

test('wake step: a failed delivery carries no step', async (t) => {
  const { f, key } = await watchStepFixture(t, { [SESSION_A]: {} });
  f.cli.failNext('listing', { exitCode: 1, stderr: 'listing refused' });

  await f.tick();
  assert.deepEqual(await stepViewOf(f, key, SESSION_A), {
    status: 'failed-transient',
    reason: 'listing_unavailable',
    ...NO_STEP,
  });
});

test('force check: the route runs one poll now, answers checked true and restarts the poll countdown', async (t) => {
  const f = await watchFixture(t, { http: true });
  await f.watcher.start();
  const key = await watchWithNewMessage(f, [SESSION_A]);
  f.clock.advance(PARTWAY_MS);

  const res = await post(f, 'check');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json(), { ok: true, state: 'running', checked: true });
  assert.equal(f.fakeReader.calls.length, 1, 'one poll read the thread once');
  assert.deepEqual(f.inboxLines(SESSION_A), [
    DEFAULT_TEMPLATE.replace('{link}', f.entry(key).link),
  ]);
  assert.equal(
    await nextCheckAtOf(f),
    isoAt(PARTWAY_MS + POLL_INTERVAL_MS),
    'restarted at the check',
  );

  await f.timers.advance(POLL_INTERVAL_MS - 1);
  assert.equal(
    f.fakeReader.calls.length,
    1,
    'no poll one millisecond before the new countdown ends',
  );
  await f.timers.advance(1);
  assert.equal(f.fakeReader.calls.length, 2, 'one timed poll at the end of the new countdown');
});

test('force check: a poll that is already running is not doubled and the route answers checked false', async (t) => {
  const f = await watchFixture(t, { http: true });
  await watchWithNewMessage(f, [SESSION_A]);
  const hold = f.fakeReader.hold();
  const running = f.tick();
  await flush();
  assert.equal(f.fakeReader.inFlight, 1, 'a poll is reading');

  const requestLanded = once(f.http.server, 'request');
  const answered = post(f, 'check');
  await requestLanded;
  await flush();
  hold.release();
  const [res] = await Promise.all([answered, running]);

  assert.equal(res.status, 200);
  assert.deepEqual(res.json(), { ok: true, state: 'running', checked: false });
  assert.equal(f.fakeReader.calls.length, 1, 'the running poll was the only read');
  assert.equal(f.fakeReader.maxInFlight, 1);
  assert.equal(f.inboxLines(SESSION_A).length, 1, 'one notice line');
});

test('force check: the route reads nothing and answers a fixed failure while paused and while disabled', async (t) => {
  const paused = await watchFixture(t, { http: true, paused: true });
  await watchWithNewMessage(paused, [SESSION_A]);
  const pausedBefore = await stateOf(paused);
  const pausedRes = await post(paused, 'check');
  assert.notEqual(pausedRes.status, 404, 'the route exists');
  assert.ok(
    pausedRes.status >= 400 && pausedRes.status < 500,
    `a client failure: ${pausedRes.status}`,
  );
  const pausedBody = pausedRes.json();
  assert.match(String(pausedBody.code), FIXED_CODE, 'a fixed code names the state');
  assert.notEqual(pausedBody.code, 'OPERATION_FAILED');
  assert.notEqual(pausedBody.code, 'WATCH_DISABLED');
  assert.deepEqual(Object.keys(pausedBody).sort(), REFUSAL_KEYS);
  assert.equal(paused.fakeReader.calls.length, 0, 'a paused check reads nothing from Slack');
  assert.deepEqual(paused.inboxLines(SESSION_A), []);
  assert.deepEqual(await stateOf(paused), pausedBefore, 'a paused check changes nothing');

  const disabled = await watchFixture(t, { http: true, claudeHome: false });
  await watchWithNewMessage(disabled, [SESSION_A]);
  const disabledBefore = await stateOf(disabled);
  const disabledRes = await post(disabled, 'check');
  assert.equal(disabledRes.status, 409);
  assert.equal(disabledRes.json().code, 'WATCH_DISABLED');
  assert.deepEqual(Object.keys(disabledRes.json()).sort(), REFUSAL_KEYS);
  assert.equal(disabled.fakeReader.calls.length, 0, 'a disabled check reads nothing from Slack');
  assert.deepEqual(disabled.inboxLines(SESSION_A), []);
  assert.deepEqual(await stateOf(disabled), disabledBefore, 'a disabled check changes nothing');
});

test('force check: the route keeps the trust checks of its neighbours and answers without setup', async (t) => {
  const f = await watchFixture(t, { http: true });
  await watchWithNewMessage(f, [SESSION_A]);
  const refusals = [
    [{ origin: 'http://evil.example' }, 403],
    [{ 'sec-fetch-site': 'cross-site' }, 403],
    [{ host: `evil.example:${f.http.port}` }, 403],
    [{ 'content-type': 'text/plain' }, 415],
  ];
  for (const [headers, status] of refusals) {
    const res = await f.http.raw('POST', `${WATCH}/check`, { headers });
    assert.equal(res.status, status, `${JSON.stringify(headers)}: status`);
  }
  assert.equal(f.fakeReader.calls.length, 0, 'a refused request polls nothing');
  assert.deepEqual(f.inboxLines(SESSION_A), []);

  const headerless = await f.http.bare('POST', `${WATCH}/check`);
  assert.equal(headerless.status, 200);
  assert.deepEqual(headerless.json(), { ok: true, state: 'running', checked: true });
  const sameOrigin = await f.http.raw('POST', `${WATCH}/check`, {
    headers: { origin: f.http.base, 'content-type': 'application/json' },
  });
  assert.equal(sameOrigin.status, 200);
  assert.equal(sameOrigin.json().checked, true);

  const unready = await watchFixture(t, { http: true, setupAccepted: false });
  const unreadyRes = await unready.http.json('POST', `${WATCH}/check`);
  assert.equal(unreadyRes.status, 200);
  assert.notEqual(unreadyRes.json().code, 'SETUP_REQUIRED');
  assert.equal(unreadyRes.json().ok, true);
});
