import test from 'node:test';
import assert from 'node:assert/strict';
import { withAttachedSessions } from '../backend/slack-model.mjs';
import { deepFreeze } from '../e2e/deep-freeze.mjs';
import {
  CHANNEL,
  SESSION_A,
  SESSION_B,
  THREAD_TS,
  threadKey,
  tsAt,
  watchFixture,
} from './slack-watch-fixture.mjs';

const SECOND_TS = tsAt(-400, 200);
const THIRD_TS = tsAt(-800, 300);
const FOURTH_TS = tsAt(-1200, 400);
const OTHER_CHANNEL = 'C0OTHER0001';
const TEAM = 'T0EXAMPLE1';

const person = { id: 'U_OTHER', name: 'Colleague' };
const rowOf = (ts, { channelId = CHANNEL, ...extra } = {}) => ({
  ts,
  url: `https://app.slack.com/client/${TEAM}/${channelId}/thread/${channelId}-${ts}`,
  watchKey: threadKey(channelId, ts),
  text: `TAP-1: Invented subject for ${ts}`,
  author: person,
  starter: person,
  replyCount: 2,
  activityAt: '2026-10-31T09:00:00.000Z',
  latestReplyBy: person,
  needsReply: false,
  ...extra,
});
const entryOf = (ts, sessionIds, channelId = CHANNEL) => ({
  key: threadKey(channelId, ts),
  link: `https://example.slack.com/archives/${channelId}/p${ts.replace('.', '')}`,
  channelId,
  threadTs: ts,
  sessionIds,
});
const linksOf = (...entries) => Object.fromEntries(entries.map((entry) => [entry.key, entry]));
const resultOf = (started, mentions = []) => ({
  available: true,
  channel: { id: CHANNEL, name: 'example_channel' },
  started,
  mentions,
  updatedAt: '2026-10-31T09:00:00.000Z',
  enriched: true,
});
const counts = (rows) => rows.map((row) => row.attachedSessions);

// -- withAttachedSessions annotates each thread row with how many sessions are attached --------------

test('withAttachedSessions gives each row the number of sessions attached under its watch key', () => {
  const links = linksOf(
    entryOf(THREAD_TS, []),
    entryOf(SECOND_TS, [SESSION_A]),
    entryOf(THIRD_TS, [SESSION_A, SESSION_B]),
  );
  const result = resultOf([
    rowOf(THREAD_TS),
    rowOf(SECOND_TS),
    rowOf(THIRD_TS),
    rowOf(FOURTH_TS),
    rowOf(FOURTH_TS, { watchKey: '' }),
  ]);
  const noKey = rowOf(FOURTH_TS);
  delete noKey.watchKey;
  result.started.push(noKey);
  const answered = withAttachedSessions(result, links);
  assert.deepEqual(
    counts(answered.started),
    [0, 1, 2, 0, 0, 0],
    'none attached, one, two, a watched-by-nobody thread, an empty watch key, no watch key',
  );
});

test('withAttachedSessions annotates the started list only and passes the mentions list through as it was', () => {
  const links = linksOf(
    entryOf(THREAD_TS, [SESSION_A]),
    entryOf(SECOND_TS, [SESSION_A, SESSION_B]),
  );
  const mentions = [rowOf(SECOND_TS), rowOf(THREAD_TS), rowOf(THIRD_TS)];
  const answered = withAttachedSessions(resultOf([rowOf(THREAD_TS)], mentions), links);
  assert.deepEqual(counts(answered.started), [1]);
  assert.deepEqual(answered.mentions, mentions, 'the mentions rows carry no count');
  assert.ok(answered.mentions.every((row) => !('attachedSessions' in row)));
});

test('withAttachedSessions matches the whole key: the same timestamp in another channel is another thread', () => {
  const links = linksOf(entryOf(THREAD_TS, [SESSION_A], OTHER_CHANNEL));
  const answered = withAttachedSessions(
    resultOf([rowOf(THREAD_TS), rowOf(THREAD_TS, { channelId: OTHER_CHANNEL })]),
    links,
  );
  assert.deepEqual(counts(answered.started), [0, 1]);
});

test('withAttachedSessions keeps every other field and leaves its input and the links alone', () => {
  const rows = [rowOf(THREAD_TS), rowOf(SECOND_TS, { needsReply: true, replyCount: 4 })];
  const links = linksOf(
    entryOf(THREAD_TS, [SESSION_A]),
    entryOf(SECOND_TS, [SESSION_A, SESSION_B]),
  );
  const input = deepFreeze(resultOf(rows, [rowOf(THREAD_TS)]));
  const linksBefore = structuredClone(links);
  const answered = withAttachedSessions(input, deepFreeze(links));

  assert.deepEqual(input, resultOf(rows, [rowOf(THREAD_TS)]), 'the input is not touched');
  assert.deepEqual(links, linksBefore, 'the links are not touched');
  assert.deepEqual(
    { ...answered, started: undefined },
    { ...input, started: undefined },
    'the top-level fields and the mentions list come through as they were',
  );
  assert.deepEqual(answered.started, [
    { ...rows[0], attachedSessions: 1 },
    { ...rows[1], attachedSessions: 2 },
  ]);
  assert.notEqual(answered, input);
  assert.notEqual(answered.started, input.started);
  answered.started.forEach((row, index) => assert.notEqual(row, input.started[index]));
  assert.ok(
    !JSON.stringify(answered).includes(SESSION_A),
    'a row carries the count only, never a session id',
  );
});

test('withAttachedSessions passes an unavailable result through', () => {
  const links = linksOf(entryOf(THREAD_TS, [SESSION_A]));
  assert.deepEqual(withAttachedSessions({ available: false }, links), { available: false });
  assert.deepEqual(withAttachedSessions({ available: false }, {}), { available: false });
});

test('withAttachedSessions answers 0 for every row when there is no watch list to read', () => {
  for (const links of [{}, undefined, null]) {
    const answered = withAttachedSessions(resultOf([rowOf(THREAD_TS), rowOf(SECOND_TS)]), links);
    assert.deepEqual(counts(answered.started), [0, 0], String(links));
  }
});

test('withAttachedSessions counts a key as its own entry only, never an inherited property or a malformed entry', () => {
  const links = {
    [threadKey(CHANNEL, THREAD_TS)]: { key: threadKey(CHANNEL, THREAD_TS) },
    [threadKey(CHANNEL, SECOND_TS)]: { sessionIds: 'not a list' },
  };
  const rows = ['constructor', 'toString', '__proto__', 'hasOwnProperty'].map((watchKey) =>
    rowOf(THREAD_TS, { watchKey }),
  );
  const answered = withAttachedSessions(
    resultOf([...rows, rowOf(THREAD_TS), rowOf(SECOND_TS)]),
    links,
  );
  assert.deepEqual(counts(answered.started), [0, 0, 0, 0, 0, 0]);
  assert.ok(answered.started.every((row) => Number.isInteger(row.attachedSessions)));
});

// -- GET /api/slack/threads annotates through a real handler and never fails ------------------------

const THREADS = '/api/slack/threads';

// The watch fixture serves the real handler over the real watch store and watcher. Its Slack reader
// only knows how to read one thread, so it is given the listing the route asks it for.
async function routeFixture(t, options = {}) {
  const f = await watchFixture(t, { http: true, ...options });
  const listing = resultOf(
    [rowOf(THREAD_TS), rowOf(SECOND_TS), rowOf(THIRD_TS), rowOf(FOURTH_TS)],
    [rowOf(THREAD_TS), rowOf(THIRD_TS)],
  );
  f.slack.threads = async () => listing;
  return { f, listing, original: structuredClone(listing) };
}
const getThreads = (f) => f.http.bare('GET', THREADS);
const startedCounts = async (f) => {
  const res = await getThreads(f);
  assert.equal(res.status, 200, 'GET /api/slack/threads answers 200');
  return counts(res.json().started);
};

test('GET /api/slack/threads gives each row the sessions attached to its thread, from the watch store', async (t) => {
  const { f, listing, original } = await routeFixture(t);
  await f.watch({ threadTs: THREAD_TS, sessionIds: [SESSION_A] });
  await f.watch({ threadTs: SECOND_TS, sessionIds: [SESSION_A, SESSION_B] });
  await f.watch({ threadTs: THIRD_TS, sessionIds: [] });

  const res = await getThreads(f);
  assert.equal(res.status, 200);
  const body = res.json();
  assert.deepEqual(
    counts(body.started),
    [1, 2, 0, 0],
    'attached, two attached, watched by none, not watched',
  );
  assert.deepEqual(body.mentions, original.mentions, 'the mentions list comes through as it was');
  body.started.forEach((row, index) => {
    const rest = { ...row };
    delete rest.attachedSessions;
    assert.deepEqual(rest, original.started[index], 'every other field comes through');
  });
  assert.equal(body.available, true);
  assert.deepEqual(body.channel, original.channel);
  assert.ok(
    !res.text.includes(SESSION_A) && !res.text.includes(SESSION_B),
    'the count only, never a session id',
  );
  assert.deepEqual(
    listing,
    original,
    'the listing the Slack integration hands out (its cache) is not mutated',
  );
});

test('GET /api/slack/threads reads the watch store on every request, so an attach and a detach show at once', async (t) => {
  const { f } = await routeFixture(t);
  assert.deepEqual(await startedCounts(f), [0, 0, 0, 0]);
  const key = await f.watch({ threadTs: THREAD_TS, sessionIds: [SESSION_A] });
  assert.deepEqual(await startedCounts(f), [1, 0, 0, 0]);
  await f.store.attach(key, SESSION_B);
  assert.deepEqual(await startedCounts(f), [2, 0, 0, 0]);
  await f.store.detach(key, SESSION_A);
  await f.store.detach(key, SESSION_B);
  assert.deepEqual(await startedCounts(f), [0, 0, 0, 0]);
});

test('GET /api/slack/threads answers 0 on every row while the watcher is disabled, still with 200', async (t) => {
  const { f } = await routeFixture(t, { claudeHome: false });
  await f.watch({ threadTs: THREAD_TS, sessionIds: [SESSION_A] });
  assert.equal(
    f.watcher.isDisabled(),
    true,
    'the watcher is disabled without a readable Claude home',
  );
  const res = await getThreads(f);
  assert.equal(res.status, 200);
  const body = res.json();
  assert.deepEqual(counts(body.started), [0, 0, 0, 0]);
});

test('GET /api/slack/threads answers 0 on every row, still with 200, when the watch store cannot be read', async (t) => {
  const { f } = await routeFixture(t);
  await f.watch({ threadTs: THREAD_TS, sessionIds: [SESSION_A] });
  assert.deepEqual(
    await startedCounts(f),
    [1, 0, 0, 0],
    'the attachment is real before the store fails',
  );
  t.mock.method(f.store, 'snapshot', () => {
    throw new Error('map unreadable /home/example/secret-path');
  });
  const res = await getThreads(f);
  assert.equal(res.status, 200, 'a failing store never fails the route');
  const body = res.json();
  assert.deepEqual(counts(body.started), [0, 0, 0, 0]);
  assert.ok(
    !res.text.includes('map unreadable') && !res.text.includes('secret-path'),
    'no error text',
  );
});

test('GET /api/slack/threads annotates outside the setup gate and passes an unavailable Slack through', async (t) => {
  const { f } = await routeFixture(t, { setupAccepted: false });
  const res = await getThreads(f);
  assert.equal(res.status, 200, 'the route is outside the GitHub and Jira setup gate');
  assert.deepEqual(counts(res.json().started), [0, 0, 0, 0], 'and still annotated');

  f.slack.threads = async () => ({ available: false });
  const down = await getThreads(f);
  assert.equal(down.status, 200);
  assert.deepEqual(down.json(), { available: false });
});
