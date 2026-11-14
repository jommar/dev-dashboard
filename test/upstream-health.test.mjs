// upstream-health.test.mjs — the sentence a board note shows for a degraded integration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describeUpstream, degradedNotes } from '../ui/upstream-health.js';

const AT = '2026-11-14T10:00:00.000Z';
const NOW = Date.parse(AT);
const degraded = (kind, extra = {}) => ({
  status: 'degraded',
  lastOkAt: null,
  lastFailure: { kind, status: null, at: AT, retryAfterSec: null, ...extra },
});

test('describeUpstream: a rate limit names the minutes left to wait', () => {
  const entry = degraded('rate_limit', { retryAfterSec: 240 });
  assert.equal(
    describeUpstream('github', entry, NOW),
    'GitHub is rate limiting requests: retry in 4 min.',
  );
});

test('describeUpstream: under a minute left reads in seconds', () => {
  const entry = degraded('rate_limit', { retryAfterSec: 30 });
  assert.equal(
    describeUpstream('github', entry, NOW),
    'GitHub is rate limiting requests: retry in 30 s.',
  );
});

test('describeUpstream: an elapsed or missing retry time drops the clause', () => {
  const elapsed = degraded('rate_limit', { retryAfterSec: 60 });
  assert.equal(
    describeUpstream('github', elapsed, NOW + 120_000),
    'GitHub is rate limiting requests.',
  );
  assert.equal(
    describeUpstream('jira', degraded('rate_limit'), NOW),
    'Jira is rate limiting requests.',
  );
});

test('describeUpstream: auth words differ for Slack', () => {
  assert.equal(
    describeUpstream('jira', degraded('auth', { status: 401 }), NOW),
    'Jira rejected the token. Check Settings.',
  );
  assert.equal(
    describeUpstream('github', degraded('auth'), NOW),
    'GitHub rejected the token. Check Settings.',
  );
  assert.equal(
    describeUpstream('slack', degraded('auth'), NOW),
    'Slack rejected the session. Reconnect Slack.',
  );
});

test('describeUpstream: timeout, network and upstream failures', () => {
  assert.equal(describeUpstream('jira', degraded('timeout'), NOW), 'Jira did not answer in time.');
  assert.equal(describeUpstream('slack', degraded('network'), NOW), 'Slack could not be reached.');
  assert.equal(
    describeUpstream('github', degraded('upstream', { status: 502 }), NOW),
    'GitHub is having trouble answering.',
  );
  assert.equal(
    describeUpstream('github', degraded('something-new'), NOW),
    'GitHub is having trouble answering.',
  );
});

test('describeUpstream: ok, unknown and odd input say nothing and never throw', () => {
  assert.equal(
    describeUpstream('github', { status: 'ok', lastOkAt: AT, lastFailure: null }, NOW),
    null,
  );
  assert.equal(
    describeUpstream('github', { status: 'unknown', lastOkAt: null, lastFailure: null }, NOW),
    null,
  );
  assert.equal(describeUpstream('github', { status: 'degraded', lastFailure: null }, NOW), null);
  assert.equal(describeUpstream('github', null, NOW), null);
  assert.equal(describeUpstream('github', undefined, NOW), null);
  assert.equal(describeUpstream('github', 'garbage', NOW), null);
  assert.equal(describeUpstream('github', { status: 7, lastFailure: 'x' }, NOW), null);
  assert.equal(describeUpstream('github', { status: 'degraded', lastFailure: 'x' }, NOW), null);
});

test('degradedNotes: one note per degraded integration, in the screen order', () => {
  const health = {
    generatedAt: AT,
    integrations: {
      github: degraded('timeout'),
      jira: { status: 'ok', lastOkAt: AT, lastFailure: null },
      slack: degraded('auth'),
    },
  };
  assert.deepEqual(degradedNotes(health, ['jira', 'github', 'slack'], NOW), [
    { name: 'github', testId: 'github-upstream', text: 'GitHub did not answer in time.' },
    {
      name: 'slack',
      testId: 'slack-upstream',
      text: 'Slack rejected the session. Reconnect Slack.',
    },
  ]);
  assert.deepEqual(
    degradedNotes(health, ['slack', 'github'], NOW).map((note) => note.name),
    ['slack', 'github'],
  );
});

test('degradedNotes: only the names a screen depends on; garbage health is empty', () => {
  const health = { integrations: { github: degraded('network'), slack: degraded('network') } };
  assert.deepEqual(
    degradedNotes(health, ['jira', 'github'], NOW).map((note) => note.testId),
    ['github-upstream'],
  );
  assert.deepEqual(degradedNotes(null, ['github'], NOW), []);
  assert.deepEqual(degradedNotes('x', ['github'], NOW), []);
  assert.deepEqual(degradedNotes({}, ['github'], NOW), []);
  assert.deepEqual(degradedNotes({ integrations: null }, ['github'], NOW), []);
  assert.deepEqual(degradedNotes(health, null, NOW), []);
});

test('source contract: UpstreamNote uses the shared BoardNote; neither file holds a timer', () => {
  const note = readFileSync(
    new URL('../ui-react/components/UpstreamNote.jsx', import.meta.url),
    'utf8',
  );
  const hook = readFileSync(
    new URL('../ui-react/hooks/useUpstreamHealth.js', import.meta.url),
    'utf8',
  );
  assert.match(note, /import \{[^}]*\bBoardNote\b[^}]*\} from '\.\/BoardShell\.jsx'/);
  for (const source of [note, hook]) {
    assert.doesNotMatch(source, /setInterval|setTimeout|useActivePolling/);
  }
});
