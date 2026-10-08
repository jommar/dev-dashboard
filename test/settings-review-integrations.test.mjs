import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { settingsFixture, accept, jiraToken } from './settings-fixture.mjs';

for (const revision of [null, 1, 5]) {
  test(`migration ${revision === null ? 'initial' : 'recovery revision ' + revision} preserves effective JIRA_TOKEN when both aliases exist`, async (t) => {
    const f = settingsFixture(t, { realEnvLoader: true });
    f.write(
      f.paths.dashboardDir + '/.env',
      [
        'GH_TOKEN=synthetic-migration-gh',
        'JIRA_TOKEN=synthetic-effective-old-jira',
        'JIRA_API_TOKEN=synthetic-other-alias',
        'JIRA_EMAIL=qa@example.invalid',
        'JIRA_BASE_URL=https://jira.example.invalid',
      ].join('\n'),
    );
    if (revision !== null)
      f.write(
        f.paths.settings,
        JSON.stringify({
          schemaVersion: 1,
          revision,
          origin: 'legacy',
          ...f.configuration,
          validation: {},
        }),
      );
    const store = await f.store();
    await store.initialize();
    assert.equal(
      fs.readFileSync(f.paths.jiraToken, 'utf8') === 'synthetic-effective-old-jira',
      true,
      'use old effective alias; boolean diagnostics',
    );
    assert.equal(store.getSetupStatus().ready, revision !== 5);
    assert.equal(f.calls.length, 0);
    if (revision !== null) assert.deepEqual(store.getPublicSettings().jira, f.configuration.jira);
  });
}

test('trailing-slash saved Jira URL reaches all public Jira consumers as single-slash endpoint paths', async (t) => {
  const f = settingsFixture(t);
  const store = await f.store();
  await accept(f, store);
  await store.save({
    ...f.configuration,
    jira: { ...f.configuration.jira, baseUrl: 'https://jira.example.invalid/' },
    expectedRevision: store.getSetupStatus().revision,
  });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    requests.push(url);
    return Response.json({
      issues: [
        { key: 'DEMO-1', fields: { summary: 'Synthetic', status: { name: 'Promote to UAT' } } },
      ],
      isLast: true,
    });
  });
  const options = { snapshot: store.getSnapshot() };
  const jira = await import('../jira.mjs');
  const velocity = await import('../team-velocity.mjs');
  await jira.fetchMyTickets(options);
  await jira.fetchTicketStatuses(['DEMO-1'], options);
  await jira.fetchUatPromoteTickets(options);
  await velocity.fetchTeamIssues(options);
  assert.ok(requests.length >= 5);
  assert.ok(
    requests.every(
      ({ origin, pathname }) =>
        origin === 'https://jira.example.invalid' && pathname === '/rest/api/3/search/jql',
    ),
    'all consumers use one slash at base/path boundary',
  );
});

for (const service of ['github', 'jira']) {
  test(`symlinked ${service} credential ancestor cannot authorize or replace outside private path`, async (t) => {
    const f = settingsFixture(t);
    const outside = path.join(f.home, 'outside-synthetic');
    fs.mkdirSync(outside);
    f.write(path.join(outside, 'token'), 'synthetic-outside-token');
    const parent = path.dirname(f.paths[`${service}Token`]);
    fs.mkdirSync(path.dirname(parent), { recursive: true });
    fs.symlinkSync(outside, parent);
    const store = await f.store();
    await store.initialize();
    assert.equal(
      store.getPublicSettings().credentials[service].present,
      false,
      'unsafe ancestor not accepted as private credentials',
    );
    await assert.rejects(
      store.save({
        ...f.configuration,
        expectedRevision: store.getSetupStatus().revision,
        credentials: { githubToken: 'synthetic-replace-gh', jiraToken },
      }),
    );
    assert.equal(store.getSetupStatus().ready, false);
    assert.equal(
      fs.readFileSync(path.join(outside, 'token'), 'utf8') === 'synthetic-outside-token',
      true,
    );
    assert.equal(f.calls.length, 0, 'unsafe ancestors rejected before credentialed probes');
  });
}
