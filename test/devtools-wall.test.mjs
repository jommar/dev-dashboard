import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldStream, tilePageTitle, tileState } from '../ui/devtools-wall.js';

test('a tile streams only while its browser runs and it can be seen', () => {
  const seen = { running: true, active: true, inView: true, documentVisible: true };
  assert.equal(shouldStream(seen), true);
  // Each condition on its own is enough to pause it.
  for (const lacking of ['running', 'active', 'inView', 'documentVisible'])
    assert.equal(shouldStream({ ...seen, [lacking]: false }), false, lacking);
  assert.equal(shouldStream({}), false);
  assert.equal(shouldStream({ ...seen, inView: undefined }), false);
  assert.equal(shouldStream({ ...seen, running: 'running' }), true, 'truthy is running');
});

test('a tile says one state, a stopped or paused one before anything the stream said', () => {
  const live = { running: true, streaming: true, status: 'live', reason: '' };
  assert.deepEqual(tileState(live), { key: 'live', text: 'Live' });
  assert.deepEqual(tileState({ ...live, running: false }), { key: 'stopped', text: 'Stopped' });
  assert.deepEqual(tileState({ ...live, streaming: false }), { key: 'paused', text: 'Paused' });
  assert.deepEqual(tileState({ ...live, running: false, streaming: false }), {
    key: 'stopped',
    text: 'Stopped',
  });
  assert.deepEqual(tileState({ ...live, status: 'connecting' }), {
    key: 'connecting',
    text: 'Connecting',
  });
  assert.deepEqual(tileState({ ...live, status: 'connecting', reason: 'reconnecting' }), {
    key: 'connecting',
    text: 'Reconnecting',
  });
  assert.deepEqual(tileState({ ...live, status: 'connecting', reason: 'switching' }), {
    key: 'connecting',
    text: 'Switching tab',
  });
  assert.deepEqual(tileState({ ...live, status: 'lost', reason: 'unreachable' }), {
    key: 'lost',
    text: 'Lost · Not reachable',
  });
  assert.deepEqual(tileState({ ...live, status: 'lost', reason: 'something-new' }), {
    key: 'lost',
    text: 'Lost · No signal',
  });
});

test('the page a tile names is the shown tab, else where the stream last navigated', () => {
  const tabs = {
    mode: 'auto',
    tabs: [
      { id: 'T1', title: 'Admin home', url: 'https://example.invalid/admin', current: false },
      { id: 'T2', title: 'Checkout', url: 'https://example.invalid/checkout', current: true },
    ],
  };
  const target = { id: 'T1', title: '', url: 'https://reports.example.invalid/q3' };
  assert.equal(tilePageTitle({ tabs, target }), 'Checkout');
  assert.equal(tilePageTitle({ tabs: null, target }), 'reports.example.invalid');
  assert.equal(tilePageTitle({ tabs: { tabs: [] }, target }), 'reports.example.invalid');
  assert.equal(tilePageTitle({ tabs: null, target: null }), '');
  assert.equal(tilePageTitle({}), '');
});
