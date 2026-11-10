// screencast-input.mjs — the only input a viewer may send to a debug browser.
//
// The dashboard never relays a CDP method the client names. A request carries one flat event
// whose `type` selects a fixed shape, every field is checked and bounded, and anything else is
// refused. What comes out is the one CDP command and params object that shape maps to.

import { fail } from './browser-devtools.mjs';

const MAX_COORDINATE = 20000;
const MAX_DELTA = 20000;
const MAX_MODIFIERS = 15; // Alt 1, Ctrl 2, Meta 4, Shift 8
const MAX_BUTTONS = 31;
const MAX_KEY_LENGTH = 32;
const MAX_TEXT_LENGTH = 8;

const MOUSE_TYPES = new Set(['mousePressed', 'mouseReleased', 'mouseMoved']);
const KEY_TYPES = new Set(['keyDown', 'keyUp', 'char']);
const BUTTONS = new Set(['none', 'left', 'middle', 'right']);

const MOUSE_FIELDS = ['type', 'x', 'y', 'button', 'buttons', 'clickCount', 'modifiers'];
const WHEEL_FIELDS = ['type', 'x', 'y', 'deltaX', 'deltaY', 'modifiers'];
const KEY_FIELDS = ['type', 'key', 'code', 'text', 'modifiers', 'windowsVirtualKeyCode'];

const NAMED_KEYS = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Pause: 19,
  CapsLock: 20,
  Escape: 27,
  ' ': 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Insert: 45,
  Delete: 46,
  Meta: 91,
  ContextMenu: 93,
};
const PUNCTUATION = {
  ';': 186,
  '=': 187,
  ',': 188,
  '-': 189,
  '.': 190,
  '/': 191,
  '`': 192,
  '[': 219,
  '\\': 220,
  ']': 221,
  "'": 222,
};

function invalid(message) {
  return fail('INVALID_INPUT', message, 400);
}

function bounded(value, name, { min, max, integer = false, fallback }) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw invalid(`${name} is out of range.`);
  if (integer && !Number.isInteger(value)) throw invalid(`${name} must be a whole number.`);
  return value;
}

function string(value, name, { max, min = 0, fallback }) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || value.length < min || value.length > max)
    throw invalid(`${name} is not a valid string.`);
  return value;
}

function onlyFields(event, allowed) {
  for (const field of Object.keys(event))
    if (!allowed.includes(field)) throw invalid(`${field} is not accepted.`);
}

// The legacy virtual-key code Chromium wants alongside `key`, when the client did not send one.
export function virtualKeyCode(key) {
  if (Object.hasOwn(NAMED_KEYS, key)) return NAMED_KEYS[key];
  if (/^F([1-9]|1[0-2])$/.test(key)) return 111 + Number(key.slice(1));
  if (key.length === 1) {
    if (/[a-z]/i.test(key)) return key.toUpperCase().charCodeAt(0);
    if (/\d/.test(key)) return key.charCodeAt(0);
    if (Object.hasOwn(PUNCTUATION, key)) return PUNCTUATION[key];
  }
  return 0;
}

function mouse(event) {
  onlyFields(event, MOUSE_FIELDS);
  const moved = event.type === 'mouseMoved';
  const button = string(event.button, 'button', { max: 6, fallback: moved ? 'none' : 'left' });
  if (!BUTTONS.has(button)) throw invalid('button is not accepted.');
  const params = {
    type: event.type,
    x: bounded(event.x, 'x', { min: 0, max: MAX_COORDINATE }),
    y: bounded(event.y, 'y', { min: 0, max: MAX_COORDINATE }),
    button,
    clickCount: bounded(event.clickCount, 'clickCount', {
      min: 0,
      max: 3,
      integer: true,
      fallback: moved ? 0 : 1,
    }),
    modifiers: bounded(event.modifiers, 'modifiers', {
      min: 0,
      max: MAX_MODIFIERS,
      integer: true,
      fallback: 0,
    }),
  };
  if (event.buttons !== undefined)
    params.buttons = bounded(event.buttons, 'buttons', {
      min: 0,
      max: MAX_BUTTONS,
      integer: true,
    });
  return { method: 'Input.dispatchMouseEvent', params };
}

function wheel(event) {
  onlyFields(event, WHEEL_FIELDS);
  return {
    method: 'Input.dispatchMouseEvent',
    params: {
      type: 'mouseWheel',
      x: bounded(event.x, 'x', { min: 0, max: MAX_COORDINATE }),
      y: bounded(event.y, 'y', { min: 0, max: MAX_COORDINATE }),
      deltaX: bounded(event.deltaX, 'deltaX', { min: -MAX_DELTA, max: MAX_DELTA, fallback: 0 }),
      deltaY: bounded(event.deltaY, 'deltaY', { min: -MAX_DELTA, max: MAX_DELTA, fallback: 0 }),
      modifiers: bounded(event.modifiers, 'modifiers', {
        min: 0,
        max: MAX_MODIFIERS,
        integer: true,
        fallback: 0,
      }),
    },
  };
}

function key(event) {
  onlyFields(event, KEY_FIELDS);
  const name = string(event.key, 'key', { min: 1, max: MAX_KEY_LENGTH });
  const text = string(event.text, 'text', { max: MAX_TEXT_LENGTH, fallback: '' });
  if (event.type === 'char' && !text) throw invalid('A char event needs text.');
  const code = bounded(event.windowsVirtualKeyCode, 'windowsVirtualKeyCode', {
    min: 0,
    max: 255,
    integer: true,
    fallback: virtualKeyCode(name),
  });
  const params = {
    // A keyDown with no text is a raw key (Backspace, arrows, shortcuts); with text it types.
    type: event.type === 'keyDown' && !text ? 'rawKeyDown' : event.type,
    key: name,
    code: string(event.code, 'code', { max: MAX_KEY_LENGTH, fallback: '' }),
    modifiers: bounded(event.modifiers, 'modifiers', {
      min: 0,
      max: MAX_MODIFIERS,
      integer: true,
      fallback: 0,
    }),
    windowsVirtualKeyCode: code,
    nativeVirtualKeyCode: code,
  };
  if (event.type !== 'keyUp' && text) {
    params.text = text;
    params.unmodifiedText = text;
  }
  return { method: 'Input.dispatchKeyEvent', params };
}

// One viewer event in, one whitelisted CDP command out, or a 400.
export function parseInputEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event))
    throw invalid('An input event is required.');
  if (MOUSE_TYPES.has(event.type)) return mouse(event);
  if (event.type === 'wheel') return wheel(event);
  if (KEY_TYPES.has(event.type)) return key(event);
  throw invalid('That input type is not accepted.');
}
