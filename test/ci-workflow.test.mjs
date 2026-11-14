import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const workflow = read('.github/workflows/ci.yml');
const scripts = JSON.parse(read('package.json')).scripts;

// The text of one job: from its `  <name>:` line to the next job or the end of the file.
const job = (name) => {
  const match = workflow.match(
    new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [\\w-]+:\\n|(?![\\s\\S]))`, 'm'),
  );
  assert.ok(match, `job ${name} is in the workflow`);
  return match[1];
};

// The `run:` commands of a job, in file order.
const commands = (text) => [...text.matchAll(/^\s+run: (.+)$/gm)].map((match) => match[1].trim());

test('check script chains lint, format:check and test in that order', () => {
  assert.equal(scripts.check, 'npm run lint && npm run format:check && npm test');
  for (const name of ['lint', 'format:check', 'test']) assert.ok(scripts[name], `script ${name}`);
});

test('gate job steps run in order', () => {
  assert.match(workflow, /^on:\n {2}push:\n {4}branches: \[master\]\n {2}pull_request:/m);
  const check = job('check');
  assert.match(check, /node-version-file: \.nvmrc/);
  assert.match(check, /cache: npm/);
  assert.deepEqual(commands(check), [
    'npm ci',
    'npm run lint',
    'npm run format:check',
    'npm test',
    'npm run build',
    'npm audit --omit=dev --audit-level=high',
  ]);
  for (const command of commands(check)) {
    const name = command.match(/^npm run ([\w:-]+)$/)?.[1];
    if (name) assert.ok(scripts[name], `the workflow runs script ${name}`);
  }
});

test('e2e job is separate and non-blocking', () => {
  const e2e = job('e2e');
  assert.match(e2e, /^\s+continue-on-error: true$/m);
  assert.doesNotMatch(e2e, /^\s+needs:/m);
  assert.ok(commands(e2e).includes('npx playwright install --with-deps chromium'));
  assert.ok(commands(e2e).includes('npm run test:ui'));
  assert.ok(scripts['test:ui']);
  assert.doesNotMatch(job('check'), /test:ui/);
});

test('permissions and concurrency are set', () => {
  assert.match(workflow, /^permissions:\n {2}contents: read$/m);
  assert.match(workflow, /^concurrency:\n {2}group: .+\n {2}cancel-in-progress: true$/m);
  assert.doesNotMatch(workflow, /secrets\./);
});
