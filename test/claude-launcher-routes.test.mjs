// claude-launcher-routes.test.mjs — the three Claude routes on the production HTTP handler: key and
// phase validation, the ticket list, the one shared listing, the mutating-route guard and the
// setup gate. The launcher, the sessions module and the app are real; the CLI is a local double.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  EARLIER_ID,
  IMPLEMENT,
  INVESTIGATE,
  KEY,
  NAME,
  SUMMARY,
  UNTRUSTED_OUTPUT,
  claudeHttpFixture,
  launchRecord,
  listed,
  question,
  requestsSeen,
  seedPlanned,
  sleep,
  statusFile,
  until,
  workingEntry,
} from './claude-launcher-fixture.mjs';

const TICKETS = '/api/claude/tickets';
const LAUNCH = '/api/claude/launch';
const ANSWERS = '/api/claude/answers';
const SECOND_KEY = 'TAP-5678';
const ENTRY_KEYS = [
  'phase',
  'state',
  'reason',
  'flags',
  'questions',
  'unanswered',
  'blocks',
  'goTo',
];
const BAD_KEYS = ['../etc', 'tap-1', 'TAP-1/../x', 'TAP-', ' TAP-1', 'TAP-12345678'];

const launchBody = { key: KEY, phase: INVESTIGATE, summary: SUMMARY };

test('scenario 8: bad keys and phases are refused with INVALID_TICKET before any filesystem access', async (t) => {
  const f = await claudeHttpFixture(t);
  fs.mkdirSync(f.stateDir, { recursive: true, mode: 0o700 });
  f.recorder.clearCalls();

  for (const key of BAD_KEYS) {
    const requests = [
      [LAUNCH, { key, phase: INVESTIGATE, summary: SUMMARY }],
      [ANSWERS, { key, answers: { q1: 'x' } }],
    ];
    for (const [route, body] of requests) {
      const res = await f.http.json('POST', route, body);
      assert.equal(res.status, 400, `${route} ${JSON.stringify(key)}: status`);
      assert.equal(res.json().code, 'INVALID_TICKET', `${route} ${JSON.stringify(key)}: code`);
    }
  }
  const badPhase = await f.http.json('POST', LAUNCH, { key: KEY, phase: 'rm', summary: SUMMARY });
  assert.equal(badPhase.status, 400, 'phase rm: status');
  assert.equal(badPhase.json().code, 'INVALID_TICKET', 'phase rm: code');

  assert.deepEqual(f.recorder.calls, [], 'no file or directory is touched');
  assert.deepEqual(fs.readdirSync(f.stateDir), [], 'the state directory stays empty');
  assert.equal(f.cli.calls.length, 0, 'no listing and no launch');
});

// A finished, planned ticket with the given key and answered or open questions.
function seedTicket(f, key, { status, id }) {
  f.seed(key, { status, launch: { [INVESTIGATE]: launchRecord({ name: `${key}-x`, id }) } });
}

test('scenario 12: the ticket list holds exactly the valid state folders, each with the full entry', async (t) => {
  const f = await claudeHttpFixture(t);
  f.writePlan();
  seedTicket(f, KEY, { status: statusFile({ investigate: true }), id: 'aaaa0001' });
  seedTicket(f, SECOND_KEY, {
    status: statusFile({ investigate: true, questions: [question('q1')] }),
    id: 'aaaa0002',
  });
  fs.mkdirSync(`${f.stateDir}/scratch`, { mode: 0o700 });
  f.cli.setListing([
    listed({ id: 'aaaa0001', name: `${KEY}-x` }),
    listed({ id: 'aaaa0002', name: `${SECOND_KEY}-x` }),
  ]);

  const res = await f.http.bare('GET', TICKETS);
  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.listing, 'ok');
  assert.deepEqual(Object.keys(body.tickets).sort(), [KEY, SECOND_KEY]);
  for (const entry of Object.values(body.tickets)) {
    for (const field of ENTRY_KEYS) assert.ok(field in entry, `an entry carries ${field}`);
  }
  const [first, second] = [body.tickets[KEY], body.tickets[SECOND_KEY]];
  assert.deepEqual([first.phase, first.state, first.reason], [INVESTIGATE, 'done', 'plan_ready']);
  assert.deepEqual(first.flags, { [INVESTIGATE]: true, [IMPLEMENT]: false });
  assert.deepEqual([second.state, second.reason], ['waiting', 'questions']);
  assert.deepEqual(second.questions, [question('q1')]);
  assert.equal(second.unanswered, 1);
  assert.equal(f.cli.listings().length, 1, 'one listing for both tickets');
});

test('scenario 12: an empty or missing state directory answers without a CLI call', async (t) => {
  const f = await claudeHttpFixture(t);
  const missing = await f.http.bare('GET', TICKETS);
  assert.equal(missing.status, 200, 'no state directory yet');
  assert.equal(missing.json().listing, 'ok');
  assert.deepEqual(missing.json().tickets, {});

  fs.mkdirSync(f.stateDir, { recursive: true, mode: 0o700 });
  const empty = await f.http.bare('GET', TICKETS);
  assert.equal(empty.status, 200, 'an empty state directory');
  assert.equal(empty.json().listing, 'ok');
  assert.deepEqual(empty.json().tickets, {});
  assert.equal(f.cli.calls.length, 0, 'the CLI never ran');
});

test('scenario 18: one shared listing serves five tickets and two simultaneous polls', async (t) => {
  const f = await claudeHttpFixture(t);
  f.writePlan();
  const keys = ['TAP-1001', 'TAP-1002', 'TAP-1003', 'TAP-1004', 'TAP-1005'];
  keys.forEach((key, index) =>
    seedTicket(f, key, { status: statusFile({ investigate: true }), id: `aaaa100${index + 1}` }),
  );
  f.cli.setListing(
    keys.map((key, index) => listed({ id: `aaaa100${index + 1}`, name: `${key}-x` })),
  );

  const hold = f.cli.holdListing();
  const landed = requestsSeen(f.http.server, 2);
  const first = f.http.bare('GET', TICKETS);
  const second = f.http.bare('GET', TICKETS);
  await landed;
  await until(() => f.cli.listings().length > 0);
  await sleep(100);
  hold.release();
  const bodies = (await Promise.all([first, second])).map((res) => res.json());

  assert.equal(f.cli.listings().length, 1, 'the CLI listing ran once, not once per ticket');
  for (const body of bodies) assert.deepEqual(Object.keys(body.tickets).sort(), keys);
});

// A valid launch for a fresh ticket and a valid answer for a seeded one, each of which would
// change state if the guard let it through.
function guardedRequests() {
  return [
    [LAUNCH, launchBody],
    [ANSWERS, { key: SECOND_KEY, answers: { q1: 'Portage-backend' } }],
  ].map(([route, body]) => ({ route, body: JSON.stringify(body) }));
}

function seedGuardTicket(f) {
  seedTicket(f, SECOND_KEY, {
    status: statusFile({ investigate: true, questions: [question('q1')] }),
    id: EARLIER_ID,
  });
  f.cli.setListing([listed({ id: EARLIER_ID, name: `${SECOND_KEY}-x` })]);
}

const stateTree = (f) => {
  const names = fs.existsSync(f.stateDir) ? fs.readdirSync(f.stateDir).sort() : null;
  return { names, second: f.files(SECOND_KEY) };
};

test('scenario 19: the Claude POST routes refuse a foreign Origin, cross-site, bad Host and text/plain', async (t) => {
  const f = await claudeHttpFixture(t);
  seedGuardTicket(f);
  const before = stateTree(f);
  const refusals = [
    [{ origin: 'http://evil.example' }, 403],
    [{ 'sec-fetch-site': 'cross-site' }, 403],
    [{ host: `evil.example:${f.http.port}` }, 403],
    [{ 'content-type': 'text/plain' }, 415],
  ];

  for (const { route, body } of guardedRequests()) {
    for (const [headers, status] of refusals) {
      const res = await f.http.raw('POST', route, { body, headers });
      assert.equal(res.status, status, `${route} ${JSON.stringify(headers)}: status`);
    }
  }
  assert.equal(f.cli.launches().length, 0, 'nothing is spawned');
  assert.deepEqual(stateTree(f), before, 'nothing is written');
});

test('scenario 19: the same JSON bodies without Origin or Sec-Fetch-Site reach the handlers', async (t) => {
  const f = await claudeHttpFixture(t);
  seedGuardTicket(f);

  const launch = await f.http.raw('POST', LAUNCH, { body: JSON.stringify(launchBody) });
  assert.equal(launch.status, 200, 'launch');
  assert.equal(launch.json().name, NAME);
  assert.equal(f.cli.launches().length, 1, 'the launch spawned once');

  const answer = await f.http.raw('POST', ANSWERS, {
    body: JSON.stringify({ key: SECOND_KEY, answers: { q1: 'Portage-backend' } }),
  });
  assert.equal(answer.status, 200, 'answers');
  assert.equal(f.parsed(SECOND_KEY).status.questions[0].answer, 'Portage-backend');
});

test('scenario 20: the Claude routes answer while setup is incomplete and my-tickets still needs it', async (t) => {
  const f = await claudeHttpFixture(t, { ready: false });
  fs.mkdirSync(f.stateDir, { recursive: true, mode: 0o700 });

  const claude = await f.http.bare('GET', TICKETS);
  assert.equal(claude.status, 200);
  assert.equal(claude.json().listing, 'ok');

  const gated = await f.http.bare('GET', '/api/my-tickets');
  assert.equal(gated.status, 409);
  assert.equal(gated.json().code, 'SETUP_REQUIRED');
});

test('scenario 37: the refused, failed and invalid-answer codes and statuses reach the HTTP reply', async (t) => {
  const f = await claudeHttpFixture(t);
  seedPlanned(f, { questions: [question('q1')] });

  f.cli.setListing([workingEntry({ id: EARLIER_ID })]);
  const refused = await f.http.json('POST', LAUNCH, launchBody);
  assert.equal(refused.status, 409, 'a working session');
  assert.equal(refused.json().code, 'CLAUDE_REFUSED');
  assert.deepEqual(refused.json().errors, ['session_running']);

  f.cli.setListing([]);
  f.cli.failLaunch({ exitCode: 1, stdout: UNTRUSTED_OUTPUT });
  const failed = await f.http.json('POST', LAUNCH, {
    key: SECOND_KEY,
    phase: INVESTIGATE,
    summary: SUMMARY,
  });
  assert.equal(failed.status, 502, 'a workspace the CLI does not trust');
  assert.equal(failed.json().code, 'CLAUDE_FAILED');
  assert.deepEqual(failed.json().errors, ['untrusted_workspace']);

  f.cli.setListing([listed({ id: EARLIER_ID })]);
  const invalid = await f.http.json('POST', ANSWERS, { key: KEY, answers: { q9: 'unknown' } });
  assert.equal(invalid.status, 400, 'an unknown question');
  assert.equal(invalid.json().code, 'INVALID_ANSWER');
});
