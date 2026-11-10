import test from 'node:test';
import assert from 'node:assert/strict';
import { slackThreadRow, slackThreadRead } from '../e2e/data.js';

test('Slack row/read builders preserve activity, session and review payloads without enriching sparse reads', () => {
  const author = Object.freeze({ id: 'U0EXAMPLE1', name: 'Sam Example' });
  const channel = Object.freeze({ id: 'C0EXAMPLE1', name: 'example_channel' });
  const profiles = [
    {
      rowOptions: {
        text: 'Old root, newest reply',
        createdAt: 1772985600123,
        activityAt: 1773071700000,
        teamId: 'T0EXAMPLE1',
        channelId: 'C0EXAMPLE1',
        author,
        replyCount: 1,
        latestReplyBy: { id: 'U0EXAMPLE2', name: 'Riley Sample' },
      },
      readOptions: {
        channel,
        author,
        replyCount: 1,
        truncated: false,
        names: { U0EXAMPLE1: 'Sam Example' },
      },
      expectedRow: {
        ts: '1772985600.123000',
        url: 'https://app.slack.com/client/T0EXAMPLE1/C0EXAMPLE1/thread/C0EXAMPLE1-1772985600.123000',
        watchKey: 'C0EXAMPLE1:1772985600.123000',
        text: 'Old root, newest reply',
        subjectText: 'Old root, newest reply',
        author: { id: 'U0EXAMPLE1', name: 'Sam Example' },
        starter: { id: 'U0EXAMPLE1', name: 'Sam Example' },
        replyCount: 1,
        activityAt: '2026-03-09T15:55:00.000Z',
        latestReplyBy: { id: 'U0EXAMPLE2', name: 'Riley Sample' },
        needsReply: false,
        attachedSessions: 0,
      },
      expectedRead: {
        ts: '1772985600.123000',
        url: 'https://app.slack.com/client/T0EXAMPLE1/C0EXAMPLE1/thread/C0EXAMPLE1-1772985600.123000',
        watchKey: 'C0EXAMPLE1:1772985600.123000',
        channel: { id: 'C0EXAMPLE1', name: 'example_channel' },
        replyCount: 1,
        truncated: false,
        names: { U0EXAMPLE1: 'Sam Example' },
        messages: [
          {
            ts: '1772985600.123000',
            at: '2026-03-08T16:00:00.123Z',
            author: { id: 'U0EXAMPLE1', name: 'Sam Example' },
            text: 'Old root, newest reply',
            mrkdwn: 'Old root, newest reply',
          },
        ],
      },
    },
    {
      rowOptions: {
        text: 'Session thread',
        createdAt: 1772985598000,
        activityAt: 1773068400000,
        teamId: 'T0EXAMPLE1',
        channelId: 'C0EXAMPLE1',
        author,
        replyCount: 1,
      },
      readOptions: { channel, author, replyCount: 1 },
      expectedRow: {
        ts: '1772985598.000000',
        url: 'https://app.slack.com/client/T0EXAMPLE1/C0EXAMPLE1/thread/C0EXAMPLE1-1772985598.000000',
        watchKey: 'C0EXAMPLE1:1772985598.000000',
        text: 'Session thread',
        subjectText: 'Session thread',
        author: { id: 'U0EXAMPLE1', name: 'Sam Example' },
        starter: { id: 'U0EXAMPLE1', name: 'Sam Example' },
        replyCount: 1,
        activityAt: '2026-03-09T15:00:00.000Z',
        needsReply: false,
        attachedSessions: 0,
      },
      expectedRead: {
        ts: '1772985598.000000',
        url: 'https://app.slack.com/client/T0EXAMPLE1/C0EXAMPLE1/thread/C0EXAMPLE1-1772985598.000000',
        watchKey: 'C0EXAMPLE1:1772985598.000000',
        channel: { id: 'C0EXAMPLE1', name: 'example_channel' },
        replyCount: 1,
        messages: [
          {
            ts: '1772985598.000000',
            at: '2026-03-08T15:59:58.000Z',
            author: { id: 'U0EXAMPLE1', name: 'Sam Example' },
            text: 'Session thread',
            mrkdwn: 'Session thread',
          },
        ],
      },
    },
    {
      rowOptions: {
        text: 'Review thread',
        createdAt: 1773072000987,
        activityAt: 1773072000987,
        teamId: 'T0EXAMPLE1',
        channelId: 'C0EXAMPLE1',
        author,
        replyCount: 0,
      },
      readOptions: { channel, author, replyCount: 0 },
      expectedRow: {
        ts: '1773072000.987000',
        url: 'https://app.slack.com/client/T0EXAMPLE1/C0EXAMPLE1/thread/C0EXAMPLE1-1773072000.987000',
        watchKey: 'C0EXAMPLE1:1773072000.987000',
        text: 'Review thread',
        subjectText: 'Review thread',
        author: { id: 'U0EXAMPLE1', name: 'Sam Example' },
        starter: { id: 'U0EXAMPLE1', name: 'Sam Example' },
        replyCount: 0,
        activityAt: '2026-03-09T16:00:00.987Z',
        needsReply: false,
        attachedSessions: 0,
      },
      expectedRead: {
        ts: '1773072000.987000',
        url: 'https://app.slack.com/client/T0EXAMPLE1/C0EXAMPLE1/thread/C0EXAMPLE1-1773072000.987000',
        watchKey: 'C0EXAMPLE1:1773072000.987000',
        channel: { id: 'C0EXAMPLE1', name: 'example_channel' },
        replyCount: 0,
        messages: [
          {
            ts: '1773072000.987000',
            at: '2026-03-09T16:00:00.987Z',
            author: { id: 'U0EXAMPLE1', name: 'Sam Example' },
            text: 'Review thread',
            mrkdwn: 'Review thread',
          },
        ],
      },
    },
  ];

  for (const { rowOptions, readOptions, expectedRow, expectedRead } of profiles) {
    const originalRowOptions = structuredClone(rowOptions);
    const originalReadOptions = structuredClone(readOptions);
    const row = slackThreadRow(Object.freeze(rowOptions));
    assert.deepEqual(row, expectedRow);
    const read = slackThreadRead(Object.freeze(row), Object.freeze(readOptions));
    assert.deepEqual(read, expectedRead);
    assert.deepEqual(row, expectedRow);
    assert.deepEqual(rowOptions, originalRowOptions);
    assert.deepEqual(readOptions, originalReadOptions);
  }

  assert.deepEqual(
    slackThreadRow({
      text: 'Please take a look',
      createdAt: 1772985600123,
      activityAt: 1773071700000,
      teamId: 'T0EXAMPLE1',
      channelId: 'C0EXAMPLE1',
      author: { id: 'U0EXAMPLE2', name: 'Riley Sample' },
      starter: author,
      replyCount: 1,
      latestReplyBy: { id: 'U0EXAMPLE2', name: 'Riley Sample' },
      needsReply: true,
    }),
    {
      ts: '1772985600.123000',
      url: 'https://app.slack.com/client/T0EXAMPLE1/C0EXAMPLE1/thread/C0EXAMPLE1-1772985600.123000',
      watchKey: 'C0EXAMPLE1:1772985600.123000',
      text: 'Please take a look',
      subjectText: 'Please take a look',
      author: { id: 'U0EXAMPLE2', name: 'Riley Sample' },
      starter: { id: 'U0EXAMPLE1', name: 'Sam Example' },
      replyCount: 1,
      activityAt: '2026-03-09T15:55:00.000Z',
      latestReplyBy: { id: 'U0EXAMPLE2', name: 'Riley Sample' },
      needsReply: true,
      attachedSessions: 0,
    },
  );

  const options = Object.freeze({
    text: 'Sparse activity',
    createdAt: 1772985600123,
    activityAt: 'unknown',
    teamId: 'T0EXAMPLE1',
    channelId: 'C0EXAMPLE1',
    author,
    replyCount: 7,
    subjectText: 'Scenario subject',
    needsReply: true,
    attachedSessions: 2,
  });
  const expected = {
    ts: '1772985600.123000',
    url: 'https://app.slack.com/client/T0EXAMPLE1/C0EXAMPLE1/thread/C0EXAMPLE1-1772985600.123000',
    watchKey: 'C0EXAMPLE1:1772985600.123000',
    text: 'Sparse activity',
    subjectText: 'Scenario subject',
    author: { id: 'U0EXAMPLE1', name: 'Sam Example' },
    starter: { id: 'U0EXAMPLE1', name: 'Sam Example' },
    replyCount: 7,
    activityAt: 'unknown',
    needsReply: true,
    attachedSessions: 2,
  };
  assert.deepEqual(slackThreadRow(options), expected);
  assert.deepEqual(slackThreadRow({ ...options, activityAt: '2026-03-09T15:00:00Z' }), {
    ...expected,
    activityAt: '2026-03-09T15:00:00Z',
  });
  assert.deepEqual(slackThreadRead(expected, { channel, author, replyCount: 7 }), {
    ts: '1772985600.123000',
    url: 'https://app.slack.com/client/T0EXAMPLE1/C0EXAMPLE1/thread/C0EXAMPLE1-1772985600.123000',
    watchKey: 'C0EXAMPLE1:1772985600.123000',
    channel: { id: 'C0EXAMPLE1', name: 'example_channel' },
    replyCount: 7,
    messages: [
      {
        ts: '1772985600.123000',
        at: '2026-03-08T16:00:00.123Z',
        author: { id: 'U0EXAMPLE1', name: 'Sam Example' },
        text: 'Sparse activity',
        mrkdwn: 'Sparse activity',
      },
    ],
  });
});
