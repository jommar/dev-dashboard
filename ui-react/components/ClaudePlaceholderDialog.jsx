import { useEffect, useId, useRef } from 'react';
import { Button } from './Primitives.jsx';

export function ClaudePlaceholderDialog({ ticketKey, summary, onClose, resolveOpener }) {
  const dialogRef = useRef(null);
  const close = useRef(onClose);
  const openerResolver = useRef(resolveOpener);
  const pressedBackdrop = useRef(false);
  const titleId = useId();
  close.current = onClose;
  openerResolver.current = resolveOpener;

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog.showModal();
    const cancel = (event) => {
      event.preventDefault();
      close.current();
    };
    dialog.addEventListener('cancel', cancel);
    return () => {
      dialog.removeEventListener('cancel', cancel);
      if (dialog.open) dialog.close();
      openerResolver.current?.(ticketKey)?.focus({ preventScroll: true });
    };
  }, [ticketKey]);

  return (
    <dialog
      ref={dialogRef}
      className="claude-dialog"
      aria-labelledby={titleId}
      data-testid="prs-claude-dialog"
      onPointerDown={(event) => {
        pressedBackdrop.current = event.target === dialogRef.current;
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current && pressedBackdrop.current) close.current();
      }}
    >
      <header className="claude-dialog-head">
        <h3 className="claude-dialog-title" id={titleId} data-testid="prs-claude-dialog-title">
          <span className="claude-dialog-key">{ticketKey}</span> {summary}
        </h3>
      </header>
      <div className="claude-dialog-body" data-testid="prs-claude-dialog-body" />
      <footer className="claude-dialog-foot">
        <Button data-testid="prs-claude-dialog-close" onClick={() => close.current()}>
          Close
        </Button>
      </footer>
    </dialog>
  );
}
