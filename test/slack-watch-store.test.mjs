// slack-watch-store.test.mjs — the watch map (atomic, one writer) and the per-session inboxes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CHANNEL,
  SESSION_A,
  SESSION_B,
  SESSION_C,
  SESSION_D,
  THREAD_TS,
  createClock,
  permalinkFor,
  recordingFs,
  threadKey,
  tsAt,
} from './slack-watch-fixture.mjs';

const SESSION_E = '55555555-5555-4555-8555-555555555555';
const START_ISO = '2026-10-28T13:01:40.000Z';
const PLUS_120_SECONDS_ISO = '2026-10-28T13:03:40.000Z';
const STRAY_TEMP_NAME = 'map.json.9f1b7c2e-3d4a-4b5c-8d6e-7f8091a2b3c4.tmp';
const WRITE_METHODS = [
  'writeFileSync',
  'appendFileSync',
  'writeSync',
  'copyFileSync',
  'renameSync',
  'fsyncSync',
];
const SNAPSHOT_LINK_KEYS = [
  'addedAt',
  'baselineAt',
  'channelId',
  'key',
  'lastNotifiedTs',
  'link',
  'sessionIds',
  'threadTs',
];

function linkObject(channelId, threadTs) {
  return {
    key: threadKey(channelId, threadTs),
    link: permalinkFor(channelId, threadTs),
    channelId,
    threadTs,
  };
}

const LINK_1 = linkObject(CHANNEL, THREAD_TS);
const LINK_2 = linkObject('C0999ZZZ1', '1793192300.000100');
const LINK_3 = linkObject('C0888YYY2', '1793192400.000200');

function storeEnvironment(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-watch-store-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const clock = createClock();
  const recorder = recordingFs(fs);
  const directory = path.join(home, '.config/dev-dashboard/slack-watch');
  return {
    home,
    clock,
    recorder,
    directory,
    mapFile: path.join(directory, 'map.json'),
    inboxDirectory: path.join(directory, 'inbox'),
    inboxFile: (sessionId) => path.join(directory, 'inbox', `${sessionId}.log`),
    async open() {
      const { createSlackWatchStore } = await import('../backend/slack-watch-store.mjs');
      return createSlackWatchStore({ home, fs: recorder.fs, now: clock.now });
    },
  };
}

async function openWithLinks(t, links = [LINK_1, LINK_2]) {
  const env = storeEnvironment(t);
  const store = await env.open();
  for (const link of links) await store.addLink(link);
  return { env, store };
}

const modeOf = (file) => fs.statSync(file).mode & 0o777;
const readMap = (env) => JSON.parse(fs.readFileSync(env.mapFile, 'utf8'));
const sortedSessions = (store, key) => [...store.snapshot().links[key].sessionIds].sort();
const inboxNames = (env) =>
  fs.existsSync(env.inboxDirectory) ? fs.readdirSync(env.inboxDirectory).sort() : [];

function listFiles(root) {
  const found = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else found.push(path.relative(root, file));
    }
  };
  if (fs.existsSync(root)) visit(root);
  return found.sort();
}

// Runs a call that may throw at once or reject later; yields the error, or null when neither.
async function failureOf(call) {
  try {
    await call();
  } catch (error) {
    return error;
  }
  return null;
}

test('map store starts empty and gives the contract shape after addLink', async (t) => {
  const env = storeEnvironment(t);
  const store = await env.open();
  assert.deepEqual(store.snapshot(), { version: 1, links: {} });

  const result = await store.addLink(LINK_1);

  assert.equal(result.added, true);
  const entry = store.snapshot().links[LINK_1.key];
  assert.deepEqual(Object.keys(entry).sort(), SNAPSHOT_LINK_KEYS);
  assert.equal(entry.key, LINK_1.key);
  assert.equal(entry.link, LINK_1.link);
  assert.equal(entry.channelId, CHANNEL);
  assert.equal(entry.threadTs, THREAD_TS);
  assert.equal(entry.addedAt, START_ISO);
  assert.equal(entry.lastNotifiedTs, null);
  assert.deepEqual(entry.sessionIds, []);
});

test('map store snapshot is a deep copy', async (t) => {
  const { store } = await openWithLinks(t, [LINK_1]);
  await store.attach(LINK_1.key, SESSION_A);

  const first = store.snapshot();
  first.links[LINK_1.key].sessionIds.push(SESSION_B);
  first.links[LINK_1.key].lastNotifiedTs = tsAt(99);
  delete first.links[LINK_1.key].link;
  first.version = 7;

  const second = store.snapshot();
  assert.equal(second.version, 1);
  assert.deepEqual(second.links[LINK_1.key].sessionIds, [SESSION_A]);
  assert.equal(second.links[LINK_1.key].lastNotifiedTs, null);
  assert.equal(second.links[LINK_1.key].link, LINK_1.link);
});

test('map store keeps one link when addLink runs twice', async (t) => {
  const { env, store } = await openWithLinks(t, []);
  const first = await store.addLink(LINK_1);
  env.clock.advance(60_000);
  const second = await store.addLink(LINK_1);

  assert.equal(first.added, true);
  assert.equal(second.added, false);
  assert.deepEqual(Object.keys(store.snapshot().links), [LINK_1.key]);
  assert.equal(store.snapshot().links[LINK_1.key].addedAt, START_ISO);
  assert.deepEqual(Object.keys(readMap(env).links), [LINK_1.key]);
});

test('map store removeLink drops the link and persists the removal', async (t) => {
  const { env, store } = await openWithLinks(t, [LINK_1, LINK_2]);

  await store.removeLink(LINK_1.key);

  assert.deepEqual(Object.keys(store.snapshot().links), [LINK_2.key]);
  assert.deepEqual(Object.keys(readMap(env).links), [LINK_2.key]);
  const reloaded = await env.open();
  assert.deepEqual(Object.keys(reloaded.snapshot().links), [LINK_2.key]);
});

test('map store attach to an empty link sets baselineAt to the clock and clears lastNotifiedTs', async (t) => {
  const { env, store } = await openWithLinks(t, [LINK_1]);
  const key = LINK_1.key;

  const first = await store.attach(key, SESSION_A);
  assert.equal(first.changed, true);
  assert.equal(store.snapshot().links[key].baselineAt, START_ISO);
  assert.equal(store.snapshot().links[key].lastNotifiedTs, null);

  await store.setLastNotifiedTs(key, tsAt(5));
  assert.equal(store.snapshot().links[key].lastNotifiedTs, tsAt(5));
  assert.equal(readMap(env).links[key].lastNotifiedTs, tsAt(5));

  env.clock.advance(60_000);
  await store.attach(key, SESSION_B);
  assert.equal(store.snapshot().links[key].baselineAt, START_ISO, 'a second session keeps it');
  assert.equal(store.snapshot().links[key].lastNotifiedTs, tsAt(5), 'and keeps the cursor');
  assert.deepEqual(sortedSessions(store, key), [SESSION_A, SESSION_B]);

  await store.detach(key, SESSION_A);
  await store.detach(key, SESSION_B);
  assert.deepEqual(store.snapshot().links[key].sessionIds, []);

  env.clock.advance(60_000);
  await store.attach(key, SESSION_A);
  assert.equal(store.snapshot().links[key].baselineAt, PLUS_120_SECONDS_ISO);
  assert.equal(store.snapshot().links[key].lastNotifiedTs, null);
  assert.equal(readMap(env).links[key].baselineAt, PLUS_120_SECONDS_ISO);
});

test('map store repeat attach leaves map.json bytes unchanged and writes nothing', async (t) => {
  const { env, store } = await openWithLinks(t, [LINK_1]);
  const first = await store.attach(LINK_1.key, SESSION_A);
  const before = fs.readFileSync(env.mapFile);
  env.recorder.clearCalls();
  env.clock.advance(60_000);

  const again = await store.attach(LINK_1.key, SESSION_A);

  assert.equal(again.changed, false);
  assert.equal(again.inbox, first.inbox);
  assert.ok(fs.readFileSync(env.mapFile).equals(before), 'map.json bytes are unchanged');
  const writes = env.recorder.calls.filter((call) => WRITE_METHODS.includes(call.method));
  assert.deepEqual(writes, [], 'no write-capable fs call is made');
});

test('map store applies every effective change of concurrent attach and detach calls', async (t) => {
  const { env, store } = await openWithLinks(t, [LINK_1, LINK_2, LINK_3]);
  await store.attach(LINK_1.key, SESSION_A);
  await store.attach(LINK_1.key, SESSION_B);
  await store.attach(LINK_2.key, SESSION_A);

  await Promise.all([
    store.attach(LINK_1.key, SESSION_C),
    store.attach(LINK_2.key, SESSION_B),
    store.attach(LINK_2.key, SESSION_D),
    store.detach(LINK_1.key, SESSION_A),
    store.detach(LINK_2.key, SESSION_A),
    store.attach(LINK_1.key, SESSION_E),
    store.detach(LINK_1.key, SESSION_B),
    store.attach(LINK_3.key, SESSION_E),
  ]);

  assert.deepEqual(sortedSessions(store, LINK_1.key), [SESSION_C, SESSION_E]);
  assert.deepEqual(sortedSessions(store, LINK_2.key), [SESSION_B, SESSION_D]);
  assert.deepEqual(sortedSessions(store, LINK_3.key), [SESSION_E]);
  assert.deepEqual(readMap(env), store.snapshot());
  const reloaded = await env.open();
  assert.deepEqual(reloaded.snapshot(), store.snapshot());
});

test('map store writes through one serialized writer: staged temp, fsync, rename onto map.json', async (t) => {
  const { env, store } = await openWithLinks(t, [LINK_1, LINK_2]);
  env.recorder.clearCalls();

  await Promise.all([
    store.attach(LINK_1.key, SESSION_A),
    store.attach(LINK_2.key, SESSION_B),
    store.attach(LINK_1.key, SESSION_C),
    store.detach(LINK_2.key, SESSION_B),
    store.attach(LINK_2.key, SESSION_D),
  ]);

  const calls = env.recorder.calls;
  const writes = calls
    .map((call, index) => ({ call, index }))
    .filter(({ call }) => call.method === 'renameSync')
    .map(({ call, index }) => {
      const [staged, target] = call.args;
      return {
        staged,
        target,
        renameIndex: index,
        startIndex: calls.findIndex((other) => other.args[0] === staged),
      };
    });

  assert.ok(writes.length >= 1, 'at least one map write was recorded');
  for (const write of writes) {
    assert.equal(write.target, env.mapFile, 'every rename lands on map.json');
    assert.notEqual(write.staged, env.mapFile, 'the staged file has another name');
    assert.equal(path.dirname(write.staged), env.directory, 'in the same directory');
    assert.ok(write.startIndex !== -1 && write.startIndex < write.renameIndex, 'staged first');
    assert.ok(
      calls.slice(write.startIndex, write.renameIndex).some((call) => call.method === 'fsyncSync'),
      'fsync runs between staging and the rename',
    );
  }
  assert.equal(new Set(writes.map((write) => write.staged)).size, writes.length);
  for (let index = 1; index < writes.length; index++)
    assert.ok(
      writes[index].startIndex > writes[index - 1].renameIndex,
      'a write is staged only after the previous write was renamed into place',
    );
  assert.deepEqual(
    fs.readdirSync(env.directory).filter((name) => name.endsWith('.tmp')),
    [],
    'no staged file is left behind',
  );
});

test('map store file is mode 600 in a mode 700 directory and parses to the snapshot', async (t) => {
  const { env, store } = await openWithLinks(t, [LINK_1, LINK_2]);
  await store.attach(LINK_1.key, SESSION_A);

  assert.equal(modeOf(env.mapFile), 0o600);
  assert.equal(modeOf(env.directory), 0o700);
  assert.deepEqual(readMap(env), store.snapshot());
});

test('map store reload over the same home shows the stored map', async (t) => {
  const { env, store } = await openWithLinks(t, [LINK_1, LINK_2]);
  await store.attach(LINK_1.key, SESSION_A);
  await store.attach(LINK_2.key, SESSION_B);
  await store.setLastNotifiedTs(LINK_2.key, tsAt(30));

  const reloaded = await env.open();

  assert.deepEqual(reloaded.snapshot(), store.snapshot());
  assert.equal(reloaded.snapshot().links[LINK_2.key].lastNotifiedTs, tsAt(30));
  assert.deepEqual(reloaded.snapshot().links[LINK_1.key].sessionIds, [SESSION_A]);
});

test('map store keeps the previous map when the rename fails and the queue is not wedged', async (t) => {
  const { env, store } = await openWithLinks(t, [LINK_1]);
  await store.attach(LINK_1.key, SESSION_A);
  const bytesBefore = fs.readFileSync(env.mapFile);
  const previous = store.snapshot();
  env.recorder.failOn(
    'renameSync',
    (args) => args[1] === env.mapFile,
    Object.assign(new Error('synthetic rename failure'), { code: 'EIO' }),
  );

  let pending;
  assert.doesNotThrow(() => {
    pending = store.attach(LINK_1.key, SESSION_B);
  }, 'a failing write never throws synchronously');
  await Promise.resolve(pending).then(
    () => {},
    () => {},
  );

  assert.ok(fs.readFileSync(env.mapFile).equals(bytesBefore), 'the previous bytes are on disk');
  const reloaded = await env.open();
  assert.deepEqual(reloaded.snapshot(), previous);

  await assert.doesNotReject(async () => store.attach(LINK_1.key, SESSION_C));
  const afterwards = await env.open();
  assert.ok(afterwards.snapshot().links[LINK_1.key].sessionIds.includes(SESSION_C));
  assert.deepEqual(afterwards.snapshot(), store.snapshot());
});

test('map store load ignores a stray temp file', async (t) => {
  const { env, store } = await openWithLinks(t, [LINK_1]);
  await store.attach(LINK_1.key, SESSION_A);
  const previous = store.snapshot();
  fs.writeFileSync(path.join(env.directory, STRAY_TEMP_NAME), '{not json');
  fs.writeFileSync(
    path.join(env.directory, `${STRAY_TEMP_NAME}.second.tmp`),
    JSON.stringify({ version: 1, links: { [LINK_2.key]: { ...LINK_2, sessionIds: [SESSION_D] } } }),
  );

  const reloaded = await env.open();

  assert.deepEqual(reloaded.snapshot(), previous);
  await reloaded.attach(LINK_1.key, SESSION_B);
  assert.deepEqual(sortedSessions(reloaded, LINK_1.key), [SESSION_A, SESSION_B]);
});

const UNUSABLE_MAPS = {
  'a missing map': null,
  'a garbage map': '{not json',
  'a map of the wrong shape': '{"links":"x"}',
  'an array instead of a map': '[]',
  'a null map': 'null',
};

for (const [label, text] of Object.entries(UNUSABLE_MAPS))
  test(`map store loads empty from ${label} without throwing`, async (t) => {
    const env = storeEnvironment(t);
    if (text !== null) {
      fs.mkdirSync(env.directory, { recursive: true, mode: 0o700 });
      fs.writeFileSync(env.mapFile, text, { mode: 0o600 });
    }

    const store = await env.open();

    assert.deepEqual(store.snapshot(), { version: 1, links: {} });
    await store.addLink(LINK_1);
    assert.deepEqual(Object.keys(readMap(env).links), [LINK_1.key], 'a later write recovers');
  });

test('scenario 62: map store removes its temp file when the rename fails', async (t) => {
  const { env, store } = await openWithLinks(t, [LINK_1]);
  await store.attach(LINK_1.key, SESSION_A);
  env.recorder.failOn(
    'renameSync',
    (args) => args[1] === env.mapFile,
    Object.assign(new Error('synthetic rename failure'), { code: 'EIO' }),
  );

  await Promise.resolve(store.attach(LINK_1.key, SESSION_B)).then(
    () => {},
    () => {},
  );

  const strays = fs.readdirSync(env.directory).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(strays, [], 'no temp file is left beside map.json');
});

test('map store loads empty when reading the map throws', async (t) => {
  const { env } = await openWithLinks(t, [LINK_1]);
  env.recorder.failOn(
    'readFileSync',
    (args) => args[0] === env.mapFile,
    Object.assign(new Error('synthetic read failure'), { code: 'EACCES' }),
  );

  const store = await env.open();

  assert.deepEqual(store.snapshot(), { version: 1, links: {} });
});

test('inbox is created empty with mode 600 on the first attach', async (t) => {
  const { env, store } = await openWithLinks(t, [LINK_1]);
  assert.deepEqual(inboxNames(env), [], 'adding a link creates no inbox');
  const expected = `${env.home}/.config/dev-dashboard/slack-watch/inbox/${SESSION_A}.log`;

  const attached = await store.attach(LINK_1.key, SESSION_A);

  assert.equal(attached.inbox, expected);
  assert.equal(store.inboxPath(SESSION_A), expected);
  assert.equal(fs.readFileSync(expected, 'utf8'), '');
  assert.equal(modeOf(expected), 0o600);
  assert.equal(modeOf(env.inboxDirectory), 0o700);
});

test('inbox is shared by two links on one session', async (t) => {
  const { env, store } = await openWithLinks(t, [LINK_1, LINK_2]);

  const first = await store.attach(LINK_1.key, SESSION_A);
  const second = await store.attach(LINK_2.key, SESSION_A);

  assert.equal(second.inbox, first.inbox);
  assert.deepEqual(inboxNames(env), [`${SESSION_A}.log`]);
  await store.append(SESSION_A, 'one line for both links');
  assert.deepEqual(inboxNames(env), [`${SESSION_A}.log`]);
});

test('inbox is kept while a link remains and removed with the last detach', async (t) => {
  const { env, store } = await openWithLinks(t, [LINK_1, LINK_2]);
  await store.attach(LINK_1.key, SESSION_A);
  await store.attach(LINK_2.key, SESSION_A);
  await store.append(SESSION_A, 'kept line');

  await store.detach(LINK_1.key, SESSION_A);

  assert.equal(fs.readFileSync(env.inboxFile(SESSION_A), 'utf8'), 'kept line\n');

  await store.detach(LINK_2.key, SESSION_A);

  assert.equal(fs.existsSync(env.inboxFile(SESSION_A)), false);
  assert.deepEqual(inboxNames(env), []);
});

test('inbox is removed when removeLink orphans its session and kept when another link remains', async (t) => {
  const { env, store } = await openWithLinks(t, [LINK_1, LINK_2]);
  await store.attach(LINK_1.key, SESSION_A);
  await store.attach(LINK_1.key, SESSION_B);
  await store.attach(LINK_2.key, SESSION_A);

  await store.removeLink(LINK_1.key);

  assert.deepEqual(inboxNames(env), [`${SESSION_A}.log`], 'only the orphaned session lost it');

  await store.removeLink(LINK_2.key);

  assert.deepEqual(inboxNames(env), []);
});

test('inbox removeSession detaches the session from every link and removes its inbox', async (t) => {
  const { env, store } = await openWithLinks(t, [LINK_1, LINK_2, LINK_3]);
  await store.attach(LINK_1.key, SESSION_A);
  await store.attach(LINK_1.key, SESSION_B);
  await store.attach(LINK_2.key, SESSION_A);
  await store.attach(LINK_3.key, SESSION_A);
  await store.append(SESSION_B, 'untouched line');

  await store.removeSession(SESSION_A);

  assert.deepEqual(store.snapshot().links[LINK_1.key].sessionIds, [SESSION_B]);
  assert.deepEqual(store.snapshot().links[LINK_2.key].sessionIds, []);
  assert.deepEqual(store.snapshot().links[LINK_3.key].sessionIds, []);
  assert.deepEqual(inboxNames(env), [`${SESSION_B}.log`]);
  assert.equal(fs.readFileSync(env.inboxFile(SESSION_B), 'utf8'), 'untouched line\n');
  assert.deepEqual(readMap(env), store.snapshot());
});

test('inbox append adds exactly one newline-ended line and leaves earlier lines untouched', async (t) => {
  const { env, store } = await openWithLinks(t, [LINK_1]);
  await store.attach(LINK_1.key, SESSION_A);
  await store.attach(LINK_1.key, SESSION_B);
  const file = env.inboxFile(SESSION_A);

  await store.append(SESSION_A, 'first notice');
  assert.equal(fs.readFileSync(file, 'utf8'), 'first notice\n');

  await store.append(SESSION_A, `second notice ${LINK_1.link}`);
  assert.equal(fs.readFileSync(file, 'utf8'), `first notice\nsecond notice ${LINK_1.link}\n`);

  assert.equal(modeOf(file), 0o600);
  assert.equal(fs.readFileSync(env.inboxFile(SESSION_B), 'utf8'), '', 'another inbox is untouched');
});

test('inbox concurrent appends each add one whole line', async (t) => {
  const { env, store } = await openWithLinks(t, [LINK_1]);
  await store.attach(LINK_1.key, SESSION_A);
  const lines = ['line one', 'line two', 'line three', 'line four', 'line five', 'line six'];

  await Promise.all(lines.map((line) => store.append(SESSION_A, line)));

  const text = fs.readFileSync(env.inboxFile(SESSION_A), 'utf8');
  assert.ok(text.endsWith('\n'));
  assert.deepEqual(text.slice(0, -1).split('\n').sort(), [...lines].sort());
});

const BAD_SESSION_IDS = [
  { label: 'a path traversal', id: '../../etc/passwd', fragments: ['passwd'] },
  { label: 'a short id', id: 'fc6372e4', fragments: ['fc6372e4'] },
  { label: 'an empty id', id: '', fragments: [] },
  { label: 'a number', id: 20260601123456, fragments: ['20260601123456'] },
];

const SESSION_OPERATIONS = {
  inboxPath: (store, id) => store.inboxPath(id),
  append: (store, id) => store.append(id, 'a notice line'),
  attach: (store, id) => store.attach(LINK_1.key, id),
  detach: (store, id) => store.detach(LINK_1.key, id),
  removeSession: (store, id) => store.removeSession(id),
};

for (const { label, id, fragments } of BAD_SESSION_IDS)
  test(`inbox refuses ${label} with INVALID_SESSION before any path is built`, async (t) => {
    const { env, store } = await openWithLinks(t, [LINK_1]);
    const filesBefore = listFiles(env.home);
    const mapBefore = fs.readFileSync(env.mapFile);
    env.recorder.clearCalls();

    for (const [name, operation] of Object.entries(SESSION_OPERATIONS)) {
      const error = await failureOf(() => operation(store, id));
      assert.ok(error, `${name} must refuse ${label}`);
      assert.equal(error.code, 'INVALID_SESSION', `${name} refuses with INVALID_SESSION`);
    }

    const stringArguments = env.recorder.calls.flatMap((call) =>
      call.args.filter((argument) => typeof argument === 'string'),
    );
    for (const argument of stringArguments) {
      assert.equal(argument.includes('..'), false, `no path holds '..': ${argument}`);
      assert.equal(argument.endsWith('.log'), false, `no inbox path is built: ${argument}`);
      for (const fragment of fragments)
        assert.equal(argument.includes(fragment), false, `no fs argument holds the bad id`);
    }
    assert.deepEqual(listFiles(env.home), filesBefore, 'no file appears');
    assert.ok(fs.readFileSync(env.mapFile).equals(mapBefore), 'map.json is untouched');

    await store.attach(LINK_1.key, SESSION_A);
    assert.deepEqual(inboxNames(env), [`${SESSION_A}.log`], 'a valid attach still works after');
  });
