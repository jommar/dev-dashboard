import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { withSyntheticEnvRead } from '../e2e/node-boundaries.mjs';
import { settingsFixture, githubToken, jiraToken, assertNoSecrets } from './settings-fixture.mjs';

test('missing settings initialize once as fresh, partial or grandfathered legacy; existing records stay authoritative', async (t) => {
  for (const evidence of ['none', 'env-stat', 'partial', 'full', 'existing-token']) {
    const f = settingsFixture(t, {
      env:
        evidence === 'full' || evidence === 'existing-token'
          ? {
              GH_TOKEN: githubToken,
              GITHUB_TOKEN: 'lower-priority-synthetic-token',
              JIRA_TOKEN: jiraToken,
              JIRA_BASE_URL: 'https://jira.example.invalid',
              JIRA_EMAIL: 'qa@example.invalid',
              MIN_PR_APPROVER: '3',
              JIRA_SPRINT_FIELD: 'customfield_101',
              JIRA_POINTS_FIELD: 'customfield_102',
            }
          : evidence === 'partial'
            ? { GH_TOKEN: githubToken }
            : {},
    });
    if (evidence === 'env-stat') f.write(f.paths.dashboardDir + '/.env', '');
    if (evidence === 'existing-token')
      f.write(f.paths.githubToken, '  existing-synthetic-token\n', 0o644);
    const store = await f.store();
    await store.initialize();
    const status = store.getSetupStatus();
    assert.equal(status.ready, ['full', 'existing-token'].includes(evidence), evidence);
    assert.equal(status.origin, evidence === 'none' ? 'fresh' : 'legacy');
    assert.equal(f.calls.length, 0, 'migration never authenticates remotely');
    const persisted = fs.readFileSync(f.paths.settings, 'utf8');
    assert.equal(JSON.parse(persisted).schemaVersion, 1);
    if (status.ready) {
      assert.match(JSON.stringify(status.connection), /legacy-unverified/);
      assert.equal(store.getPublicSettings().minPrApprover, 3);
      assert.equal(store.getPublicSettings().jira.sprintField, 'customfield_101');
      assert.equal(
        fs.readFileSync(f.paths.githubToken, 'utf8').trim(),
        evidence === 'existing-token' ? 'existing-synthetic-token' : githubToken,
      );
      assert.equal(fs.statSync(f.paths.githubToken).mode & 0o777, 0o600);
    } else assert.ok(status.errors.length > 0);
    f.env.JIRA_BASE_URL = 'https://changed.example.invalid';
    f.env.GH_TOKEN = 'changed-synthetic-token';
    const restarted = await f.store();
    await restarted.initialize();
    assert.equal(fs.readFileSync(f.paths.settings, 'utf8'), persisted);
    assert.equal(restarted.getSetupStatus().ready, status.ready);
    assert.deepEqual(restarted.getPublicSettings().jira, store.getPublicSettings().jira);
  }
  for (const record of [
    '{malformed',
    '{"schemaVersion":999}',
    '{"schemaVersion":1,"revision":1,"github":{}}',
  ]) {
    const f = settingsFixture(t, { env: { GH_TOKEN: githubToken, JIRA_TOKEN: jiraToken } });
    f.write(f.paths.settings, record);
    const store = await f.store();
    await store.initialize();
    assert.equal(store.getSetupStatus().ready, false);
    assert.ok(store.getSetupStatus().errors.length > 0);
    assert.equal(fs.readFileSync(f.paths.settings, 'utf8'), record);
    assert.equal(f.calls.length, 0);
  }
  const broken = settingsFixture(t);
  const original = fs.writeFileSync;
  broken.dependencies.fs = {
    ...fs,
    promises: {
      ...fs.promises,
      async writeFile(file, ...args) {
        if (String(file).startsWith(broken.paths.settings))
          throw Object.assign(new Error('synthetic disk full'), { code: 'ENOSPC' });
        return fs.promises.writeFile(file, ...args);
      },
    },
    writeFileSync(file, ...args) {
      if (String(file).startsWith(broken.paths.settings))
        throw Object.assign(new Error('synthetic disk full'), { code: 'ENOSPC' });
      return original(file, ...args);
    },
  };
  const store = await broken.store();
  await store.initialize();
  assert.equal(store.getSetupStatus().ready, false);
  assert.equal(fs.existsSync(broken.paths.settings), false);
  broken.dependencies.fs = fs;
  await (await broken.store()).initialize();
  assert.equal(
    fs.existsSync(broken.paths.settings),
    true,
    'failed bootstrap can retry without a marker',
  );

  for (const exported of [false, true]) {
    const f = settingsFixture(t, {
      realEnvLoader: true,
      env: exported
        ? {
            GH_TOKEN: githubToken,
            JIRA_TOKEN: jiraToken,
            JIRA_EMAIL: 'exported@example.invalid',
            JIRA_BASE_URL: 'https://exported.example.invalid',
            MIN_PR_APPROVER: '4',
          }
        : {},
    });
    const text = [
      '# Synthetic migration fixture',
      'GH_TOKEN="synthetic-env-gh"',
      "GITHUB_TOKEN='synthetic-fallback-gh'",
      "JIRA_API_TOKEN='synthetic-env-jira'",
      'JIRA_TOKEN="synthetic-compatible-jira"',
      'JIRA_EMAIL="quoted@example.invalid"',
      "JIRA_BASE_URL='https://quoted.example.invalid/'",
      'JIRA_SPRINT_FIELD="customfield_101"',
      "JIRA_POINTS_FIELD='customfield_102'",
      'MIN_PR_APPROVER="3"',
    ].join('\n');
    const envFile = f.paths.dashboardDir + '/.env';
    f.write(envFile, text);
    assert.throws(
      () => fs.readFileSync(envFile, 'utf8'),
      /reads forbidden/,
      'only synthetic loader can read even fixture env',
    );
    const before = { ...process.env };
    const supplied = { ...f.env };
    const store = await f.store();
    await store.initialize();
    assert.equal(store.getSetupStatus().ready, true);
    assert.equal(
      store.getPublicSettings().jira.baseUrl,
      exported ? 'https://exported.example.invalid' : 'https://quoted.example.invalid',
    );
    assert.equal(
      store.getPublicSettings().jira.email,
      exported ? 'exported@example.invalid' : 'quoted@example.invalid',
    );
    assert.equal(store.getPublicSettings().minPrApprover, exported ? 4 : 3);
    assert.equal(store.getPublicSettings().jira.sprintField, 'customfield_101');
    assert.equal(store.getPublicSettings().jira.pointsField, 'customfield_102');
    assert.equal(
      fs.readFileSync(f.paths.githubToken, 'utf8'),
      exported ? githubToken : 'synthetic-env-gh',
    );
    assert.equal(
      fs.readFileSync(f.paths.jiraToken, 'utf8'),
      exported ? jiraToken : 'synthetic-compatible-jira',
    );
    for (const file of [f.paths.githubToken, f.paths.jiraToken])
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(
      isDeepStrictEqual({ ...process.env }, before),
      true,
      'loader never exports secrets',
    );
    assert.equal(
      isDeepStrictEqual(f.env, supplied),
      true,
      'loader never mutates supplied environment',
    );
    assertNoSecrets(fs.readFileSync(f.paths.settings, 'utf8'), [
      'synthetic-env-gh',
      'synthetic-env-jira',
      'synthetic-compatible-jira',
    ]);
    assertNoSecrets(store.getPublicSettings(), [
      'synthetic-env-gh',
      'synthetic-env-jira',
      'synthetic-compatible-jira',
    ]);
    assert.equal(f.calls.length, 0);
    f.write(
      envFile,
      'GH_TOKEN=changed-synthetic-gh\nJIRA_API_TOKEN=changed-synthetic-jira\nJIRA_EMAIL=changed@example.invalid',
    );
    const record = fs.readFileSync(f.paths.settings, 'utf8');
    const restart = await f.store();
    await restart.initialize();
    assert.equal(fs.readFileSync(f.paths.settings, 'utf8'), record);
    assert.equal(
      fs.readFileSync(f.paths.jiraToken, 'utf8'),
      exported ? jiraToken : 'synthetic-compatible-jira',
    );
    assert.throws(
      () => fs.readFileSync(envFile),
      /reads forbidden/,
      'loader exemption closes after invocation',
    );
  }
  for (const revision of [1, 5]) {
    const recoveryCases = ['github', 'jira'].flatMap((tokenName) =>
      ['absent', 'nonblank', 'empty', 'unreadable'].map((existing) => ({ tokenName, existing })),
    );
    for (const { tokenName, existing } of recoveryCases) {
      const f = settingsFixture(t, { realEnvLoader: true });
      const saved = {
        schemaVersion: 1,
        revision,
        origin: 'legacy',
        ...f.configuration,
        validation: {},
      };
      f.write(f.paths.settings, JSON.stringify(saved));
      f.write(
        f.paths.dashboardDir + '/.env',
        [
          'GH_TOKEN="synthetic-recovered-gh"',
          "JIRA_API_TOKEN='synthetic-recovered-jira'",
          'JIRA_BASE_URL=https://must-not-reseed.example.invalid',
          'JIRA_EMAIL=must-not-reseed@example.invalid',
          'JIRA_SPRINT_FIELD=customfield_999',
          'MIN_PR_APPROVER=9',
        ].join('\n'),
      );
      const tokenPath = f.paths[`${tokenName}Token`];
      if (existing !== 'absent')
        f.write(tokenPath, existing === 'empty' ? '' : 'existing-synthetic-token');
      if (existing === 'unreadable') {
        f.dependencies.fs = {
          ...fs,
          readFileSync(file, ...args) {
            if (String(file) === tokenPath)
              throw Object.assign(new Error('Synthetic unreadable file'), { code: 'EACCES' });
            return fs.readFileSync(file, ...args);
          },
        };
      }
      const store = await f.store();
      await store.initialize();
      assert.equal(
        store.getSetupStatus().ready,
        revision === 1 && ['absent', 'nonblank'].includes(existing),
      );
      assert.equal(store.getSetupStatus().revision, revision);
      const current = store.getPublicSettings();
      for (const field of ['github', 'jira', 'local', 'minPrApprover'])
        assert.deepEqual(
          current[field],
          f.configuration[field],
          'saved editable fields remain authoritative',
        );
      for (const [name, recovered] of [
        ['github', 'synthetic-recovered-gh'],
        ['jira', 'synthetic-recovered-jira'],
      ]) {
        assert.equal(
          fs.readFileSync(f.paths[`${name}Token`], 'utf8'),
          name !== tokenName || existing === 'absent'
            ? recovered
            : existing === 'empty'
              ? ''
              : 'existing-synthetic-token',
        );
      }
      for (const file of [f.paths.githubToken, f.paths.jiraToken])
        assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(f.calls.length, 0, 'recovery never remotely probes');
      if (revision > 1)
        assert.ok(
          store.getSetupStatus().errors.some(({ code }) => code === 'VALIDATION_REQUIRED'),
          'edited recovery cannot grandfather',
        );
      assertNoSecrets(fs.readFileSync(f.paths.settings, 'utf8'), [
        'synthetic-recovered-gh',
        'synthetic-recovered-jira',
        'existing-synthetic-token',
      ]);
      const persisted = fs.readFileSync(f.paths.settings, 'utf8');
      const restart = await f.store();
      await restart.initialize();
      assert.equal(fs.readFileSync(f.paths.settings, 'utf8'), persisted);
      assert.equal(restart.getSetupStatus().ready, store.getSetupStatus().ready);
    }
  }
  const boundary = settingsFixture(t, { realEnvLoader: true });
  const boundaryFile = path.join(boundary.paths.dashboardDir, '.env');
  boundary.write(boundaryFile, 'JIRA_API_TOKEN=synthetic-boundary-token');
  await boundary.store();
  const loaderUrl = pathToFileURL(path.join(boundary.paths.dashboardDir, 'env.mjs'));
  assert.throws(
    () =>
      withSyntheticEnvRead(
        new URL('../env.mjs', import.meta.url),
        boundary.paths.dashboardDir,
        () => {},
      ),
    /synthetic loader location/,
  );
  const loader = await import(loaderUrl);
  const guarded = {
    ...fs,
    readFileSync(file, ...args) {
      assert.throws(() => fs.readFileSync(new URL('../.env', import.meta.url)), /reads forbidden/);
      return fs.readFileSync(file, ...args);
    },
  };
  assert.equal(
    loader.loadEnvFile({ directory: boundary.paths.dashboardDir, env: {}, fs: guarded })
      .JIRA_API_TOKEN,
    'synthetic-boundary-token',
  );
  assert.throws(() => fs.readFileSync(boundaryFile), /reads forbidden/);
  fs.rmSync(boundaryFile);
  fs.symlinkSync(path.join(boundary.home, 'missing-synthetic-env'), boundaryFile);
  assert.throws(
    () => loader.loadEnvFile({ directory: boundary.paths.dashboardDir, env: {} }),
    /synthetic loader location/,
  );
});
