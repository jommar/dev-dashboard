// screencast-input.test.mjs — what a viewer may send to a debug browser, and nothing else.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInputEvent, virtualKeyCode } from '../backend/screencast-input.mjs';

const refused = (event, why) =>
  assert.throws(() => parseInputEvent(event), { code: 'INVALID_INPUT', status: 400 }, why);

test('a mouse press maps to Input.dispatchMouseEvent with defaults filled', () => {
  assert.deepEqual(parseInputEvent({ type: 'mousePressed', x: 12, y: 30.5 }), {
    method: 'Input.dispatchMouseEvent',
    params: {
      type: 'mousePressed',
      x: 12,
      y: 30.5,
      button: 'left',
      clickCount: 1,
      modifiers: 0,
    },
  });
  assert.deepEqual(
    parseInputEvent({
      type: 'mouseReleased',
      x: 1,
      y: 2,
      button: 'right',
      clickCount: 2,
      modifiers: 6,
      buttons: 2,
    }).params,
    {
      type: 'mouseReleased',
      x: 1,
      y: 2,
      button: 'right',
      clickCount: 2,
      modifiers: 6,
      buttons: 2,
    },
  );
});

test('a mouse move defaults to no button and no click', () => {
  const { params } = parseInputEvent({ type: 'mouseMoved', x: 5, y: 6 });
  assert.equal(params.button, 'none');
  assert.equal(params.clickCount, 0);
  assert.equal(
    parseInputEvent({ type: 'mouseMoved', x: 5, y: 6, button: 'left' }).params.button,
    'left',
  );
});

test('a wheel maps to a mouseWheel with deltas', () => {
  assert.deepEqual(parseInputEvent({ type: 'wheel', x: 100, y: 200, deltaY: -120 }), {
    method: 'Input.dispatchMouseEvent',
    params: { type: 'mouseWheel', x: 100, y: 200, deltaX: 0, deltaY: -120, modifiers: 0 },
  });
});

test('a typed key carries its text; a raw key does not', () => {
  assert.deepEqual(parseInputEvent({ type: 'keyDown', key: 'a', code: 'KeyA', text: 'a' }), {
    method: 'Input.dispatchKeyEvent',
    params: {
      type: 'keyDown',
      key: 'a',
      code: 'KeyA',
      modifiers: 0,
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      text: 'a',
      unmodifiedText: 'a',
    },
  });
  const raw = parseInputEvent({ type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft' }).params;
  assert.equal(raw.type, 'rawKeyDown');
  assert.equal(raw.windowsVirtualKeyCode, 37);
  assert.ok(!('text' in raw));
  const up = parseInputEvent({ type: 'keyUp', key: 'a', code: 'KeyA', text: 'a' }).params;
  assert.equal(up.type, 'keyUp');
  assert.ok(!('text' in up), 'a key-up never types');
  assert.equal(parseInputEvent({ type: 'char', key: 'é', text: 'é' }).params.type, 'char');
  assert.equal(
    parseInputEvent({ type: 'keyDown', key: 'Enter', text: '\r', windowsVirtualKeyCode: 13 }).params
      .windowsVirtualKeyCode,
    13,
  );
});

test('derives the virtual key code the client did not send', () => {
  assert.equal(virtualKeyCode('Backspace'), 8);
  assert.equal(virtualKeyCode('Enter'), 13);
  assert.equal(virtualKeyCode(' '), 32);
  assert.equal(virtualKeyCode('z'), 90);
  assert.equal(virtualKeyCode('Z'), 90);
  assert.equal(virtualKeyCode('7'), 55);
  assert.equal(virtualKeyCode('F1'), 112);
  assert.equal(virtualKeyCode('F12'), 123);
  assert.equal(virtualKeyCode('-'), 189);
  assert.equal(virtualKeyCode('Unidentified'), 0);
  assert.equal(virtualKeyCode('toString'), 0, 'inherited object keys are not key names');
  assert.equal(virtualKeyCode('constructor'), 0);
});

test('refuses anything that is not a known event shape', () => {
  for (const event of [undefined, null, 0, 'mouseMoved', [], {}, { type: 7 }])
    refused(event, String(event));
  refused(
    { type: 'Page.navigate', url: 'https://x.invalid' },
    'a CDP method name is not an event type',
  );
  refused({ type: 'mouseWheel', x: 1, y: 1 }, 'the raw CDP wheel type is not the client type');
  refused({ type: 'toString' }, 'an inherited name is not a type');
  refused({ type: '__proto__' }, 'nor is this');
});

test('refuses unknown fields rather than passing them along', () => {
  refused({ type: 'mouseMoved', x: 1, y: 1, method: 'Runtime.evaluate' }, 'mouse');
  refused({ type: 'wheel', x: 1, y: 1, expression: '1' }, 'wheel');
  refused({ type: 'keyDown', key: 'a', autoRepeat: true }, 'key');
});

test('refuses non-finite and out-of-range numbers', () => {
  for (const value of [Number.NaN, Infinity, -1, 20001, '5', null, true, {}])
    refused({ type: 'mouseMoved', x: value, y: 1 }, `x=${String(value)}`);
  refused({ type: 'mouseMoved', x: 1, y: 20001 }, 'y too large');
  refused({ type: 'mouseMoved', x: 1 }, 'y missing');
  refused({ type: 'mousePressed', x: 1, y: 1, clickCount: 4 }, 'clickCount');
  refused({ type: 'mousePressed', x: 1, y: 1, clickCount: 1.5 }, 'fractional clickCount');
  refused({ type: 'mousePressed', x: 1, y: 1, modifiers: 16 }, 'modifiers');
  refused({ type: 'mousePressed', x: 1, y: 1, modifiers: -1 }, 'modifiers');
  refused({ type: 'mousePressed', x: 1, y: 1, buttons: 32 }, 'buttons');
  refused({ type: 'wheel', x: 1, y: 1, deltaY: 20001 }, 'delta');
  refused({ type: 'wheel', x: 1, y: 1, deltaX: Number.NaN }, 'delta');
  refused({ type: 'keyDown', key: 'a', windowsVirtualKeyCode: 256 }, 'vk');
  refused({ type: 'keyDown', key: 'a', modifiers: 99 }, 'key modifiers');
});

test('refuses a bad button, and oversized or mistyped strings', () => {
  refused({ type: 'mousePressed', x: 1, y: 1, button: 'back' }, 'unknown button');
  refused({ type: 'mousePressed', x: 1, y: 1, button: 1 }, 'numeric button');
  refused({ type: 'keyDown' }, 'key required');
  refused({ type: 'keyDown', key: '' }, 'empty key');
  refused({ type: 'keyDown', key: 'x'.repeat(33) }, 'key length');
  refused({ type: 'keyDown', key: 'a', code: 'c'.repeat(33) }, 'code length');
  refused({ type: 'keyDown', key: 'a', text: 'abcdefghi' }, 'text length');
  refused({ type: 'keyDown', key: 'a', text: 5 }, 'text type');
  refused({ type: 'char', key: 'a' }, 'a char with no text');
  refused({ type: 'char', key: 'a', text: '' }, 'a char with empty text');
});
