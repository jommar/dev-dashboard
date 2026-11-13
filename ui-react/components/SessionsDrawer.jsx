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
// Escape closes it and puts focus back on the tab.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button, DashboardTooltip } from './Primitives.jsx';
import { StatusMark } from './ClaudeSteps.jsx';
import { NavIcon } from './NavIcon.jsx';
import { claudePhrase } from './ClaudeIcon.jsx';
import { RelativeTime } from './slack-watch/RelativeTime.jsx';
import {
  BOT_STATE_WORDS,
  QUIET_WORKING_MS,
  filterSessionGroups,
  isQuiet,
} from '../../ui/bot-bar.js';
import { chatHref } from '../../ui/chat-stream.js';
import { copyText } from '../../ui/dom.js';

const MARK = { working: 'running', waiting: 'attention', done: 'done', failed: 'failed' };
const PHASE_WORDS = {
  investigate: 'Investigate and plan',
  implement: 'Implement plan',
  review: 'Code review',
  groom: 'Groom ticket',
  e2e: 'E2E check',
  chat: 'Chat',
};
// The words a row shows after its ticket: the phase, then the state with its reason when it adds one.
const phaseOf = (phase) => PHASE_WORDS[phase] ?? phase;
function stateText({ state, reason, phase }) {
  // A chat has no reason to give: it is working, done or failed.
  if (phase === 'chat') return BOT_STATE_WORDS[state];
  const reasonPhrase = claudePhrase({ state, reason });
  return reasonPhrase === BOT_STATE_WORDS[state]
    ? reasonPhrase
    : `${BOT_STATE_WORDS[state]} · ${reasonPhrase}`;
}
// What the search matches: all of the above, the copy button's word and `quiet` for a quiet working
// session. The time itself is not searched.
const copyWord = (goTo) => (goTo.kind === 'attach' ? 'Copy attach' : 'Copy resume');
const searchText = (row, now) =>
  [
    row.title ?? row.ticket,
    phaseOf(row.phase),
    stateText(row),
    row.goTo ? copyWord(row.goTo) : '',
    isQuiet(row, now) ? 'quiet' : '',
  ].join(' ');
// How long "Copied" shows on a row's copy button.
const COPIED_MS = 2000;
// How often the open drawer reads the clock again, so "9m ago" and the quiet flag age on screen.
const ACTIVITY_CLOCK_MS = 30_000;
// The popup on a row's time: when the session was last written to and, for a quiet one, for how long.
const activityTitle = (iso, quiet) =>
  `Last active ${new Date(iso).toLocaleString()}${
    quiet ? ` · working but quiet for ${QUIET_WORKING_MS / 60_000}+ min` : ''
  }`;

function Row({ row, now, copied, onOpen, onCopy, onClose }) {
  const { key, ticket, phase, state, goTo, lastActiveAt, session } = row;
  const phaseWords = phaseOf(phase);
  // A standalone chat has no ticket; its title is what names it.
  const name = row.title ?? ticket;
  const whenId = useId();
  const quiet = isQuiet(row, now);
  return (
    <li className="sessions-row" data-testid={`sessions-row-${key}`} data-state={state}>
      <button
        type="button"
        className="sessions-row-open"
        data-testid={`sessions-open-${key}`}
        aria-label={`Open ${name} ${phaseWords} session`}
        aria-describedby={lastActiveAt ? whenId : undefined}
        aria-haspopup={phase === 'chat' ? undefined : 'dialog'}
        onClick={() => onOpen(ticket, phase)}
      >
        <span className="sessions-row-mark" data-state={state}>
          <StatusMark status={MARK[state]} />
        </span>
        <span className="sessions-row-ticket">{name}</span>
        <span className="sessions-row-detail">{`${phaseWords} · ${stateText(row)}`}</span>
      </button>
      {lastActiveAt && (
        <span
          id={whenId}
          className="sessions-row-when"
          data-testid={`sessions-when-${key}`}
          data-quiet={quiet ? 'true' : undefined}
        >
          {quiet && <span className="sr-only">quiet, </span>}
          <span className="sr-only">active </span>
          <RelativeTime iso={lastActiveAt} now={now} title={activityTitle(lastActiveAt, quiet)} />
        </span>
      )}
      {session && phase !== 'chat' && (
        <DashboardTooltip title="Chat" placement="left">
          <a
            className="sessions-row-chat"
            href={chatHref(session)}
            onClick={onClose}
            data-testid={`sessions-chat-${key}`}
            aria-label={`Chat with ${ticket} ${phaseWords} session`}
          >
            <NavIcon name="chat" />
          </a>
        </DashboardTooltip>
      )}
      {goTo && (
        <DashboardTooltip title={goTo.command} placement="left">
          <Button
            className="subtle sessions-row-copy"
            data-testid={`sessions-copy-${key}`}
            aria-label={`Copy command to continue ${name} ${phaseWords} session`}
            onClick={() => onCopy(key, goTo.command)}
          >
            {copied ? 'Copied' : copyWord(goTo)}
          </Button>
        </DashboardTooltip>
      )}
    </li>
  );
}

export function SessionsDrawer({ groups, open, onToggle, onOpenSession }) {
  const count = groups.reduce((total, { rows }) => total + rows.length, 0);
  const waiting = groups.find(({ state }) => state === 'waiting')?.rows.length ?? 0;
  const titleId = useId();
  const tab = useRef(null);
  const closeButton = useRef(null);
  const [copied, setCopied] = useState(null);
  const [query, setQuery] = useState('');
  // The time the rows are aged against. It is read again while the drawer is open, and only then.
  const [now, setNow] = useState(() => Date.now());
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
    if (!open) return undefined;
    closeButton.current?.focus();
    const onKey = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // A modal dialog over the drawer takes Escape for itself.
      if (document.querySelector('dialog[open]')) return;
      onToggle(false);
      tab.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onToggle]);

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
    setCopied(ok ? key : null);
  };

  return (
    <>
      <button
        ref={tab}
        type="button"
        className="sessions-tab"
        data-testid="sessions-tab"
        data-attention={waiting > 0 ? 'true' : undefined}
        aria-expanded={open}
        aria-controls={`${titleId}-drawer`}
        aria-label={`Claude sessions, ${count}${waiting ? `, ${waiting} need you` : ''}`}
        onClick={() => onToggle(!open)}
      >
        <span aria-hidden="true">Sessions</span>
        <span className="sessions-tab-count" aria-hidden="true">
          {count}
        </span>
      </button>
      <aside
        id={`${titleId}-drawer`}
        className="sessions-drawer"
        data-testid="sessions-drawer"
        aria-labelledby={titleId}
        hidden={!open}
      >
        {open && (
          <>
            <header className="sessions-head">
              <h2 id={titleId}>Claude sessions</h2>
              <div className="sessions-head-actions">
                <Button
                  href="#/chat"
                  className="subtle"
                  data-testid="sessions-new-chat"
                  onClick={close}
                >
                  New chat
                </Button>
                <Button
                  ref={closeButton}
                  className="subtle"
                  data-testid="sessions-close"
                  aria-label="Close session list"
                  onClick={close}
                >
                  Close
                </Button>
              </div>
            </header>
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
            <div className="sessions-body" data-testid="sessions-body">
              {count === 0 ? (
                <p className="sessions-empty" data-testid="sessions-empty">
                  No Claude sessions for tickets in an active sprint.
                </p>
              ) : shown.length === 0 ? (
                <p className="sessions-empty" data-testid="sessions-no-match">
                  No sessions match your search.
                </p>
              ) : (
                shown.map(({ state, title, rows }) => (
                  <section key={state} className="sessions-group" data-testid={`sessions-${state}`}>
                    <h3>
                      {title}
                      <span className="sessions-group-count">{rows.length}</span>
                    </h3>
                    <ul>
                      {rows.map((row) => (
                        <Row
                          key={row.key}
                          row={row}
                          now={now}
                          copied={copied === row.key}
                          onOpen={openRow}
                          onCopy={copy}
                          onClose={close}
                        />
                      ))}
                    </ul>
                  </section>
                ))
              )}
            </div>
          </>
        )}
      </aside>
    </>
  );
}
