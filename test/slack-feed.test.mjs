// slack-feed.test.mjs — the Slack Activity feed behind the edge drawer (backend/slack-feed.mjs): the
// pure split and dedupe of one activity page, and the integration's `feed()` over a scripted Slack:
// hydration, its call budget and priority, rate limits, the calm degrade and a session change
// mid-read. Synthetic ids, names and text only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { slackTimestamp, threadLinkFields } from '../backend/slack-model.mjs';
import { deferred, flush } from './slack-watch-fixture.mjs';
import {
  ALEX,
  ME,
  SAM,
  TEAM,
  connectedFeed,
  mentionItem,
  reactionItem,
  threadItem,
  tsOf,
} from './slack-feed-fixture.mjs';

const ROOM = 'C0EXAMPLE1';
const OTHER_ROOM = 'C0EXAMPLE2';
// Loaded per test, so a missing module fails each pure case and never hides the rest of the file.
const loadFeed = () => import('../backend/slack-feed.mjs');
const FEED_TYPES = 'at_user,at_channel,keyword,thread_v2,message_reaction';

test('mention kinds land in mentions, once per message', async () => {
  const { feedRows } = await loadFeed();
  const split = feedRows([
    mentionItem({ key: 'k-user', channel: ROOM, ts: tsOf(10) }),
    mentionItem({ key: 'k-word', type: 'keyword', channel: ROOM, ts: tsOf(10), unread: true }),
    mentionItem({ key: 'k-chan', type: 'at_channel', channel: ROOM, ts: tsOf(20) }),
  ]);
  assert.equal(split.mentions.length, 2, 'two messages, so two rows');
  const [shared, broadcast] = split.mentions;
  assert.equal(shared.kind, 'mention', 'the first kind in feed order wins');
  assert.equal(shared.unread, true, 'unread when any item of the message is');
  assert.equal(broadcast.kind, 'channel');
  assert.equal(broadcast.unread, false);
  assert.deepEqual(split.threads, []);
  assert.deepEqual(split.reactions, []);
});

test('dedupe: a mention that is a thread newest reply shows once, under mentions', async () => {
  const { feedRows } = await loadFeed();
  const split = feedRows([
    mentionItem({ key: 'k-mention', channel: ROOM, ts: tsOf(30), threadTs: tsOf(5) }),
    threadItem({ key: 'k-same', channel: ROOM, threadTs: tsOf(5), latestTs: tsOf(30) }),
    threadItem({ key: 'k-newer', channel: ROOM, threadTs: tsOf(5), latestTs: tsOf(40) }),
  ]);
  assert.deepEqual(
    split.mentions.map((row) => row.id),
    ['k-mention'],
  );
  assert.deepEqual(
    split.threads.map((row) => row.id),
    ['k-newer'],
    'only the thread whose newest reply is another message stays',
  );
});

test('dedupe keeps a reaction on a message that is also a mention', async () => {
  const { feedRows } = await loadFeed();
  const split = feedRows([
    mentionItem({ key: 'k-mention', channel: ROOM, ts: tsOf(30) }),
    reactionItem({ key: 'k-react', channel: ROOM, ts: tsOf(30) }),
  ]);
  assert.equal(split.mentions.length, 1);
  assert.deepEqual(
    split.reactions.map((row) => row.id),
    ['k-react'],
  );
});

test('mentionUnread sums mention types only and counts a non-number as zero', async () => {
  const { mentionUnread } = await loadFeed();
  assert.equal(
    mentionUnread({ at_user: 2, at_channel: 1, keyword: 1, thread_v2: 7, message_reaction: 4 }),
    4,
  );
  assert.equal(mentionUnread({ at_user: '2', at_channel: null, keyword: 3 }), 3);
  assert.equal(mentionUnread(undefined), 0);
});

function threadsAndReactionsFeed() {
  const parentTs = tsOf(100);
  const latestTs = tsOf(160);
  const reacted = tsOf(120);
  return {
    parentTs,
    latestTs,
    reacted,
    items: [
      threadItem({
        key: 'k-thread',
        channel: ROOM,
        threadTs: parentTs,
        latestTs,
        unreadCount: 3,
      }),
      reactionItem({
        key: 'k-react',
        channel: OTHER_ROOM,
        ts: reacted,
        feedTs: tsOf(130),
        by: ALEX,
        name: 'eyes',
      }),
    ],
    messages: {
      [`${ROOM}:${parentTs}`]: { ts: parentTs, user: SAM, text: 'Parent topic text' },
      [`${ROOM}:${latestTs}`]: {
        ts: latestTs,
        thread_ts: parentTs,
        user: ALEX,
        text: 'Latest reply text',
      },
      [`${OTHER_ROOM}:${reacted}`]: { ts: reacted, user: ME, text: 'My own message' },
    },
    channels: { [ROOM]: { id: ROOM, name: 'general-example', is_private: false } },
  };
}

test('threads and reactions: a thread row carries replies and text, a reaction row its reaction', async (t) => {
  const feed = threadsAndReactionsFeed();
  const { slack, integration, writeSession } = connectedFeed(t, feed);
  writeSession();

  const result = await integration.feed();

  assert.equal(result.available, true);
  assert.deepEqual(result.partial, []);
  assert.deepEqual(result.mentions, []);
  const [thread] = result.threads;
  assert.equal(thread.kind, 'thread');
  assert.equal(thread.replies, 3);
  assert.equal(thread.parentText, 'Parent topic text');
  assert.equal(thread.text, 'Latest reply text');
  assert.equal(thread.author, 'Alex Example');
  assert.equal(thread.hydrated, true);
  assert.deepEqual(thread.channel, { name: 'general-example', type: 'channel' });
  assert.equal(thread.at, slackTimestamp(feed.latestTs));
  assert.equal(
    thread.url,
    threadLinkFields({ teamId: TEAM, channelId: ROOM, ts: feed.parentTs }).url,
  );
  assert.match(thread.url, /^https:\/\/app\.slack\.com\/client\//);

  const [reaction] = result.reactions;
  assert.equal(reaction.kind, 'reaction');
  assert.deepEqual(reaction.reaction, { by: 'Alex Example', name: 'eyes' });
  assert.equal(reaction.author, 'You', 'the reacted message is the signed-in user');
  assert.equal(reaction.text, 'My own message');
  assert.match(reaction.url, /^https:\/\/app\.slack\.com\/client\//);
  assert.ok(!slack.methods().includes('conversations.history'), 'history never hydrates');
});

test('threads and reactions: one chrono activity.feed page of 30, replies asked per message kind', async (t) => {
  const feed = threadsAndReactionsFeed();
  const mentionTs = tsOf(170);
  feed.items.push(mentionItem({ key: 'k-mention', channel: ROOM, ts: mentionTs }));
  feed.messages[`${ROOM}:${mentionTs}`] = { ts: mentionTs, user: SAM, text: 'A mention' };
  const { slack, integration, writeSession } = connectedFeed(t, feed);
  writeSession();

  await integration.feed();

  assert.deepEqual(slack.paramsOf('activity.feed'), [
    { types: FEED_TYPES, mode: 'chrono_reads_and_unreads', limit: '30' },
  ]);
  const replies = slack.paramsOf('conversations.replies');
  assert.deepEqual(
    replies.find((params) => params.oldest),
    {
      channel: ROOM,
      ts: feed.parentTs,
      oldest: feed.latestTs,
      inclusive: 'true',
      limit: '2',
    },
  );
  assert.deepEqual(
    replies.find((params) => params.ts === mentionTs),
    { channel: ROOM, ts: mentionTs, inclusive: 'true', limit: '1' },
  );
});

test('feed reply carries names and text, never a user or channel id outside the url', async (t) => {
  const feed = threadsAndReactionsFeed();
  const { integration, writeSession } = connectedFeed(t, feed);
  writeSession();

  const result = await integration.feed();
  const rows = [...result.mentions, ...result.threads, ...result.reactions];
  assert.equal(rows.length, 2);
  const withoutUrls = JSON.stringify(rows.map(({ url: _url, ...row }) => row));
  for (const id of [ROOM, OTHER_ROOM, ME, ALEX, SAM])
    assert.ok(!withoutUrls.includes(id), `${id} must not reach the browser`);
});

// 30 distinct messages in 12 channels: 10 threads, then 10 reactions, then the 10 mentions, in feed
// order (newest first). Mentions sit in 5 channels, threads in the first 10, reactions reach all 12.
function budgetFeed() {
  const rooms = Array.from({ length: 12 }, (_, i) => `C0BUDGET${String(i + 1).padStart(2, '0')}`);
  const items = [];
  const messages = {};
  let clock = 1000;
  const next = () => (clock -= 1);
  for (let i = 0; i < 10; i++) {
    const channel = rooms[i % 12];
    const threadTs = tsOf(next());
    const latestTs = tsOf(next());
    items.push(threadItem({ key: `thread-${i}`, channel, threadTs, latestTs }));
    messages[`${channel}:${threadTs}`] = { ts: threadTs, user: SAM, text: `parent ${i}` };
    messages[`${channel}:${latestTs}`] = { ts: latestTs, user: ALEX, text: `reply ${i}` };
  }
  for (let i = 0; i < 10; i++) {
    const channel = rooms[(i + 2) % 12];
    const ts = tsOf(next());
    items.push(reactionItem({ key: `reaction-${i}`, channel, ts }));
    messages[`${channel}:${ts}`] = { ts, user: ME, text: `reacted ${i}` };
  }
  for (let i = 0; i < 10; i++) {
    const channel = rooms[i % 5];
    const ts = tsOf(next());
    items.push(mentionItem({ key: `mention-${i}`, channel, ts, unread: true }));
    messages[`${channel}:${ts}`] = { ts, user: ALEX, text: `mention ${i}` };
  }
  return { items, messages };
}

test('hydration budget: 24 replies and 10 infos at most, mentions first, a warm read costs only the rest', async (t) => {
  const { slack, integration, writeSession } = connectedFeed(t, budgetFeed());
  writeSession();

  const cold = await integration.feed();

  assert.equal(slack.count('activity.feed'), 1);
  assert.ok(slack.count('conversations.replies') <= 24, 'replies are capped at 24');
  assert.ok(slack.count('conversations.info') <= 10, 'infos are capped at 10');
  assert.ok(cold.partial.includes('budget'));
  assert.equal(cold.available, true);
  assert.equal(cold.mentions.length, 10);
  assert.ok(
    cold.mentions.every((row) => row.hydrated),
    'every mention is hydrated first',
  );
  assert.ok(
    cold.threads.every((row) => row.hydrated),
    'threads come next',
  );
  const unhydrated = cold.reactions.filter((row) => !row.hydrated);
  assert.ok(unhydrated.length >= 6, 'the budget leaves the last reactions unread');
  const rows = [...cold.mentions, ...cold.threads, ...cold.reactions];
  assert.ok(
    rows.every((row) => /^https:\/\/app\.slack\.com\/client\//.test(row.url)),
    'an unhydrated row still links',
  );

  const repliesBefore = slack.paramsOf('conversations.replies');
  const infoBefore = slack.count('conversations.info');
  const feedBefore = slack.count('activity.feed');
  const warm = await integration.feed();

  assert.equal(slack.count('activity.feed') - feedBefore, 1);
  const repliesAfter = slack.paramsOf('conversations.replies').slice(repliesBefore.length);
  assert.ok(repliesAfter.length <= unhydrated.length, 'only the rows still missing are read');
  assert.equal(
    repliesAfter.filter((after) =>
      repliesBefore.some((before) => before.channel === after.channel && before.ts === after.ts),
    ).length,
    0,
    'no message is read twice',
  );
  assert.ok(slack.count('conversations.info') - infoBefore <= 2, 'only the 2 missing channels');
  assert.equal(warm.partial.includes('budget'), false);
  assert.ok([...warm.mentions, ...warm.threads, ...warm.reactions].every((row) => row.hydrated));
});

test('rate limit stops hydration, not the page', async (t) => {
  const rooms = ['C0LIMIT01'];
  const items = [];
  const messages = {};
  for (let i = 0; i < 12; i++) {
    const ts = tsOf(2000 - i);
    items.push(mentionItem({ key: `m-${i}`, channel: rooms[0], ts, unread: true }));
    messages[`${rooms[0]}:${ts}`] = { ts, user: ALEX, text: `mention ${i}` };
  }
  const { slack, integration, writeSession } = connectedFeed(t, { items, messages });
  writeSession();
  slack.script(({ method }) => {
    if (method === 'conversations.replies' && slack.count('conversations.replies') === 3)
      return new Response('{}', { status: 429, headers: { 'Retry-After': '30' } });
    return undefined;
  });

  const result = await integration.feed();

  assert.equal(result.available, true);
  assert.ok(result.partial.includes('rate_limited'));
  assert.ok(
    slack.count('conversations.replies') <= 5,
    'no read starts once the limit is known, beyond the pool already in flight',
  );
  const unhydrated = result.mentions.filter((row) => !row.hydrated);
  assert.ok(unhydrated.length >= 7, 'the rest stay unhydrated');
  assert.ok(
    result.mentions.every((row) => row.url.startsWith('https://app.slack.com/client/')),
    'every row still links',
  );
});

test('disconnected: no stored session is calm and asks Slack nothing', async (t) => {
  const { slack, integration } = connectedFeed(t, {});
  assert.deepEqual(await integration.feed(), { available: false, reason: 'disconnected' });
  assert.equal(slack.calls.length, 0);
});

test('disconnected: a session Slack rejects reads no activity', async (t) => {
  const { slack, integration, writeSession } = connectedFeed(t, {});
  writeSession();
  slack.script(({ method }) =>
    method === 'auth.test' ? Response.json({ ok: false, error: 'invalid_auth' }) : undefined,
  );
  assert.deepEqual(await integration.feed(), { available: false, reason: 'disconnected' });
  assert.equal(slack.count('activity.feed'), 0);
});

test('unavailable: an activity.feed that answers ok:false is calm', async (t) => {
  const { slack, integration, writeSession } = connectedFeed(t, {});
  writeSession();
  slack.script(({ method }) =>
    method === 'activity.feed'
      ? Response.json({ ok: false, error: 'invalid_arguments' })
      : undefined,
  );
  assert.deepEqual(await integration.feed(), { available: false, reason: 'unavailable' });
});

test('unavailable: an unreachable activity.feed is calm, never a throw', async (t) => {
  const { slack, integration, writeSession } = connectedFeed(t, {});
  writeSession();
  slack.script(({ method }) =>
    method === 'activity.feed' ? new Response('{}', { status: 502 }) : undefined,
  );
  assert.deepEqual(await integration.feed(), { available: false, reason: 'unavailable' });
});

test('session change mid-read writes nothing back and the next read hydrates again', async (t) => {
  const ts = tsOf(300);
  const messages = { [`${ROOM}:${ts}`]: { ts, user: ALEX, text: 'A mention' } };
  const { slack, integration, writeSession } = connectedFeed(t, {
    items: [mentionItem({ key: 'k-1', channel: ROOM, ts, unread: true })],
    messages,
  });
  writeSession();
  const hold = deferred();
  let held = false;
  slack.script(({ method, params }) => {
    if (method !== 'conversations.replies' || held) return undefined;
    held = true;
    return hold.promise.then(() => slack.answer(method, params));
  });

  const reading = integration.feed();
  await flush();
  integration.disconnect();
  hold.resolve();
  assert.deepEqual(await reading, { available: false, reason: 'unavailable' });

  writeSession();
  const repliesBefore = slack.count('conversations.replies');
  const again = await integration.feed();
  assert.equal(again.available, true);
  assert.ok(
    slack.count('conversations.replies') > repliesBefore,
    'the stale read left no cache behind, so the message is read again',
  );
  assert.equal(again.mentions[0].hydrated, true);
  assert.equal(again.mentions[0].text, 'A mention');
});

test('text never carries an id: an unmapped user or channel mention becomes a word', async (t) => {
  const ts = tsOf(400);
  const parentTs = tsOf(380);
  const latestTs = tsOf(420);
  const { integration, writeSession } = connectedFeed(t, {
    items: [
      mentionItem({ key: 'k-mention', channel: ROOM, ts }),
      threadItem({ key: 'k-thread', channel: ROOM, threadTs: parentTs, latestTs }),
    ],
    messages: {
      [`${ROOM}:${ts}`]: {
        ts,
        user: ALEX,
        text: `hi <@U0UNKNOWN9> and <@${SAM}> see <#C0EXAMPLE7> or <#C0EXAMPLE7|named> <@U0UNKNOWN8|pat> ok`,
      },
      [`${ROOM}:${parentTs}`]: { ts: parentTs, user: SAM, text: 'parent of <@U0UNKNOWN9>' },
      [`${ROOM}:${latestTs}`]: { ts: latestTs, user: ALEX, text: 'reply' },
    },
  });
  writeSession();

  const result = await integration.feed();

  assert.equal(
    result.mentions[0].text,
    'hi @someone and @Sam Sample see #channel or #named @pat ok',
  );
  assert.equal(result.threads[0].parentText, 'parent of @someone');
  const everything = JSON.stringify(result);
  for (const id of ['U0UNKNOWN9', 'U0UNKNOWN8', 'C0EXAMPLE7'])
    assert.ok(!everything.includes(id), `${id} must not reach the browser`);
});

test('text never carries a user group id: markup becomes its label, else @group', async (t) => {
  const ts = tsOf(450);
  const { integration, writeSession } = connectedFeed(t, {
    items: [mentionItem({ key: 'k-group', channel: ROOM, ts })],
    messages: {
      [`${ROOM}:${ts}`]: {
        ts,
        user: ALEX,
        text: 'ping <!subteam^S0EXAMPLE1|@devs> and <!subteam^S0EXAMPLE2> now',
      },
    },
  });
  writeSession();

  const result = await integration.feed();

  assert.equal(result.mentions[0].text, 'ping @devs and @group now');
  const everything = JSON.stringify(result);
  for (const id of ['S0EXAMPLE1', 'S0EXAMPLE2', 'subteam'])
    assert.ok(!everything.includes(id), `${id} must not reach the browser`);
});

test('an unreadable row is not asked again for a minute, and its note clears once a read works', async (t) => {
  const ts = tsOf(500);
  const messages = {};
  let clock = 1_793_201_000_000;
  const { slack, integration, writeSession } = connectedFeed(
    t,
    { items: [mentionItem({ key: 'k-gone', channel: ROOM, ts })], messages },
    () => clock,
  );
  writeSession();

  const first = await integration.feed();
  assert.deepEqual(first.partial, ['unreadable']);
  assert.equal(slack.count('conversations.replies'), 1);

  clock += 30_000;
  const second = await integration.feed();
  assert.deepEqual(
    second.partial,
    ['unreadable'],
    'the row is still not loaded, so the note stays',
  );
  assert.equal(second.mentions[0].hydrated, false);
  assert.equal(slack.count('conversations.replies'), 1, 'no second call inside the minute');

  messages[`${ROOM}:${ts}`] = { ts, user: ALEX, text: 'back again' };
  clock += 31_000;
  const third = await integration.feed();
  assert.equal(slack.count('conversations.replies'), 2, 'asked again once the minute has passed');
  assert.deepEqual(third.partial, [], 'a read that works clears the note');
  assert.equal(third.mentions[0].text, 'back again');
});

test('concurrent reads of one session share one read', async (t) => {
  const ts = tsOf(510);
  const { slack, integration, writeSession } = connectedFeed(t, {
    items: [mentionItem({ key: 'k-1', channel: ROOM, ts })],
    messages: { [`${ROOM}:${ts}`]: { ts, user: ALEX, text: 'one' } },
  });
  writeSession();

  const [a, b] = await Promise.all([integration.feed(), integration.feed()]);

  assert.equal(a, b, 'the same reply object');
  assert.equal(slack.count('activity.feed'), 1);
});

test('the message cache lasts ten minutes', async (t) => {
  const ts = tsOf(520);
  let clock = 1_793_201_000_000;
  const { slack, integration, writeSession } = connectedFeed(
    t,
    {
      items: [mentionItem({ key: 'k-1', channel: ROOM, ts })],
      messages: { [`${ROOM}:${ts}`]: { ts, user: ALEX, text: 'one' } },
    },
    () => clock,
  );
  writeSession();

  await integration.feed();
  clock += 9 * 60_000;
  await integration.feed();
  assert.equal(slack.count('conversations.replies'), 1, 'warm at nine minutes');
  clock += 2 * 60_000;
  await integration.feed();
  assert.equal(slack.count('conversations.replies'), 2, 'read again after ten');
});

test('the message cache keeps the newest 200 entries', async (t) => {
  const items = [];
  const messages = {};
  const batch = (n) => {
    items.length = 0;
    for (let i = 0; i < 24; i++) {
      const ts = tsOf(600 + n * 24 + i);
      items.push(mentionItem({ key: `k-${n}-${i}`, channel: ROOM, ts }));
      messages[`${ROOM}:${ts}`] = { ts, user: ALEX, text: `m ${n}-${i}` };
    }
  };
  const { slack, integration, writeSession } = connectedFeed(t, { items, messages });
  writeSession();
  for (let n = 0; n < 10; n++) {
    batch(n);
    await integration.feed();
  }
  assert.equal(slack.count('conversations.replies'), 240, '240 messages read, 200 kept');

  batch(9);
  await integration.feed();
  assert.equal(slack.count('conversations.replies'), 240, 'the newest batch is still cached');
  batch(0);
  await integration.feed();
  assert.equal(slack.count('conversations.replies'), 264, 'the oldest batch was dropped');
});

test('another account clears the caches, the remembered misses included', async (t) => {
  const ts = tsOf(700);
  const gone = tsOf(701);
  const { slack, integration, writeSession } = connectedFeed(t, {
    items: [
      mentionItem({ key: 'k-ok', channel: ROOM, ts }),
      mentionItem({ key: 'k-gone', channel: ROOM, ts: gone }),
    ],
    messages: { [`${ROOM}:${ts}`]: { ts, user: ALEX, text: 'one' } },
  });
  writeSession();
  await integration.feed();
  assert.equal(slack.count('conversations.replies'), 2);

  writeSession('xoxc-another-account');
  const result = await integration.feed();

  assert.equal(
    slack.count('conversations.replies'),
    4,
    'the message and the miss were asked again',
  );
  assert.equal(result.mentions[0].hydrated, true);
});

test('a rate-limited activity.feed is calm, and the cool-down asks Slack nothing more', async (t) => {
  const { slack, integration, writeSession } = connectedFeed(t, {});
  writeSession();
  slack.script(({ method }) =>
    method === 'activity.feed'
      ? new Response('{}', { status: 429, headers: { 'Retry-After': '30' } })
      : undefined,
  );

  assert.deepEqual(await integration.feed(), { available: false, reason: 'unavailable' });
  assert.equal(slack.count('activity.feed'), 1);
  assert.deepEqual(await integration.feed(), { available: false, reason: 'unavailable' });
  assert.equal(slack.count('activity.feed'), 1, 'no request while the method cools down');
});
