import { useEffect, useRef, useState } from 'react';
import { isBlocked, isPaletteChord, resolveShortcut } from '../../ui/shortcuts.js';
import { loadCommandPalette, loadShortcutsHelp } from '../lib/lazy-overlays.js';

// The keyboard layer's one document listener (see ui/shortcuts.js for what a key means): returns
// `{ palette, setPalette, helpOpen, setHelpOpen }`. `palette` is null while the command palette is
// closed and `{ active }` while open. A `g` then letter calls `onNavigate`; the palette and the help
// are state the shell renders. Reads the latest props through a ref, so the listener is bound once.
export function useGlobalShortcuts({ tabs, active, onNavigate }) {
  const [palette, setPalette] = useState(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const latest = useRef({ tabs, active, onNavigate });
  latest.current = { tabs, active, onNavigate };

  useEffect(() => {
    const isMac = /Mac|iPhone|iPad/i.test(navigator.platform);
    let pending = null;
    const onKeyDown = (event) => {
      const { tabs: current, active: activeTab, onNavigate: navigate } = latest.current;
      // Decided before the chord is prevented, which `isBlocked` would read as "already handled".
      const blocked = isBlocked(event, document);
      // Recognised is prevented in every state (palette or help open, key repeat): the browser's own
      // Ctrl+K moves focus to its address bar.
      if (current.length > 1 && isPaletteChord(event, isMac)) event.preventDefault();
      const result = resolveShortcut({
        event,
        pending,
        now: Date.now(),
        tabs: current,
        blocked,
        isMac,
      });
      pending = result.pending;
      if (result.action === 'palette') {
        event.preventDefault();
        // Load, then open (also when the load fails: the lazy mount then shows the Reload alert).
        const open = () => setPalette({ active: activeTab });
        loadCommandPalette().then(open, open);
      } else if (result.action === 'help') {
        event.preventDefault();
        const open = () => setHelpOpen(true);
        loadShortcutsHelp().then(open, open);
      } else if (result.action) navigate(result.action.slice('goto:'.length));
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  return { palette, setPalette, helpOpen, setHelpOpen };
}
