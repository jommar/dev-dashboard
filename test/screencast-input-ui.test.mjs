// screencast-input-ui.test.mjs — viewer pixels to browser pixels, and DOM events to route events.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createInputQueue,
  frameToDevicePoint,
  keyInput,
  modifiersOf,
  mouseInput,
  wheelInput,
} from '../ui/screencast-input.js';

const METADATA = { deviceWidth: 1280, deviceHeight: 720, offsetTop: 0 };
// A 16:9 frame (640x360 image pixels) drawn with object-fit: contain.
const frame = { naturalWidth: 640, naturalHeight: 360, metadata: METADATA };

test('maps a point in an exactly fitting element', () => {
  const rect = { left: 100, top: 50, width: 640, height: 360 };
  assert.deepEqual(frameToDevicePoint({ clientX: 100, clientY: 50, rect, ...frame }), {
    x: 0,
    y: 0,
  });
  assert.deepEqual(frameToDevicePoint({ clientX: 420, clientY: 230, rect, ...frame }), {
    x: 640,
    y: 360,
  });
  assert.deepEqual(frameToDevicePoint({ clientX: 740, clientY: 410, rect, ...frame }), {
    x: 1280,
    y: 720,
  });
});

test('accounts for letterbox bars above and below a tall element', () => {
  // 800x600: the 16:9 image is 800 wide and 450 tall, centred, with 75 px bars above and below.
  const rect = { left: 0, top: 0, width: 800, height: 600 };
  assert.equal(frameToDevicePoint({ clientX: 400, clientY: 40, rect, ...frame }), null);
  assert.equal(frameToDevicePoint({ clientX: 400, clientY: 560, rect, ...frame }), null);
  assert.deepEqual(frameToDevicePoint({ clientX: 400, clientY: 300, rect, ...frame }), {
    x: 640,
    y: 360,
  });
  assert.deepEqual(frameToDevicePoint({ clientX: 0, clientY: 75, rect, ...frame }), {
    x: 0,
    y: 0,
  });
  assert.deepEqual(frameToDevicePoint({ clientX: 800, clientY: 525, rect, ...frame }), {
    x: 1280,
    y: 720,
  });
});

test('accounts for letterbox bars left and right of a wide element', () => {
  // 1000x360 at (10, 10): the image keeps 640x360, centred, with 180 px bars at each side.
  const rect = { left: 10, top: 10, width: 1000, height: 360 };
  assert.equal(frameToDevicePoint({ clientX: 100, clientY: 100, rect, ...frame }), null);
  assert.equal(frameToDevicePoint({ clientX: 900, clientY: 100, rect, ...frame }), null);
  assert.deepEqual(frameToDevicePoint({ clientX: 190, clientY: 10, rect, ...frame }), {
    x: 0,
    y: 0,
  });
  assert.deepEqual(frameToDevicePoint({ clientX: 510, clientY: 190, rect, ...frame }), {
    x: 640,
    y: 360,
  });
});

test('scales from image pixels to the browser viewport, not to the element', () => {
  const rect = { left: 0, top: 0, width: 160, height: 90 };
  assert.deepEqual(frameToDevicePoint({ clientX: 80, clientY: 45, rect, ...frame }), {
    x: 640,
    y: 360,
  });
});

test('removes the frame offset and never goes negative', () => {
  const rect = { left: 0, top: 0, width: 640, height: 360 };
  const shifted = { ...frame, metadata: { deviceWidth: 1280, deviceHeight: 720, offsetTop: 40 } };
  assert.deepEqual(frameToDevicePoint({ clientX: 320, clientY: 180, rect, ...shifted }), {
    x: 640,
    y: 320,
  });
  assert.equal(frameToDevicePoint({ clientX: 10, clientY: 2, rect, ...shifted }).y, 0);
});

test('clamps an off-frame point only when asked to', () => {
  const rect = { left: 0, top: 0, width: 640, height: 360 };
  assert.equal(frameToDevicePoint({ clientX: 900, clientY: -20, rect, ...frame }), null);
  assert.deepEqual(
    frameToDevicePoint({ clientX: 900, clientY: -20, rect, ...frame, clamped: true }),
    { x: 1280, y: 0 },
  );
});

test('refuses to map before a frame has arrived or with a degenerate size', () => {
  const rect = { left: 0, top: 0, width: 640, height: 360 };
  const at = { clientX: 1, clientY: 1 };
  assert.equal(
    frameToDevicePoint({ ...at, rect, naturalWidth: 0, naturalHeight: 0, metadata: METADATA }),
    null,
  );
  assert.equal(frameToDevicePoint({ ...at, rect, ...frame, metadata: null }), null);
  assert.equal(frameToDevicePoint({ ...at, rect: { ...rect, width: 0 }, ...frame }), null);
  assert.equal(
    frameToDevicePoint({
      ...at,
      rect,
      ...frame,
      metadata: { deviceWidth: Number.NaN, deviceHeight: 1 },
    }),
    null,
  );
});

test('packs the modifier keys into the CDP bitmask', () => {
  assert.equal(modifiersOf({}), 0);
  assert.equal(modifiersOf({ altKey: true }), 1);
  assert.equal(modifiersOf({ ctrlKey: true, shiftKey: true }), 10);
  assert.equal(modifiersOf({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true }), 15);
  assert.equal(modifiersOf(undefined), 0);
});

const geometry = { rect: { left: 0, top: 0, width: 640, height: 360 }, ...frame };

test('a click becomes press and release events with a button and click count', () => {
  const press = mouseInput(
    'mousePressed',
    { clientX: 320, clientY: 180, button: 2, buttons: 2, detail: 2 },
    geometry,
  );
  assert.deepEqual(press, {
    type: 'mousePressed',
    x: 640,
    y: 360,
    modifiers: 0,
    button: 'right',
    clickCount: 2,
    buttons: 2,
  });
  const release = mouseInput(
    'mouseReleased',
    { clientX: 320, clientY: 180, button: 0, buttons: 0, detail: 1 },
    geometry,
  );
  assert.equal(release.button, 'left');
  assert.equal(release.buttons, 0);
});

test('a release outside the frame still lands on its edge, a stray press does not', () => {
  const outside = { clientX: 900, clientY: 180, button: 0, buttons: 0, detail: 1 };
  assert.equal(mouseInput('mouseReleased', outside, geometry).x, 1280);
  assert.equal(mouseInput('mousePressed', outside, geometry), null);
  assert.equal(
    mouseInput('mousePressed', { ...outside, buttons: 1 }, geometry),
    null,
    'a press in a letterbox bar is not a press at the nearest edge',
  );
  assert.equal(mouseInput('mouseMoved', outside, geometry), null);
  assert.equal(mouseInput('mouseMoved', { ...outside, buttons: 1 }, geometry).x, 1280);
});

test('a plain move carries no button; a drag carries the held one', () => {
  assert.deepEqual(mouseInput('mouseMoved', { clientX: 0, clientY: 0, buttons: 0 }, geometry), {
    type: 'mouseMoved',
    x: 0,
    y: 0,
    modifiers: 0,
  });
  const drag = mouseInput('mouseMoved', { clientX: 0, clientY: 0, buttons: 1 }, geometry);
  assert.equal(drag.button, 'left');
  assert.equal(drag.buttons, 1);
});

test('a wheel is sent in pixels whatever unit the device reports', () => {
  const at = { clientX: 320, clientY: 180 };
  assert.deepEqual(wheelInput({ ...at, deltaX: 0, deltaY: 100, deltaMode: 0 }, geometry), {
    type: 'wheel',
    x: 640,
    y: 360,
    deltaX: 0,
    deltaY: 100,
    modifiers: 0,
  });
  assert.equal(wheelInput({ ...at, deltaX: 0, deltaY: 3, deltaMode: 1 }, geometry).deltaY, 48);
  assert.equal(wheelInput({ ...at, deltaX: 0, deltaY: 1, deltaMode: 2 }, geometry).deltaY, 360);
  assert.equal(wheelInput({ clientX: 9000, clientY: 0, deltaX: 0, deltaY: 1 }, geometry), null);
});

test('a printable key types, a shortcut and a navigation key do not', () => {
  assert.deepEqual(keyInput('keyDown', { key: 'a', code: 'KeyA', keyCode: 65 }), {
    type: 'keyDown',
    key: 'a',
    code: 'KeyA',
    modifiers: 0,
    text: 'a',
    windowsVirtualKeyCode: 65,
  });
  assert.equal(keyInput('keyDown', { key: 'Enter', code: 'Enter', keyCode: 13 }).text, '\r');
  assert.equal(keyInput('keyDown', { key: 'a', code: 'KeyA', ctrlKey: true }).text, undefined);
  assert.equal(keyInput('keyDown', { key: 'a', code: 'KeyA', metaKey: true }).text, undefined);
  assert.equal(keyInput('keyDown', { key: 'A', code: 'KeyA', shiftKey: true }).text, 'A');
  assert.equal(keyInput('keyDown', { key: 'ArrowLeft', code: 'ArrowLeft' }).text, undefined);
  assert.equal(keyInput('keyUp', { key: 'a', code: 'KeyA' }).text, undefined);
  assert.equal('windowsVirtualKeyCode' in keyInput('keyDown', { key: 'x', code: 'KeyX' }), false);
  assert.equal('windowsVirtualKeyCode' in keyInput('keyDown', { key: 'x', keyCode: 999 }), false);
});

test('composition keys are left to the input method', () => {
  assert.equal(keyInput('keyDown', { key: 'a', isComposing: true }), null);
  assert.equal(keyInput('keyDown', { key: 'Process' }), null);
  assert.equal(keyInput('keyDown', { key: 'Dead' }), null);
});

const settled = () => new Promise((resolve) => setImmediate(resolve));

test('the input queue sends in order and one at a time', async () => {
  const sent = [];
  let inFlight = 0;
  let overlapped = false;
  const push = createInputQueue(async (event) => {
    inFlight += 1;
    overlapped ||= inFlight > 1;
    await settled();
    sent.push(event.type);
    inFlight -= 1;
  });
  push({ type: 'mousePressed', x: 1, y: 1 });
  push({ type: 'mouseReleased', x: 1, y: 1 });
  push({ type: 'keyDown', key: 'a' });
  for (let turn = 0; turn < 6; turn += 1) await settled();
  assert.deepEqual(sent, ['mousePressed', 'mouseReleased', 'keyDown']);
  assert.equal(overlapped, false);
});

test('the input queue keeps the latest move and sums a backlog of scrolls', async () => {
  const sent = [];
  const push = createInputQueue(async (event) => {
    sent.push(event);
    await settled();
  });
  push({ type: 'mousePressed', x: 0, y: 0 }); // in flight at once
  push({ type: 'mouseMoved', x: 1, y: 1 });
  push({ type: 'mouseMoved', x: 2, y: 2 });
  push({ type: 'mouseMoved', x: 3, y: 3 });
  push({ type: 'wheel', x: 3, y: 3, deltaX: 0, deltaY: 10 });
  push({ type: 'wheel', x: 4, y: 4, deltaX: 5, deltaY: 20 });
  push({ type: 'mouseReleased', x: 4, y: 4 });
  for (let turn = 0; turn < 10; turn += 1) await settled();
  assert.deepEqual(
    sent.map((event) => event.type),
    ['mousePressed', 'mouseMoved', 'wheel', 'mouseReleased'],
  );
  assert.equal(sent[1].x, 3, 'only the last queued move survives');
  assert.deepEqual([sent[2].x, sent[2].deltaX, sent[2].deltaY], [4, 5, 30]);
});

test('the input queue survives a refused event', async () => {
  const sent = [];
  const push = createInputQueue(async (event) => {
    sent.push(event.type);
    if (event.type === 'keyDown') throw new Error('refused');
  });
  push({ type: 'keyDown', key: 'a' });
  push({ type: 'keyUp', key: 'a' });
  for (let turn = 0; turn < 5; turn += 1) await settled();
  assert.deepEqual(sent, ['keyDown', 'keyUp']);
});
