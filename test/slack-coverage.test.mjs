import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { slackStaleReplyWarning, slackStandaloneMentionWarning } from '../ui/slack-coverage.js';

test('ambiguous Slack search results disclose the possible standalone mention omission', () => {
  for (const snapshot of [
    { partial: true, partialReasons: ['ambiguous_search_result'], started: [], mentions: [] },
    {
      partial: true,
      partialReasons: ['search_coverage_uncertain', 'ambiguous_search_result'],
      started: [{ ts: '1.000001' }],
    },
    { partial: false, partialReasons: ['ambiguous_search_result'] },
  ]) {
    assert.match(slackStandaloneMentionWarning(snapshot), /standalone mentions may be missing/i);
  }
});

test('a skipped ambiguous history mention uses the same standalone disclosure', () => {
  for (const started of [[], [{ ts: '1.000001' }]]) {
    assert.match(
      slackStandaloneMentionWarning({
        partial: true,
        partialReasons: ['ambiguous_history_mention'],
        started,
      }),
      /standalone mentions may be missing/i,
    );
  }
});

test('other incomplete Slack reasons do not claim a standalone mention omission', () => {
  for (const snapshot of [
    null,
    {},
    { partial: true, partialReasons: ['refresh_failed'] },
    { partial: true, partialReasons: ['search_coverage_uncertain'] },
    { partial: true, partialReasons: [] },
    { partial: true, partialReasons: 'ambiguous_search_result' },
  ]) {
    assert.equal(slackStandaloneMentionWarning(snapshot), '');
  }
});

test('reused reply activity is disclosed even for an empty visible list', () => {
  for (const snapshot of [
    { partial: true, partialReasons: ['reply_activity_stale'], started: [] },
    {
      partial: false,
      stale: false,
      partialReasons: ['ambiguous_search_result', 'reply_activity_stale'],
      started: [{ ts: '1.000001' }],
    },
  ]) {
    assert.match(slackStaleReplyWarning(snapshot), /reply information may be stale/i);
  }
});

test('other incomplete reasons do not claim stale reply activity', () => {
  for (const snapshot of [
    null,
    {},
    { stale: true, partialReasons: ['refresh_failed'] },
    { partial: true, partialReasons: ['search_coverage_uncertain'] },
    { partial: true, partialReasons: ['ambiguous_search_result'] },
    { partial: true, partialReasons: ['reply_unavailable'] },
    { partial: true, partialReasons: 'reply_activity_stale' },
  ]) {
    assert.equal(slackStaleReplyWarning(snapshot), '');
  }
});

test('reply recovery clears only the stale reply disclosure', () => {
  const snapshot = {
    partialReasons: ['ambiguous_search_result', 'reply_activity_stale'],
  };
  assert.ok(slackStaleReplyWarning(snapshot));
  assert.ok(slackStandaloneMentionWarning(snapshot));
  snapshot.partialReasons = ['ambiguous_search_result'];
  assert.equal(slackStaleReplyWarning(snapshot), '');
  assert.ok(slackStandaloneMentionWarning(snapshot));
});

for (const [file, snapshot] of [
  ['SlackPanel.jsx', 'threads'],
  ['MyTicketsPanel.jsx', 'slackSnapshot'],
]) {
  test(`${file} includes the reason-specific warning in its coverage state`, () => {
    const source = readFileSync(new URL(`../ui-react/panels/${file}`, import.meta.url), 'utf8');
    assert.ok(
      source.includes(`const standaloneWarning = slackStandaloneMentionWarning(${snapshot});`),
    );
    assert.match(source, /standaloneWarning\)\s*&&\s*\(/);
    assert.ok(source.includes("{standaloneWarning ? ` ${standaloneWarning}` : ''}"));
  });
}
