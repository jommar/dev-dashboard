import { useEffect, useId, useRef, useState } from 'react';
import { Button } from './Primitives.jsx';
import { claudePhrase } from './ClaudeIcon.jsx';

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
      </header>
      <div className="claude-dialog-body" data-testid="prs-claude-dialog-body">
        <p className="claude-dialog-state" role="status">
          Code review: {claudePhrase(entry?.review)}
        </p>
        <ul className="claude-actions">
          <li className="claude-action">
            <Button
              data-testid="prs-claude-action-review"
              disabled={busy || Boolean(block)}
              onClick={startReview}
            >
              Start code review
            </Button>
            {block && (
              <span className="claude-action-hint">
                {REASON_TEXT[block] ?? 'Code review cannot start right now.'}
              </span>
            )}
          </li>
          <li className="claude-action">
            <Button
              data-testid="prs-claude-action-rereview"
              disabled={busy || Boolean(rereviewBlock)}
              onClick={requestRereview}
            >
              Re-review
            </Button>
            {rereviewBlock && (
              <span className="claude-action-hint" data-testid="prs-claude-rereview-hint">
                {REASON_TEXT[rereviewBlock] ?? 'Re-review cannot be sent right now.'}
              </span>
            )}
            {resentAt && (
              <span className="claude-action-hint" data-testid="prs-claude-rereview-at">
                Last re-review requested {new Date(resentAt).toLocaleString()}.
              </span>
            )}
          </li>
        </ul>
        <p className="claude-note" role="status">
          {busy ? busyText : resultText}
        </p>
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
