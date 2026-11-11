import test from 'node:test';
import assert from 'node:assert/strict';
import { jiraStatusKind } from '../ui/jira-status.js';

test('the pure Jira classifier preserves coercion and color bands', () => {
  for (const [status, kind] of [
    ['To Do', 'queued'],
    ['  SELECTED FOR DEVELOPMENT\t', 'queued'],
    ['In Progress', 'active'],
    ['Ready For Code Review', 'active'],
    ['Hardening in UAT', 'done'],
    [' resolved ', 'done'],
    ['CS Escalation', 'attention'],
    ['\tBLOCKED\n', 'attention'],
    ['Code Review', 'unknown'],
    ['A new workflow gate', 'unknown'],
    ['', 'unknown'],
    [null, 'unknown'],
    [undefined, 'unknown'],
    [42, 'unknown'],
    [false, 'unknown'],
    [{ toString: () => '  Testing  ' }, 'active'],
    ['constructor', Object],
  ]) {
    assert.equal(jiraStatusKind(status), kind, String(status));
  }
});
