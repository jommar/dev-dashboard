// screencast-input.js — turns what the viewer sees and the user does into the flat input events
// the DevTools screencast route accepts. Pure: the viewer passes in rects and DOM events.
//
// The screencast frame is drawn with `object-fit: contain`, so it can be letterboxed inside its
// element. A pointer is mapped through the drawn image, not the element, then scaled from image
// pixels to the browser's own viewport (the frame metadata's deviceWidth/deviceHeight).

const MODIFIERS = { altKey: 1, ctrlKey: 2, metaKey: 4, shiftKey: 8 };
const BUTTONS = ['left', 'middle', 'right'];
const LINE_PIXELS = 16;

const round = (value) => Math.round(value * 100) / 100;
const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

// CDP's modifier bitmask: Alt 1, Ctrl 2, Meta 4, Shift 8.
export function modifiersOf(event) {
  let mask = 0;
  for (const [name, bit] of Object.entries(MODIFIERS)) if (event?.[name]) mask |= bit;
  return mask;
}

// A client point on the displayed frame as a point in the browser's viewport, or null when it falls
// in the letterbox bars. `clamped` pins an off-frame point to the nearest edge instead, which a drag
// that leaves the image needs so the release still lands.
export function frameToDevicePoint({
  clientX,
  clientY,
  rect,
  naturalWidth,
  naturalHeight,
  metadata,
  clamped = false,
}) {
  const { deviceWidth, deviceHeight, offsetTop = 0 } = metadata || {};
  const sizes = [rect?.width, rect?.height, naturalWidth, naturalHeight, deviceWidth, deviceHeight];
  if (!sizes.every((size) => Number.isFinite(size) && size > 0)) return null;
  const scale = Math.min(rect.width / naturalWidth, rect.height / naturalHeight);
  const width = naturalWidth * scale;
  const height = naturalHeight * scale;
  let x = clientX - (rect.left + (rect.width - width) / 2);
  let y = clientY - (rect.top + (rect.height - height) / 2);
  if (clamped) {
    x = clamp(x, 0, width);
    y = clamp(y, 0, height);
  } else if (x < 0 || y < 0 || x > width || y > height) return null;
  return {
    x: round((x / width) * deviceWidth),
    y: round(Math.max(0, (y / height) * deviceHeight - offsetTop)),
  };
}

// A DOM mouse event as the route's mouse event, or null when it is off the frame.
export function mouseInput(type, event, geometry) {
  const point = frameToDevicePoint({
    clientX: event.clientX,
    clientY: event.clientY,
    ...geometry,
    clamped: type === 'mouseReleased' || (type === 'mouseMoved' && event.buttons > 0),
  });
  if (!point) return null;
  const input = { type, ...point, modifiers: modifiersOf(event) };
  if (type !== 'mouseMoved') {
    input.button = BUTTONS[event.button] || 'left';
    input.clickCount = clamp(event.detail || 1, 1, 3);
  } else if (event.buttons > 0) {
    input.button = event.buttons & 1 ? 'left' : event.buttons & 4 ? 'middle' : 'right';
  }
  if (event.buttons > 0 || type !== 'mouseMoved') input.buttons = event.buttons & 31;
  return input;
}

// A DOM wheel event as the route's wheel event, in pixels whatever unit the device reports.
export function wheelInput(event, geometry) {
  const point = frameToDevicePoint({ clientX: event.clientX, clientY: event.clientY, ...geometry });
  if (!point) return null;
  const unit =
    event.deltaMode === 1 ? LINE_PIXELS : event.deltaMode === 2 ? geometry.rect.height : 1;
  return {
    type: 'wheel',
    ...point,
    deltaX: clamp(event.deltaX * unit, -20000, 20000),
    deltaY: clamp(event.deltaY * unit, -20000, 20000),
    modifiers: modifiersOf(event),
  };
}

// A DOM key event as the route's key event. A key types when it is one character (or Enter) and
// no shortcut modifier is held, so Ctrl+A stays a shortcut and never types an "a". Returns null for
// composition input the page's own input method has not finished.
export function keyInput(type, event) {
  if (event.isComposing || event.key === 'Process' || event.key === 'Dead') return null;
  const input = { type, key: event.key, code: event.code || '', modifiers: modifiersOf(event) };
  const shortcut = event.ctrlKey || event.metaKey || event.altKey;
  if (type === 'keyDown' && !shortcut) {
    if (event.key === 'Enter') input.text = '\r';
    else if ([...event.key].length === 1) input.text = event.key;
  }
  if (Number.isInteger(event.keyCode) && event.keyCode > 0 && event.keyCode <= 255)
    input.windowsVirtualKeyCode = event.keyCode;
  return input;
}

// Events go out one at a time and in order (a release must never overtake its press), and a
// backlog collapses to what still matters: the latest pointer position, and scrolls summed into one.
export function createInputQueue(send) {
  const queue = [];
  let sending = false;
  const drain = async () => {
    if (sending) return;
    sending = true;
    while (queue.length) {
      try {
        await send(queue.shift());
      } catch {
        // A refused event is not worth stopping the ones behind it.
      }
    }
    sending = false;
  };
  return (event) => {
    const last = queue.at(-1);
    if (last && event.type === 'mouseMoved' && last.type === 'mouseMoved')
      queue[queue.length - 1] = event;
    else if (last && event.type === 'wheel' && last.type === 'wheel')
      queue[queue.length - 1] = {
        ...event,
        deltaX: clamp(last.deltaX + event.deltaX, -20000, 20000),
        deltaY: clamp(last.deltaY + event.deltaY, -20000, 20000),
      };
    else queue.push(event);
    drain();
  };
}
