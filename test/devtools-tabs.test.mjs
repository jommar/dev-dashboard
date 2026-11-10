// devtools-tabs.test.mjs — what a tab in the viewer's strip is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tabLabel } from '../ui/devtools-tabs.js';

test('a tab is named by its title, else its site, else its address, else a placeholder', () => {
  assert.equal(tabLabel({ title: ' Admin home ', url: 'https://example.invalid/a' }), 'Admin home');
  assert.equal(
    tabLabel({ title: '', url: 'https://reports.example.invalid/q3?x=1' }),
    'reports.example.invalid',
  );
  assert.equal(tabLabel({ title: '', url: 'about:blank' }), 'about:blank');
  assert.equal(tabLabel({ title: '', url: 'not an address' }), 'not an address');
  assert.equal(tabLabel({ title: '', url: '' }), 'New tab');
  assert.equal(tabLabel(undefined), 'New tab');
});
