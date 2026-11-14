// ScreenSlot.jsx — where one lazily loaded screen is mounted. The screen's code is fetched on its
// first visit (or at once when the boot route names it, e.g. #/chat?session=<uuid>), and the screen
// then stays mounted, hidden while another tab is active, exactly as an eager screen does: scroll,
// filters and open dialogs survive leaving and returning, and no chunk is requested twice.
//
// While the chunk loads, a panel with id `<id>-loading` stands in and `panel-<id>` is never the
// fallback. The stand-in has the screen's own shape: a `BoardPanel` for a board screen (so the
// viewport-fill rule holds from the first paint) and a plain `.panel` for a page that scrolls
// normally (`board={false}`, Releases), so the page height does not flip when the chunk arrives. A failed chunk, usually a tab that outlived a
// deploy and asks for a hashed file that is gone, shows `screen-error-<id>` with a Reload button and
// leaves every other tab alone.
import { Component, memo, Suspense, useEffect, useState } from 'react';
import { BoardPanel, BoardState } from './BoardShell.jsx';
import { ChunkFailedDialog } from './ChunkFailedDialog.jsx';
import { Button, Card } from './Primitives.jsx';

// The stand-in panel: `board` picks the shape of the screen it stands in for.
function StandIn({ id, board, active, busy, children }) {
  if (board)
    return (
      <BoardPanel id={id} active={active} busy={busy}>
        {children}
      </BoardPanel>
    );
  return (
    <section
      id={`panel-${id}`}
      className="panel"
      data-testid={`panel-${id}`}
      hidden={!active}
      aria-busy={busy}
    >
      {children}
    </section>
  );
}

function ScreenLoading({ id, label, board, active }) {
  return (
    <StandIn id={`${id}-loading`} board={board} active={active} busy>
      <Card className={board ? 'board-section' : undefined}>
        <BoardState kind="loading" label={`Loading ${label}…`} testId={`screen-loading-${id}`} />
      </Card>
    </StandIn>
  );
}

// A class, because React still has no hook for catching a render or lazy-import failure. It shows
// `fallback` in place of its children once one of them throws, and nothing else on the page is
// affected.
export class ChunkBoundary extends Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function ScreenError({ id, label, board, active }) {
  return (
    <StandIn id={`${id}-error`} board={board} active={active}>
      <Card className={board ? 'board-section' : undefined}>
        <BoardState kind="error" testId={`screen-error-${id}`}>
          <p>{label} could not be shown. Reload the page to try again.</p>
          <Button data-testid={`screen-reload-${id}`} onClick={() => location.reload()}>
            Reload
          </Button>
        </BoardState>
      </Card>
    </StandIn>
  );
}

// A lazily loaded dialog: nothing shows while its chunk loads (it opens when it arrives); a chunk
// that cannot load opens a modal of its own with Reload and Close (`onClose` unmounts it), instead
// of taking the screen down with it. `onClose` must be stable.
export function LazyDialog({ label, onClose, children }) {
  return (
    <ChunkBoundary fallback={<ChunkFailedDialog label={label} onClose={onClose} />}>
      <Suspense fallback={null}>{children}</Suspense>
    </ChunkBoundary>
  );
}

// `Screen` is a lazy component (memoize it at the call site); `props` go to it unchanged. The slot
// is a `memo`, so a screen whose props did not change skips the render App's other state caused.
// `board` (default true) says the screen renders a `BoardPanel`; pass `board={false}` for a page
// that scrolls normally, so its loading and error stand-ins do not take the board's one-viewport
// height.
export const ScreenSlot = memo(function ScreenSlot({
  id,
  label,
  board = true,
  active,
  Screen,
  ...props
}) {
  // `active` alone mounts the screen on the very render it is first shown; the state keeps it
  // mounted afterwards.
  const [visited, setVisited] = useState(active);
  useEffect(() => {
    if (active) setVisited(true);
  }, [active]);
  if (!visited && !active) return null;
  return (
    <ChunkBoundary fallback={<ScreenError id={id} label={label} board={board} active={active} />}>
      <Suspense fallback={<ScreenLoading id={id} label={label} board={board} active={active} />}>
        <Screen active={active} {...props} />
      </Suspense>
    </ChunkBoundary>
  );
});
