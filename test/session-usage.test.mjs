import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MAX_ROW_SESSIONS,
  USAGE_CHUNK,
  rowUsageLabel,
  usageChunks,
  usageSessionIds,
} from '../ui/session-usage.js';

// F15 deferred surface: the token tally on each Sessions drawer row, read in batches while the drawer is
// open (never on the 15 s tickets poll, never from the bot bar).
const id = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const group = (...rows) => ({ state: 'working', title: 'Working', rows });
const tally = (tokens, complete = true) => ({ tokens, models: {}, messages: 1, complete });
const ZERO = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

test('session usage: ids are the distinct session ids of the rows, in row order', () => {
  const groups = [
    group({ session: id(1) }, { session: undefined }, { session: id(2) }),
    group({ session: id(1) }, { session: null }, { session: id(3) }),
  ];
  assert.deepEqual(usageSessionIds(groups), [id(1), id(2), id(3)]);
  assert.deepEqual(usageSessionIds([]), []);
  assert.deepEqual(usageSessionIds(undefined), []);
});

test('session usage: the ids are capped, and cut into the route-sized batches', () => {
  assert.equal(USAGE_CHUNK, 8);
  const rows = Array.from({ length: 40 }, (_, n) => ({ session: id(n) }));
  const ids = usageSessionIds([group(...rows)]);
  assert.equal(ids.length, MAX_ROW_SESSIONS);
  const chunks = usageChunks(ids);
  assert.ok(chunks.every((chunk) => chunk.length <= USAGE_CHUNK));
  assert.deepEqual(chunks.flat(), ids);
  assert.deepEqual(usageChunks([]), []);
});

test('session usage: a row says its tokens, nothing for none or no answer', () => {
  assert.equal(
    rowUsageLabel(tally({ input: 900, output: 200, cacheRead: 100_000, cacheCreation: 0 })),
    '~101.1k tokens',
  );
  assert.equal(
    rowUsageLabel(tally({ ...ZERO, cacheCreation: 1_100_000 }, false)),
    'at least 1.1M tokens',
  );
  assert.equal(rowUsageLabel(tally(ZERO)), null);
  assert.equal(rowUsageLabel(undefined), null);
  assert.equal(rowUsageLabel(null), null);
});

test('session usage: only the drawer asks, and never on a timer', () => {
  const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const hook = read('ui-react/hooks/useSessionsUsage.js');
  assert.doesNotMatch(hook, /setInterval|setTimeout/);
  assert.match(hook, /getClaudeUsage/);
  assert.match(read('ui-react/components/SessionsDrawer.jsx'), /useSessionsUsage\(/);
  for (const file of [
    'ui-react/components/BotBar.jsx',
    'ui-react/hooks/useClaudeTickets.js',
    'ui-react/hooks/useBotCallouts.js',
  ])
    assert.doesNotMatch(read(file), /getClaudeUsage|useSessionsUsage|useClaudeUsage/, file);
});
