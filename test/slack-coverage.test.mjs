import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  slackCoverage,
  slackStaleReplyWarning,
  slackStandaloneMentionWarning,
} from '../ui/slack-coverage.js';

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

test('slackCoverage says nothing for a snapshot that is missing or complete', () => {
  for (const snapshot of [
    undefined,
    null,
    {},
    { partial: false, truncated: false, partialReasons: [] },
    { started: [{ ts: '1.000001' }], partialReasons: ['refresh_failed'] },
  ]) {
    assert.deepEqual(slackCoverage(snapshot), {
      staleReplyWarning: '',
      standaloneWarning: '',
      incomplete: false,
    });
  }
});

test('slackCoverage flags a partial or truncated snapshot without inventing a sentence', () => {
  for (const snapshot of [
    { partial: true },
    { truncated: true },
    { partial: true, truncated: true },
  ]) {
    assert.deepEqual(slackCoverage(snapshot), {
      staleReplyWarning: '',
      standaloneWarning: '',
      incomplete: true,
    });
  }
});

test('slackCoverage returns each reason-specific sentence and flags the snapshot for either', () => {
  const stale = slackCoverage({ partialReasons: ['reply_activity_stale'] });
  assert.equal(
    stale.staleReplyWarning,
    slackStaleReplyWarning({ partialReasons: ['reply_activity_stale'] }),
  );
  assert.equal(stale.standaloneWarning, '');
  assert.equal(stale.incomplete, true);

  for (const reason of ['ambiguous_search_result', 'ambiguous_history_mention']) {
    const standalone = slackCoverage({ partialReasons: [reason] });
    assert.match(standalone.standaloneWarning, /standalone mentions may be missing/i);
    assert.equal(standalone.staleReplyWarning, '');
    assert.equal(standalone.incomplete, true);
  }

  const both = slackCoverage({
    partialReasons: ['reply_activity_stale', 'ambiguous_search_result'],
  });
  assert.ok(both.staleReplyWarning && both.standaloneWarning);
});

test('slackCoverage leaves the causes only one screen has to that screen', () => {
  // A continuation (My Tickets) and a stale or still-enriching snapshot (Slack) are each screen's
  // own reason to raise its note, so the shared flag does not include them.
  for (const snapshot of [
    { continuation: 'next-page' },
    { stale: true },
    { enriched: false },
    { coverageNotes: ['A channel was skipped.'] },
  ]) {
    assert.equal(slackCoverage(snapshot).incomplete, false);
  }
});

test('slackCoverage ignores a partialReasons value that is not a list', () => {
  assert.deepEqual(slackCoverage({ partialReasons: 'reply_activity_stale' }), {
    staleReplyWarning: '',
    standaloneWarning: '',
    incomplete: false,
  });
});

// Both screens that list Slack threads take their warnings and the flag from this one helper, and
// each puts the warnings into its own note (the rendered text is asserted by the e2e specs).
for (const file of ['SlackPanel.jsx', 'MyTicketsPanel.jsx']) {
  test(`${file} gets the coverage warnings from the shared helper`, () => {
    const source = readFileSync(new URL(`../ui-react/panels/${file}`, import.meta.url), 'utf8');
    assert.match(source, /from '\.\.\/\.\.\/ui\/slack-coverage\.js'/);
    assert.match(source, /\bslackCoverage\(/);
    assert.doesNotMatch(source, /slackStaleReplyWarning|slackStandaloneMentionWarning/);
    for (const name of ['staleReplyWarning', 'standaloneWarning', 'incomplete'])
      assert.ok(source.split(new RegExp(`\\b${name}\\b`)).length - 1 >= 2, `${name} is used`);
  });
}
