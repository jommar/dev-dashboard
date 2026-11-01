// claude-sessions.test.mjs — the session picker listing, the stop of an idle background session and
// the resume fallback for finished sessions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CHANNEL,
  FORK_SENTENCE,
  OTHER,
  SESSION_A,
  SESSION_B,
  SESSION_C,
  SESSION_D,
  SESSION_E,
  THREAD_TS,
  captureConsole,
  createClock,
  createFakeExec,
  deferred,
  findInTree,
  flush,
  listingEntry,
  permalinkFor,
  threadKey,
  tsAt,
  wakeConstants,
  watchFixture,
} from './slack-watch-fixture.mjs';

const { SETTLE_MS } = await wakeConstants();
const SETTLE_GAP_SECONDS = Math.ceil(SETTLE_MS / 1000) + 1;

const NAME_SENTINEL = 'sentinel-session-name-4d1c';
const CWD_SENTINEL = '/work/sentinel-cwd-8e2b';
const ERROR_SENTINEL = 'sentinel-error-text-b71f';
const FINISHED_CWD = '/work/finished-session';
const SECOND_THREAD_TS = '1793192300.000100';
const NOTICE_PREFIX = "There's a new message on ";
const TICK_MS = 180_000;
const UNTRUSTED_MESSAGE =
  `Workspace not trusted. Run \`claude\` in ${FINISHED_CWD} once and accept the trust prompt, ` +
  'then retry.';

const LINK = {
  key: threadKey(),
  link: permalinkFor(),
  channelId: CHANNEL,
  threadTs: THREAD_TS,
};

const finishedEntry = (sessionId = SESSION_A, extra = {}) =>
  listingEntry({ sessionId, cwd: FINISHED_CWD, ...extra });

async function sessionsEnvironment(t) {
  const { createClaudeSessions } = await import('../backend/claude-sessions.mjs');
  const { createSlackWatchStore } = await import('../backend/slack-watch-store.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sessions-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const clock = createClock();
  const store = createSlackWatchStore({ home, fs, now: clock.now });
  const exec = createFakeExec();
  const sessions = createClaudeSessions({ execFileImpl: exec.execFileImpl, store });
  return { sessions, store, exec, home, clock };
}

async function attachSessions(store, sessionIds, link = LINK) {
  await store.addLink(link);
  for (const sessionId of sessionIds) await store.attach(link.key, sessionId);
}

function assertListingArgv(call) {
  assert.equal(path.basename(call.file), 'claude');
  assert.deepStrictEqual(call.args, ['agents', '--json', '--all']);
  assert.ok(!call.options.shell, 'no shell');
  assert.ok(Number.isFinite(call.options.timeout) && call.options.timeout > 0, 'a timeout');
  assert.ok(Number.isFinite(call.options.maxBuffer) && call.options.maxBuffer > 0, 'an output cap');
}

function assertSpawn(spawn, { sessionId, notice, cwd }) {
  assert.equal(path.basename(spawn.file), 'claude');
  assert.deepStrictEqual(spawn.args, ['--bg', '--resume', sessionId, '--', notice]);
  assert.equal(spawn.options.cwd, cwd);
  assert.ok(!spawn.options.shell, 'no shell');
}

const withoutUndefined = (value) => JSON.parse(JSON.stringify(value));
const bySessionId = (sessions) =>
  Object.fromEntries(sessions.map((session) => [session.sessionId, session]));
const sortedById = (sessions) =>
  [...sessions].sort((left, right) => left.sessionId.localeCompare(right.sessionId));

// A result is a failure `{ status, reason }` or an answer whose code is the status or the reason.
const codeOf = (result) => result.reason ?? result.status;
const idleBackgroundEntry = (sessionId = SESSION_A, extra = {}) =>
  listingEntry({ sessionId, pid: 4242, status: 'idle', ...extra });
const callKinds = (exec) => exec.calls.map((call) => call.args[0]);
const FORK_OUTPUT = `session 11111111 ${FORK_SENTENCE} ffffffff\n${ERROR_SENTINEL}\n`;
const SHARED_PREFIX_SESSION = '11111111-2222-4222-8222-222222222222';

async function attemptStop(sessions, sessionId) {
  assert.equal(typeof sessions.stop, 'function', 'the sessions module exposes stop');
  try {
    return await sessions.stop({ sessionId });
  } catch {
    return null;
  }
}

const LISTING_FAILURES = {
  'a missing CLI': { spawnError: 'ENOENT' },
  'a timeout': { timeout: true },
  'exit code 1': { exitCode: 1, stderr: 'listing failed' },
  'non-JSON output': { stdout: '{not json' },
  'JSON that is not an array': { stdout: JSON.stringify({ sessions: [] }) },
};

test('listing returns source claude with only sessionId, state, name, attached and activity', async (t) => {
  const env = await sessionsEnvironment(t);
  await attachSessions(env.store, [SESSION_A, SESSION_C]);
  env.exec.setListing([
    listingEntry({ sessionId: SESSION_A, pid: 4242, name: 'live session', cwd: '/work/live' }),
    listingEntry({ sessionId: SESSION_B, name: 'finished session' }),
    listingEntry({ sessionId: SESSION_C, pid: '4242', name: 'string pid session' }),
    listingEntry({ sessionId: SESSION_D, pid: null, name: 'null pid session' }),
    { id: '55555555', name: 'only a short id', cwd: '/work/short', kind: 'background' },
    { ...listingEntry({ sessionId: SESSION_B }), sessionId: 'not-a-uuid' },
  ]);

  const result = await env.sessions.listSessions();

  assert.equal(result.source, 'claude');
  assert.equal(result.sessions.length, 4, 'entries without a UUID sessionId are dropped');
  const expected = {
    [SESSION_A]: { state: 'live', name: 'live session', attached: true, activity: null },
    [SESSION_B]: { state: 'finished', name: 'finished session', attached: false, activity: null },
    [SESSION_C]: { state: 'unknown', name: 'string pid session', attached: true, activity: null },
    [SESSION_D]: { state: 'unknown', name: 'null pid session', attached: false, activity: null },
  };
  const listed = bySessionId(result.sessions);
  assert.deepEqual(Object.keys(listed).sort(), Object.keys(expected).sort());
  for (const [sessionId, fields] of Object.entries(expected)) {
    assert.deepEqual(
      Object.keys(listed[sessionId]).sort(),
      ['activity', 'attached', 'name', 'sessionId', 'state'],
      'cwd, pid, id and kind never leak',
    );
    assert.deepStrictEqual(listed[sessionId], { sessionId, ...fields });
  }
});

test('listing carries activity idle, busy or null by kind, pid and status', async (t) => {
  const env = await sessionsEnvironment(t);
  env.exec.setListing([
    listingEntry({ sessionId: SESSION_A, pid: 4242, status: 'idle' }),
    listingEntry({ sessionId: SESSION_B, pid: 4243, status: 'busy', state: 'working' }),
    listingEntry({ sessionId: SESSION_C, pid: 4244, status: 'idle', kind: 'interactive' }),
    listingEntry({ sessionId: SESSION_D, pid: 4245 }),
    listingEntry({ sessionId: SESSION_E, pid: 4246, status: null }),
  ]);

  const result = await env.sessions.listSessions();

  assert.equal(result.source, 'claude');
  const listed = bySessionId(result.sessions);
  const activityById = Object.fromEntries(
    Object.entries(listed).map(([sessionId, session]) => [sessionId, session.activity]),
  );
  assert.deepStrictEqual(activityById, {
    [SESSION_A]: 'idle',
    [SESSION_B]: 'busy',
    [SESSION_C]: null,
    [SESSION_D]: null,
    [SESSION_E]: null,
  });
  for (const session of result.sessions)
    assert.deepEqual(
      Object.keys(session).sort(),
      ['activity', 'attached', 'name', 'sessionId', 'state'],
      'activity is the only new key',
    );
});

for (const [label, outcome] of Object.entries(LISTING_FAILURES))
  test(`listing falls back to the map ids when the CLI fails with ${label}`, async (t) => {
    const env = await sessionsEnvironment(t);
    const secondLink = {
      ...LINK,
      key: threadKey(CHANNEL, SECOND_THREAD_TS),
      threadTs: SECOND_THREAD_TS,
    };
    await attachSessions(env.store, [SESSION_A, SESSION_C]);
    await attachSessions(env.store, [SESSION_A], secondLink);
    env.exec.onListing(() => outcome);

    const result = await env.sessions.listSessions();

    assert.equal(result.source, 'map');
    assert.deepStrictEqual(
      sortedById(withoutUndefined(result.sessions)),
      [
        { sessionId: SESSION_A, state: 'unknown', attached: true },
        { sessionId: SESSION_C, state: 'unknown', attached: true },
      ],
      'each id in the map is listed once, unknown and attached, with no name',
    );
    for (const session of result.sessions) assert.equal(session.name, undefined);
  });

test('listing with the CLI failing and an empty map gives source map and no sessions', async (t) => {
  const env = await sessionsEnvironment(t);
  env.exec.onListing(() => ({ spawnError: 'ENOENT' }));

  const result = await env.sessions.listSessions();

  assert.deepStrictEqual(withoutUndefined(result), { source: 'map', sessions: [] });
});

test('listing runs the fixed claude argv without a shell, with a timeout and an output cap', async (t) => {
  const env = await sessionsEnvironment(t);
  env.exec.setListing([listingEntry({ sessionId: SESSION_A })]);

  await env.sessions.listSessions();

  assert.equal(env.exec.calls.length, 1);
  assertListingArgv(env.exec.calls[0]);
});

test('concurrent listing calls share one CLI run', async (t) => {
  const env = await sessionsEnvironment(t);
  const gate = deferred();
  env.exec.onListing(() => gate.promise);

  const pending = [env.sessions.listSessions(), env.sessions.listSessions()];
  await flush();
  pending.push(env.sessions.listSessions());
  await flush();
  assert.equal(env.exec.listings().length, 1, 'one exec call while the run is held');

  gate.resolve({ stdout: JSON.stringify([listingEntry({ sessionId: SESSION_A, pid: 4242 })]) });
  const results = await Promise.all(pending);

  assert.equal(env.exec.listings().length, 1);
  for (const result of results) {
    assert.equal(result.source, 'claude');
    assert.deepEqual(
      result.sessions.map((session) => session.sessionId),
      [SESSION_A],
    );
  }
});

test('listing never logs or stores the session name or cwd, and returns the name', async (t) => {
  const lines = captureConsole(t);
  const env = await sessionsEnvironment(t);
  env.exec.setListing([
    listingEntry({ sessionId: SESSION_A, name: NAME_SENTINEL, cwd: CWD_SENTINEL }),
  ]);
  const needles = [NAME_SENTINEL, CWD_SENTINEL];
  const assertClean = (when) => {
    assert.deepEqual(
      lines.filter((line) => needles.some((needle) => line.includes(needle))),
      [],
      `${when}: nothing logged`,
    );
    assert.deepEqual(findInTree(env.home, needles), [], `${when}: nothing stored`);
  };

  const result = await env.sessions.listSessions();

  assert.equal(bySessionId(result.sessions)[SESSION_A].name, NAME_SENTINEL);
  assert.equal(JSON.stringify(result).includes(CWD_SENTINEL), false, 'cwd is not returned');
  assertClean('after listing');

  await attachSessions(env.store, [SESSION_A]);
  await env.sessions.listSessions();
  assertClean('after an attach');
});

test('listing failures never log or store the CLI output or error text', async (t) => {
  const lines = captureConsole(t);
  const env = await sessionsEnvironment(t);
  await attachSessions(env.store, [SESSION_A]);
  env.exec.onListing(() => ({ exitCode: 1, stdout: ERROR_SENTINEL, stderr: ERROR_SENTINEL }));

  const result = await env.sessions.listSessions();

  assert.equal(result.source, 'map');
  assert.equal(JSON.stringify(result).includes(ERROR_SENTINEL), false);
  assert.deepEqual(
    lines.filter((line) => line.includes(ERROR_SENTINEL)),
    [],
  );
  assert.deepEqual(findInTree(env.home, [ERROR_SENTINEL]), []);
});

test('picker route answers 200 with the picker data and keeps the name to itself', async (t) => {
  const f = await watchFixture(t, { http: true, sessions: 'real' });
  f.exec.setListing([
    listingEntry({ sessionId: SESSION_A, name: NAME_SENTINEL, cwd: CWD_SENTINEL }),
  ]);
  const needles = [NAME_SENTINEL, CWD_SENTINEL];

  const picker = await f.http.raw('GET', '/api/slack/watch/sessions');

  assert.equal(picker.status, 200);
  const body = picker.json();
  assert.equal(body.source, 'claude');
  assert.deepStrictEqual(body.sessions, [
    {
      sessionId: SESSION_A,
      state: 'finished',
      name: NAME_SENTINEL,
      attached: false,
      activity: null,
    },
  ]);
  assert.equal(picker.text.includes(NAME_SENTINEL), true, 'the picker reply carries the name');
  assert.equal(picker.text.includes(CWD_SENTINEL), false, 'and never the cwd');

  const link = permalinkFor();
  const otherReplies = [
    await f.http.raw('GET', '/api/slack/watch'),
    await f.http.json('POST', '/api/slack/watch/links', { links: [link] }),
    await f.http.json('POST', '/api/slack/watch/attach', { link, sessionId: SESSION_A }),
    await f.http.raw('GET', '/api/slack/watch'),
    await f.http.json('POST', '/api/slack/watch/detach', { link, sessionId: SESSION_A }),
  ];
  for (const reply of otherReplies) {
    assert.equal(reply.status, 200);
    for (const needle of needles)
      assert.equal(reply.text.includes(needle), false, 'no other route carries the name or cwd');
  }
  assert.deepEqual(findInTree(f.home, needles), [], 'nothing is stored under the home');
});

test('picker route still answers 200 with source map when the CLI fails', async (t) => {
  const f = await watchFixture(t, { http: true, sessions: 'real' });
  await f.watch({ sessionIds: [SESSION_A] });
  f.exec.onListing(() => ({ exitCode: 1, stderr: 'listing failed' }));

  const picker = await f.http.raw('GET', '/api/slack/watch/sessions');

  assert.equal(picker.status, 200);
  assert.deepStrictEqual(picker.json(), {
    source: 'map',
    sessions: [{ sessionId: SESSION_A, state: 'unknown', attached: true }],
  });
});

test('picker route carries activity for live background sessions and none from the map', async (t) => {
  const f = await watchFixture(t, { http: true, sessions: 'real' });
  await f.watch({ sessionIds: [SESSION_A] });
  f.exec.setListing([
    idleBackgroundEntry(SESSION_A),
    listingEntry({ sessionId: SESSION_B, pid: 4243, status: 'busy', state: 'working' }),
  ]);

  const fromClaude = (await f.http.raw('GET', '/api/slack/watch/sessions')).json();

  assert.equal(fromClaude.source, 'claude');
  assert.deepStrictEqual(
    Object.fromEntries(fromClaude.sessions.map((session) => [session.sessionId, session.activity])),
    { [SESSION_A]: 'idle', [SESSION_B]: 'busy' },
  );

  f.exec.onListing(() => ({ exitCode: 1, stderr: 'listing failed' }));
  const fromMap = (await f.http.raw('GET', '/api/slack/watch/sessions')).json();

  assert.equal(fromMap.source, 'map');
  assert.equal(fromMap.sessions.length, 1, 'the attached session is still listed');
  for (const session of fromMap.sessions)
    assert.equal('activity' in session, false, 'a map entry carries no activity');
});

test('stop runs claude stop with the short id of an idle background session and answers stopped', async (t) => {
  const env = await sessionsEnvironment(t);
  env.exec.setListing([idleBackgroundEntry(SESSION_A)]);

  const result = await env.sessions.stop({ sessionId: SESSION_A });

  assert.equal(codeOf(result), 'stopped');
  assert.equal(env.exec.stops().length, 1);
  assert.deepStrictEqual(env.exec.stops()[0].args, ['stop', '11111111']);
});

const NOT_IDLE = {
  'a busy background session': listingEntry({
    sessionId: SESSION_A,
    pid: 4242,
    status: 'busy',
    state: 'working',
  }),
  'an idle interactive session': idleBackgroundEntry(SESSION_A, { kind: 'interactive' }),
  'a live session with no status key': listingEntry({ sessionId: SESSION_A, pid: 4242 }),
  'a live session with a null status': listingEntry({
    sessionId: SESSION_A,
    pid: 4242,
    status: null,
  }),
  'a live session with a text pid': idleBackgroundEntry(SESSION_A, { pid: '4242' }),
  'a finished session': listingEntry({ sessionId: SESSION_A, status: null }),
};

for (const [label, entry] of Object.entries(NOT_IDLE))
  test(`stop answers not_idle and runs nothing for ${label}`, async (t) => {
    const env = await sessionsEnvironment(t);
    env.exec.setListing([entry]);

    const result = await env.sessions.stop({ sessionId: SESSION_A });

    assert.equal(codeOf(result), 'not_idle');
    assert.equal(env.exec.stops().length, 0, 'no stop call');
  });

test('stop answers not_listed and runs nothing when a good listing lacks the session', async (t) => {
  const env = await sessionsEnvironment(t);
  env.exec.setListing([idleBackgroundEntry(SESSION_B)]);

  const result = await env.sessions.stop({ sessionId: SESSION_A });

  assert.equal(codeOf(result), 'not_listed');
  assert.equal(env.exec.stops().length, 0, 'no stop call');
});

test('stop fails permanently as ambiguous_id when another listed session shares the short id', async (t) => {
  const env = await sessionsEnvironment(t);
  env.exec.setListing([
    idleBackgroundEntry(SESSION_A),
    listingEntry({ sessionId: SHARED_PREFIX_SESSION }),
  ]);

  const result = await env.sessions.stop({ sessionId: SESSION_A });

  assert.equal(result.status, 'failed-permanent');
  assert.equal(codeOf(result), 'ambiguous_id');
  assert.equal(env.exec.stops().length, 0, 'no stop call');
});

test('stop does not stop an entry whose short id disagrees with its session id', async (t) => {
  const env = await sessionsEnvironment(t);
  env.exec.setListing([{ ...idleBackgroundEntry(SESSION_A), id: '99999999' }]);

  const result = await env.sessions.stop({ sessionId: SESSION_A });

  assert.notEqual(codeOf(result), 'stopped');
  assert.equal(env.exec.stops().length, 0, 'no stop call');
});

const STOP_FAILURES = {
  'exit code 1': { outcome: { exitCode: 1, stderr: 'stop failed' }, reason: 'stop_failed' },
  'a spawn error': { outcome: { spawnError: 'ENOENT' }, reason: 'stop_failed' },
  'a timeout': { outcome: { timeout: true }, reason: 'timed_out' },
};

for (const [label, { outcome, reason }] of Object.entries(STOP_FAILURES))
  test(`stop fails transiently as ${reason} on ${label} and is not retried`, async (t) => {
    const env = await sessionsEnvironment(t);
    env.exec.setListing([idleBackgroundEntry(SESSION_A)]);
    env.exec.onStop(() => outcome);

    const result = await env.sessions.stop({ sessionId: SESSION_A });

    assert.equal(result.status, 'failed-transient');
    assert.equal(codeOf(result), reason);
    assert.equal(env.exec.stops().length, 1, 'the stop was attempted once');
  });

for (const [label, outcome] of Object.entries(LISTING_FAILURES))
  test(`stop fails transiently as listing_unavailable when the fresh listing has ${label}`, async (t) => {
    const env = await sessionsEnvironment(t);
    env.exec.onListing(() => outcome);

    const result = await env.sessions.stop({ sessionId: SESSION_A });

    assert.equal(result.status, 'failed-transient');
    assert.equal(codeOf(result), 'listing_unavailable');
    assert.equal(env.exec.stops().length, 0, 'no stop call');
  });

test('stop takes a fresh listing before the stop call', async (t) => {
  const env = await sessionsEnvironment(t);
  env.exec.setListing([idleBackgroundEntry(SESSION_A)]);

  await env.sessions.stop({ sessionId: SESSION_A });

  assert.deepStrictEqual(callKinds(env.exec), ['agents', 'stop']);
  assertListingArgv(env.exec.calls[0]);
});

test('stop argv is a fixed claude stop with eight lowercase hex characters and no shell', async (t) => {
  const env = await sessionsEnvironment(t);
  env.exec.setListing([idleBackgroundEntry(SESSION_A)]);

  await env.sessions.stop({ sessionId: SESSION_A });

  assert.equal(env.exec.stops().length, 1);
  const [call] = env.exec.stops();
  assert.equal(path.basename(call.file), 'claude');
  assert.equal(call.args.length, 2, 'no element besides the subcommand and the id');
  assert.equal(call.args[0], 'stop');
  assert.match(call.args[1], /^[0-9a-f]{8}$/);
  assert.ok(!call.options.shell, 'no shell');
  assert.ok(Number.isFinite(call.options.timeout) && call.options.timeout > 0, 'a timeout');
  assert.ok(Number.isFinite(call.options.maxBuffer) && call.options.maxBuffer > 0, 'an output cap');
});

const INVALID_STOP_IDS = {
  'a string that is not a UUID': 'not-a-uuid',
  'an empty string': '',
  'a flag': '--help',
  'an uppercase UUID': 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
  'a UUID followed by a shell command': `${SESSION_A}; rm -rf /`,
  undefined: undefined,
  'a number': 42,
};

for (const [label, sessionId] of Object.entries(INVALID_STOP_IDS))
  test(`stop argv never reaches the CLI for ${label}`, async (t) => {
    const env = await sessionsEnvironment(t);
    env.exec.setListing([idleBackgroundEntry(SESSION_A)]);

    const result = await attemptStop(env.sessions, sessionId);

    assert.equal(env.exec.calls.length, 0, 'not even a listing is taken');
    if (result) assert.notEqual(codeOf(result), 'stopped');
  });

test('resume fallback spawns once with the exact argv from the listed cwd', async (t) => {
  const env = await sessionsEnvironment(t);
  const notice = `${NOTICE_PREFIX}${permalinkFor()}`;
  env.exec.setListing([finishedEntry(SESSION_A)]);

  const result = await env.sessions.resume({ sessionId: SESSION_A, notice });

  assert.deepStrictEqual(result, { status: 'delivered', reason: 'resumed' });
  assert.equal(env.exec.spawns().length, 1);
  assertSpawn(env.exec.spawns()[0], { sessionId: SESSION_A, notice, cwd: FINISHED_CWD });
  assert.ok(
    Number.isFinite(env.exec.spawns()[0].options.timeout) &&
      env.exec.spawns()[0].options.timeout > 0,
    'the spawn has a timeout',
  );
});

test('resume fallback takes a fresh listing before the spawn', async (t) => {
  const env = await sessionsEnvironment(t);
  env.exec.setListing([finishedEntry(SESSION_A)]);

  await env.sessions.resume({ sessionId: SESSION_A, notice: 'a notice' });

  assert.equal(env.exec.spawns().length, 1);
  assertListingArgv(env.exec.calls[0]);
  assert.equal(env.exec.calls[env.exec.calls.length - 1], env.exec.spawns()[0]);
});

for (const notice of ['-dash-leading notice', '--help', '-- x; rm -rf / $(id) "quoted"'])
  test(`resume fallback keeps the notice ${JSON.stringify(notice)} as the single element after --`, async (t) => {
    const env = await sessionsEnvironment(t);
    env.exec.setListing([finishedEntry(SESSION_A)]);

    const result = await env.sessions.resume({ sessionId: SESSION_A, notice });

    assert.deepStrictEqual(result, { status: 'delivered', reason: 'resumed' });
    assertSpawn(env.exec.spawns()[0], { sessionId: SESSION_A, notice, cwd: FINISHED_CWD });
  });

test('resume fallback delivers with reason not_listed and spawns nothing when a good listing lacks the session', async (t) => {
  const env = await sessionsEnvironment(t);
  env.exec.setListing([finishedEntry(SESSION_B)]);

  const result = await env.sessions.resume({ sessionId: SESSION_A, notice: 'a notice' });

  assert.deepStrictEqual(result, { status: 'delivered', reason: 'not_listed' });
  assert.equal(env.exec.spawns().length, 0);
});

test('resume fallback waits as live_at_resume when the listing now shows a pid', async (t) => {
  const env = await sessionsEnvironment(t);
  env.exec.setListing([finishedEntry(SESSION_A)]);
  const earlier = await env.sessions.listSessions();
  assert.equal(bySessionId(earlier.sessions)[SESSION_A].state, 'finished');
  env.exec.setListing([finishedEntry(SESSION_A, { pid: 4242 })]);

  const result = await env.sessions.resume({ sessionId: SESSION_A, notice: 'a notice' });

  assert.deepStrictEqual(result, { status: 'waiting', reason: 'live_at_resume' });
  assert.equal(env.exec.spawns().length, 0);
});

for (const status of ['idle', 'busy'])
  test(`resume fallback waits as live_at_resume without a spawn or a stop for a ${status} pid`, async (t) => {
    const env = await sessionsEnvironment(t);
    env.exec.setListing([finishedEntry(SESSION_A, { pid: 4242, status })]);

    const result = await env.sessions.resume({ sessionId: SESSION_A, notice: 'a notice' });

    assert.deepStrictEqual(result, { status: 'waiting', reason: 'live_at_resume' });
    assert.equal(env.exec.spawns().length, 0, 'nothing is spawned');
    assert.equal(env.exec.stops().length, 0, 'nothing is stopped');
  });

for (const [stream, outcome] of [
  ['stdout', { stdout: FORK_OUTPUT }],
  ['stderr', { stderr: FORK_OUTPUT }],
])
  test(`resume fallback fails permanently as resume_forked when ${stream} says it started a copy`, async (t) => {
    const lines = captureConsole(t);
    const env = await sessionsEnvironment(t);
    await attachSessions(env.store, [SESSION_A]);
    env.exec.setListing([finishedEntry(SESSION_A)]);
    env.exec.onResume(() => outcome);

    const result = await env.sessions.resume({ sessionId: SESSION_A, notice: 'a notice' });

    assert.deepStrictEqual(result, { status: 'failed-permanent', reason: 'resume_forked' });
    assert.equal(env.exec.spawns().length, 1, 'the spawn was attempted once and not retried');
    assert.deepStrictEqual(callKinds(env.exec), ['agents', '--bg'], 'the copy is left alone');
    assert.equal(JSON.stringify(result).includes(ERROR_SENTINEL), false, 'not returned');
    assert.deepEqual(
      lines.filter((line) => line.includes(ERROR_SENTINEL)),
      [],
      'not logged',
    );
    assert.deepEqual(findInTree(env.home, [ERROR_SENTINEL]), [], 'not stored');
  });

test('resume fallback delivers with reason resumed when the CLI says it woke the session', async (t) => {
  const env = await sessionsEnvironment(t);
  env.exec.setListing([finishedEntry(SESSION_A)]);
  env.exec.onResume(() => ({ stdout: 'woke session 11111111 with its saved options' }));

  const result = await env.sessions.resume({ sessionId: SESSION_A, notice: 'a notice' });

  assert.deepStrictEqual(result, { status: 'delivered', reason: 'resumed' });
  assert.equal(env.exec.spawns().length, 1);
});

for (const [label, outcome] of Object.entries(LISTING_FAILURES))
  test(`resume fallback fails transiently as listing_unavailable when the fresh listing has ${label}`, async (t) => {
    const env = await sessionsEnvironment(t);
    env.exec.onListing(() => outcome);

    const result = await env.sessions.resume({ sessionId: SESSION_A, notice: 'a notice' });

    assert.deepStrictEqual(result, { status: 'failed-transient', reason: 'listing_unavailable' });
    assert.equal(env.exec.spawns().length, 0);
  });

const RESUME_FAILURES = [
  {
    label: 'exit 1 with the untrusted workspace message on stderr',
    outcome: { exitCode: 1, stderr: UNTRUSTED_MESSAGE },
    expected: { status: 'failed-permanent', reason: 'untrusted_workspace' },
  },
  {
    label: 'exit 1 with the untrusted workspace message on stdout',
    outcome: { exitCode: 1, stdout: UNTRUSTED_MESSAGE },
    expected: { status: 'failed-permanent', reason: 'untrusted_workspace' },
  },
  {
    label: 'a spawn error',
    outcome: { spawnError: 'ENOENT' },
    expected: { status: 'failed-transient', reason: 'spawn_failed' },
  },
  {
    label: 'a timeout',
    outcome: { timeout: true },
    expected: { status: 'failed-transient', reason: 'timed_out' },
  },
  {
    label: 'exit 2 with unrelated text',
    outcome: { exitCode: 2, stderr: 'something unrelated went wrong' },
    expected: { status: 'failed-transient', reason: 'spawn_failed' },
  },
  {
    label: 'exit 1 with unrelated text',
    outcome: { exitCode: 1, stderr: 'something unrelated went wrong' },
    expected: { status: 'failed-transient', reason: 'spawn_failed' },
  },
];

for (const { label, outcome, expected } of RESUME_FAILURES)
  test(`resume fallback classifies ${label}`, async (t) => {
    const env = await sessionsEnvironment(t);
    env.exec.setListing([finishedEntry(SESSION_A)]);
    env.exec.onResume(() => outcome);

    const result = await env.sessions.resume({ sessionId: SESSION_A, notice: 'a notice' });

    assert.deepStrictEqual(result, expected);
    assert.equal(env.exec.spawns().length, 1, 'the spawn was attempted once and not retried');
  });

const LEAKY_FAILURES = {
  'an untrusted workspace exit': {
    exitCode: 1,
    stdout: ERROR_SENTINEL,
    stderr: `${UNTRUSTED_MESSAGE} ${ERROR_SENTINEL}`,
  },
  'an unrelated exit': { exitCode: 2, stdout: ERROR_SENTINEL, stderr: ERROR_SENTINEL },
  'a spawn error': () =>
    Promise.reject(Object.assign(new Error(ERROR_SENTINEL), { code: 'EACCES' })),
};

for (const [label, outcome] of Object.entries(LEAKY_FAILURES))
  test(`resume fallback never returns, logs or stores the error text of ${label}`, async (t) => {
    const lines = captureConsole(t);
    const env = await sessionsEnvironment(t);
    await attachSessions(env.store, [SESSION_A]);
    env.exec.setListing([finishedEntry(SESSION_A)]);
    env.exec.onResume(typeof outcome === 'function' ? outcome : () => outcome);

    const result = await env.sessions.resume({ sessionId: SESSION_A, notice: 'a notice' });

    assert.equal(result.status === 'delivered', false);
    assert.equal(JSON.stringify(result).includes(ERROR_SENTINEL), false, 'not returned');
    assert.deepEqual(
      lines.filter((line) => line.includes(ERROR_SENTINEL)),
      [],
      'not logged',
    );
    assert.deepEqual(findInTree(env.home, [ERROR_SENTINEL]), [], 'not stored');
  });

async function wakeFixture(t, { listing, sessionIds = [SESSION_A] }) {
  const f = await watchFixture(t, { sessions: 'real' });
  f.exec.setListing(listing);
  const key = await f.watch({ sessionIds, messages: [{ user: OTHER, ts: tsAt(-120) }] });
  f.threads.post(key, { user: OTHER, ts: tsAt(60) });
  // The watcher holds a finished session's first resume until the settle gap has passed.
  f.clock.advance(SETTLE_GAP_SECONDS * 1000);
  return { f, key };
}

const noticeFor = (f, key) => `${NOTICE_PREFIX}${f.entry(key).link}`;

test('resume fallback through the watcher wakes a finished session with a line and one spawn', async (t) => {
  const { f, key } = await wakeFixture(t, { listing: [finishedEntry(SESSION_A)] });

  await f.tick();

  const notice = noticeFor(f, key);
  assert.deepEqual(f.inboxLines(SESSION_A), [notice]);
  assert.equal(f.exec.spawns().length, 1);
  assertSpawn(f.exec.spawns()[0], { sessionId: SESSION_A, notice, cwd: FINISHED_CWD });
  assert.equal(f.delivery(key, SESSION_A)?.status, 'delivered');
});

test('resume fallback runs one spawn per session per tick when two links wake it', async (t) => {
  const { f, key } = await wakeFixture(t, { listing: [finishedEntry(SESSION_A)] });
  const secondKey = await f.watch({
    threadTs: SECOND_THREAD_TS,
    sessionIds: [SESSION_A],
    messages: [{ user: OTHER, ts: tsAt(-90) }],
  });
  // This link baselines after the settle advance, so its new message must be later still.
  f.threads.post(secondKey, { user: OTHER, ts: tsAt(SETTLE_GAP_SECONDS + 70) });

  await f.tick();

  const notices = [noticeFor(f, key), noticeFor(f, secondKey)];
  assert.deepEqual([...f.inboxLines(SESSION_A)].sort(), [...notices].sort());
  assert.equal(f.exec.spawns().length, 1, 'exactly one spawn for the session');
  assert.ok(notices.includes(f.exec.spawns()[0].args[4]), 'the spawn carries one rendered notice');
  assert.deepStrictEqual(f.exec.spawns()[0].args.slice(0, 4), [
    '--bg',
    '--resume',
    SESSION_A,
    '--',
  ]);
  assert.equal(f.exec.spawns()[0].options.cwd, FINISHED_CWD);
});

const INBOX_ONLY = {
  'a numeric pid': { listing: [finishedEntry(SESSION_A, { pid: 4242 })], listedLive: true },
  'a non-numeric pid': { listing: [finishedEntry(SESSION_A, { pid: '4242' })], listedLive: true },
  'a null pid': { listing: [finishedEntry(SESSION_A, { pid: null })], listedLive: true },
  'only a short id': {
    listing: [{ id: SESSION_A.slice(0, 8), name: 'short only', cwd: FINISHED_CWD, state: 'done' }],
    listedLive: false,
  },
};

for (const [label, { listing, listedLive }] of Object.entries(INBOX_ONLY))
  test(`a live session with no idle status gets only its line: ${label}`, async (t) => {
    const { f, key } = await wakeFixture(t, { listing });

    await f.tick();

    assert.equal(f.exec.spawns().length, 0, 'zero spawns');
    assert.deepEqual(f.inboxLines(SESSION_A), [noticeFor(f, key)], 'the line is appended');
    if (listedLive) {
      assert.equal(f.delivery(key, SESSION_A)?.status, 'delivered');
      assert.equal(f.delivery(key, SESSION_A)?.reason, 'inbox_only');
    }
  });

test('resume fallback never spawns again for a session shown with a pid after its resume', async (t) => {
  const { f, key } = await wakeFixture(t, { listing: [finishedEntry(SESSION_A)] });
  await f.tick();
  assert.equal(f.exec.spawns().length, 1);
  assert.equal(f.inboxLines(SESSION_A).length, 1);

  f.exec.setListing([finishedEntry(SESSION_A, { pid: 4242 })]);
  f.clock.advance(TICK_MS);
  f.threads.post(key, { user: OTHER, ts: tsAt(120) });
  await f.tick();

  assert.equal(f.exec.spawns().length, 1, 'no further spawn');
  assert.equal(f.inboxLines(SESSION_A).length, 2, 'the new message still appends a line');
  assert.equal(f.delivery(key, SESSION_A)?.reason, 'inbox_only');
});

test('resume fallback records an untrusted workspace as failed-permanent and never retries it', async (t) => {
  const { f, key } = await wakeFixture(t, { listing: [finishedEntry(SESSION_A)] });
  f.exec.onResume(() => ({ exitCode: 1, stderr: UNTRUSTED_MESSAGE }));

  await f.tick();

  assert.equal(f.exec.spawns().length, 1);
  assert.equal(f.inboxLines(SESSION_A).length, 1);
  assert.equal(f.delivery(key, SESSION_A)?.status, 'failed-permanent');
  assert.equal(f.delivery(key, SESSION_A)?.reason, 'untrusted_workspace');

  for (let later = 0; later < 3; later++) {
    f.clock.advance(TICK_MS);
    await f.tick();
  }

  assert.equal(f.exec.spawns().length, 1, 'no later tick spawns again');
  assert.equal(f.inboxLines(SESSION_A).length, 1, 'no later tick appends again');
  assert.equal(f.delivery(key, SESSION_A)?.status, 'failed-permanent');
  assert.equal(f.delivery(key, SESSION_A)?.reason, 'untrusted_workspace');
});

test('resume fallback through the watcher records a session absent from a good listing as delivered with reason not_listed', async (t) => {
  const { f, key } = await wakeFixture(t, { listing: [finishedEntry(SESSION_B)] });

  await f.tick();

  assert.equal(f.exec.spawns().length, 0, 'no spawn for a session nobody listed');
  assert.deepEqual(f.inboxLines(SESSION_A), [noticeFor(f, key)], 'the line is appended');
  assert.equal(f.delivery(key, SESSION_A)?.status, 'delivered');
  assert.equal(f.delivery(key, SESSION_A)?.reason, 'not_listed');
  assert.equal(
    f.entry(key).lastNotifiedTs,
    tsAt(60),
    'a not_listed session never holds the cursor',
  );
});

test('resume fallback through the watcher delivers with reason not_listed when the session leaves the listing before the spawn', async (t) => {
  const { f, key } = await wakeFixture(t, { listing: [finishedEntry(SESSION_A)] });
  let listingsTaken = 0;
  f.exec.onListing(() => ({
    stdout: JSON.stringify(++listingsTaken === 1 ? [finishedEntry(SESSION_A)] : []),
  }));

  await f.tick();

  assert.equal(f.exec.spawns().length, 0, 'no spawn once the fresh listing lacks the session');
  assert.equal(f.delivery(key, SESSION_A)?.status, 'delivered');
  assert.equal(f.delivery(key, SESSION_A)?.reason, 'not_listed');
});

test('resume fallback through the watcher records an unusable listing as failed-transient listing_unavailable after the line, then failed-permanent on the third failure', async (t) => {
  const { f, key } = await wakeFixture(t, { listing: [finishedEntry(SESSION_A)] });
  f.exec.onListing(() => ({ timeout: true }));
  const notice = noticeFor(f, key);

  await f.tick();
  assert.deepEqual(f.inboxLines(SESSION_A), [notice], 'the line is written before the failure');
  assert.equal(f.delivery(key, SESSION_A)?.status, 'failed-transient');
  assert.equal(f.delivery(key, SESSION_A)?.reason, 'listing_unavailable');
  assert.notEqual(f.entry(key).lastNotifiedTs, tsAt(60), 'the cursor waits for the retry');

  f.clock.advance(TICK_MS);
  await f.tick();
  assert.equal(f.delivery(key, SESSION_A)?.status, 'failed-transient');

  f.clock.advance(TICK_MS);
  await f.tick();
  assert.equal(f.delivery(key, SESSION_A)?.status, 'failed-permanent');
  assert.equal(f.delivery(key, SESSION_A)?.reason, 'listing_unavailable');
  assert.equal(f.entry(key).lastNotifiedTs, tsAt(60), 'the third failure lets the cursor advance');
  assert.deepEqual(f.inboxLines(SESSION_A), [notice], 'only the resume step was ever repeated');
  assert.equal(f.exec.spawns().length, 0, 'nothing is spawned without a usable listing');
});
