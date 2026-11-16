// SprintGroomDialog.jsx — the confirmation of a "Groom ungroomed" batch: the eligible tickets, all
// checked, then one groom launch after another for the checked ones, each row showing its outcome.
// A refusal other than "already grooming" stops the rest. A native modal <dialog>, open while mounted.
import { useEffect, useId, useRef, useState } from 'react';
import { groomOutcome } from '../../ui/sprint-attention.js';
import { useBackdropClose, useModalDialog } from '../hooks/useModalDialog.js';
import { Button } from './Primitives.jsx';

const NOT_STARTED = { outcome: 'not-started', words: 'Not started' };

export function SprintGroomDialog({ tickets, launch, onClose }) {
  const [checked, setChecked] = useState(() => new Set(tickets.map(({ key }) => key)));
  const [outcomes, setOutcomes] = useState({});
  const [phase, setPhase] = useState('confirm');
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // Escape and the backdrop do nothing while launches are going out, so a batch is never cut short
  // half way without a word on screen.
  const close = () => {
    if (!running.current) onClose();
  };
  const dialogRef = useModalDialog(close);
  const backdrop = useBackdropClose(dialogRef, close);
  const titleId = useId();

  const toggle = (key) =>
    setChecked((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const confirm = async () => {
    running.current = true;
    setPhase('running');
    const keys = tickets.map(({ key }) => key).filter((key) => checked.has(key));
    const show = (key, outcome) => {
      if (mounted.current) setOutcomes((previous) => ({ ...previous, [key]: outcome }));
    };
    // A confirmed batch goes on after the dialog closes with the tab, so no checked ticket is dropped.
    let stopped = false;
    for (const key of keys) {
      if (stopped) {
        show(key, NOT_STARTED);
        continue;
      }
      const outcome = groomOutcome(await launch(key, 'groom'));
      show(key, outcome);
      stopped = outcome.stop;
    }
    running.current = false;
    if (mounted.current) setPhase('finished');
  };

  return (
    <dialog
      ref={dialogRef}
      className="sprint-board-dialog"
      data-testid="sprint-groom-dialog"
      aria-labelledby={titleId}
      {...backdrop}
    >
      <h2 id={titleId} className="sprint-board-dialog-title">
        Groom ungroomed tickets
      </h2>
      <p className="sprint-board-dialog-text">
        Each checked ticket gets a groom session, one after another. Jira is not changed.
      </p>
      <ul className="sprint-board-dialog-list">
        {tickets.map((ticket) => (
          <li
            key={ticket.key}
            className="sprint-board-dialog-item"
            data-testid={`sprint-groom-item-${ticket.key}`}
          >
            <label className="sprint-board-dialog-label">
              <input
                type="checkbox"
                checked={checked.has(ticket.key)}
                disabled={phase !== 'confirm'}
                onChange={() => toggle(ticket.key)}
              />
              <span className="sprint-board-dialog-key">{ticket.key}</span>
              <span className="sprint-board-dialog-summary">{ticket.summary}</span>
            </label>
            {outcomes[ticket.key] && (
              <span
                className="sprint-board-dialog-outcome"
                data-outcome={outcomes[ticket.key].outcome}
                data-testid={`sprint-groom-outcome-${ticket.key}`}
              >
                {outcomes[ticket.key].words}
              </span>
            )}
          </li>
        ))}
      </ul>
      <div className="sprint-board-dialog-actions">
        <Button disabled={phase === 'running'} onClick={onClose}>
          {phase === 'finished' ? 'Close' : 'Cancel'}
        </Button>
        <Button
          className="primary"
          disabled={phase !== 'confirm' || checked.size === 0}
          onClick={confirm}
        >
          Confirm
        </Button>
      </div>
    </dialog>
  );
}
