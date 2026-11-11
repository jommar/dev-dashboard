// E2eCheckDialog.jsx — the two steps that come before an e2e check session. A native modal <dialog>
// opened over the Claude dialog and mounted only while it is open. Step 1 takes the address and opens
// a NEW DevTools browser; step 2 names its port, offers the live view (the DevTools viewer, as an
// optional way to sign in) and "I've logged in, start check", the only thing that starts the session.
// The person is the only driver until Start; the viewer is a modal over this dialog, so Start cannot be
// reached while it is open, and closing it lets go of the shared stream. Closing the dialog at step 2
// before a successful Start stops that browser (a failed stop is ignored: it stays in the DevTools
// tab); after Start the backend owns the stop. This component opens no event stream of its own.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from './Primitives.jsx';
import { ShowWindowToggle } from './ShowWindowToggle.jsx';
import { DevtoolsViewer } from './DevtoolsViewer.jsx';
import { launchDevtoolsBrowser, stopDevtoolsBrowser } from '../lib/api.js';
import { DEFAULT_DEVTOOLS_URL } from '../../ui/devtools-defaults.js';

const START_LABEL = "I've logged in, start check";

// `start(browserId)` launches the session and answers `{ ok }` or, for a refusal,
// `{ ok: false, gone, handedOver, message }`: `gone` when the browser is no longer there, `handedOver`
// when a session may be running on it, so closing no longer stops it.
export function E2eCheckDialog({ ticketKey, start, onClose }) {
  const dialogRef = useRef(null);
  const close = useRef(null);
  const pressedBackdrop = useRef(false);
  const titleId = useId();
  const [url, setUrl] = useState('');
  const [headed, setHeaded] = useState(false);
  const [browser, setBrowser] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [watching, setWatching] = useState(false);
  // The browser this dialog opened and has not handed to a session; closing stops it.
  const owned = useRef(null);
  const mounted = useRef(false);
  // While Start runs the session is being launched on that browser, so closing waits for the answer.
  const starting = useRef(false);
  const inputRef = useRef(null);
  const startRef = useRef(null);

  // Stops what the dialog still owns, then leaves. Also the unmount path, for a parent that goes away.
  const release = () => {
    if (owned.current) stopDevtoolsBrowser(owned.current);
    owned.current = null;
  };
  const dismiss = () => {
    if (starting.current) return;
    release();
    onClose();
  };
  close.current = dismiss;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // A Start in flight owns the browser now: the session is being launched on it.
      if (!starting.current) release();
    };
  }, []);

  // A step's button unmounts when the next step shows, so focus moves to the new step's control.
  useEffect(() => {
    (browser ? startRef : inputRef).current?.focus();
  }, [browser]);
  const closeViewer = useCallback(() => setWatching(false), []);

  useEffect(() => {
    const dialog = dialogRef.current;
    const opener = document.activeElement;
    dialog.showModal();
    // Esc closes through the same path as the Close button.
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

  const launch = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    const result = await launchDevtoolsBrowser({
      label: `E2E ${ticketKey}`,
      url: url.trim(),
      headed,
    });
    // Closed while the browser was opening: nothing else will ever stop it.
    if (!mounted.current) {
      if (result.ok) stopDevtoolsBrowser(result.browser.id);
      return;
    }
    setBusy(false);
    if (!result.ok) {
      setError(result.error || 'Could not open a browser.');
      return;
    }
    owned.current = result.browser.id;
    setBrowser(result.browser);
  };

  const begin = async () => {
    setBusy(true);
    setError('');
    starting.current = true;
    const result = await start(browser.id);
    starting.current = false;
    setBusy(false);
    if (result.ok) {
      owned.current = null;
      onClose();
      return;
    }
    setError(result.message);
    if (result.gone || result.handedOver) owned.current = null;
    if (result.gone) setBrowser(null);
  };

  return (
    <>
      <dialog
        ref={dialogRef}
        className="claude-dialog"
        aria-labelledby={titleId}
        data-testid="e2e-check-dialog"
        onPointerDown={(event) => {
          pressedBackdrop.current = event.target === dialogRef.current;
        }}
        onClick={(event) => {
          if (event.target === dialogRef.current && pressedBackdrop.current) close.current();
        }}
      >
        <header className="claude-dialog-head">
          <h3 className="claude-dialog-title" id={titleId}>
            <span className="claude-dialog-key">{ticketKey}</span> E2E check
          </h3>
        </header>

        <div className="claude-dialog-body">
          {browser ? (
            <div className="claude-e2e-step">
              <p className="claude-e2e-port">Port {browser.port}</p>
              <p className="claude-note">
                {browser.headed
                  ? 'Sign in in the browser window, or through the live view (Take control). '
                  : 'Sign in through the live view (Take control). '}
                Sign in to a throw-away test client, never a real one.
              </p>
              <div className="claude-e2e-actions">
                <Button onClick={() => setWatching(true)}>Open live view</Button>
                <Button ref={startRef} className="primary" disabled={busy} onClick={begin}>
                  {START_LABEL}
                </Button>
              </div>
            </div>
          ) : (
            <form className="claude-e2e-step" onSubmit={launch}>
              <label className="claude-e2e-field">
                Start at
                <input
                  ref={inputRef}
                  className="claude-e2e-input"
                  value={url}
                  placeholder={DEFAULT_DEVTOOLS_URL}
                  onChange={(event) => setUrl(event.target.value)}
                />
              </label>
              <p className="claude-note">
                Opens a new browser at this address. You sign in there, then the check starts.
              </p>
              <ShowWindowToggle checked={headed} onChange={setHeaded} />
              <div className="claude-e2e-actions">
                <Button type="submit" className="primary" disabled={busy}>
                  Launch browser
                </Button>
              </div>
            </form>
          )}
          {error && (
            <p className="claude-error" role="alert">
              {error}
            </p>
          )}
        </div>

        <footer className="claude-dialog-foot">
          <Button onClick={dismiss}>Close</Button>
        </footer>
      </dialog>
      {watching && (
        <DevtoolsViewer
          id={browser.id}
          label={`E2E ${ticketKey}`}
          port={browser.port}
          onClose={closeViewer}
        />
      )}
    </>
  );
}
