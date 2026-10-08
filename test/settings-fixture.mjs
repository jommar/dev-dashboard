import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const githubToken = 'synthetic-github-only-for-tests';
export const jiraToken = 'synthetic-jira-only-for-tests';

export function settingsFixture(t, options = {}) {
  const parent = new URL('./.settings-tmp/', import.meta.url);
  fs.mkdirSync(parent, { recursive: true });
  const home = fs.mkdtempSync(new URL('case-', parent));
  const root = path.join(home, 'repos');
  fs.mkdirSync(root);
  for (const dir of ['app', 'Portage-backend', 'Portage-frontend', 'TravelTracker']) {
    fs.mkdirSync(path.join(root, dir));
  }
  const paths = {
    home,
    root,
    dashboardDir: path.join(home, 'dashboard'),
    settings: path.join(home, '.config/dev-dashboard/settings.json'),
    githubToken: path.join(home, '.config/github/token'),
    jiraToken: path.join(home, '.config/jira/token'),
  };
  fs.mkdirSync(paths.dashboardDir);
  const calls = [];
  const network = { status: 200, route: null };
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (network.route) return network.route(url, init);
    return probeResponse(url, init, network.status);
  };
  const runtimeCalls = [];
  const runtimeInspector = async (service, local) => {
    runtimeCalls.push({ service, local });
    return {
      ok: true,
      cwd: path.resolve(local.root, service.dir),
      env: { PATH: '/synthetic/bin' },
      warnings: ['node_modules missing'],
    };
  };
  const env = { PATH: '/synthetic/bin', ...options.env };
  const configuration = {
    github: { api: 'https://api.github.com', org: 'ExampleOrg', repos: ['app'], maxResults: 17 },
    jira: {
      baseUrl: 'https://jira.example.invalid',
      email: 'qa@example.invalid',
      sprintField: 'customfield_101',
      pointsField: 'customfield_102',
    },
    local: {
      root,
      services: [
        { id: 'app', label: 'Application', dir: 'app', command: ['npm', 'run', 'dev'], port: null },
      ],
    },
    minPrApprover: 2,
  };
  const dependencies = { paths, env, fs: options.fs || fs, fetch, runtimeInspector };
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const write = (filename, value, mode = 0o600) => {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, value, { mode });
  };
  return {
    home,
    root,
    paths,
    env,
    calls,
    network,
    runtimeCalls,
    configuration,
    dependencies,
    write,
    async store() {
      let moduleUrl = new URL('../backend/settings.mjs', import.meta.url);
      if (options.realEnvLoader) {
        fs.copyFileSync(
          new URL('../backend/env.mjs', import.meta.url),
          path.join(paths.dashboardDir, 'env.mjs'),
        );
        const source = fs
          .readFileSync(new URL('../backend/settings.mjs', import.meta.url), 'utf8')
          .replaceAll(
            "from './config.mjs'",
            `from ${JSON.stringify(new URL('../backend/config.mjs', import.meta.url).href)}`,
          )
          .replaceAll(
            "from './credentials.mjs'",
            `from ${JSON.stringify(new URL('../backend/credentials.mjs', import.meta.url).href)}`,
          );
        fs.writeFileSync(path.join(paths.dashboardDir, 'settings.mjs'), source);
        moduleUrl = pathToFileURL(path.join(paths.dashboardDir, 'settings.mjs'));
      }
      const { createSettingsStore } = await import(moduleUrl);
      return createSettingsStore(dependencies);
    },
  };
}

export function probeResponse(url, init, status = 200) {
  let body;
  if (url.pathname === '/user') body = { login: 'qa' };
  else if (/^\/repos\//.test(url.pathname)) body = { name: 'app', permissions: { pull: true } };
  else if (url.pathname === '/graphql')
    body = {
      data: { viewer: { login: 'qa' }, repository: { name: 'app', pullRequests: { nodes: [] } } },
    };
  else if (url.pathname === '/rest/api/3/myself')
    body = { accountId: 'qa', emailAddress: 'qa@example.invalid' };
  else if (url.pathname === '/rest/api/3/search/jql') body = { issues: [], isLast: true };
  else if (url.pathname === '/rest/api/3/field')
    body = [
      {
        id: 'customfield_101',
        name: 'Sprint',
        schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' },
      },
      { id: 'customfield_102', name: 'Story Points', schema: { type: 'number' } },
    ];
  else assert.fail(`Unexpected mocked request: ${url.origin}${url.pathname}`);
  return Response.json(status === 200 ? body : { message: 'Synthetic remote failure' }, { status });
}

export async function accept(fixture, store) {
  await store.initialize();
  await store.save({
    ...fixture.configuration,
    expectedRevision: store.getSetupStatus().revision,
    credentials: { githubToken, jiraToken },
  });
  assert.equal(store.getSetupStatus().ready, true);
}

export function assertNoSecrets(value, extra = []) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [
    githubToken,
    jiraToken,
    `Basic ${Buffer.from('qa@example.invalid:' + jiraToken).toString('base64')}`,
    ...extra,
  ]) {
    assert.equal(text.includes(secret), false, 'private authentication must not be published');
  }
}

export const errorCode = (code) => (error) => error?.code === code;
