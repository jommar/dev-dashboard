import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  eligibleSlackRoot,
  groupSlackActivity,
  nextSlackActivityChange,
  slackSessionIdentity,
  SLACK_WINDOW_MS,
} from '../ui/slack-activity.js';

process.env.TZ = 'America/New_York';
const HOUR = 60 * 60 * 1000;
const ts = (ms, micros = 0) =>
  `${Math.floor(ms / 1000)}.${String((ms % 1000) * 1000 + micros).padStart(6, '0')}`;
const row = (created, activity, extra = {}) => ({
  ts: ts(created),
  activityAt: new Date(activity).toISOString(),
  replyCount: 1,
  ...extra,
});

test('board activity: calendar boundaries include rolling three hours and DST local dates', () => {
  const now = Date.parse('2026-03-09T05:00:00Z');
  const crossing = row(now - 24 * HOUR, Date.parse('2026-03-09T03:30:00Z'));
  const exact = row(now - 24 * HOUR - 1000, now - 3 * HOUR);
  const past = row(now - 24 * HOUR - 2000, now - 3 * HOUR - 1);
  const seventh = row(Date.parse('2026-03-02T05:00:00Z'), Date.parse('2026-03-02T05:00:00Z'), {
    replyCount: 0,
  });
  const eighth = row(Date.parse('2026-03-01T05:00:00Z'), Date.parse('2026-03-01T05:00:00Z'), {
    replyCount: 0,
  });
  const { groups } = groupSlackActivity([past, eighth, exact, crossing, seventh], now);
  assert.deepEqual(
    groups.map((group) => group.threads),
    [[crossing, exact], [], [past], [seventh], [eighth]],
  );
  const fall = Date.parse('2026-11-02T17:00:00Z');
  const seven = row(Date.parse('2026-10-26T04:00:00Z'), Date.parse('2026-10-26T04:00:00Z'), {
    replyCount: 0,
  });
  const eight = row(Date.parse('2026-10-25T04:00:00Z'), Date.parse('2026-10-25T04:00:00Z'), {
    replyCount: 0,
  });
  const fallGroups = groupSlackActivity([seven, eight], fall).groups;
  assert.deepEqual(fallGroups[3].threads, [seven]);
  assert.deepEqual(fallGroups[4].threads, [eight]);

  // Spring-forward makes the exact 28-day boundary fall on a 29th local date.
  const spring = Date.parse('2026-03-09T04:15:00Z');
  const boundary = spring - SLACK_WINDOW_MS;
  const olderLocalDate = row(boundary, boundary, { replyCount: 0 });
  assert.deepEqual(groupSlackActivity([olderLocalDate], spring).groups[4].threads, [
    olderLocalDate,
  ]);

  const newYear = Date.parse('2027-01-01T17:00:00Z');
  const previousYear = row(newYear - 2 * 24 * HOUR, Date.parse('2026-12-31T17:00:00Z'));
  assert.deepEqual(groupSlackActivity([previousYear], newYear).groups[2].threads, [previousYear]);
});

test('board activity: root cutoff and newest sort preserve microseconds', () => {
  const now = Date.parse('2026-03-09T16:00:00Z');
  assert.equal(eligibleSlackRoot(ts(now - SLACK_WINDOW_MS), now), true);
  assert.equal(eligibleSlackRoot(ts(now - SLACK_WINDOW_MS - 1, 999), now), false);
  assert.equal(eligibleSlackRoot(ts(now, 1), now), false);
  assert.equal(eligibleSlackRoot('bad', now), false);
  const at = now - HOUR;
  const older = row(now - 2 * HOUR, at, { activityTs: ts(at, 1) });
  const newer = row(now - 2 * HOUR - 1, at, { activityTs: ts(at, 999) });
  assert.deepEqual(groupSlackActivity([older, newer], now).groups[0].threads, [newer, older]);
});

test('board activity: unverified, inconsistent and future activity is never guessed', () => {
  const now = Date.parse('2026-03-09T16:00:00Z');
  const root = now - 2 * HOUR;
  const bad = row(root, now - HOUR, { activityTs: null });
  const mismatch = row(root - 1, now - HOUR, { activityTs: ts(now - HOUR - 1) });
  const future = row(root - 2, now + 1);
  const before = row(root - 3, root - 4);
  const empty = { ts: ts(root - 5), replyCount: 0 };
  const result = groupSlackActivity([bad, mismatch, future, before, empty], now);
  assert.equal(result.unknown.length, 4);
  assert.deepEqual(result.groups[0].threads, [empty]);
});

test('board activity: timer wakes just after inclusive expiry and at midnight', () => {
  const now = Date.parse('2026-03-09T05:00:00Z');
  const root = row(now - SLACK_WINDOW_MS + 5_000, now - HOUR);
  assert.equal(nextSlackActivityChange([root], now), now + 5_001);
  const activity = row(now - 24 * HOUR, now - 3 * HOUR);
  assert.equal(nextSlackActivityChange([activity], now), now + 1);
  const beforeMidnight = Date.parse('2026-03-10T03:59:58Z');
  assert.equal(nextSlackActivityChange([], beforeMidnight), beforeMidnight + 2_000);
});

test('board scope: saved session identity distinguishes a re-login without treating verification failure as replacement', () => {
  const first = slackSessionIdentity({ connected: true, savedAt: 'one', teamDomain: 'workspace' });
  const second = slackSessionIdentity({ connected: true, savedAt: 'two', teamDomain: 'workspace' });
  assert.notEqual(first, second);
  const old = slackSessionIdentity({ connected: true, user: 'user', team: 'team' });
  assert.equal(slackSessionIdentity({ connected: true, verified: false }, old), old);
  assert.equal(slackSessionIdentity({ connected: false }, old), '');
  const firstLegacy = slackSessionIdentity({
    connected: true,
    sessionVersion: 'one',
    user: 'same',
    team: 'team',
  });
  const secondLegacy = slackSessionIdentity(
    { connected: true, sessionVersion: 'two', user: 'same', team: 'team' },
    firstLegacy,
  );
  assert.notEqual(firstLegacy, secondLegacy);
  assert.equal(
    slackSessionIdentity({ connected: true, verified: false, sessionVersion: 'one' }, firstLegacy),
    firstLegacy,
  );
});
