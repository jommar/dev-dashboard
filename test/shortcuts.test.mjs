import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHORD_MS,
  SHORTCUT_TABS,
  chordHint,
  isBlocked,
  isEditableTarget,
  isPaletteChord,
  resolveShortcut,
} from '../ui/shortcuts.js';

const TABS = [
  'home',
  'my-tickets',
  'slack',
  'prs',
  'chat',
  'releases',
  'services',
  'devtools',
  'mascots',
  'settings',
].map((id) => ({ id }));
const key = (k, extra = {}) => ({ key: k, target: { tagName: 'BODY' }, ...extra });
const run = (event, pending = null, now = 1000, more = {}) =>
  resolveShortcut({ event, pending, now, tabs: TABS, blocked: false, ...more });

test('every tab has exactly one chord letter and the table covers the ten tabs', () => {
  assert.deepEqual(Object.values(SHORTCUT_TABS).sort(), TABS.map(({ id }) => id).sort());
  assert.equal(chordHint('my-tickets'), 't');
  assert.equal(chordHint('settings'), ',');
  assert.equal(chordHint('nope'), null);
});

test('g then a letter within the window goes to that tab', () => {
  const first = run(key('g'));
  assert.equal(first.action, null);
  assert.deepEqual(first.pending, { at: 1000 });
  const second = run(key('t'), first.pending, 1000 + CHORD_MS);
  assert.equal(second.action, 'goto:my-tickets');
  assert.equal(second.pending, null);
  assert.equal(run(key(','), first.pending, 1500).action, 'goto:settings');
});

test('a wrong second key, a second g or a late key navigates nowhere and ends the chord', () => {
  const pending = { at: 1000 };
  assert.deepEqual(run(key('x'), pending, 1100), { action: null, pending: null });
  assert.deepEqual(run(key('g'), pending, 1100), { action: null, pending: null });
  assert.deepEqual(run(key('t'), pending, 1000 + CHORD_MS + 1).action, null);
});

test('a chord only reaches tabs of the current mode', () => {
  const settingsOnly = [{ id: 'settings' }];
  assert.equal(run(key(','), { at: 1000 }, 1100, { tabs: settingsOnly }).action, 'goto:settings');
  assert.equal(run(key('t'), { at: 1000 }, 1100, { tabs: settingsOnly }).action, null);
  assert.equal(run(key('?'), null, 1000, { tabs: settingsOnly }).action, null);
  assert.equal(run(key('k', { ctrlKey: true }), null, 1000, { tabs: settingsOnly }).action, null);
});

test('? opens the help, with or without shift', () => {
  assert.equal(run(key('?', { shiftKey: true })).action, 'help');
  assert.equal(run(key('?')).action, 'help');
});

test('modifiers: plain keys need none, shift-letters and ctrl/alt/meta letters do nothing', () => {
  assert.equal(run(key('g', { shiftKey: true })).pending, null);
  assert.equal(run(key('g', { ctrlKey: true })).pending, null);
  assert.equal(run(key('g', { altKey: true })).pending, null);
  assert.equal(run(key('g', { metaKey: true })).pending, null);
  assert.equal(run(key('t', { ctrlKey: true }), { at: 1000 }, 1100).action, null);
  assert.equal(run(key('t', { shiftKey: true }), { at: 1000 }, 1100).action, null);
});

test('a bare modifier key does not break a chord', () => {
  const pending = { at: 1000 };
  assert.deepEqual(run(key('Shift'), pending, 1100), { action: null, pending });
});

test('repeat and composing events resolve to nothing and keep the chord', () => {
  const pending = { at: 1000 };
  assert.deepEqual(run(key('t', { repeat: true }), pending, 1100), { action: null, pending });
  assert.deepEqual(run(key('t', { isComposing: true }), pending, 1100), { action: null, pending });
});

test('the palette chord uses ctrl off Mac and cmd on Mac, with no alt or shift', () => {
  assert.equal(isPaletteChord({ key: 'k', ctrlKey: true }, false), true);
  assert.equal(isPaletteChord({ key: 'K', ctrlKey: true }, false), true);
  assert.equal(isPaletteChord({ key: 'k', metaKey: true }, false), false);
  assert.equal(isPaletteChord({ key: 'k', metaKey: true }, true), true);
  assert.equal(isPaletteChord({ key: 'k', ctrlKey: true }, true), false);
  assert.equal(isPaletteChord({ key: 'k', ctrlKey: true, shiftKey: true }, false), false);
  assert.equal(isPaletteChord({ key: 'k', ctrlKey: true, altKey: true }, false), false);
  assert.equal(isPaletteChord({ key: 'j', ctrlKey: true }, false), false);
  assert.equal(run(key('k', { ctrlKey: true })).action, 'palette');
  assert.equal(run(key('k', { metaKey: true }), null, 1000, { isMac: true }).action, 'palette');
});

test('text fields keep plain keys but still take the palette chord', () => {
  const field = { tagName: 'TEXTAREA' };
  assert.deepEqual(run(key('g', { target: field })), { action: null, pending: null });
  assert.equal(run(key('?', { target: field })).action, null);
  assert.equal(run(key('t', { target: field }), { at: 1000 }, 1100).action, null);
  assert.equal(run(key('k', { ctrlKey: true, target: field })).action, 'palette');
});

test('isEditableTarget: text inputs, textareas, selects, contenteditable and comboboxes', () => {
  assert.equal(isEditableTarget({ tagName: 'INPUT', type: 'text' }), true);
  assert.equal(isEditableTarget({ tagName: 'INPUT' }), true);
  assert.equal(isEditableTarget({ tagName: 'INPUT', type: 'search' }), true);
  assert.equal(isEditableTarget({ tagName: 'INPUT', type: 'checkbox' }), false);
  assert.equal(isEditableTarget({ tagName: 'TEXTAREA' }), true);
  assert.equal(isEditableTarget({ tagName: 'SELECT' }), true);
  assert.equal(isEditableTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(
    isEditableTarget({
      tagName: 'DIV',
      getAttribute: (name) => (name === 'role' ? 'combobox' : null),
    }),
    true,
  );
  assert.equal(isEditableTarget({ tagName: 'BUTTON' }), false);
  assert.equal(isEditableTarget({ tagName: 'A' }), false);
  assert.equal(isEditableTarget(null), false);
});

test('a blocked event resolves to nothing, even the palette chord, and ends the chord', () => {
  assert.deepEqual(run(key('k', { ctrlKey: true }), null, 1000, { blocked: true }), {
    action: null,
    pending: null,
  });
  assert.deepEqual(run(key('t'), { at: 1000 }, 1100, { blocked: true }), {
    action: null,
    pending: null,
  });
});

test('isBlocked: an open dialog, a prevented event or a screencast control stage', () => {
  const doc = (open) => ({ querySelector: (sel) => (sel === 'dialog[open]' && open ? {} : null) });
  const plain = { defaultPrevented: false, target: { closest: () => null } };
  assert.equal(isBlocked(plain, doc(false)), false);
  assert.equal(isBlocked(plain, doc(true)), true);
  assert.equal(isBlocked({ ...plain, defaultPrevented: true }, doc(false)), true);
  const stage = {
    defaultPrevented: false,
    target: { closest: (sel) => (sel === '[data-control="true"]' ? {} : null) },
  };
  assert.equal(isBlocked(stage, doc(false)), true);
  assert.equal(isBlocked({ defaultPrevented: false, target: null }, doc(false)), false);
});

test('isBlocked: a key typed inside an open menu or listbox popup is not a shortcut', () => {
  const doc = { querySelector: () => null };
  const inside = (role) => ({
    defaultPrevented: false,
    target: { closest: (sel) => (sel === `[role="${role}"]` ? {} : null) },
  });
  assert.equal(isBlocked(inside('menu'), doc), true);
  assert.equal(isBlocked(inside('listbox'), doc), true);
});
