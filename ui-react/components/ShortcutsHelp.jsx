// ShortcutsHelp.jsx — the `?` dialog: every shortcut of the keyboard layer. A native modal <dialog>,
// mounted only while open (it opens on mount and closes on unmount, returning focus).
import { SHORTCUT_TABS } from '../../ui/shortcuts.js';
import { useBackdropClose, useModalDialog } from '../hooks/useModalDialog.js';

export function ShortcutsHelp({ tabs, onClose }) {
  const dialogRef = useModalDialog(onClose);
  const backdrop = useBackdropClose(dialogRef, onClose);
  const isMac = /Mac|iPhone|iPad/i.test(navigator.platform);
  const labelOf = (id) => tabs.find((tab) => tab.id === id)?.label;
  return (
    <dialog
      ref={dialogRef}
      className="command-palette command-palette-help"
      data-testid="shortcuts-help"
      aria-labelledby="shortcuts-help-title"
      {...backdrop}
    >
      <h2 id="shortcuts-help-title" className="command-palette-help-title">
        Keyboard shortcuts
      </h2>
      <dl className="command-palette-help-list">
        <dt>
          <kbd className="command-palette-hint">{isMac ? 'Cmd+K' : 'Ctrl+K'}</kbd>
        </dt>
        <dd>Command palette: screens, sessions, New chat, Refresh</dd>
        <dt>
          <kbd className="command-palette-hint">?</kbd>
        </dt>
        <dd>This list</dd>
        {Object.entries(SHORTCUT_TABS)
          .filter(([, id]) => labelOf(id))
          .map(([letter, id]) => (
            <div key={id} className="command-palette-help-row">
              <dt>
                <kbd className="command-palette-hint">g</kbd> then{' '}
                <kbd className="command-palette-hint">{letter}</kbd>
              </dt>
              <dd>Go to {labelOf(id)}</dd>
            </div>
          ))}
      </dl>
      <button type="button" className="command-palette-close" onClick={onClose}>
        Close
      </button>
    </dialog>
  );
}
