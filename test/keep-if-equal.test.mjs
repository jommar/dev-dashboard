import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { keepIfEqual } from '../ui/keep-if-equal.js';

test('equal JSON keeps the previous reference, different JSON takes the next', () => {
  const previous = [{ id: 'be', lineCount: 3 }];
  const same = [{ id: 'be', lineCount: 3 }];
  const changed = [{ id: 'be', lineCount: 4 }];
  assert.equal(keepIfEqual(previous, same), previous);
  assert.equal(keepIfEqual(previous, changed), changed);
  assert.equal(keepIfEqual(null, same), same, 'the first answer replaces null');
});

test('a changed line count is never treated as equal, so live logs keep following', () => {
  const before = [{ id: 'be', status: 'running', lineCount: 10, lastLineAt: 1 }];
  const after = [{ id: 'be', status: 'running', lineCount: 11, lastLineAt: 2 }];
  assert.notEqual(keepIfEqual(before, after), before);
});

test('both hooks use the shared helper instead of a private copy', () => {
  const read = (file) =>
    fs.readFileSync(new URL(`../ui-react/hooks/${file}`, import.meta.url), 'utf8');
  for (const file of ['useClaudeTickets.js', 'useServiceEvents.js']) {
    const source = read(file);
    assert.match(source, /import \{ keepIfEqual \} from '\.\.\/\.\.\/ui\/keep-if-equal\.js'/, file);
    assert.doesNotMatch(source, /const keepIfEqual\b/, `${file} has no private copy`);
  }
});
