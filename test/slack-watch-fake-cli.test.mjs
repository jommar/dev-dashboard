// slack-watch-fake-cli.test.mjs — the stateful fake claude CLI the wake tests stand on: stop clears
// the pid, a resume inside the settle window forks a copy under a new id, and one after it continues
// the same id. These pin the fake itself, so a wake test that passes cannot be passing over a CLI that
// forgives a premature resume.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLI_OUTPUT_SENTINELS,
  FORK_SENTENCE,
  SESSION_A,
  SESSION_B,
  SESSION_C,
  SESSION_D,
  TRAP_WINDOW_MS,
  createClock,
  createFakeCli,
  createFakeSessions,
  flush,
  listingEntry,
  watchFixture,
} from './slack-watch-fixture.mjs';

const SHORT_A = SESSION_A.slice(0, 8);

function runCli(cli, args) {
  return new Promise((resolve) =>
    cli.execFileImpl('claude', args, {}, (error, stdout, stderr) =>
      resolve({ error, stdout, stderr }),
    ),
  );
}

const stopSession = (cli, sessionId) => runCli(cli, ['stop', sessionId.slice(0, 8)]);
const resumeSession = (cli, sessionId) =>
  runCli(cli, ['--bg', '--resume', sessionId, '--', 'a notice']);
const readListing = async (cli) =>
  JSON.parse((await runCli(cli, ['agents', '--json', '--all'])).stdout);

function idleSessionCli() {
  const clock = createClock();
  const cli = createFakeCli({ clock });
  cli.add(SESSION_A);
  return { clock, cli };
}

test('fake cli: a resume 9 s after a stop forks a copy under a new id with the real wording', async () => {
  const { clock, cli } = idleSessionCli();
  await stopSession(cli, SESSION_A);
  clock.advance(9_000);

  const { error, stdout } = await resumeSession(cli, SESSION_A);

  assert.equal(error, null, 'a fork exits 0');
  assert.ok(stdout.includes(FORK_SENTENCE), 'the fork wording');
  assert.ok(stdout.includes(`session ${SHORT_A} is already running`), 'names the parent');
  assert.equal(cli.entryCount(), 2, 'a copy is listed');
  assert.equal(cli.forks.length, 1);
  assert.equal(cli.forks[0].sessionId, SESSION_A);
  assert.notEqual(cli.forks[0].copyId, SESSION_A);
  assert.ok(stdout.includes(`started a copy as ${cli.forks[0].copyId.slice(0, 8)}`));
  assert.ok(stdout.includes(CLI_OUTPUT_SENTINELS.forkName), 'the fork prints a session name');
  assert.equal(cli.session(SESSION_A).live, false, 'the stopped session did not come back');
  assert.deepEqual(
    cli.resumes.map(({ outcome }) => outcome),
    ['forked'],
  );
});

test('fake cli: a resume 10 s after a stop continues the same id with a new pid and no new entry', async () => {
  const { clock, cli } = idleSessionCli();
  const pidBefore = cli.session(SESSION_A).pid;
  await stopSession(cli, SESSION_A);
  clock.advance(TRAP_WINDOW_MS);

  const { error, stdout } = await resumeSession(cli, SESSION_A);

  assert.equal(error, null);
  assert.ok(stdout.includes(`woke session ${SHORT_A}`), 'the continue wording');
  assert.equal(stdout.includes('started a copy'), false);
  assert.equal(cli.entryCount(), 1, 'the entry count is unchanged');
  assert.equal(cli.forks.length, 0);
  const after = cli.session(SESSION_A);
  assert.equal(after.live, true);
  assert.equal(typeof after.pid, 'number');
  assert.notEqual(after.pid, pidBefore, 'a new process');
  assert.deepEqual(
    cli.resumes.map(({ outcome }) => outcome),
    ['continued'],
  );
});

test('fake cli: a resume while the session is live forks a copy', async () => {
  const { cli } = idleSessionCli();

  const { error, stdout } = await resumeSession(cli, SESSION_A);

  assert.equal(error, null);
  assert.ok(stdout.includes(FORK_SENTENCE));
  assert.equal(cli.entryCount(), 2);
  assert.equal(cli.session(SESSION_A).live, true, 'the original keeps running');
});

test('fake cli: a session that finished without a stop resumes at once under its own id', async () => {
  const { cli } = idleSessionCli();
  cli.finish(SESSION_A);

  const { stdout } = await resumeSession(cli, SESSION_A);

  assert.ok(stdout.includes(`woke session ${SHORT_A}`));
  assert.equal(cli.entryCount(), 1);
  assert.equal(cli.forks.length, 0);
});

test('fake cli: the trap window is the fake CLI own setting, longer than any settle gap can be', async () => {
  const { clock, cli } = idleSessionCli();
  cli.trapWindowMs = 10 * 60_000;
  await stopSession(cli, SESSION_A);
  clock.advance(5 * 60_000);

  const { stdout } = await resumeSession(cli, SESSION_A);

  assert.ok(stdout.includes(FORK_SENTENCE));
  assert.equal(cli.forks.length, 1);
});

test('fake cli: the listing prints idle, busy and finished sessions in the CLI shape', async () => {
  const cli = createFakeCli({ clock: createClock() });
  cli.add(SESSION_A, { status: 'idle' });
  cli.add(SESSION_B, { status: 'busy' });
  cli.add(SESSION_C, { status: null });
  cli.add(SESSION_D, { kind: 'interactive', status: 'idle' });

  const entries = Object.fromEntries(
    (await readListing(cli)).map((entry) => [entry.sessionId, entry]),
  );

  assert.deepEqual(
    [entries[SESSION_A].kind, entries[SESSION_A].state, entries[SESSION_A].status],
    ['background', 'done', 'idle'],
  );
  assert.equal(typeof entries[SESSION_A].pid, 'number');
  assert.deepEqual(
    [entries[SESSION_B].kind, entries[SESSION_B].state, entries[SESSION_B].status],
    ['background', 'working', 'busy'],
  );
  assert.equal(typeof entries[SESSION_B].pid, 'number');
  assert.equal('pid' in entries[SESSION_C], false, 'a finished session has no pid');
  assert.equal(entries[SESSION_C].status, null);
  assert.equal(entries[SESSION_C].state, 'done');
  assert.equal(entries[SESSION_D].kind, 'interactive');
  assert.equal(typeof entries[SESSION_D].pid, 'number');
  for (const [sessionId, entry] of Object.entries(entries))
    assert.equal(entry.id, sessionId.slice(0, 8), 'the short id is the first 8 characters');
});

test('fake cli: a stop clears the pid and keeps the entry, and stopping a stopped session exits 1', async () => {
  const { cli } = idleSessionCli();

  const first = await stopSession(cli, SESSION_A);

  assert.equal(first.error, null);
  assert.ok(first.stdout.startsWith(`stopped ${SHORT_A}`));
  assert.ok(first.stdout.includes(CLI_OUTPUT_SENTINELS.stop), 'the stop prints text of its own');
  const [entry] = await readListing(cli);
  assert.equal('pid' in entry, false);
  assert.equal(entry.status, null);
  assert.equal(cli.stops.length, 1);
  assert.equal(cli.stops[0].sessionId, SESSION_A);

  const second = await stopSession(cli, SESSION_A);

  assert.equal(second.error.code, 1);
  assert.equal(cli.stops.length, 1, 'only an effective stop is counted');
});

test('fake cli: a stop is its own call kind, apart from listings and resume spawns', async () => {
  const { cli } = idleSessionCli();

  await readListing(cli);
  await stopSession(cli, SESSION_A);
  await resumeSession(cli, SESSION_A);

  assert.equal(cli.exec.listings().length, 1);
  assert.equal(cli.exec.stops().length, 1);
  assert.deepEqual(cli.exec.stops()[0].args, ['stop', SHORT_A]);
  assert.equal(cli.exec.spawns().length, 1, 'the stop is not counted as a resume spawn');
});

test('fake cli: a session it was never given resumes like the plain exec double', async () => {
  const cli = createFakeCli({ clock: createClock() });

  const { error, stdout } = await resumeSession(cli, SESSION_A);

  assert.equal(error, null);
  assert.equal(stdout, 'backgrounded');
  assert.equal(cli.resumes.length, 0);
  assert.equal(cli.entryCount(), 0);
});

test('fake cli: an override changes what the listing prints and nothing about the session', async () => {
  const { cli } = idleSessionCli();
  cli.override(SESSION_A, { status: undefined });

  const [withoutStatus] = await readListing(cli);

  assert.equal('status' in withoutStatus, false, 'a live entry with no status key');
  assert.equal(typeof withoutStatus.pid, 'number');
  assert.equal(cli.session(SESSION_A).status, 'idle', 'the session itself is still idle');

  cli.override(SESSION_A, { pid: '4242' });
  const [withTextPid] = await readListing(cli);
  assert.equal(withTextPid.pid, '4242');
});

test('fake cli: failNext fails the next calls of one kind and hold waits for its release', async () => {
  const { cli } = idleSessionCli();
  cli.failNext('stop', { exitCode: 1, stderr: 'refused' }, 2);

  const outcomes = [];
  for (let attempt = 0; attempt < 3; attempt++)
    outcomes.push((await stopSession(cli, SESSION_A)).error?.code ?? 0);
  assert.deepEqual(outcomes, [1, 1, 0], 'two injected failures, then the real stop');
  assert.equal(cli.stops.length, 1);

  const hold = cli.hold('listing');
  let listed = false;
  const pending = readListing(cli).then(() => {
    listed = true;
  });
  await flush();
  assert.equal(listed, false, 'the listing waits for the hold');
  hold.release();
  await pending;
  assert.equal(listed, true);
});

test('fake cli: watchFixture with real sessions runs the CLI on the fixture clock', async (t) => {
  const f = await watchFixture(t, { sessions: 'real' });
  f.cli.add(SESSION_A);
  assert.equal(f.exec, f.cli.exec, 'the fixture exec is the one the CLI answers');

  await stopSession(f.cli, SESSION_A);
  f.clock.advance(9_000);
  await resumeSession(f.cli, SESSION_A);
  assert.equal(f.cli.forks.length, 1, 'inside the window on the fixture clock');

  f.clock.advance(11_000);
  await resumeSession(f.cli, SESSION_A);
  assert.equal(f.cli.forks.length, 1, 'after the window the same id continues');
  assert.deepEqual(
    f.cli.resumes.map(({ outcome }) => outcome),
    ['forked', 'continued'],
  );

  const plain = await watchFixture(t);
  assert.equal(plain.cli, null, 'no stateful CLI without real sessions');
});

test('fake cli: the sessions double passes activity through and records stop calls', async () => {
  const sessions = createFakeSessions();
  sessions.setSessions([
    { sessionId: SESSION_A, state: 'live', activity: 'idle' },
    { sessionId: SESSION_B, state: 'live' },
    { sessionId: SESSION_C, state: 'finished' },
  ]);

  const listed = await sessions.listSessions();
  assert.deepEqual(
    listed.sessions.map(({ activity }) => activity),
    ['idle', null, null],
  );

  sessions.setSessions([{ sessionId: SESSION_A, state: 'live', activity: 'idle' }], 'map');
  const mapListed = await sessions.listSessions();
  assert.equal('activity' in mapListed.sessions[0], false, 'a map listing carries no activity');

  assert.deepEqual(await sessions.stop({ sessionId: SESSION_A }), { status: 'stopped' });
  sessions.onStop(SESSION_A, { status: 'failed-transient', reason: 'stop_failed' });
  assert.deepEqual(await sessions.stop({ sessionId: SESSION_A }), {
    status: 'failed-transient',
    reason: 'stop_failed',
  });
  assert.deepEqual(sessions.stopCalls, [{ sessionId: SESSION_A }, { sessionId: SESSION_A }]);
});

test('fake cli: a listing entry has a status only when one is given and a kind that defaults to background', () => {
  const plain = listingEntry({ sessionId: SESSION_A, pid: 4242 });
  assert.equal('status' in plain, false);
  assert.equal(plain.kind, 'background');

  const idle = listingEntry({
    sessionId: SESSION_A,
    pid: 4242,
    status: 'idle',
    kind: 'interactive',
  });
  assert.equal(idle.status, 'idle');
  assert.equal(idle.kind, 'interactive');

  const finished = listingEntry({ sessionId: SESSION_A, status: null });
  assert.equal(finished.status, null);
  assert.equal('pid' in finished, false);
});
