// listbox.js — a reusable dropdown listbox (button + listbox popup).
//
// Why this exists: a native <select> renders its open option list in the OS,
// so per-option colors (state tints, a distinct selected highlight) are
// unreliable — Safari ignores them almost entirely. This component renders the
// popup in the DOM, so every option is fully styleable via CSS.
//
// Reuse contract (deliberately framework-free, like home-cards.js):
//   1. Render with listboxHtml() — pure, DOM-free, unit-tested here.
//   2. Hold `selectedValue` + `open` (+ optional active-descendant value) in
//      the caller's closure state, exactly like home-panel.js holds
//      `expanded` — setRegion-style wholesale re-renders must re-emit from
//      that state so silent poll ticks stay byte-identical no-ops.
//   3. Wire clicks + keys in the panel (see the "wiring" comment below) and
//      move focus explicitly after each re-render — the DOM nodes are
//      recreated, so focus falls to <body> unless restored.
//   4. Style via ui-react/styles/listbox.css (.listbox-*) plus optional per-option
//      [data-state] hooks. Any string state works; the stylesheet ships the
//      active/future/closed convention shared with .ticket-sprint.
//
// Wiring sketch (home-panel.js is the reference implementation):
//   container.addEventListener('click', (e) => {
//     if (e.target.closest('[role="option"]')) onSelect(option value); // + close
//     else if (e.target.closest('button[data-listbox-button]')) onToggle();
//   });
//   container.addEventListener('keydown', (e) => {
//     // Enter/Space toggle or select, ArrowUp/Down/Home/End move via
//     // listboxMove(), Escape/Tab close.
//   });
//   document.addEventListener('click', (e) => {
//     if (!container.contains(e.target)) onClose();
//   });
import { esc, slug } from '../dom.js';

// One dropdown option. `value` is the stable identity (compared with ===
// against String(selectedValue)); `label` is the visible text; `state` is an
// opaque tag rendered as data-state for CSS hooks (e.g. sprint state);
// `hint` feeds both data-tooltip and aria-label so mouse and keyboard users
// get the same sentence (tooltip.js listens on mouseover only).
// `testId` overrides the default `${testId}-option-<slug(value)>`.
//
// Returns the button + (when open) popup markup. The button always carries
// data-state of the selected option so the closed control can tint itself by
// state (e.g. accent for the active sprint, muted for a closed one).
export function listboxHtml({
  id,
  testId,
  label,
  options,
  selectedValue,
  open = false,
  activeValue = null,
  hint = null,
} = {}) {
  const list = options || [];
  const selected = list.find((o) => String(o.value) === String(selectedValue)) || list[0] || null;
  const active =
    (activeValue != null && list.find((o) => String(o.value) === String(activeValue))) || selected;
  const listId = `${id}-list`;
  const expanded = open ? 'true' : 'false';
  const buttonState = selected && selected.state ? ` data-state="${esc(selected.state)}"` : '';
  const tip = hint ? ` data-tooltip="${esc(hint)}" aria-label="${esc(hint)}"` : '';
  const activeId = open && active ? `${id}-opt-${slug(String(active.value))}` : null;
  const labelledBy = label ? `${id}-label ${id}` : id;

  const button =
    `<button type="button" id="${esc(id)}" class="listbox-button" data-listbox-button="${esc(id)}"` +
    ` role="combobox" aria-haspopup="listbox" aria-expanded="${expanded}"` +
    (open ? ` aria-controls="${esc(listId)}"` : '') +
    (activeId ? ` aria-activedescendant="${esc(activeId)}"` : '') +
    ` data-value="${selected ? esc(String(selected.value)) : ''}"${buttonState}${tip}` +
    ` data-testid="${esc(testId)}">` +
    (label ? `<span class="listbox-button-label">${esc(label)}</span>` : '') +
    `<span class="listbox-button-value">${selected ? esc(selected.label) : ''}</span>` +
    '<span class="listbox-caret" aria-hidden="true">▾</span></button>';

  if (!open) {
    return (
      `<div class="listbox" data-listbox="${esc(id)}">` +
      (label ? `<span class="listbox-label" id="${esc(id)}-label">${esc(label)}</span>` : '') +
      button +
      `</div>`
    );
  }

  const items = list
    .map((o) => {
      const val = String(o.value);
      const isSelected = selected && String(selected.value) === val;
      const isActive = active && String(active.value) === val;
      const state = o.state ? ` data-state="${esc(o.state)}"` : '';
      const itemHint = o.hint
        ? ` data-tooltip="${esc(o.hint)}" aria-label="${esc(`${o.label}. ${o.hint}`)}"`
        : '';
      const itemTestId = o.testId || `${testId}-option-${slug(val)}`;
      return (
        `<div role="option" id="${esc(id)}-opt-${slug(val)}" class="listbox-option" data-value="${esc(val)}"` +
        `${state} aria-selected="${isSelected ? 'true' : 'false'}"` +
        (isActive ? ' data-active="true"' : '') +
        ` tabindex="-1"${itemHint} data-testid="${esc(itemTestId)}">` +
        `<span class="listbox-check" aria-hidden="true">${isSelected ? '✓' : ''}</span>` +
        `<span class="listbox-option-label">${esc(o.label)}</span>` +
        `</div>`
      );
    })
    .join('');

  return (
    `<div class="listbox" data-listbox="${esc(id)}">` +
    (label ? `<span class="listbox-label" id="${esc(id)}-label">${esc(label)}</span>` : '') +
    button +
    `<div role="listbox" id="${esc(listId)}" class="listbox-list" tabindex="-1" aria-labelledby="${esc(labelledBy)}"` +
    ` data-testid="${esc(testId)}-list">${items}</div>` +
    `</div>`
  );
}

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
