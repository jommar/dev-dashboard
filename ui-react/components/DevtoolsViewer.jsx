// DevtoolsViewer.jsx — a running debug browser, watched from inside the dashboard.
//
// View-only by default. "Take control" forwards the mouse, wheel and keyboard to the browser;
// releasing it (the button, or Esc) stops forwarding at once. Frames are painted straight into
// the <img> by the screencast hook, so a stream of them never re-renders this component.
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from './Primitives.jsx';
import { useScreencast } from '../hooks/useScreencast.js';
import { sendDevtoolsInput } from '../lib/api.js';
import { createInputQueue, keyInput, mouseInput, wheelInput } from '../../ui/screencast-input.js';

const STATUS_TEXT = {
  connecting: 'Connecting…',
  live: 'Live',
  lost: 'Connection lost',
};
const REASON_TEXT = {
  reconnecting: 'Reconnecting…',
  stopped: 'Browser stopped',
  unreachable: 'Browser not reachable',
  unavailable: 'Browser not available',
  disconnected: 'Disconnected from the dashboard',
};

function DevtoolsViewerView({ id, label, port, onClose }) {
  const dialogRef = useRef(null);
  const stageRef = useRef(null);
  const imageRef = useRef(null);
  const metadataRef = useRef(null);
  const closeRef = useRef(onClose);
  const titleId = useId();
  const [hasFrame, setHasFrame] = useState(false);
  const [control, setControl] = useState(false);
  const controlRef = useRef(false);

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  const onFrame = useCallback(({ data, metadata }) => {
    metadataRef.current = metadata;
    if (imageRef.current) imageRef.current.src = `data:image/jpeg;base64,${data}`;
    setHasFrame(true);
  }, []);
  const { status, reason, target } = useScreencast(id, onFrame);
  const send = useMemo(() => createInputQueue((event) => sendDevtoolsInput(id, event)), [id]);

  useEffect(() => {
    controlRef.current = control;
  }, [control]);
  // Control only means something while the picture is live.
  useEffect(() => {
    if (status !== 'live') setControl(false);
  }, [status]);
  useEffect(() => {
    if (control) stageRef.current?.focus();
  }, [control]);

  // A modal <dialog> traps focus itself, but does not remember where it came from.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const opener = document.activeElement;
    if (!dialog.open) dialog.showModal();
    // Esc releases control first and only then closes, so a keyboard user is never trapped.
    const cancel = (event) => {
      event.preventDefault();
      if (controlRef.current) setControl(false);
      else closeRef.current?.();
    };
    dialog.addEventListener('cancel', cancel);
    return () => {
      dialog.removeEventListener('cancel', cancel);
      if (dialog.open) dialog.close();
      if (opener?.isConnected && typeof opener.focus === 'function')
        opener.focus({ preventScroll: true });
    };
  }, []);

  // What the pointer is over, in the frame's own terms: the drawn image, its natural size, and the
  // metadata of the frame it shows.
  const geometry = useCallback(() => {
    const image = imageRef.current;
    const metadata = metadataRef.current;
    if (!image || !metadata || !image.naturalWidth) return null;
    return {
      rect: image.getBoundingClientRect(),
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      metadata,
    };
  }, []);
  const pointer = (type, event) => {
    const where = geometry();
    const input = where && mouseInput(type, event, where);
    if (input) send(input);
    return Boolean(input);
  };

  const press = (event) => {
    if (!control) return;
    event.preventDefault();
    stageRef.current?.focus();
    // A press on a letterbox bar is on no point of the page, so there is nothing to drag or release.
    if (!pointer('mousePressed', event.nativeEvent)) return;
    // The drag is followed on the window, so leaving the picture does not drop the release.
    const move = (moved) => pointer('mouseMoved', moved);
    const release = (released) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', release);
      pointer('mouseReleased', released);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', release);
  };
  const hover = (event) => {
    if (control && event.buttons === 0) pointer('mouseMoved', event.nativeEvent);
  };
  const key = (type) => (event) => {
    if (!control || event.key === 'Escape') return;
    const input = keyInput(type, event.nativeEvent);
    if (!input) return;
    event.preventDefault();
    send(input);
  };

  // React registers wheel listeners as passive, which cannot stop the dialog scrolling.
  useEffect(() => {
    const stage = stageRef.current;
    if (!control || !stage) return undefined;
    const wheel = (event) => {
      event.preventDefault();
      const where = geometry();
      const input = where && wheelInput(event, where);
      if (input) send(input);
    };
    stage.addEventListener('wheel', wheel, { passive: false });
    return () => stage.removeEventListener('wheel', wheel);
  }, [control, send, geometry]);

  const text = reason && status !== 'live' ? REASON_TEXT[reason] : STATUS_TEXT[status];

  return (
    <dialog
      ref={dialogRef}
      className="devtools-viewer"
      aria-labelledby={titleId}
      data-testid="devtools-viewer"
      onClick={(event) => {
        // A backdrop click targets the <dialog> itself; the panel's children cannot cause it.
        if (event.target === dialogRef.current) closeRef.current?.();
      }}
    >
      <header className="devtools-viewer-head">
        <div>
          <h3 className="devtools-viewer-title" id={titleId} data-testid="devtools-viewer-title">
            {label}
          </h3>
          <p className="devtools-viewer-sub" data-testid="devtools-viewer-sub">
            Port {port}
            {target?.url ? ` · ${target.url}` : ''}
          </p>
        </div>
        <span
          className="devtools-viewer-status"
          role="status"
          data-status={status}
          data-testid="devtools-viewer-status"
        >
          {text}
        </span>
      </header>

      <div className="devtools-viewer-body">
        <div
          ref={stageRef}
          className="devtools-viewer-stage"
          data-control={control ? 'true' : 'false'}
          data-testid="devtools-viewer-stage"
          role="group"
          aria-label={
            control
              ? `${label}. Your mouse and keyboard drive this browser. Press Escape to release control.`
              : `${label}, view only.`
          }
          tabIndex={control ? 0 : -1}
          onMouseDown={press}
          onMouseMove={hover}
          onContextMenu={(event) => control && event.preventDefault()}
          onKeyDown={key('keyDown')}
          onKeyUp={key('keyUp')}
        >
          <img
            ref={imageRef}
            className="devtools-viewer-image"
            alt={`Live view of ${label}`}
            data-testid="devtools-viewer-image"
            hidden={!hasFrame}
            draggable={false}
          />
          {!hasFrame && <p className="devtools-viewer-wait">Waiting for the first frame…</p>}
        </div>
      </div>

      <footer className="devtools-viewer-foot">
        <Button
          data-testid="devtools-viewer-control"
          aria-pressed={control}
          disabled={status !== 'live'}
          onClick={() => setControl((current) => !current)}
        >
          {control ? 'Release control' : 'Take control'}
        </Button>
        <span className="devtools-viewer-hint" data-testid="devtools-viewer-hint">
          {control
            ? 'Your mouse and keyboard drive this browser. Esc releases control.'
            : 'View only.'}
        </span>
        <Button
          className="devtools-viewer-close"
          data-testid="devtools-viewer-close"
          onClick={() => closeRef.current?.()}
        >
          Close
        </Button>
      </footer>
    </dialog>
  );
}

export const DevtoolsViewer = memo(DevtoolsViewerView);
