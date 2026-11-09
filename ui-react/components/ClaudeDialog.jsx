// ClaudeDialog.jsx — the one Claude menu for My Tickets, opened by a card's icon. A native modal
// <dialog> rather than a popup in the card: cards and columns clip overflow, and a card that
// remounts would lose its state. The panel mounts it only while a ticket is open (keyed by the
// ticket), so its drafts, errors and copy status begin empty each time. The body holds one row per
// phase (its run button and its Go to session button side by side, then what a disabled button
// says, in words, under them) and, when the planning session asked any, the numbered questions as
// auto-growing text boxes. The footer stays in view beside the body's scroll: it holds Prompts
// (on the left), Save answers (linked to the questions form by its id), the progress, the result of
// the last save, and Close. Prompts swaps the body for the prompt editor, still in this one dialog:
// the footer then holds Back (the same button, so it keeps focus) and Close, and everything this
// component holds (answer drafts, copy status, the last send result) is there when Back returns.
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from './Primitives.jsx';
import { claudePhrase } from './ClaudeIcon.jsx';
import { ClaudePromptsEditor } from './ClaudePromptsEditor.jsx';
import { copyText } from '../../ui/dom.js';

const INVESTIGATE = 'investigate-and-plan';
const IMPLEMENT = 'implement-plan';
const GROOM = 'groom';

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
  prompt_unreadable:
    "A custom prompt file could not be used. Fix or remove it in the dashboard's prompts folder.",
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

// The full name of each Go to session button (its text is just "Go to session"), by `goTo` side.
const GO_TO_LABEL = {
  investigate: 'Go to investigate and plan session',
  implement: 'Go to implement plan session',
  groom: 'Go to groom ticket session',
};

// A ticket the server lists nothing for has not been started.
const NOT_STARTED = {
  questions: [],
  goTo: { investigate: null, implement: null, groom: null },
  groom: { state: 'none', reason: null },
  blocks: { investigate: null, implement: 'not_planned', answer: 'no_questions', groom: null },
};

const failureText = ({ errors, error }) =>
  REASON_TEXT[errors?.[0]] ?? error ?? 'The Claude request failed.';

// One phase: its run button and its Go to session button side by side, then the hints under both
// (why the run button is off, then whatever the row's `children` add, then why there is no session).
function ClaudeRow({ phase, label, disabled, hint, onRun, noSession, onGoTo, children }) {
  return (
    <li className="claude-action">
      <Button data-testid={`claude-action-${phase}`} disabled={disabled} onClick={onRun}>
        {label}
      </Button>
      <Button
        data-testid={`claude-action-goto-${phase}`}
        aria-label={GO_TO_LABEL[phase]}
        disabled={noSession}
        onClick={onGoTo}
      >
        Go to session
      </Button>
      {hint && (
        <span className="claude-action-hint" data-testid={`claude-action-hint-${phase}`}>
          {hint}
        </span>
      )}
      {children}
      {noSession && (
        <span className="claude-action-hint" data-testid={`claude-action-hint-goto-${phase}`}>
          No session to join
        </span>
      )}
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
  const formId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [drafts, setDrafts] = useState({});
  const [sendResult, setSendResult] = useState('');
  const [copy, setCopy] = useState(null);
  const [editingPrompts, setEditingPrompts] = useState(false);

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
  }, [busy, blocks.investigate, blocks.implement, blocks.answer, blocks.groom]);

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
        {editingPrompts ? (
          <ClaudePromptsEditor />
        ) : (
          <>
            <ul className="claude-actions">
              <ClaudeRow
                phase="investigate"
                label="Investigate and plan"
                disabled={busy || Boolean(blocks.investigate)}
                hint={REASON_TEXT[blocks.investigate]}
                onRun={() => run(() => launch(ticketKey, INVESTIGATE))}
                noSession={!goTo.investigate}
                onGoTo={() => copyCommand('investigate')}
              />
              <ClaudeRow
                phase="implement"
                label="Implement plan"
                disabled={busy || Boolean(blocks.implement)}
                hint={REASON_TEXT[blocks.implement]}
                onRun={() => run(() => launch(ticketKey, IMPLEMENT))}
                noSession={!goTo.implement}
                onGoTo={() => copyCommand('implement')}
              >
                {/* Starting the session is the user's approval, so where the plan is stays in view. */}
                {entry.reason === 'plan_ready' && (
                  <span className="claude-action-hint" data-testid="claude-plan-hint">
                    {`~/pathwise/.orchestrator/${ticketKey.toLowerCase()}/02-plan.md`}
                  </span>
                )}
              </ClaudeRow>
              <ClaudeRow
                phase="groom"
                label="Groom ticket"
                disabled={busy || Boolean(blocks.groom)}
                hint={REASON_TEXT[blocks.groom]}
                onRun={() => run(() => launch(ticketKey, GROOM))}
                noSession={!goTo.groom}
                onGoTo={() => copyCommand('groom')}
              >
                <span className="claude-action-hint" data-testid="claude-groom-note">
                  Works on any ticket, on its own. Needs no plan and changes nothing in Jira until
                  you say so.
                </span>
                {/* Where the result is, once the session has finished. */}
                {entry.groom?.state === 'done' && (
                  <span className="claude-action-hint" data-testid="claude-groom-path">
                    {`~/pathwise/.orchestrator/${ticketKey.toLowerCase()}/groom.md`}
                  </span>
                )}
              </ClaudeRow>
            </ul>

            {error && (
              <p className="claude-error" role="alert" data-testid="claude-error">
                {error}
              </p>
            )}

            {/* Always rendered, so a screen reader hears its text change rather than appear. */}
            <div className="claude-goto" role="status">
              {copied?.copied && (
                <span data-testid={`claude-goto-copied-${copied.side}`}>Copied</span>
              )}
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
              <form
                id={formId}
                className="claude-questions"
                data-testid="claude-questions"
                onSubmit={save}
              >
                <p className="claude-note">
                  Save as you go. Nothing is sent to the session until every question has an answer.
                </p>
                <ol className="claude-question-list">
                  {questions.map(({ id, question, answer: saved }, index) => (
                    <li key={id} className="claude-question">
                      {/* The number and the tick sit outside the label, so its name is the question. */}
                      <div className="claude-question-head">
                        <span className="claude-question-number" aria-hidden="true">
                          {index + 1}
                        </span>
                        <label htmlFor={`${formId}-${id}`}>{question}</label>
                        {saved?.trim() && (
                          <span
                            className="claude-question-answered"
                            role="img"
                            aria-label="Answered"
                            data-testid={`claude-question-answered-${id}`}
                          >
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 16 16"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.8"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden="true"
                              focusable="false"
                            >
                              <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
                            </svg>
                          </span>
                        )}
                      </div>
                      <textarea
                        id={`${formId}-${id}`}
                        className="claude-question-input"
                        data-testid={`claude-question-${id}`}
                        rows={2}
                        maxLength={2000}
                        autoComplete="off"
                        data-lpignore="true"
                        data-1p-ignore="true"
                        data-bwignore="true"
                        value={Object.hasOwn(drafts, id) ? drafts[id] : (saved ?? '')}
                        disabled={Boolean(blocks.answer)}
                        onChange={(event) => {
                          const { value } = event.target;
                          setDrafts((current) => ({ ...current, [id]: value }));
                        }}
                      />
                    </li>
                  ))}
                </ol>
              </form>
            )}
          </>
        )}
      </div>

      <footer className="claude-dialog-foot">
        {/* One button for both views, so the keyboard focus it holds survives the swap. */}
        <Button
          className="claude-dialog-foot-start"
          data-testid={editingPrompts ? 'claude-prompts-back' : 'claude-prompts-open'}
          onClick={() => setEditingPrompts(!editingPrompts)}
        >
          {editingPrompts ? 'Back' : 'Prompts'}
        </Button>
        {!editingPrompts && questions.length > 0 && (
          <>
            <div className="claude-dialog-foot-status">
              <p className="claude-note" data-testid="claude-questions-progress">
                {`${questions.filter(({ answer: saved }) => saved?.trim()).length} of ${questions.length} answered`}
              </p>
              {/* Always rendered, so a screen reader hears its text change rather than appear. */}
              <p
                className="claude-note claude-send-result"
                role="status"
                data-testid="claude-send-result"
              >
                {sendResult}
              </p>
            </div>
            <Button
              type="submit"
              form={formId}
              data-testid="claude-questions-save"
              disabled={busy || Boolean(blocks.answer) || !(dirty || entry.unsent)}
            >
              Save answers
            </Button>
          </>
        )}
        <Button ref={closeButton} data-testid="claude-dialog-close" onClick={() => close.current()}>
          Close
        </Button>
      </footer>
    </dialog>
  );
}
