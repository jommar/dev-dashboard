// SessionsDrawer.jsx — the list of Claude sessions behind the bot bar's edge tab, so a session can be
// opened or continued from any screen. The tab is a fixed button on the right edge; the drawer is a
// non-modal panel (the app stays usable beside it) that opens over the screen without changing any
// screen's height. Its rows are the bar's own sessions (BotBar works them out and hands them in),
// grouped by what they need: Needs you, Working, Failed, Done, one compact line each, with one search
// box over everything a row shows (filterSessionGroups). Each row also says when its session was last
// active ("9m ago", read as "active 9m ago"), and a working one that has been quiet for a while is flagged (isQuiet). A
// row opens the same Claude dialog the bot opens, and a session there is to join gets a button that
// copies its join command, the same as the dialog's "Go to session". A row with a session id also links
// to that session in the Chat screen, as an icon (the Chat tab's) with "Chat" in the tooltip; a standalone chat's row (no ticket, its title in place of the
// ticket) opens in Chat instead of a dialog (BotBar's open handler). The header's "New chat" link is
// the Chat screen's own (`#/chat`, a fresh conversation), shown with or without sessions. The rows are mounted only while
// the drawer is open, so nothing here is on the page, or in its accessibility tree, while it is shut.
// Each row also shows the tokens its session used (useSessionsUsage: read when the drawer opens, never polled),
// and the header's "Notify me" switch turns on the desktop notification for sessions that need you.
// Escape closes it and puts focus back on the tab. The list itself (groups, rows) is SessionsBody, a lazy
// overlay BotBar loads before the drawer opens; this file keeps the tab, the search and every piece of state.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { notifyClaudeTicketsChanged } from '../hooks/useClaudeTickets.js';
import { useSessionsUsage } from '../hooks/useSessionsUsage.js';
import { stopSession } from '../lib/api.js';
import { useHarness } from '../lib/harness-context.js';
import { useUsageAppUrl } from '../lib/usage-app-context.js';
import { SessionsBody } from '../lib/lazy-overlays.js';
import { Button, DashboardTooltip } from './Primitives.jsx';
import { EdgeDrawer } from './EdgeDrawer.jsx';
import { StatusMark } from './ClaudeSteps.jsx';
import { claudePhrase } from './ClaudeIcon.jsx';
import { LazyDialog } from './ScreenSlot.jsx';
import { BOT_STATE_WORDS, filterSessionGroups, isQuiet } from '../../ui/bot-bar.js';
import { copyText } from '../../ui/dom.js';
import { say } from '../../ui/harness.js';
import { notifyStateLabel, notifyTooltip } from '../../ui/needs-you.js';
import { PHASES, phaseWords as phaseOf } from '../../ui/session-phases.js';

const MARK = { working: 'running', waiting: 'attention', done: 'done', failed: 'failed' };
function stateText({ state, reason, phase }) {
  // A chat has no reason to give: it is working, done or failed.
  if (phase === 'chat') return BOT_STATE_WORDS[state];
  const reasonPhrase = claudePhrase({ state, reason });
  return reasonPhrase === BOT_STATE_WORDS[state]
    ? reasonPhrase
    : `${BOT_STATE_WORDS[state]} · ${reasonPhrase}`;
}
const copyWord = (goTo) => (goTo.kind === 'attach' ? 'Copy attach' : 'Copy resume');
// What the search matches: the title or ticket, the phase words, the state text, the copy button's word
// and `quiet` for a quiet working session. The time itself is not searched.
const searchText = (row, now) =>
  [
    row.title ?? row.ticket,
    phaseOf(row.phase),
    stateText(row),
    row.goTo ? copyWord(row.goTo) : '',
    isQuiet(row, now) ? 'quiet' : '',
  ].join(' ');
// A row with what the lazy list shows of it, so the list imports none of the shared modules these come
// from. The words of a phase are the tooltip of its icon, the row button's name and what the search
// matches; a phase not in PHASES has no `meta` (icon and colour) and shows its words in the detail instead.
const dressed = (row) => {
  const meta = PHASES[row.phase];
  const words = phaseOf(row.phase);
  const state = stateText(row);
  return {
    ...row,
    meta,
    words,
    mark: <StatusMark status={MARK[row.state]} />,
    detail: meta ? state : `${words} · ${state}`,
    copyWord: row.goTo && copyWord(row.goTo),
  };
};
// How long "Copied" (or "Copy failed") shows on a row's copy button.
const COPIED_MS = 2000;
// How often the open drawer reads the clock again, so "9m ago" and the quiet flag age on screen.
const ACTIVITY_CLOCK_MS = 30_000;

// The header's "Notify me" switch: an opt-in desktop notification (and tab-title count) when a session
// needs you while this page is hidden. Pressing it is the user gesture that asks the browser for
// permission; a refusal leaves it off and the drawer says why (`notifyBlocked`, below the header).
// The state shows as a visible word too (`sessions-notify-state`, aria-hidden), so it never rests on
// colour alone; the name stays "Notify me" and aria-pressed carries the state for assistive tech.
function NotifyToggle({ notify, noteId }) {
  const label = notifyStateLabel(notify);
  const tipId = useId();
  // The tooltip describes the button while open (describeChild), never names it. The button's own
  // aria-describedby would replace the tooltip's, so the popup's id is listed with the note's.
  const describedBy = notifyBlocked(notify) ? `${tipId} ${noteId}` : tipId;
  return (
    <DashboardTooltip title={notifyTooltip(notify)} describeChild id={tipId} placement="bottom">
      <Button
        className="subtle sessions-notify"
        data-testid="sessions-notify"
        aria-pressed={notify.active}
        aria-describedby={describedBy}
        onClick={() => (notify.active ? notify.disable() : notify.enable())}
      >
        Notify me
        <span
          className="sessions-notify-state"
          data-testid="sessions-notify-state"
          data-state={label.toLowerCase()}
          aria-hidden
        >
          {label}
        </span>
      </Button>
    </DashboardTooltip>
  );
}
const notifyBlocked = (notify) => Boolean(notify?.supported) && notify.permission === 'denied';

export function SessionsDrawer({ groups, open, onToggle, onOpenSession, notify, drawerId }) {
  const harness = useHarness();
  const usageAppUrl = useUsageAppUrl();
  const count = groups.reduce((total, { rows }) => total + rows.length, 0);
  const waiting = groups.find(({ state }) => state === 'waiting')?.rows.length ?? 0;
  const notifyNoteId = useId();
  const tab = useRef(null);
  // The row whose copy button is showing its outcome: { key, outcome }.
  const [copied, setCopied] = useState(null);
  const [query, setQuery] = useState('');
  // The time the rows are aged against. It is read again while the drawer is open, and only then.
  const [now, setNow] = useState(() => Date.now());
  // Each row's tokens: asked once per open for every row's session, not per search.
  const usage = useSessionsUsage({ groups, active: open });
  const shown = useMemo(
    () => filterSessionGroups(groups, query, (row) => searchText(row, now)),
    [groups, query, now],
  );

  useEffect(() => {
    if (!open) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), ACTIVITY_CLOCK_MS);
    return () => clearInterval(timer);
  }, [open]);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(null), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  // Closing from the drawer's own controls puts the focus back on the tab that opened it. A row that
  // goes to Chat closes the drawer too (BotBar), so it does the same.
  const close = () => {
    onToggle(false);
    tab.current?.focus();
  };
  const openRow = (ticket, phase) => {
    onOpenSession(ticket, phase);
    if (phase === 'chat') tab.current?.focus();
  };

  const copy = async (key, command) => {
    const ok = await copyText(command);
    setCopied({ key, outcome: ok ? 'Copied' : 'Copy failed' });
  };

  // Ends a working session's process, then has every reader of the tickets list ask again at once.
  const stop = async (session) => {
    const result = await stopSession(session);
    notifyClaudeTicketsChanged();
    return result;
  };

  return (
    <EdgeDrawer
      name="sessions"
      id={drawerId}
      open={open}
      onToggle={onToggle}
      tabRef={tab}
      slot="upper"
      label="Sessions"
      count={count}
      attention={waiting > 0}
      tabLabel={say(`{name} sessions, ${count}${waiting ? `, ${waiting} need you` : ''}`, harness)}
      title={say('{name} sessions', harness)}
      closeLabel="Close session list"
      actions={
        <>
          {notify?.supported && <NotifyToggle notify={notify} noteId={notifyNoteId} />}
          <Button href="#/chat" className="subtle" data-testid="sessions-new-chat" onClick={close}>
            New chat
          </Button>
        </>
      }
    >
      {notifyBlocked(notify) && (
        <p id={notifyNoteId} className="sessions-notify-note" data-testid="sessions-notify-note">
          Notifications are blocked in the browser settings.
        </p>
      )}
      {count > 0 && (
        <div className="sessions-search">
          <input
            type="search"
            data-testid="sessions-search"
            aria-label="Search sessions"
            placeholder="Search sessions"
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              // Escape clears a search first; only an empty box lets it close the drawer.
              if (event.key === 'Escape' && query) {
                event.preventDefault();
                setQuery('');
              }
            }}
          />
        </div>
      )}
      <LazyDialog label="The session list" onClose={onToggle}>
        <SessionsBody
          empty={say('No {name} sessions for tickets in an active sprint.', harness)}
          count={count}
          shown={shown}
          dress={dressed}
          now={now}
          copied={copied}
          usage={usage}
          usageAppUrl={usageAppUrl}
          onOpen={openRow}
          onCopy={copy}
          onStop={stop}
          onClose={close}
        />
      </LazyDialog>
    </EdgeDrawer>
  );
}
