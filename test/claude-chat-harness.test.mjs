// claude-chat-harness.test.mjs — the chat on a harness other than Claude Code (multi-harness plan,
// items 7 chat half, 10, 11, 12). The chat module is real; the harness is the test-only fake adapter
// (`harness-fake.mjs`), the sessions service and `spawn` are the chat fixture's doubles, so no CLI runs.
//
//   harness turn           the turn spawns the harness's command and arguments, the message goes to stdin
//                          only, and events and history come from the harness's own parsers
//   chat unsupported       an adapter without `chat`: send, stop and open are refused `harness_unsupported`
//   chat other harness     a standalone chat recorded for another harness is refused under Claude Code
//   stamp                  a new standalone record names a non-default harness, and only that one
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createFakeHarness } from './harness-fake.mjs';
import {
  BASE_ARGS,
  SECRET_NAMES,
  UUID_1,
  UUID_2,
  chatEnvironment,
  createFakeSessions,
} from './claude-chat-fixture.mjs';

const refused = (reason) => ({ code: 'CLAUDE_REFUSED', status: 409, errors: [reason] });

// A fake-harness chat over the chat fixture's doubles.
async function fakeChat(t, { without = [] } = {}) {
  const fake = await createFakeHarness({ without });
  const env = await chatEnvironment(t, {
    claudeSessions: createFakeSessions(),
    harness: fake.harness,
  });
  return { fake, env };
}

test('harness turn: the turn spawns the fake command and arguments with the message on stdin only, in a scrubbed environment', async (t) => {
  const previous = SECRET_NAMES.map((name) => [name, process.env[name]]);
  for (const name of SECRET_NAMES) process.env[name] = `synthetic-${name}`;
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const { env } = await fakeChat(t);
  const message = 'SENTINEL-MESSAGE-71c2 do the thing';

  const result = await env.chat.send({ message });

  const call = env.spawner.last();
  assert.equal(call.command, 'fake', 'the harness command, not `claude`');
  assert.deepEqual(call.args, ['chat', '--new', result.session], 'the harness arguments only');
  assert.equal(
    call.args.some((arg) => arg.includes('SENTINEL')),
    false,
    'the message is never an argument',
  );
  assert.equal(
    BASE_ARGS.some((arg) => call.args.includes(arg)),
    false,
    'none of the Claude Code arguments',
  );
  assert.equal(call.options.shell, undefined, 'no shell');
  for (const name of SECRET_NAMES)
    assert.equal(name in call.options.env, false, `${name} is not passed on`);
  assert.equal(call.child.stdinText(), `${JSON.stringify({ say: message })}\n`);
});

test('harness turn: stream events come from the fake liveMessages and history from its historyItems', async (t) => {
  const { env } = await fakeChat(t);
  const result = await env.chat.send({ message: 'hello fake' });
  const child = env.spawner.last().child;
  const { sink } = await env.openStream(result.session);
  sink.messages.length = 0;

  await child.emitLine({ delta: 'Hel' });
  await child.emitLine({ delta: 'lo' });
  await child.emitLine({ item: { id: 'fake-1', kind: 'assistant', text: 'Hello' } });
  await child.emitLine({ done: true });
  await child.close(0);

  assert.deepEqual(sink.of('delta'), [{ text: 'Hel' }, { text: 'lo' }]);
  assert.deepEqual(
    sink.of('item').map(({ item }) => item),
    [{ id: 'fake-1', kind: 'assistant', text: 'Hello' }],
  );
  assert.equal(sink.last('state').state, 'idle');
  assert.equal(env.records().length, 1);
  assert.equal(env.record(result.session).lastOutcome, 'completed', 'the fake parser set it');

  env.seedRecord(UUID_1);
  env.writeTranscript(UUID_1, [
    { id: 'h-1', text: 'from the fake transcript' },
    { id: 'h-2', text: 'and the next' },
  ]);
  const history = await env.openStream(UUID_1);
  assert.deepEqual(
    history.sink.messages[0].payload.items.map((item) => [item.id, item.kind, item.text]),
    [
      ['h-1', 'assistant', 'from the fake transcript'],
      ['h-2', 'assistant', 'and the next'],
    ],
  );
});

test('chat unsupported: send, stop and the stream are refused harness_unsupported, nothing is spawned and no record is written', async (t) => {
  const { env } = await fakeChat(t, { without: ['chat'] });
  env.seedRecord(UUID_1);
  const seeded = fs.readFileSync(env.recordFile(UUID_1), 'utf8');

  await assert.rejects(env.chat.send({ message: 'hello' }), refused('harness_unsupported'));
  await assert.rejects(
    env.chat.send({ session: UUID_1, message: 'hello' }),
    refused('harness_unsupported'),
  );
  await assert.rejects(env.chat.stop({ session: UUID_1 }), refused('harness_unsupported'));
  const sink = { send: () => true, end() {} };
  await assert.rejects(
    env.chat.open({ session: UUID_1, sink }),
    refused('harness_unsupported'),
    'the stream is refused as an error before any event',
  );

  assert.equal(env.spawner.calls.length, 0, 'nothing spawned');
  assert.deepEqual(env.records(), [`${UUID_1}.json`], 'no new record');
  assert.equal(fs.readFileSync(env.recordFile(UUID_1), 'utf8'), seeded, 'the seeded one is intact');
  assert.equal(env.sessions.held.size, 0, 'no writer mark was taken');
});

test('chat other harness: a send to a chat recorded for another harness is refused under Claude Code, nothing is spawned or written', async (t) => {
  const env = await chatEnvironment(t);
  env.seedRecord(UUID_1, { harness: 'fake' });
  const before = fs.readFileSync(env.recordFile(UUID_1), 'utf8');

  await assert.rejects(
    env.chat.send({ session: UUID_1, message: 'hello' }),
    refused('harness_unsupported'),
  );

  assert.equal(env.spawner.calls.length, 0, 'nothing spawned');
  assert.equal(fs.readFileSync(env.recordFile(UUID_1), 'utf8'), before, 'the record is untouched');
  assert.equal(env.sessions.events.includes(`begin:${UUID_1}`), false, 'the mark was not taken');
});

test('chat go-to of a foreign record: it is still listed, but gets no resume command from the active harness', async (t) => {
  const env = await chatEnvironment(t);
  env.seedRecord(UUID_1);
  env.seedRecord(UUID_2, { harness: 'fake' });

  const byId = Object.fromEntries((await env.chat.list()).map((chat) => [chat.id, chat]));

  assert.ok(byId[UUID_1].goTo, 'a Claude Code chat has a resume command');
  assert.equal(byId[UUID_2].goTo, null, 'another harness chat has none');
});

test('stamp: a new standalone chat on the fake carries harness fake; on Claude Code its record has no harness key', async (t) => {
  const { env: onFake } = await fakeChat(t);
  const sent = await onFake.chat.send({ message: 'stamped' });
  assert.equal(onFake.record(sent.session).harness, 'fake');

  const onClaude = await chatEnvironment(t);
  const plain = await onClaude.chat.send({ message: 'plain' });
  assert.deepEqual(
    Object.keys(onClaude.record(plain.session)).sort(),
    ['createdAt', 'cwd', 'id', 'lastOutcome', 'lastTurnAt', 'title'],
    'exactly the bytes written before this change',
  );
});
