import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slackWatchSummary } from '../ui/slack-watch-summary.js';

const link = (...statuses) => ({
  key: 'C0EXAMPLE1:1.000001',
  sessions: statuses.map((status, index) => ({
    sessionId: `session-${index}`,
    delivery: status ? { status } : undefined,
  })),
});

test('nothing is shown before the first watch read', () => {
  assert.deepEqual(slackWatchSummary(null), { count: undefined, attention: '' });
  assert.deepEqual(slackWatchSummary(undefined), { count: undefined, attention: '' });
});

test('a healthy watcher shows its count and no warning', () => {
  assert.deepEqual(slackWatchSummary({ state: 'running', links: [] }), { count: 0, attention: '' });
  assert.deepEqual(
    slackWatchSummary({
      state: 'running',
      links: [link('delivered'), link('waiting', null), link()],
    }),
    { count: 3, attention: '' },
  );
});

test('a paused or disabled watcher asks for attention, however many threads it holds', () => {
  assert.deepEqual(slackWatchSummary({ state: 'paused', links: [link('delivered')] }), {
    count: 1,
    attention: 'Watcher paused',
  });
  assert.deepEqual(slackWatchSummary({ state: 'disabled', links: [] }), {
    count: 0,
    attention: 'Watcher disabled',
  });
});

test('any failed delivery, transient or permanent, asks for attention', () => {
  for (const status of ['failed-transient', 'failed-permanent']) {
    assert.deepEqual(
      slackWatchSummary({ state: 'running', links: [link('delivered'), link('waiting', status)] }),
      { count: 2, attention: 'A delivery is failing' },
    );
  }
});

test('disabled outranks paused, and either outranks a failed delivery', () => {
  assert.equal(
    slackWatchSummary({ state: 'disabled', links: [link('failed-permanent')] }).attention,
    'Watcher disabled',
  );
  assert.equal(
    slackWatchSummary({ state: 'paused', links: [link('failed-transient')] }).attention,
    'Watcher paused',
  );
});

test('a list the server sent without links counts none', () => {
  assert.deepEqual(slackWatchSummary({ state: 'running' }), { count: 0, attention: '' });
});
