import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ESLint } from 'eslint';

const cwd = new URL('..', import.meta.url).pathname;
const severities = async (code, filePath) => {
  const [result] = await new ESLint({ cwd }).lintText(code, { filePath });
  return Object.fromEntries(result.messages.map((message) => [message.ruleId, message.severity]));
};

test('rules-of-hooks is an error in ui-react', async () => {
  const code = `import { useState } from 'react';
export function Broken({ on }) {
  if (on) useState(0);
  return <p />;
}
`;
  const found = await severities(code, `${cwd}ui-react/x.jsx`);
  assert.equal(found['react-hooks/rules-of-hooks'], 2);
});

test('exhaustive-deps is a warning in ui-react', async () => {
  const code = `import { useEffect } from 'react';
export function Loose({ id }) {
  useEffect(() => {
    document.title = id;
  }, []);
  return <p />;
}
`;
  const found = await severities(code, `${cwd}ui-react/x.jsx`);
  assert.equal(found['react-hooks/exhaustive-deps'], 1);
});

test('the hooks rules do not reach the backend', async () => {
  const code = `export function load(on) {
  if (on) useThing();
}
`;
  const found = await severities(code, `${cwd}backend/x.mjs`);
  assert.equal(found['react-hooks/rules-of-hooks'], undefined);
});

test('lint script fails on warnings', () => {
  const scripts = JSON.parse(readFileSync(`${cwd}package.json`, 'utf8')).scripts;
  assert.match(scripts.lint, /--max-warnings 0/);
});
