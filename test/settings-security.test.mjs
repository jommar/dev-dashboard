import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { settingsFixture, accept, assertNoSecrets, errorCode } from './settings-fixture.mjs';

test('credentials stay private and restrictive; serialized durable saves and restart cannot accept partial identities', async (t) => {
  const f = settingsFixture(t);
  const store = await f.store();
  const environment = { ...process.env };
  const logs = [];
  t.mock.method(console, 'log', (...args) => logs.push(args));
  t.mock.method(console, 'error', (...args) => logs.push(args));
  await accept(f, store);
  for (const file of [f.paths.githubToken, f.paths.jiraToken])
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assertNoSecrets(fs.readFileSync(f.paths.settings, 'utf8'));
  assertNoSecrets(store.getPublicSettings());
  assertNoSecrets(store.getSetupStatus());
  assert.equal(
    isDeepStrictEqual({ ...process.env }, environment),
    true,
    'process environment must remain unchanged',
  );
  const retained = fs.readFileSync(f.paths.githubToken, 'utf8');
  await store.save({
    ...f.configuration,
    expectedRevision: store.getSetupStatus().revision,
    credentials: { githubToken: ' ', jiraToken: '' },
  });
  assert.equal(fs.readFileSync(f.paths.githubToken, 'utf8'), retained);
  const revision = store.getSetupStatus().revision;
  const results = await Promise.allSettled(
    [2, 3].map((minPrApprover) =>
      store.save({ ...f.configuration, minPrApprover, expectedRevision: revision }),
    ),
  );
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(
    results.find(({ status }) => status === 'rejected').reason.code,
    'REVISION_CONFLICT',
  );
  await assert.rejects(
    store.save({ ...f.configuration, expectedRevision: revision }),
    errorCode('REVISION_CONFLICT'),
  );
  for (const failureTarget of ['github', 'jira', 'settings']) {
    const broken = settingsFixture(t);
    const initial = await broken.store();
    await accept(broken, initial);
    const previous = new Map(
      [broken.paths.githubToken, broken.paths.jiraToken, broken.paths.settings].map((file) => [
        file,
        fs.readFileSync(file, 'utf8'),
      ]),
    );
    const rename = fs.renameSync;
    const renameAsync = fs.promises.rename;
    let injected = false;
    const target =
      failureTarget === 'settings'
        ? broken.paths.settings
        : failureTarget === 'github'
          ? broken.paths.githubToken
          : broken.paths.jiraToken;
    const shouldFail = (dest) => !injected && String(dest) === target;
    broken.dependencies.fs = {
      ...fs,
      renameSync(from, to) {
        if (shouldFail(to)) {
          injected = true;
          throw Object.assign(new Error('synthetic failed commit'), { code: 'EIO' });
        }
        return rename(from, to);
      },
      promises: {
        ...fs.promises,
        async rename(from, to) {
          if (shouldFail(to)) {
            injected = true;
            throw Object.assign(new Error('synthetic failed commit'), { code: 'EIO' });
          }
          return renameAsync(from, to);
        },
      },
    };
    const faulty = await broken.store();
    await faulty.initialize();
    await assert.rejects(
      faulty.save({
        ...broken.configuration,
        expectedRevision: faulty.getSetupStatus().revision,
        credentials: {
          githubToken: 'synthetic-replacement-gh',
          jiraToken: 'synthetic-replacement-jira',
        },
      }),
    );
    assert.equal(injected, true, 'fault exercised at real persistence boundary');
    assertNoSecrets(faulty.getPublicSettings(), [
      'synthetic-replacement-gh',
      'synthetic-replacement-jira',
    ]);
    broken.dependencies.fs = fs;
    const restart = await broken.store();
    await restart.initialize();
    if (restart.getSetupStatus().ready) {
      for (const [file, content] of previous)
        assert.equal(
          fs.readFileSync(file, 'utf8'),
          content,
          'ready implies fully restored old revision',
        );
    } else assert.ok(restart.getSetupStatus().errors.length > 0);
  }
  f.write(f.paths.githubToken, 'externally-replaced-synthetic-token');
  const changed = await f.store();
  await changed.initialize();
  assert.equal(
    changed.getSetupStatus().ready,
    false,
    'external token changes cannot inherit acceptance',
  );
  const unsafe = settingsFixture(t);
  unsafe.write(unsafe.home + '/linked-token', 'synthetic-linked-token');
  fs.mkdirSync(path.dirname(unsafe.paths.githubToken), { recursive: true });
  fs.symlinkSync(unsafe.home + '/linked-token', unsafe.paths.githubToken);
  const unsafeStore = await unsafe.store();
  await unsafeStore.initialize();
  assert.equal(unsafeStore.getSetupStatus().ready, false);
  await assert.rejects(
    unsafeStore.save({
      ...unsafe.configuration,
      expectedRevision: unsafeStore.getSetupStatus().revision,
      credentials: { githubToken: 'synthetic-new-token', jiraToken: 'synthetic-new-jira' },
    }),
  );
  assert.equal(fs.readFileSync(unsafe.home + '/linked-token', 'utf8'), 'synthetic-linked-token');
  const remoteError = settingsFixture(t);
  remoteError.network.route = async () => {
    throw new Error('synthetic-secret-in-upstream-message');
  };
  const rejected = await remoteError.store();
  await rejected.initialize();
  let captured;
  try {
    await rejected.save({
      ...remoteError.configuration,
      expectedRevision: rejected.getSetupStatus().revision,
      credentials: {
        githubToken: 'synthetic-secret-in-upstream-message',
        jiraToken: 'synthetic-private-error-jira',
      },
    });
    assert.fail('remote validation must reject');
  } catch (error) {
    captured = error;
  }
  assertNoSecrets(String(captured), [
    'synthetic-secret-in-upstream-message',
    'synthetic-private-error-jira',
  ]);
  assertNoSecrets(rejected.getPublicSettings(), [
    'synthetic-secret-in-upstream-message',
    'synthetic-private-error-jira',
  ]);
  assert.equal(
    fs.existsSync(remoteError.paths.githubToken),
    false,
    'rejected candidate never commits replacement secrets',
  );
  assert.equal(fs.existsSync(remoteError.paths.jiraToken), false);
  assertNoSecrets(logs, ['synthetic-replacement-gh', 'synthetic-replacement-jira']);
  assert.equal(
    isDeepStrictEqual({ ...process.env }, environment),
    true,
    'process environment must remain unchanged',
  );
});
