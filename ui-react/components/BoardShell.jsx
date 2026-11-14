// BoardShell.jsx — the screen My Tickets and Slack share: one panel holding one card, a
// one-row toolbar (title, sub line, counts, controls), an optional switch, notes, and a body
// that fills the viewport with a board of columns. What the cards are, and what the columns
// mean, stay with each screen; presentation is ui-react/styles/board.css.
import { Children, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { usePreservedInteraction } from '../hooks/usePreservedInteraction.js';
import { registerBoardRefresh } from '../lib/board-refresh.js';
import { Button, Card, DashboardTooltip, LoadingState } from './Primitives.jsx';

// The panel <section>. `board-panel` is what opts the page into the one-viewport fill layout.
export function BoardPanel({ id, active, busy, children }) {
  return (
    <section
      id={`panel-${id}`}
      className="panel board-panel"
      data-testid={`panel-${id}`}
      hidden={!active}
      aria-busy={busy}
    >
      {children}
    </section>
  );
}

// The DOM ids that tie a BoardTabs row (by `name`) to the body BoardSection renders as its panel.
export const tabDomId = (name, id) => `board-tab-${name}-${id}`;
export const tabPanelDomId = (name) => `board-tabpanel-${name}`;

// The card: the toolbar (title, optional sub line, counts, controls, then `filters` and `notes`),
// then the body. Test ids default to `${name}-section|title|sub|meta|list`; `testIds` overrides any.
// When the `filters` are a BoardTabs row of the same `name`, pass the selected tab as `activeTab`:
// the body is then the tabs' panel, labelled by that tab. One body serves every tab because the
// views are swapped inside it (a board, a state box or a pane), not rendered side by side.
export function BoardSection({
  name,
  title,
  sub,
  subHidden = false,
  meta,
  controls,
  filters,
  notes,
  activeTab,
  testIds = {},
  children,
}) {
  const ids = {
    section: `${name}-section`,
    title: `${name}-title`,
    sub: `${name}-sub`,
    meta: `${name}-meta`,
    list: `${name}-list`,
    ...testIds,
  };
  const panel =
    activeTab === undefined
      ? undefined
      : {
          id: tabPanelDomId(name),
          role: 'tabpanel',
          'aria-labelledby': tabDomId(name, activeTab),
        };
  return (
    <Card className="board-section" data-testid={ids.section}>
      <div className="board-toolbar">
        <div className="board-bar">
          <h2 className="board-title" data-testid={ids.title}>
            {title}
          </h2>
          {sub !== undefined && (
            <div className="board-sub" data-testid={ids.sub} hidden={subHidden}>
              {sub}
            </div>
          )}
          <span className="board-meta" data-testid={ids.meta} role="status">
            {meta}
          </span>
          {controls && <div className="board-controls">{controls}</div>}
        </div>
        {filters}
        {notes}
      </div>
      <div className="board-body" data-testid={ids.list} {...panel}>
        {children}
      </div>
    </Card>
  );
}

// The Refresh button and the countdown beside it, for a board screen that polls with
// useActivePolling: pass the hook's `load`, so a click restarts the countdown and goes through the
// hook's in-flight guard, and the hook's `countdown` descriptor as `countdown`. Home and PRs keep
// their own pair: their countdown is `.pr-next` (body font, --fs-sm), this one is `.board-next`
// (mono, --fs-xs), so adopting it there would change how those two screens look.
export function RefreshControl({ name, loading, countdown, onRefresh }) {
  // The command palette's Refresh entry runs this same guarded load, found by the screen's name.
  useEffect(() => registerBoardRefresh(name, onRefresh), [name, onRefresh]);
  return (
    <span className="board-refresh">
      <Button data-testid={`${name}-refresh`} disabled={loading} onClick={() => onRefresh()}>
        Refresh
      </Button>
      <BoardCountdown name={name} countdown={countdown} />
    </span>
  );
}

// The readout over Refresh (words kept for assistive tech and tests, drawn transparent; what is seen is the
// line along the button's bottom edge) and the only 1 s clock a board has, so only this span re-renders per
// second, never the panel around it. It ticks only while its screen is active, as the polling does.
// It reads `refresh in Ns`, `refreshing…` once due, and `refresh paused (Ns)` while the page is
// hidden; the clock stops while hidden (the label then holds the value it had when the page was
// hidden) and restarts, with a fresh reading, on visible.
// `countdown` is `{ lastLoadedAt, interval, loaded, active }` from useActivePolling.
function BoardCountdown({ name, countdown: { lastLoadedAt, interval, loaded, active } }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return undefined;
    let timer = null;
    const tick = () => setNow(Date.now());
    const sync = () => {
      clearInterval(timer);
      timer = null;
      tick();
      if (!document.hidden) timer = setInterval(tick, 1000); // the 1 s clock
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', sync);
    };
  }, [active]);
  // The line along the button is the countdown. It restarts, at the elapsed time read once, on a load, when the
  // page hides or shows (the key) and when the screen is shown again (the memo), never per tick.
  const hidden = document.hidden;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hidden and active only trigger the read
  const ago = useMemo(() => Date.now() - lastLoadedAt, [lastLoadedAt, hidden, active]);
  // `now` can lag a just-finished load by up to a tick, so the elapsed time never goes negative.
  const remaining = Math.max(0, interval - Math.max(0, now - lastLoadedAt));
  const text =
    !loaded || !lastLoadedAt
      ? ''
      : hidden
        ? `refresh paused (${Math.ceil(remaining / 1000)}s)`
        : remaining
          ? `refresh in ${Math.ceil(remaining / 1000)}s`
          : 'refreshing…';
  return (
    <span
      key={hidden + lastLoadedAt}
      className="board-next"
      data-testid={`${name}-next`}
      data-hold={hidden}
      style={{ '--cd-ms': interval, '--cd-ago': -ago }}
    >
      {text}
    </span>
  );
}

// A segmented switch between views of one board: a tablist whose tabs all control the body of the
// BoardSection with the same `name` (see its `activeTab`). Only the selected tab is a Tab stop;
// ArrowLeft, ArrowRight, Home and End move focus along the row and select the tab they land on.
// `tabs` is [{ id, label, count?, tone?, hint?, testId }]. A `tone` ('warn') marks the count, and
// its `hint` says why in words, for a screen reader and on hover, so the tone is never colour alone.
export function BoardTabs({ name, label, tabs, value, onChange }) {
  const move = (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const elements = [...event.currentTarget.querySelectorAll('[role="tab"]')];
    const at = elements.indexOf(event.target);
    const last = elements.length - 1;
    const to = {
      ArrowRight: at === last ? 0 : at + 1,
      ArrowLeft: at === 0 ? last : at - 1,
      Home: 0,
      End: last,
    }[event.key];
    if (at < 0 || to === undefined) return;
    event.preventDefault();
    elements[to].focus();
    onChange(tabs[to].id);
  };
  return (
    <div className="board-tabs" role="tablist" aria-label={label} onKeyDown={move}>
      {tabs.map((tab) => (
        <DashboardTooltip key={tab.id} title={tab.hint} describeChild>
          <button
            type="button"
            role="tab"
            id={tabDomId(name, tab.id)}
            className="board-tab"
            aria-selected={tab.id === value}
            aria-controls={tabPanelDomId(name)}
            tabIndex={tab.id === value ? 0 : -1}
            data-tone={tab.tone}
            data-testid={tab.testId}
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
            {tab.count !== undefined && <span className="board-tab-count">{tab.count}</span>}
            {tab.hint && <span className="sr-only">{tab.hint}</span>}
          </button>
        </DashboardTooltip>
      ))}
    </div>
  );
}

// An amber chip in the toolbar: a stale or partial result the screen should not hide. The text is
// one line; when it does not fit (or the note is open) a toggle with no text shows the whole of it.
// `defaultOpen` starts it expanded, for a note that carries a link.
export function BoardNote({ testId, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  const [overflows, setOverflows] = useState(false);
  const textRef = useRef(null);
  const textId = useId();
  const toggle = () => setOpen((value) => !value);
  // Only a collapsed note is measured: an open one wraps, so it never overflows.
  useLayoutEffect(() => {
    const text = textRef.current;
    if (open) return undefined;
    const measure = () => setOverflows(text.scrollWidth > text.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(text);
    return () => observer.disconnect();
  }, [open, children]);
  return (
    <p
      className="board-note"
      role="status"
      data-testid={testId}
      data-open={open ? 'true' : 'false'}
    >
      <span className="board-note-glyph" aria-hidden="true" />
      <span className="board-note-text" id={textId} ref={textRef}>
        {children}
      </span>
      {(overflows || open) && (
        <button
          type="button"
          className="board-note-toggle"
          aria-label={open ? 'Collapse note' : 'Show full note'}
          aria-expanded={open}
          aria-controls={textId}
          onClick={toggle}
        />
      )}
    </p>
  );
}

// What the body shows instead of a board: `loading` (the shared spinner line), or a dashed box
// that is `empty` (the default), an `error` or a `warning`.
const STATE_TAGS = { empty: 'div', error: 'div', warning: 'p' };

export function BoardState({ kind = 'empty', testId, label, children }) {
  if (kind === 'loading') return <LoadingState label={label} testId={testId} />;
  const Tag = STATE_TAGS[kind];
  return (
    <Tag className="board-state" data-kind={kind} data-testid={testId}>
      {children}
    </Tag>
  );
}

// The board: a frame around one scrolling region of columns. Its scrollLeft and every column's
// scrollTop survive re-renders. `frameRef` lets the owner read the frame (Slack resolves the
// opener of its thread dialog inside it).
export function Board({ label, testId, frameRef, children }) {
  const ownRef = useRef(null);
  const ref = frameRef ?? ownRef;
  usePreservedInteraction(ref);
  return (
    <div className="board-frame" ref={ref}>
      <div
        className="board-track"
        role="region"
        aria-label={label}
        tabIndex={0}
        data-testid={testId}
      >
        {children}
      </div>
    </div>
  );
}

// One column of the board: a header with its name and count, then a scrolling list of rows.
export function BoardColumn({ id, label, count, testIdPrefix, kind, hint, children }) {
  const titleId = `${testIdPrefix}title-${id}`;
  const heading = (
    <h3 className="board-column-title" id={titleId} tabIndex={hint ? 0 : undefined}>
      {label}
    </h3>
  );
  // Count 0 and nothing to list: a rail beside a populated column (board.css). A lane that holds
  // only a Load more item has children, so it is not empty.
  const empty = Number(count) === 0 && Children.toArray(children).length === 0;
  return (
    <section
      className="board-column"
      role="group"
      data-empty={empty ? 'true' : undefined}
      data-jira-status-kind={kind}
      data-testid={`${testIdPrefix}${id}`}
      aria-labelledby={titleId}
    >
      <div className="board-column-head" data-testid={`${testIdPrefix}head-${id}`}>
        {hint ? (
          <DashboardTooltip title={hint} describeChild slotProps={{ transition: { timeout: 0 } }}>
            {heading}
          </DashboardTooltip>
        ) : (
          heading
        )}
        <span className="board-column-count" data-testid={`${testIdPrefix}count-${id}`}>
          {count}
        </span>
      </div>
      <ul className="board-column-body" data-testid={`${testIdPrefix}body-${id}`} tabIndex={0}>
        {children}
      </ul>
    </section>
  );
}
