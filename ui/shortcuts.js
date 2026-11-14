// shortcuts.js — what a key press means to the dashboard's keyboard layer, with no DOM: the palette
// chord (Ctrl+K, Cmd+K on a Mac), `g` then a letter to jump to a tab, and `?` for the help. The hook
// that listens (useGlobalShortcuts) only feeds events in and acts on the answer.

// How long the letter after `g` is waited for.
export const CHORD_MS = 1500;

// The letter after `g` for each tab.
export const SHORTCUT_TABS = Object.freeze({
  h: 'home',
  t: 'my-tickets',
  s: 'slack',
  p: 'prs',
  c: 'chat',
  r: 'releases',
  v: 'services',
  d: 'devtools',
  m: 'mascots',
  ',': 'settings',
});

// The chord letter of a tab id, or null.
export const chordHint = (tabId) =>
  Object.entries(SHORTCUT_TABS).find(([, id]) => id === tabId)?.[0] ?? null;

const NON_TEXT_INPUTS = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta']);

// Whether typing into `element` is text entry, so a plain key is the writer's and not a shortcut.
export function isEditableTarget(element) {
  if (!element) return false;
  const tag = element.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !NON_TEXT_INPUTS.has(String(element.type ?? '').toLowerCase());
  if (element.isContentEditable) return true;
  return element.getAttribute?.('role') === 'combobox';
}

// The platform modifier (Cmd on a Mac, Ctrl elsewhere) with K, and no alt or shift.
export const isPaletteChord = (event, isMac) =>
  Boolean(isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) &&
  !event.altKey &&
  !event.shiftKey &&
  String(event.key).toLowerCase() === 'k';

// Whether the layer must ignore `event`: a modal dialog is open, something already handled the key, it
// is typed inside an open menu or listbox popup (a portal outside any dialog, whose letters are its own
// typeahead), or on a screencast stage in control mode (those keys belong to the remote browser).
export const isBlocked = (event, doc) =>
  Boolean(
    event.defaultPrevented ||
    doc.querySelector('dialog[open]') ||
    event.target?.closest?.('[data-control="true"]') ||
    event.target?.closest?.('[role="menu"]') ||
    event.target?.closest?.('[role="listbox"]'),
  );

const NOTHING = { action: null, pending: null };

// The action of one key press and the chord waiting after it. `pending` is `{ at }` after a `g` (null
// for none), `now` is ms, `tabs` the tabs of the current mode (only those are reachable) and `blocked`
// says the event is to be ignored (see `isBlocked`). The action is `palette`, `help`, `goto:<tab id>`
// or null. A text field keeps every plain key but still takes the palette chord, so it works from the
// Chat composer.
export function resolveShortcut({ event, pending, now, tabs, blocked, isMac = false }) {
  if (blocked) return NOTHING;
  if (event.repeat || event.isComposing || MODIFIER_KEYS.has(event.key))
    return { action: null, pending };
  if (tabs.length > 1 && isPaletteChord(event, isMac)) return { action: 'palette', pending: null };
  if (isEditableTarget(event.target)) return NOTHING;
  if (event.ctrlKey || event.metaKey || event.altKey) return NOTHING;
  if (pending && now - pending.at <= CHORD_MS) {
    const id = event.shiftKey ? undefined : SHORTCUT_TABS[event.key];
    return id && tabs.some((tab) => tab.id === id)
      ? { action: `goto:${id}`, pending: null }
      : NOTHING;
  }
  if (tabs.length < 2) return NOTHING;
  if (event.key === 'g' && !event.shiftKey) return { action: null, pending: { at: now } };
  if (event.key === '?') return { action: 'help', pending: null };
  return NOTHING;
}
