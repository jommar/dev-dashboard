// upstream-sources.test.mjs — source guards for the integration-health layer: every Jira and GitHub
// request goes through the one wrapper, and the UI hook that reads health owns no timer.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (relative) =>
  fs.readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');

// Code only: comments carry prose that may name the calls.
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('no bare fetch in the Jira and GitHub modules: every request goes through upstreamFetch', () => {
  for (const file of [
    'jira.mjs',
    'github.mjs',
    'github-api.mjs',
    'team-velocity.mjs',
    'releases.mjs',
  ]) {
    const source = code(read(`backend/${file}`));
    assert.doesNotMatch(source, /(?<![\w.])fetch\(/, `${file} calls fetch( directly`);
    assert.match(source, /upstreamFetch\(/, `${file} uses upstreamFetch`);
  }
});

test('useUpstreamHealth owns no timer and /api/health appears once in api.js', () => {
  const hook = read('ui-react/hooks/useUpstreamHealth.js');
  for (const word of ['setInterval', 'setTimeout', 'useActivePolling'])
    assert.ok(!hook.includes(word), `the hook mentions ${word}`);
  assert.equal(read('ui-react/lib/api.js').split('/api/health').length - 1, 1);
});

test('UpstreamNote words its notes once per health answer, not on every one-second re-render', () => {
  const source = code(read('ui-react/components/UpstreamNote.jsx'));
  assert.match(source, /useMemo\(/);
  assert.match(source, /\[health,/);
});

test('each board mounts UpstreamNote for its integrations, refreshed with its own load', () => {
  const mounts = {
    'MyTicketsPanel.jsx': "['jira', 'github', 'slack']",
    'PrsPanel.jsx': "['github', 'jira']",
    'SlackPanel.jsx': "['slack']",
  };
  for (const [file, names] of Object.entries(mounts)) {
    const source = code(read(`ui-react/panels/${file}`));
    assert.match(
      source,
      /import \{ UpstreamNote \} from '\.\.\/components\/UpstreamNote\.jsx'/,
      file,
    );
    assert.ok(source.includes(`integrations={${names}}`), `${file} names its integrations`);
    assert.match(source, /<UpstreamNote[^>]*refreshKey=\{countdown\.lastLoadedAt\}/s, file);
  }
});
