// claude-launcher-continue.test.mjs — Continue: one built-in message to the same finished session of
// a failed workflow ticket, through the shared send path, with no state file written. The launcher
// runs over the fake sessions module (or the real one over the stub CLI for the one-writer mark);
// no `claude` ever starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CONTINUE_TEMPLATE,
  EARLIER_ID,
  FIRST_TEXT,
  INVESTIGATE,
  KEY,
  PROMPT_MAX_CHARS,
  SLUG,
  answeredMap,
  launchRecord,
  launcherEnvironment,
  listed,
  question,
  renderTemplate,
  routingEnvironment,
  sentRecord,
  sessionUuid,
  statusFile,
  workingEntry,
} from './claude-launcher-fixture.mjs';

const body = { key: KEY };
const refused = (reason) => ({ code: 'CLAUDE_REFUSED', status: 409, errors: [reason] });
const failed = (reason) => ({ code: 'CLAUDE_FAILED', status: 502, errors: [reason] });
const QUESTIONS = [question('q1', FIRST_TEXT)];
const PLAN_TEXT = 'PLAN-MARKER-4471';
const SUMMARY = 'HOSTILE-SUMMARY-9930';

// A planning session that ended without its flag, listed and finished, with an answered question.
function seedFailed(env, { status, listing = [listed({ id: EARLIER_ID })] } = {}) {
  env.seed(KEY, {
    status: status ?? statusFile({ questions: QUESTIONS }),
    launch: {
      [INVESTIGATE]: launchRecord({
        answered: answeredMap(QUESTIONS),
        sent: sentRecord(QUESTIONS),
      }),
    },
  });
  (env.fake ?? env.cli).setListing(listing);
}

async function assertRejects(operation, expected, label) {
  await assert.rejects(operation, (error) => {
    for (const [field, value] of Object.entries(expected))
      assert.deepEqual(error[field], value, `${label}: ${field}`);
    return true;
  });
}

test('continue: sends one message to the finished session and writes nothing', async (t) => {
  const env = await routingEnvironment(t);
  seedFailed(env);
  assert.equal((await env.launcher.list()).tickets[KEY].blocks.continue, null);
  const before = env.files();

  const result = await env.launcher.continueSession(body);

  assert.deepEqual(result.send, { status: 'sent' });
  assert.deepEqual(Object.keys(result).sort(), ['key', 'ok', 'send', 'ticket']);
  assert.equal(result.key, KEY);
  assert.equal(env.fake.resumes().length, 1);
  assert.equal(env.fake.resumes()[0].sessionId, sessionUuid(EARLIER_ID));
  assert.equal(
    env.fake.resumes()[0].notice,
    renderTemplate(CONTINUE_TEMPLATE, { statusPath: env.statusPath() }),
  );
  assert.deepEqual(env.files(), before, 'status.json and launch.json are byte-identical');
  assert.equal(result.ticket.state, 'working', 'the effect shows as working on the next listing');
});

test('continue: refused', async (t) => {
  const cases = [
    [
      'working',
      (env) => seedFailed(env, { listing: [workingEntry({ id: EARLIER_ID })] }),
      'session_running',
    ],
    [
      'done',
      (env) => {
        seedFailed(env, { status: statusFile({ investigate: true, done: true }) });
        env.writePlan();
      },
      'not_failed',
    ],
    ['no record', (env) => env.fake.setListing([]), 'not_failed'],
    ['no listing', (env) => (seedFailed(env), env.fake.failFreshListing(1)), 'listing_unavailable'],
    ['not listed', (env) => seedFailed(env, { listing: [] }), 'session_not_found'],
  ];
  for (const [label, arrange, reason] of cases) {
    const env = await routingEnvironment(t);
    arrange(env);
    const before = env.files();

    await assertRejects(
      () => env.launcher.continueSession(body),
      label === 'no listing' ? failed(reason) : refused(reason),
      label,
    );

    assert.equal(env.fake.resumes().length, 0, `${label}: nothing resumed`);
    assert.equal(env.fake.stops().length, 0, `${label}: nothing stopped`);
    assert.deepEqual(env.files(), before, `${label}: nothing written`);
  }
  const env = await routingEnvironment(t);
  for (const bad of ['nope', '', null, undefined, 'tap-1', 'TAP-1/../x'])
    await assertRejects(
      () => env.launcher.continueSession({ key: bad }),
      { code: 'INVALID_TICKET', status: 400 },
      String(bad),
    );
});

test('continue: resume failure', async (t) => {
  const env = await routingEnvironment(t);
  seedFailed(env);
  const before = env.files();
  env.fake.forceResume({ status: 'failed-permanent', reason: 'resume_forked' });

  const result = await env.launcher.continueSession(body);

  assert.deepEqual(result.send, { status: 'failed', reason: 'resume_failed' });
  assert.deepEqual(env.files(), before, 'both state files are unchanged');
  env.fake.forceResume(null);
  const again = await env.launcher.continueSession(body);
  assert.deepEqual(again.send, { status: 'sent' }, 'a second Continue is allowed');
  assert.equal(env.fake.resumes().length, 2);
});

test('continue: prompt file', async (t) => {
  const env = await routingEnvironment(t);
  seedFailed(env);
  env.writePrompt('continue', '\n  CUSTOM {KEY} {SLUG} {STATUS_FILE} {NOPE} $&\n');

  const result = await env.launcher.continueSession(body);

  assert.deepEqual(result.send, { status: 'sent' });
  assert.equal(
    env.fake.resumes()[0].notice,
    `CUSTOM ${KEY} ${SLUG} ${env.statusPath()} {NOPE} $&`,
    'trimmed, the three placeholders filled, anything else as written',
  );

  for (const [label, text] of [
    ['empty', ''],
    ['too long', 'x'.repeat(PROMPT_MAX_CHARS + 1)],
    ['NUL', 'a\0b'],
  ]) {
    const bad = await routingEnvironment(t);
    seedFailed(bad);
    bad.writePrompt('continue', text);
    const before = bad.files();
    const reply = await bad.launcher.continueSession(body);
    assert.deepEqual(reply.send, { status: 'failed', reason: 'prompt_unreadable' }, label);
    assert.equal(bad.fake.resumes().length, 0, `${label}: nothing sent`);
    assert.equal(bad.fake.stops().length, 0, `${label}: nothing stopped`);
    assert.deepEqual(bad.files(), before, `${label}: nothing written`);
  }
});

test('continue: validated values only', async (t) => {
  const env = await routingEnvironment(t);
  seedFailed(env, {
    status: { ...statusFile({ questions: [question('q1', FIRST_TEXT)] }), summary: SUMMARY },
  });
  env.writePlan();
  fs.writeFileSync(`${env.pathwise}/.orchestrator/${SLUG}/02-plan.md`, PLAN_TEXT);

  await env.launcher.continueSession(body);

  const { notice } = env.fake.resumes()[0];
  for (const wanted of [KEY, SLUG, env.statusPath()])
    assert.ok(notice.includes(wanted), `has ${wanted}`);
  for (const unwanted of [FIRST_TEXT, PLAN_TEXT, SUMMARY, 'Which repo'])
    assert.ok(!notice.includes(unwanted), `has no ${unwanted}`);
  assert.doesNotMatch(notice, /\{(KEY|SLUG|STATUS_FILE)\}/);
});

test('continue: held session', async (t) => {
  const env = await launcherEnvironment(t);
  seedFailed(env);
  const release = env.sessions.beginTurn(sessionUuid(EARLIER_ID));
  t.after(() => release());
  const before = env.files();

  const entry = (await env.launcher.list()).tickets[KEY];
  assert.equal(entry.state, 'working', 'a chat turn holds the session');
  assert.equal('continue' in entry.blocks, false);
  await assertRejects(() => env.launcher.continueSession(body), refused('session_running'), 'held');

  assert.equal(env.cli.resumes().length, 0);
  assert.deepEqual(env.files(), before);
});

test('continue: no state write', () => {
  const source = fs.readFileSync(
    fileURLToPath(new URL('../backend/claude-launcher.mjs', import.meta.url)),
    'utf8',
  );
  const start = source.indexOf('async function continueLocked');
  assert.ok(start > 0, 'continueLocked exists');
  const end = source.indexOf('\n  }\n', start);
  const body = source.slice(start, end);
  assert.doesNotMatch(body, /writeJson|restore\(|writeFileAtomic|writeFileSync/);
  assert.match(body, /deliverToSession\(/, 'it reaches the session only through the shared path');
  assert.doesNotMatch(body, /claudeSessions\.(resume|stop|launch)\(/);
});
