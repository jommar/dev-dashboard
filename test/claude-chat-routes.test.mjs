// claude-chat-routes.test.mjs — the chat routes on the production HTTP handler: the tickets reply
// that lists chats and session ids, the send and stop routes, and the stream route, under the
// dashboard's request rules. The handler, the chat module, the launcher and the sessions module are
// real; the CLI is a local double (`claudeHttpFixture(t, { chat: true })`), so no `claude` runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  IMPLEMENT,
  IMPLEMENT_NAME,
  KEY,
  claudeHttpFixture,
  launchRecord,
  listed,
  sessionUuid,
  statusFile,
  until,
} from './claude-launcher-fixture.mjs';
import {
  UUID_1,
  UUID_6,
  UUID_SHAPE,
  initLine,
  resultLine,
  tAssistant,
  tText,
  tUser,
} from './claude-chat-fixture.mjs';

const TICKETS = '/api/claude/tickets';
const SEND = '/api/claude/chat/send';
const STOP = '/api/claude/chat/stop';
const STREAM = '/api/claude/chat/stream';
const IMPLEMENT_ID = 'bbbb2222';

const fixture = (t, options) => claudeHttpFixture(t, { chat: true, ...options });
const firstChild = (f) => f.chatSpawn.calls[0].child;

// A chat stream over a plain request, so a stream that never ends can be read and then dropped.
// Resolves with the reply as soon as its headers arrive (the server writes them with the first
// event); `text()` is what has been read, `close()` drops the connection.
function openStream(f, query, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: f.http.port, path: `${STREAM}${query}`, method: 'GET', headers },
      (res) => {
        let text = '';
        res.on('data', (chunk) => {
          text += chunk;
        });
        const reply = {
          status: res.statusCode,
          headers: res.headers,
          text: () => text,
          json: () => JSON.parse(text),
          close: () => req.destroy(),
          done: new Promise((done) => res.on('end', done).on('close', done)),
        };
        resolve(reply);
      },
    );
    req.on('error', (error) => {
      if (error.code !== 'ECONNRESET') reject(error);
    });
    req.setTimeout(5_000, () => req.destroy(new Error('no reply within 5 s')));
    req.end();
  });
}

// The JSON reply of a stream that was refused: it carries the whole body.
async function refusedStream(f, query, options) {
  const reply = await openStream(f, query, options);
  await reply.done;
  return reply;
}

async function newChat(f, message = 'a standalone question') {
  const res = await f.http.json('POST', SEND, { message });
  assert.equal(res.status, 200);
  return res.json();
}

// ---- scenario 10: the tickets reply lists chats and session ids ----

test('scenario 10: the tickets reply lists a standalone chat with a turn in flight, and the session id of a listed phase', async (t) => {
  const f = await fixture(t);
  f.seed(KEY, {
    status: statusFile({ investigate: true }),
    launch: { [IMPLEMENT]: launchRecord({ name: IMPLEMENT_NAME, id: IMPLEMENT_ID }) },
  });
  f.cli.setListing([listed({ id: IMPLEMENT_ID, name: IMPLEMENT_NAME })]);
  const sent = await newChat(f, 'standalone hello');

  const res = await f.http.bare('GET', TICKETS);

  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.chats.length, 1);
  const [chat] = body.chats;
  assert.equal(chat.id, sent.session);
  assert.deepEqual([chat.title, chat.state, chat.goTo], ['standalone hello', 'working', null]);
  assert.deepEqual(body.sessionIds, { [KEY]: { implement: sessionUuid(IMPLEMENT_ID) } });
  for (const key of ['listing', 'tickets', 'updatedAt', 'lastActive'])
    assert.ok(key in body, `${key} is still there`);
  assert.deepEqual(Object.keys(body.tickets), [KEY]);
  assert.equal(body.listing, 'ok');
});

// ---- send and stop ----

test('scenario 10: send answers { ok, session, chat } for a standalone chat and chat null for a listed session', async (t) => {
  const f = await fixture(t);
  f.cli.setListing([listed({ id: IMPLEMENT_ID, name: IMPLEMENT_NAME })]);

  const standalone = await f.http.json('POST', SEND, { message: 'hello' });
  assert.equal(standalone.status, 200);
  const body = standalone.json();
  assert.equal(body.ok, true);
  assert.match(body.session, UUID_SHAPE);
  assert.equal(body.chat.id, body.session);
  assert.deepEqual(f.chatSpawn.calls[0].args.slice(-2), ['--session-id', body.session]);

  const listedSend = await f.http.json('POST', SEND, {
    message: 'hello',
    session: sessionUuid(IMPLEMENT_ID),
  });
  assert.equal(listedSend.status, 200);
  assert.deepEqual(listedSend.json(), {
    ok: true,
    session: sessionUuid(IMPLEMENT_ID),
    chat: null,
  });
  assert.deepEqual(f.chatSpawn.calls[1].args.slice(-2), ['--resume', sessionUuid(IMPLEMENT_ID)]);
});

test('scenario 10: stop answers { ok: true } and signals the turn; a refusal is the 409 envelope', async (t) => {
  const f = await fixture(t);
  const { session } = await newChat(f);

  const stopped = await f.http.json('POST', STOP, { session });
  assert.equal(stopped.status, 200);
  assert.deepEqual(stopped.json(), { ok: true });
  assert.deepEqual(firstChild(f).signals, ['SIGINT']);

  const none = await f.http.json('POST', STOP, { session: UUID_6 });
  assert.equal(none.status, 409);
  assert.deepEqual([none.json().code, none.json().errors], ['CLAUDE_REFUSED', ['no_turn']]);
});

test('scenario 10: the spec error table: chat_busy, session_not_found, too_many_turns, listing_unavailable', async (t) => {
  const f = await fixture(t);
  const first = await newChat(f);
  const cases = [
    [{ message: 'again', session: first.session }, 409, 'CLAUDE_REFUSED', 'chat_busy'],
    [{ message: 'hi', session: UUID_6 }, 409, 'CLAUDE_REFUSED', 'session_not_found'],
  ];
  for (const [body, status, code, reason] of cases) {
    const res = await f.http.json('POST', SEND, body);
    assert.equal(res.status, status, reason);
    assert.deepEqual([res.json().code, res.json().errors], [code, [reason]], reason);
  }
  for (const index of [2, 3, 4]) await newChat(f, `chat ${index}`);
  const over = await f.http.json('POST', SEND, { message: 'chat 5' });
  assert.equal(over.status, 409);
  assert.deepEqual(over.json().errors, ['too_many_turns']);

  f.cli.failListing();
  const down = await f.http.json('POST', SEND, {
    message: 'hi',
    session: sessionUuid(IMPLEMENT_ID),
  });
  assert.equal(down.status, 502);
  assert.deepEqual(
    [down.json().code, down.json().errors],
    ['CLAUDE_FAILED', ['listing_unavailable']],
  );
});

test('scenario 10: a CLI that cannot start is 502 CLAUDE_FAILED spawn_failed', async (t) => {
  const f = await fixture(t);
  f.chatSpawn.failWith();
  const res = await f.http.json('POST', SEND, { message: 'hello' });
  assert.equal(res.status, 502);
  assert.deepEqual([res.json().code, res.json().errors], ['CLAUDE_FAILED', ['spawn_failed']]);
});

test('scenario 10: the chat routes work with setup incomplete, like the other Claude routes', async (t) => {
  const f = await fixture(t, { ready: false });
  const sent = await f.http.json('POST', SEND, { message: 'hello' });
  assert.equal(sent.status, 200);
  const stream = await openStream(f, `?session=${sent.json().session}`);
  assert.equal(stream.status, 200);
  stream.close();
});

// ---- scenario 17: the chat routes keep the dashboard's request rules ----

const GUARDS = [
  ['a foreign Host', { host: 'evil.example:80' }, 403],
  ['a foreign Origin', { origin: 'https://evil.example' }, 403],
  ['a cross-site write', { 'sec-fetch-site': 'cross-site' }, 403],
  ['a same-site write', { 'sec-fetch-site': 'same-site' }, 403],
  ['a content type that is not JSON', { 'content-type': 'text/plain' }, 415],
];

for (const route of [SEND, STOP])
  for (const [label, headers, status] of GUARDS)
    test(`scenario 17: POST ${route} refuses ${label} before any file access or spawn`, async (t) => {
      const f = await fixture(t);
      f.recorder.clearCalls();
      const res = await f.http.raw('POST', route, {
        body: JSON.stringify({ message: 'hello', session: UUID_1 }),
        headers: { 'content-type': 'application/json', ...headers },
      });
      assert.equal(res.status, status);
      assert.deepEqual(f.recorder.calls, [], 'no file was touched');
      assert.equal(f.chatSpawn.calls.length, 0, 'nothing was spawned');
      assert.equal(f.cli.calls.length, 0, 'no listing was read');
    });

const BAD_MESSAGES = [
  ['a number', 5],
  ['null', null],
  ['an object', { text: 'hi' }],
  ['missing', undefined],
  ['empty', ''],
  ['only whitespace', ' \n\t '],
  ['over 32000 characters', 'x'.repeat(32_001)],
];

test('scenario 17: a bad message is 400 INVALID_MESSAGE before any file access, listing or spawn', async (t) => {
  const f = await fixture(t);
  f.recorder.clearCalls();
  for (const [label, message] of BAD_MESSAGES) {
    for (const session of [undefined, UUID_1]) {
      const res = await f.http.json('POST', SEND, { message, session });
      assert.equal(res.status, 400, `${label} ${session ? 'with a session' : ''}`);
      assert.equal(res.json().code, 'INVALID_MESSAGE', label);
    }
  }
  assert.deepEqual(f.recorder.calls, []);
  assert.equal(f.chatSpawn.calls.length, 0);
  assert.equal(f.cli.calls.length, 0);

  const longest = await f.http.json('POST', SEND, { message: 'x'.repeat(32_000) });
  assert.equal(longest.status, 200, '32000 characters is the limit, and allowed');
});

test('scenario 17: a session that is not a UUID is 400 INVALID_SESSION on send, stop and stream, before any file access or spawn', async (t) => {
  const f = await fixture(t);
  f.recorder.clearCalls();
  for (const session of ['nope', '../etc/passwd', `${UUID_1}x`, UUID_1.toUpperCase(), 7, '']) {
    const send = await f.http.json('POST', SEND, { message: 'hi', session });
    assert.deepEqual([send.status, send.json().code], [400, 'INVALID_SESSION'], `send ${session}`);
    const stop = await f.http.json('POST', STOP, { session });
    assert.deepEqual([stop.status, stop.json().code], [400, 'INVALID_SESSION'], `stop ${session}`);
  }
  for (const query of ['', '?session=nope', '?session=../x', `?session=${UUID_1}0`]) {
    const stream = await refusedStream(f, query);
    assert.equal(stream.status, 400, query);
    assert.equal(stream.json().code, 'INVALID_SESSION', query);
    assert.doesNotMatch(String(stream.headers['content-type']), /event-stream/);
  }
  assert.deepEqual(f.recorder.calls, []);
  assert.equal(f.chatSpawn.calls.length, 0);
  assert.equal(f.cli.calls.length, 0);
});

test('scenario 17: the stream GET refuses cross-site and same-site Sec-Fetch-Site and a foreign Host as JSON, and takes the others', async (t) => {
  const f = await fixture(t);
  const { session } = await newChat(f);
  for (const site of ['cross-site', 'same-site']) {
    const res = await refusedStream(f, `?session=${session}`, {
      headers: { 'sec-fetch-site': site },
    });
    assert.equal(res.status, 403, site);
    assert.equal(res.json().code, 'INVALID_ORIGIN', site);
    assert.doesNotMatch(String(res.headers['content-type']), /event-stream/);
  }
  const foreign = await refusedStream(f, `?session=${session}`, {
    headers: { host: 'evil.example' },
  });
  assert.equal(foreign.status, 403);
  for (const headers of [{ 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-site': 'none' }, {}]) {
    const ok = await openStream(f, `?session=${session}`, { headers });
    assert.equal(ok.status, 200, JSON.stringify(headers));
    ok.close();
  }
});

test('scenario 17: an accepted stream is text/event-stream, no-store, with the frame headers, and hello comes first', async (t) => {
  const f = await fixture(t);
  const { session } = await newChat(f, 'hello there');

  const stream = await openStream(f, `?session=${session}`);
  await until(() => stream.text().includes('\n\n'));

  assert.equal(stream.status, 200);
  assert.match(String(stream.headers['content-type']), /^text\/event-stream/);
  assert.equal(stream.headers['cache-control'], 'no-store');
  assert.equal(stream.headers['x-frame-options'], 'DENY');
  assert.equal(stream.headers['content-security-policy'], "frame-ancestors 'none'");
  assert.match(stream.text(), /^event: hello\ndata: /);
  const hello = JSON.parse(stream.text().split('\n')[1].slice('data: '.length));
  assert.deepEqual(
    [hello.session, hello.kind, hello.state, hello.live],
    [session, 'chat', 'working', true],
  );

  // and what the CLI says follows as server-sent events on the same stream
  const child = firstChild(f);
  await child.emitLine(initLine(session));
  await child.emitLine(resultLine());
  await child.close(0);
  await until(() => stream.text().includes('event: state'));
  assert.match(
    stream.text(),
    /event: state\ndata: \{"state":"idle","turn":\{"outcome":"completed"/,
  );
  stream.close();
});

test('scenario 17: a stream shows a transcript that is on disk, through the route', async (t) => {
  const f = await fixture(t);
  const { session } = await newChat(f);
  await firstChild(f).close(0);
  const file = path.join(f.home, '.claude', 'projects', 'p', `${session}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [tUser('u1', null, 'what is up'), tAssistant('a1', 'u1', [tText('not much')])]
      .map((line) => JSON.stringify(line))
      .join('\n'),
  );

  const stream = await openStream(f, `?session=${session}`);
  await until(() => stream.text().includes('not much'));
  assert.match(stream.text(), /what is up/);
  stream.close();
});

test('scenario 17: a ninth chat stream is 429 TOO_MANY_STREAMS as JSON, and a closed stream frees its place', async (t) => {
  const f = await fixture(t);
  const { session } = await newChat(f);
  const open = [];
  for (let index = 0; index < 8; index += 1) {
    const stream = await openStream(f, `?session=${session}`);
    assert.equal(stream.status, 200, `stream ${index + 1}`);
    open.push(stream);
  }

  const ninth = await refusedStream(f, `?session=${session}`);
  assert.equal(ninth.status, 429);
  assert.equal(ninth.json().code, 'TOO_MANY_STREAMS');
  assert.doesNotMatch(String(ninth.headers['content-type']), /event-stream/);

  open[0].close();
  let room = await openStream(f, `?session=${session}`);
  for (let attempt = 0; attempt < 50 && room.status !== 200; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    room = await openStream(f, `?session=${session}`);
  }
  assert.equal(room.status, 200, 'a closed stream frees its place');
  room.close();
  for (const stream of open) stream.close();
});

test('scenario 17: a client that leaves while its stream is still being opened does not keep a place', async (t) => {
  const f = await fixture(t);
  const { session } = await newChat(f);
  // the open is held, so the client can go away before hello is sent
  const realOpen = f.chat.open;
  let entered = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  f.chat.open = async (args) => {
    entered += 1;
    await gate;
    return realOpen(args);
  };
  const req = http.request({
    host: '127.0.0.1',
    port: f.http.port,
    path: `${STREAM}?session=${session}`,
    method: 'GET',
  });
  req.on('error', () => {});
  req.end();
  await until(() => entered === 1);
  req.destroy();
  await new Promise((resolve) => setTimeout(resolve, 50));
  release();
  await new Promise((resolve) => setTimeout(resolve, 50));
  f.chat.open = realOpen;

  const open = [];
  for (let index = 0; index < 8; index += 1) {
    const stream = await openStream(f, `?session=${session}`);
    assert.equal(stream.status, 200, `stream ${index + 1} of 8`);
    open.push(stream);
  }
  for (const stream of open) stream.close();
});

// ---- a session the CLI no longer lists, that a launch record names ----

test('orphans: a launched session the listing lost is continued through send and streamed with its history; an unrelated unlisted id is still refused', async (t) => {
  const f = await fixture(t);
  const orphan = sessionUuid('abab1212');
  f.seed(KEY, { launch: { [IMPLEMENT]: launchRecord({ name: IMPLEMENT_NAME, id: 'abab1212' }) } });
  f.cli.setListing([]);
  const file = path.join(f.home, '.claude', 'projects', 'p', `${orphan}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [tUser('u1', null, 'earlier question'), tAssistant('a1', 'u1', [tText('earlier answer')])]
      .map((line) => JSON.stringify(line))
      .join('\n'),
  );

  const sent = await f.http.json('POST', SEND, { message: 'hello again', session: orphan });
  assert.equal(sent.status, 200);
  assert.deepEqual(sent.json(), { ok: true, session: orphan, chat: null });
  assert.deepEqual(f.chatSpawn.calls[0].args.slice(-2), ['--resume', orphan]);

  const stream = await openStream(f, `?session=${orphan}`);
  await until(() => stream.text().includes('earlier answer'));
  assert.ok(stream.text().includes(`"title":"${IMPLEMENT_NAME}"`));
  stream.close();

  const stranger = await f.http.json('POST', SEND, { message: 'hi', session: UUID_6 });
  assert.equal(stranger.status, 409);
  assert.deepEqual(stranger.json().errors, ['session_not_found']);
});
