// harness-conformance.test.mjs — the harness adapter seam (backend/harness): the registry, the shape
// check, the generic helpers every sessions service builds on, and the conformance suite every adapter
// passes. The suite loops over `HARNESSES` plus the test-only adapter in harness-fake.mjs, the way
// mascots.test.mjs loops over MASCOTS; each adapter needs a driver in DRIVERS, so a registered harness
// without one fails. The Claude Code driver runs the real adapter over recording fakes (an injected
// `execFileImpl`, a temp home); the fake adapter runs its scripted service. Nothing real is started.
//
// The backend modules are imported inside the helpers, so a scenario fails by itself while a module
// is missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeHarness } from './harness-fake.mjs';
import {
  SESSION_A,
  SESSION_B,
  SESSION_C,
  SESSION_E,
  captureConsole,
  createClock,
  createFakeExec,
  listingEntry,
} from './slack-watch-fixture.mjs';
import {
  INVESTIGATE,
  START_MS,
  launchRecord,
  listed,
  sessionUuid,
  statusFile,
} from './claude-launcher-fixture.mjs';

const SECRET_NAMES = ['GH_TOKEN', 'GITHUB_TOKEN', 'JIRA_API_TOKEN', 'JIRA_TOKEN'];
const MESSAGE = 'sentinel-message-text-5c3e';
const SHORT = 'abcd1234';
const STATE_WORDS = ['working', 'blocked', 'done', 'stopped'];
const TOKEN_KEYS = ['cacheCreation', 'cacheRead', 'input', 'output'];

// The registry is loaded once; when it is missing, the scenarios that need it fail with its error.
const registry = await import('../backend/harness/index.mjs').catch((error) => ({ error }));
const needRegistry = () => {
  if (registry.error) throw registry.error;
  return registry;
};
const loadContract = () => import('../backend/harness/contract.mjs');
const loadEntry = () => import('../backend/harness/session-entry.mjs');
const loadLock = () => import('../backend/harness/session-lock.mjs');

// ---- drivers: how each adapter is built with fakes, and what its world looks like ----
//
// A driver answers `{ harness, sessions, world, usageLines, cleanup }`. `world.listing(entries|null)`
// is what the harness lists (null: unusable), `world.child('ok'|'timeout'|'error')` is what a process
// it starts does, `world.starts()` are the processes started, `{ file, args, options, session }`
// (`session` marks one that starts or continues a session).

async function claudeDriver() {
  const { harnessById } = needRegistry();
  const { createSlackWatchStore } = await import('../backend/slack-watch-store.mjs');
  const harness = harnessById('claude-code');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-conformance-'));
  const store = createSlackWatchStore({ home, fs, now: createClock().now });
  const exec = createFakeExec();
  const sessions = harness.createSessions({
    execFileImpl: exec.execFileImpl,
    store,
    projectsDir: path.join(home, '.claude', 'projects'),
  });
  const childOutcome = {
    ok: () => ({ stdout: `started ${SHORT}` }),
    timeout: () => ({ timeout: true }),
    error: () => ({ spawnError: 'ENOENT' }),
  };
  const world = {
    listing(entries) {
      if (entries === null) exec.onListing(() => ({ spawnError: 'ENOENT' }));
      else exec.setListing(entries);
    },
    child(outcome) {
      exec.onStop(childOutcome[outcome]);
      exec.onResume(childOutcome[outcome]);
    },
    starts: () =>
      exec.calls.map(({ file, args, options }) => ({
        file,
        args,
        options,
        session: args.includes('--bg'),
      })),
  };
  const usageLines = {
    usage: JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_1',
        model: 'claude-opus-4-5',
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    }),
    other: JSON.stringify({ type: 'user', message: { content: 'hello' } }),
  };
  return {
    harness,
    sessions,
    world,
    usageLines,
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
  };
}

async function fakeDriver() {
  const fake = await createFakeHarness();
  const sessions = fake.harness.createSessions({});
  const world = {
    listing: fake.setEntries,
    child: fake.setChild,
    starts: () => fake.starts,
  };
  const usageLines = {
    usage: JSON.stringify({ fake_usage: { id: 'fake-1', model: 'fake-model', in: 3, out: 4 } }),
    other: JSON.stringify({ hello: 'world' }),
  };
  return { harness: fake.harness, sessions, world, usageLines, cleanup() {} };
}

const DRIVERS = { 'claude-code': claudeDriver, fake: fakeDriver };

// Every registered adapter, then the test-only one. While the registry is missing the Claude Code
// driver still names its scenarios, so each fails on the missing module.
const ADAPTER_IDS = [...(registry.HARNESSES?.map(({ id }) => id) ?? ['claude-code']), 'fake'];

async function withDriver(t, id) {
  const driver = DRIVERS[id];
  assert.ok(
    driver,
    `registered harness ${id} needs a driver in DRIVERS (harness-conformance.test)`,
  );
  const built = await driver();
  t.after(built.cleanup);
  return built;
}

// What the dashboard never hands to a process: the credential names, present for the test.
function withSecretsInEnvironment(t) {
  for (const name of SECRET_NAMES) {
    const previous = process.env[name];
    process.env[name] = `synthetic-${name}`;
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
}

// ---- the contract's vocabularies ----

const FAILED = {
  launch: {
    'failed-permanent': ['untrusted_workspace'],
    'failed-transient': ['timed_out', 'spawn_failed'],
  },
  stop: {
    'failed-permanent': ['ambiguous_id'],
    'failed-transient': ['listing_unavailable', 'timed_out', 'stop_failed'],
  },
  resume: {
    'failed-permanent': ['resume_forked', 'untrusted_workspace'],
    'failed-transient': ['listing_unavailable', 'timed_out', 'spawn_failed'],
  },
};

function assertVocabulary(kind, result, label) {
  const failures = FAILED[kind];
  if (result.status in failures) {
    assert.ok(failures[result.status].includes(result.reason), `${label}: reason ${result.reason}`);
    return;
  }
  if (kind === 'launch') {
    assert.equal(result.status, 'delivered', `${label}: status ${result.status}`);
    assert.ok(result.id === null || /^[0-9a-f]{8}$/.test(result.id), `${label}: id ${result.id}`);
  } else if (kind === 'stop') {
    assert.ok(
      ['stopped', 'not_listed', 'not_idle'].includes(result.status),
      `${label}: ${result.status}`,
    );
  } else {
    const ok =
      (result.status === 'delivered' && ['resumed', 'not_listed'].includes(result.reason)) ||
      (result.status === 'waiting' && result.reason === 'live_at_resume');
    assert.ok(ok, `${label}: ${result.status} ${result.reason}`);
  }
}

function assertContractEntry(entry, label) {
  assert.match(
    entry.sessionId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    label,
  );
  assert.ok(STATE_WORDS.includes(entry.state), `${label}: state ${entry.state}`);
  assert.ok(entry.id === undefined || /^[0-9a-f]{8}$/.test(entry.id), `${label}: short id`);
}

// One pass over the sessions service: a usable listing, then each way a started process can end, then
// an unusable listing. Answers every result, tagged with the call that made it.
async function exercise({ sessions, world }) {
  const live = listingEntry({ sessionId: SESSION_A, pid: 4242, status: 'idle', state: 'working' });
  const done = listingEntry({ sessionId: SESSION_B, cwd: '/work/finished', state: 'done' });
  const nameless = { ...listingEntry({ sessionId: SESSION_C }), sessionId: 'not-a-session-id' };
  const results = [];
  const note = (kind, label, result) => results.push({ kind, label, result });

  world.listing([live, done, nameless]);
  world.child('ok');
  note('entries', 'fresh', await sessions.entries({ fresh: true }));
  note('entries', 'shared', await sessions.entries());
  note('launch', 'ok', await sessions.launch({ name: 'n', prompt: 'p', cwd: '/work' }));
  note('stop', 'idle', await sessions.stop({ sessionId: SESSION_A }));
  note('stop', 'finished', await sessions.stop({ sessionId: SESSION_B }));
  note('stop', 'unlisted', await sessions.stop({ sessionId: SESSION_E }));
  note('resume', 'finished', await sessions.resume({ sessionId: SESSION_B, notice: 'n' }));
  note('resume', 'unlisted', await sessions.resume({ sessionId: SESSION_E, notice: 'n' }));
  note('resume', 'live', await sessions.resume({ sessionId: SESSION_A, notice: 'n' }));
  for (const outcome of ['timeout', 'error']) {
    world.child(outcome);
    note('launch', outcome, await sessions.launch({ name: 'n', prompt: 'p', cwd: '/work' }));
    note('stop', outcome, await sessions.stop({ sessionId: SESSION_A }));
    note('resume', outcome, await sessions.resume({ sessionId: SESSION_B, notice: 'n' }));
  }
  world.listing(null);
  note('entries', 'unusable', await sessions.entries({ fresh: true }));
  note('stop', 'unusable', await sessions.stop({ sessionId: SESSION_A }));
  note('resume', 'unusable', await sessions.resume({ sessionId: SESSION_B, notice: 'n' }));
  return results;
}

// ---- the registry, the shape check and the generic helpers ----

test('registry: Claude Code is the only registered harness and the default', async () => {
  const { HARNESSES, DEFAULT_HARNESS_ID, defaultHarness, harnessById } = needRegistry();
  assert.ok(Object.isFrozen(HARNESSES), 'the list is frozen');
  assert.deepEqual(
    HARNESSES.map(({ id }) => id),
    ['claude-code'],
  );
  assert.equal(DEFAULT_HARNESS_ID, 'claude-code');
  assert.equal(defaultHarness(), HARNESSES[0]);
  assert.equal(harnessById('claude-code'), HARNESSES[0]);
  assert.ok(Object.isFrozen(HARNESSES[0]), 'an adapter is one frozen object');
  const { default: adapter } = await import('../backend/harness/claude-code/index.mjs');
  assert.equal(HARNESSES[0], adapter, 'the registry holds the default export of the adapter');
});

test('registry: harnessMeta of Claude Code is the metadata the UI is given', () => {
  const { harnessMeta, defaultHarness } = needRegistry();
  assert.deepEqual(harnessMeta(defaultHarness()), {
    id: 'claude-code',
    label: 'Claude Code',
    name: 'Claude',
    command: 'claude',
    capabilities: { chat: true, usage: true },
  });
});

test('registry: harnessIdOf reads a stored id and anything else as Claude Code', () => {
  const { harnessIdOf } = needRegistry();
  assert.equal(harnessIdOf({ harness: 'fake' }), 'fake');
  assert.equal(harnessIdOf({ harness: 'claude-code' }), 'claude-code');
  for (const record of [{}, { harness: 'Bad Id' }, { harness: 7 }, { harness: '' }])
    assert.equal(harnessIdOf(record), 'claude-code', JSON.stringify(record));
});

test('registry: harnessStamp is empty for the default harness and names any other', async () => {
  const { harnessStamp, defaultHarness } = needRegistry();
  const { harness } = await createFakeHarness();
  assert.deepEqual(harnessStamp(defaultHarness()), {});
  assert.deepEqual(harnessStamp(harness), { harness: 'fake' });
});

test('assertHarness accepts Claude Code and the fake, with and without their optional facets', async () => {
  const { assertHarness } = await loadContract();
  const { defaultHarness } = needRegistry();
  assertHarness(defaultHarness());
  assertHarness((await createFakeHarness()).harness);
  assertHarness((await createFakeHarness({ without: ['chat', 'usage', 'limits'] })).harness);
});

test('assertSessions rejects a sessions service missing a method', async () => {
  const { assertSessions } = await loadContract();
  const { sessions } = await fakeDriver();
  const partial = { ...sessions, stop: undefined };
  assert.throws(() => assertSessions(partial, 'fake'), /sessions\.stop/);
  assert.throws(() => assertSessions(null, 'fake'), /sessions\.entries/);
});

test('assertHarness rejects a missing commands.resume, a bad id, an over-long text and a half facet', async () => {
  const { assertHarness } = await loadContract();
  const { harness } = await createFakeHarness();
  const noResume = { ...harness, commands: { attach: harness.commands.attach } };
  const rejected = {
    'missing commands.resume': noResume,
    'bad id': { ...harness, id: 'Bad Id' },
    'label over 40 characters': { ...harness, label: 'x'.repeat(41) },
    'no prompt words': { ...harness, prompt: undefined },
    'prompt without askTool': { ...harness, prompt: { skill: 'playbook' } },
    'empty prompt skill': { ...harness, prompt: { ...harness.prompt, skill: '' } },
    'prompt word over 40 characters': {
      ...harness,
      prompt: { ...harness.prompt, skill: 'x'.repeat(41) },
    },
    'chat without historyItems': { ...harness, chat: { ...harness.chat, historyItems: undefined } },
    'usage without parseLine': { ...harness, usage: {} },
  };
  for (const [label, adapter] of Object.entries(rejected))
    assert.throws(() => assertHarness(adapter), label);
});

test('stateOf reads a live pid, a stopped null pid and a finished entry as the sessions service does', async () => {
  const { stateOf } = await loadEntry();
  assert.equal(stateOf({ pid: 4242 }), 'live');
  assert.equal(stateOf({ pid: null, state: 'stopped' }), 'finished');
  assert.equal(stateOf({}), 'finished');
  assert.equal(stateOf({ pid: null, state: 'done' }), 'unknown');
  assert.equal(stateOf({ pid: 'x' }), 'unknown');
});

test('settleSession stops a live session and polls until it has no pid, else says why not', async () => {
  const { settleSession } = await loadEntry();
  const stopped = [];
  let reads = 0;
  const observed = [{ pid: 7 }, { pid: 7 }, {}];
  const settled = await settleSession({
    observe: async () => ({ listing: [], session: observed[Math.min(reads++, 2)] }),
    stop: async (session) => {
      stopped.push(session);
      return { status: 'stopped' };
    },
    wait: async () => {},
    limit: 5,
  });
  assert.equal(settled.status, 'settled');
  assert.equal(stopped.length, 1, 'stopped once');

  const never = await settleSession({
    observe: async () => ({ listing: [], session: { pid: 7 } }),
    stop: async () => ({ status: 'stopped' }),
    wait: async () => {},
    limit: 2,
  });
  assert.deepEqual(never, { status: 'failed', reason: 'live_at_resume' });
  const notIdle = await settleSession({
    observe: async () => ({ listing: [], session: { pid: 7 } }),
    stop: async () => ({ status: 'not_idle' }),
    wait: async () => {},
    limit: 2,
  });
  assert.deepEqual(notIdle, { status: 'failed', reason: 'session_running' });
  const unlisted = await settleSession({
    observe: async () => ({ listing: null, session: null }),
    stop: async () => ({ status: 'stopped' }),
    wait: async () => {},
    limit: 2,
  });
  assert.deepEqual(unlisted, { status: 'failed', reason: 'listing_unavailable' });
});

test('createSessionLock: one writer per session, a held session reads working, a late release frees nothing', async () => {
  const { createSessionLock } = await loadLock();
  const lock = createSessionLock();
  const release = lock.beginTurn(SESSION_A);
  assert.equal(typeof release, 'function');
  assert.equal(lock.beginTurn(SESSION_A), null, 'a second writer is refused');
  assert.equal(lock.isHeld(SESSION_A), true);
  assert.equal(lock.isHeld(SESSION_B), false);

  const entries = [
    { sessionId: SESSION_A, state: 'done' },
    { sessionId: SESSION_B, state: 'done' },
  ];
  assert.deepEqual(lock.overlay(entries), [
    { sessionId: SESSION_A, state: 'working' },
    { sessionId: SESSION_B, state: 'done' },
  ]);

  release();
  release();
  assert.equal(lock.isHeld(SESSION_A), false);
  const second = lock.beginTurn(SESSION_A);
  assert.equal(typeof second, 'function');
  release();
  assert.equal(lock.beginTurn(SESSION_A), null, 'the first release, called late, freed nothing');
});

// ---- the conformance suite, once per adapter ----

for (const id of ADAPTER_IDS) {
  test(`conformance ${id}: it passes assertHarness and its metadata is derived from its facets`, async (t) => {
    const { assertHarness } = await loadContract();
    const { harnessMeta } = needRegistry();
    const { harness } = await withDriver(t, id);
    assertHarness(harness);
    assert.deepEqual(harnessMeta(harness), {
      id: harness.id,
      label: harness.label,
      name: harness.name,
      command: harness.command,
      capabilities: { chat: Boolean(harness.chat), usage: Boolean(harness.usage) },
    });
  });

  test(`conformance ${id}: it supplies the prompt words, and the shared prompts are filled from them`, async (t) => {
    const { harnessValues, fillTemplate, PROMPT_TEMPLATES } =
      await import('../backend/claude-prompts.mjs');
    const { harness } = await withDriver(t, id);
    for (const word of ['skill', 'askTool'])
      assert.ok(
        typeof harness.prompt?.[word] === 'string' && harness.prompt[word],
        `prompt.${word}`,
      );
    const words = harnessValues(harness);
    assert.deepEqual(words, { SKILL: harness.prompt.skill, ASK_TOOL: harness.prompt.askTool });
    const text = fillTemplate(PROMPT_TEMPLATES.investigate, { ...words, KEY: 'TAP-1' });
    assert.ok(text.includes(`\`orchestrator\` ${words.SKILL} `), "the skill word is the adapter's");
    assert.ok(text.includes(`with ${words.ASK_TOOL}:`), "the ask word is the adapter's");
  });

  test(`conformance ${id}: its sessions service has exactly the contract's methods`, async (t) => {
    const { assertSessions, SESSION_METHODS } = await loadContract();
    const { sessions, harness } = await withDriver(t, id);
    assertSessions(sessions, harness.id);
    assert.deepEqual(Object.keys(sessions).sort(), [...SESSION_METHODS].sort());
  });

  test(`conformance ${id}: every process it starts uses its command, an argument array, no shell and no credential`, async (t) => {
    withSecretsInEnvironment(t);
    const driver = await withDriver(t, id);
    await exercise(driver);
    const starts = driver.world.starts();
    assert.ok(starts.length > 0, 'the exercise started processes');
    for (const { file, args, options, session } of starts) {
      assert.equal(file, driver.harness.command, 'the adapter command is the binary');
      assert.ok(Array.isArray(args) && args.every((arg) => typeof arg === 'string'), 'arguments');
      assert.ok(!options || !('shell' in options), 'no shell option');
      for (const name of SECRET_NAMES)
        assert.ok(!options?.env || !(name in options.env), `${name} is not in the environment`);
      // A process that runs a session is always given the scrubbed environment.
      if (session) assert.ok(options?.env, 'a session start passes its environment explicitly');
    }
  });

  test(`conformance ${id}: entries are contract entries, and null for an unusable listing`, async (t) => {
    const driver = await withDriver(t, id);
    const results = await exercise(driver);
    for (const { label, result } of results.filter(({ kind }) => kind === 'entries')) {
      if (label === 'unusable') {
        assert.equal(result, null, 'unusable listing');
        continue;
      }
      assert.deepEqual(
        result.map(({ sessionId }) => sessionId),
        [SESSION_A, SESSION_B],
        `${label}: an entry without a session id is dropped`,
      );
      result.forEach((entry) => assertContractEntry(entry, label));
    }
  });

  test(`conformance ${id}: launch, stop and resume answer only the contract vocabularies`, async (t) => {
    const driver = await withDriver(t, id);
    const results = await exercise(driver);
    for (const { kind, label, result } of results.filter(({ kind }) => kind !== 'entries'))
      assertVocabulary(kind, result, `${kind} ${label}`);
    const byLabel = (kind, label) =>
      results.find((r) => r.kind === kind && r.label === label).result;
    assert.equal(byLabel('stop', 'idle').status, 'stopped');
    assert.equal(byLabel('stop', 'unlisted').status, 'not_listed');
    assert.equal(byLabel('stop', 'unusable').reason, 'listing_unavailable');
    assert.equal(byLabel('resume', 'finished').reason, 'resumed');
    assert.equal(byLabel('resume', 'unlisted').reason, 'not_listed');
    assert.equal(byLabel('resume', 'live').reason, 'live_at_resume');
    assert.equal(byLabel('launch', 'timeout').reason, 'timed_out');
    assert.equal(byLabel('launch', 'error').reason, 'spawn_failed');
  });

  test(`conformance ${id}: the one-writer mark gives a release, refuses a second writer and reads working`, async (t) => {
    const { sessions, world } = await withDriver(t, id);
    world.listing([listingEntry({ sessionId: SESSION_B, state: 'done' })]);
    const stateOfB = async () =>
      (await sessions.entries({ fresh: true })).find((entry) => entry.sessionId === SESSION_B)
        .state;
    assert.equal(await stateOfB(), 'done');
    const release = sessions.beginTurn(SESSION_B);
    assert.equal(typeof release, 'function');
    assert.equal(sessions.beginTurn(SESSION_B), null);
    assert.equal(sessions.isHeld(SESSION_B), true);
    assert.equal(await stateOfB(), 'working');
    release();
    assert.equal(sessions.isHeld(SESSION_B), false);
    assert.equal(await stateOfB(), 'done');
  });

  test(`conformance ${id}: its attach and resume commands are a string or null and contain the id`, async (t) => {
    const { harness } = await withDriver(t, id);
    for (const [member, argument] of [
      ['attach', SHORT],
      ['resume', SESSION_A],
    ]) {
      const command = harness.commands[member](argument);
      assert.ok(
        command === null || (typeof command === 'string' && command.includes(argument)),
        member,
      );
    }
  });

  test(`conformance ${id}: chat.buildTurn puts the message in input and never in the arguments`, async (t) => {
    const { harness } = await withDriver(t, id);
    if (!harness.chat) return;
    for (const resuming of [true, false]) {
      const turn = harness.chat.buildTurn({ sessionId: SESSION_A, resuming, message: MESSAGE });
      assert.equal(turn.command, harness.command);
      assert.ok(Array.isArray(turn.args) && turn.args.every((arg) => typeof arg === 'string'));
      assert.ok(!turn.args.some((arg) => arg.includes(MESSAGE)), 'the message is not an argument');
      assert.ok(
        turn.args.some((arg) => arg.includes(SESSION_A)),
        'the arguments name the session',
      );
      assert.equal(typeof turn.input, 'string');
      assert.ok(turn.input.includes(MESSAGE), 'the message is on stdin');
    }
  });

  test(`conformance ${id}: usage.parseLine returns numbers and a model id string or null, else null`, async (t) => {
    const { harness, usageLines } = await withDriver(t, id);
    if (!harness.usage) return;
    const parsed = harness.usage.parseLine(usageLines.usage);
    assert.equal(typeof parsed.id, 'string');
    assert.ok(parsed.model === null || typeof parsed.model === 'string');
    assert.deepEqual(Object.keys(parsed.tokens).sort(), TOKEN_KEYS);
    for (const value of Object.values(parsed.tokens)) assert.ok(Number.isFinite(value));
    assert.equal(harness.usage.parseLine(usageLines.other), null);
    assert.equal(harness.usage.parseLine('not json'), null);
  });

  test(`conformance ${id}: nothing is written to the console while it runs`, async (t) => {
    const driver = await withDriver(t, id);
    const lines = captureConsole(t);
    await exercise(driver);
    const { harness, usageLines } = driver;
    harness.chat?.buildTurn({ sessionId: SESSION_A, resuming: true, message: MESSAGE });
    harness.usage?.parseLine(usageLines.usage);
    harness.homeReadable(os.tmpdir());
    assert.deepEqual(lines, []);
  });
}

test('conformance: every registered harness has a driver in the suite', () => {
  for (const { id } of needRegistry().HARNESSES)
    assert.ok(DRIVERS[id], `registered harness ${id} needs a driver in DRIVERS`);
});

// ---- Claude Code: what its adapter sends, byte for byte (plan item 3) ----

async function claude() {
  return needRegistry().defaultHarness();
}

test('claude-code adapter: its identity and facets are the ones the dashboard has always used', async () => {
  const harness = await claude();
  assert.deepEqual(
    [harness.id, harness.label, harness.name, harness.command],
    ['claude-code', 'Claude Code', 'Claude', 'claude'],
  );
  assert.ok(harness.chat && harness.usage && harness.limits?.specReview);
});

test("claude-code adapter: it lists, launches, stops and resumes with today's argument arrays", async (t) => {
  const { sessions, world } = await withDriver(t, 'claude-code');
  const full = {
    name: 'TAP-1-investigate-and-plan',
    prompt: 'the prompt',
    cwd: '/work/dir',
    addDir: '/state/dir',
    tools: ['Read', 'Skill'],
    disallowedTools: ['a', 'b'],
    mcpConfig: '/work/dir/.mcp.json',
  };
  world.listing([
    listingEntry({ sessionId: SESSION_A, pid: 4242, status: 'idle', state: 'working' }),
    listingEntry({ sessionId: SESSION_B, cwd: '/work/finished', state: 'done' }),
  ]);
  world.child('ok');
  await sessions.entries({ fresh: true });
  await sessions.launch(full);
  await sessions.launch({ name: 'n', prompt: 'p', cwd: '/work' });
  await sessions.stop({ sessionId: SESSION_A });
  await sessions.resume({ sessionId: SESSION_B, notice: 'the notice' });

  const starts = world.starts();
  assert.ok(starts.every(({ file }) => file === 'claude'));
  assert.deepEqual(
    starts.map(({ args }) => args),
    [
      ['agents', '--json', '--all'],
      [
        '--bg',
        '--add-dir',
        '/state/dir',
        '--tools',
        'Read,Skill',
        '--disallowedTools',
        'a,b',
        '--strict-mcp-config',
        '--mcp-config',
        '/work/dir/.mcp.json',
        '-n',
        'TAP-1-investigate-and-plan',
        '--',
        'the prompt',
      ],
      ['--bg', '-n', 'n', '--', 'p'],
      ['agents', '--json', '--all'],
      ['stop', SESSION_A.slice(0, 8)],
      ['agents', '--json', '--all'],
      ['--bg', '--resume', SESSION_B, '--', 'the notice'],
    ],
  );
  assert.equal(starts[1].options.cwd, '/work/dir');
  assert.equal(starts.at(-1).options.cwd, '/work/finished');
});

test('claude-code adapter: a chat turn is -p stream-json plus --resume or --session-id, the message on stdin', async () => {
  const { chat } = await claude();
  const base = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
  ];
  const input = `${JSON.stringify({ type: 'user', message: { role: 'user', content: MESSAGE } })}\n`;
  assert.deepEqual(chat.buildTurn({ sessionId: SESSION_A, resuming: true, message: MESSAGE }), {
    command: 'claude',
    args: [...base, '--resume', SESSION_A],
    input,
  });
  assert.deepEqual(chat.buildTurn({ sessionId: SESSION_A, resuming: false, message: MESSAGE }), {
    command: 'claude',
    args: [...base, '--session-id', SESSION_A],
    input,
  });
});

test('claude-code adapter: its chat parsers are the stream-json and transcript readers it always had', async () => {
  const { chat } = await claude();
  const turn = {};
  assert.deepEqual(
    chat.liveMessages(
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      }),
      turn,
    ),
    [{ event: 'delta', data: { text: 'hi' } }],
  );
  const transcript = [
    { type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'hello' } },
    {
      type: 'assistant',
      uuid: 'a1',
      parentUuid: 'u1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
    },
  ]
    .map((line) => JSON.stringify(line))
    .join('\n');
  assert.deepEqual(chat.historyItems(transcript), {
    items: [
      { id: 'u1', kind: 'user', text: 'hello' },
      { id: 'a1', kind: 'assistant', text: 'hi there' },
    ],
    truncated: false,
  });
});

test('claude-code adapter: its commands are claude attach <short id> and claude --resume <id>', async () => {
  const { commands } = await claude();
  assert.equal(commands.attach(SHORT), `claude attach ${SHORT}`);
  assert.equal(commands.resume(SESSION_A), `claude --resume ${SESSION_A}`);
});

test('claude-code adapter: parseLine reads the API usage fields and drops what is not a usage line', async () => {
  const { usage } = await claude();
  const line = (message) => JSON.stringify({ type: 'assistant', message });
  assert.deepEqual(
    usage.parseLine(
      line({
        id: 'msg_1',
        model: 'claude-opus-4-5',
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 40,
        },
      }),
    ),
    {
      id: 'msg_1',
      model: 'claude-opus-4-5',
      tokens: { input: 10, output: 20, cacheRead: 30, cacheCreation: 40 },
    },
  );
  const partial = usage.parseLine(
    line({ id: 'msg_2', model: 'not a model!', usage: { input_tokens: 5 } }),
  );
  assert.deepEqual(partial, {
    id: 'msg_2',
    model: null,
    tokens: { input: 5, output: 0, cacheRead: 0, cacheCreation: 0 },
  });
  assert.equal(usage.parseLine(line({ usage: { input_tokens: 5 } })), null, 'no message id');
  assert.equal(usage.parseLine(JSON.stringify({ type: 'user', message: { id: 'x' } })), null);
});

test("claude-code adapter: the spec review limits are today's tools, deny list and MCP config", async () => {
  const { limits } = await claude();
  const { tools, disallowedTools, mcpConfig } = limits.specReview({
    launchDirectory: '/ws/pathwise',
  });
  assert.deepEqual(tools, ['Read', 'Skill', 'ToolSearch']);
  assert.ok(disallowedTools.includes('mcp__toolkit-mcp__github_merge_pr'));
  assert.equal(mcpConfig, '/ws/pathwise/.mcp.json');
  // The whole deny list, pinned by digest (56 entries when it moved): a change to it is a decision.
  assert.equal(disallowedTools.length, 56);
  assert.equal(
    crypto.createHash('sha256').update(JSON.stringify({ tools, disallowedTools })).digest('hex'),
    '111803f4caf7d33768a9a1953365d6bf8045f38130e159c44a9108a768fe60c7',
  );
});

test('claude-code adapter: its home gate is whether ~/.claude is readable', async (t) => {
  const { homeReadable } = await claude();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.equal(homeReadable(home), false);
  fs.mkdirSync(path.join(home, '.claude'));
  assert.equal(homeReadable(home), true);
});

// ---- the go-to commands come from the active harness (plan item 4) ----

async function goToOf(commands, state) {
  const { deriveEntry } = await import('../backend/claude-ticket-state.mjs');
  return deriveEntry({
    status: statusFile({ investigate: true, done: true }),
    launch: { [INVESTIGATE]: launchRecord({ id: SHORT }) },
    entries: [listed({ id: SHORT, state, ...(state === 'working' && { pid: 4242 }) })],
    now: START_MS,
    planPresent: true,
    ...(commands && { commands }),
  }).goTo.investigate;
}

test('harness commands: Claude Code gives claude attach for a live session and claude --resume from ~/pathwise for a finished one', async () => {
  const resume = {
    kind: 'resume',
    command: `cd ~/pathwise && claude --resume ${sessionUuid(SHORT)}`,
  };
  const attach = { kind: 'attach', command: `claude attach ${SHORT}` };
  assert.deepEqual(await goToOf(undefined, 'working'), attach, 'the default is Claude Code');
  assert.deepEqual(await goToOf(undefined, 'done'), resume);
  const { commands } = await claude();
  assert.deepEqual(await goToOf(commands, 'working'), attach);
  assert.deepEqual(await goToOf(commands, 'done'), resume);
});

test('harness commands: the fake harness gives its own commands, and a null command gives a null goTo', async () => {
  const { harness } = await createFakeHarness();
  assert.deepEqual(await goToOf(harness.commands, 'working'), {
    kind: 'attach',
    command: `fake attach ${SHORT}`,
  });
  assert.deepEqual(await goToOf(harness.commands, 'done'), {
    kind: 'resume',
    command: `cd ~/pathwise && fake resume ${sessionUuid(SHORT)}`,
  });
  const none = { attach: () => null, resume: () => null };
  assert.equal(await goToOf(none, 'working'), null);
  assert.equal(await goToOf(none, 'done'), null);
});

test('harness commands: resumeGoTo adds the ~/pathwise directory change and passes a null command on', async () => {
  const { resumeGoTo } = await import('../backend/claude-ticket-state.mjs');
  const { commands } = await claude();
  assert.deepEqual(resumeGoTo(commands, SESSION_A), {
    kind: 'resume',
    command: `cd ~/pathwise && claude --resume ${SESSION_A}`,
  });
  assert.equal(resumeGoTo({ attach: () => null, resume: () => null }, SESSION_A), null);
});
