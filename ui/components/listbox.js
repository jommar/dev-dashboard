// listbox.js — keyboard helpers for the dropdown listbox (button + listbox popup).
//
// Why a custom listbox exists: a native <select> renders its open option list in
// the OS, so per-option colors (state tints, a distinct selected highlight) are
// unreliable — Safari ignores them almost entirely. The React `Listbox`
// component (ui-react/components/Listbox.jsx) renders the popup in the DOM and
// uses `listboxMove` below; styles live in ui-react/styles/listbox.css (.listbox-*).

// True when an event target sits inside a listbox button or popup — including
// a node detached by a mid-propagation re-render (innerHTML swaps sever the
// container from the live tree but the subtree keeps its internal parent
// chain, so closest() still finds [data-listbox]). Outside-click closers must
// ignore these targets, or the same click that opens the list closes it again
// when it bubbles to document and contains() reports false.
export function isListboxEventTarget(target) {
  return !!target?.closest?.('[data-listbox]');
}

// Pure keyboard movement over an ordered value list. Wraps at both ends so a
// long sprint history can be walked without reversing direction. Returns the
// new current value (a String); unknown keys leave it unchanged.
export function listboxMove(values, currentValue, key) {
  const list = (values || []).map(String);
  if (!list.length) return currentValue;
  let i = list.indexOf(String(currentValue));
  if (i === -1) i = 0;
  if (key === 'ArrowDown') return list[(i + 1) % list.length];
  if (key === 'ArrowUp') return list[(i - 1 + list.length) % list.length];
  if (key === 'Home') return list[0];
  if (key === 'End') return list[list.length - 1];
  return currentValue;
}
