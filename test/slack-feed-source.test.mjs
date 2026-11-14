// slack-feed-source.test.mjs — source guards for the Slack Activity feed: it is read-only, its three
// Slack methods live in backend/slack-feed.mjs alone, and it makes every request through `call`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (relative) =>
  fs.readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const METHOD = /['"`]([a-z_]+\.[A-Za-z_.]+)['"`]/g;
const FEED_METHODS = ['activity.feed', 'conversations.info', 'conversations.replies'];

test('the feed module exists, names only its three read methods and no activity.mark', () => {
  const source = code(read('backend/slack-feed.mjs'));
  const methods = new Set([...source.matchAll(METHOD)].map((match) => match[1]));
  for (const method of FEED_METHODS) assert.ok(methods.has(method), `${method} is used`);
  assert.doesNotMatch(source, /activity\.mark/);
  assert.doesNotMatch(source, /conversations\.history/);
  const slackMethods = [...methods].filter((name) =>
    /^(?:activity|conversations|chat|reactions|files|pins|stars|users|client|auth)\./.test(name),
  );
  assert.deepEqual(slackMethods.sort(), FEED_METHODS);
});

test('the feed module makes no bare fetch: every request goes through the call seam', () => {
  const source = code(read('backend/slack-feed.mjs'));
  assert.doesNotMatch(source, /(?<![\w.])fetch\(/);
});

test('slack.mjs and slack-board.mjs gain no feed method literal', () => {
  for (const file of ['backend/slack.mjs', 'backend/slack-board.mjs']) {
    const source = code(read(file));
    assert.doesNotMatch(source, /['"`]activity\.feed['"`]/, file);
    assert.doesNotMatch(source, /['"`]conversations\.info['"`]/, file);
  }
});
