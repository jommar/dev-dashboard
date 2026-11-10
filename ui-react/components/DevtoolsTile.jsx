// DevtoolsTile.jsx — one debug browser on the DevTools wall: a live, view-only picture of it with
// its port, state and the page it is on, and the actions that start, stop, restart or remove it.
//
// The picture is the browser's `tile` stream (small and slow) on the dashboard's one shared stream.
// A tile watches only while it can be seen: its browser runs, the DevTools screen is shown, the
// tile is inside the scrolling pane and the page is not in a background tab. Otherwise it lets go,
// which lets the browser's screencast stop, and keeps its last picture marked "Paused".
//
// Frames are painted straight into the <img>, so a stream of them never re-renders the tile; only
// the state, the page title and the first frame do. A tile is never a place to type: the picture
// forwards no input, and the only way to drive a browser is "Take control" in the full viewer that
// the picture opens.
import { memo, useEffect, useRef, useState } from 'react';
import { Button } from './Primitives.jsx';
import { devtoolsStream } from '../lib/devtools-stream.js';
import { useDocumentVisible, useInView } from '../hooks/useTileVisibility.js';
import { shouldStream, tilePageTitle, tileState } from '../../ui/devtools-wall.js';
import { timeAgo } from '../../ui/dom.js';

const IDLE = { status: 'connecting', reason: '', target: null, tabs: null };

function DevtoolsTileView({ browser, active, busy, onAction }) {
  const { id, label, port, pid, url, status, startedAt, profileDir } = browser;
  const running = status === 'running';
  // A different run of the same browser (restarted, new port) is a different picture.
  const run = running ? `${port}:${startedAt}` : null;
  const rootRef = useRef(null);
  const imageRef = useRef(null);
  const [live, setLive] = useState(IDLE);
  const [hasFrame, setHasFrame] = useState(false);
  const inView = useInView(rootRef);
  const documentVisible = useDocumentVisible();
  const streaming = shouldStream({ running, active, inView, documentVisible });

  useEffect(() => {
    setLive(IDLE);
    setHasFrame(false);
    imageRef.current?.removeAttribute('src');
  }, [run]);

  useEffect(() => {
    if (!streaming) return undefined;
    // Back from a pause: what it said before is not known to be true any more.
    setLive((current) => ({ ...current, status: 'connecting', reason: '' }));
    return devtoolsStream.watch(id, 'tile', {
      frame: ({ data }) => {
        if (imageRef.current) imageRef.current.src = `data:image/jpeg;base64,${data}`;
        setHasFrame(true);
      },
      status: ({ status: next, reason }) =>
        setLive((current) => ({ ...current, status: next, reason })),
      target: (target) => setLive((current) => ({ ...current, target })),
      tabs: (tabs) => setLive((current) => ({ ...current, tabs })),
    });
  }, [id, run, streaming]);

  const state = tileState({ running, streaming, status: live.status, reason: live.reason });
  const title = running ? tilePageTitle(live) : '';
  const name = `${label}, port ${port}`;
  const disabled = Boolean(busy);
  const act = (kind) => () => onAction(kind, browser);

  return (
    <li
      ref={rootRef}
      className="devtools-tile"
      data-state={state.key}
      data-testid={`devtools-tile-${id}`}
    >
      <div className="devtools-tile-head">
        <h3 className="devtools-tile-label" title={label} data-testid={`devtools-label-${id}`}>
          {label}
        </h3>
        <span className="devtools-tile-port">
          port{' '}
          <span className="devtools-tile-portnumber" data-testid={`devtools-port-${id}`}>
            {port ?? '—'}
          </span>
        </span>
      </div>
      <div className="devtools-tile-state">
        <span
          className="devtools-tile-status"
          data-status={state.key}
          data-testid={`devtools-status-${id}`}
        >
          <span className="devtools-tile-dot" aria-hidden="true" />
          {state.text}
        </span>
        <span className="devtools-tile-title" title={title} data-testid={`devtools-title-${id}`}>
          {title}
        </span>
      </div>

      {running ? (
        <button
          type="button"
          className="devtools-tile-frame devtools-tile-open"
          aria-label={`Open the live view of ${name}`}
          data-testid={`devtools-open-${id}`}
          onClick={act('open')}
        >
          <img
            ref={imageRef}
            className="devtools-tile-image"
            alt=""
            data-testid={`devtools-image-${id}`}
            hidden={!hasFrame}
            draggable={false}
          />
          {(!hasFrame || state.key !== 'live') && (
            <span className="devtools-tile-overlay" data-testid={`devtools-overlay-${id}`}>
              {state.text}
            </span>
          )}
        </button>
      ) : (
        <div className="devtools-tile-frame" data-testid={`devtools-placeholder-${id}`}>
          <div className="devtools-tile-empty">
            <span>Stopped</span>
            <span className="devtools-tile-emptyhint">Start it to see it here</span>
          </div>
        </div>
      )}

      <div className="devtools-tile-actions" role="group" aria-label={`Actions for ${name}`}>
        {running ? (
          <>
            <Button
              data-testid={`devtools-stop-${id}`}
              aria-label={`Stop ${name}`}
              disabled={disabled}
              onClick={act('stop')}
            >
              Stop
            </Button>
            <Button
              data-testid={`devtools-restart-${id}`}
              aria-label={`Restart ${name}`}
              disabled={disabled}
              onClick={act('restart')}
            >
              Restart
            </Button>
          </>
        ) : (
          <Button
            data-testid={`devtools-start-${id}`}
            aria-label={`Start ${name}`}
            disabled={disabled}
            onClick={act('start')}
          >
            Start
          </Button>
        )}
        <Button
          data-testid={`devtools-remove-${id}`}
          aria-label={`Remove ${name}`}
          disabled={disabled}
          onClick={act('remove')}
        >
          Remove
        </Button>
      </div>

      <details className="devtools-tile-details" data-testid={`devtools-details-${id}`}>
        <summary aria-label={`Details of ${name}`}>Details</summary>
        <dl className="devtools-tile-facts">
          <dt>Start at</dt>
          <dd data-testid={`devtools-url-${id}`}>{url}</dd>
          <dt>Profile</dt>
          <dd data-testid={`devtools-profile-${id}`}>{profileDir}</dd>
          <dt>Started</dt>
          <dd data-testid={`devtools-started-${id}`}>{timeAgo(startedAt)}</dd>
          <dt>PID</dt>
          <dd className="devtools-tile-pid" data-testid={`devtools-pid-${id}`}>
            {pid ?? '—'}
          </dd>
        </dl>
      </details>
    </li>
  );
}

// The panel re-renders every second (its refresh countdown) and every poll hands over new record
// objects, so a tile re-renders only when something it shows changed.
const SHOWN = ['id', 'label', 'port', 'pid', 'url', 'status', 'startedAt', 'profileDir'];
const sameTile = (previous, next) =>
  previous.active === next.active &&
  previous.busy === next.busy &&
  previous.onAction === next.onAction &&
  SHOWN.every((key) => previous.browser[key] === next.browser[key]);

export const DevtoolsTile = memo(DevtoolsTileView, sameTile);
