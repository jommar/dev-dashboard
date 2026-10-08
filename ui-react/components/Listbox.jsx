import { useEffect, useId, useRef, useState } from 'react';
import { listboxMove } from '../../ui/components/listbox.js';

export function Listbox({
  label,
  options,
  value,
  onChange,
  testId = 'listbox',
  active: enabled = true,
}) {
  const generated = useId().replaceAll(':', '');
  const id = `${testId}-${generated}`;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(value);
  useEffect(() => {
    if (!enabled) setOpen(false);
  }, [enabled]);
  const button = useRef(null);
  const selected = options.find((option) => String(option.value) === String(value)) || options[0];
  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = (event) => {
      if (!event.target.closest(`[data-listbox="${id}"]`)) setOpen(false);
    };
    document.addEventListener('mousedown', closeOutside);
    return () => document.removeEventListener('mousedown', closeOutside);
  }, [id, open]);
  const keyDown = (event) => {
    if (event.key === 'Escape') {
      setOpen(false);
      button.current?.focus({ preventScroll: true });
      return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setActive(String(value ?? selected?.value));
      } else
        setActive(
          listboxMove(
            options.map((option) => option.value),
            active ?? value,
            event.key,
          ),
        );
    }
    if (open && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      const next = options.find((option) => String(option.value) === String(active));
      if (next) onChange(next.value);
      setOpen(false);
      button.current?.focus({ preventScroll: true });
    }
  };
  return (
    <div className="listbox" data-listbox={id} onKeyDown={keyDown}>
      <span className="listbox-label" id={`${id}-label`}>
        {label}
      </span>
      <button
        ref={button}
        type="button"
        className="listbox-button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-activedescendant={open ? `${id}-option-${active}` : undefined}
        data-testid={testId}
        onClick={() => {
          setActive(String(value ?? selected?.value));
          setOpen((shown) => !shown);
        }}
      >
        {selected?.label}
        <span className="listbox-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div
          id={`${id}-list`}
          className="listbox-list"
          role="listbox"
          aria-labelledby={`${id}-label`}
        >
          {options.map((option) => (
            <div
              id={`${id}-option-${option.value}`}
              key={option.value}
              className="listbox-option"
              role="option"
              aria-selected={String(option.value) === String(value)}
              data-active={String(option.value) === String(active)}
              data-state={option.state}
              tabIndex={-1}
              onMouseEnter={() => setActive(String(option.value))}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
                button.current?.focus({ preventScroll: true });
              }}
            >
              {option.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
