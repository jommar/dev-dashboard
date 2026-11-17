// slack-ticket-threads.test.mjs — threads that name a ticket, found by Slack search in any conversation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSlackTicketThreads, ticketKeysOf } from '../backend/slack-ticket-threads.mjs';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const ME = 'U0000ME01';
const OTHER = 'U0000OT01';
const PIQ = 'C0CA4BAGF44';
const EZAT = 'C0C2DJFKATW';
const DM = 'D066M8NP1FT';
// 2026-11-17 08:53:20Z and a few seconds apart, all well inside the 28-day window.
const T1 = '1794905600.296579';
const T2 = '1794897843.980369';
const T3 = '1794848370.406359';

function match({ ts = T1, channel = { id: PIQ, name: 'piq_claudio' }, text, user = ME, thread }) {
  const [seconds, fraction] = ts.split('.');
  const link = `https://example.slack.com/archives/${channel.id}/p${seconds}${fraction}`;
  return {
    ts,
    channel,
    user,
    text,
    permalink: thread ? `${link}?thread_ts=${thread}&cid=${channel.id}` : link,
  };
}

function setup({
  matches = {},
  roots = {},
  now = NOW,
  connected = true,
  failSearch = false,
  limitSearch = false,
} = {}) {
  let clock = now;
  const calls = [];
  const generation = 1;
  const slack = createSlackTicketThreads({
    call: async (method, params) => {
      calls.push({ method, params });
      if (method === 'search.messages') {
        if (limitSearch) throw new Error('rate_limited');
        if (failSearch) throw new Error('unavailable');
        const key = params.query.split(' ')[0];
        const found = matches[key] ?? [];
        return { ok: true, messages: { matches: found, paging: { total: found.length } } };
      }
      const root = roots[`${params.channel}:${params.ts}`];
      return root
        ? { ok: true, messages: [{ ts: params.ts, ...root }] }
        : { ok: false, error: 'thread_not_found' };
    },
    session: () => (connected ? { token: 'x', teamId: 'T1' } : null),
    verify: async () => ({ connected: true, userId: ME, teamId: 'T1' }),
    users: async () => ({ [ME]: 'Alex', [OTHER]: 'Sam' }),
    now: () => clock,
    isCurrent: (gen) => gen === generation,
    generation: () => generation,
  });
  return {
    slack,
    calls,
    searches: () => calls.filter((c) => c.method === 'search.messages'),
    advance: (ms) => (clock += ms),
  };
}

test('ticketKeysOf keeps well-formed TAP keys once each, upper-cased', () => {
  assert.deepEqual(ticketKeysOf([' tap-12 ', 'TAP-12', 'TAP-3', 'TRIPS-4', 'TAP-', 'x', 7, null]), [
    'TAP-12',
    'TAP-3',
  ]);
  assert.deepEqual(ticketKeysOf(undefined), []);
  assert.equal(ticketKeysOf(Array.from({ length: 200 }, (_, i) => `TAP-${i + 1}`)).length, 80);
});

test('a thread in another channel is listed with its channel, replies and activity', async () => {
  const { slack } = setup({
    matches: { 'TAP-2356': [match({ text: 'TAP-2356 review: PR #384 is up' })] },
    roots: {
      [`${PIQ}:${T1}`]: {
        user: ME,
        text: 'TAP-2356 review: PR #384 is up',
        reply_count: 3,
        latest_reply: '1794906000.000100',
      },
    },
  });
  const result = await slack.lookup(['TAP-2356']);

  assert.equal(result.available, true);
  assert.equal(result.threads.length, 1);
  const [row] = result.threads;
  assert.equal(row.ts, T1);
  assert.deepEqual(row.channel, { id: PIQ, name: 'piq_claudio', kind: 'channel' });
  assert.equal(row.replyCount, 3);
  assert.equal(row.subjectText, 'TAP-2356 review: PR #384 is up');
  assert.match(row.url, new RegExp(`${PIQ}`));
  assert.ok(row.watchKey.includes(PIQ));
  assert.equal(result.remaining, 0);
  assert.equal(result.partial, false);
});

test('only opening messages whose first line names the key are kept', async () => {
  const reply = match({ ts: T2, text: 'TAP-1 is done', thread: T1 });
  const keyOnSecondLine = match({ ts: T3, text: 'standup notes\nTAP-1 came up' });
  const otherKey = match({ ts: '1794800000.000100', text: 'TAP-10: a different ticket' });
  const tooOld = match({ ts: '1700000000.000100', text: 'TAP-1: from long ago' });
  const badChannel = match({ ts: '1794800100.000100', text: 'TAP-1: odd', channel: { id: 'x' } });
  const kept = match({ ts: '1794800200.000100', text: '_Spec: TAP-1 italic label_' });
  const { slack } = setup({
    matches: { 'TAP-1': [reply, keyOnSecondLine, otherKey, tooOld, badChannel, kept] },
  });
  const result = await slack.lookup(['TAP-1']);

  assert.deepEqual(
    result.threads.map((row) => row.ts),
    ['1794800200.000100'],
  );
});

test('direct and group messages are named by their kind, not an id', async () => {
  const dm = match({
    ts: T1,
    text: 'TAP-5 question',
    channel: { id: DM, name: null, is_im: true },
  });
  const group = match({
    ts: T2,
    text: 'TAP-5 group chat',
    channel: { id: 'G0123456789', name: 'mpdm-a--b-1', is_mpim: true },
  });
  const { slack } = setup({ matches: { 'TAP-5': [dm, group] } });
  const result = await slack.lookup(['TAP-5']);

  const byTs = Object.fromEntries(result.threads.map((row) => [row.ts, row.channel]));
  assert.deepEqual(byTs[T1], { id: DM, name: 'Direct message', kind: 'im' });
  assert.deepEqual(byTs[T2], { id: 'G0123456789', name: 'Group message', kind: 'mpim' });
});

test('a thread naming two requested tickets is listed once', async () => {
  const both = match({ text: 'TAP-1, TAP-2: shared work' });
  const { slack } = setup({ matches: { 'TAP-1': [both], 'TAP-2': [both] } });
  const result = await slack.lookup(['TAP-1', 'TAP-2']);

  assert.equal(result.threads.length, 1);
});

test('answers are cached per key, so a repeat asks Slack nothing', async () => {
  const { slack, calls, advance } = setup({
    matches: { 'TAP-1': [match({ text: 'TAP-1: one' })] },
  });
  await slack.lookup(['TAP-1']);
  const first = calls.length;
  await slack.lookup(['TAP-1']);
  assert.equal(calls.length, first);
  advance(16 * 60 * 1000);
  await slack.lookup(['TAP-1']);
  assert.ok(calls.length > first);
});

test('a call searches a bounded number of new keys and reports what is left', async () => {
  const keys = Array.from({ length: 12 }, (_, i) => `TAP-${i + 1}`);
  const { slack, searches } = setup();
  const first = await slack.lookup(keys);

  assert.equal(searches().length, 8);
  assert.equal(first.remaining, 4);
  assert.equal(first.truncated, true);
  assert.ok(first.partialReasons.includes('bounded_work_remaining'));

  const second = await slack.lookup(keys);
  assert.equal(searches().length, 12);
  assert.equal(second.remaining, 0);
  assert.equal(second.partial, false);
});

test('a rate limit ends the request but still answers', async () => {
  const { slack } = setup({ limitSearch: true });
  const result = await slack.lookup(['TAP-1', 'TAP-2', 'TAP-3']);

  assert.equal(result.available, true);
  assert.deepEqual(result.threads, []);
  assert.ok(result.partialReasons.includes('rate_limited'));
});

test('a failed search is not cached but is not retried straight away either', async () => {
  const { slack, searches, advance } = setup({ failSearch: true });
  const first = await slack.lookup(['TAP-1']);
  assert.ok(first.partialReasons.includes('search_unavailable'));
  assert.equal(searches().length, 1);

  await slack.lookup(['TAP-1']);
  assert.equal(searches().length, 1);
  advance(61 * 1000);
  await slack.lookup(['TAP-1']);
  assert.equal(searches().length, 2);
});

test('a root Slack will not read is still listed, without a reply count', async () => {
  const { slack } = setup({ matches: { 'TAP-1': [match({ text: 'TAP-1: private thread' })] } });
  const [row] = (await slack.lookup(['TAP-1'])).threads;

  assert.equal(row.replyCount, 0);
  assert.equal(row.ts, T1);
});

test('the dialog may read only a thread that was listed, in that channel', async () => {
  const { slack } = setup({ matches: { 'TAP-1': [match({ text: 'TAP-1: listed' })] } });
  assert.equal(slack.isVerifiedRoot(PIQ, T1), false);
  await slack.lookup(['TAP-1']);

  assert.equal(slack.isVerifiedRoot(PIQ, T1), true);
  assert.equal(slack.isVerifiedRoot(EZAT, T1), false);
  assert.equal(slack.isVerifiedRoot(PIQ, T2), false);
  assert.deepEqual(slack.describe(PIQ, T1), { id: PIQ, name: 'piq_claudio', kind: 'channel' });
});

test('without a session there is nothing to ask', async () => {
  const { slack, calls } = setup({ connected: false });

  assert.deepEqual(await slack.lookup(['TAP-1']), { available: false });
  assert.equal(calls.length, 0);
});
