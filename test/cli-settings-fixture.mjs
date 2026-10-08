import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { settingsFixture } from './settings-fixture.mjs';

export async function invokeCli(t, command, { ready = false, dashboard = 'gated' } = {}) {
  const f = settingsFixture(t);
  const root = f.paths.dashboardDir;
  fs.copyFileSync(new URL('../backend/cli.mjs', import.meta.url), path.join(root, 'cli.mjs'));
  fs.writeFileSync(
    path.join(root, 'settings.mjs'),
    `
    export const calls = [];
    const snapshot = ${JSON.stringify({ ...f.configuration, revision: 7, credentials: { githubToken: 'synthetic-cli-gh', jiraToken: 'synthetic-cli-jira' } })};
    export const settingsStore = {
      async initialize() {},
      getSetupStatus() { return { ready: ${ready}, revision: 7, errors: ${ready ? '[]' : '[{field:"jira",message:"Complete Settings setup"}]'} }; },
      getSnapshot() { return snapshot; },
      getPublicSettings() { return snapshot; },
    };
    export const getSettingsStore = () => settingsStore;
  `,
  );
  fs.writeFileSync(
    path.join(root, 'config.mjs'),
    `
    export const DASHBOARD_DIR = ${JSON.stringify(root)};
    export const DEFAULT_TAIL_LINES = 40;
    export const DASHBOARD_HOST = '127.0.0.1';
    export const DASHBOARD_PORT = 6500;
    export const SERVICES = { old: { id: 'old' } };
    export const hasService = id => id === 'old';
    export const getMinPrApprover = () => 1;
  `,
  );
  fs.writeFileSync(
    path.join(root, 'manager.mjs'),
    `
    import { calls } from './settings.mjs';
    export class Manager {
      constructor(options) { calls.push(['manager', options]); }
      list() { return [{ id: 'app', status: 'stopped', label: 'Saved app' }]; }
      logs(id) { calls.push(['logs', id]); return 'saved logs'; }
      async start(id) { calls.push(['start', id]); return { ok: true }; }
      stop(id) { calls.push(['stop', id]); return { ok: true }; }
      async restart(id) { calls.push(['restart', id]); return { ok: true }; }
    }
  `,
  );
  for (const [file, names] of [
    ['github.mjs', ['fetchOpenPRs', 'groupByTicket']],
    ['jira.mjs', ['fetchMyTickets']],
    ['team-velocity.mjs', ['rebuildTeamVelocity']],
    ['review.mjs', ['approvalCount', 'enrichOpenPRs', 'filterPrsNeedingApprovals']],
    ['releases.mjs', ['fetchRelease', 'formatReleaseText', 'parseReleasesArgs']],
  ])
    fs.writeFileSync(
      path.join(root, file),
      `import { calls } from './settings.mjs';\nexport const DEFAULT_KEEP_SPRINTS = 8;\n` +
        names
          .map(
            (name) =>
              `export const ${name} = (...args) => { calls.push(['${name}', ...args]); throw new Error('Unexpected direct integration'); };`,
          )
          .join('\n'),
    );
  const requests = [];
  const output = [];
  const errors = [];
  const exits = [];
  const previousArgv = process.argv;
  const previousExitCode = process.exitCode;
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(String(url));
    if (dashboard === 'unavailable') throw new TypeError('synthetic offline');
    return Response.json(
      { code: 'SETUP_REQUIRED', error: 'Complete Settings setup', setup: { ready: false } },
      { status: 409 },
    );
  });
  let done;
  const finished = new Promise((resolve) => {
    done = resolve;
  });
  t.mock.method(console, 'log', (...args) => {
    output.push(args.join(' '));
    done();
  });
  t.mock.method(console, 'error', (...args) => {
    errors.push(args.join(' '));
    done();
  });
  const stdoutWrite = process.stdout.write;
  t.mock.method(process.stdout, 'write', function (value, ...args) {
    if (String(value) === 'saved logs') {
      output.push(String(value));
      done();
      return true;
    }
    return stdoutWrite.call(this, value, ...args);
  });
  t.mock.method(process, 'exit', (code) => {
    exits.push(code);
    done();
  });
  process.argv = [
    process.execPath,
    path.join(root, 'cli.mjs'),
    command,
    ...(command === 'help' ? [] : ['app']),
  ];
  await import(pathToFileURL(path.join(root, 'cli.mjs')));
  await finished;
  await new Promise((resolve) => setImmediate(resolve));
  const { calls } = await import(pathToFileURL(path.join(root, 'settings.mjs')));
  const exitCode = exits.at(-1) ?? process.exitCode ?? 0;
  process.argv = previousArgv;
  process.exitCode = previousExitCode;
  t.mock.restoreAll();
  return { f, requests, output, errors, exitCode, calls };
}
