// slack-model.test.mjs — pure shaping rules for the Slack thread lists.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyLastReply,
  buildThread,
  cleanText,
  person,
  slackTimestamp,
  sortByActivity,
  threadUrl,
} from '../backend/slack-model.mjs';

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
