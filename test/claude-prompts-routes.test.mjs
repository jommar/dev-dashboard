// claude-prompts-routes.test.mjs — the prompt routes on the production HTTP handler: list, save and
// reset the prompt files from the app. The prompt store, the launcher and the app are real,
// over a temp prompts folder and the CLI double; an edit made through a route is what the next
// launch and the next send read.
//
// Nothing here reads or writes the dashboard's own `prompts` folder: the fixture injects a store
// over a temp one, and the one test of the default wiring runs a copy of the dashboard.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ANSWERS_IMPLEMENT_TEMPLATE,
  ANSWERS_TEMPLATE,
  APPROVE_TEMPLATE,
  EARLIER_ID,
  GROOM,
  GROOM_TEMPLATE,
  REREVIEW_TEMPLATE,
  REVIEW_TEMPLATE,
  SPEC_REVIEW_TEMPLATE,
  E2E_TEMPLATE,
  IMPLEMENT,
  IMPLEMENT_TEMPLATE,
  INVESTIGATE,
  INVESTIGATE_TEMPLATE,
  KEY,
  PROMPT_MAX_CHARS,
  PROMPT_NAMES,
  SLUG,
  answeredMap,
  claudeHttpFixture,
  dashboardSandbox,
  fsChanges,
  groomPrompt,
  launchRecord,
  listed,
  promptEntry,
  question,
  renderTemplate,
  seedPlanned,
  statusFile,
  until,
} from './claude-launcher-fixture.mjs';

const PROMPTS = '/api/claude/prompts';
const LAUNCH = '/api/claude/launch';
const ANSWERS = '/api/claude/answers';
const route = (name) => `${PROMPTS}/${name}`;

const list = (f) => f.http.bare('GET', PROMPTS);
const put = (f, name, text) => f.http.json('PUT', route(name), { text });
const reset = (f, name) => f.http.bare('DELETE', route(name));
const launch = (f, phase = INVESTIGATE) => f.http.json('POST', LAUNCH, { key: KEY, phase });
const save = (f, answers) => f.http.json('POST', ANSWERS, { key: KEY, answers });

const changes = (f) => fsChanges(f.recorder);

// Every file and folder under `dir` with its bytes (a link is its target path).
function tree(dir) {
  const found = {};
  const walk = (current) => {
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name);
      const stat = fs.lstatSync(file);
      const key = path.relative(dir, file);
      if (stat.isDirectory()) {
        found[key] = 'folder';
        walk(file);
      } else if (stat.isSymbolicLink()) found[key] = `link to ${fs.readlinkSync(file)}`;
      else found[key] = fs.readFileSync(file, 'utf8');
    }
  };
  walk(dir);
  return found;
}

const assertInvalid = (res, label) => {
  assert.equal(res.status, 400, `${label}: status`);
  assert.equal(res.json().code, 'INVALID_PROMPT', `${label}: code`);
  assert.ok(Array.isArray(res.json().errors), `${label}: errors is a list`);
};
const assertFailed = (res, label) => {
  assert.equal(res.status, 502, `${label}: status`);
  assert.equal(res.json().code, 'CLAUDE_FAILED', `${label}: code`);
  assert.deepEqual(res.json().errors, ['prompt_not_changed'], `${label}: reason`);
};

// ---- GET /api/claude/prompts ----

test('scenario 170: GET lists the ten prompts in order, each the built-in text when there is no file', async (t) => {
  const f = await claudeHttpFixture(t);

  const res = await list(f);

  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.deepEqual(res.json(), {
    ok: true,
    prompts: PROMPT_NAMES.map((name) => promptEntry(name, 'default')),
  });
  assert.equal(fs.existsSync(f.promptsDir), false, 'listing makes no folder');
  assert.deepEqual(changes(f), [], 'and changes nothing');
});

test('scenario 171: GET shows a usable file as custom with its trimmed text, the others as default', async (t) => {
  const f = await claudeHttpFixture(t);
  f.writePrompt('investigate', '\n  Work on {KEY} now.  \n\n');
  f.writePrompt('answers', 'Read {STATUS_FILE}: {CHANGE} {QUESTION_IDS}\n');

  const res = await list(f);

  assert.deepEqual(res.json().prompts, [
    promptEntry('investigate', 'custom', 'Work on {KEY} now.'),
    promptEntry('implement', 'default'),
    promptEntry('answers', 'custom', 'Read {STATUS_FILE}: {CHANGE} {QUESTION_IDS}'),
    promptEntry('answers-implement', 'default'),
    promptEntry('approve', 'default'),
    promptEntry('rereview', 'default'),
    promptEntry('groom', 'default'),
    promptEntry('review', 'default'),
    promptEntry('spec-review', 'default'),
    promptEntry('e2e', 'default'),
  ]);
});

test('scenario 171: GET shows a file that cannot be used as unusable, with the built-in text so that a fix can be saved', async (t) => {
  const f = await claudeHttpFixture(t);
  f.writePrompt('implement', '');

  const res = await list(f);

  assert.equal(res.status, 200, 'an unusable file is shown, not an error');
  assert.deepEqual(res.json().prompts, [
    promptEntry('investigate', 'default'),
    promptEntry('implement', 'unusable'),
    promptEntry('answers', 'default'),
    promptEntry('answers-implement', 'default'),
    promptEntry('approve', 'default'),
    promptEntry('rereview', 'default'),
    promptEntry('groom', 'default'),
    promptEntry('review', 'default'),
    promptEntry('spec-review', 'default'),
    promptEntry('e2e', 'default'),
  ]);
});

test('scenario 172: GET reads the files on every request', async (t) => {
  const f = await claudeHttpFixture(t);
  const implement = async () => (await list(f)).json().prompts[1];

  f.writePrompt('implement', 'first');
  assert.deepEqual(await implement(), promptEntry('implement', 'custom', 'first'));
  f.writePrompt('implement', 'second');
  assert.deepEqual(await implement(), promptEntry('implement', 'custom', 'second'));
  fs.rmSync(f.promptPath('implement'));
  assert.deepEqual(await implement(), promptEntry('implement', 'default'));
});

// ---- PUT /api/claude/prompts/<name> ----

test('scenario 173: PUT saves the trimmed text with one newline and answers with the custom entry', async (t) => {
  const f = await claudeHttpFixture(t);
  const text = '\n  Custom {KEY} for {STATUS_FILE}  \n';

  for (const name of PROMPT_NAMES) {
    const res = await put(f, name, text);

    assert.equal(res.status, 200, name);
    assert.deepEqual(res.json(), {
      ok: true,
      prompt: promptEntry(name, 'custom', 'Custom {KEY} for {STATUS_FILE}'),
    });
    assert.equal(
      fs.readFileSync(f.promptPath(name), 'utf8'),
      'Custom {KEY} for {STATUS_FILE}\n',
      `${name}: the file`,
    );
  }
  assert.deepEqual(fs.readdirSync(f.promptsDir).sort(), [
    'answers-implement.md',
    'answers.md',
    'approve.md',
    'e2e.md',
    'groom.md',
    'implement.md',
    'investigate.md',
    'rereview.md',
    'review.md',
    'spec-review.md',
  ]);
  assert.deepEqual(
    (await list(f)).json().prompts.map(({ source }) => source),
    PROMPT_NAMES.map(() => 'custom'),
  );
});

test('scenario 175: PUT with a text that is empty after trim is INVALID_PROMPT and writes nothing', async (t) => {
  const f = await claudeHttpFixture(t);
  f.recorder.clearCalls();

  assertInvalid(await put(f, 'investigate', '  \n\t  '), 'empty after trim');

  assert.deepEqual(changes(f), [], 'nothing is written');
  assert.equal(fs.existsSync(f.promptsDir), false, 'not even the folder');
});

test('scenario 176: PUT accepts a text of exactly 20 000 characters, so the body limit admits it', async (t) => {
  const f = await claudeHttpFixture(t);
  // Three bytes a character in UTF-8, the most a character without an escape takes.
  const wide = '€'.repeat(PROMPT_MAX_CHARS);
  assert.ok(Buffer.byteLength(JSON.stringify({ text: wide })) > 60_000, 'a body of about 60 KB');
  const plain = 'x'.repeat(PROMPT_MAX_CHARS);

  const first = await put(f, 'investigate', wide);
  const second = await put(f, 'implement', `\n   ${plain}   \n\n`);
  const third = await put(f, 'answers', `${plain}x`);

  assert.equal(first.status, 200);
  assert.equal(first.json().prompt.text, wide);
  assert.equal(fs.readFileSync(f.promptPath('investigate'), 'utf8'), `${wide}\n`);
  assert.equal(second.status, 200, 'padding around it does not count');
  assert.equal(second.json().prompt.text, plain);
  assertInvalid(third, 'one character more');
  assert.equal(fs.existsSync(f.promptPath('answers')), false);
});

test('scenario 177: PUT never refuses a text for lacking {STATUS_FILE}, or for holding a placeholder it does not know', async (t) => {
  const f = await claudeHttpFixture(t);

  const lacking = await put(f, 'investigate', 'Just do the work, no placeholders.');
  const unknown = await put(f, 'implement', 'Use {WORD} and {key} and {STATUS_FILE}.');

  assert.equal(lacking.status, 200);
  assert.deepEqual(
    lacking.json().prompt,
    promptEntry('investigate', 'custom', 'Just do the work, no placeholders.'),
  );
  assert.equal(unknown.status, 200);
  assert.equal(
    fs.readFileSync(f.promptPath('implement'), 'utf8'),
    'Use {WORD} and {key} and {STATUS_FILE}.\n',
  );
});

test('scenario 178: PUT with a body that is not a JSON object is the usual INVALID_JSON and writes nothing', async (t) => {
  const f = await claudeHttpFixture(t);
  f.recorder.clearCalls();

  for (const body of ['{', '[]', '"text"', '']) {
    const res = await f.http.json('PUT', route('investigate'), body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.json().code, 'INVALID_JSON', JSON.stringify(body));
  }

  assert.deepEqual(changes(f), []);
  assert.equal(fs.existsSync(f.promptsDir), false);
});

test('scenario 179: PUT that cannot write is CLAUDE_FAILED and the old file stays whole', async (t) => {
  const f = await claudeHttpFixture(t);
  f.writePrompt('investigate', 'old\n');
  f.recorder.failOn(
    'renameSync',
    () => true,
    Object.assign(new Error('disk full'), { code: 'ENOSPC' }),
  );

  assertFailed(await put(f, 'investigate', 'new'), 'the file cannot be put in place');

  assert.equal(fs.readFileSync(f.promptPath('investigate'), 'utf8'), 'old\n');
  assert.deepEqual(fs.readdirSync(f.promptsDir), ['investigate.md'], 'no temp file is left');
  const retry = await put(f, 'investigate', 'new');
  assert.equal(retry.status, 200, 'and the next save works');
});

// ---- DELETE /api/claude/prompts/<name> ----

test('scenario 180: DELETE removes the file and answers with the built-in entry, and again when it is already gone', async (t) => {
  const f = await claudeHttpFixture(t);
  f.writePrompt('investigate', 'one');
  f.writePrompt('implement', 'two');

  const res = await reset(f, 'investigate');
  const again = await reset(f, 'investigate');

  assert.equal(res.status, 200);
  assert.deepEqual(res.json(), { ok: true, prompt: promptEntry('investigate', 'default') });
  assert.equal(again.status, 200, 'a file that is not there is fine');
  assert.deepEqual(again.json().prompt, promptEntry('investigate', 'default'));
  assert.deepEqual(fs.readdirSync(f.promptsDir), ['implement.md'], 'the other file stays');
  assert.deepEqual(
    (await list(f)).json().prompts.map(({ source }) => source),
    [
      'default',
      'custom',
      'default',
      'default',
      'default',
      'default',
      'default',
      'default',
      'default',
      'default',
    ],
  );
  // Every registered prompt, including the three initial side-action prompts, supports reset.
  for (const name of PROMPT_NAMES) {
    assert.equal((await put(f, name, `custom ${name}`)).status, 200, `save ${name}`);
    const removed = await reset(f, name);
    assert.equal(removed.status, 200, `reset ${name}`);
    assert.deepEqual(removed.json().prompt, promptEntry(name, 'default'));
    assert.equal(fs.existsSync(f.promptPath(name)), false, `${name}: the custom file is gone`);
  }
});

test('scenario 182: DELETE of a folder where the file should be is CLAUDE_FAILED and what is in it stays', async (t) => {
  const f = await claudeHttpFixture(t);
  fs.mkdirSync(f.promptPath('implement'), { recursive: true });
  fs.writeFileSync(path.join(f.promptPath('implement'), 'keep.txt'), 'kept');

  assertFailed(await reset(f, 'implement'), 'a folder');

  assert.equal(fs.readFileSync(path.join(f.promptPath('implement'), 'keep.txt'), 'utf8'), 'kept');
});

// ---- names ----

const UNKNOWN_PATHS = [
  `${PROMPTS}/..%2Finvestigate`,
  `${PROMPTS}/%2e%2e%2finvestigate`,
  `${PROMPTS}/..%2F..%2Fclaude%2Fstatus`,
  `${PROMPTS}/../investigate`,
  `${PROMPTS}/investigate%2F..%2Fanswers`,
  `${PROMPTS}/investigate.md`,
  `${PROMPTS}/Investigate`,
  `${PROMPTS}/ANSWERS`,
  `${PROMPTS}/investigate/`,
  `${PROMPTS}/investigate/answers`,
  `${PROMPTS}/investigat`,
  `${PROMPTS}/investigate%00`,
  `${PROMPTS}/constructor`,
  `${PROMPTS}/__proto__`,
  `${PROMPTS}/toString`,
  `${PROMPTS}/hasOwnProperty`,
  `${PROMPTS}/`,
  PROMPTS,
];

test('scenario 183: any name but the ten is the normal 404 for PUT and DELETE, and nothing is touched outside the prompts folder', async (t) => {
  const f = await claudeHttpFixture(t);
  // Where `../investigate` and `../answers` would land if a name became part of a path.
  fs.writeFileSync(path.join(f.root, 'investigate.md'), 'outside');
  fs.writeFileSync(path.join(f.root, 'answers.md'), 'outside too');
  fs.mkdirSync(f.stateDir, { recursive: true });
  fs.writeFileSync(path.join(f.stateDir, 'status'), 'state');
  const before = tree(f.root);
  f.recorder.clearCalls();

  for (const requestPath of UNKNOWN_PATHS) {
    const saved = await f.http.exact('PUT', requestPath, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'new text' }),
    });
    assert.equal(saved.status, 404, `PUT ${requestPath}`);
    assert.deepEqual(saved.json(), { error: 'not found' }, `PUT ${requestPath}`);
    const removed = await f.http.exact('DELETE', requestPath);
    assert.equal(removed.status, 404, `DELETE ${requestPath}`);
    assert.deepEqual(removed.json(), { error: 'not found' }, `DELETE ${requestPath}`);
  }

  assert.deepEqual(tree(f.root), before, 'no file or folder anywhere changed');
  assert.deepEqual(changes(f), [], 'no file was written, made or removed');
  assert.equal(fs.existsSync(f.promptsDir), false, 'the prompts folder was not even made');
  const touched = f.recorder.calls
    .flatMap(({ args }) => args.filter((arg) => typeof arg === 'string' && path.isAbsolute(arg)))
    .filter((arg) => arg !== f.promptsDir && !arg.startsWith(f.promptsDir + path.sep));
  assert.deepEqual(touched, [], 'and nothing outside the prompts folder was looked at either');
});

test('scenario 183: other verbs on the prompt routes are the normal 404', async (t) => {
  const f = await claudeHttpFixture(t);
  f.recorder.clearCalls();

  const post = await f.http.json('POST', route('investigate'), { text: 'text' });
  const postList = await f.http.json('POST', PROMPTS, { text: 'text' });

  assert.equal(post.status, 404);
  assert.equal(postList.status, 404);
  assert.deepEqual(changes(f), []);
});

// ---- the same guard as the other Claude POSTs ----

const REFUSALS = (port) => [
  [{ origin: 'http://evil.example' }, 403],
  [{ 'sec-fetch-site': 'cross-site' }, 403],
  [{ 'sec-fetch-site': 'same-site' }, 403],
  [{ host: `evil.example:${port}` }, 403],
  [{ 'content-type': 'text/plain' }, 415],
];

test('scenario 184: PUT refuses a foreign Origin, cross-site, same-site, a bad Host and text/plain before anything is written', async (t) => {
  const f = await claudeHttpFixture(t);
  f.writePrompt('investigate', 'mine\n');
  const before = tree(f.root);
  f.recorder.clearCalls();

  for (const [headers, status] of REFUSALS(f.http.port)) {
    const res = await f.http.raw('PUT', route('investigate'), {
      body: JSON.stringify({ text: 'theirs' }),
      headers: { 'content-type': 'application/json', ...headers },
    });
    assert.equal(res.status, status, `PUT ${JSON.stringify(headers)}`);
  }
  const other = await f.http.raw('PUT', route('answers'), {
    body: JSON.stringify({ text: 'theirs' }),
    headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
  });
  assert.equal(other.status, 403, 'a file that is not there yet');

  assert.deepEqual(changes(f), [], 'nothing is written');
  assert.deepEqual(tree(f.root), before);
});

test('scenario 184: DELETE refuses a foreign Origin, cross-site, same-site, a bad Host and text/plain before anything is removed', async (t) => {
  const f = await claudeHttpFixture(t);
  f.writePrompt('investigate', 'mine\n');
  const before = tree(f.root);
  f.recorder.clearCalls();

  for (const [headers, status] of REFUSALS(f.http.port)) {
    const res = await f.http.raw('DELETE', route('investigate'), { headers });
    assert.equal(res.status, status, `DELETE ${JSON.stringify(headers)}`);
  }

  assert.deepEqual(changes(f), [], 'nothing is removed');
  assert.deepEqual(tree(f.root), before);
});

test('scenario 184: the same PUT and DELETE from this page, or from a client that sends no Origin, go through', async (t) => {
  const f = await claudeHttpFixture(t);
  const sameOrigin = {
    origin: f.http.base,
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
  };

  const saved = await f.http.raw('PUT', route('investigate'), {
    body: JSON.stringify({ text: 'from the page' }),
    headers: sameOrigin,
  });
  assert.equal(saved.status, 200, 'PUT from this page');
  assert.equal(fs.readFileSync(f.promptPath('investigate'), 'utf8'), 'from the page\n');

  const removed = await f.http.raw('DELETE', route('investigate'), { headers: sameOrigin });
  assert.equal(removed.status, 200, 'DELETE from this page');
  assert.equal(fs.existsSync(f.promptPath('investigate')), false);

  const bare = await f.http.raw('PUT', route('answers'), {
    body: JSON.stringify({ text: 'from curl' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(bare.status, 200, 'PUT with no Origin and no Sec-Fetch-Site');
  assert.equal(fs.readFileSync(f.promptPath('answers'), 'utf8'), 'from curl\n');
  assert.equal((await f.http.bare('DELETE', route('answers'))).status, 200, 'bare DELETE');
});

// ---- before setup is complete ----

test('scenario 185: the prompt routes answer while setup is incomplete, like the other Claude routes', async (t) => {
  const f = await claudeHttpFixture(t, { ready: false });

  const listed = await list(f);
  const saved = await put(f, 'implement', 'text');
  const removed = await reset(f, 'implement');

  assert.equal(listed.status, 200);
  assert.equal(listed.json().prompts.length, 10);
  assert.equal(saved.status, 200);
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.json().prompt, promptEntry('implement', 'default'));
  assert.equal(
    (await f.http.bare('GET', '/api/my-tickets')).status,
    409,
    'my-tickets still waits for setup',
  );
});

// ---- an edit applies to the next launch and the next send, with no restart ----

// A session that has finished, so the next launch is not refused.
function finishSessions(f) {
  f.cli.setListing(
    f.cli.listing.map((entry) => {
      const copy = { ...entry };
      delete copy.pid;
      return { ...copy, state: 'done', status: null };
    }),
  );
}
const launchedPrompt = (f, index = -1) => f.cli.launches().at(index).args.at(-1);

test('scenario 186: an edit through the route is in the next investigate launch, and a reset takes it out again', async (t) => {
  const f = await claudeHttpFixture(t);
  const filled = (text) => renderTemplate(text, { statusPath: f.statusPath() });
  const prompts = [];
  const relaunch = async () => {
    finishSessions(f);
    const res = await launch(f);
    assert.equal(res.status, 200);
    prompts.push(launchedPrompt(f));
  };

  assert.equal((await launch(f)).status, 200);
  prompts.push(launchedPrompt(f));
  await put(f, 'investigate', 'First text for {KEY} at {STATUS_FILE}');
  await relaunch();
  await put(f, 'investigate', '\n  Second text for {SLUG} with $&  \n');
  await relaunch();
  await reset(f, 'investigate');
  await relaunch();

  assert.deepEqual(prompts, [
    filled(INVESTIGATE_TEMPLATE),
    `First text for ${KEY} at ${f.statusPath()}`,
    `Second text for ${SLUG} with $&`,
    filled(INVESTIGATE_TEMPLATE),
  ]);
});

test('scenario 187: an edit through the route is in the next implement launch', async (t) => {
  const f = await claudeHttpFixture(t);
  seedPlanned(f);
  await put(f, 'implement', 'Build {KEY} as planned, status at {STATUS_FILE}.');

  const res = await launch(f, IMPLEMENT);

  assert.equal(res.status, 200);
  assert.equal(launchedPrompt(f), `Build ${KEY} as planned, status at ${f.statusPath()}.`);
  assert.equal(
    (await list(f)).json().prompts[0].source,
    'default',
    'the investigate prompt is not touched',
  );
});

const FIRST_TEXT = 'ANSWER-ALPHA-4410';
const SECOND_TEXT = 'ANSWER-BETA-5520';
const CHANGED_TEXT = 'ANSWER-GAMMA-6630';
const HALF_ANSWERED = [question('q1', FIRST_TEXT), question('q2')];

test('scenario 188: an edit through the route is in the next send, and a reset takes it out again', async (t) => {
  const f = await claudeHttpFixture(t);
  f.seed(KEY, {
    status: statusFile({ investigate: true, questions: HALF_ANSWERED }),
    launch: { [INVESTIGATE]: launchRecord({ answered: answeredMap(HALF_ANSWERED) }) },
  });
  f.writePlan();
  f.cli.setListing([listed({ id: EARLIER_ID })]);
  await put(f, 'answers', 'Read {STATUS_FILE} for {KEY}: {CHANGE} {QUESTION_IDS} (first)');

  const first = await save(f, { q2: SECOND_TEXT });
  await put(f, 'answers', 'Second {CHANGE} {QUESTION_IDS}');
  const second = await save(f, { q2: CHANGED_TEXT });
  await reset(f, 'answers');
  const third = await save(f, { q2: FIRST_TEXT });

  for (const res of [first, second, third]) {
    assert.equal(res.status, 200);
    assert.deepEqual(res.json().send, { status: 'sent' });
  }
  assert.deepEqual(
    f.cli.resumes().map(({ args }) => args.at(-1)),
    [
      `Read ${f.statusPath()} for ${KEY}: answers q1, q2 (first)`,
      'Second changed answers q2',
      renderTemplate(ANSWERS_TEMPLATE, {
        statusPath: f.statusPath(),
        questionIds: ['q2'],
        change: 'changed answers',
      }),
    ],
  );
});

test('scenario 189: a save while a launch is starting is answered at once, and the launch already under way is not changed', async (t) => {
  const f = await claudeHttpFixture(t);
  const filled = (text) => renderTemplate(text, { statusPath: f.statusPath() });
  const hold = f.cli.holdLaunch();
  const launching = launch(f);
  await until(() => f.cli.launches().length === 1);

  const saved = await put(f, 'investigate', 'edited while the launch is starting');
  const reply = await reset(f, 'implement');

  assert.equal(saved.status, 200, 'the route does not wait for the launch');
  assert.equal(reply.status, 200);
  hold.release();
  assert.equal((await launching).status, 200);
  assert.equal(
    launchedPrompt(f, 0),
    filled(INVESTIGATE_TEMPLATE),
    'the launch kept the text it began with',
  );
  finishSessions(f);
  assert.equal((await launch(f)).status, 200);
  assert.equal(
    launchedPrompt(f),
    'edited while the launch is starting',
    'the next launch has the edit',
  );
});

// ---- the app as shipped: the default store is the dashboard's own prompts folder ----

test('scenario 190: the dashboard with its default wiring lists, saves and resets the prompts in its own prompts folder', (t) => {
  const sandbox = dashboardSandbox(t);
  sandbox.write('prompts/investigate.md', '  my own {KEY}  \n');
  fs.mkdirSync(path.join(sandbox.copy, 'prompts', 'implement.md'));
  const json = { 'content-type': 'application/json' };

  const replies = sandbox.requests([
    { label: 'first list', path: PROMPTS },
    {
      label: 'save',
      method: 'PUT',
      path: route('answers'),
      headers: json,
      body: { text: ' new answers ' },
    },
    { label: 'reset', method: 'DELETE', path: route('investigate') },
    { label: 'second list', path: PROMPTS },
  ]);

  const entries = (label) => JSON.parse(replies[label].text).prompts;
  assert.deepEqual(
    entries('first list').map(({ name, source, text }) => [name, source, text]),
    [
      ['investigate', 'custom', 'my own {KEY}'],
      ['implement', 'unusable', IMPLEMENT_TEMPLATE],
      ['answers', 'default', ANSWERS_TEMPLATE],
      ['answers-implement', 'default', ANSWERS_IMPLEMENT_TEMPLATE],
      ['approve', 'default', APPROVE_TEMPLATE],
      ['rereview', 'default', REREVIEW_TEMPLATE],
      ['groom', 'default', GROOM_TEMPLATE],
      ['review', 'default', REVIEW_TEMPLATE],
      ['spec-review', 'default', SPEC_REVIEW_TEMPLATE],
      ['e2e', 'default', E2E_TEMPLATE],
    ],
  );
  assert.equal(replies.save.status, 200);
  assert.equal(
    fs.readFileSync(path.join(sandbox.copy, 'prompts', 'answers.md'), 'utf8'),
    'new answers\n',
  );
  assert.equal(replies.reset.status, 200);
  assert.equal(fs.existsSync(path.join(sandbox.copy, 'prompts', 'investigate.md')), false);
  assert.deepEqual(
    entries('second list').map(({ name, source }) => [name, source]),
    [
      ['investigate', 'default'],
      ['implement', 'unusable'],
      ['answers', 'custom'],
      ['answers-implement', 'default'],
      ['approve', 'default'],
      ['rereview', 'default'],
      ['groom', 'default'],
      ['review', 'default'],
      ['spec-review', 'default'],
      ['e2e', 'default'],
    ],
  );
  assert.deepEqual(fs.readdirSync(sandbox.elsewhere), [], 'nothing went to the working folder');
});

// ---- after the review: a NUL byte, a linked prompts folder, the shared failure ----

test('scenario 191: PUT with a NUL byte in the text is INVALID_PROMPT and writes nothing', async (t) => {
  const f = await claudeHttpFixture(t);
  f.writePrompt('investigate', 'kept\n');
  f.recorder.clearCalls();

  assertInvalid(await put(f, 'investigate', 'before\0after'), 'a NUL byte');

  assert.deepEqual(changes(f), [], 'nothing is written');
  assert.equal(fs.readFileSync(f.promptPath('investigate'), 'utf8'), 'kept\n');
});

test('scenario 192: with a prompts folder that is a symlink the list works, and a save or a reset is CLAUDE_FAILED and changes nothing behind the link', async (t) => {
  const f = await claudeHttpFixture(t);
  const behind = path.join(f.root, 'behind');
  fs.mkdirSync(behind);
  fs.writeFileSync(path.join(behind, 'answers.md'), 'kept {KEY}\n');
  fs.symlinkSync(behind, f.promptsDir);

  const listing = await list(f);
  const saved = await put(f, 'investigate', 'new');
  const removed = await reset(f, 'answers');

  assert.equal(listing.status, 200);
  assert.deepEqual(listing.json().prompts[2], promptEntry('answers', 'custom', 'kept {KEY}'));
  assert.equal(saved.status, 502, 'a save is refused');
  assert.equal(removed.status, 502, 'a reset is refused');
  assertFailed(saved, 'save');
  assertFailed(removed, 'reset');
  assert.deepEqual(fs.readdirSync(behind), ['answers.md']);
  assert.equal(fs.readFileSync(path.join(behind, 'answers.md'), 'utf8'), 'kept {KEY}\n');
});

test('scenario 193: the launcher exports the CLAUDE_FAILED error that the prompt routes throw', async () => {
  const { failed } = await import('../backend/claude-launcher.mjs');
  assert.equal(typeof failed, 'function', 'the launcher exports failed');

  const error = failed('prompt_not_changed');

  assert.ok(error instanceof Error);
  assert.equal(error.code, 'CLAUDE_FAILED');
  assert.equal(error.status, 502);
  assert.deepEqual(error.errors, ['prompt_not_changed']);
});

// ---- the groom prompt over the routes ----

test('scenario 205: an edit of the groom prompt through the route is in the next groom launch, and a reset takes it out', async (t) => {
  const f = await claudeHttpFixture(t);
  const prompt = (index) => f.cli.launches()[index].args.at(-1);
  await put(f, 'groom', 'Groom {KEY} in {SLUG}, never {STATUS_FILE}.');

  const first = await launch(f, GROOM);
  assert.equal(first.status, 200);
  assert.equal(prompt(0), `Groom ${KEY} in ${SLUG}, never {STATUS_FILE}.`);

  finishSessions(f);
  await reset(f, 'groom');
  assert.equal((await launch(f, GROOM)).status, 200);
  assert.equal(prompt(1), groomPrompt(KEY));
  assert.equal(GROOM_TEMPLATE.includes('{STATUS_FILE}'), false);
});
