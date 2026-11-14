// BotBar.jsx — the strip of mascots along the bottom of every screen: one bot per Claude session
// (investigate, implement, review, groom or e2e check; BOT_PHASES in ui/bot-bar.js says which), each in the
// state of that session. A bot is a button: it opens the same Claude dialog the My Tickets card and
// the PR card open. The strip is an overlay (position: fixed, see bot-bar.css) and takes no room, so
// no screen's height or its viewport-fill layout changes.
//
// It polls GET /api/claude/tickets itself, on every screen, through its own `useClaudeTickets`
// (every CLAUDE_POLL_MS while the page is visible, or hidden too while the user's "Notify me" opt-in is
// on and permitted; a failed read keeps the last answer). A bot is
// drawn only for a ticket Jira places in an active sprint (GET /api/active-sprint-tickets, asked
// every SPRINT_POLL_MS and when a new ticket appears, through `useActiveSprintKeys`): until that
// answer is in, or when Jira cannot say, it draws nothing for the ticket. It draws nothing at all
// while there is nothing to show. A finished bot leaves after DONE_TTL_MS, except a done implement
// bot whose ticket Jira still reports as open, which stays until the ticket is done-kind (see
// `heldDoneBots`); a finished or failed bot can be dismissed. Both are remembered in memory only.
//
// Working bots patrol, waiting (idle) ones wander, done ones stroll and failed ones stand slumped;
// under reduced motion every bot stands still. Each bot carries a poster with its ticket key above
// its head (BotPoster), swaying while it walks.
//
// The same sessions are also a list: SessionsDrawer (a tab on the right edge) shows every session of
// the sprint's bots, grouped by state and not forgotten when a bot fades or is dismissed, each one
// opening the same dialog and offering its join command.
//
// Standalone Claude chats (no ticket) are bots too, added after the sprint filter, so they need no
// sprint and never reach Jira. A chat bot opens the Chat screen on its session instead of a dialog.
//
// A bot is memoized on plain values, so a poll that finds nothing new, or a re-render of the app,
// never restarts its walk, and a state change replays its own pose (the hop, the shake) once.
import { memo, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useActiveSprintKeys } from '../hooks/useActiveSprintKeys.js';
import { useBotCallouts } from '../hooks/useBotCallouts.js';
import { useClaudeTickets } from '../hooks/useClaudeTickets.js';
import { useNeedsYouAlerts, useNotifyPreference } from '../hooks/useNeedsYou.js';
import { BotPoster } from './BotPoster.jsx';
import { ClaudePlaceholderDialog } from './ClaudePlaceholderDialog.jsx';
import { LazyDialog } from './ScreenSlot.jsx';
import { ClaudeDialog, CommandPalette, loadClaudeDialog } from '../lib/lazy-overlays.js';
import { SessionsDrawer } from './SessionsDrawer.jsx';
import { claudePhrase } from './ClaudeIcon.jsx';
import { DashboardTooltip } from './Primitives.jsx';
import { mascotFor } from '../lib/mascot-for.js';
import { hasBoardRefresh, refreshBoard } from '../lib/board-refresh.js';
import { ShortcutsContext } from '../lib/shortcuts-context.js';
import { chatHref } from '../../ui/chat-stream.js';
import { ticketHref } from '../../ui/ticket-link.js';
import {
  BOT_STATE_WORDS,
  NO_MEMORY,
  calloutText,
  botPose,
  botsFromChats,
  botsFromTickets,
  dismissBot,
  heldDoneBots,
  inActiveSprint,
  laneStyle,
  liveBots,
  nextBotChange,
  POSTER_RISE_PX,
  rememberBots,
  sessionGroups,
  walks,
  withSessions,
  ZONES_MIN_WIDTH_PX,
  zoneSpots,
  roamFor,
} from '../../ui/bot-bar.js';

// The longest a timer may wait (setTimeout overflows past 2^31 ms).
const LONGEST_WAIT_MS = 2 ** 30;
// Whether the screen is narrower than the zones' minimum width, where they collapse (the same query
// as the media query in bot-bar.css).
function useNarrow() {
  const query = `(max-width: ${ZONES_MIN_WIDTH_PX - 1}px)`;
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const change = () => setNarrow(list.matches);
    change();
    list.addEventListener('change', change);
    return () => list.removeEventListener('change', change);
  }, [query]);
  return narrow;
}

const isFinished = (state) => state === 'done' || state === 'failed';

const Bot = memo(function Bot({
  botKey,
  ticket,
  phase,
  title,
  state,
  reason,
  verdict,
  fading,
  rest,
  layer,
  calloutState,
  calloutLeaving,
  onOpen,
  onAttend,
  onDismiss,
}) {
  const mascot = mascotFor(botKey);
  const roam = roamFor(botKey);
  const pose = botPose(state, roam);
  const label = `${title ?? `${ticket} ${phase}`}: ${BOT_STATE_WORDS[state]}`;
  // The popup adds the reason, unless it only repeats the state word (a running session reads "working").
  const reasonPhrase = claudePhrase({ state, reason });
  const detail = reasonPhrase === BOT_STATE_WORDS[state] ? label : `${label} · ${reasonPhrase}`;
  const { Component } = mascot;
  return (
    <div
      className="bot-bar-lane"
      data-state={state}
      data-fading={fading ? 'true' : undefined}
      style={{ ...laneStyle(roam, rest), '--bot-layer': layer }}
    >
      {/* Beside the face, not inside it, like the callout: the face is mirrored when the bot turns, and
          the poster's key must never be. It sways while the bot walks and stands still otherwise. */}
      <BotPoster
        botKey={botKey}
        text={ticket}
        moving={walks(state)}
        testId={`bot-bar-poster-${ticket}-${phase}`}
      />
      <div className="bot-bar-face">
        {/* The app's own popup (the board's DashboardTooltip: it shows on keyboard focus too), never a
            native title attribute: MUI adds one when a tooltip is declared the description of its
            child, so that option stays off, and the button keeps its own aria-label. */}
        <DashboardTooltip
          title={detail}
          placement="top"
          slotProps={{
            transition: { timeout: 0 },
            // Above the bot's poster, not over it.
            popper: { modifiers: [{ name: 'offset', options: { offset: [0, POSTER_RISE_PX] } }] },
          }}
        >
          <button
            type="button"
            className="bot-bar-bot"
            data-testid={`bot-bar-bot-${ticket}-${phase}`}
            data-state={state}
            data-phase={phase}
            data-mascot={mascot.id}
            aria-label={label}
            aria-haspopup={phase === 'chat' ? undefined : 'dialog'}
            onMouseEnter={() => onAttend(botKey)}
            onFocus={() => onAttend(botKey)}
            onClick={() => {
              onAttend(botKey);
              onOpen(ticket, phase);
            }}
          >
            <Component state={state} facing={pose.facing} label={label} moving={pose.stepping} />
          </button>
        </DashboardTooltip>
      </div>
      {/* Beside the face, not inside it: the face is mirrored when the bot turns, the bubble never. */}
      {calloutState && (
        <div
          className="bot-bar-callout"
          aria-hidden="true"
          data-testid={`bot-bar-callout-${ticket}-${phase}`}
          data-state={calloutState}
        >
          <span
            className="bot-bar-callout-bubble"
            data-leaving={calloutLeaving ? 'true' : undefined}
          >
            {calloutText(ticket, calloutState, verdict)}
          </span>
        </div>
      )}
      {isFinished(state) && (
        <button
          type="button"
          className="bot-bar-dismiss"
          data-testid={`bot-bar-dismiss-${ticket}-${phase}`}
          aria-label={`Dismiss ${label}`}
          onClick={() => onDismiss(botKey, state)}
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M2 2l6 6M8 2 2 8" />
          </svg>
        </button>
      )}
    </div>
  );
});

export function BotBar() {
  // The opt-in desktop notification: only while it is on and permitted does the bar keep polling a hidden page.
  const notify = useNotifyPreference();
  const claude = useClaudeTickets({ active: true, source: 'bot-bar', whileHidden: notify.active });
  // Sessions that qualify by phase and state, then only the tickets Jira places in an active sprint.
  const sessions = useMemo(
    () => withSessions(botsFromTickets(claude.byTicket), claude.sessionIds),
    [claude.byTicket, claude.sessionIds],
  );
  const ticketKeys = useMemo(() => [...new Set(sessions.map(({ ticket }) => ticket))], [sessions]);
  const sprint = useActiveSprintKeys(ticketKeys);
  const chatBots = useMemo(() => botsFromChats(claude.chats, Date.now()), [claude.chats]);
  const bots = useMemo(
    () => [...inActiveSprint(sessions, sprint?.keys), ...chatBots],
    [sessions, sprint, chatBots],
  );
  // A done implement bot whose ticket is still open in Jira stays until the ticket reaches a
  // done-kind status; its status map is part of the same sprint answer.
  const held = useMemo(() => heldDoneBots(bots, sprint?.statuses), [bots, sprint]);
  const [memory, setMemory] = useState(NO_MEMORY);
  // Bumped when a done bot starts to fade or is due to leave, the only change with no new data.
  const [clock, setClock] = useState(0);
  const [open, setOpen] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // The drawer lists every session of the sprint's bots, past the bar's time to live and dismissals,
  // each with the time it was last active (the same response's `lastActive`).
  const groups = useMemo(
    () => sessionGroups(bots, claude.byTicket, claude.lastActive),
    [bots, claude.byTicket, claude.lastActive],
  );

  useEffect(() => {
    setMemory((previous) => rememberBots(previous, bots, Date.now()));
  }, [bots]);

  useEffect(() => {
    const wait = nextBotChange(bots, memory, Date.now(), { held });
    if (wait === null) return undefined;
    const timer = setTimeout(() => setClock((count) => count + 1), Math.min(wait, LONGEST_WAIT_MS));
    return () => clearTimeout(timer);
  }, [bots, memory, held, clock]);

  // `clock` is not read: it is what makes the list be worked out again when a done bot's time comes.
  const visible = useMemo(
    () => liveBots(bots, memory, Date.now(), { held }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- clock is the recompute trigger for a done bot's time, not a value read
    [bots, memory, held, clock],
  );
  // Where bots stand (a failed bot, or any bot under reduced motion): spread among the bots of the same
  // zone, or among all of them when the screen is narrow and the zones have collapsed.
  const narrow = useNarrow();
  const spots = useMemo(() => zoneSpots(visible, narrow), [visible, narrow]);
  // The most recently done bot is in front of the other done ones.
  const layers = useMemo(() => {
    const done = visible
      .filter(({ state }) => state === 'done')
      .sort((a, b) => (memory.seenDoneAt.get(a.key) ?? 0) - (memory.seenDoneAt.get(b.key) ?? 0));
    return new Map(done.map(({ key }, index) => [key, index + 1]));
  }, [visible, memory]);
  // A chat bot or row goes to the Chat screen; every other session opens its dialog.
  const openBot = useCallback(
    (ticket, phase) => {
      const chat = phase === 'chat' && chatBots.find((bot) => bot.ticket === ticket);
      if (chat) {
        location.hash = chatHref(chat.session);
        setDrawerOpen(false);
      } else if (phase === 'review') setOpen({ ticket, phase });
      else {
        // Load the dialog's code first, then open it (also when the load fails: Reload alert).
        const show = () => setOpen({ ticket, phase });
        loadClaudeDialog().then(show, show);
      }
    },
    [chatBots],
  );
  // A notification for a session that needs the user, and the `(N)` in the tab title, from the same
  // changes that get bubbles; a click on the notification opens that session as a bot would.
  const onReady = useNeedsYouAlerts({ active: notify.active, bots: visible, onOpen: openBot });
  const { callouts, announcements, attend } = useBotCallouts(
    claude.byTicket,
    claude.loaded,
    visible,
    onReady,
  );

  const dismiss = useCallback(
    (key, state) => setMemory((previous) => dismissBot(previous, { key, state })),
    [],
  );
  const close = useCallback(() => setOpen(null), []);
  // The command palette (Ctrl/Cmd+K) is state of the keyboard layer, shared by the app shell.
  const shortcuts = useContext(ShortcutsContext);
  // Stable (the setter, not the context value that changes with the palette), because a failed
  // palette chunk's Reload alert re-opens itself when its `onClose` changes.
  const setPalette = shortcuts?.setPalette;
  const closePalette = useCallback(() => setPalette?.(null), [setPalette]);
  const choose = useCallback(
    (action) => {
      if (action.type === 'tab') shortcuts.onNavigate(action.id);
      else if (action.type === 'session') openBot(action.ticket, action.phase);
      else if (action.type === 'new-chat') location.hash = '#/chat';
      else if (action.type === 'refresh') refreshBoard(action.id);
      else if (action.type === 'ticket') location.hash = ticketHref(action.key);
    },
    [shortcuts, openBot],
  );

  const calloutOf = new Map(callouts.map((callout) => [callout.key, callout]));
  const entry = open && claude.byTicket[open.ticket];
  return (
    <>
      {/* The one polite live region: a message per change, none on first load. */}
      <div className="sr-only" role="status" aria-live="polite" data-testid="bot-bar-live">
        {announcements.map(({ id, text }) => (
          <p key={id}>{text}</p>
        ))}
      </div>
      {visible.length > 0 && (
        <div className="bot-bar" role="group" aria-label="Claude sessions" data-testid="bot-bar">
          {visible.map((bot) => (
            <Bot
              key={bot.key}
              botKey={bot.key}
              ticket={bot.ticket}
              phase={bot.phase}
              title={bot.title}
              state={bot.state}
              reason={bot.reason}
              verdict={bot.verdict}
              fading={bot.fading}
              rest={spots.get(bot.key)}
              layer={layers.get(bot.key)}
              calloutState={calloutOf.get(bot.key)?.state}
              calloutLeaving={calloutOf.get(bot.key)?.leaving}
              onOpen={openBot}
              onAttend={attend}
              onDismiss={dismiss}
            />
          ))}
        </div>
      )}
      {/* The session list, from every screen: a tab on the right edge and the drawer it opens. */}
      <SessionsDrawer
        groups={groups}
        open={drawerOpen}
        onToggle={setDrawerOpen}
        onOpenSession={openBot}
        notify={notify}
      />
      {/* Beside the strip, never inside it: a dialog inherits the strip's pointer-events: none. */}
      {shortcuts?.palette && (
        <LazyDialog label="The command palette" onClose={closePalette}>
          <CommandPalette
            tabs={shortcuts.tabs}
            groups={groups}
            active={shortcuts.palette.active}
            refresh={hasBoardRefresh(shortcuts.palette.active)}
            onChoose={choose}
            onClose={closePalette}
          />
        </LazyDialog>
      )}
      {open?.phase === 'review' && (
        <ClaudePlaceholderDialog
          key={open.ticket}
          ticketKey={open.ticket}
          summary=""
          entry={entry}
          launch={claude.launch}
          rereview={claude.rereview}
          onClose={close}
        />
      )}
      {open && open.phase !== 'review' && (
        <LazyDialog key={open.ticket} label="The Claude dialog" onClose={close}>
          <ClaudeDialog
            ticketKey={open.ticket}
            summary=""
            entry={entry}
            onClose={close}
            launch={claude.launch}
            answer={claude.answer}
            approve={claude.approve}
            continueSession={claude.continueSession}
            sessionIds={claude.sessionIds[open.ticket]}
          />
        </LazyDialog>
      )}
    </>
  );
}
