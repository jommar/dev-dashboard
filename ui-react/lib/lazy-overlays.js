import { createElement } from 'react';
import { lazyScreen } from './lazy-screen.js';

// The overlays opened on demand are not in the first-paint bundle: the command palette (Control+K),
// the shortcuts help (?) and the ticket's Claude dialog (a click on a bot or a My Tickets row; its
// code holds the prompts editor and UseInServices too).
//
// Each is a `[load, Overlay]` pair. The opener calls `load()` first and opens when it settles, also
// when it failed: `Overlay` then renders the loaded component directly, with no Suspense. A bare
// `React.lazy` would suspend on its first render and React holds a revealed fallback back for up to
// 300 ms, a visible lag on the first open. If the load failed, `Overlay` falls back to the lazy
// component, which tries again and fails into the `LazyDialog` around it (the Reload alert).
function lazyOverlay(importer, name) {
  let loaded = null;
  const Fallback = lazyScreen(importer, name);
  const load = () => importer().then((module) => (loaded ??= module[name]));
  const Overlay = (props) => createElement(loaded ?? Fallback, props);
  return [load, Overlay];
}

export const [loadCommandPalette, CommandPalette] = lazyOverlay(
  () => import('../components/CommandPalette.jsx'),
  'CommandPalette',
);
export const [loadShortcutsHelp, ShortcutsHelp] = lazyOverlay(
  () => import('../components/ShortcutsHelp.jsx'),
  'ShortcutsHelp',
);
export const [loadClaudeDialog, ClaudeDialog] = lazyOverlay(
  () => import('../components/ClaudeDialog.jsx'),
  'ClaudeDialog',
);
