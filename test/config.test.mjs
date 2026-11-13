// config.test.mjs — `SECRET_ENV_NAMES`: the one list of credential variables the dashboard holds
// and never hands to a process it starts (a service, a launched Claude session).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const CREDENTIAL_NAMES = ['GH_TOKEN', 'GITHUB_TOKEN', 'JIRA_API_TOKEN', 'JIRA_TOKEN'];
const LISTED_NAME = /['"`](?:GH_TOKEN|GITHUB_TOKEN|JIRA_API_TOKEN|JIRA_TOKEN)['"`]/;

test('scenario 53: config.mjs exports SECRET_ENV_NAMES as exactly the four credential names', async () => {
  const { SECRET_ENV_NAMES } = await import('../backend/config.mjs');
  assert.ok(SECRET_ENV_NAMES, 'config.mjs exports SECRET_ENV_NAMES');
  assert.deepEqual([...SECRET_ENV_NAMES].sort(), [...CREDENTIAL_NAMES].sort());
});

test('scenario 18: withoutSecrets copies an environment without the credential names, and only those', async () => {
  const { withoutSecrets } = await import('../backend/config.mjs');
  assert.equal(typeof withoutSecrets, 'function', 'config.mjs exports withoutSecrets');
  const env = Object.fromEntries([
    ...CREDENTIAL_NAMES.map((name) => [name, `synthetic-${name}`]),
    ['PATH', '/usr/bin'],
    ['GH_TOKEN_NOT', 'kept'],
  ]);
  const snapshot = { ...env };

  const scrubbed = withoutSecrets(env);

  assert.deepEqual(scrubbed, { PATH: '/usr/bin', GH_TOKEN_NOT: 'kept' });
  assert.deepEqual(env, snapshot, 'the environment given is not changed');
  assert.notEqual(scrubbed, env, 'a copy');
});

// The three places that start a process take the environment from the one helper in config.mjs;
// none keeps a list of its own.
const IMPORTS_HELPER = /import\s*\{[^}]*\bwithoutSecrets\b[^}]*\}\s*from\s*['"]\.\/config\.mjs['"]/;

for (const backendFile of ['claude-sessions.mjs', 'manager.mjs', 'claude-chat.mjs']) {
  test(`scenario 18: ${backendFile} takes its environment from withoutSecrets in config.mjs and lists no credential itself`, () => {
    const source = fs.readFileSync(new URL(`../backend/${backendFile}`, import.meta.url), 'utf8');
    assert.ok(
      IMPORTS_HELPER.test(source),
      `${backendFile} imports withoutSecrets from ./config.mjs`,
    );
    assert.ok(!LISTED_NAME.test(source), `${backendFile} spells out no credential name`);
  });
}
