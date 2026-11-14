// EdgeDrawer.jsx — the frame of a right-edge drawer: a fixed tab on the edge and the non-modal panel it
// opens (SessionsDrawer, SlackDrawer). Class names and test ids come from `name` (`${name}-tab`,
// `${name}-drawer`, `${name}-head`, `${name}-close` ...); the shared CSS hooks are the `data-edge-*`
// attributes (styles/edge-drawer.css), so a drawer's own sheet only adds its colour role. The drawer's
// content is `children` and is mounted only while it is open. Closing from here (Close, Escape) puts the
// focus back on the tab, which the caller owns through `tabRef` so its own controls can do the same.
// `sweep` (the pending store's { cycle, ms }) adds a decorative border timer: a new cycle remounts it, so a CSS animation of `ms` restarts.
// There is no tooltip, native title or live region in the frame.
import { useCallback, useEffect, useId, useRef } from 'react';
import { Button } from './Primitives.jsx';

export function EdgeDrawer({
  name,
  id,
  open,
  onToggle,
  tabRef,
  label,
  count,
  attention,
  tabLabel,
  sweep,
  title,
  closeLabel,
  slot,
  actions,
  children,
}) {
  const titleId = useId();
  const closeButton = useRef(null);

  const close = useCallback(() => {
    onToggle(false);
    tabRef.current?.focus();
  }, [onToggle, tabRef]);

  useEffect(() => {
    if (!open) return undefined;
    closeButton.current?.focus();
    const onKey = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // A modal dialog over the drawer takes Escape for itself.
      if (document.querySelector('dialog[open]')) return;
      close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  return (
    <>
      <button
        ref={tabRef}
        type="button"
        className={`${name}-tab`}
        data-testid={`${name}-tab`}
        data-edge-tab={slot}
        data-attention={attention || undefined}
        aria-expanded={open}
        aria-controls={id}
        aria-label={tabLabel}
        onClick={() => onToggle(!open)}
      >
        <span aria-hidden="true">{label}</span>
        {count !== undefined && (
          <span className={`${name}-tab-count`} data-edge-count aria-hidden="true">
            {count}
          </span>
        )}
        {sweep && (
          <span
            key={sweep.cycle}
            className={`${name}-tab-sweep`}
            style={{ '--sweep-ms': sweep.ms }}
            aria-hidden="true"
          />
        )}
      </button>
      <aside
        id={id}
        className={`${name}-drawer`}
        data-testid={`${name}-drawer`}
        data-edge-drawer
        aria-labelledby={titleId}
        hidden={!open}
      >
        {open && (
          <>
            <header className={`${name}-head`} data-edge-head>
              <h2 id={titleId}>{title}</h2>
              <div className={`${name}-head-actions`} data-edge-actions>
                {actions}
                <Button
                  ref={closeButton}
                  className="subtle"
                  data-testid={`${name}-close`}
                  aria-label={closeLabel}
                  onClick={close}
                >
                  Close
                </Button>
              </div>
            </header>
            {children}
          </>
        )}
      </aside>
    </>
  );
}
