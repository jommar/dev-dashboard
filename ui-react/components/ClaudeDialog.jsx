// ClaudeDialog.jsx — the one Claude menu for My Tickets, opened by a card's icon. A native modal
// <dialog> rather than a popup in the card: cards and columns clip overflow, and a card that
// remounts would lose its state. The panel mounts it only while a ticket is open (keyed by the
// ticket), so its drafts, errors and copy status begin empty each time. It holds the four items
// (Investigate and plan, Implement plan, and a Go to session for each of those two sessions) and,
// when the planning session asked any, the questions as text inputs. A disabled item says why in words beside it.
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from './Primitives.jsx';
import { claudePhrase } from './ClaudeIcon.jsx';
import { copyText } from '../../ui/dom.js';

const INVESTIGATE = 'investigate-and-plan';
const IMPLEMENT = 'implement-plan';

// Why an action is blocked or failed, as one sentence. The server sends the reason; the wording is
// the dashboard's, and it serves both the hint beside a disabled item and the line after a failure.
const REASON_TEXT = {
  untrusted_workspace:
    'Claude does not trust ~/pathwise yet. Run claude there once and accept the trust prompt.',
  timed_out: 'Claude took too long to start. Check Go to session before launching again.',
  spawn_failed: 'Could not start Claude. Is the claude command installed?',
  listing_unavailable: 'Claude status is unavailable.',
  session_running: 'A Claude session is already running for this ticket.',
  investigate_running: 'Investigate and plan is still running.',
  implement_running: 'Implement plan is running.',
  session_not_found: 'The Claude session could not be found.',
  live_at_resume: 'The Claude session is still running.',
  resume_failed: 'The Claude session could not be resumed.',
  answers_not_sent:
    'All questions are answered, but they have not been sent to the session. Press Save answers to send them.',
  plan_not_done: 'Claude has not marked the plan done. Check the session before implementing.',
  not_planned: 'Run Investigate and plan first.',
  plan_missing: 'The plan file was not found.',
  questions_unanswered: 'Answer the open questions first.',
  status_unreadable: "The ticket's status file cannot be read.",
};

// What a save says about routing the answers to the session, by the server's `send` outcome.
const SKIPPED_TEXT = {
  unchanged: 'Saved. The answers had not changed, so nothing was sent.',
  not_planned: 'Saved. The plan is not ready yet, so nothing was sent.',
  implement_started: 'Saved. Implement plan has started, so nothing was sent.',
};

function sendText({ send, ticket }) {
  if (send?.status === 'sent') return 'Answers sent. Claude is updating the plan.';
  if (send?.status === 'failed') {
    const why = REASON_TEXT[send.reason].replace(/\.$/, '');
    return `Answers saved, but they could not be sent: ${why}. Save again to retry.`;
  }
  if (send?.reason === 'incomplete') {
    const open = ticket.unanswered;
    return `Saved. ${open} question${open === 1 ? ' still needs' : 's still need'} an answer; nothing was sent.`;
  }
  return SKIPPED_TEXT[send?.reason];
}

// The ticket's two sessions, each with its own Go to session item (`goTo` is keyed by the side).
const GO_TO = [
  ['investigate', 'Go to investigate and plan session'],
  ['implement', 'Go to implement plan session'],
];

// A ticket the server lists nothing for has not been started.
const NOT_STARTED = {
  questions: [],
  goTo: { investigate: null, implement: null },
  blocks: { investigate: null, implement: 'not_planned', answer: 'no_questions' },
};

const failureText = ({ errors, error }) =>
  REASON_TEXT[errors?.[0]] ?? error ?? 'The Claude request failed.';

function ClaudeAction({ name, label, disabled, hint, onClick, children }) {
  return (
    <li className="claude-action">
      <Button data-testid={`claude-action-${name}`} disabled={disabled} onClick={onClick}>
        {label}
      </Button>
      {hint && (
        <span className="claude-action-hint" data-testid={`claude-action-hint-${name}`}>
          {hint}
        </span>
      )}
      {children}
    </li>
  );
}

export function ClaudeDialog({ ticketKey, summary, entry: listed, onClose, launch, answer }) {
  const entry = listed ?? NOT_STARTED;
  const { blocks, questions, goTo } = entry;
  const dialogRef = useRef(null);
  // The panel passes fresh callbacks on every render; a ref keeps the Esc listener from being
  // torn down and rebuilt on each poll.
  const close = useRef(onClose);
  close.current = onClose;
  const closeButton = useRef(null);
  // Whether the press that ended in a click began on the backdrop: a drag that starts in an answer
  // field and is released over the backdrop clicks the <dialog> too, and must not close it.
  const pressedBackdrop = useRef(false);
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [drafts, setDrafts] = useState({});
  const [sendResult, setSendResult] = useState('');
  const [copy, setCopy] = useState(null);

  // Open once, trap focus (the browser does that for a modal) and give focus back to the ticket's
  // icon, which the key fully determines (a click does not focus a button in every browser).
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog.showModal();
    // Esc closes through the parent state, the same path as the Close button.
    const cancel = (event) => {
      event.preventDefault();
      close.current();
    };
    dialog.addEventListener('cancel', cancel);
    return () => {
      dialog.removeEventListener('cancel', cancel);
      if (dialog.open) dialog.close();
      document
        .querySelector(`[data-testid="claude-icon-${CSS.escape(ticketKey)}"]`)
        ?.focus({ preventScroll: true });
    };
  }, [ticketKey]);

  // A control that has just been disabled (the item that was clicked, while it runs and once the
  // session works) must not keep keyboard focus: it moves to Close.
  useEffect(() => {
    const focused = document.activeElement;
    if (!focused || focused === document.body || focused.disabled) closeButton.current?.focus();
  }, [busy, blocks.investigate, blocks.implement, blocks.answer]);

  const run = async (action) => {
    setBusy(true);
    setError('');
    const result = await action();
    setBusy(false);
    if (!result.ok) setError(failureText(result));
    return result;
  };

  // Only what differs from the saved answer is sent.
  const changed = Object.fromEntries(
    questions
      .filter(({ id, answer: saved }) => Object.hasOwn(drafts, id) && drafts[id] !== (saved ?? ''))
      .map(({ id }) => [id, drafts[id]]),
  );
  const dirty = Object.keys(changed).length > 0;
  // With nothing changed, Save still asks the server to try sending (the retry of an unsent set).
  const save = async (event) => {
    event.preventDefault();
    setSendResult('');
    const result = await run(() => answer(ticketKey, dirty ? changed : []));
    if (!result.ok) return;
    setSendResult(sendText(result));
    // The saved drafts are dropped; whatever was typed while the request ran is kept.
    setDrafts((current) =>
      Object.fromEntries(Object.entries(current).filter(([id, text]) => changed[id] !== text)),
    );
  };

  const copyCommand = async (side) => {
    const command = goTo[side].command;
    setCopy({ side, command, copied: await copyText(command) });
  };
  // One status at a time, for the item last used: copying the other session's command replaces it.
  // A status for a command the poll has since replaced is not shown.
  const copied = copy?.command === goTo[copy?.side]?.command ? copy : null;

  return (
    <dialog
      ref={dialogRef}
      className="claude-dialog"
      aria-labelledby={titleId}
      data-testid="claude-dialog"
      onPointerDown={(event) => {
        pressedBackdrop.current = event.target === dialogRef.current;
      }}
      onClick={(event) => {
        // A backdrop click targets the <dialog> itself; everything inside it is a child.
        if (event.target === dialogRef.current && pressedBackdrop.current) close.current();
      }}
    >
      <header className="claude-dialog-head">
        <h3 className="claude-dialog-title" id={titleId} data-testid="claude-dialog-title">
          <span className="claude-dialog-key">{ticketKey}</span> {summary}
        </h3>
        <p className="claude-dialog-state" role="status" data-testid="claude-dialog-state">
          {claudePhrase(listed)}
        </p>
      </header>

      <div className="claude-dialog-body">
        <ul className="claude-actions">
          <ClaudeAction
            name="investigate"
            label="Investigate and plan"
            disabled={busy || Boolean(blocks.investigate)}
            hint={REASON_TEXT[blocks.investigate]}
            onClick={() => run(() => launch(ticketKey, INVESTIGATE))}
          />
          <ClaudeAction
            name="implement"
            label="Implement plan"
            disabled={busy || Boolean(blocks.implement)}
            hint={REASON_TEXT[blocks.implement]}
            onClick={() => run(() => launch(ticketKey, IMPLEMENT))}
          >
            {/* Starting the session is the user's approval, so where the plan is stays in view. */}
            {entry.reason === 'plan_ready' && (
              <span className="claude-action-hint" data-testid="claude-plan-hint">
                {`~/pathwise/.orchestrator/${ticketKey.toLowerCase()}/02-plan.md`}
              </span>
            )}
          </ClaudeAction>
          {GO_TO.map(([side, label]) => (
            <ClaudeAction
              key={side}
              name={`goto-${side}`}
              label={label}
              disabled={!goTo[side]}
              hint={goTo[side] ? undefined : 'No session to join'}
              onClick={() => copyCommand(side)}
            />
          ))}
        </ul>

        {error && (
          <p className="claude-error" role="alert" data-testid="claude-error">
            {error}
          </p>
        )}

        {/* Always rendered, so a screen reader hears its text change rather than appear. */}
        <div className="claude-goto" role="status">
          {copied?.copied && <span data-testid={`claude-goto-copied-${copied.side}`}>Copied</span>}
          {copied?.copied === false && "Couldn't copy — copy the command manually"}
        </div>
        {copied?.copied === false && (
          <input
            className="claude-goto-fallback"
            data-testid={`claude-goto-fallback-${copied.side}`}
            readOnly
            value={copied.command}
            aria-label="Session command"
            onFocus={(event) => event.currentTarget.select()}
          />
        )}

        {entry.reason === 'answers_not_sent' && (
          <p className="claude-note" data-testid="claude-answers-hint">
            {REASON_TEXT.answers_not_sent}
          </p>
        )}

        {questions.length > 0 && (
          <form className="claude-questions" data-testid="claude-questions" onSubmit={save}>
            {questions.map(({ id, question, answer: saved }) => (
              <label key={id} className="claude-question">
                <span>{question}</span>
                <input
                  type="text"
                  className="claude-question-input"
                  data-testid={`claude-question-${id}`}
                  maxLength={2000}
                  value={Object.hasOwn(drafts, id) ? drafts[id] : (saved ?? '')}
                  disabled={Boolean(blocks.answer)}
                  onChange={(event) => {
                    const { value } = event.target;
                    setDrafts((current) => ({ ...current, [id]: value }));
                  }}
                />
              </label>
            ))}
            <p className="claude-note" data-testid="claude-questions-progress">
              {`${questions.filter(({ answer: saved }) => saved?.trim()).length} of ${questions.length} answered`}
            </p>
            <p className="claude-note">
              Save as you go. Nothing is sent to the session until every question has an answer.
            </p>
            <Button
              type="submit"
              data-testid="claude-questions-save"
              disabled={busy || Boolean(blocks.answer) || !(dirty || entry.unsent)}
            >
              Save answers
            </Button>
            {/* Always rendered, so a screen reader hears its text change rather than appear. */}
            <p className="claude-note" role="status" data-testid="claude-send-result">
              {sendResult}
            </p>
          </form>
        )}
      </div>

      <footer className="claude-dialog-foot">
        <Button ref={closeButton} data-testid="claude-dialog-close" onClick={() => close.current()}>
          Close
        </Button>
      </footer>
    </dialog>
  );
}
