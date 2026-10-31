// slack-link.test.mjs — a pasted Slack link becomes one thread key, or a reason.
import test from 'node:test';
import assert from 'node:assert/strict';

const CHANNEL = 'C024BE91L';
const THREAD_TS = '1793192214.548389';
const KEY = `${CHANNEL}:${THREAD_TS}`;

const REPLY_LINK =
  'https://example.slack.com/archives/C024BE91L/p1793192474000200' +
  '?thread_ts=1793192214.548389&cid=C024BE91L';
const TOP_LEVEL_LINK = 'https://example.slack.com/archives/C024BE91L/p1793192214548389';
const APP_LINK =
  'https://app.slack.com/client/T024BE7LD/C024BE91L/thread/C024BE91L-1793192214.548389';

const SNAKE_CASE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

async function parse(input) {
  const { parseSlackLink } = await import('../backend/slack-link.mjs');
  let result;
  assert.doesNotThrow(
    () => {
      result = parseSlackLink(input);
    },
    `parsing ${String(input)} must not throw`,
  );
  return result;
}

function assertRejected(result, label) {
  assert.equal(typeof result.reason, 'string', `${label}: a reason code is returned`);
  assert.match(result.reason, SNAKE_CASE, `${label}: the reason is a snake_case code`);
  assert.equal('key' in result, false, `${label}: a rejected link has no key`);
}

function assertValidatedLink(link, label) {
  const url = new URL(link);
  assert.equal(url.protocol, 'https:', `${label}: https only`);
  assert.ok(
    url.hostname === 'slack.com' || url.hostname.endsWith('.slack.com'),
    `${label}: a Slack host, got ${url.hostname}`,
  );
  assert.equal(url.hash, '', `${label}: no fragment`);
  assert.equal(url.username, '', `${label}: no user name`);
  assert.equal(url.password, '', `${label}: no password`);
  for (const name of url.searchParams.keys())
    assert.equal(name, 'thread_ts', `${label}: only thread_ts may remain in the query`);
}

test('a reply permalink is keyed by the thread it replies to', async () => {
  const result = await parse(REPLY_LINK);
  assert.equal(result.key, KEY);
  assert.equal(result.channelId, CHANNEL);
  assert.equal(result.threadTs, THREAD_TS);
});

test('a top-level message permalink is keyed by its own timestamp', async () => {
  const result = await parse(TOP_LEVEL_LINK);
  assert.equal(result.key, KEY);
  assert.equal(result.channelId, CHANNEL);
  assert.equal(result.threadTs, THREAD_TS);
});

test('the dashboard own app.slack.com thread form is accepted', async () => {
  const result = await parse(APP_LINK);
  assert.equal(result.key, KEY);
  assert.equal(result.channelId, CHANNEL);
  assert.equal(result.threadTs, THREAD_TS);
});

test('every variant of one thread yields one key', async () => {
  const variants = [
    REPLY_LINK,
    TOP_LEVEL_LINK,
    APP_LINK,
    `${TOP_LEVEL_LINK}#section`,
    `${REPLY_LINK}#reply`,
    'https://other.slack.com/archives/C024BE91L/p1793192474000200?thread_ts=1793192214.548389',
  ];
  const keys = [];
  for (const variant of variants) keys.push((await parse(variant)).key);
  assert.deepEqual(
    keys,
    variants.map(() => KEY),
  );
});

test('a different thread in the same channel gets a different key', async () => {
  const other = await parse('https://example.slack.com/archives/C024BE91L/p1793192474000200');
  assert.equal(other.key, `${CHANNEL}:1793192474.000200`);
  assert.equal(other.threadTs, '1793192474.000200');
});

test('the normalized link keeps only validated parts', async () => {
  const inputs = [REPLY_LINK, TOP_LEVEL_LINK, APP_LINK, `${REPLY_LINK}#reply`, `${APP_LINK}#x`];
  for (const input of inputs) {
    const result = await parse(input);
    assert.equal(typeof result.link, 'string', `${input}: a normalized link is returned`);
    assertValidatedLink(result.link, input);
  }
});

test('a fragment and a cid on the input are accepted and dropped from the link', async () => {
  const result = await parse(`${REPLY_LINK}#frag`);
  assert.equal(result.key, KEY);
  const url = new URL(result.link);
  assert.equal(url.hash, '');
  assert.equal(url.searchParams.has('cid'), false);
});

test('the normalized link is itself a valid link for the same thread', async () => {
  for (const input of [REPLY_LINK, TOP_LEVEL_LINK, APP_LINK]) {
    const first = await parse(input);
    const again = await parse(first.link);
    assert.equal(again.key, KEY, `${input}: re-parsing the stored link keeps the thread`);
    assert.equal(again.link, first.link, `${input}: normalizing twice changes nothing`);
  }
});

test('a channel-only link is rejected', async () => {
  const inputs = [
    'https://example.slack.com/archives/C024BE91L',
    'https://example.slack.com/archives/C024BE91L/',
    'https://app.slack.com/client/T024BE7LD/C024BE91L',
  ];
  for (const input of inputs) assertRejected(await parse(input), input);
});

test('a non-Slack host is rejected, look-alikes included', async () => {
  const inputs = [
    'https://example.com/archives/C024BE91L/p1793192214548389',
    'https://slack.com.evil.example/archives/C024BE91L/p1793192214548389',
    'https://example.slack.com.evil.example/archives/C024BE91L/p1793192214548389',
    'https://notslack.com/archives/C024BE91L/p1793192214548389',
    'https://evilslack.com/archives/C024BE91L/p1793192214548389',
    'https://example.slack.com@evil.example/archives/C024BE91L/p1793192214548389',
  ];
  for (const input of inputs) assertRejected(await parse(input), input);
});

test('a non-https scheme is rejected', async () => {
  const inputs = [
    'http://example.slack.com/archives/C024BE91L/p1793192214548389',
    'ftp://example.slack.com/archives/C024BE91L/p1793192214548389',
    'example.slack.com/archives/C024BE91L/p1793192214548389',
  ];
  for (const input of inputs) assertRejected(await parse(input), input);
});

test('embedded credentials are rejected', async () => {
  const inputs = [
    'https://user:secret@example.slack.com/archives/C024BE91L/p1793192214548389',
    'https://user@example.slack.com/archives/C024BE91L/p1793192214548389',
  ];
  for (const input of inputs) assertRejected(await parse(input), input);
});

test('a malformed message timestamp is rejected', async () => {
  const inputs = [
    'https://example.slack.com/archives/C024BE91L/p179319221454838',
    'https://example.slack.com/archives/C024BE91L/p17931922145483890',
    'https://example.slack.com/archives/C024BE91L/p17931922145483ab',
    'https://example.slack.com/archives/C024BE91L/pabcdefghijklmnop',
    'https://example.slack.com/archives/C024BE91L/p',
    'https://app.slack.com/client/T024BE7LD/C024BE91L/thread/C024BE91L-1793192214.54',
  ];
  for (const input of inputs) assertRejected(await parse(input), input);
});

test('a malformed thread_ts is rejected', async () => {
  const base = 'https://example.slack.com/archives/C024BE91L/p1793192474000200';
  const inputs = [
    `${base}?thread_ts=1793192214`,
    `${base}?thread_ts=abc.def`,
    `${base}?thread_ts=1793192214.54838`,
  ];
  for (const input of inputs) assertRejected(await parse(input), input);
});

test('trailing junk after the permalink is rejected', async () => {
  const inputs = [
    `${TOP_LEVEL_LINK} please look`,
    `look at ${TOP_LEVEL_LINK}`,
    `${REPLY_LINK} junk`,
    `${TOP_LEVEL_LINK} ${REPLY_LINK}`,
    `${TOP_LEVEL_LINK}/extra`,
    `${TOP_LEVEL_LINK}extra`,
    `${APP_LINK}/extra`,
  ];
  for (const input of inputs) assertRejected(await parse(input), input);
});

test('text that is not a link is rejected', async () => {
  for (const input of ['', 'not a link', '   ']) assertRejected(await parse(input), `"${input}"`);
});

test('non-string input is rejected without throwing', async () => {
  for (const input of [null, undefined, 42, {}, [TOP_LEVEL_LINK]])
    assertRejected(await parse(input), String(input));
});
