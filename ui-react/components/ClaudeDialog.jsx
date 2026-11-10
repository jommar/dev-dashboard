// ClaudeDialog.jsx — the one Claude menu for My Tickets, opened by a card's icon. A native modal
// <dialog> rather than a popup in the card: cards and columns clip overflow, and a card that
// remounts would lose its state. The panel mounts it only while a ticket is open (keyed by the
// ticket), so its drafts, errors and copy status begin empty each time.
// The header holds the key and summary and the state as a pill (a mark and a word). The body opens
// with the workflow as three steps in order, Investigate and plan, Approve plan, Implement plan
// (ClaudeSteps.jsx says where each stands): each step is its state word, its one button and, when it
// has a session, a "Go to session" chip. Only the step to act on now has the primary button; a plan
// that exists and is approved makes Investigate and plan a quiet re-run, and Approve becomes a done
// step ("Approved 7:39 AM") rather than a disabled button. Why a step is off is one line under the
// strip (a reason that two steps share is said once). A send's outcome is a short inline message
// beside its action that can be dismissed and clears once the ticket stops working. Groom ticket sits
// apart, as the independent action it is. When the planning session asked questions they follow as
// cards, with the progress, the bar and Resend answers (sends the saved answers again, even
// unchanged) above them. The footer stays in view beside the body's scroll: Prompts (on the left),
// the progress and the last save's result, Save answers (linked to the questions form by its id) and
// Close. Prompts swaps the body for the prompt editor, still in this one dialog: the footer then
// holds Back (the same button, so it keeps focus) and Close, and everything this component holds
// (answer drafts, copy status, the last send result) is there when Back returns.
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from './Primitives.jsx';
import { ClaudePromptsEditor } from './ClaudePromptsEditor.jsx';
import { ArtifactViewer } from './ArtifactViewer.jsx';
import {
  BUTTON_CLASS,
  DismissButton,
  SessionChip,
  StatePill,
  StatusMark,
  workflowSteps,
} from './ClaudeSteps.jsx';
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
  not_approved: 'Approve the plan first.',
  already_approved: 'The plan is approved.',
  implement_started: 'Implement plan has started.',
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

function approveText({ send }) {
  if (send?.status === 'sent') return 'Approval sent. Claude is checking the plan.';
  const why = REASON_TEXT[send?.reason]?.replace(/\.$/, '') ?? 'the session could not be reached';
  return `Approval not sent: ${why}. Press Approve plan to retry.`;
}

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

// A ticket the server lists nothing for has not been started.
const NOT_STARTED = {
  questions: [],
  goTo: { investigate: null, implement: null, groom: null },
  groom: { state: 'none', reason: null },
  blocks: {
    investigate: null,
    implement: 'not_planned',
    answer: 'no_questions',
    resend: 'no_questions',
    approve: 'not_planned',
    groom: null,
  },
};

// A path that may wrap, but only after a slash: a break inside a name reads as two names.
const breakAtSlashes = (path) =>
  path.split('/').flatMap((part, index) => (index ? ['/', <wbr key={index} />, part] : [part]));

const failureText = ({ errors, error }) =>
  REASON_TEXT[errors?.[0]] ?? error ?? 'The Claude request failed.';

const STEP_LABEL = {
  investigate: 'Investigate and plan',
  approve: 'Approve plan',
  implement: 'Implement plan',
};
// The shorter name a reason line leads with.
const STEP_SHORT = { investigate: 'Investigate', approve: 'Approve', implement: 'Implement' };
const HINT_TESTID = {
  investigate: 'claude-action-hint-investigate',
  approve: 'claude-approve-hint',
  implement: 'claude-action-hint-implement',
};

export function ClaudeDialog({
  ticketKey,
  summary,
  entry: listed,
  onClose,
  launch,
  answer,
  approve,
}) {
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
  const hintId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [drafts, setDrafts] = useState({});
  const [sendResult, setSendResult] = useState('');
  const [approveResult, setApproveResult] = useState('');
  const [copy, setCopy] = useState(null);
  const [editingPrompts, setEditingPrompts] = useState(false);
  // The Markdown viewer opened over this dialog: `{ name }` is the file to open first (or null).
  const [viewing, setViewing] = useState(null);

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
  }, [busy, blocks.investigate, blocks.implement, blocks.answer, blocks.approve, blocks.groom]);

  // A send's message is about the session that was working on it: once the ticket stops working it
  // is out of date ("Approval sent. Claude is checking the plan." under a plan that is ready), so it
  // goes. It can also be dismissed, and the next action replaces it.
  const lastState = useRef(entry.state);
  useEffect(() => {
    if (lastState.current === 'working' && entry.state !== 'working') {
      setSendResult('');
      setApproveResult('');
    }
    lastState.current = entry.state;
  }, [entry.state]);

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

  // Sends the saved answers again, whether or not they changed; unsaved edits stay as drafts.
  const resend = async () => {
    setSendResult('');
    const result = await run(() => answer(ticketKey, [], { resend: true }));
    if (result.ok) setSendResult(sendText(result));
  };

  const approvePlan = async () => {
    setApproveResult('');
    const result = await run(() => approve(ticketKey));
    if (result.ok) setApproveResult(approveText(result));
  };

  const copyCommand = async (side) => {
    const command = goTo[side].command;
    setCopy({ side, command, copied: await copyText(command) });
  };
  // One status at a time, for the item last used: copying the other session's command replaces it.
  // A status for a command the poll has since replaced is not shown.
  const copied = copy?.command === goTo[copy?.side]?.command ? copy : null;

  const steps = workflowSteps(entry);
  const runs = {
    investigate: () => run(() => launch(ticketKey, INVESTIGATE)),
    approve: approvePlan,
    implement: () => run(() => launch(ticketKey, IMPLEMENT)),
  };
  const blockOf = {
    investigate: blocks.investigate,
    approve: entry.flags?.approved ? null : blocks.approve,
    implement: blocks.implement,
  };

  // Why each off step is off, one line each under the strip. A reason two steps share is said once
  // (the later one stays for assistive tech), and while a session works or the status is unavailable
  // the pill and the steps already say so, so the lines are for assistive tech only.
  const held = entry.state === 'working' || entry.state === 'unknown';
  const reasons = [];
  for (const { phase } of steps) {
    const text = REASON_TEXT[blockOf[phase]];
    if (!text) continue;
    const lead = reasons.find((reason) => reason.text === text);
    if (lead) lead.names.push(STEP_SHORT[phase]);
    reasons.push({ phase, text, names: [STEP_SHORT[phase]], quiet: held || Boolean(lead) });
  }
  const describedBy = (phase) => (REASON_TEXT[blockOf[phase]] ? `${hintId}-${phase}` : undefined);

  // The Resend hint is for what the lines under the strip do not already say.
  const resendText = REASON_TEXT[blocks.resend];
  const resendShown =
    dirty ||
    (Boolean(resendText) &&
      !held &&
      !reasons.some((reason) => !reason.quiet && reason.text === resendText));
  const answered = questions.filter(({ answer: saved }) => saved?.trim()).length;
  const liveText = Boolean(approveResult) || Boolean(copied);

  return (
    <>
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
          <StatePill entry={listed} data-testid="claude-dialog-state" />
        </header>

        <div className="claude-dialog-body">
          {editingPrompts ? (
            <ClaudePromptsEditor />
          ) : (
            <>
              <ol className="claude-steps" aria-label="Workflow">
                {steps.map((step) => (
                  <li
                    key={step.phase}
                    className="claude-step"
                    data-step={step.phase}
                    data-status={step.status}
                    aria-current={step.current ? 'step' : undefined}
                  >
                    <p className="claude-step-state">
                      <StatusMark status={step.status} />
                      <span
                        data-testid={
                          step.phase === 'approve' && entry.flags?.approved
                            ? 'claude-approved-note'
                            : `claude-step-state-${step.phase}`
                        }
                      >
                        {step.caption}
                      </span>
                    </p>
                    {/* Approving is done once approved: the step says so instead of a dead button. */}
                    {!(step.phase === 'approve' && entry.flags?.approved) && (
                      <Button
                        className={BUTTON_CLASS[step.variant]}
                        data-testid={
                          step.phase === 'approve'
                            ? 'claude-approve'
                            : `claude-action-${step.phase}`
                        }
                        disabled={busy || Boolean(blockOf[step.phase])}
                        aria-describedby={describedBy(step.phase)}
                        onClick={runs[step.phase]}
                      >
                        {STEP_LABEL[step.phase]}
                      </Button>
                    )}
                    {goTo[step.phase] && (
                      <SessionChip phase={step.phase} onGoTo={() => copyCommand(step.phase)} />
                    )}
                    {/* Approving the plan unlocks this, so where the plan is stays in view. */}
                    {step.phase === 'implement' && entry.reason === 'plan_ready' && (
                      <span className="claude-step-note" data-testid="claude-plan-hint">
                        {breakAtSlashes(
                          `~/pathwise/.orchestrator/${ticketKey.toLowerCase()}/02-plan.md`,
                        )}
                      </span>
                    )}
                    {step.phase === 'implement' && entry.reason === 'plan_ready' && (
                      <button
                        type="button"
                        className="artifact-link"
                        data-testid="claude-view-plan"
                        onClick={() => setViewing({ name: '02-plan.md' })}
                      >
                        View plan
                      </button>
                    )}
                  </li>
                ))}
              </ol>

              <ul className="claude-reasons">
                {reasons.map(({ phase, text, names, quiet }) => (
                  <li key={phase} className={quiet ? 'sr-only' : undefined}>
                    <span className="claude-reason-step">{names.join(' · ')}</span>
                    <span id={`${hintId}-${phase}`} data-testid={HINT_TESTID[phase]}>
                      {text}
                    </span>
                  </li>
                ))}
              </ul>

              {/* The live regions are always rendered, so a screen reader hears their text change
                rather than appear; with no text they take no room. */}
              <div className={`claude-live${liveText ? ' has-text' : ''}`}>
                <div className="claude-flash">
                  <p
                    className="claude-note claude-send-result"
                    role="status"
                    data-testid="claude-approve-result"
                  >
                    {approveResult}
                  </p>
                  {approveResult && <DismissButton onClick={() => setApproveResult('')} />}
                </div>
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
              </div>

              {error && (
                <p className="claude-error" role="alert" data-testid="claude-error">
                  {error}
                </p>
              )}

              {/* Grooming is not a step: it works on any ticket, on its own. */}
              <section className="claude-groom" aria-labelledby={`${hintId}-groom`}>
                <div className="claude-groom-main">
                  <span className="claude-groom-title" id={`${hintId}-groom`}>
                    Independent
                  </span>
                  <Button
                    className="subtle claude-groom-run"
                    data-testid="claude-action-groom"
                    disabled={busy || Boolean(blocks.groom)}
                    onClick={() => run(() => launch(ticketKey, GROOM))}
                  >
                    Groom ticket
                  </Button>
                  {goTo.groom && <SessionChip phase="groom" onGoTo={() => copyCommand('groom')} />}
                </div>
                {REASON_TEXT[blocks.groom] && (
                  <span className="claude-action-hint" data-testid="claude-action-hint-groom">
                    {REASON_TEXT[blocks.groom]}
                  </span>
                )}
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
                {entry.groom?.state === 'done' && (
                  <button
                    type="button"
                    className="artifact-link"
                    data-testid="claude-view-groom"
                    onClick={() => setViewing({ name: 'groom.md' })}
                  >
                    View groom notes
                  </button>
                )}
              </section>

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
                  <div className="claude-questions-head">
                    <h4 className="claude-section-title">Questions</h4>
                    <span className="claude-progress-count" aria-hidden="true">
                      {answered}/{questions.length}
                    </span>
                    <span className="claude-progress" aria-hidden="true">
                      <span style={{ width: `${(answered / questions.length) * 100}%` }} />
                    </span>
                    {/* The saved answers again, even unchanged, for a send that never arrived. */}
                    <Button
                      type="button"
                      className="subtle claude-resend"
                      data-testid="claude-questions-resend"
                      disabled={busy || Boolean(blocks.resend) || dirty}
                      aria-describedby={`${hintId}-resend`}
                      onClick={resend}
                    >
                      Resend answers
                    </Button>
                  </div>
                  <p
                    id={`${hintId}-resend`}
                    className={`claude-note${resendShown ? '' : ' sr-only'}`}
                    data-testid="claude-resend-hint"
                  >
                    {dirty
                      ? 'Save your changes first.'
                      : (REASON_TEXT[blocks.resend] ??
                        'Sends the saved answers to the session again, even if unchanged.')}
                  </p>
                  <p className="claude-note">
                    Save as you go. Nothing is sent to the session until every question has an
                    answer.
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
          <div className="claude-dialog-foot-start">
            <Button
              className="subtle"
              data-testid={editingPrompts ? 'claude-prompts-back' : 'claude-prompts-open'}
              onClick={() => setEditingPrompts(!editingPrompts)}
            >
              {editingPrompts ? 'Back' : 'Prompts'}
            </Button>
            {!editingPrompts && (
              <Button
                className="subtle"
                aria-haspopup="dialog"
                data-testid="claude-files-open"
                onClick={() => setViewing({ name: null })}
              >
                Files
              </Button>
            )}
          </div>
          {!editingPrompts && questions.length > 0 && (
            <>
              <div className="claude-dialog-foot-status">
                <p className="claude-note" data-testid="claude-questions-progress">
                  {`${answered} of ${questions.length} answered`}
                </p>
                {/* Always rendered, so a screen reader hears its text change rather than appear. */}
                <div className="claude-flash">
                  <p
                    className="claude-note claude-send-result"
                    role="status"
                    data-testid="claude-send-result"
                  >
                    {sendResult}
                  </p>
                  {sendResult && <DismissButton onClick={() => setSendResult('')} />}
                </div>
              </div>
              <Button
                type="submit"
                form={formId}
                className="primary"
                data-testid="claude-questions-save"
                disabled={busy || Boolean(blocks.answer) || !(dirty || entry.unsent)}
              >
                Save answers
              </Button>
            </>
          )}
          <Button
            ref={closeButton}
            data-testid="claude-dialog-close"
            onClick={() => close.current()}
          >
            Close
          </Button>
        </footer>
      </dialog>
      {viewing && (
        <ArtifactViewer
          ticketKey={ticketKey}
          initialName={viewing.name}
          onClose={() => setViewing(null)}
        />
      )}
    </>
  );
}
