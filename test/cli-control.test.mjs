import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { invokeCli } from './cli-settings-fixture.mjs';

async function runControl(t, command, response) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-dashboard-cli-'));
  const argv = process.argv;
  t.after(() => {
    process.argv = argv;
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.copyFileSync(new URL('../cli.mjs', import.meta.url), path.join(root, 'cli.mjs'));
  fs.writeFileSync(
    path.join(root, 'config.mjs'),
    `
    export const DASHBOARD_DIR = ${JSON.stringify(root)};
    export const DEFAULT_TAIL_LINES = 40;
    export const DASHBOARD_HOST = '127.0.0.1';
    export const DASHBOARD_PORT = 6500;
    export const SERVICES = { be: {} };
    export const hasService = (id) => id === 'be';
    export const getMinPrApprover = () => 1;
  `,
  );
  fs.writeFileSync(
    path.join(root, 'settings.mjs'),
    `
    export const settingsStore = {
      async initialize() {},
      getSetupStatus() { return { ready: true, revision: 1, errors: [] }; },
      getSnapshot() { return { revision: 1, minPrApprover: 1, local: { root: ${JSON.stringify(root)}, services: [{ id: 'be' }] } }; },
    };
    export const getSettingsStore = () => settingsStore;
  `,
  );
  fs.writeFileSync(
    path.join(root, 'manager.mjs'),
    `
    export const attempts = [];
    export class Manager {
      constructor() {
        attempts.push('fallback');
        throw new Error('Unexpected in-process fallback');
      }
    }
  `,
  );
  for (const [file, names] of [
    ['github.mjs', ['fetchOpenPRs', 'groupByTicket']],
    ['jira.mjs', ['fetchMyTickets']],
    ['team-velocity.mjs', ['DEFAULT_KEEP_SPRINTS', 'rebuildTeamVelocity']],
    ['review.mjs', ['approvalCount', 'enrichOpenPRs', 'filterPrsNeedingApprovals']],
    ['releases.mjs', ['fetchRelease', 'formatReleaseText', 'parseReleasesArgs']],
  ]) {
    fs.writeFileSync(
      path.join(root, file),
      names
        .map(
          (name) =>
            `export const ${name} = () => { throw new Error('Unexpected dependency call'); };`,
        )
        .join('\n'),
    );
  }
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, method: options?.method || 'GET' });
    assert.ok(requests.length <= 2, 'no retry or extra network request');
    return requests.length === 1 ? new Response('{}') : response;
  });
  const output = [];
  const errors = [];
  const exits = [];
  let finish;
  const finished = new Promise((resolve) => {
    finish = resolve;
  });
  t.mock.method(console, 'log', (message) => {
    output.push(message);
    finish();
  });
  t.mock.method(console, 'error', (message) => errors.push(message));
  t.mock.method(process, 'exit', (code) => {
    exits.push(code);
    finish();
  });
  process.argv = [process.execPath, path.join(root, 'cli.mjs'), command, 'be'];
  await import(pathToFileURL(path.join(root, 'cli.mjs')));
  await finished;
  const { attempts } = await import(pathToFileURL(path.join(root, 'manager.mjs')));
  assert.deepEqual(requests, [
    { url: 'http://127.0.0.1:6500/api/services', method: 'GET' },
    { url: `http://127.0.0.1:6500/api/services/be/${command}`, method: 'POST' },
  ]);
  assert.deepEqual(attempts, [], 'must not fall back to launching an in-process manager');
  return { output, errors, exits };
}

for (const command of ['start', 'restart']) {
  test(`CLI ${command} surfaces dashboard pin rejection and exits nonzero without success or fallback`, async (t) => {
    const error = 'Unsupported .nvmrc pin "lts/*": expected an exact Node version';
    const result = await runControl(
      t,
      command,
      new Response(JSON.stringify({ error }), { status: 500 }),
    );
    assert.deepEqual(result.exits, [1]);
    assert.deepEqual(result.errors, [error]);
    assert.deepEqual(result.output, []);
  });

  test(`CLI ${command} still reports a successful dashboard control response`, async (t) => {
    const result = await runControl(t, command, new Response(JSON.stringify({ ok: true })));
    assert.deepEqual(result.exits, []);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.output, [`${command} be (via dashboard)`]);
  });
}

test('CLI control reports the HTTP status when a failure has no JSON error', async (t) => {
  const result = await runControl(t, 'start', new Response('Unavailable', { status: 503 }));
  assert.deepEqual(result.exits, [1]);
  assert.deepEqual(result.errors, ['Dashboard start be failed (HTTP 503)']);
  assert.deepEqual(result.output, []);
});

test('all CLI operations reject setup before fallback or direct integrations; help and saved offline service IDs work', async (t) => {
  for (const dashboard of ['gated', 'unavailable']) {
    for (const command of [
      'status',
      'logs',
      'start',
      'stop',
      'restart',
      'prs',
      'my-tickets',
      'releases',
      'team-velocity',
    ]) {
      const result = await invokeCli(t, command, { dashboard });
      assert.notEqual(result.exitCode, 0, `${dashboard} ${command}`);
      assert.match(result.errors.join('\n'), /setup|settings/i);
      assert.deepEqual(result.calls, [], 'no manager, direct integration, or control work');
      assert.equal(
        result.requests.every((url) => /\/api\/(services|config)$/.test(url)),
        true,
      );
      assert.ok(result.requests.length <= 2);
    }
  }
  const help = await invokeCli(t, 'help');
  assert.equal(help.exitCode, 0);
  assert.match(help.output.join('\n'), /dev-dashboard/);
  assert.deepEqual(help.requests, []);
  assert.deepEqual(help.calls, []);
  const ready = await invokeCli(t, 'start', { ready: true, dashboard: 'unavailable' });
  assert.equal(ready.exitCode, 0);
  assert.deepEqual(ready.errors, []);
  assert.deepEqual(
    ready.calls.filter(([name]) => name === 'start'),
    [['start', 'app']],
  );
  const constructor = ready.calls.find(([name]) => name === 'manager');
  assert.equal(constructor[1].local.root, ready.f.root);
  assert.equal(constructor[1].local.services[0].id, 'app');
});

test('CLI help lists the releases command', async (t) => {
  const help = await invokeCli(t, 'help');
  assert.equal(help.exitCode, 0);
  assert.match(help.output.join('\n'), /releases/);
  assert.deepEqual(help.requests, []);
  assert.deepEqual(help.calls, []);
});

async function runReleasesCli(t, args, { result = null, failure = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-dashboard-cli-releases-'));
  const argv = process.argv;
  t.after(() => {
    process.argv = argv;
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.copyFileSync(new URL('../cli.mjs', import.meta.url), path.join(root, 'cli.mjs'));
  fs.copyFileSync(
    new URL('../release-model.mjs', import.meta.url),
    path.join(root, 'release-model.mjs'),
  );
  fs.writeFileSync(
    path.join(root, 'config.mjs'),
    `
    export const DASHBOARD_DIR = ${JSON.stringify(root)};
    export const DEFAULT_TAIL_LINES = 40;
    export const DASHBOARD_HOST = '127.0.0.1';
    export const DASHBOARD_PORT = 6500;
    export const SERVICES = { be: {} };
    export const hasService = (id) => id === 'be';
    export const getMinPrApprover = () => 1;
  `,
  );
  fs.writeFileSync(
    path.join(root, 'settings.mjs'),
    `
    const snapshot = { revision: 1, minPrApprover: 1, sentinel: 'saved-snapshot', local: { root: ${JSON.stringify(root)}, services: [{ id: 'be' }] } };
    export const settingsStore = {
      async initialize() {},
      getSetupStatus() { return { ready: true, revision: 1, errors: [] }; },
      getSnapshot() { return snapshot; },
    };
    export const getSettingsStore = () => settingsStore;
  `,
  );
  fs.writeFileSync(
    path.join(root, 'manager.mjs'),
    `export class Manager { constructor() { throw new Error('Unexpected manager'); } }`,
  );
  for (const [file, names] of [
    ['github.mjs', ['fetchOpenPRs', 'groupByTicket']],
    ['jira.mjs', ['fetchMyTickets']],
    ['team-velocity.mjs', ['DEFAULT_KEEP_SPRINTS', 'rebuildTeamVelocity']],
    ['review.mjs', ['approvalCount', 'enrichOpenPRs', 'filterPrsNeedingApprovals']],
  ]) {
    fs.writeFileSync(
      path.join(root, file),
      names
        .map(
          (name) =>
            `export const ${name} = () => { throw new Error('Unexpected dependency call'); };`,
        )
        .join('\n'),
    );
  }
  fs.writeFileSync(
    path.join(root, 'releases.mjs'),
    `
    export { parseReleasesArgs, formatReleaseText } from './release-model.mjs';
    export const releaseCalls = [];
    export async function fetchRelease(options) {
      releaseCalls.push(options);
      ${failure ? `throw new Error(${JSON.stringify(failure)});` : `return ${JSON.stringify(result)};`}
    }
  `,
  );
  t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('synthetic offline');
  });
  const output = [];
  const errors = [];
  const exits = [];
  let finish;
  const finished = new Promise((resolve) => {
    finish = resolve;
  });
  t.mock.method(console, 'log', (message) => {
    output.push(message);
    finish();
  });
  t.mock.method(console, 'error', (message) => errors.push(message));
  t.mock.method(process, 'exit', (code) => {
    exits.push(code);
    finish();
  });
  process.argv = [process.execPath, path.join(root, 'cli.mjs'), 'releases', ...args];
  await import(pathToFileURL(path.join(root, 'cli.mjs')));
  await finished;
  const { releaseCalls } = await import(pathToFileURL(path.join(root, 'releases.mjs')));
  return {
    output,
    errors,
    exits,
    releaseCalls,
    snapshot: {
      revision: 1,
      minPrApprover: 1,
      sentinel: 'saved-snapshot',
      local: { root, services: [{ id: 'be' }] },
    },
  };
}

const emptyRelease = {
  versions: [],
  scope: 'all',
  total: 0,
  truncated: false,
  tickets: [],
  version: {
    id: '18741',
    name: 'EZAT | Sprint 19.0 | 10/09/26',
    released: false,
    releaseDate: '2026-10-09',
  },
};

test('CLI releases sends a version name, everyone and no refresh, and prints the release as JSON', async (t) => {
  const run = await runReleasesCli(
    t,
    ['--version', 'EZAT | Sprint 19.0 | 10/09/26', '--all', '--json'],
    { result: emptyRelease },
  );
  assert.deepEqual(run.releaseCalls, [
    {
      versionName: 'EZAT | Sprint 19.0 | 10/09/26',
      mine: false,
      refresh: false,
      snapshot: run.snapshot,
    },
  ]);
  assert.equal(run.output.length, 1);
  assert.match(run.output[0], /^\{\n {2}"/);
  assert.deepEqual(JSON.parse(run.output[0]), emptyRelease);
  assert.deepEqual(run.errors, []);
  assert.deepEqual(run.exits, []);
});

test('CLI releases sends digits as a version id and no version as the default, for my tickets, and prints text', async (t) => {
  const byId = await runReleasesCli(t, ['--version', '18741'], { result: emptyRelease });
  assert.deepEqual(byId.releaseCalls, [
    { versionId: '18741', mine: true, refresh: false, snapshot: byId.snapshot },
  ]);
  assert.match(
    byId.output[0],
    /^Unreleased version EZAT \| Sprint 19\.0 \| 10\/09\/26 \(2026-10-09\) - /,
  );
  const byDefault = await runReleasesCli(t, [], { result: emptyRelease });
  assert.deepEqual(byDefault.releaseCalls, [
    { versionId: null, mine: true, refresh: false, snapshot: byDefault.snapshot },
  ]);
});

test('CLI releases prints the failure message to stderr and exits 1 without output', async (t) => {
  const run = await runReleasesCli(t, ['--all'], { failure: 'jira versions failed: 500' });
  assert.deepEqual(run.errors, ['jira versions failed: 500']);
  assert.deepEqual(run.exits, [1]);
  assert.deepEqual(run.output, []);
});

test('CLI releases reports a usage error to stderr and exits 1 without fetching', async (t) => {
  const run = await runReleasesCli(t, ['--version']);
  assert.equal(run.errors.length, 1);
  assert.match(run.errors[0], /^usage: releases /);
  assert.deepEqual(run.exits, [1]);
  assert.deepEqual(run.releaseCalls, []);
});
