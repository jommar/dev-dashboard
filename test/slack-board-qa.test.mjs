import test from 'node:test';
import assert from 'node:assert/strict';
import { createSlackIntegration, slackPaths } from '../backend/slack.mjs';

const NOW = Date.parse('2026-11-07T12:00:00.000Z');
const WINDOW = 28 * 24 * 60 * 60 * 1000;
const CHANNEL = 'C024BE91L';
const ME = 'U9';
const OTHER = 'U1';

function at(milliseconds) {
  const micros = BigInt(milliseconds) * 1000n;
  return `${micros / 1_000_000n}.${String(micros % 1_000_000n).padStart(6, '0')}`;
}

function root(timestamp, latest) {
  return {
    ts: timestamp,
    thread_ts: timestamp,
    user: ME,
    text: 'TAP-42: synthetic thread',
    reply_count: latest ? 1 : 0,
    ...(latest ? { latest_reply: latest } : {}),
  };
}

function hit(message) {
  return { ...message, channel: { id: CHANNEL, name: 'ezat_claudio' } };
}

// Every upstream response and session read is in memory; no credentials or network are used.
function fixture({ history, searchHit, replyResponse }) {
  let clock = NOW;
  let failSearch = false;
  const calls = [];
  const paths = slackPaths('/virtual-qa-home');
  const fs = {
    lstatSync(file) {
      return {
        isDirectory: () => file !== paths.session,
        isFile: () => file === paths.session,
        isSymbolicLink: () => false,
      };
    },
    chmodSync() {},
    readFileSync: () =>
      JSON.stringify({ token: 'xoxc-synthetic', cookie: 'xoxd-synthetic', teamId: 'T0EXAMPLE1' }),
  };
  const response = (value) => new Response(JSON.stringify(value));
  const fetchImpl = async (url) => {
    const target = new URL(url);
    const method = target.pathname.split('/').pop();
    const params = Object.fromEntries(target.searchParams);
    calls.push({ method, params, at: clock });
    if (method === 'auth.test')
      return response({ ok: true, user: 'testuser', user_id: ME, team_id: 'T0EXAMPLE1' });
    if (method === 'users.list') return response({ ok: true, members: [] });
    if (method === 'conversations.history') {
      return response({
        ok: true,
        messages: history.filter((message) => message.ts >= params.oldest),
        has_more: false,
        response_metadata: {},
      });
    }
    if (method === 'search.messages') {
      if (params.count === '1')
        return response({
          ok: true,
          messages: { matches: [{ channel: { id: CHANNEL, name: 'ezat_claudio' } }] },
        });
      if (failSearch)
        return new Response(JSON.stringify({ ok: false, error: 'ratelimited' }), {
          status: 429,
          headers: { 'Retry-After': '30' },
        });
      const matches = params.query.includes(`<@${ME}>`) ? [] : [searchHit];
      return response({
        ok: true,
        messages: { matches, total: matches.length, paging: { pages: 1 } },
      });
    }
    if (method === 'conversations.replies') return replyResponse(params, response);
    return response({ ok: false, error: 'unexpected_method' });
  };
  return {
    integration: createSlackIntegration({ paths, fs, fetchImpl, now: () => clock }),
    calls,
    advance: (milliseconds) => {
      clock += milliseconds;
    },
    failSearch: () => {
      failSearch = true;
    },
  };
}

async function flush() {
  for (let index = 0; index < 30; index++) await new Promise((resolve) => setImmediate(resolve));
}

test('QA: a root-only limit=1 response cannot establish the latest reply', async () => {
  const rootTs = at(NOW - 30_000);
  const latest = at(NOW - 1000);
  const candidate = root(rootTs, latest);
  const match = hit({ ts: latest, thread_ts: rootTs, user: OTHER, text: 'Recent <@U9> mention' });
  const f = fixture({
    history: [],
    searchHit: match,
    replyResponse: (params, response) =>
      params.limit === '1'
        ? response({ ok: true, messages: [candidate], has_more: true, response_metadata: {} })
        : new Response(JSON.stringify({ ok: false, error: 'ratelimited' }), {
            status: 429,
            headers: { 'Retry-After': '30' },
          }),
  });

  await f.integration.threads();
  await flush();
  const result = await f.integration.threads();
  const row = result.started.find((item) => item.ts === rootTs);
  assert.ok(row, 'the search-resolved root is returned');
  assert.deepEqual(
    f.calls
      .filter((call) => call.method === 'conversations.replies')
      .map((call) => call.params.limit),
    ['1', '200'],
    'the one-message root lookup is distinct from the rate-limited reply scan',
  );
  assert.equal(row.activityTs, null);
  assert.equal(row.activityAt, '');
  assert.equal(row.latestReplyBy, null);
  assert.equal(row.needsReply, null);
  assert.ok(result.partialReasons.includes('reply_unavailable'));
});

test('QA: root-only limit=1 with more pages contradicts a zero-reply count', async () => {
  const candidate = root(at(NOW - 30_000));
  const f = fixture({
    history: [],
    searchHit: hit(candidate),
    replyResponse: (params, response) =>
      params.limit === '1'
        ? response({
            ok: true,
            messages: [candidate],
            has_more: true,
            response_metadata: { next_cursor: 'reply-1' },
          })
        : new Response(JSON.stringify({ ok: false, error: 'ratelimited' }), {
            status: 429,
            headers: { 'Retry-After': '30' },
          }),
  });

  await f.integration.threads();
  await flush();
  const result = await f.integration.threads();
  const row = result.started.find((item) => item.ts === candidate.ts);
  assert.ok(row, 'the root can still be displayed with unknown activity');
  assert.ok(
    f.calls.some((call) => call.method === 'conversations.replies' && call.params.limit === '1'),
  );
  assert.deepEqual(
    { activityTs: row.activityTs, latestReplyBy: row.latestReplyBy, needsReply: row.needsReply },
    { activityTs: null, latestReplyBy: null, needsReply: null },
    'has_more contradicts the unverified zero-reply metadata',
  );
  assert.ok(result.partialReasons.some((reason) => reason !== 'search_coverage_uncertain'));
});

test('QA: a 429 search refresh excludes unconfirmed rows while expiring old cached rows', async () => {
  const stable = root(at(NOW - 60_000));
  const expiring = root(at(NOW - WINDOW + 300_000));
  const searchOnly = root(at(NOW - 120_000));
  const f = fixture({
    history: [stable, expiring],
    searchHit: hit(searchOnly),
    replyResponse: (params, response) =>
      response({ ok: true, messages: [searchOnly], has_more: false, response_metadata: {} }),
  });

  const initial = await f.integration.threads();
  await flush();
  assert.deepEqual(
    new Set(initial.started.map((row) => row.ts)),
    new Set([stable.ts, expiring.ts, searchOnly.ts]),
  );
  f.failSearch();
  f.advance(300_001);
  const stale = await f.integration.threads();
  assert.deepEqual(
    new Set(stale.started.map((row) => row.ts)),
    new Set([stable.ts, searchOnly.ts]),
  );
  await flush();
  const refreshed = await f.integration.threads();
  assert.equal(refreshed.partial, true);
  assert.ok(
    refreshed.partialReasons.includes('search_unavailable') ||
      refreshed.partialReasons.includes('refresh_failed'),
  );
  assert.ok(
    !f.calls.some(
      (call) =>
        call.method === 'conversations.replies' &&
        call.params.ts === expiring.ts &&
        call.at > NOW + 300_000,
    ),
  );
  assert.deepEqual(
    { ids: new Set(refreshed.started.map((row) => row.ts)), stale: refreshed.stale },
    { ids: new Set([stable.ts]), stale: true },
    'a failed search refresh keeps only freshly confirmed rows and stays stale',
  );
});
