// ClaudeIcon.jsx — the Claude entry point on a My Tickets card. The button shows where the
// ticket stands with Claude and opens the panel's one Claude dialog. The state is a word in the
// label and tooltip, and a badge shape beside the mark (a ring for working, a dot for waiting, a
// check for done, a cross for failed), so colour never carries it alone. A ticket with no workflow
// record shows its groom session instead (same looks, and the words say grooming). Presentational
// only: the entry comes from useClaudeTickets and the click hands the ticket key to the panel.

// What an entry's reason reads as; a state with no reason of its own is "not started".
const PHRASES = {
  running: 'working',
  starting: 'starting',
  blocked: 'blocked, needs you',
  questions: 'has questions for you',
  answers_not_sent: 'answers not sent',
  plan_not_done: 'plan not done',
  plan_ready: 'plan ready',
  implemented: 'implemented',
  finished: 'finished',
  plan_missing: 'plan file missing',
  ended_without_flag: 'ended without finishing',
  session_missing: 'session no longer listed',
  listing_unavailable: 'status unavailable',
  unrecognised_state: 'status unavailable',
};

export function claudePhrase(entry) {
  if (!entry || entry.state === 'none') return 'not started';
  return PHRASES[entry.reason] ?? 'status unavailable';
}

// The badge in the corner of the mark. Working is a broken ring so its turning shows; the ring
// stays a ring when motion is reduced.
const BADGES = {
  working: <circle className="claude-icon-ring" cx="18" cy="18" r="4" />,
  waiting: <circle cx="18" cy="18" r="3.2" fill="currentColor" stroke="none" />,
  done: <path d="M15 18.2 17.2 20.4 21.2 15.6" />,
  failed: <path d="M15.6 15.6l4.8 4.8m0-4.8-4.8 4.8" />,
};

// Grooming is not part of the workflow, so it stands in only while the workflow has not started.
const isGrooming = (entry) =>
  entry?.state === 'none' && Boolean(entry.groom) && entry.groom.state !== 'none';

export function ClaudeIcon({
  ticketKey,
  entry: listed,
  onOpen,
  label: overrideLabel,
  testId,
  tooltip = true,
}) {
  const grooming = isGrooming(listed);
  const entry = grooming ? listed.groom : listed;
  const state = entry?.state ?? 'none';
  const label = overrideLabel ?? `Claude${grooming ? ' grooming' : ''}: ${claudePhrase(entry)}`;
  return (
    <button
      type="button"
      className="claude-icon"
      data-testid={testId ?? `claude-icon-${ticketKey}`}
      data-state={state}
      data-reason={entry?.reason ?? undefined}
      data-tooltip={tooltip ? label : undefined}
      aria-label={label}
      aria-haspopup="dialog"
      onClick={() => onOpen?.(ticketKey)}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        {/* A six-spoke burst: at 18px it reads faster than any brand mark would. */}
        <path d="M10 3v14M3.9 6.5l12.2 7M3.9 13.5l12.2-7" />
        {BADGES[state]}
      </svg>
    </button>
  );
}
