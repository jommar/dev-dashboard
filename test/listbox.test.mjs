// listbox.test.mjs — the reusable dropdown is the only way to color an open
// option list (native <select> styling is OS-controlled), so its markup
// contract and keyboard movement are pinned here rather than eyeballed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { listboxHtml, listboxMove, isListboxEventTarget } from '../ui/components/listbox.js';

const options = [
  { value: 'a', label: 'Alpha', state: 'active' },
  { value: 'b', label: 'Beta', state: 'closed' },
  { value: 'c', label: 'Gamma' },
];

test('closed listbox renders a button carrying the selection and its state', () => {
  const html = listboxHtml({ id: 'lb', testId: 'lb', label: 'Pick', options, selectedValue: 'b' });
  assert.match(html, /<button[^>]*id="lb"/);
  assert.match(html, /role="combobox"/);
  assert.match(html, /aria-haspopup="listbox"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /data-state="closed"/);
  assert.match(html, /Beta/);
  assert.doesNotMatch(html, /role="option"/);
  assert.doesNotMatch(html, /role="listbox"/);
  assert.doesNotMatch(html, /aria-controls=/);
});

test('open listbox marks the selection and exposes per-option states', () => {
  const html = listboxHtml({ id: 'lb', testId: 'lb', options, selectedValue: 'b', open: true });
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /role="listbox"[^>]*tabindex="-1"/);
  assert.match(html, /aria-activedescendant="lb-opt-b"/);
  assert.match(html, /data-value="b"[^>]*aria-selected="true"/);
  assert.match(html, /data-value="a"[^>]*aria-selected="false"/);
  assert.match(html, /data-state="active"/);
  // The highlight hook is separate from the state hook.
  assert.match(html, /data-value="b"[^>]*data-active="true"/);
});

test('unlabelled listbox labels the popup from its button', () => {
  const html = listboxHtml({ id: 'lb', testId: 'lb', options, selectedValue: 'a', open: true });
  assert.match(html, /role="listbox"[^>]*aria-labelledby="lb"/);
  assert.doesNotMatch(html, /lb-label/);
});

test('listbox escapes labels and values', () => {
  const html = listboxHtml({
    id: 'lb',
    testId: 'lb',
    options: [{ value: 'x"y', label: '<b>&', state: 'a"b' }],
    selectedValue: 'x"y',
    open: true,
  });
  assert.doesNotMatch(html, /<b>/);
  assert.match(html, /&lt;b&gt;&amp;/);
  assert.match(html, /data-value="x&quot;y"/);
});

test('listbox falls back to the first option when nothing is selected', () => {
  const html = listboxHtml({ id: 'lb', testId: 'lb', options, selectedValue: null, open: true });
  assert.match(html, /data-value="a"[^>]*aria-selected="true"/);
});

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
