// slack-model.test.mjs — pure shaping rules for the Slack thread lists.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyLastReply,
  buildThread,
  buildThreadMessages,
  cleanText,
  mentionedUserIds,
  person,
  slackTimestamp,
  sortByActivity,
  threadKey,
  threadUrl,
} from '../backend/slack-model.mjs';
import { parseSlackLink } from '../backend/slack-link.mjs';

const users = { U1: 'Patrick Rivera', U2: 'Yuliia Palamarchuk' };

test('mrkdwn becomes plain text with names, labels and decoded entities', () => {
  assert.equal(cleanText('hey <@U1> look', users), 'hey @Patrick Rivera look');
  assert.equal(cleanText('<@U404>', users), '@U404');
  assert.equal(cleanText('see <#C1|general> now'), 'see #general now');
  assert.equal(cleanText('<https://x.dev/a|the doc>'), 'the doc');
  assert.equal(cleanText('<https://x.dev/a>'), 'https://x.dev/a');
  assert.equal(cleanText('ping <!here>'), 'ping @here');
  assert.equal(cleanText('a &amp; b &lt;c&gt;'), 'a & b <c>');
  assert.equal(cleanText('*Sent using* @Claude'), 'Sent using @Claude');
  assert.equal(cleanText('run `npm test` now'), 'run npm test now');
  assert.equal(cleanText('  spaced \n\t text  '), 'spaced text');
  assert.equal(cleanText(null), '');
});

test('Slack epoch strings become ISO timestamps, bad input becomes empty', () => {
  assert.equal(slackTimestamp('1793222863.750299'), '2026-10-28T21:27:43.000Z');
  assert.equal(slackTimestamp(''), '');
  assert.equal(slackTimestamp('abc'), '');
  assert.equal(slackTimestamp(undefined), '');
});

test('a thread link points at the workspace thread, not a guessed permalink', () => {
  assert.equal(
    threadUrl({ teamId: 'T1', channelId: 'C1', ts: '1793222863.750299' }),
    'https://app.slack.com/client/T1/C1/thread/C1-1793222863.750299',
  );
  assert.equal(threadUrl({ teamId: '', channelId: 'C1', ts: '1' }), '');
});

test('people resolve to names, with "You" for the current user', () => {
  assert.deepEqual(person('U1', 'U9', users), { id: 'U1', name: 'Patrick Rivera' });
  assert.deepEqual(person('U9', 'U9', users), { id: 'U9', name: 'You' });
  assert.deepEqual(person('', 'U9', users), { id: '', name: '' });
});

test('messages group by the thread they belong to, not by their own timestamp', () => {
  // A search match: no `thread_ts`, the permalink names the thread.
  assert.equal(
    threadKey({
      ts: '250.0002',
      permalink: 'https://team.slack.com/archives/C1/p2500002?thread_ts=200.0002&cid=C1',
    }),
    '200.0002',
  );
  // An explicit `thread_ts` always wins, even if the permalink disagrees.
  assert.equal(
    threadKey({
      ts: '250.0002',
      thread_ts: '200.0002',
      permalink: 'https://team.slack.com/archives/C1/p2500002?thread_ts=999.0009',
    }),
    '200.0002',
  );
  // A permalink without a thread is a standalone message: its own `ts` is the key.
  assert.equal(
    threadKey({ ts: '500.0005', permalink: 'https://team.slack.com/archives/C1/p5000005' }),
    '500.0005',
  );
  // A malformed permalink must not throw.
  assert.equal(threadKey({ ts: '500.0005', permalink: 'not a url?thread_ts=1' }), '500.0005');
  assert.equal(threadKey({}), '');
  assert.equal(threadKey(null), '');
});

test('a thread root becomes one list entry ordered by its latest activity', () => {
  const thread = buildThread({
    root: {
      ts: '100.0001',
      user: 'U1',
      text: 'TAP-1: hello <@U2>',
      reply_count: 3,
      latest_reply: '200.0002',
    },
    channelId: 'C1',
    teamId: 'T1',
    me: 'U9',
    users,
  });
  assert.equal(thread.ts, '100.0001');
  assert.equal(thread.text, 'TAP-1: hello @Yuliia Palamarchuk');
  assert.equal(thread.author.name, 'Patrick Rivera');
  assert.equal(thread.replyCount, 3);
  assert.equal(thread.activityAt, new Date(200000).toISOString(), 'latest reply drives ordering');
  assert.equal(thread.needsReply, null, 'unknown until replies are read');
});

test('the last message decides whether a reply is owed', () => {
  const thread = buildThread({
    root: { ts: '100.0001', user: 'U9', text: 'mine', reply_count: 2 },
    channelId: 'C1',
    teamId: 'T1',
    me: 'U9',
    users,
  });
  applyLastReply(thread, { user: 'U2', ts: '300.0003' }, 'U9', users);
  assert.equal(thread.latestReplyBy.name, 'Yuliia Palamarchuk');
  assert.equal(thread.needsReply, true);

  applyLastReply(thread, { user: 'U9', ts: '400.0004' }, 'U9', users);
  assert.equal(thread.latestReplyBy.name, 'You');
  assert.equal(thread.needsReply, false);
});

test('sorting is newest activity first and never mutates the input', () => {
  const input = [
    { ts: 'a', activityAt: new Date(1_000).toISOString() },
    { ts: 'b', activityAt: new Date(3_000).toISOString() },
    { ts: 'c', activityAt: '' },
  ];
  assert.deepEqual(
    sortByActivity(input).map((item) => item.ts),
    ['b', 'a', 'c'],
  );
  assert.equal(input[0].ts, 'a');
});

test('only the ids a text actually names are collected, in first-seen order', () => {
  assert.deepEqual(mentionedUserIds(['hey <@U1> and <@U2|Pat>', 'again <@U1>']), ['U1', 'U2']);
  assert.deepEqual(mentionedUserIds(['<@U9>', '<@U1>']), ['U9', 'U1']);
  assert.deepEqual(mentionedUserIds(['no mentions', null, undefined]), []);
  assert.deepEqual(mentionedUserIds([]), []);
  assert.deepEqual(mentionedUserIds(), []);
});

test('a conversation becomes messages with both a plain form and the raw mrkdwn', () => {
  const messages = buildThreadMessages(
    [
      { ts: '100.0001', user: 'U1', text: 'hi <@U9>, see <#C1|general>' },
      { ts: '200.0002', user: 'U9' },
    ],
    { me: 'U9', users: { U1: 'Patrick Rivera', U9: 'You' } },
  );
  assert.equal(messages.length, 2);
  assert.equal(messages[0].ts, '100.0001');
  assert.equal(messages[0].at, new Date(100_000).toISOString());
  assert.deepEqual(messages[0].author, { id: 'U1', name: 'Patrick Rivera' });
  assert.equal(messages[0].text, 'hi @You, see #general');
  assert.equal(messages[0].mrkdwn, 'hi <@U9>, see <#C1|general>', 'the raw text is verbatim');
  assert.deepEqual(messages[1].author, { id: 'U9', name: 'You' });
  assert.equal(messages[1].text, '', 'a message without text is empty, never null');
  assert.equal(messages[1].mrkdwn, '');
  assert.deepEqual(buildThreadMessages(), []);
});

test('another user last message is not mine, the user and a bot message are', async () => {
  const { isNotMine } = await import('../backend/slack-model.mjs');
  assert.equal(isNotMine({ user: 'U1', ts: '100.0001' }, 'U9'), true);
  assert.equal(isNotMine({ user: 'U9', ts: '100.0001' }, 'U9'), false, 'the user own message');
  assert.equal(isNotMine({ ts: '100.0001' }, 'U9'), false, 'a bot message has no user');
  assert.equal(
    isNotMine({ ts: '100.0001', subtype: 'bot_message', bot_id: 'B1' }, 'U9'),
    false,
    'a bot id alone is not a person',
  );
});

test('applyLastReply sets needsReply exactly as the not-mine predicate decides', async () => {
  const { isNotMine } = await import('../backend/slack-model.mjs');
  const cases = [
    { last: { user: 'U2', ts: '300.0003' }, expected: true },
    { last: { user: 'U9', ts: '400.0004' }, expected: false },
    { last: { ts: '500.0005' }, expected: false },
  ];
  for (const { last, expected } of cases) {
    const thread = buildThread({
      root: { ts: '100.0001', user: 'U9', text: 'mine', reply_count: 2 },
      channelId: 'C1',
      teamId: 'T1',
      me: 'U9',
      users,
    });
    applyLastReply(thread, last, 'U9', users);
    assert.equal(thread.needsReply, expected);
    assert.equal(thread.needsReply, isNotMine(last, 'U9'), 'one rule serves both callers');
  }
});

test('wake rule: another user message newer than the last notified one wakes', async () => {
  const { shouldWake } = await import('../backend/slack-model.mjs');
  assert.equal(
    shouldWake({ user: 'U1', ts: '1793192474.000300' }, 'U9', '1793192474.000200'),
    true,
  );
  assert.equal(
    shouldWake({ user: 'U1', ts: '1793192600.000100' }, 'U9', '1793192474.000200'),
    true,
    'a later second wins whatever the microseconds',
  );
});

test('wake rule: the user own message, a bot message, an equal or older ts never wake', async () => {
  const { shouldWake } = await import('../backend/slack-model.mjs');
  const notified = '1793192474.000200';
  assert.equal(shouldWake({ user: 'U9', ts: '1793192474.000300' }, 'U9', notified), false, 'own');
  assert.equal(shouldWake({ ts: '1793192474.000300' }, 'U9', notified), false, 'bot, no user');
  assert.equal(shouldWake({ user: 'U1', ts: notified }, 'U9', notified), false, 'equal ts');
  assert.equal(
    shouldWake({ user: 'U1', ts: '1793192474.000100' }, 'U9', notified),
    false,
    'older ts: a deleted newest message exposing an earlier one',
  );
  assert.equal(
    shouldWake({ user: 'U1', ts: '1793192400.999999' }, 'U9', notified),
    false,
    'an earlier second loses whatever the microseconds',
  );
});

test('wake rule: no recorded lastNotifiedTs wakes for any message not mine', async () => {
  const { shouldWake } = await import('../backend/slack-model.mjs');
  for (const unset of [null, undefined]) {
    assert.equal(shouldWake({ user: 'U1', ts: '1793192474.000300' }, 'U9', unset), true);
    assert.equal(shouldWake({ user: 'U9', ts: '1793192474.000300' }, 'U9', unset), false, 'own');
    assert.equal(shouldWake({ ts: '1793192474.000300' }, 'U9', unset), false, 'bot');
  }
});

test('wake rule: timestamps compare as seconds and microseconds, not as text or floats', async () => {
  const { shouldWake } = await import('../backend/slack-model.mjs');
  const wakes = (ts, notified) => shouldWake({ user: 'U1', ts }, 'U9', notified);
  assert.equal(wakes('1793192474.000201', '1793192474.000200'), true, 'one microsecond newer');
  assert.equal(wakes('1793192474.000200', '1793192474.000201'), false, 'one microsecond older');
  assert.equal(wakes('1793192474.100000', '1793192474.099999'), true, 'tenth beats 99999 micro');
  assert.equal(wakes('1793192474.099999', '1793192474.100000'), false);
  assert.equal(
    wakes('1000000000.000000', '999999999.999999'),
    true,
    'ten digits of seconds beat nine, though "9" sorts after "1"',
  );
  assert.equal(wakes('999999999.999999', '1000000000.000000'), false, 'and not the reverse');
});

const WATCH_KEY_TEAM = 'T0EXAMPLE1';
const WATCH_KEY_THREAD_TS = '1793192214.548389';

const listEntryFor = ({ channelId, teamId, ts }) =>
  buildThread({
    root: { ts, user: 'U1', text: 'TAP-1: invented subject', reply_count: 1 },
    channelId,
    teamId,
    me: 'U9',
    users,
  });

test('thread watch key: a list entry carries the key the watch list files its own link under', () => {
  const thread = listEntryFor({
    channelId: 'C0EXAMPLE1',
    teamId: WATCH_KEY_TEAM,
    ts: WATCH_KEY_THREAD_TS,
  });
  assert.equal(thread.watchKey, 'C0EXAMPLE1:1793192214.548389');
  assert.equal(parseSlackLink(thread.url).key, thread.watchKey);
});

test('thread watch key: a mention row is keyed by its thread root, not by the mention', () => {
  const thread = buildThread({
    root: { ts: WATCH_KEY_THREAD_TS, user: 'U1', text: 'TAP-1: invented subject', reply_count: 2 },
    mention: { ts: '1793192300.000200', user: 'U2', text: 'ping <@U9> about this' },
    channelId: 'C0EXAMPLE1',
    teamId: WATCH_KEY_TEAM,
    me: 'U9',
    users,
  });
  assert.equal(thread.watchKey, 'C0EXAMPLE1:1793192214.548389');
  assert.equal(parseSlackLink(thread.url).key, thread.watchKey);
});

test('thread watch key: a list entry without a team, channel or ts has no link and an empty key', () => {
  const incomplete = [
    { channelId: 'C0EXAMPLE1', teamId: '', ts: WATCH_KEY_THREAD_TS },
    { channelId: '', teamId: WATCH_KEY_TEAM, ts: WATCH_KEY_THREAD_TS },
    { channelId: 'C0EXAMPLE1', teamId: WATCH_KEY_TEAM, ts: '' },
  ];
  for (const parts of incomplete) {
    const thread = listEntryFor(parts);
    assert.equal(thread.url, '', `no link for ${JSON.stringify(parts)}`);
    assert.equal(thread.watchKey, '', `no key for ${JSON.stringify(parts)}`);
  }
});

test('thread watch key: parity with the key a pasted archive permalink files the same thread under', () => {
  const cases = [
    {
      channelId: 'C024BE91L',
      permalink: 'https://example.slack.com/archives/C024BE91L/p1793192214548389',
      key: 'C024BE91L:1793192214.548389',
    },
    {
      channelId: 'G0EXAMPLE12',
      permalink: 'https://example.slack.com/archives/G0EXAMPLE12/p1793192214548389',
      key: 'G0EXAMPLE12:1793192214.548389',
    },
  ];
  for (const { channelId, permalink, key } of cases) {
    const thread = listEntryFor({
      channelId,
      teamId: WATCH_KEY_TEAM,
      ts: WATCH_KEY_THREAD_TS,
    });
    assert.equal(thread.watchKey, key, `${channelId}: the key a list entry carries`);
    assert.equal(parseSlackLink(permalink).key, key, `${channelId}: the key a pasted link gets`);
    assert.equal(parseSlackLink(thread.url).key, key, `${channelId}: the key its own link gets`);
  }
});
