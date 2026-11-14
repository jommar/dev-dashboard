// claude-chat.test.mjs — the chat module (`createClaudeChat`): standalone chats and their record,
// a turn as one CLI process per message, the one-writer rules, history then live events on a stream,
// Stop, and the guards on the spawn and the log. The CLI is an injected `spawn` double and the
// sessions module is a double (one test runs the real one); nothing real runs.
//
// Interface these tests fix:
//   createClaudeChat({ claudeSessions, spawn, stateDir, home, fs, now, timers, log })
//     -> { list, send, stop, open, close }, no IO at construction
//   send({ message, session? })  -> { ok: true, session, chat }       (chat is null for a listed session)
//   stop({ session })            -> { ok: true }
//   open({ session, sink })      -> { drained(), close() }            (hello is the first thing sent)
//   list()                       -> [chat]                            (spec "public form", newest first)
// A refusal is an Error with `code`, `status` and `errors: [reason]`, like the launcher's.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  BASE_ARGS,
  SECRET_NAMES,
  STOP_GRACE_MS,
  UUID_1,
  UUID_2,
  UUID_3,
  UUID_4,
  UUID_5,
  UUID_6,
  UUID_SHAPE,
  assistantTextLine,
  chatEnvironment,
  createFakeSpawn,
  flush,
  initLine,
  resultLine,
  scratchDir,
  tAssistant,
  tText,
  tToolResult,
  tToolUse,
  tUser,
  textDeltaLine,
  throughTimers,
  toolResultLine,
  toolUseLine,
} from './claude-chat-fixture.mjs';
import {
  createFakeExec,
  listingEntry,
  START_MS as SLACK_START_MS,
} from './slack-watch-fixture.mjs';

const POLL_LIMIT = 30;

const refused = (reason) => ({ code: 'CLAUDE_REFUSED', status: 409, errors: [reason] });
const failedWith = (reason) => ({ code: 'CLAUDE_FAILED', status: 502, errors: [reason] });

// A listed session as `claude agents --json --all` prints it.
const entry = (sessionId, extra = {}) => ({
  id: sessionId.slice(0, 8),
  sessionId,
  name: 'TAP-1-implement-plan',
  cwd: '/work/ticket-session',
  kind: 'background',
  startedAt: SLACK_START_MS,
  state: 'done',
  status: null,
  ...extra,
});
const idleEntry = (sessionId, extra = {}) =>
  entry(sessionId, { status: 'idle', pid: 4242, ...extra });
const workingEntry = (sessionId, extra = {}) =>
  entry(sessionId, { state: 'working', status: 'busy', pid: 4242, ...extra });

// Starts a turn and hands back its child process.
async function startTurn(env, body) {
  const result = await env.chat.send(body);
  return { result, child: env.spawner.last().child };
}
const userLine = (text) =>
  `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`;

// ---- scenario 1: a first message starts a standalone chat ----

test('scenario 1: a first message creates the record, spawns the CLI with --session-id, and ends the turn on close', async (t) => {
  const env = await chatEnvironment(t);
  const { result, child } = await startTurn(env, { message: 'hello\nmore' });

  assert.equal(result.ok, true);
  assert.match(result.session, UUID_SHAPE);
  assert.equal(result.chat.id, result.session);
  assert.equal(result.chat.title, 'hello');
  assert.equal(result.chat.state, 'working');
  assert.equal(result.chat.goTo, null, 'no way to join while it works');

  const record = env.record(result.session);
  assert.deepEqual(
    [record.id, record.title, record.cwd, record.lastOutcome],
    [result.session, 'hello', env.pathwise, null],
  );
  assert.ok(Number.isFinite(Date.parse(record.createdAt)));
  assert.ok(Number.isFinite(Date.parse(record.lastTurnAt)));
  assert.deepEqual(env.records(), [`${result.session}.json`], 'one record, named by the id');

  assert.equal(env.spawner.calls.length, 1);
  const call = env.spawner.calls[0];
  assert.equal(path.basename(call.command), 'claude');
  assert.deepEqual(call.args, [...BASE_ARGS, '--session-id', result.session]);
  assert.equal(call.options.cwd, env.pathwise);
  assert.equal(
    child.stdinText(),
    userLine('hello\nmore'),
    'the message is one stdin line, newline kept',
  );

  const { sink } = await env.openStream(result.session);
  const hello = sink.messages[0];
  assert.equal(hello.event, 'hello', 'hello is first');
  assert.equal(hello.payload.state, 'working');
  assert.equal(hello.payload.live, true);
  assert.equal(hello.payload.kind, 'chat');
  assert.deepEqual(
    hello.payload.items.map((item) => [item.kind, item.text]),
    [['user', 'hello\nmore']],
  );

  await child.emitLine(initLine(result.session));
  await child.emitLine(resultLine());
  assert.equal(child.stdinEnded(), true, 'stdin is closed on the first result');
  assert.equal(sink.last('state'), undefined, 'the turn is not over before the process closes');
  await child.close(0);

  assert.deepEqual(sink.last('state'), {
    state: 'idle',
    turn: { outcome: 'completed', reason: null, error: null, denials: [], costUsd: 0.12 },
  });
  assert.equal(env.record(result.session).lastOutcome, 'completed');
  assert.deepEqual(env.sessions.released, [result.session], 'the one-writer mark is let go');
  const [chat] = await env.chat.list();
  assert.deepEqual(
    [chat.state, chat.goTo],
    ['done', { kind: 'resume', command: `cd ~/pathwise && claude --resume ${result.session}` }],
  );
});

test('scenario 1: the title is the first line, whitespace collapsed, at most 60 characters', async (t) => {
  const env = await chatEnvironment(t);
  const long = await env.chat.send({ message: `  ${'word  '.repeat(40)}\nsecond line` });
  assert.equal(env.record(long.session).title.length, 60);
  assert.doesNotMatch(env.record(long.session).title, /\s{2}|second/);
  const spaced = await env.chat.send({ message: 'a \t b   c\nnext' });
  assert.equal(env.record(spaced.session).title, 'a b c');
});

test('scenario 1: what the CLI says reaches an open stream as delta, item and state events, and the turn is remembered', async (t) => {
  const env = await chatEnvironment(t);
  const { result, child } = await startTurn(env, { message: 'read it' });
  const { sink } = await env.openStream(result.session);
  sink.messages.length = 0;

  await child.emitLine(initLine(result.session));
  await child.emitLine(textDeltaLine('Hel'));
  await child.emitLine(textDeltaLine('lo'));
  await child.emitLine(assistantTextLine('a-1', 'Hello'));
  await child.emitLine(toolUseLine('a-2', 'toolu_1', 'Read', { file_path: '/work/a' }));
  await child.emitLine(toolResultLine('toolu_1', 'text', false));
  await child.emitLine(textDeltaLine('x', { parent_tool_use_id: 'toolu_1' }));
  await child.emitLine(resultLine({ denials: ['Write'] }));
  await child.close(0);

  assert.deepEqual(sink.events(), ['delta', 'delta', 'item', 'item', 'item', 'state']);
  assert.deepEqual(sink.of('delta'), [{ text: 'Hel' }, { text: 'lo' }]);
  const items = sink.of('item').map(({ item }) => item);
  assert.deepEqual(items[0], { id: 'a-1', kind: 'assistant', text: 'Hello' });
  assert.deepEqual([items[1].id, items[1].result], ['toolu_1', null]);
  assert.deepEqual(items[2].result, { text: 'text', isError: false });
  assert.deepEqual(sink.last('state').turn.denials, ['Write']);

  const again = await env.openStream(result.session);
  const hello = again.sink.messages[0].payload;
  assert.equal(hello.state, 'idle');
  assert.equal(hello.live, false);
  assert.equal(hello.turn.outcome, 'completed', 'the last finished turn is in hello');
  assert.equal(
    hello.items.some((item) => item.id === 'a-1'),
    false,
    'the live buffer is discarded when the turn ends; history comes from the transcript',
  );
});

test('scenario 1: a process that exits without a result is a failed turn, reason exited, and the record says failed', async (t) => {
  const env = await chatEnvironment(t);
  const { result, child } = await startTurn(env, { message: 'go' });
  const { sink } = await env.openStream(result.session);
  await child.close(1);
  assert.deepEqual(sink.last('state').turn.outcome, 'failed');
  assert.equal(sink.last('state').turn.reason, 'exited');
  assert.equal(env.record(result.session).lastOutcome, 'failed');
  assert.equal((await env.chat.list())[0].state, 'failed');
});

test('scenario 1: a CLI that cannot start is 502 spawn_failed, leaves nothing held and the next send works', async (t) => {
  const env = await chatEnvironment(t);
  env.spawner.failWith();
  await assert.rejects(env.chat.send({ message: 'hello' }), failedWith('spawn_failed'));
  assert.equal(env.sessions.held.size, 0);
  const next = await env.chat.send({ message: 'hello again' });
  assert.equal(next.ok, true);
});

test('scenario 10: the list holds valid standalone records newest first, with their state, and skips bad files', async (t) => {
  const env = await chatEnvironment(t);
  env.seedRecord(UUID_1, {
    title: 'older',
    lastTurnAt: new Date(SLACK_START_MS - 5_000).toISOString(),
  });
  env.seedRecord(UUID_2, {
    title: 'newer failed',
    lastTurnAt: new Date(SLACK_START_MS - 1_000).toISOString(),
    lastOutcome: 'failed',
  });
  // not records: a name that is not the id, a wrong type, a stray file
  fs.writeFileSync(
    path.join(env.recordsDir, `${UUID_3}.json`),
    JSON.stringify({ id: UUID_4, title: 'x', cwd: env.pathwise, createdAt: 'x', lastTurnAt: 'x' }),
  );
  fs.writeFileSync(
    path.join(env.recordsDir, `${UUID_5}.json`),
    JSON.stringify({ id: UUID_5, title: 7, cwd: env.pathwise }),
  );
  fs.writeFileSync(path.join(env.recordsDir, 'notes.txt'), 'hello');

  const chats = await env.chat.list();
  assert.deepEqual(
    chats.map((chat) => [chat.id, chat.title, chat.state]),
    [
      [UUID_2, 'newer failed', 'failed'],
      [UUID_1, 'older', 'done'],
    ],
  );
  for (const chat of chats) {
    assert.deepEqual(Object.keys(chat).sort(), [
      'createdAt',
      'goTo',
      'id',
      'lastActiveAt',
      'state',
      'title',
    ]);
    assert.equal(chat.goTo.kind, 'resume');
  }
});

// ---- scenario 2: a second message continues the same session ----

test('scenario 2: a message to a standalone chat with a transcript spawns --resume, not --session-id, and writes no new record', async (t) => {
  const env = await chatEnvironment(t);
  env.seedRecord(UUID_1);
  env.writeTranscript(UUID_1, [tUser('u1', null, 'q'), tAssistant('a1', 'u1', [tText('a')])]);
  const before = env.record(UUID_1);

  const { result } = await startTurn(env, { session: UUID_1, message: 'and again' });

  assert.equal(result.session, UUID_1);
  assert.equal(result.chat.id, UUID_1);
  assert.deepEqual(env.spawner.last().args, [...BASE_ARGS, '--resume', UUID_1]);
  assert.equal(env.spawner.last().args.includes('--session-id'), false);
  assert.equal(env.spawner.last().options.cwd, before.cwd, 'the record decides the directory');
  assert.deepEqual(env.records(), [`${UUID_1}.json`]);
  const after = env.record(UUID_1);
  assert.deepEqual(
    [after.id, after.title, after.createdAt],
    [before.id, before.title, before.createdAt],
  );
  assert.equal(after.lastOutcome, null, 'the new turn is in flight');
});

// ---- scenario 3: an idle ticket session is continued, not copied ----

test('scenario 3: an idle listed session is stopped, polled until it has no pid, and only then resumed in its own directory', async (t) => {
  const env = await chatEnvironment(t);
  env.sessions.setEntries([idleEntry(UUID_2)]);
  env.sessions.liveAfterStop(2);

  const result = await throughTimers(env, env.chat.send({ session: UUID_2, message: 'continue' }));

  assert.equal(result.session, UUID_2);
  assert.equal(result.chat, null, 'a listed session has no standalone chat');
  const events = env.sessions.events;
  assert.deepEqual(env.sessions.stops(), [`stop:${UUID_2}`], 'one stop');
  const stopAt = events.indexOf(`stop:${UUID_2}`);
  const spawnAt = events.indexOf('spawn');
  assert.ok(spawnAt > stopAt, 'the spawn comes after the stop');
  const reads = events.slice(stopAt, spawnAt).filter((event) => event === 'entries:fresh');
  assert.ok(
    reads.length >= 3,
    'it read the listing until the pid was gone (two live reads, then none)',
  );
  assert.deepEqual(env.spawner.last().args, [...BASE_ARGS, '--resume', UUID_2]);
  assert.equal(env.spawner.last().options.cwd, '/work/ticket-session');
  assert.deepEqual(env.records(), [], 'no standalone record for a listed session');
});

test('scenario 3: a finished session with no pid is resumed with no stop', async (t) => {
  const env = await chatEnvironment(t);
  env.sessions.setEntries([entry(UUID_2)]);
  await env.chat.send({ session: UUID_2, message: 'continue' });
  assert.deepEqual(env.sessions.stops(), []);
  assert.deepEqual(env.spawner.last().args, [...BASE_ARGS, '--resume', UUID_2]);
});

test('scenario 3: a session still live after the poll limit is 502 live_at_resume, never spawned, and its mark is let go', async (t) => {
  const env = await chatEnvironment(t);
  env.sessions.setEntries([idleEntry(UUID_2)]);
  env.sessions.liveAfterStop(Infinity);

  await assert.rejects(
    throughTimers(env, env.chat.send({ session: UUID_2, message: 'continue' })),
    failedWith('live_at_resume'),
  );
  assert.equal(env.spawner.calls.length, 0);
  assert.equal(env.sessions.held.size, 0);
  const waits = env.sessions.events.filter((event) => event === 'entries:fresh').length;
  assert.ok(waits <= POLL_LIMIT + 3, 'it gave up at the launcher limit');
});

test('scenario 3: an unknown session is refused session_not_found, and an unreadable listing is 502 listing_unavailable', async (t) => {
  const env = await chatEnvironment(t);
  env.sessions.setEntries([entry(UUID_2)]);
  await assert.rejects(
    env.chat.send({ session: UUID_6, message: 'hi' }),
    refused('session_not_found'),
  );
  env.sessions.failListing();
  await assert.rejects(
    env.chat.send({ session: UUID_2, message: 'hi' }),
    failedWith('listing_unavailable'),
  );
  assert.equal(env.spawner.calls.length, 0);
  assert.equal(env.sessions.held.size, 0);
});

test('scenario 3: with the real sessions module, the chat does not take its own mark for work elsewhere', async (t) => {
  const { createClaudeSessions } = await import('../backend/claude-sessions.mjs');
  const exec = createFakeExec();
  exec.setListing([
    listingEntry({ sessionId: UUID_2, cwd: '/work/ticket-session', state: 'done' }),
  ]);
  const real = createClaudeSessions({
    execFileImpl: exec.execFileImpl,
    store: { snapshot: () => ({ links: {} }) },
    projectsDir: path.join(scratchDir(t, 'real-sessions-'), 'projects'),
  });
  const env = await chatEnvironment(t, { claudeSessions: real });

  await env.chat.send({ session: UUID_2, message: 'continue' });
  assert.equal(env.spawner.calls.length, 1, 'the turn started');
  assert.equal(
    (await real.entries({ fresh: true })).find((found) => found.sessionId === UUID_2).state,
    'working',
    'the turn shows as work in progress to everyone else',
  );
  await env.spawner.last().child.close(0);
  assert.equal(
    (await real.entries({ fresh: true })).find((found) => found.sessionId === UUID_2).state,
    'done',
  );
});

// ---- scenario 4: a session working elsewhere is never written to ----

test('scenario 4: a session working outside the chat is refused session_running, with no stop and no spawn', async (t) => {
  const env = await chatEnvironment(t);
  env.sessions.setEntries([workingEntry(UUID_2)]);

  await assert.rejects(
    env.chat.send({ session: UUID_2, message: 'hi' }),
    refused('session_running'),
  );

  assert.deepEqual(env.sessions.stops(), []);
  assert.equal(env.spawner.calls.length, 0);
  assert.equal(env.sessions.held.size, 0, 'a refusal leaves no mark');
});

test('scenario 4: a live session that is not idle when stopped is refused session_running with no spawn', async (t) => {
  const env = await chatEnvironment(t);
  env.sessions.setEntries([idleEntry(UUID_2, { status: 'busy' })]);
  await assert.rejects(
    env.chat.send({ session: UUID_2, message: 'hi' }),
    refused('session_running'),
  );
  assert.equal(env.spawner.calls.length, 0);
});

test('scenario 4: a stream on a session working elsewhere says state working, live false, with its history and listing name', async (t) => {
  const env = await chatEnvironment(t);
  env.sessions.setEntries([workingEntry(UUID_2)]);
  env.writeTranscript(UUID_2, [
    tUser('u1', null, 'question'),
    tAssistant('a1', 'u1', [tText('answer')]),
  ]);

  const { sink } = await env.openStream(UUID_2);

  const hello = sink.messages[0];
  assert.equal(hello.event, 'hello');
  assert.deepEqual(
    [
      hello.payload.session,
      hello.payload.kind,
      hello.payload.title,
      hello.payload.state,
      hello.payload.live,
    ],
    [UUID_2, 'session', 'TAP-1-implement-plan', 'working', false],
  );
  assert.deepEqual(
    hello.payload.items.map((item) => item.text),
    ['question', 'answer'],
  );
  assert.equal(hello.payload.truncated, false);
  assert.equal(hello.payload.turn, null);
  assert.equal(env.spawner.calls.length, 0, 'watching never writes to it');
});

// ---- scenario 5: one turn at a time ----

test('scenario 5: a second send on a chat with a turn in flight is refused chat_busy and spawns nothing', async (t) => {
  const env = await chatEnvironment(t);
  const { result } = await startTurn(env, { message: 'first' });
  await assert.rejects(
    env.chat.send({ session: result.session, message: 'second' }),
    refused('chat_busy'),
  );
  assert.equal(env.spawner.calls.length, 1);
});

test('scenario 5: a fifth turn while four are in flight is refused too_many_turns, and a place frees when one ends', async (t) => {
  const env = await chatEnvironment(t);
  for (const index of [1, 2, 3, 4]) await env.chat.send({ message: `chat ${index}` });
  await assert.rejects(env.chat.send({ message: 'chat 5' }), refused('too_many_turns'));
  assert.equal(env.spawner.calls.length, 4);

  await env.spawner.calls[0].child.close(0);
  const fifth = await env.chat.send({ message: 'chat 5' });
  assert.equal(fifth.ok, true);
  assert.equal(env.spawner.calls.length, 5);
});

// ---- scenario 7: history first, then the live turn, with nothing twice ----

test('scenario 7: a stream opens with the newest branch of the transcript, the tool result inside its tool item, and no synthetic line', async (t) => {
  const env = await chatEnvironment(t);
  env.seedRecord(UUID_1, { title: 'seeded chat' });
  env.writeTranscript(UUID_1, [
    tUser('u1', null, 'first'),
    tAssistant('a1', 'u1', [tToolUse('toolu_1', 'Read', { file_path: '/a' })]),
    tToolResult('r1', 'a1', 'toolu_1', 'contents', false),
    tUser('u-old', 'r1', 'abandoned branch'),
    tAssistant('a-old', 'u-old', [tText('abandoned answer')]),
    tAssistant('a2', 'r1', [tText('No response requested.')], {
      message: {
        role: 'assistant',
        model: '<synthetic>',
        content: [tText('No response requested.')],
      },
    }),
    tAssistant('a3', 'a2', [tText('the answer')]),
  ]);

  const { sink } = await env.openStream(UUID_1);

  const hello = sink.messages[0].payload;
  assert.deepEqual(
    [hello.session, hello.kind, hello.title, hello.state, hello.live, hello.turn, hello.truncated],
    [UUID_1, 'chat', 'seeded chat', 'idle', false, null, false],
  );
  assert.deepEqual(
    hello.items.map((item) => item.kind),
    ['user', 'tool', 'assistant'],
  );
  assert.deepEqual(hello.items[1].result, { text: 'contents', isError: false });
  assert.deepEqual([hello.items[0].text, hello.items[2].text], ['first', 'the answer']);
});

test('scenario 7: a stream on a chat with no transcript yet has no items', async (t) => {
  const env = await chatEnvironment(t);
  env.seedRecord(UUID_1);
  const { sink } = await env.openStream(UUID_1);
  assert.deepEqual(sink.messages[0].payload.items, []);
});

test('scenario 7: a second stream opened mid-turn lists each item of the turn once, after the history, though its lines are already in the file', async (t) => {
  const env = await chatEnvironment(t);
  env.seedRecord(UUID_1);
  const file = env.writeTranscript(UUID_1, [
    tUser('u1', null, 'old question'),
    tAssistant('a1', 'u1', [tText('old answer')]),
  ]);
  const { child } = await startTurn(env, { session: UUID_1, message: 'new question' });
  // the CLI writes the turn into the transcript as it goes, and says the same on stdout
  env.appendTranscript(file, [
    tUser('u2', 'a1', 'new question'),
    tAssistant('a2', 'u2', [tText('new answer')]),
  ]);
  await child.emitLine(assistantTextLine('a2', 'new answer'));

  const first = await env.openStream(UUID_1);
  const second = await env.openStream(UUID_1);

  for (const { sink } of [first, second]) {
    const hello = sink.messages[0].payload;
    assert.equal(hello.live, true);
    assert.equal(hello.state, 'working');
    assert.deepEqual(
      hello.items.map((item) => item.text),
      ['old question', 'old answer', 'new question', 'new answer'],
      'history, then the turn, each once',
    );
  }
  await child.emitLine(assistantTextLine('a3', 'more'));
  assert.deepEqual(
    first.sink.of('item').map(({ item }) => item.id),
    ['a3'],
  );
});

// ---- scenario 9: Stop ----

test('scenario 9: Stop sends SIGINT, and the turn ends stopped on its aborted result and close; a later send is accepted', async (t) => {
  const env = await chatEnvironment(t);
  const { result, child } = await startTurn(env, { message: 'long task' });
  const { sink } = await env.openStream(result.session);

  assert.deepEqual(await env.chat.stop({ session: result.session }), { ok: true });
  assert.deepEqual(child.signals, ['SIGINT']);
  assert.equal(
    sink.last('state'),
    undefined,
    'the turn ends with the process, not with the signal',
  );

  await child.emitLine(resultLine({ isError: true, result: null, terminal: 'aborted_tools' }));
  await child.close(0);

  assert.equal(sink.last('state').turn.outcome, 'stopped');
  assert.equal(env.record(result.session).lastOutcome, 'stopped');
  assert.deepEqual(child.signals, ['SIGINT'], 'no SIGTERM for a process that closed');
  await env.timers.advance(STOP_GRACE_MS * 2);
  assert.deepEqual(child.signals, ['SIGINT']);
  const next = await env.chat.send({ session: result.session, message: 'carry on' });
  assert.equal(next.ok, true);
});

test('scenario 9: a process that has not closed 5 s after SIGINT gets SIGTERM, and the turn still ends stopped', async (t) => {
  const env = await chatEnvironment(t);
  const { result, child } = await startTurn(env, { message: 'long task' });
  const { sink } = await env.openStream(result.session);

  await env.chat.stop({ session: result.session });
  await env.timers.advance(STOP_GRACE_MS - 1);
  assert.deepEqual(child.signals, ['SIGINT'], 'not before 5 s');
  await env.timers.advance(1);
  assert.deepEqual(child.signals, ['SIGINT', 'SIGTERM']);

  await child.close(143, 'SIGTERM');
  assert.equal(sink.last('state').turn.outcome, 'stopped');
  assert.equal(env.sessions.held.size, 0);
});

test('scenario 9: Stop with no turn in flight is refused no_turn', async (t) => {
  const env = await chatEnvironment(t);
  env.seedRecord(UUID_1);
  await assert.rejects(env.chat.stop({ session: UUID_1 }), refused('no_turn'));
  await assert.rejects(env.chat.stop({ session: UUID_6 }), refused('no_turn'));
});

// ---- scenario 18: the spawn is safe and nothing said is logged ----

test('scenario 18: the spawn is `claude` with the spec arguments only, no shell, the message on stdin only, and no secret in its environment', async (t) => {
  const previous = SECRET_NAMES.map((name) => [name, process.env[name]]);
  for (const name of SECRET_NAMES) process.env[name] = `synthetic-${name}`;
  process.env.CHAT_TEST_KEPT = 'kept';
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    delete process.env.CHAT_TEST_KEPT;
  });
  const env = await chatEnvironment(t);
  const message = 'SENTINEL-MESSAGE-5e1c do the thing';

  const { result, child } = await startTurn(env, { message });

  const call = env.spawner.calls[0];
  assert.equal(path.basename(call.command), 'claude');
  assert.deepEqual(call.args, [...BASE_ARGS, '--session-id', result.session]);
  assert.ok(!call.options.shell, 'no shell');
  assert.equal(
    call.args.some((arg) => arg.includes('SENTINEL')),
    false,
    'the message is never an argument',
  );
  assert.equal(child.stdinText(), userLine(message));
  for (const flag of [
    '--permission-mode',
    '--dangerously-skip-permissions',
    '--allowedTools',
    '--model',
    '--mcp-config',
    '--tools',
  ])
    assert.equal(call.args.includes(flag), false, flag);
  for (const name of SECRET_NAMES)
    assert.equal(name in call.options.env, false, `${name} is not passed on`);
  assert.equal(call.options.env.CHAT_TEST_KEPT, 'kept', 'the rest of the environment is');
});

test('scenario 18: a resumed session is spawned the same way, with the same scrubbed environment', async (t) => {
  process.env.GH_TOKEN = 'synthetic-resume';
  t.after(() => delete process.env.GH_TOKEN);
  const env = await chatEnvironment(t);
  env.sessions.setEntries([entry(UUID_2)]);
  await env.chat.send({ session: UUID_2, message: 'hi' });
  const call = env.spawner.last();
  assert.deepEqual(call.args, [...BASE_ARGS, '--resume', UUID_2]);
  assert.equal('GH_TOKEN' in call.options.env, false);
  assert.ok(!call.options.shell);
});

test('scenario 18: after a failed turn the log holds one [claude] line with the step, reason and short session id, and none of what was said', async (t) => {
  const env = await chatEnvironment(t);
  const message = 'SENTINEL-MESSAGE-77aa';
  const { result, child } = await startTurn(env, { message: `${message} title words` });
  await child.emitLine(assistantTextLine('a-1', 'SENTINEL-ASSISTANT-12bb'));
  await child.emitLine(
    toolUseLine('a-2', 'toolu_1', 'Read', { file_path: '/SENTINEL-INPUT-34cc' }),
  );
  await child.emitLine('SENTINEL-GARBAGE-56dd not json');
  await child.emitStderr('SENTINEL-STDERR-78ee');
  await child.emitLine(
    resultLine({ isError: true, result: 'SENTINEL-CLI-ERROR-90ff', terminal: 'x' }),
  );
  await child.close(1);

  assert.equal(env.logs.length, 1, 'one line per failure');
  const [line] = env.logs;
  assert.match(line, /^\[claude\] /);
  assert.ok(line.includes(result.session.slice(0, 8)), 'the 8-character session prefix');
  assert.match(line, /api_error|exited/);
  assert.ok(line.includes('1'), 'the exit code');
  assert.doesNotMatch(line, /SENTINEL|title words/);
  assert.equal(line.includes(result.session), false, 'only the prefix of the session id');
});

// ---- scenario 19: no IO at construction, nothing left running ----

test('scenario 19: building the chat reads no file, writes none, and spawns nothing', async (t) => {
  const { createClaudeChat } = await import('../backend/claude-chat.mjs');
  const { recordingFs } = await import('./slack-watch-fixture.mjs');
  const root = scratchDir(t, 'construct-');
  const recorder = recordingFs(fs);
  const spawner = createFakeSpawn();
  const chat = createClaudeChat({
    claudeSessions: {},
    spawn: spawner.spawn,
    stateDir: path.join(root, 'claude'),
    home: path.join(root, 'home'),
    fs: recorder.fs,
  });
  assert.deepEqual(recorder.calls, []);
  assert.deepEqual(spawner.calls, []);
  assert.equal(fs.existsSync(path.join(root, 'claude')), false);
  chat.close();
});

test('scenario 19: close() sends SIGTERM to every turn process and ends every stream', async (t) => {
  const env = await chatEnvironment(t);
  const one = await startTurn(env, { message: 'one' });
  const two = await startTurn(env, { message: 'two' });
  const streams = [
    await env.openStream(one.result.session),
    await env.openStream(two.result.session),
    await env.openStream(one.result.session),
  ];

  env.chat.close();

  assert.deepEqual(one.child.signals, ['SIGTERM']);
  assert.deepEqual(two.child.signals, ['SIGTERM']);
  for (const { sink } of streams) assert.ok(sink.ended >= 1, 'the stream is ended');
  await flush(5);
});

// ---- review round 1: a process that will not end, a bad directory, a failed start, big output ----

test('a process that ignores SIGINT and SIGTERM is killed with SIGKILL after two more graces, and its mark and place are freed', async (t) => {
  const env = await chatEnvironment(t);
  const { result, child } = await startTurn(env, { message: 'stuck' });
  const { sink } = await env.openStream(result.session);

  await env.chat.stop({ session: result.session });
  await env.timers.advance(STOP_GRACE_MS);
  assert.deepEqual(child.signals, ['SIGINT', 'SIGTERM']);
  await env.timers.advance(STOP_GRACE_MS - 1);
  assert.deepEqual(child.signals, ['SIGINT', 'SIGTERM'], 'not before the second grace');
  await env.timers.advance(1);
  assert.deepEqual(child.signals, ['SIGINT', 'SIGTERM', 'SIGKILL']);

  await child.close(null, 'SIGKILL');
  assert.equal(sink.last('state').turn.outcome, 'stopped');
  assert.equal(env.sessions.held.size, 0);
  assert.equal((await env.chat.send({ session: result.session, message: 'again' })).ok, true);
});

test('a process that closes after SIGTERM is not sent SIGKILL', async (t) => {
  const env = await chatEnvironment(t);
  const { result, child } = await startTurn(env, { message: 'slow' });
  await env.chat.stop({ session: result.session });
  await env.timers.advance(STOP_GRACE_MS);
  await child.close(143, 'SIGTERM');
  await env.timers.advance(STOP_GRACE_MS * 3);
  assert.deepEqual(child.signals, ['SIGINT', 'SIGTERM']);
});

for (const cwd of [undefined, '', 7])
  test(`a listed session whose entry has no usable directory (${JSON.stringify(cwd)}) is 502 spawn_failed, never spawned in the dashboard's own directory`, async (t) => {
    const env = await chatEnvironment(t);
    env.sessions.setEntries([entry(UUID_2, { cwd })]);
    await assert.rejects(
      env.chat.send({ session: UUID_2, message: 'hi' }),
      failedWith('spawn_failed'),
    );
    assert.equal(env.spawner.calls.length, 0);
    assert.equal(env.sessions.held.size, 0);
  });

test('a start that fails after send answered (an error event, no pid) ends the turn failed / spawn_failed and frees the mark', async (t) => {
  const env = await chatEnvironment(t);
  const { result, child } = await startTurn(env, { message: 'go' });
  const { sink } = await env.openStream(result.session);
  child.pid = undefined;
  child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
  await flush(5);

  assert.deepEqual(
    [sink.last('state').turn.outcome, sink.last('state').turn.reason],
    ['failed', 'spawn_failed'],
  );
  assert.equal(env.sessions.held.size, 0);
  assert.equal(env.record(result.session).lastOutcome, 'failed');
});

test('an error event from a process that did start (a failed kill) does not end the turn', async (t) => {
  const env = await chatEnvironment(t);
  const { result, child } = await startTurn(env, { message: 'go' });
  child.emit('error', new Error('kill EPERM'));
  await flush(5);
  assert.equal(env.sessions.held.size, 1, 'still held');
  await assert.rejects(
    env.chat.send({ session: result.session, message: 'again' }),
    refused('chat_busy'),
  );
});

test('a stdout line over 8 MiB is dropped to its end, and the lines after it are still read', async (t) => {
  const env = await chatEnvironment(t);
  const { result, child } = await startTurn(env, { message: 'big' });
  const { sink } = await env.openStream(result.session);
  sink.messages.length = 0;
  const big = 'x'.repeat(9 * 1024 * 1024);

  // an open line that grows past the limit, finished by a later chunk
  child.stdout.write(big);
  await flush(5);
  child.stdout.write(`still the long line\n${JSON.stringify(textDeltaLine('one'))}\n`);
  await flush(5);
  // a whole line over the limit in one chunk
  child.stdout.write(`${big}\n${JSON.stringify(textDeltaLine('two'))}\n`);
  await flush(5);

  assert.deepEqual(sink.of('delta'), [{ text: 'one' }, { text: 'two' }]);
});

test('a delta is not written to a client that has not drained, an item is, and a drain turns deltas on again', async (t) => {
  const env = await chatEnvironment(t);
  const { result, child } = await startTurn(env, { message: 'go' });
  const { sink, handle } = await env.openStream(result.session, { congested: true });
  sink.messages.length = 0;

  await child.emitLine(textDeltaLine('dropped'));
  await child.emitLine(assistantTextLine('a-1', 'kept'));
  assert.deepEqual(sink.events(), ['item']);

  sink.congested = false;
  handle.drained();
  await child.emitLine(textDeltaLine('written'));
  assert.deepEqual(sink.of('delta'), [{ text: 'written' }]);
});

test('the live buffer keeps the newest 500 items and says truncated', async (t) => {
  const env = await chatEnvironment(t);
  const { result, child } = await startTurn(env, { message: 'many' });
  for (let index = 0; index < 501; index += 1)
    await child.emitLine(assistantTextLine(`a-${index}`, `reply ${index}`));

  const { sink } = await env.openStream(result.session);
  const hello = sink.messages[0].payload;
  assert.equal(hello.items.length, 500);
  assert.equal(hello.truncated, true);
  assert.deepEqual([hello.items[0].id, hello.items.at(-1).id], ['a-1', 'a-500']);
});

test('only the last 4 MiB of a transcript are read: the cut line is dropped, the newer items stay, truncated is set', async (t) => {
  const env = await chatEnvironment(t);
  env.seedRecord(UUID_1);
  const file = env.writeTranscript(UUID_1, []);
  fs.writeFileSync(
    file,
    `${JSON.stringify({ type: 'cost-state', pad: 'p'.repeat(5 * 1024 * 1024) })}\n` +
      `${JSON.stringify(tUser('u1', null, 'recent question'))}\n` +
      `${JSON.stringify(tAssistant('a1', 'u1', [tText('recent answer')]))}\n`,
  );

  const { sink } = await env.openStream(UUID_1);
  const hello = sink.messages[0].payload;
  assert.deepEqual(
    hello.items.map((item) => item.text),
    ['recent question', 'recent answer'],
  );
  assert.equal(hello.truncated, true);
});

test('the list holds at most 100 chats, and a record over 64 KiB is not one', async (t) => {
  const env = await chatEnvironment(t);
  const ids = Array.from(
    { length: 101 },
    (_, index) => `0a1b2c3d-7777-4777-8777-${String(index).padStart(12, '0')}`,
  );
  ids.forEach((id, index) =>
    env.seedRecord(id, { lastTurnAt: new Date(SLACK_START_MS - index * 1000).toISOString() }),
  );
  const huge = '0a1b2c3d-8888-4888-8888-888888888888';
  env.seedRecord(huge, {
    title: 'h'.repeat(70 * 1024),
    lastTurnAt: new Date(SLACK_START_MS).toISOString(),
  });

  const chats = await env.chat.list();
  assert.equal(chats.length, 100);
  assert.equal(
    chats.some((chat) => chat.id === huge),
    false,
  );
  assert.equal(chats[0].id, ids[0], 'newest first');
  assert.equal(chats.at(-1).id, ids[99], 'the 101st is the one left out');
});

// ---- a session the CLI no longer lists, that this dashboard launched ----

const ORPHAN = UUID_5;
const orphanName = (id) => (id === ORPHAN ? 'TAP-9-implement-plan' : null);

async function orphanEnvironment(t, { known = true, recoverable = true } = {}) {
  const env = await chatEnvironment(t, { launchedName: known ? orphanName : () => null });
  env.sessions.setEntries([entry(UUID_2)]);
  if (recoverable) env.sessions.setRecoverable(ORPHAN);
  return env;
}

test('an orphaned launch session is continued: --resume in the standalone directory, no stop, no copy, no record', async (t) => {
  const env = await orphanEnvironment(t);
  env.writeTranscript(ORPHAN, [tUser('u1', null, 'q'), tAssistant('a1', 'u1', [tText('a')])]);

  const result = await env.chat.send({ session: ORPHAN, message: 'carry on' });

  assert.deepEqual(result, { ok: true, session: ORPHAN, chat: null });
  assert.deepEqual(env.spawner.last().args, [...BASE_ARGS, '--resume', ORPHAN]);
  assert.equal(env.spawner.last().options.cwd, env.pathwise);
  assert.deepEqual(env.sessions.stops(), []);
  assert.deepEqual(env.records(), []);
  assert.deepEqual(
    [...env.sessions.held],
    [ORPHAN],
    'the one-writer mark is held as for any session',
  );
});

test('an orphaned launch session streams its history from its transcript, named by its launch record, idle', async (t) => {
  const env = await orphanEnvironment(t);
  env.writeTranscript(ORPHAN, [
    tUser('u1', null, 'question'),
    tAssistant('a1', 'u1', [tText('answer')]),
  ]);

  const { sink } = await env.openStream(ORPHAN);

  const hello = sink.messages[0].payload;
  assert.deepEqual(
    [hello.session, hello.kind, hello.title, hello.state, hello.live],
    [ORPHAN, 'session', 'TAP-9-implement-plan', 'idle', false],
  );
  assert.deepEqual(
    hello.items.map((item) => item.text),
    ['question', 'answer'],
  );
});

for (const [label, options] of [
  ['no launch record names it', { known: false }],
  ['its short id does not recover to exactly this id', { recoverable: false }],
]) {
  test(`an unlisted session is still session_not_found when ${label}`, async (t) => {
    const env = await orphanEnvironment(t, options);
    env.writeTranscript(ORPHAN, [tUser('u1', null, 'q')]);
    await assert.rejects(
      env.chat.send({ session: ORPHAN, message: 'hi' }),
      refused('session_not_found'),
    );
    await assert.rejects(env.openStream(ORPHAN), refused('session_not_found'));
    assert.equal(env.spawner.calls.length, 0);
    assert.equal(env.sessions.held.size, 0);
  });
}

test('an unlisted session whose prefix recovers to a different id is not the orphan', async (t) => {
  const env = await orphanEnvironment(t);
  const sibling = `${ORPHAN.slice(0, 8)}-9999-4999-8999-999999999999`;
  await assert.rejects(
    env.chat.send({ session: sibling, message: 'hi' }),
    refused('session_not_found'),
  );
});

test('a listed session never asks for recovery, and an unreadable listing still says listing_unavailable', async (t) => {
  const env = await orphanEnvironment(t);
  await env.chat.send({ session: UUID_2, message: 'hi' });
  assert.equal(env.sessions.events.includes('recover'), false);
  env.sessions.failListing();
  await assert.rejects(
    env.chat.send({ session: ORPHAN, message: 'hi' }),
    failedWith('listing_unavailable'),
  );
});

test('over 500 records the newest are the ones kept, whatever order the folder is read in', async (t) => {
  const { createClaudeChat } = await import('../backend/claude-chat.mjs');
  const env = await chatEnvironment(t);
  const total = 501;
  const at = (number) => SLACK_START_MS - (total - number) * 1_000;
  const idOf = (number) => `0a1b2c3d-1111-4111-8111-${String(number).padStart(12, '0')}`;
  for (let number = 1; number <= total; number++) {
    env.seedRecord(idOf(number), { lastTurnAt: new Date(at(number)).toISOString() });
    fs.utimesSync(env.recordFile(idOf(number)), at(number) / 1000, at(number) / 1000);
  }
  // A folder read oldest first: a cap taken from the front of that order drops the newest.
  const oldestFirst = new Proxy(fs, {
    get: (target, property) =>
      property === 'readdirSync'
        ? (dir) =>
            target
              .readdirSync(dir)
              .sort(
                (a, b) =>
                  target.statSync(path.join(dir, a)).mtimeMs -
                  target.statSync(path.join(dir, b)).mtimeMs,
              )
        : target[property],
  });
  const chat = createClaudeChat({
    claudeSessions: env.sessions,
    stateDir: env.stateDir,
    home: env.home,
    fs: oldestFirst,
  });
  t.after(() => chat.close?.());
  const ids = (await chat.list()).map((entry) => entry.id);
  assert.equal(ids[0], idOf(total), 'the newest chat is listed first');
  assert.equal(ids.length, 100);
  assert.equal(ids.at(-1), idOf(total - 99));
});
