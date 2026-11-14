// ChunkFailedDialog.jsx — what a lazily loaded dialog shows when its code cannot load (usually a tab
// that outlived a deploy). It is a modal <dialog> of its own: the dialog it was to open over (the
// Claude dialog) is itself a modal, so everything outside it is inert, and a plain alert next to it
// would show behind it with a Reload nobody can click. Shown last, a modal takes the top layer in
// front. Escape and Close call `onClose`, so the owner unmounts it; keep `onClose` stable, a new
// function each render reopens the dialog.
import { useId } from 'react';
import { Button } from './Primitives.jsx';
import { useModalDialog } from '../hooks/useModalDialog.js';

export function ChunkFailedDialog({ label, onClose }) {
  const dialogRef = useModalDialog(onClose);
  const titleId = useId();
  const textId = useId();
  return (
    <dialog
      ref={dialogRef}
      className="claude-dialog"
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={textId}
      data-testid="dialog-error"
    >
      <header className="claude-dialog-head">
        <h3 className="claude-dialog-title" id={titleId}>
          {label} could not load
        </h3>
      </header>
      <div className="claude-dialog-body">
        <p id={textId}>
          The dashboard may have been updated since this tab opened. Reload the page to try again.
        </p>
      </div>
      <footer className="claude-dialog-foot">
        <Button className="primary" onClick={() => location.reload()}>
          Reload
        </Button>
        <Button onClick={onClose}>Close</Button>
      </footer>
    </dialog>
  );
}
