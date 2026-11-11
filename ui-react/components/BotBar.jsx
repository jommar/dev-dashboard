// BotBar.jsx — the strip of mascots along the bottom of every screen: one bot per Claude session
// that belongs to a PR or its code review (BOT_PHASES in ui/bot-bar.js says which), each in the
// state of that session. A bot is a button: it opens the same Claude dialog the My Tickets card and
// the PR card open. The strip is an overlay (position: fixed, see bot-bar.css) and takes no room, so
// no screen's height or its viewport-fill layout changes.
//
// It polls GET /api/claude/tickets itself, on every screen, through its own `useClaudeTickets`
// (every CLAUDE_POLL_MS while the page is visible; a failed read keeps the last answer). A bot is
// drawn only for a ticket Jira places in an active sprint (GET /api/active-sprint-tickets, asked
// every SPRINT_POLL_MS and when a new ticket appears, through `useActiveSprintKeys`): until that
// answer is in, or when Jira cannot say, it draws nothing for the ticket. It draws nothing at all
// while there is nothing to show. A finished bot leaves after DONE_TTL_MS and
// a finished or failed bot can be dismissed; both are remembered in memory only.
//
// Working bots patrol, waiting (idle) ones wander, done ones stroll and failed ones stand slumped;
// under reduced motion every bot stands still.
//
// A bot is memoized on plain values, so a poll that finds nothing new, or a re-render of the app,
// never restarts its walk, and a state change replays its own pose (the hop, the shake) once.
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useActiveSprintKeys } from '../hooks/useActiveSprintKeys.js';
import { useBotCallouts } from '../hooks/useBotCallouts.js';
import { useClaudeTickets } from '../hooks/useClaudeTickets.js';
import { ClaudeDialog } from './ClaudeDialog.jsx';
import { ClaudePlaceholderDialog } from './ClaudePlaceholderDialog.jsx';
import { claudePhrase } from './ClaudeIcon.jsx';
import { DashboardTooltip } from './Primitives.jsx';
import { mascotFor } from '../lib/mascot-for.js';
import {
  BOT_STATE_WORDS,
  CALLOUT_TEXT,
  NO_MEMORY,
  botPose,
  botsFromTickets,
  dismissBot,
  inActiveSprint,
  laneStyle,
  liveBots,
  nextBotChange,
  rememberBots,
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
  state,
  reason,
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
  const label = `${ticket} ${phase}: ${BOT_STATE_WORDS[state]}`;
  const { Component } = mascot;
  return (
    <div
      className="bot-bar-lane"
      data-state={state}
      data-fading={fading ? 'true' : undefined}
      style={{ ...laneStyle(roam, rest), '--bot-layer': layer }}
    >
      <div className="bot-bar-face">
        {/* The app's own popup (the board's DashboardTooltip: it shows on keyboard focus too), never a
            native title attribute: MUI adds one when a tooltip is declared the description of its
            child, so that option stays off, and the button keeps its own aria-label. */}
        <DashboardTooltip
          title={`${label} · ${claudePhrase({ state, reason })}`}
          slotProps={{ transition: { timeout: 0 } }}
        >
          <button
            type="button"
            className="bot-bar-bot"
            data-testid={`bot-bar-bot-${ticket}-${phase}`}
            data-state={state}
            data-phase={phase}
            data-mascot={mascot.id}
            aria-label={label}
            aria-haspopup="dialog"
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
            {`${ticket} · ${CALLOUT_TEXT[calloutState]}`}
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
  const claude = useClaudeTickets({ active: true, source: 'bot-bar' });
  // Sessions that qualify by phase and state, then only the tickets Jira places in an active sprint.
  const sessions = useMemo(() => botsFromTickets(claude.byTicket), [claude.byTicket]);
  const ticketKeys = useMemo(() => [...new Set(sessions.map(({ ticket }) => ticket))], [sessions]);
  const sprintKeys = useActiveSprintKeys(ticketKeys);
  const bots = useMemo(() => inActiveSprint(sessions, sprintKeys), [sessions, sprintKeys]);
  const [memory, setMemory] = useState(NO_MEMORY);
  // Bumped when a done bot starts to fade or is due to leave, the only change with no new data.
  const [clock, setClock] = useState(0);
  const [open, setOpen] = useState(null);

  useEffect(() => {
    setMemory((previous) => rememberBots(previous, bots, Date.now()));
  }, [bots]);

  useEffect(() => {
    const wait = nextBotChange(bots, memory, Date.now());
    if (wait === null) return undefined;
    const timer = setTimeout(() => setClock((count) => count + 1), Math.min(wait, LONGEST_WAIT_MS));
    return () => clearTimeout(timer);
  }, [bots, memory, clock]);

  // `clock` is not read: it is what makes the list be worked out again when a done bot's time comes.
  const visible = useMemo(() => liveBots(bots, memory, Date.now()), [bots, memory, clock]);
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
  const { callouts, announcements, attend } = useBotCallouts(
    claude.byTicket,
    claude.loaded,
    visible,
  );

  const openBot = useCallback((ticket, phase) => setOpen({ ticket, phase }), []);
  const dismiss = useCallback(
    (key, state) => setMemory((previous) => dismissBot(previous, { key, state })),
    [],
  );
  const close = useCallback(() => setOpen(null), []);

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
              state={bot.state}
              reason={bot.reason}
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
      {/* Beside the strip, never inside it: a dialog inherits the strip's pointer-events: none. */}
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
      {open?.phase === 'implement' && (
        <ClaudeDialog
          key={open.ticket}
          ticketKey={open.ticket}
          summary=""
          entry={entry}
          onClose={close}
          launch={claude.launch}
          answer={claude.answer}
          approve={claude.approve}
        />
      )}
    </>
  );
}
