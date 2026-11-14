// claude-usage-route.test.mjs — GET /api/claude/usage on the production HTTP handler: the answer's
// shape, its refusals, and the guard that the 15 s tickets poll reads no transcript content and never
// asks the usage reader. The handler, sessions module and reader are real; the CLI is a local double.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import {
  IMPLEMENT,
  IMPLEMENT_NAME,
  KEY,
  claudeHttpFixture,
  launchRecord,
  launcherEnvironment,
  listed,
  sessionUuid,
  statusFile,
} from './claude-launcher-fixture.mjs';
import { UUID_1, UUID_2, UUID_3 } from './claude-chat-fixture.mjs';
import { createUsageReader } from '../backend/claude-usage.mjs';

const USAGE = '/api/claude/usage';
const IMPLEMENT_ID = 'bbbb2222';
const SENTINEL = 'SENTINEL-TEXT-6612';

const assistant = (id, input, output) =>
  JSON.stringify({
    type: 'assistant',
    cwd: `/work/${SENTINEL}`,
    message: {
      id,
      model: 'claude-sonnet-5-5',
      content: [{ type: 'text', text: SENTINEL }],
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  });

function transcript(home, sessionId, lines, { subagent } = {}) {
  const project = path.join(home, '.claude', 'projects', 'project-a');
  const file = subagent
    ? path.join(project, sessionId, 'subagents', 'agent-1.jsonl')
    : path.join(project, `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
}

test('the route answers a tally per session, the main transcript plus its subagents, with no path or text', async (t) => {
  const f = await claudeHttpFixture(t);
  transcript(f.home, UUID_1, [assistant('m1', 10, 5), assistant('m2', 1, 1)]);
  transcript(f.home, UUID_1, [assistant('s1', 4, 4)], { subagent: true });
  transcript(f.home, UUID_2, [assistant('m1', 2, 2)]);

  const res = await f.http.bare('GET', `${USAGE}?sessions=${UUID_1},${UUID_2},${UUID_3}`);

  assert.equal(res.status, 200);
  const { sessions } = res.json();
  assert.deepEqual(Object.keys(sessions), [UUID_1, UUID_2, UUID_3]);
  assert.deepEqual(sessions[UUID_1], {
    tokens: { input: 15, output: 10, cacheRead: 0, cacheCreation: 0 },
    models: { 'claude-sonnet-5-5': 3 },
    messages: 3,
    complete: true,
  });
  assert.equal(sessions[UUID_2].messages, 1);
  assert.equal(sessions[UUID_3].messages, 0, 'a session with no transcript reads as empty');
  assert.ok(!res.text.includes(SENTINEL), 'no text or cwd in the body');
  assert.ok(!res.text.includes(f.home), 'no path in the body');
});

const BAD = [
  ['no sessions', ''],
  ['an empty id', `${UUID_1},`],
  ['a bad id', 'not-a-session'],
  ['a path', '../../etc/passwd'],
  [
    'more than 8 ids',
    Array.from({ length: 9 }, (_, index) => UUID_1.replace(/.$/, String(index))).join(','),
  ],
];
for (const [label, sessions] of BAD)
  test(`the route refuses ${label} with 400 INVALID_SESSION and reads nothing`, async (t) => {
    const f = await claudeHttpFixture(t);
    f.recorder.clearCalls();
    const res = await f.http.bare('GET', `${USAGE}?sessions=${encodeURIComponent(sessions)}`);
    assert.equal(res.status, 400);
    assert.equal(res.json().code, 'INVALID_SESSION');
    assert.deepEqual(f.recorder.calls, []);
  });

test('the route refuses a request without the sessions parameter', async (t) => {
  const f = await claudeHttpFixture(t);
  const res = await f.http.bare('GET', USAGE);
  assert.equal(res.status, 400);
  assert.equal(res.json().code, 'INVALID_SESSION');
});

for (const site of ['cross-site', 'same-site'])
  test(`the route refuses a ${site} request with 403`, async (t) => {
    const f = await claudeHttpFixture(t);
    transcript(f.home, UUID_1, [assistant('m1', 10, 5)]);
    const res = await f.http.raw('GET', `${USAGE}?sessions=${UUID_1}`, {
      headers: { 'sec-fetch-site': site },
    });
    assert.equal(res.status, 403);
    assert.ok(!res.text.includes('tokens'));
  });

test('no content read: the tickets poll stats transcripts and never asks the usage reader', async (t) => {
  const reads = { readFile: 0, readActivities: 0, tally: 0 };
  const { createClaudeSessions } = await import('../backend/claude-sessions.mjs');
  const { createHttpHandler } = await import('../backend/http-app.mjs');
  const { createSlackWatchStore } = await import('../backend/slack-watch-store.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-usage-route-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectsDir = path.join(root, 'home', '.claude', 'projects');
  const sessionId = sessionUuid(IMPLEMENT_ID);
  transcript(path.join(root, 'home'), sessionId, [assistant('m1', 10, 5)]);
  transcript(path.join(root, 'home'), sessionId, [assistant('s1', 4, 4)], { subagent: true });
  const entry = listed({ id: IMPLEMENT_ID, name: IMPLEMENT_NAME, state: 'working', pid: 4242 });
  const sessions = createClaudeSessions({
    execFileImpl: (bin, args, options, callback) => callback(null, JSON.stringify([entry]), ''),
    store: createSlackWatchStore({ home: path.join(root, 'home'), fs }),
    projectsDir,
    metadataIO: {
      readdir: fs.promises.readdir,
      stat: fs.promises.stat,
      readFile: async (...args) => {
        reads.readFile += 1;
        return fs.promises.readFile(...args);
      },
    },
    readActivities: async () => {
      reads.readActivities += 1;
      return new Map();
    },
  });
  const env = await launcherEnvironment(t, { claudeSessions: sessions });
  env.seed(KEY, {
    status: statusFile({ investigate: true, implement: true }),
    launch: { [IMPLEMENT]: launchRecord({ name: IMPLEMENT_NAME, id: IMPLEMENT_ID }) },
  });
  const handler = createHttpHandler({
    settings: {
      getSetupStatus: () => ({ ready: true }),
      getPublicSettings: () => ({}),
      getSnapshot: () => ({}),
    },
    manager: { list: () => [], logs: () => '', onUpdate: null },
    integrations: {
      slack: {},
      slackWatchStore: env.store,
      slackWatcher: { isDisabled: () => true, stop() {}, list: () => ({}), refreshSchedule() {} },
      claudeSessions: sessions,
      claudeLauncher: env.launcher,
      claudeChat: { list: async () => [], close() {} },
      claudeUsage: {
        tallyMany: async (filesById) => {
          reads.tally += 1;
          return Object.fromEntries(
            Object.keys(filesById).map((id) => [
              id,
              { tokens: {}, models: {}, messages: 0, complete: true },
            ]),
          );
        },
      },
    },
  });
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    handler.close?.();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const get = (pathname) =>
    new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port: server.address().port, path: pathname }, (res) => {
          let text = '';
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () => resolve({ status: res.statusCode, text }));
        })
        .on('error', reject);
    });

  const tickets = await get('/api/claude/tickets');
  await env.launcher.list();

  assert.equal(tickets.status, 200);
  assert.ok(tickets.text.includes(sessionId), 'the poll did see the session');
  assert.deepEqual(reads, { readFile: 0, readActivities: 0, tally: 0 });

  const usage = await get(`${USAGE}?sessions=${sessionId}`);
  assert.equal(usage.status, 200);
  assert.equal(reads.tally, 1, 'only the usage route asks the reader');
});

// The route on the real handler and sessions module, with the usage reader injected.
async function usageRoute(t, claudeUsage) {
  const env = await launcherEnvironment(t);
  const { createHttpHandler } = await import('../backend/http-app.mjs');
  const handler = createHttpHandler({
    settings: {
      getSetupStatus: () => ({ ready: true }),
      getPublicSettings: () => ({}),
      getSnapshot: () => ({}),
    },
    manager: { list: () => [], logs: () => '', onUpdate: null },
    integrations: {
      slack: {},
      slackWatchStore: env.store,
      slackWatcher: { isDisabled: () => true, stop() {}, list: () => ({}), refreshSchedule() {} },
      claudeSessions: env.sessions,
      claudeLauncher: env.launcher,
      claudeChat: { list: async () => [], close() {} },
      claudeUsage,
    },
  });
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    handler.close?.();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const get = (pathname) =>
    new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port: server.address().port, path: pathname }, (res) => {
          let text = '';
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () => resolve({ status: res.statusCode, json: () => JSON.parse(text) }));
        })
        .on('error', reject);
    });
  return { home: env.home, get };
}

test('one request asks the reader once for all its sessions, each id once', async (t) => {
  const calls = [];
  const f = await usageRoute(t, {
    tally: async () => assert.fail('the route must not tally per session'),
    tallyMany: async (filesById) => {
      calls.push(Object.keys(filesById));
      return Object.fromEntries(
        Object.keys(filesById).map((id) => [id, { tokens: {}, models: {}, messages: 0 }]),
      );
    },
  });

  const res = await f.get(`${USAGE}?sessions=${UUID_1},${UUID_2},${UUID_1}`);

  assert.equal(res.status, 200);
  assert.deepEqual(calls, [[UUID_1, UUID_2]]);
  assert.deepEqual(Object.keys(res.json().sessions), [UUID_1, UUID_2]);
});

test('a request with several sessions reads no more than one budget in all', async (t) => {
  const lines = Array.from({ length: 20 }, (_, index) => assistant(`m${index}`, 1, 1));
  const fileBytes = Buffer.byteLength(`${lines.join('\n')}\n`);
  const budgetBytes = Math.floor(fileBytes * 1.5);
  let bytesRead = 0;
  const { stat } = fs.promises;
  const reader = createUsageReader({
    budgetBytes,
    io: {
      stat,
      read: async (file, offset, length) => {
        const handle = await fs.promises.open(file, 'r');
        try {
          const buffer = Buffer.alloc(length);
          const result = await handle.read(buffer, 0, length, offset);
          bytesRead += result.bytesRead;
          return buffer.subarray(0, result.bytesRead);
        } finally {
          await handle.close();
        }
      },
    },
  });
  const f = await usageRoute(t, reader);
  for (const id of [UUID_1, UUID_2, UUID_3]) transcript(f.home, id, lines);

  const res = await f.get(`${USAGE}?sessions=${UUID_1},${UUID_2},${UUID_3}`);

  assert.equal(res.status, 200);
  assert.ok(bytesRead > 0 && bytesRead <= budgetBytes, `read ${bytesRead} of ${budgetBytes}`);
  const { sessions } = res.json();
  assert.equal(sessions[UUID_1].complete, true);
  assert.equal(sessions[UUID_3].complete, false, 'the last session waits for a later request');
});
