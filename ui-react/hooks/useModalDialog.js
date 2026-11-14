import { useEffect, useRef } from 'react';

// A native modal <dialog> that is open for as long as its component is mounted: returns the ref to put on
// the <dialog>. Escape (the dialog's `cancel`) calls `onClose` instead of closing it, so the owner
// unmounts it. Focus goes back to what had it before the dialog opened; the dialog is already out of the
// document when React runs its cleanup, so the browser's own focus return cannot be relied on. The latest
// `onClose` is read through a ref, so a new callback never closes and reopens the dialog.
export function useModalDialog(onClose) {
  const dialogRef = useRef(null);
  const before = useRef(document.activeElement);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const dialog = dialogRef.current;
    const opener = before.current;
    dialog.showModal();
    const cancel = (event) => {
      event.preventDefault();
      close.current();
    };
    dialog.addEventListener('cancel', cancel);
    return () => {
      dialog.removeEventListener('cancel', cancel);
      if (dialog.open) dialog.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  return dialogRef;
}

// Click handlers that close `dialogRef`'s dialog from its backdrop only when the press AND the click both
// landed on the backdrop: a drag that starts in a field and is released over the backdrop clicks the
// <dialog> too, and so does a click on the dialog's own padding; neither may close it.
export function useBackdropClose(dialogRef, onClose) {
  const pressedBackdrop = useRef(false);
  const onBackdrop = (event) => {
    const dialog = dialogRef.current;
    if (event.target !== dialog) return false;
    const { left, right, top, bottom } = dialog.getBoundingClientRect();
    return (
      event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom
    );
  };
  return {
    onMouseDown: (event) => {
      pressedBackdrop.current = onBackdrop(event);
    },
    onClick: (event) => {
      if (pressedBackdrop.current && onBackdrop(event)) onClose();
      pressedBackdrop.current = false;
    },
  };
}
