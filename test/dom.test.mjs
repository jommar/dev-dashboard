import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as dom from '../ui/dom.js';

// `copyText(text)` is the one place that writes to the clipboard. It resolves true once the write
// has finished and false when it could not be made: it never rejects, so a caller only decides what
// to say. It reads `navigator.clipboard` each time it is called (a page can lose or swap it).
// Only `navigator` is stubbed: none of its callers uses a textarea or `execCommand` fallback.

const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

function stubNavigator(t, value) {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value });
  t.after(() => {
    if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator);
    else delete globalThis.navigator;
  });
}

test('scenario 45: copyText writes the exact text once and resolves true', async (t) => {
  const writes = [];
  stubNavigator(t, {
    clipboard: {
      async writeText(text) {
        writes.push(text);
      },
    },
  });
  const text = 'cd ~/pathwise && claude --resume 00000000-0000-4000-8000-000000000000\nline two ✓';
  assert.equal(await dom.copyText(text), true);
  assert.deepEqual(writes, [text]);
});

test('scenario 45: copyText resolves true only after the write has finished', async (t) => {
  let finish;
  stubNavigator(t, {
    clipboard: { writeText: () => new Promise((resolve) => (finish = resolve)) },
  });
  let settled = false;
  const result = dom.copyText('slow').then((value) => {
    settled = true;
    return value;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  finish();
  assert.equal(await result, true);
});

test('scenario 45: copyText resolves false when there is no clipboard to write to', async (t) => {
  for (const missing of [{}, { clipboard: undefined }, { clipboard: {} }]) {
    stubNavigator(t, missing);
    assert.equal(await dom.copyText('anything'), false);
  }
});

test('scenario 45: copyText resolves false, and does not reject, when the write is refused', async (t) => {
  const refusals = [
    () => Promise.reject(new Error('Permission denied')),
    () => {
      throw new Error('NotAllowedError');
    },
  ];
  for (const writeText of refusals) {
    stubNavigator(t, { clipboard: { writeText } });
    assert.equal(await dom.copyText('anything'), false);
  }
});

test('scenario 45: copyText looks the clipboard up on every call', async (t) => {
  const first = [];
  const second = [];
  stubNavigator(t, { clipboard: { writeText: async (text) => first.push(text) } });
  assert.equal(await dom.copyText('one'), true);
  stubNavigator(t, { clipboard: { writeText: async (text) => second.push(text) } });
  assert.equal(await dom.copyText('two'), true);
  stubNavigator(t, {});
  assert.equal(await dom.copyText('three'), false);
  assert.deepEqual([first, second], [['one'], ['two']]);
});
