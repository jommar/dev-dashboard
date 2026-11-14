// ServiceCheckoutPicker.jsx — the checkout choice on a service card: a native select of the repo's
// git worktrees, a badge when the repo runs from a non-main one, and a native modal that asks before
// a running repo is restarted onto another checkout. A native select and dialog because
// `.service-card` clips popups. The dialog is mounted only while it asks.
import { useEffect, useId, useRef, useState } from 'react';
import { Button, DashboardTooltip } from './Primitives.jsx';

const labelOf = (checkoutLabel) => checkoutLabel ?? 'main';

function optionsFor(service, worktrees) {
  const current = service.checkout;
  const label = labelOf(service.checkoutLabel);
  if (!worktrees) return [{ path: current, text: label }];
  const options = worktrees.map(({ path, label: name, isMain }) => ({
    path,
    text: isMain ? `main · ${name}` : name,
  }));
  if (!options.some(({ path }) => path === current))
    options.push({ path: current, text: `${label} (not listed)` });
  return options;
}

function ConfirmRestart({ id, running, label, onConfirm, onCancel }) {
  const dialogRef = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog.showModal();
    const cancel = (event) => {
      event.preventDefault();
      onCancel();
    };
    dialog.addEventListener('cancel', cancel);
    return () => {
      dialog.removeEventListener('cancel', cancel);
      if (dialog.open) dialog.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only dialog wiring; onCancel is an inline closure that must not re-open the dialog
  }, []);
  return (
    <dialog
      ref={dialogRef}
      className="claude-dialog"
      aria-labelledby={titleId}
      data-testid={`service-checkout-dialog-${id}`}
    >
      <header className="claude-dialog-head">
        <h3 className="claude-dialog-title" id={titleId}>
          Restart on {label}?
        </h3>
      </header>
      <div className="claude-dialog-body">
        <p className="claude-note">
          {running.join(', ')} will stop and start again from this checkout.
        </p>
      </div>
      <footer className="claude-dialog-foot">
        <Button data-testid={`service-checkout-cancel-${id}`} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          className="primary"
          data-testid={`service-checkout-confirm-${id}`}
          onClick={onConfirm}
        >
          Restart
        </Button>
      </footer>
    </dialog>
  );
}

// `repo` is the panel's view of this service's repo: `worktrees` (the listing or undefined),
// `services` (every service of the repo), `disabled`, `list()` and `switchTo(path, restart)`.
export function ServiceCheckoutPicker({ service, repo, onFeedback }) {
  const [asked, setAsked] = useState(null);
  const options = optionsFor(service, repo.worktrees);
  const nameOf = (path) => options.find((option) => option.path === path)?.text ?? path;
  const running = repo.services.filter(({ status }) => status === 'running');
  const selectRef = useRef(null);
  const refocus = useRef(false);
  // The select is disabled while a switch runs, which drops its focus: take it back once re-enabled.
  useEffect(() => {
    if (repo.disabled || !refocus.current) return;
    refocus.current = false;
    selectRef.current?.focus();
  }, [repo.disabled]);

  const run = async (path, restart) => {
    setAsked(null);
    refocus.current = true;
    onFeedback({ message: 'Switching checkout…', state: 'pending' });
    try {
      const { checkoutLabel } = await repo.switchTo(path, restart);
      const label = labelOf(checkoutLabel);
      onFeedback({
        message: restart
          ? `Restarting from ${label}. Status follows the service feed.`
          : `Checkout set to ${label}. The next start uses it.`,
        state: 'success',
      });
    } catch (error) {
      onFeedback({ message: `Checkout not changed: ${error.message}`, state: 'error' });
    }
  };
  const pick = (path) => {
    if (path === service.checkout) return;
    if (running.length) setAsked(path);
    else run(path, false);
  };

  return (
    <div className="service-checkout">
      {service.checkoutLabel && (
        <DashboardTooltip title={service.checkout} describeChild>
          <span
            className="board-chip service-checkout-badge"
            data-testid={`service-checkout-badge-${service.id}`}
          >
            worktree: {service.checkoutLabel}
          </span>
        </DashboardTooltip>
      )}
      <select
        ref={selectRef}
        className="service-checkout-select"
        aria-label={`${service.label} checkout`}
        data-testid={`service-checkout-${service.id}`}
        value={service.checkout}
        disabled={repo.disabled}
        onFocus={() =>
          repo
            .list()
            .catch((error) =>
              onFeedback({ message: `Checkouts unavailable: ${error.message}`, state: 'error' }),
            )
        }
        onChange={(event) => pick(event.target.value)}
      >
        {options.map(({ path, text }) => (
          <option key={path} value={path}>
            {text}
          </option>
        ))}
      </select>
      {asked && (
        <ConfirmRestart
          id={service.id}
          running={running.map(({ label }) => label)}
          label={nameOf(asked)}
          onConfirm={() => run(asked, true)}
          onCancel={() => setAsked(null)}
        />
      )}
    </div>
  );
}
