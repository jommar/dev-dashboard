// harness-routes.test.mjs — the active harness on the production HTTP handler and the usage reader
// (multi-harness plan, items 1, 2, 13, 14). The handler, launcher, watcher and usage reader are real;
// the harness is the default Claude Code adapter or the test-only fake (`harness-fake.mjs`), so no CLI
// runs and the dashboard's real `claude/` state folder is never read: the launcher and chat are built
// over temp folders.
//
//   config harness     `GET /api/config` carries Claude Code's metadata beside its unchanged keys
//   injected harness   `integrations.harness` is the one reported and wired
//   usage              an adapter without `usage` answers zero tallies and never reads a file
//   home gate          `homeReadable()` of the injected harness gates the Slack watcher
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createFakeHarness } from './harness-fake.mjs';
import { createUsageReader } from '../backend/claude-usage.mjs';
import { KEY, INVESTIGATE, INVESTIGATE_NAME, launchRecord } from './claude-launcher-fixture.mjs';

const CLAUDE_CODE_META = {
  id: 'claude-code',
  label: 'Claude Code',
  name: 'Claude',
  command: 'claude',
  capabilities: { chat: true, usage: true },
};

// The handler over temp folders, with the injected harness when given.
async function handlerFixture(t, { harness } = {}) {
  const { createHttpHandler } = await import('../backend/http-app.mjs');
  const { createSlackWatchStore } = await import('../backend/slack-watch-store.mjs');
  const { createClaudeLauncher } = await import('../backend/claude-launcher.mjs');
  const { defaultHarness } = await import('../backend/harness/index.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-routes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const stateDir = path.join(root, 'claude');
  fs.mkdirSync(home, { recursive: true });
  const store = createSlackWatchStore({ home });
  const active = harness ?? defaultHarness();
  const launcher = createClaudeLauncher({
    claudeSessions: active.createSessions({ store }),
    harness: active,
    stateDir,
    home,
    promptsDir: path.join(root, 'prompts'),
  });
  const settings = {
    getSetupStatus: () => ({ ready: true }),
    getPublicSettings: () => ({
      jira: { baseUrl: 'https://jira.example.test' },
      slackWatch: { intervalSeconds: 180, noticeTemplate: 'Ping {link}' },
    }),
    getSnapshot: () => ({}),
  };
  const manager = { list: () => [], logs: () => '', onUpdate: null };
  const handler = createHttpHandler({
    settings,
    manager,
    integrations: {
      slack: {},
      slackWatchStore: store,
      claudeLauncher: launcher,
      claudeChat: { list: async () => [], close() {} },
      ...(harness && { harness }),
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
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    stateDir,
    get: async (pathname) => {
      const res = await fetch(`${base}${pathname}`);
      return { status: res.status, json: await res.json() };
    },
  };
}

test('config harness: GET /api/config carries Claude Code metadata beside its unchanged keys', async (t) => {
  const f = await handlerFixture(t);

  const res = await f.get('/api/config');

  assert.equal(res.status, 200);
  assert.deepEqual(res.json.harness, CLAUDE_CODE_META);
  assert.deepEqual(Object.keys(res.json).sort(), [
    'defaultTailLines',
    'harness',
    'jiraBase',
    'setup',
  ]);
  assert.equal(res.json.jiraBase, 'https://jira.example.test/browse/');
  assert.deepEqual(res.json.setup, { ready: true });
  assert.equal(typeof res.json.defaultTailLines, 'number');
});

test('injected harness: the injected adapter is the one reported, and its sessions service is the one asked', async (t) => {
  const fake = await createFakeHarness({ without: ['usage'] });
  fake.setEntries([]);
  const f = await handlerFixture(t, { harness: fake.harness });
  const ticket = path.join(f.stateDir, KEY);
  fs.mkdirSync(ticket, { recursive: true });
  fs.writeFileSync(
    path.join(ticket, 'launch.json'),
    JSON.stringify({ [INVESTIGATE]: launchRecord({ name: INVESTIGATE_NAME }) }),
  );

  const config = await f.get('/api/config');
  const tickets = await f.get('/api/claude/tickets');

  assert.deepEqual(config.json.harness, {
    id: 'fake',
    label: 'Fake Agent',
    name: 'Fake',
    command: 'fake',
    capabilities: { chat: true, usage: false },
  });
  assert.equal(tickets.status, 200);
  assert.equal(tickets.json.listing, 'ok', 'the listing is the fake one');
  assert.ok(KEY in tickets.json.tickets);
  assert.ok(fake.sessionCalls('entries').length > 0, 'the fake sessions service was read');
  assert.ok(
    fake.created.length > 0,
    'the handler built its sessions service from the injected harness',
  );
});

// ---- usage ----

const TRANSCRIPT = `${JSON.stringify({ fake_usage: { id: 'm1', model: 'fake-1', in: 7, out: 3 } })}\n`;

// The default file io with every call recorded.
function spyIo() {
  const calls = { stat: [], read: [] };
  return {
    calls,
    io: {
      stat: async (file) => {
        calls.stat.push(file);
        return fs.promises.stat(file);
      },
      read: async (file, offset, length) => {
        calls.read.push(file);
        const handle = await fs.promises.open(file, 'r');
        try {
          const buffer = Buffer.alloc(length);
          const { bytesRead } = await handle.read(buffer, 0, length, offset);
          return buffer.subarray(0, bytesRead);
        } finally {
          await handle.close();
        }
      },
    },
  };
}

const ZERO_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

function transcriptFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-usage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, TRANSCRIPT);
  return file;
}

test('usage: an adapter without usage answers zero tallies for every session and never reads a file', async (t) => {
  const fake = await createFakeHarness({ without: ['usage'] });
  const spy = spyIo();
  const reader = createUsageReader({ harness: fake.harness, io: spy.io });
  const file = transcriptFile(t);

  const many = await reader.tallyMany({ first: [file], second: [file, file] });
  const one = await reader.tally([file]);

  for (const answer of [many.first, many.second, one]) {
    assert.deepEqual(answer.tokens, ZERO_TOKENS);
    assert.deepEqual(answer.models, {});
    assert.equal(answer.messages, 0);
    assert.equal(answer.complete, true, 'nothing is missing: there is nothing to read');
  }
  assert.deepEqual(Object.keys(many), ['first', 'second']);
  assert.equal(spy.calls.read.length, 0, 'io.read was never called');
});

test('usage: an adapter with usage tallies through its own parseLine', async (t) => {
  const fake = await createFakeHarness();
  const reader = createUsageReader({ harness: fake.harness, io: spyIo().io });

  const answer = await reader.tally([transcriptFile(t)]);

  assert.deepEqual(answer.tokens, { input: 7, output: 3, cacheRead: 0, cacheCreation: 0 });
  assert.deepEqual(answer.models, { 'fake-1': 1 });
  assert.equal(answer.messages, 1);
});

// ---- the Slack watcher's gate ----

test('home gate: homeReadable() false on the injected harness disables the watcher with claude_home_unreadable', async (t) => {
  const fake = await createFakeHarness();
  fake.setHomeReadable(false);
  const f = await handlerFixture(t, { harness: fake.harness });

  const disabled = await f.get('/api/slack/watch');
  fake.setHomeReadable(true);
  const enabled = await f.get('/api/slack/watch');

  assert.equal(disabled.status, 200);
  assert.equal(disabled.json.reason, 'claude_home_unreadable');
  assert.equal('reason' in enabled.json, false, 'a readable home enables it again');
});
