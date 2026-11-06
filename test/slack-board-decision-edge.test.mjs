import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpHandler } from '../backend/http-app.mjs';
import { createSlackBoard, eligibleRoot } from '../backend/slack-board.mjs';
import { createSlackIntegration, slackPaths } from '../backend/slack.mjs';
import { withAttachedSessions } from '../backend/slack-model.mjs';
import { eligibleSlackRoot, SLACK_WINDOW_MS } from '../ui/slack-activity.js';

const NOW = Date.parse('2026-11-07T12:00:00.000Z');
const ME = 'U9';

function at(ms, microseconds = 0) {
  const value = BigInt(ms) * 1000n + BigInt(microseconds);
  return `${value / 1_000_000n}.${String(value % 1_000_000n).padStart(6, '0')}`;
}

function root(ts, latest) {
  return {
    ts,
    thread_ts: ts,
    user: ME,
    text: 'TAP-42: synthetic root',
    reply_count: latest ? 1 : 0,
    ...(latest ? { latest_reply: latest } : {}),
  };
}

function board(call, now, verify = async () => ({ connected: true, userId: ME, teamId: 'T1' })) {
  return createSlackBoard({
    call,
    now,
    verify,
    session: () => ({}),
    channel: async () => ({ id: 'C1', name: 'ezat_claudio' }),
    users: async () => ({}),
    isCurrent: () => true,
    generation: () => 1,
  });
}

async function flush() {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
}

function deferred() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test('decision: backend and frontend share exact eligible-root boundaries', () => {
  assert.equal(eligibleRoot, eligibleSlackRoot, 'both consumers use the same predicate');
  const cutoff = NOW - SLACK_WINDOW_MS;
  for (const [ts, expected] of [
    [at(cutoff - 1, 999), false],
    [at(cutoff), true],
    [at(cutoff, 1), true],
    [at(NOW), true],
    [at(NOW, 1), false],
    [at(NOW - 1000).replace(/0+$/, '') + '0', true],
    ['', false],
    [null, false],
    ['1794052799.0000000', false],
  ]) {
    assert.equal(eligibleRoot(ts, NOW), expected, String(ts));
  }
  for (const invalidNow of [NaN, Infinity, 'invalid'])
    assert.equal(eligibleRoot(at(NOW), invalidNow), false);
});

test('decision: a confirmed root keeps verified activity when search and reply reads fail', async () => {
  let clock = NOW;
  let partial = false;
  const confirmed = root(at(NOW - 30_000), at(NOW - 1000));
  const omitted = root(at(NOW - 40_000));
  const latest = { ts: confirmed.latest_reply, thread_ts: confirmed.ts, user: 'U1', text: 'reply' };
  const integration = board(
    async (method, params) => {
      if (method === 'conversations.history')
        return { ok: true, messages: partial ? [confirmed] : [confirmed, omitted] };
      if (method === 'search.messages') {
        if (partial && !params.query.includes(`<@${ME}>`)) throw new Error('rate_limited');
        return { ok: true, messages: { matches: [], total: 0, paging: { pages: 1 } } };
      }
      if (method === 'conversations.replies') {
        if (partial) throw new Error('rate_limited');
        return { ok: true, messages: [confirmed, latest], response_metadata: {} };
      }
      throw new Error(`unexpected method ${method}`);
    },
    () => clock,
  );

  await integration.threads();
  await flush();
  assert.equal((await integration.threads()).started.length, 2);
  partial = true;
  clock += 300_001;
  await integration.threads();
  await flush();
  const failed = structuredClone(await integration.threads());
  assert.deepEqual(
    failed.started.map((row) => row.ts),
    [confirmed.ts],
  );
  assert.equal(failed.started[0].activityTs, confirmed.latest_reply);
  assert.equal(failed.started[0].latestReplyBy.id, 'U1');
  assert.equal(failed.started[0].needsReply, true);
  assert.equal(failed.stale, true);
  assert.ok(failed.partialReasons.includes('search_unavailable'));
  assert.ok(failed.partialReasons.includes('reply_unavailable'));
  assert.ok(failed.partialReasons.includes('reply_activity_stale'));

  partial = false;
  await integration.threads({ continuation: failed.continuation });
  await flush();
  const recovered = await integration.threads();
  assert.deepEqual(
    recovered.started.map((row) => row.ts),
    [confirmed.ts],
  );
  assert.equal(recovered.started[0].needsReply, true);
  assert.ok(!recovered.partialReasons.includes('search_unavailable'));
  assert.ok(!recovered.partialReasons.includes('reply_unavailable'));
  assert.ok(!recovered.partialReasons.includes('reply_activity_stale'));
});

test('decision: one recovered reply does not clear another root’s failed reply reason', async () => {
  let clock = NOW;
  const roots = [root(at(NOW - 30_000), at(NOW - 1000)), root(at(NOW - 40_000), at(NOW - 2000))];
  const failing = new Set();
  const integration = board(
    async (method, params) => {
      if (method === 'conversations.history') return { ok: true, messages: roots };
      if (method === 'search.messages')
        return { ok: true, messages: { matches: [], total: 0, paging: { pages: 1 } } };
      if (method === 'conversations.replies') {
        if (failing.has(params.ts)) throw new Error('rate_limited');
        const item = roots.find((candidate) => candidate.ts === params.ts);
        return {
          ok: true,
          messages: [item, { ts: item.latest_reply, thread_ts: item.ts, user: 'U1' }],
          response_metadata: {},
        };
      }
      throw new Error(`unexpected method ${method}`);
    },
    () => clock,
  );

  await integration.threads();
  await flush();
  for (const item of roots) failing.add(item.ts);
  clock += 300_001;
  await integration.threads();
  await flush();
  const failed = await integration.threads();
  assert.ok(failed.partialReasons.includes('reply_unavailable'));
  failing.delete(roots[0].ts);
  await integration.threads({ continuation: failed.continuation });
  await flush();
  const partlyRecovered = await integration.threads();
  assert.ok(partlyRecovered.partialReasons.includes('reply_unavailable'));
  assert.ok(partlyRecovered.continuation);
  failing.clear();
  await integration.threads({ continuation: partlyRecovered.continuation });
  await flush();
  const recovered = await integration.threads();
  assert.ok(!recovered.partialReasons.includes('reply_unavailable'));
  assert.ok(recovered.started.every((row) => row.needsReply === true));
});

test('decision: failure before a refresh snapshot invalidates previously verified roots', async () => {
  let clock = NOW;
  let identityAvailable = true;
  let attempts = 0;
  const candidate = root(at(NOW - 1000));
  const integration = board(
    async (method) => {
      if (method === 'conversations.history') return { ok: true, messages: [candidate] };
      if (method === 'search.messages')
        return { ok: true, messages: { matches: [], total: 0, paging: { pages: 1 } } };
      throw new Error(`unexpected method ${method}`);
    },
    () => clock,
    async () => {
      attempts++;
      return identityAvailable
        ? { connected: true, userId: ME, teamId: 'T1' }
        : { connected: false };
    },
  );

  await integration.threads();
  await flush();
  assert.equal(integration.isVerifiedRoot(candidate.ts), true);
  identityAvailable = false;
  clock += 300_001;
  await integration.threads();
  await flush();
  const failed = await integration.threads();
  assert.equal(failed.available, true);
  assert.deepEqual(failed.started, []);
  assert.deepEqual(failed.mentions, []);
  assert.equal(failed.partial, true);
  assert.ok(failed.partialReasons.includes('refresh_failed'));
  assert.equal(integration.isVerifiedRoot(candidate.ts), false);
  const count = attempts;
  await integration.threads();
  assert.equal(attempts, count, 'the failed refresh observes the retry backoff');
  identityAvailable = true;
  clock += 60_001;
  const recovered = await integration.threads();
  await flush();
  assert.equal(recovered.available, true);
  assert.deepEqual(
    recovered.started.map((row) => row.ts),
    [candidate.ts],
  );
});

for (const timing of [
  'after refresh starts',
  'already in flight',
  'already in flight until refresh completes',
]) {
  for (const outcome of ['partial', 'unverified identity']) {
    test(`decision safety: old continuation ${timing} cannot supersede ${outcome} refresh`, async () => {
      let clock = NOW;
      let refreshing = false;
      let refreshStarted = false;
      let continuationStarted = false;
      const refreshGate = deferred();
      const continuationGate = deferred();
      const present = root(at(NOW - 1000));
      const omitted = root(at(NOW - 2000));
      const extra = root(at(NOW - 3000));
      const integration = board(
        async (method, params) => {
          if (method === 'conversations.history') {
            if (refreshing && !params.cursor) {
              refreshStarted = true;
              await refreshGate.promise;
              return { ok: true, messages: [present], response_metadata: {} };
            }
            if (params.cursor === 'p3') {
              continuationStarted = true;
              if (timing.startsWith('already in flight')) await continuationGate.promise;
              return { ok: true, messages: [extra], response_metadata: {} };
            }
            const page = params.cursor ? Number(params.cursor.slice(1)) : 0;
            return {
              ok: true,
              messages: page === 0 ? [present, omitted] : [],
              has_more: true,
              response_metadata: { next_cursor: `p${page + 1}` },
            };
          }
          if (method === 'search.messages') {
            if (refreshing && outcome === 'partial') throw new Error('rate_limited');
            return { ok: true, messages: { matches: [], total: 0, paging: { pages: 1 } } };
          }
          throw new Error(`unexpected method ${method}`);
        },
        () => clock,
        async () => {
          if (refreshing && outcome === 'unverified identity') {
            refreshStarted = true;
            await refreshGate.promise;
            return { connected: true, verified: false, userId: '' };
          }
          return { connected: true, userId: ME, teamId: 'T1' };
        },
      );

      const initial = await integration.threads();
      await flush();
      assert.ok(initial.continuation);
      const oldToken = initial.continuation;
      let oldContinuation;
      let oldResult;
      try {
        if (timing.startsWith('already in flight')) {
          oldContinuation = integration.threads({ continuation: oldToken });
          await flush();
          assert.equal(continuationStarted, true);
        }
        refreshing = true;
        clock += 300_001;
        await integration.threads();
        await flush();
        assert.equal(refreshStarted, true);
        if (timing === 'after refresh starts')
          oldContinuation = integration.threads({ continuation: oldToken });
        if (timing === 'already in flight until refresh completes') {
          refreshGate.release();
          await flush();
        }
        continuationGate.release();
        oldResult = structuredClone(await oldContinuation);
      } finally {
        continuationGate.release();
        refreshGate.release();
      }
      await flush();
      const result = await integration.threads();
      assert.equal(oldResult.available, false, 'the superseded continuation cannot publish');
      if (timing === 'after refresh starts')
        assert.equal(continuationStarted, false, 'the obsolete token cannot start a read');
      assert.equal(result.available, true);
      assert.equal(result.partial, true);
      assert.deepEqual(
        result.started.map((row) => row.ts),
        outcome === 'partial' ? [present.ts] : [],
      );
      assert.ok(!result.started.some((row) => row.ts === omitted.ts));
    });
  }
}

test('decision safety: an unverified refresh gives both list consumers an empty partial', async () => {
  let clock = NOW;
  let verified = true;
  const candidate = root(at(NOW - 1000));
  const integration = board(
    async (method) => {
      if (method === 'conversations.history') return { ok: true, messages: [candidate] };
      if (method === 'search.messages')
        return { ok: true, messages: { matches: [], total: 0, paging: { pages: 1 } } };
      throw new Error(`unexpected method ${method}`);
    },
    () => clock,
    async () =>
      verified
        ? { connected: true, userId: ME, teamId: 'T1' }
        : { connected: true, verified: false, userId: '' },
  );
  const prior = await integration.threads();
  await flush();
  verified = false;
  clock += 300_001;
  await integration.threads();
  await flush();
  const result = withAttachedSessions(await integration.threads(), {});
  const slackConsumer = result.available ? result : prior;
  const ticketsConsumer = result.available ? result : null;
  for (const snapshot of [slackConsumer, ticketsConsumer]) {
    assert.ok(snapshot?.available, 'the consumer must accept the replacement');
    assert.deepEqual(snapshot.started, []);
    assert.deepEqual(snapshot.mentions, []);
    assert.equal(snapshot.partial, true);
    assert.ok(snapshot.partialReasons.includes('refresh_failed'));
  }
  assert.equal(integration.isVerifiedRoot(candidate.ts), false);
});

test('decision safety: auth timeout sends a replaceable empty partial through the list endpoint', async () => {
  let clock = NOW;
  let authTimeout = false;
  const candidate = root(at(NOW - 1000));
  const paths = slackPaths('/virtual-decision-home');
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
      JSON.stringify({ token: 'xoxc-synthetic', cookie: 'xoxd-synthetic', teamId: 'T1' }),
  };
  const fetchImpl = async (url) => {
    const target = new URL(url);
    const method = target.pathname.split('/').pop();
    const respond = (payload) => new Response(JSON.stringify(payload));
    if (method === 'auth.test') {
      if (authTimeout) throw new Error('synthetic timeout');
      return respond({ ok: true, user: 'testuser', user_id: ME, team_id: 'T1' });
    }
    if (method === 'users.list') return respond({ ok: true, members: [] });
    if (method === 'conversations.history') return respond({ ok: true, messages: [candidate] });
    if (method === 'search.messages') {
      const matches =
        target.searchParams.get('count') === '1'
          ? [{ channel: { id: 'C1', name: 'ezat_claudio' } }]
          : [];
      return respond({
        ok: true,
        messages: { matches, total: matches.length, paging: { pages: 1 } },
      });
    }
    throw new Error(`unexpected method ${method}`);
  };
  const slack = createSlackIntegration({ paths, fs, fetchImpl, now: () => clock });
  const handler = createHttpHandler({
    settings: {},
    manager: {},
    integrations: {
      slack,
      slackWatchStore: {},
      claudeSessions: {},
      slackWatcher: { isDisabled: () => true, stop() {} },
    },
  });
  async function get(url) {
    let status;
    let body;
    const res = {
      writeHead(value) {
        status = value;
      },
      end(value) {
        body = JSON.parse(value);
      },
    };
    await handler({ method: 'GET', url, headers: { host: 'localhost' }, socket: {} }, res);
    return { status, body };
  }
  try {
    const first = await get('/api/slack/threads');
    await flush();
    assert.deepEqual(
      first.body.started.map((row) => row.ts),
      [candidate.ts],
    );
    authTimeout = true;
    clock += 300_001;
    await get('/api/slack/threads');
    await flush();
    const status = await get('/api/slack/status');
    assert.equal(status.body.connected, true);
    assert.equal(status.body.verified, false);
    const failed = await get('/api/slack/threads');
    assert.equal(failed.status, 200);
    assert.equal(failed.body.available, true);
    assert.deepEqual(failed.body.started, []);
    assert.deepEqual(failed.body.mentions, []);
    assert.equal(failed.body.partial, true);
    assert.ok(failed.body.partialReasons.includes('refresh_failed'));
  } finally {
    handler.close();
  }
});

test('decision safety: concurrent failed retry callers both receive the empty partial', async () => {
  let clock = NOW;
  let verified = true;
  let held = false;
  const gate = deferred();
  const candidate = root(at(NOW - 1000));
  const integration = board(
    async (method) => {
      if (method === 'conversations.history') return { ok: true, messages: [candidate] };
      if (method === 'search.messages')
        return { ok: true, messages: { matches: [], total: 0, paging: { pages: 1 } } };
      throw new Error(`unexpected method ${method}`);
    },
    () => clock,
    async () => {
      if (held) await gate.promise;
      return verified
        ? { connected: true, userId: ME, teamId: 'T1' }
        : { connected: true, verified: false, userId: '' };
    },
  );
  await integration.threads();
  await flush();
  verified = false;
  clock += 300_001;
  await integration.threads();
  await flush();
  assert.equal((await integration.threads()).available, true);
  clock += 60_001;
  held = true;
  const first = integration.threads();
  const second = integration.threads();
  await flush();
  gate.release();
  for (const result of await Promise.all([first, second])) {
    assert.equal(result.available, true);
    assert.deepEqual(result.started, []);
    assert.equal(result.partial, true);
    assert.ok(result.partialReasons.includes('refresh_failed'));
  }
});

for (const concurrent of [false, true]) {
  test(`decision safety: ${concurrent ? 'concurrent' : 'single'} cold unverified identity reports partial and backs off`, async () => {
    let clock = NOW;
    let verified = false;
    let identityCalls = 0;
    let slackCalls = 0;
    const candidate = root(at(NOW - 1000));
    const integration = board(
      async (method) => {
        slackCalls++;
        if (method === 'conversations.history') return { ok: true, messages: [candidate] };
        if (method === 'search.messages')
          return { ok: true, messages: { matches: [], total: 0, paging: { pages: 1 } } };
        throw new Error(`unexpected method ${method}`);
      },
      () => clock,
      async () => {
        identityCalls++;
        return verified
          ? { connected: true, userId: ME, teamId: 'T1' }
          : { connected: true, verified: false, userId: '' };
      },
    );
    const requests = [integration.threads()];
    if (concurrent) requests.push(integration.threads());
    for (const result of await Promise.all(requests)) {
      assert.equal(result.available, true);
      assert.deepEqual(result.started, []);
      assert.deepEqual(result.mentions, []);
      assert.equal(result.partial, true);
      assert.ok(result.partialReasons.includes('refresh_failed'));
    }
    assert.equal(identityCalls, 1, 'cold callers share identity verification');
    assert.equal(slackCalls, 0, 'unverified identity cannot start a listing');
    const cachedFailure = await integration.threads();
    assert.equal(cachedFailure.available, true);
    assert.equal(cachedFailure.partial, true);
    assert.equal(identityCalls, 1, 'automatic retries respect the backoff');
    verified = true;
    clock += 60_001;
    const recovered = await integration.threads();
    await flush();
    assert.equal(recovered.available, true);
    assert.deepEqual(
      recovered.started.map((row) => row.ts),
      [candidate.ts],
    );
  });
}

test('decision safety: a genuinely disconnected cold identity stays unavailable', async () => {
  const integration = board(
    async () => {
      throw new Error('unexpected Slack read');
    },
    () => NOW,
    async () => ({ connected: false }),
  );
  assert.deepEqual(await integration.threads(), { available: false });
});

test('decision safety: cold throttled history exposes an empty partial and continuation', async () => {
  let clock = NOW;
  let throttled = true;
  let historyCalls = 0;
  const candidate = root(at(NOW - 1000));
  const integration = board(
    async (method) => {
      if (method === 'conversations.history') {
        historyCalls++;
        if (throttled) throw new Error('rate_limited');
        return { ok: true, messages: [candidate], response_metadata: {} };
      }
      if (method === 'search.messages')
        return { ok: true, messages: { matches: [], total: 0, paging: { pages: 1 } } };
      throw new Error(`unexpected method ${method}`);
    },
    () => clock,
  );
  const [first, second] = await Promise.all([integration.threads(), integration.threads()]);
  await flush();
  assert.equal(first.available, true);
  assert.deepEqual(first.started, []);
  assert.equal(first.partial, true);
  assert.ok(first.partialReasons.includes('history_unavailable'));
  assert.ok(first.continuation);
  assert.equal(second.available, true);
  assert.deepEqual(second.started, []);
  assert.equal(second.partial, true);
  assert.ok(second.partialReasons.includes('history_unavailable'));
  await integration.threads();
  assert.equal(historyCalls, 1, 'automatic retries respect the backoff');
  throttled = false;
  clock += 30_001;
  const continued = await integration.threads({ continuation: first.continuation });
  await flush();
  assert.deepEqual(
    continued.started.map((row) => row.ts),
    [candidate.ts],
  );
  assert.ok(!continued.partialReasons.includes('history_unavailable'));
});

test('decision safety: search pages use the current UTC cutoff after midnight', async () => {
  let clock = Date.parse('2026-11-07T23:59:59.000Z');
  const searches = [];
  const integration = board(
    async (method, params) => {
      if (method === 'conversations.history') return { ok: true, messages: [] };
      if (method === 'search.messages') {
        searches.push({ ...params, at: clock });
        return { ok: true, messages: { matches: [], total: 300, paging: { pages: 3 } } };
      }
      throw new Error(`unexpected method ${method}`);
    },
    () => clock,
  );
  const first = await integration.threads();
  await flush();
  assert.ok(first.continuation);
  clock += 2000;
  await integration.threads({ continuation: first.continuation });
  await flush();
  assert.equal(searches.length, 6);
  assert.ok(
    searches.some((call) => call.at === clock),
    'a continuation crosses UTC midnight',
  );
  for (const call of searches) {
    const date = new Date(call.at - SLACK_WINDOW_MS).toISOString().slice(0, 10);
    assert.ok(call.query.includes(`after:${date}`));
  }
});
