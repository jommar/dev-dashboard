// CommandPalette.jsx — the Ctrl/Cmd+K palette: a native modal <dialog> holding a combobox over a
// listbox of entries (every tab, the sessions of the drawer, New chat, the active board's Refresh and,
// for a typed ticket key, Open in My Tickets). What the entries are and how they are searched is
// ui/command-palette.js; this only shows them and reports the chosen one through `onChoose`. BotBar
// renders it beside the strip (never inside it) because it owns the sessions and how one opens.
// Mounted only while open: the dialog opens on mount and closes on unmount, which hands focus back to
// whatever had it (the Chat composer, say).
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { filterEntries, paletteEntries } from '../../ui/command-palette.js';
import { listboxMove } from '../../ui/components/listbox.js';
import { useBackdropClose, useModalDialog } from '../hooks/useModalDialog.js';

export function CommandPalette({ tabs, groups, active, refresh, onChoose, onClose }) {
  const dialogRef = useModalDialog(onClose);
  const backdrop = useBackdropClose(dialogRef, onClose);
  const listRef = useRef(null);
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState(null);
  const base = useId();
  const listId = `${base}-list`;
  const entries = useMemo(
    () => paletteEntries({ tabs, groups, active, refresh, query }),
    [tabs, groups, active, refresh, query],
  );
  const visible = useMemo(() => filterEntries(entries, query), [entries, query]);
  const selected = visible.find(({ id }) => id === chosen) ?? visible[0] ?? null;
  const optionId = (id) => `${base}-option-${visible.findIndex((entry) => entry.id === id)}`;

  useEffect(() => {
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [selected?.id]);

  const choose = (entry) => {
    onClose();
    onChoose(entry.action);
  };
  const onKeyDown = (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setChosen(
        listboxMove(
          visible.map(({ id }) => id),
          selected?.id,
          event.key,
        ),
      );
    } else if (event.key === 'Enter' && selected && !event.nativeEvent.isComposing) {
      event.preventDefault();
      choose(selected);
    }
  };

  let lastGroup = null;
  return (
    <dialog
      ref={dialogRef}
      className="command-palette"
      data-testid="command-palette"
      aria-label="Command palette"
      {...backdrop}
    >
      <input
        type="text"
        className="command-palette-input"
        data-testid="command-palette-input"
        role="combobox"
        aria-label="Search commands"
        aria-autocomplete="list"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={selected ? optionId(selected.id) : undefined}
        placeholder="Go to a screen, open a session, or type a ticket key"
        autoComplete="off"
        spellCheck={false}
        autoFocus
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setChosen(null);
        }}
        onKeyDown={onKeyDown}
      />
      <ul
        id={listId}
        ref={listRef}
        className="command-palette-list"
        role="listbox"
        aria-label="Commands"
        data-testid="command-palette-list"
      >
        {visible.map((entry) => {
          const heading = entry.group !== lastGroup;
          lastGroup = entry.group;
          return (
            <li key={entry.id} role="presentation" className="command-palette-row">
              {heading && <span className="command-palette-heading">{entry.group}</span>}
              <div
                id={optionId(entry.id)}
                role="option"
                aria-selected={entry.id === selected?.id}
                aria-label={entry.name}
                className="command-palette-option"
                data-testid={`command-option-${entry.id}`}
                onClick={() => choose(entry)}
              >
                <span aria-hidden="true">{entry.name}</span>
                {entry.hint && (
                  <kbd className="command-palette-hint" aria-hidden="true">
                    {entry.hint}
                  </kbd>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {visible.length === 0 && <p className="command-palette-empty">No matches.</p>}
      <p className="sr-only" role="status" aria-live="polite" data-testid="command-palette-status">
        {visible.length === 1 ? '1 result' : `${visible.length} results`}
      </p>
    </dialog>
  );
}
