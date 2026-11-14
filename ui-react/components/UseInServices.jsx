// UseInServices.jsx — the Claude dialog's "Use in Services" for a ticket whose implement session is
// done: it finds the worktree of each service repo whose branch names the ticket and runs that repo
// from it, through the Services tab's own checkout route. The worktrees are read once, on the click
// (never on a poll), nothing here starts a service, and a repo with several candidates or none is
// said so and left alone. A running repo asks before it is restarted.
import { useState } from 'react';
import { Button } from './Primitives.jsx';
import { getCheckoutMatches, setCheckout } from '../lib/api.js';

const STOPPED_NOTE = 'Services that were stopped stay stopped: start them in Services.';

// What the click found that needs no action: repos with several candidates and repos that could not
// be read, each in a sentence.
const notesOf = (repos) => [
  ...repos
    .filter(({ status }) => status === 'ambiguous')
    .map(
      ({ dir, candidates }) => `${dir}: ${candidates.join(', ')} all match; pick one in Services.`,
    ),
  ...repos
    .filter(({ status }) => status === 'unavailable')
    .map(({ dir }) => `${dir}: its worktrees could not be read.`),
];

export function UseInServices({ ticketKey }) {
  const [busy, setBusy] = useState(false);
  // What is shown under the button: a `text` line, the per-repo `choose` buttons, a restart `confirm`.
  const [view, setView] = useState(null);

  // Switches `repo` to its matching worktree; a running repo (CHECKOUT_IN_USE) asks first.
  async function switchCheckout(repo, { restart = false, notes = [] } = {}) {
    setBusy(true);
    try {
      await setCheckout(repo.dir, repo.path, { restart, ids: repo.ids });
      setView({
        text: [
          restart
            ? `${repo.dir} now runs from ${repo.label}; its running services were restarted.`
            : `${repo.dir} now runs from ${repo.label}. ${STOPPED_NOTE}`,
          ...notes,
        ].join(' '),
      });
    } catch (error) {
      if (error.code === 'CHECKOUT_IN_USE' && !restart) setView({ confirm: repo });
      else setView({ text: `Could not switch ${repo.dir}: ${error.message}` });
    } finally {
      setBusy(false);
    }
  }

  async function find() {
    setBusy(true);
    setView(null);
    let repos;
    try {
      ({ repos } = await getCheckoutMatches(ticketKey));
    } catch (error) {
      setView({ text: `Could not read the worktrees: ${error.message}` });
      setBusy(false);
      return;
    }
    setBusy(false);
    const matches = repos.filter(({ status }) => status === 'match');
    const notes = notesOf(repos);
    if (matches.length === 1) await switchCheckout(matches[0], { notes });
    else if (matches.length > 1) setView({ choose: matches, notes });
    else
      setView({
        text: notes.length ? notes.join(' ') : `No worktree branch contains ${ticketKey}.`,
      });
  }

  return (
    <div className="claude-use-in-services">
      <div className="claude-continue">
        <Button
          className="subtle claude-groom-run"
          data-testid="claude-use-in-services"
          disabled={busy}
          onClick={find}
        >
          Use in Services
        </Button>
        <span className="claude-action-hint">
          Runs the repo from the worktree whose branch names this ticket. Starts nothing.
        </span>
      </div>
      {view?.choose && (
        <div className="claude-continue">
          {view.choose.map((repo) => (
            <Button
              key={repo.dir}
              className="subtle claude-groom-run"
              data-testid={`claude-use-in-services-repo-${repo.dir}`}
              disabled={busy}
              onClick={() => switchCheckout(repo, { notes: view.notes })}
            >
              {`${repo.dir}: ${repo.label}`}
            </Button>
          ))}
        </div>
      )}
      {view?.confirm && (
        <div className="claude-continue" role="alert" data-testid="claude-use-in-services-confirm">
          <span className="claude-note">
            {`A service of ${view.confirm.dir} is running. Restart it on ${view.confirm.label}?`}
          </span>
          <Button
            className="subtle claude-groom-run"
            data-testid="claude-use-in-services-restart"
            disabled={busy}
            onClick={() => switchCheckout(view.confirm, { restart: true })}
          >
            Restart
          </Button>
          <Button
            className="subtle claude-groom-run"
            data-testid="claude-use-in-services-cancel"
            disabled={busy}
            onClick={() => setView(null)}
          >
            Cancel
          </Button>
        </div>
      )}
      <p className="claude-note" role="status" data-testid="claude-use-in-services-result">
        {view?.text ?? ''}
      </p>
      {view?.choose && view.notes.length > 0 && (
        <p className="claude-note">{view.notes.join(' ')}</p>
      )}
    </div>
  );
}
