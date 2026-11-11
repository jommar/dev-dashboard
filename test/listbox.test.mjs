// listbox.test.mjs — keyboard movement and event-target helpers for the
// reusable dropdown, pinned here rather than eyeballed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { listboxMove, isListboxEventTarget } from '../ui/components/listbox.js';

test('listboxMove walks, wraps and jumps', () => {
  const values = ['a', 'b', 'c'];
  assert.equal(listboxMove(values, 'a', 'ArrowDown'), 'b');
  assert.equal(listboxMove(values, 'c', 'ArrowDown'), 'a');
  assert.equal(listboxMove(values, 'a', 'ArrowUp'), 'c');
  assert.equal(listboxMove(values, 'b', 'Home'), 'a');
  assert.equal(listboxMove(values, 'b', 'End'), 'c');
  assert.equal(listboxMove(values, 'b', 'Enter'), 'b');
  assert.equal(listboxMove([], 'a', 'ArrowDown'), 'a');
});

test('isListboxEventTarget spots listbox-internal clicks, even detached ones', () => {
  // Regression: the toggle re-render detaches e.target mid-propagation, so an
  // outside-click closer using contains() alone closes the list on the same
  // click that opened it. closest() survives detachment via the subtree's own
  // parent chain, so gate on it instead. Stubs stand in for DOM nodes here.
  const inside = { closest: (sel) => (sel === '[data-listbox]' ? {} : null) };
  const outside = { closest: () => null };
  assert.equal(isListboxEventTarget(inside), true);
  assert.equal(isListboxEventTarget(outside), false);
  assert.equal(isListboxEventTarget(null), false);
  assert.equal(isListboxEventTarget(undefined), false);
  assert.equal(isListboxEventTarget({}), false);
});
