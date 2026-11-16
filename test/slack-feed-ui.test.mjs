import test from 'node:test';
import assert from 'node:assert/strict';

// The pure browser-side helpers of the Slack activity drawer (plan items 9 and 7): the pending
// poll's delay in ui/polling.js and the feed helpers in ui/slack-feed.js. Both are loaded inside
// each test, so a missing export or module fails that test alone, with its own reason.
const polling = await import('../ui/polling.js');
const feedHelpers = () => import('../ui/slack-feed.js');

// Synthetic rows: only the fields a helper reads.
const row = (id, unread) => ({ id, unread });

test('pendingDelay: a minute while Slack answers, five minutes while it is unavailable', () => {
  assert.equal(polling.SLACK_POLL_MS, 60_000, 'the available cadence is unchanged');
  assert.equal(polling.SLACK_IDLE_POLL_MS, 5 * 60_000);
  assert.equal(polling.pendingDelay({ available: true }), 60_000);
  assert.equal(polling.pendingDelay({ available: true, activityMentions: 4 }), 60_000);
  assert.equal(polling.pendingDelay({ available: false }), 300_000);
  // Nothing read yet (the first load is still out) and a degraded answer both count as unavailable.
  assert.equal(polling.pendingDelay(null), 300_000);
  assert.equal(polling.pendingDelay(undefined), 300_000);
  assert.equal(polling.pendingDelay({}), 300_000);
});

test('a failed pending fetch retries at the normal pace; only the server saying unavailable backs off', async (t) => {
  const { getSlackPending } = await import('../ui-react/lib/api.js');
  const answer = async (fake) => {
    t.mock.method(globalThis, 'fetch', fake);
    const reply = await getSlackPending();
    t.mock.restoreAll();
    return reply;
  };
  const rejected = await answer(async () => Promise.reject(new Error('down')));
  const status500 = await answer(async () => ({ ok: false }));
  const served = await answer(async () => ({ ok: true, json: async () => ({ available: false }) }));
  assert.equal(polling.pendingDelay(rejected), 60_000);
  assert.equal(polling.pendingDelay(status500), 60_000);
  assert.equal(polling.pendingDelay(served), 300_000);
});

test('FEED_TABS: Mentions first, then Threads, then Reactions, with their test ids', async () => {
  const { FEED_TABS } = await feedHelpers();
  assert.deepEqual(
    FEED_TABS.map((tab) => [tab.id, tab.label]),
    [
      ['mentions', 'Mentions'],
      ['threads', 'Threads'],
      ['reactions', 'Reactions'],
    ],
  );
  for (const tab of FEED_TABS)
    assert.equal(tab.testId, `slack-feed-view-${tab.id}`, `${tab.id} keeps its test id`);
});

test('tabCounts: unread rows per tab, never the number of rows', async () => {
  const { tabCounts } = await feedHelpers();
  const feed = {
    available: true,
    mentions: [row('m1', true), row('m2', false), row('m3', true)],
    threads: [row('t1', false)],
    reactions: [],
  };
  assert.deepEqual(tabCounts(feed), { mentions: 2, threads: 0, reactions: 0 });
  assert.deepEqual(tabCounts({ ...feed, threads: [row('t1', true), row('t2', true)] }), {
    mentions: 2,
    threads: 2,
    reactions: 0,
  });
});

test('unreadFirst: unread rows lead, each group keeps its newest-first order', async () => {
  const { unreadFirst } = await feedHelpers();
  const rows = [row('a', false), row('b', true), row('c', false), row('d', true)];
  assert.deepEqual(
    unreadFirst(rows).map((r) => r.id),
    ['b', 'd', 'a', 'c'],
  );
  assert.deepEqual(
    rows.map((r) => r.id),
    ['a', 'b', 'c', 'd'],
    'the input is not mutated',
  );
});

test('channelLabel: #name for a channel, the plain name for a DM or group, a calm word when unknown', async () => {
  const { channelLabel } = await feedHelpers();
  assert.equal(channelLabel({ name: 'example-channel', type: 'channel' }), '#example-channel');
  assert.equal(channelLabel({ name: 'example-private', type: 'private' }), '#example-private');
  assert.equal(channelLabel({ name: 'Example Person', type: 'dm' }), 'Example Person');
  assert.equal(
    channelLabel({ name: 'Example One, Example Two', type: 'group' }),
    'Example One, Example Two',
  );
  // An unhydrated row has no channel name.
  assert.equal(channelLabel({ name: '', type: 'channel' }), 'Unknown conversation');
  assert.equal(channelLabel(undefined), 'Unknown conversation');
});
