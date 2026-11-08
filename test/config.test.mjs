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

// The two consumers read the shared list; neither keeps a list of its own.
const IMPORTS_LIST = /import\s*\{[^}]*\bSECRET_ENV_NAMES\b[^}]*\}\s*from\s*['"]\.\/config\.mjs['"]/;

for (const backendFile of ['claude-sessions.mjs', 'manager.mjs']) {
  test(`scenario 54: ${backendFile} takes the credential names from config.mjs and lists none itself`, () => {
    const source = fs.readFileSync(new URL(`../backend/${backendFile}`, import.meta.url), 'utf8');
    assert.ok(
      IMPORTS_LIST.test(source),
      `${backendFile} imports SECRET_ENV_NAMES from ./config.mjs`,
    );
    assert.ok(!LISTED_NAME.test(source), `${backendFile} spells out no credential name`);
  });
}
