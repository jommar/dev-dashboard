// ArtifactViewer.jsx — the Markdown a ticket's Claude sessions left (the plan, checklist, spec,
// groom notes), read in the app instead of at a path. A native modal <dialog>, opened over the
// Claude dialog and mounted only while it is open, so each opening starts from a fresh read.
// Read-only: the files belong to the sessions that write them. The head names the ticket and the
// open file and holds Reload (re-reads the list and the file, for a session still writing), Copy
// path and Close; with more than one file a row of buttons switches between them (the plan first).
// The ticket's proof reports (`~/pathwise/proofs/.proofs-out`, one per run, newest first) are a
// second row of their own, never mixed into the files row.
// A response that lands after a newer request, a close or a file switch is dropped; the last good
// text stays on screen while a reload runs, and a failed reload says so beside it.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from './Primitives.jsx';
import { MarkdownView } from './MarkdownView.jsx';
import {
  getClaudeArtifact,
  getClaudeArtifacts,
  getClaudeProof,
  getClaudeProofs,
} from '../lib/api.js';
import { copyText, timeAgo } from '../../ui/dom.js';

// The server sends a code; the wording is the dashboard's.
const REASON_TEXT = {
  ARTIFACT_NOT_FOUND: 'That file is not there any more.',
  ARTIFACT_TOO_LARGE: 'That file is too large to show here.',
  INVALID_TICKET: 'That ticket cannot be read.',
  INVALID_ARTIFACT: 'That file cannot be read.',
};
const failureText = ({ code, status }) =>
  REASON_TEXT[code] ??
  (status === 0 ? 'The dashboard server is not reachable.' : 'The file could not be read.');

const NO_FILES = Object.freeze([]);
const PENDING = Object.freeze({ name: null, state: 'loading', text: '', message: '' });

const sizeText = (bytes) =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;

export const artifactPath = (ticketKey, name) =>
  `~/pathwise/.orchestrator/${ticketKey.toLowerCase()}/${name}`;

export const proofPath = (ticketKey, run) =>
  `~/pathwise/proofs/.proofs-out/${ticketKey}/${run}/report.md`;

// A proof's run id is a UUID; its first group is what a tab and the title show.
const runLabel = (run) => run.slice(0, 8);

// A wheel over a row moves it sideways (it has no vertical scroll of its own).
const scrollSideways = (event) => {
  if (event.deltaX === 0) event.currentTarget.scrollLeft += event.deltaY;
};

export function ArtifactViewer({ ticketKey, initialName, onClose }) {
  const dialogRef = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;
  // A drag that starts in the text and ends over the backdrop clicks the <dialog> too.
  const pressedBackdrop = useRef(false);
  const titleId = useId();
  const [list, setList] = useState({ state: 'loading', files: [], message: '' });
  const [name, setName] = useState(initialName ?? null);
  // The open proof run, or null while a file is open. A proof, when set, wins over `name`.
  const [proof, setProof] = useState(null);
  const [proofs, setProofs] = useState({ runs: [] });
  const [reloads, setReloads] = useState(0);
  const [loaded, setDoc] = useState({ name: null, state: 'idle', text: '', message: '' });
  const [copy, setCopy] = useState('');
  const listRequest = useRef(0);
  const proofsRequest = useRef(0);
  const docRequest = useRef(0);
  const bodyRef = useRef(null);
  const filesRef = useRef(null);
  const proofsRef = useRef(null);

  // Open once, trap focus (the browser does that for a modal), and give focus back to whatever
  // opened the viewer. Esc closes through the parent's state, the same path as Close.
  useEffect(() => {
    const dialog = dialogRef.current;
    const opener = document.activeElement;
    dialog.showModal();
    const cancel = (event) => {
      event.preventDefault();
      close.current();
    };
    dialog.addEventListener('cancel', cancel);
    return () => {
      dialog.removeEventListener('cancel', cancel);
      if (dialog.open) dialog.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  const loadList = useCallback(async () => {
    const id = ++listRequest.current;
    const result = await getClaudeArtifacts(ticketKey);
    if (id !== listRequest.current) return;
    if (!result.ok) {
      setList((current) => ({ ...current, state: 'error', message: failureText(result) }));
      return;
    }
    setList({ state: 'ready', files: result.files, message: '' });
    // Keep the open file while it is still listed; otherwise the plan (the list's first), if any.
    setName((current) =>
      result.files.some((file) => file.name === current)
        ? current
        : (result.files[0]?.name ?? null),
    );
  }, [ticketKey]);

  useEffect(() => {
    loadList();
    return () => {
      listRequest.current += 1;
    };
  }, [loadList]);

  // The proofs row is a bonus: a failed read leaves it out and never shows an error of its own.
  const loadProofs = useCallback(async () => {
    const id = ++proofsRequest.current;
    const result = await getClaudeProofs(ticketKey);
    if (id !== proofsRequest.current) return;
    const runs = result.ok ? result.runs : [];
    setProofs({ runs });
    setProof((current) => (runs.some((entry) => entry.run === current) ? current : null));
  }, [ticketKey]);

  useEffect(() => {
    loadProofs();
    return () => {
      proofsRequest.current += 1;
    };
  }, [loadProofs]);

  // A ticket with proofs but no files opens on its newest proof.
  useEffect(() => {
    if (list.state === 'ready' && !name && !proof && proofs.runs[0]) setProof(proofs.runs[0].run);
  }, [list.state, name, proof, proofs]);

  // What is open: a proof run or a file. `shown` keys the loaded text so one is never shown
  // under the other's name.
  const shown = proof ? `proof:${proof}` : name;

  useEffect(() => {
    if (!shown) return undefined;
    const id = ++docRequest.current;
    // Switching files drops the old text; a reload of the same file keeps it while it runs.
    setDoc((current) =>
      current.name === shown
        ? { ...current, state: 'loading', message: '' }
        : { name: shown, state: 'loading', text: '', message: '' },
    );
    const read = proof ? getClaudeProof(ticketKey, proof) : getClaudeArtifact(ticketKey, name);
    read.then((result) => {
      if (id !== docRequest.current) return;
      setDoc((current) =>
        result.ok
          ? {
              name: shown,
              state: 'ready',
              text: result.text,
              size: result.size,
              updatedAt: result.updatedAt,
              message: '',
            }
          : { ...current, name: shown, state: 'error', message: failureText(result) },
      );
    });
    return () => {
      docRequest.current += 1;
    };
  }, [ticketKey, name, proof, shown, reloads]);

  // The open file or proof stays in view in its row, whether it was picked, linked to or listed first.
  useEffect(() => {
    for (const row of [filesRef.current, proofsRef.current])
      row
        ?.querySelector('[aria-current="true"]')
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [name, proof, list.files, proofs]);

  const reload = () => {
    setCopy('');
    loadList();
    loadProofs();
    setReloads((count) => count + 1);
  };
  const copyPath = async () => {
    const path = proof ? proofPath(ticketKey, proof) : artifactPath(ticketKey, name);
    setCopy((await copyText(path)) ? 'Path copied' : "Couldn't copy");
  };
  const selectProof = useCallback((run) => {
    setCopy('');
    setProof(run);
    bodyRef.current?.scrollTo({ top: 0 });
  }, []);
  const select = useCallback((file) => {
    setCopy('');
    setProof(null);
    setName(file);
    // The new file starts at its top, as a link in a page would.
    bodyRef.current?.scrollTo({ top: 0 });
  }, []);

  // Text read for another file is never shown under this file's name, not even for the frame
  // before the effect that clears it runs.
  const doc = loaded.name === shown ? loaded : PENDING;
  const { files } = list;
  const fileNames = useMemo(() => files.map((file) => file.name), [files]);
  const title = proof ? `Proof ${runLabel(proof)}` : (name ?? 'Files');
  const loading = list.state === 'loading' || (shown && doc.state === 'loading' && !doc.text);
  const meta = [
    doc.state === 'ready' || doc.text ? sizeText(doc.size ?? doc.text.length) : '',
    doc.updatedAt ? `updated ${timeAgo(doc.updatedAt)}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <dialog
      ref={dialogRef}
      className="artifact-viewer"
      aria-labelledby={titleId}
      data-testid="artifact-viewer"
      onPointerDown={(event) => {
        pressedBackdrop.current = event.target === dialogRef.current;
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current && pressedBackdrop.current) close.current();
      }}
    >
      <header className="artifact-viewer-head">
        <h3 className="artifact-viewer-title" id={titleId} data-testid="artifact-viewer-title">
          <span className="claude-dialog-key">{ticketKey}</span> {title}
        </h3>
        <div className="artifact-viewer-actions">
          <Button className="subtle" data-testid="artifact-reload" onClick={reload}>
            Reload
          </Button>
          <Button
            className="subtle"
            data-testid="artifact-copy-path"
            disabled={!shown}
            onClick={copyPath}
          >
            Copy path
          </Button>
          <Button data-testid="artifact-close" onClick={() => close.current()}>
            Close
          </Button>
        </div>
        <p className="artifact-viewer-status" role="status" data-testid="artifact-status">
          {copy}
        </p>
      </header>

      {files.length > 1 && (
        <nav
          ref={filesRef}
          className="artifact-viewer-files"
          aria-label="Files"
          onWheel={scrollSideways}
        >
          {files.map((file) => (
            <button
              key={file.name}
              type="button"
              className="artifact-viewer-file"
              aria-current={!proof && file.name === name ? 'true' : undefined}
              data-testid={`artifact-file-${file.name}`}
              onClick={() => select(file.name)}
            >
              {file.name}
            </button>
          ))}
        </nav>
      )}

      {proofs.runs.length > 0 && (
        <nav
          ref={proofsRef}
          className="artifact-viewer-files artifact-viewer-proofs"
          aria-label="Proofs"
          data-testid="artifact-proofs"
          onWheel={scrollSideways}
        >
          <span className="artifact-viewer-row-label" aria-hidden="true">
            Proofs
          </span>
          {proofs.runs.map((entry) => (
            <button
              key={entry.run}
              type="button"
              className="artifact-viewer-file"
              aria-current={entry.run === proof ? 'true' : undefined}
              data-testid={`artifact-proof-${entry.run}`}
              onClick={() => selectProof(entry.run)}
            >
              {runLabel(entry.run)} · {timeAgo(entry.updatedAt)}
            </button>
          ))}
        </nav>
      )}

      <div
        ref={bodyRef}
        className="artifact-viewer-body"
        tabIndex={0}
        role="region"
        aria-label={shown ? `${title} for ${ticketKey}` : `Files for ${ticketKey}`}
        aria-busy={loading || undefined}
        data-testid="artifact-body"
      >
        {list.state === 'error' && !shown ? (
          <p className="artifact-viewer-note" data-testid="artifact-error">
            {list.message}
          </p>
        ) : loading ? (
          <p className="artifact-viewer-note" data-testid="artifact-loading">
            Loading…
          </p>
        ) : !shown ? (
          <p className="artifact-viewer-note" data-testid="artifact-empty">
            No Markdown files for this ticket yet.
          </p>
        ) : (
          <>
            {doc.state === 'error' && (
              <p className="artifact-viewer-note" role="alert" data-testid="artifact-error">
                {doc.message}
                {doc.text ? ' Showing the last version read.' : ''}
              </p>
            )}
            {meta && (
              <p className="artifact-viewer-meta" data-testid="artifact-meta">
                {meta}
              </p>
            )}
            {doc.text ? (
              <MarkdownView
                data-testid="artifact-markdown"
                files={proof ? NO_FILES : fileNames}
                onOpenFile={select}
              >
                {doc.text}
              </MarkdownView>
            ) : (
              doc.state === 'ready' && (
                <p className="artifact-viewer-note" data-testid="artifact-blank">
                  This file is empty.
                </p>
              )
            )}
          </>
        )}
      </div>
    </dialog>
  );
}
