// ClaudeSteps.jsx — the pieces of the Claude dialogs that show where a ticket stands (the pill and
// the dismiss button are shared with the Pull Requests review dialog):
// the status pill's icon, the three workflow steps (Investigate and plan -> Approve -> Implement
// plan) with what each reads as, and the small chip that copies a session's join command. All
// presentational: the dialog owns every action, block reason and request, and hands the buttons in.
// Colour never carries a state alone: every mark has a shape and every step a word.
import { Button } from './Primitives.jsx';
import { claudePhrase } from './ClaudeIcon.jsx';

const INVESTIGATE = 'investigate-and-plan';
const IMPLEMENT = 'implement-plan';

const MARK_PATHS = {
  done: <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />,
  failed: <path d="M5 5l6 6m0-6-6 6" />,
  blocked: <path d="M5 7.5V6a3 3 0 0 1 6 0v1.5M4.5 7.5h7v5h-7z" />,
};

// A 16px glyph that takes its colour from the text around it. `running` is the broken ring that
// turns (and stays a still ring when motion is reduced), `attention` a filled dot, `ready` a ring
// with a dot, and `todo` an empty ring.
export function StatusMark({ status }) {
  return (
    <svg
      className="claude-mark"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {status === 'running' && <circle className="claude-icon-ring" cx="8" cy="8" r="5.5" />}
      {status === 'attention' && <circle cx="8" cy="8" r="3.4" fill="currentColor" stroke="none" />}
      {status === 'ready' && (
        <>
          <circle cx="8" cy="8" r="5.5" />
          <circle cx="8" cy="8" r="1.8" fill="currentColor" stroke="none" />
        </>
      )}
      {status === 'todo' && <circle cx="8" cy="8" r="5.5" />}
      {MARK_PATHS[status]}
    </svg>
  );
}

// The header pill's tone and mark, from the ticket's state.
const PILL = {
  working: { tone: 'working', mark: 'running' },
  waiting: { tone: 'attention', mark: 'attention' },
  done: { tone: 'done', mark: 'done' },
  failed: { tone: 'failed', mark: 'failed' },
  unknown: { tone: 'idle', mark: 'todo' },
};

// `label` is spoken before the word ("Code review: finished") and not drawn, for a pill whose
// heading is drawn beside it.
export function StatePill({ entry, label, ...props }) {
  const { tone, mark } = PILL[entry?.state] ?? { tone: 'idle', mark: 'todo' };
  return (
    <p className="claude-dialog-state" role="status" data-tone={tone} {...props}>
      <StatusMark status={mark} />
      {label && <span className="sr-only">{`${label}: `}</span>}
      {claudePhrase(entry)}
    </p>
  );
}

const capitalise = (text) => text.charAt(0).toUpperCase() + text.slice(1);

// "7:39 AM" for today, "Nov 10, 7:39 AM" for another day.
export function stampOf(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const time = { hour: 'numeric', minute: '2-digit' };
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString([], time)
    : date.toLocaleString([], { month: 'short', day: 'numeric', ...time });
}

// Where each of the three steps stands, in workflow order: `status` (done, running, attention,
// ready, blocked or todo) shapes the step's mark and rail, `caption` is its word, `variant` says how
// its button looks (`primary` for the one step to act on now, `ghost` for a step that is finished and
// only re-runs, otherwise a plain outline). Only the first step the user can act on is primary, so
// the dialog never offers two primaries; once a plan exists and is approved, a re-run of
// Investigate and plan is quiet.
export function workflowSteps(entry) {
  const { blocks, flags = {}, phase, state } = entry;
  const planned = flags[INVESTIGATE] === true;
  const implementing = phase === IMPLEMENT;
  const unknown = state === 'unknown';
  const working = state === 'working';

  let investigate = { status: 'todo', caption: 'Not started' };
  if (unknown) investigate = { status: 'blocked', caption: 'Status unavailable' };
  else if (working && !implementing) investigate = { status: 'running', caption: 'Running' };
  else if (planned && (implementing || state === 'done'))
    investigate = {
      status: 'done',
      caption: implementing ? 'Done' : capitalise(claudePhrase(entry)),
    };
  else if (planned) investigate = { status: 'attention', caption: capitalise(claudePhrase(entry)) };
  else if (!blocks.investigate) investigate = { status: 'ready', caption: 'Ready' };

  const approveReady = !blocks.approve;
  const approve = flags.approved
    ? {
        status: 'done',
        caption: entry.approvedAt ? `Approved ${stampOf(entry.approvedAt)}`.trim() : 'Approved',
      }
    : approveReady
      ? { status: 'ready', caption: 'Ready to approve' }
      : { status: 'blocked', caption: unknown ? 'Status unavailable' : 'Waiting' };

  let implement = { status: 'blocked', caption: unknown ? 'Status unavailable' : 'Waiting' };
  if (working && implementing) implement = { status: 'running', caption: 'Running' };
  else if (implementing && state === 'done') implement = { status: 'done', caption: 'Implemented' };
  else if (!blocks.implement) implement = { status: 'ready', caption: 'Ready' };

  const current =
    !planned && !blocks.investigate
      ? 'investigate'
      : !blocks.approve
        ? 'approve'
        : !blocks.implement && !implementing
          ? 'implement'
          : null;

  const steps = { investigate, approve, implement };
  for (const [name, step] of Object.entries(steps)) {
    step.phase = name;
    step.current = current === name;
    step.variant = step.current ? 'primary' : 'outline';
  }
  // A plan that exists and is not what is being acted on: re-running it is secondary.
  if (planned && current !== 'investigate' && !blocks.investigate) investigate.variant = 'ghost';
  return [investigate, approve, implement];
}

export const BUTTON_CLASS = { primary: 'primary', ghost: 'subtle', outline: '' };

// What a session's join command is called, by `goTo` side.
const GO_TO_LABEL = {
  investigate: 'Go to investigate and plan session',
  implement: 'Go to implement plan session',
  groom: 'Go to groom ticket session',
  e2e: 'Go to e2e check session',
};

// The chip that copies a session's join command. It is only drawn for a session there is to join.
export function SessionChip({ phase, onGoTo }) {
  return (
    <Button
      className="subtle claude-chip"
      data-testid={`claude-action-goto-${phase}`}
      aria-label={GO_TO_LABEL[phase]}
      onClick={onGoTo}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M2.5 4.5 6 8l-3.5 3.5M7.5 12h6" />
      </svg>
      Go to session
    </Button>
  );
}

// The × that clears a message. It is a sibling of the message's live region, never inside it, so the
// region's text stays exactly the message.
export function DismissButton({ onClick, ...props }) {
  return (
    <Button
      className="subtle claude-dismiss"
      aria-label="Dismiss message"
      onClick={onClick}
      {...props}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M4 4l8 8m0-8-8 8" />
      </svg>
    </Button>
  );
}
