// claude-launcher-harness.test.mjs — WP2 of multi-harness: what the launcher does with the harness
// it runs on. A spec review is refused on a harness without tool limits, a new phase record is
// stamped only for a non-default harness, a record written before harnesses (or stamped
// `claude-code`) reads as Claude Code, and an action that resumes another harness's session is
// refused before any write or session call. No `claude` and no other process ever starts: Claude
// Code runs over the fixture's fake sessions or stub CLI, the second harness is the test-only fake
// adapter (`harness-fake.mjs`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { FAKE_ID, FAKE_START_ID, createFakeHarness } from './harness-fake.mjs';
import {
  EARLIER_ID,
  FIRST_TEXT,
  INVESTIGATE,
  INVESTIGATE_NAME,
  KEY,
  REVIEW,
  SECOND_TEXT,
  answeredMap,
  launcherEnvironment,
  launchRecord,
  listed,
  question,
  reviewEntry,
  reviewRecord,
  routingEnvironment,
  sentRecord,
  statusFile,
} from './claude-launcher-fixture.mjs';

const SPEC_REVIEW = 'spec-review';
const SPEC_PR = 321;
const refused = (reason) => ({ code: 'CLAUDE_REFUSED', status: 409, errors: [reason] });

async function assertRejects(operation, expected, label) {
  await assert.rejects(operation, (error) => {
    for (const [field, value] of Object.entries(expected))
      assert.deepEqual(error[field], value, `${label}: ${field}`);
    return true;
  });
}

// The real launcher over the fake adapter's own sessions service, with the fixture's temp state,
// clock, timers and prompts. `env.fake` is the fake harness helper (`calls`, `starts`, `setEntries`).
async function fakeHarnessEnvironment(t, { without } = {}) {
  const fake = await createFakeHarness({ without });
  const sessions = fake.harness.createSessions({});
  const env = await launcherEnvironment(t, { claudeSessions: sessions });
  const { createClaudeLauncher } = await import('../backend/claude-launcher.mjs');
  const launcher = createClaudeLauncher({
    claudeSessions: sessions,
    harness: fake.harness,
    stateDir: env.stateDir,
    home: env.home,
    fs: env.recorder.fs,
    now: env.clock.now,
    timers: env.timers,
    promptsDir: env.promptsDir,
    browsers: env.browsers,
  });
  return Object.assign(env, { launcher, fake });
}

// ---- 5. a spec review needs the harness's tool limits ----

test('spec review unsupported: a harness without limits refuses it and writes and starts nothing', async (t) => {
  const env = await fakeHarnessEnvironment(t, { without: ['limits'] });
  env.seed(KEY, { launch: { [INVESTIGATE]: { ...launchRecord(), harness: FAKE_ID } } });
  env.fake.setEntries([]);
  const before = env.files();

  await assertRejects(
    () => env.launcher.launch({ key: KEY, phase: SPEC_REVIEW, pr: SPEC_PR }),
    refused('harness_unsupported'),
    'spec review',
  );

  assert.deepEqual(env.files(), before, 'launch.json and status.json are byte-identical');
  assert.equal(env.fake.sessionCalls('launch').length, 0, 'no launch call');
  assert.equal(env.fake.starts.length, 0, 'no process');
});

// ---- 7. a new phase record names its harness only when it is not Claude Code ----

test('stamp: an investigate launch on the fake harness records harness fake', async (t) => {
  const env = await fakeHarnessEnvironment(t);
  env.fake.setEntries([
    listed({
      id: FAKE_START_ID,
      name: INVESTIGATE_NAME,
      state: 'working',
      status: 'busy',
      pid: 4242,
      startedAt: env.clock.now(),
    }),
  ]);

  const result = await env.launcher.launch({ key: KEY, phase: INVESTIGATE });

  assert.equal(result.ok, true);
  const record = env.parsed().launch[INVESTIGATE];
  assert.equal(record.harness, FAKE_ID);
  assert.equal(record.name, INVESTIGATE_NAME);
  assert.equal(record.id, FAKE_START_ID);
  assert.equal(typeof record.launchedAt, 'number');
});

test('stamp: an investigate launch on Claude Code writes exactly name, launchedAt and id', async (t) => {
  const env = await launcherEnvironment(t);

  const result = await env.launcher.launch({ key: KEY, phase: INVESTIGATE });

  assert.equal(result.ok, true);
  const record = env.parsed().launch[INVESTIGATE];
  assert.deepEqual(Object.keys(record).sort(), ['id', 'launchedAt', 'name']);
  assert.equal(Object.hasOwn(record, 'harness'), false, 'no harness key for the default harness');
});

// ---- 8. a record written before harnesses reads as Claude Code ----

const ANSWER_QUESTION = question('q1');
const ANSWER_BODY = { key: KEY, answers: { q1: FIRST_TEXT } };

// A planning session that asked one question, finished and listed. `harness` is the stamp of its
// phase record (absent: written before harnesses).
function seedAnswerable(env, harness) {
  env.seed(KEY, {
    status: statusFile({ investigate: true, questions: [ANSWER_QUESTION] }),
    launch: { [INVESTIGATE]: { ...launchRecord(), ...(harness && { harness }) } },
  });
  env.writePlan();
  env.fake.setListing([listed({ id: EARLIER_ID })]);
}

async function answerScenario(t, harness) {
  const env = await routingEnvironment(t);
  seedAnswerable(env, harness);
  const entry = (await env.launcher.list()).tickets[KEY];
  const result = await env.launcher.answer(ANSWER_BODY);
  // The temp state folder differs per environment, so its path is left out of the notice.
  const resumes = env.fake.resumes().map((call) => ({
    ...call,
    notice: call.notice.replaceAll(env.statusPath(), '<status.json>'),
  }));
  return { entry, send: result.send, resumes };
}

test('legacy record: no harness key and harness claude-code both list and resume as Claude Code', async (t) => {
  const baseline = await answerScenario(t);
  assert.deepEqual(baseline.send, { status: 'sent' });
  assert.equal(baseline.resumes.length, 1);

  const stamped = await answerScenario(t, 'claude-code');
  assert.deepEqual(stamped.entry, baseline.entry, 'same ticket entry');
  assert.deepEqual(stamped.send, baseline.send, 'same send result');
  assert.deepEqual(stamped.resumes, baseline.resumes, 'same resume call');
});

test('go-to of a foreign record: it is still listed, but gets no go-to command from the active harness', async (t) => {
  const goToOf = async (harness) => {
    const env = await routingEnvironment(t);
    seedAnswerable(env, harness);
    return (await env.launcher.list()).tickets[KEY].goTo.investigate;
  };
  assert.notEqual(await goToOf(undefined), null, 'a Claude Code record has a go-to');
  assert.equal(await goToOf(FAKE_ID), null, 'another harness record has none');
});

// ---- 9. an action on another harness's record is refused before anything happens ----

const ANSWERED = [question('q1', FIRST_TEXT)];
const TWO_ANSWERED = [question('q1', FIRST_TEXT), question('q2', SECOND_TEXT)];

// The ticket files and listing of one action, with the phase record stamped for the fake harness.
const OTHER = { harness: FAKE_ID };
const ACTIONS = [
  {
    label: 'answers',
    arrange(env) {
      seedAnswerable(env, FAKE_ID);
    },
    call: (env) => env.launcher.answer(ANSWER_BODY),
  },
  {
    label: 'approve',
    arrange(env) {
      env.seed(KEY, {
        status: statusFile({ investigate: true, done: true, questions: TWO_ANSWERED }),
        launch: {
          [INVESTIGATE]: {
            ...launchRecord({
              answered: answeredMap(TWO_ANSWERED),
              sent: sentRecord(TWO_ANSWERED),
            }),
            ...OTHER,
          },
        },
      });
      env.writePlan();
      env.fake.setListing([listed({ id: EARLIER_ID })]);
    },
    call: (env) => env.launcher.approve({ key: KEY }),
  },
  {
    label: 'continue',
    arrange(env) {
      env.seed(KEY, {
        status: statusFile({ questions: ANSWERED }),
        launch: {
          [INVESTIGATE]: {
            ...launchRecord({ answered: answeredMap(ANSWERED), sent: sentRecord(ANSWERED) }),
            ...OTHER,
          },
        },
      });
      env.fake.setListing([listed({ id: EARLIER_ID })]);
    },
    call: (env) => env.launcher.continueSession({ key: KEY }),
  },
  {
    label: 're-review',
    arrange(env) {
      env.seed(KEY, { launch: { [REVIEW]: { ...reviewRecord(), ...OTHER } } });
      env.fake.setListing([reviewEntry({ state: 'done', status: 'idle', pid: 4243 })]);
    },
    call: (env) => env.launcher.rereview({ key: KEY }),
  },
];

test('other harness record: answers, approve, continue and re-review are refused and change nothing', async (t) => {
  for (const { label, arrange, call } of ACTIONS) {
    const env = await routingEnvironment(t);
    arrange(env);
    const before = env.files();

    await assertRejects(() => call(env), refused('harness_unsupported'), label);

    assert.deepEqual(env.files(), before, `${label}: files are byte-identical`);
    assert.equal(env.fake.stops().length, 0, `${label}: no stop`);
    assert.equal(env.fake.resumes().length, 0, `${label}: no resume`);
  }
});

// ---- 10. the prompts are one set: the harness's own words are filled from its adapter ----

test('prompt words: a launch on the fake harness sends the shared prompt with the fake adapter words', async (t) => {
  const env = await fakeHarnessEnvironment(t);
  env.fake.setEntries([
    listed({
      id: FAKE_START_ID,
      name: INVESTIGATE_NAME,
      state: 'working',
      status: 'busy',
      pid: 4242,
      startedAt: env.clock.now(),
    }),
  ]);

  await env.launcher.launch({ key: KEY, phase: INVESTIGATE });

  const { prompt } = env.fake.sessionCalls('launch')[0].args;
  assert.match(prompt, /use the `orchestrator` playbook and run only its step 1/);
  assert.match(prompt, /anything in chat or with an ask-prompt hook: the session/);
  assert.doesNotMatch(prompt, /\{(SKILL|ASK_TOOL)\}|question tool/);
});
