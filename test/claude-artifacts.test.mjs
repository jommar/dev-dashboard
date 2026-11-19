// claude-artifacts.test.mjs — the read-only Markdown the dashboard shows for a ticket: what is
// listed, what is read, and everything refused. Real temp directories; nothing touches ~/pathwise.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createClaudeArtifacts, MAX_ARTIFACT_BYTES } from '../backend/claude-artifacts.mjs';

const KEY = 'TAP-1747';

function workspace(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'pathwise', '.orchestrator');
  const dir = path.join(root, KEY.toLowerCase());
  fs.mkdirSync(dir, { recursive: true });
  return { home, root, dir, artifacts: createClaudeArtifacts({ home }) };
}

const refusal = (code, status) => (error) => error.code === code && error.status === status;

test('lists only the ticket folder’s own .md files, the plan first', (t) => {
  const { dir, artifacts } = workspace(t);
  for (const name of ['groom.md', '02-spec.md', '02-plan.md', 'notes.txt', '.hidden.md', 'a b.md'])
    fs.writeFileSync(path.join(dir, name), '# x');
  fs.mkdirSync(path.join(dir, 'scratch.md'));
  fs.mkdirSync(path.join(dir, 'scratch'));
  fs.writeFileSync(path.join(dir, 'scratch', 'deep.md'), '# deep');
  const { ok, key, files } = artifacts.list(KEY);
  assert.equal(ok, true);
  assert.equal(key, KEY);
  assert.deepEqual(
    files.map((file) => file.name),
    ['02-plan.md', '02-spec.md', 'groom.md'],
  );
  assert.deepEqual(Object.keys(files[0]).sort(), ['name', 'size', 'updatedAt']);
  assert.ok(Number.isFinite(Date.parse(files[0].updatedAt)));
});

test('a ticket with no folder has no files, not an error', (t) => {
  const { artifacts } = workspace(t);
  assert.deepEqual(artifacts.list('TAP-9999'), { ok: true, key: 'TAP-9999', files: [] });
});

test('reads a file’s text with its size and time', (t) => {
  const { dir, artifacts } = workspace(t);
  fs.writeFileSync(path.join(dir, '02-plan.md'), '# Plan\n\n- [ ] one\n');
  const result = artifacts.read(KEY, '02-plan.md');
  assert.equal(result.text, '# Plan\n\n- [ ] one\n');
  assert.equal(result.name, '02-plan.md');
  assert.equal(result.size, 18);
});

test('refuses a ticket key or file name that could name another path', (t) => {
  const { artifacts } = workspace(t);
  for (const key of ['../etc', 'tap-1747', 'TAP-1/../x', '', null, undefined, 'TAP-1747/x'])
    assert.throws(() => artifacts.list(key), refusal('INVALID_TICKET', 400), `list ${key}`);
  for (const name of [
    '../02-plan.md',
    '..%2F02-plan.md',
    'sub/02-plan.md',
    '02-plan.txt',
    '02-plan.md/',
    '.md',
    '',
    null,
    undefined,
    'x'.repeat(120) + '.md',
  ])
    assert.throws(
      () => artifacts.read(KEY, name),
      refusal('INVALID_ARTIFACT', 400),
      `read ${name}`,
    );
  assert.throws(() => artifacts.read('../x', '02-plan.md'), refusal('INVALID_TICKET', 400));
});

test('a missing file or folder is not found', (t) => {
  const { artifacts } = workspace(t);
  assert.throws(() => artifacts.read(KEY, 'nope.md'), refusal('ARTIFACT_NOT_FOUND', 404));
  assert.throws(() => artifacts.read('TAP-9999', 'a.md'), refusal('ARTIFACT_NOT_FOUND', 404));
});

test('a symlinked file is neither listed nor read, even to a real Markdown file', (t) => {
  const { home, dir, artifacts } = workspace(t);
  const outside = path.join(home, 'secret.md');
  fs.writeFileSync(outside, '# secret');
  fs.symlinkSync(outside, path.join(dir, 'link.md'));
  assert.deepEqual(artifacts.list(KEY).files, []);
  assert.throws(() => artifacts.read(KEY, 'link.md'), refusal('ARTIFACT_NOT_FOUND', 404));
});

test('a ticket folder that is a symlink out of the root is treated as absent', (t) => {
  const { home, root, artifacts } = workspace(t);
  const outside = path.join(home, 'elsewhere');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'a.md'), '# a');
  fs.symlinkSync(outside, path.join(root, 'tap-2000'));
  assert.deepEqual(artifacts.list('TAP-2000').files, []);
  assert.throws(() => artifacts.read('TAP-2000', 'a.md'), refusal('ARTIFACT_NOT_FOUND', 404));
});

test('a file over the size cap is refused rather than read', (t) => {
  const { dir, artifacts } = workspace(t);
  fs.writeFileSync(path.join(dir, 'big.md'), 'x'.repeat(MAX_ARTIFACT_BYTES + 1));
  fs.writeFileSync(path.join(dir, 'edge.md'), 'x'.repeat(MAX_ARTIFACT_BYTES));
  assert.throws(() => artifacts.read(KEY, 'big.md'), refusal('ARTIFACT_TOO_LARGE', 413));
  assert.equal(artifacts.read(KEY, 'edge.md').size, MAX_ARTIFACT_BYTES);
});

// ---- the two routes on the production HTTP handler --------------------------------------------

async function serve(t, artifacts) {
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
      slackWatcher: { isDisabled: () => true, stop() {}, list: () => ({}), refreshSchedule() {} },
      claudeArtifacts: artifacts,
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
  return async (pathAndQuery, method = 'GET') => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${pathAndQuery}`, { method });
    return { status: res.status, body: await res.json() };
  };
}

test('GET /api/claude/artifacts and /artifact serve the list and a file, and say why they refuse', async (t) => {
  const { dir, artifacts } = workspace(t);
  fs.writeFileSync(path.join(dir, '02-plan.md'), '# Plan');
  const get = await serve(t, artifacts);

  const listed = await get(`/api/claude/artifacts?key=${KEY}`);
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.body.files.map((file) => file.name),
    ['02-plan.md'],
  );

  const file = await get(`/api/claude/artifact?key=${KEY}&name=02-plan.md`);
  assert.equal(file.status, 200);
  assert.equal(file.body.text, '# Plan');

  const bad = [
    [`/api/claude/artifacts`, 400, 'INVALID_TICKET'],
    [`/api/claude/artifacts?key=..%2Fetc`, 400, 'INVALID_TICKET'],
    [`/api/claude/artifact?key=${KEY}`, 400, 'INVALID_ARTIFACT'],
    [`/api/claude/artifact?key=${KEY}&name=..%2F..%2Fx.md`, 400, 'INVALID_ARTIFACT'],
    [`/api/claude/artifact?key=${KEY}&name=gone.md`, 404, 'ARTIFACT_NOT_FOUND'],
  ];
  for (const [url, status, code] of bad) {
    const result = await get(url);
    assert.equal(result.status, status, url);
    assert.equal(result.body.code, code, url);
  }
  // Read-only: no write verb reaches the store.
  const post = await get(`/api/claude/artifact?key=${KEY}&name=02-plan.md`, 'POST');
  assert.notEqual(post.status, 200);
  assert.equal(fs.readFileSync(path.join(dir, '02-plan.md'), 'utf8'), '# Plan');
});

// ---- proof reports: ~/pathwise/proofs/.proofs-out/<TICKET>/<run id>/report.md -------------------

const RUN_A = '77b793d4-707d-4b7f-8e00-7d847babcaeb';
const RUN_B = 'b47a33b6-5815-4a1d-b60b-7e8ee9579cd1';

function proofsWorkspace(t) {
  const ws = workspace(t);
  const proofsRoot = path.join(ws.home, 'pathwise', 'proofs', '.proofs-out');
  const proofsDir = path.join(proofsRoot, KEY);
  fs.mkdirSync(proofsDir, { recursive: true });
  const writeRun = (run, text, seconds) => {
    fs.mkdirSync(path.join(proofsDir, run), { recursive: true });
    const file = path.join(proofsDir, run, 'report.md');
    fs.writeFileSync(file, text);
    fs.utimesSync(file, seconds, seconds);
  };
  return { ...ws, proofsRoot, proofsDir, writeRun };
}

test('proofs are listed apart from the orchestrator files, newest run first', (t) => {
  const { dir, writeRun, artifacts } = proofsWorkspace(t);
  fs.writeFileSync(path.join(dir, '02-plan.md'), '# Plan');
  writeRun(RUN_A, '# Proof A', 2_000_000);
  writeRun(RUN_B, '# Proof B', 3_000_000);
  const { ok, key, runs } = artifacts.listProofs(KEY);
  assert.equal(ok, true);
  assert.equal(key, KEY);
  assert.deepEqual(
    runs.map((run) => run.run),
    [RUN_B, RUN_A],
  );
  assert.deepEqual(Object.keys(runs[0]).sort(), ['name', 'run', 'size', 'updatedAt']);
  assert.equal(runs[0].name, 'report.md');
  assert.deepEqual(
    artifacts.list(KEY).files.map((file) => file.name),
    ['02-plan.md'],
  );
});

test('only a run folder named by a UUID with a regular report.md is listed', (t) => {
  const { proofsDir, writeRun, artifacts, home } = proofsWorkspace(t);
  writeRun(RUN_A, '# Proof A', 2_000_000);
  fs.mkdirSync(path.join(proofsDir, 'scratch'));
  fs.writeFileSync(path.join(proofsDir, 'scratch', 'report.md'), '# no');
  fs.mkdirSync(path.join(proofsDir, RUN_B)); // no report yet
  const outside = path.join(home, 'secret.md');
  fs.writeFileSync(outside, '# secret');
  const linked = '11111111-2222-3333-4444-555555555555';
  fs.mkdirSync(path.join(proofsDir, linked));
  fs.symlinkSync(outside, path.join(proofsDir, linked, 'report.md'));
  assert.deepEqual(
    artifacts.listProofs(KEY).runs.map((run) => run.run),
    [RUN_A],
  );
});

test('a ticket with no proofs has none, not an error', (t) => {
  const { artifacts } = proofsWorkspace(t);
  assert.deepEqual(artifacts.listProofs('TAP-9999'), { ok: true, key: 'TAP-9999', runs: [] });
});

test('reads a proof report with its run, size and time', (t) => {
  const { writeRun, artifacts } = proofsWorkspace(t);
  writeRun(RUN_A, '# Proof report\n', 2_000_000);
  const result = artifacts.readProof(KEY, RUN_A);
  assert.equal(result.text, '# Proof report\n');
  assert.equal(result.run, RUN_A);
  assert.equal(result.name, 'report.md');
  assert.equal(result.size, 15);
});

test('refuses a proof key or run id that could name another path, and says when it is missing', (t) => {
  const { writeRun, artifacts } = proofsWorkspace(t);
  writeRun(RUN_A, '# Proof A', 2_000_000);
  for (const key of ['../etc', 'tap-1747', '', null, undefined])
    assert.throws(() => artifacts.listProofs(key), refusal('INVALID_TICKET', 400), `list ${key}`);
  for (const run of ['..', '../x', RUN_A.toUpperCase(), `${RUN_A}/report.md`, '', null, undefined])
    assert.throws(
      () => artifacts.readProof(KEY, run),
      refusal('INVALID_ARTIFACT', 400),
      `read ${run}`,
    );
  assert.throws(() => artifacts.readProof('../x', RUN_A), refusal('INVALID_TICKET', 400));
  assert.throws(() => artifacts.readProof(KEY, RUN_B), refusal('ARTIFACT_NOT_FOUND', 404));
  assert.throws(() => artifacts.readProof('TAP-9999', RUN_A), refusal('ARTIFACT_NOT_FOUND', 404));
});

test('a symlinked proof report, run folder or ticket folder is never read', (t) => {
  const { home, proofsRoot, proofsDir, artifacts } = proofsWorkspace(t);
  const outside = path.join(home, 'elsewhere');
  fs.mkdirSync(path.join(outside, RUN_A), { recursive: true });
  fs.writeFileSync(path.join(outside, RUN_A, 'report.md'), '# outside');
  // a run folder that is a link out of the ticket's proofs folder
  fs.symlinkSync(path.join(outside, RUN_A), path.join(proofsDir, RUN_A));
  assert.deepEqual(artifacts.listProofs(KEY).runs, []);
  assert.throws(() => artifacts.readProof(KEY, RUN_A), refusal('ARTIFACT_NOT_FOUND', 404));
  // a ticket folder that is a link out of the proofs root
  fs.symlinkSync(outside, path.join(proofsRoot, 'TAP-2000'));
  assert.deepEqual(artifacts.listProofs('TAP-2000').runs, []);
  assert.throws(() => artifacts.readProof('TAP-2000', RUN_A), refusal('ARTIFACT_NOT_FOUND', 404));
  // a report that is a link
  fs.mkdirSync(path.join(proofsDir, RUN_B));
  fs.symlinkSync(path.join(outside, RUN_A, 'report.md'), path.join(proofsDir, RUN_B, 'report.md'));
  assert.throws(() => artifacts.readProof(KEY, RUN_B), refusal('ARTIFACT_NOT_FOUND', 404));
});

test('a proof report over the size cap is refused rather than read', (t) => {
  const { writeRun, artifacts } = proofsWorkspace(t);
  writeRun(RUN_A, 'x'.repeat(MAX_ARTIFACT_BYTES + 1), 2_000_000);
  assert.throws(() => artifacts.readProof(KEY, RUN_A), refusal('ARTIFACT_TOO_LARGE', 413));
});

test('GET /api/claude/proofs and /proof serve the runs and a report, and say why they refuse', async (t) => {
  const { writeRun, artifacts } = proofsWorkspace(t);
  writeRun(RUN_A, '# Proof A', 2_000_000);
  const get = await serve(t, artifacts);

  const listed = await get(`/api/claude/proofs?key=${KEY}`);
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.body.runs.map((run) => run.run),
    [RUN_A],
  );
  const report = await get(`/api/claude/proof?key=${KEY}&run=${RUN_A}`);
  assert.equal(report.status, 200);
  assert.equal(report.body.text, '# Proof A');

  for (const [url, status, code] of [
    [`/api/claude/proofs`, 400, 'INVALID_TICKET'],
    [`/api/claude/proof?key=${KEY}`, 400, 'INVALID_ARTIFACT'],
    [`/api/claude/proof?key=${KEY}&run=..%2F..%2Fx`, 400, 'INVALID_ARTIFACT'],
    [`/api/claude/proof?key=${KEY}&run=${RUN_B}`, 404, 'ARTIFACT_NOT_FOUND'],
  ]) {
    const result = await get(url);
    assert.equal(result.status, status, url);
    assert.equal(result.body.code, code, url);
  }
  const post = await get(`/api/claude/proof?key=${KEY}&run=${RUN_A}`, 'POST');
  assert.notEqual(post.status, 200);
});
