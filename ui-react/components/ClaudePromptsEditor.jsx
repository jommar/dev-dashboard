// ClaudePromptsEditor.jsx — the body of the Claude dialog while it shows the prompt files. The
// dialog swaps it in for the answers and owns the footer (Back and Close), so this holds only what
// belongs to the prompts: the one fetch made when it mounts (never on the dialog's poll, and again
// only from Retry) and, per prompt, its saved entry and its draft. Leaving the view drops the
// drafts; the dialog's own state (answer drafts, copy status) lives above and is untouched.
import { useEffect, useId, useState } from 'react';
import { Button } from './Primitives.jsx';
import { getClaudePrompts, resetClaudePrompt, saveClaudePrompt } from '../lib/api.js';

const STATUS_FILE = '{STATUS_FILE}';
const MISSING_STATUS_FILE = `This prompt does not contain ${STATUS_FILE}, so the session cannot find status.json: questions, the flags and done will not work.`;
const UNUSABLE_NOTE =
  'The file in the prompts folder cannot be used. Saving replaces it and Reset removes it. If either fails, check that a folder is not in its place.';
// A failed Save or Reset is worded by the server's reason; any other failure says what the server said.
const REASON_TEXT = {
  prompt_not_changed:
    'The prompt file could not be changed. Check that prompts/ is a real folder you can write to, with nothing in the place of the file.',
};
const SOURCE_TEXT = { default: 'default', custom: 'custom', unusable: 'unusable file' };

// One prompt: the label, where its text comes from, the text in a box, the placeholders it may use
// and Save / Reset to default with the result line. `saved` is what the server last returned.
function PromptCard({ initial }) {
  const { name, label, placeholders } = initial;
  const headingId = useId();
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(initial.text);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  // The entry the server answers with becomes the saved state and, unless the box was typed in while
  // the request ran, the draft too.
  const send = async (request, done, failed) => {
    const sent = draft;
    setBusy(true);
    setStatus('');
    const result = await request();
    setBusy(false);
    if (!result.ok) {
      setStatus(REASON_TEXT[result.errors?.[0]] ?? result.error ?? failed);
      return;
    }
    setSaved(result.prompt);
    setDraft((current) => (current === sent ? result.prompt.text : current));
    setStatus(done);
  };

  const dirty = draft !== saved.text;
  return (
    <section className="claude-prompt">
      <div className="claude-prompt-head">
        <h4 className="claude-prompt-title" id={headingId}>
          {label}
        </h4>
        <span
          className="board-chip"
          data-tone={saved.source === 'unusable' ? 'warn' : undefined}
          data-testid={`claude-prompt-source-${name}`}
        >
          {SOURCE_TEXT[saved.source]}
        </span>
        {dirty && (
          <span className="claude-prompt-dirty" data-testid={`claude-prompt-dirty-${name}`}>
            Unsaved changes
          </span>
        )}
      </div>
      {saved.source === 'unusable' && <p className="claude-note">{UNUSABLE_NOTE}</p>}
      <textarea
        className="claude-prompt-input"
        data-testid={`claude-prompt-${name}`}
        aria-labelledby={headingId}
        rows={6}
        maxLength={20000}
        autoComplete="off"
        data-lpignore="true"
        data-1p-ignore="true"
        data-bwignore="true"
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setStatus('');
        }}
      />
      <p className="claude-note claude-prompt-placeholders">
        {`Placeholders: ${placeholders.join(', ')}`}
      </p>
      {!draft.includes(STATUS_FILE) && (
        <p
          className="claude-prompt-warning"
          role="status"
          data-testid={`claude-prompt-warning-${name}`}
        >
          {MISSING_STATUS_FILE}
        </p>
      )}
      <div className="claude-prompt-actions">
        <Button
          data-testid={`claude-prompt-save-${name}`}
          disabled={busy || !dirty || !draft.trim()}
          onClick={() =>
            send(() => saveClaudePrompt(name, draft), 'Saved.', 'The prompt could not be saved.')
          }
        >
          Save
        </Button>
        <Button
          data-testid={`claude-prompt-reset-${name}`}
          disabled={busy || saved.source === 'default'}
          onClick={() =>
            send(
              () => resetClaudePrompt(name),
              'Reset to default.',
              'The prompt could not be reset.',
            )
          }
        >
          Reset to default
        </Button>
        {/* Always rendered, so a screen reader hears its text change rather than appear. */}
        <p
          className="claude-note claude-prompt-status"
          role="status"
          data-testid={`claude-prompt-status-${name}`}
        >
          {status}
        </p>
      </div>
    </section>
  );
}

export function ClaudePromptsEditor() {
  const [load, setLoad] = useState({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    getClaudePrompts().then((result) => {
      if (!current) return;
      setLoad(
        result.ok
          ? { state: 'ready', prompts: result.prompts }
          : { state: 'failed', error: result.error ?? 'The prompts could not be loaded.' },
      );
    });
    return () => {
      current = false;
    };
  }, [attempt]);

  const retry = () => {
    setLoad({ state: 'loading' });
    setAttempt((count) => count + 1);
  };

  return (
    <div className="claude-prompts" data-testid="claude-prompts-view">
      {load.state === 'loading' && (
        <p className="claude-note" role="status" data-testid="claude-prompts-loading">
          Loading the prompts…
        </p>
      )}
      {load.state === 'failed' && (
        <>
          <p className="claude-error" role="alert" data-testid="claude-prompts-error">
            {load.error}
          </p>
          <Button
            className="claude-prompts-retry"
            data-testid="claude-prompts-retry"
            onClick={retry}
          >
            Retry
          </Button>
        </>
      )}
      {load.state === 'ready' && (
        <>
          <p className="claude-note">A saved prompt applies from the next launch or send.</p>
          {load.prompts.map((prompt) => (
            <PromptCard key={prompt.name} initial={prompt} />
          ))}
        </>
      )}
    </div>
  );
}
