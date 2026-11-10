import { useEffect, useId, useRef, useState } from 'react';
import { Button } from './Primitives.jsx';
import { DismissButton, StatePill, stampOf } from './ClaudeSteps.jsx';

const REVIEW = 'pr-review-transact';
const REASON_TEXT = {
  untrusted_workspace:
    'Claude does not trust ~/pathwise yet. Run claude there once and accept the trust prompt.',
  timed_out: 'Claude took too long to start. Check the review session before launching again.',
  spawn_failed: 'Could not start Claude. Is the claude command installed?',
  listing_unavailable: 'Claude review status is unavailable. Try again when status is available.',
  unrecognised_state:
    'Claude review status is unavailable. Check the session before launching again.',
  session_running: 'A Claude review session is already running for this ticket.',
  no_review_session: 'Start a code review first.',
  session_not_found: 'The Claude review session could not be found.',
  live_at_resume: 'The Claude review session is still running.',
  resume_failed: 'The Claude review session could not be resumed.',
  prompt_unreadable:
    "A custom prompt file could not be used. Fix or remove it in the dashboard's prompts folder.",
};

function rereviewText({ send }) {
  if (send?.status === 'sent') return 'Re-review requested. Claude is checking the linked PRs.';
  const why = REASON_TEXT[send?.reason]?.replace(/\.$/, '') ?? 'the session could not be reached';
  return `Re-review not sent: ${why}. Press Re-review to retry.`;
}

export function ClaudePlaceholderDialog({
  ticketKey,
  summary,
  entry,
  launch,
  rereview,
  onClose,
  resolveOpener,
}) {
  const dialogRef = useRef(null);
  const closeButton = useRef(null);
  const close = useRef(onClose);
  const openerResolver = useRef(resolveOpener);
  const pressedBackdrop = useRef(false);
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [resultText, setResultText] = useState('');
  const [busyText, setBusyText] = useState('');
  const block = entry?.blocks.review;
  const rereviewBlock = entry?.blocks.rereview;
  const resentAt = entry?.reviewResentAt;
  const reviewState = entry?.review?.state;
  // Start code review is the one primary button until a review session exists (a ticket the server
  // lists nothing for has none); after that the re-review is, and starting another review is the
  // quiet choice. While a session works or the status is unknown neither is.
  const startPrimary = !entry || (block === null && rereviewBlock === 'no_review_session');
  const rereviewPrimary = rereviewBlock === null;
  // Once a review session exists and can take a message, starting another review is the quiet choice.
  const startQuiet = block === null && rereviewBlock === null;
  const reasonId = useId();
  const startReason = REASON_TEXT[block] ?? (block ? 'Code review cannot start right now.' : '');
  const rereviewReason =
    REASON_TEXT[rereviewBlock] ?? (rereviewBlock ? 'Re-review cannot be sent right now.' : '');
  // "Start a code review first." only repeats the primary button beside it, so it is for assistive
  // tech alone then.
  const reasons = [];
  if (startReason)
    reasons.push({
      key: 'start',
      text: startReason,
      names: ['Start'],
      testId: 'prs-claude-review-hint',
    });
  if (rereviewReason) {
    const lead = reasons.find((reason) => reason.text === rereviewReason);
    if (lead) lead.names.push('Re-review');
    reasons.push({
      key: 'rereview',
      text: rereviewReason,
      names: ['Re-review'],
      quiet: Boolean(lead) || startPrimary,
      testId: 'prs-claude-rereview-hint',
    });
  }
  close.current = onClose;
  openerResolver.current = resolveOpener;

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog.showModal();
    const cancel = (event) => {
      event.preventDefault();
      close.current();
    };
    dialog.addEventListener('cancel', cancel);
    return () => {
      dialog.removeEventListener('cancel', cancel);
      if (dialog.open) dialog.close();
      openerResolver.current?.(ticketKey)?.focus({ preventScroll: true });
    };
  }, [ticketKey]);

  // A message about a review that was working is out of date once it stops (it can also be
  // dismissed, and the next action replaces it).
  const lastState = useRef(reviewState);
  useEffect(() => {
    if (lastState.current === 'working' && reviewState !== 'working') setResultText('');
    lastState.current = reviewState;
  }, [reviewState]);

  useEffect(() => {
    const focused = document.activeElement;
    if (!focused || focused === document.body || focused.disabled) closeButton.current?.focus();
  }, [busy, block]);

  const startReview = async () => {
    if (busy || block) return;
    setBusy(true);
    setBusyText('Starting code review…');
    setError('');
    setResultText('');
    const result = await launch(ticketKey, REVIEW);
    setBusy(false);
    if (!result.ok) {
      setError(
        REASON_TEXT[result.errors?.[0]] ?? result.error ?? 'The Claude review request failed.',
      );
      return;
    }
    setResultText('Code review session started. Completion does not mean the review passed.');
  };

  // Sends the re-review message to the ticket's existing review session.
  const requestRereview = async () => {
    if (busy || rereviewBlock) return;
    setBusy(true);
    setBusyText('Sending re-review…');
    setError('');
    setResultText('');
    const result = await rereview(ticketKey);
    setBusy(false);
    if (!result.ok) {
      setError(
        REASON_TEXT[result.errors?.[0]] ?? result.error ?? 'The Claude re-review request failed.',
      );
      return;
    }
    setResultText(rereviewText(result));
  };

  return (
    <dialog
      ref={dialogRef}
      className="claude-dialog"
      aria-labelledby={titleId}
      data-testid="prs-claude-dialog"
      onPointerDown={(event) => {
        pressedBackdrop.current = event.target === dialogRef.current;
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current && pressedBackdrop.current) close.current();
      }}
    >
      <header className="claude-dialog-head">
        <h3 className="claude-dialog-title" id={titleId} data-testid="prs-claude-dialog-title">
          <span className="claude-dialog-key">{ticketKey}</span> {summary}
        </h3>
        <StatePill
          entry={entry?.review}
          label="Code review"
          data-testid="prs-claude-dialog-state"
        />
      </header>
      <div className="claude-dialog-body" data-testid="prs-claude-dialog-body">
        <ul className="claude-review-actions">
          <li className="claude-review-action">
            <Button
              className={startPrimary ? 'primary' : startQuiet ? 'subtle' : ''}
              data-testid="prs-claude-action-review"
              disabled={busy || Boolean(block)}
              aria-describedby={startReason ? `${reasonId}-start` : undefined}
              onClick={startReview}
            >
              {startQuiet ? 'Start new review' : 'Start code review'}
            </Button>
          </li>
          <li className="claude-review-action">
            <Button
              className={rereviewPrimary ? 'primary' : ''}
              data-testid="prs-claude-action-rereview"
              disabled={busy || Boolean(rereviewBlock)}
              aria-describedby={rereviewReason ? `${reasonId}-rereview` : undefined}
              onClick={requestRereview}
            >
              Re-review
            </Button>
          </li>
        </ul>
        {/* Why an action is off, one line (a reason both share is said once; the other stays for
            assistive tech), then when the last re-review was asked for. */}
        <ul className="claude-reasons">
          {reasons.map(({ key, text, names, quiet, testId }) => (
            <li key={key} className={quiet ? 'sr-only' : undefined}>
              <span className="claude-reason-step">{names.join(' · ')}</span>
              <span id={`${reasonId}-${key}`} data-testid={testId}>
                {text}
              </span>
            </li>
          ))}
        </ul>
        {resentAt && (
          <p className="claude-note" data-testid="prs-claude-rereview-at">
            {`Last re-review requested ${stampOf(resentAt)}.`}
          </p>
        )}
        <div className="claude-flash">
          <p className="claude-note" role="status">
            {busy ? busyText : resultText}
          </p>
          {resultText && !busy && <DismissButton onClick={() => setResultText('')} />}
        </div>
        {error && (
          <p className="claude-error" role="alert" data-testid="prs-claude-error">
            {error}
          </p>
        )}
      </div>
      <footer className="claude-dialog-foot">
        <Button
          ref={closeButton}
          data-testid="prs-claude-dialog-close"
          onClick={() => close.current()}
        >
          Close
        </Button>
      </footer>
    </dialog>
  );
}
