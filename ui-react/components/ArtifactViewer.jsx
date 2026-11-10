// ArtifactViewer.jsx — the Markdown a ticket's Claude sessions left (the plan, checklist, spec,
// groom notes), read in the app instead of at a path. A native modal <dialog>, opened over the
// Claude dialog and mounted only while it is open, so each opening starts from a fresh read.
// Read-only: the files belong to the sessions that write them. The head names the ticket and the
// open file and holds Reload (re-reads the list and the file, for a session still writing), Copy
// path and Close; with more than one file a row of buttons switches between them (the plan first).
// A response that lands after a newer request, a close or a file switch is dropped; the last good
// text stays on screen while a reload runs, and a failed reload says so beside it.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from './Primitives.jsx';
import { MarkdownView } from './MarkdownView.jsx';
import { getClaudeArtifact, getClaudeArtifacts } from '../lib/api.js';
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

const PENDING = Object.freeze({ name: null, state: 'loading', text: '', message: '' });

const sizeText = (bytes) =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;

export const artifactPath = (ticketKey, name) =>
  `~/pathwise/.orchestrator/${ticketKey.toLowerCase()}/${name}`;

export function ArtifactViewer({ ticketKey, initialName, onClose }) {
  const dialogRef = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;
  // A drag that starts in the text and ends over the backdrop clicks the <dialog> too.
  const pressedBackdrop = useRef(false);
  const titleId = useId();
  const [list, setList] = useState({ state: 'loading', files: [], message: '' });
  const [name, setName] = useState(initialName ?? null);
  const [reloads, setReloads] = useState(0);
  const [loaded, setDoc] = useState({ name: null, state: 'idle', text: '', message: '' });
  const [copy, setCopy] = useState('');
  const listRequest = useRef(0);
  const docRequest = useRef(0);
  const bodyRef = useRef(null);
  const filesRef = useRef(null);

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

  useEffect(() => {
    if (!name) return undefined;
    const id = ++docRequest.current;
    // Switching files drops the old text; a reload of the same file keeps it while it runs.
    setDoc((current) =>
      current.name === name
        ? { ...current, state: 'loading', message: '' }
        : { name, state: 'loading', text: '', message: '' },
    );
    getClaudeArtifact(ticketKey, name).then((result) => {
      if (id !== docRequest.current) return;
      setDoc((current) =>
        result.ok
          ? {
              name,
              state: 'ready',
              text: result.text,
              size: result.size,
              updatedAt: result.updatedAt,
              message: '',
            }
          : { ...current, name, state: 'error', message: failureText(result) },
      );
    });
    return () => {
      docRequest.current += 1;
    };
  }, [ticketKey, name, reloads]);

  // The open file stays in view in the row, whether it was picked, linked to or listed first.
  useEffect(() => {
    filesRef.current
      ?.querySelector('[aria-current="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [name, list.files]);

  const reload = () => {
    setCopy('');
    loadList();
    setReloads((count) => count + 1);
  };
  const copyPath = async () => {
    setCopy((await copyText(artifactPath(ticketKey, name))) ? 'Path copied' : "Couldn't copy");
  };
  const select = useCallback((file) => {
    setCopy('');
    setName(file);
    // The new file starts at its top, as a link in a page would.
    bodyRef.current?.scrollTo({ top: 0 });
  }, []);

  // Text read for another file is never shown under this file's name, not even for the frame
  // before the effect that clears it runs.
  const doc = loaded.name === name ? loaded : PENDING;
  const { files } = list;
  const fileNames = useMemo(() => files.map((file) => file.name), [files]);
  const loading = list.state === 'loading' || (name && doc.state === 'loading' && !doc.text);
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
          <span className="claude-dialog-key">{ticketKey}</span> {name ?? 'Files'}
        </h3>
        <div className="artifact-viewer-actions">
          <Button className="subtle" data-testid="artifact-reload" onClick={reload}>
            Reload
          </Button>
          <Button
            className="subtle"
            data-testid="artifact-copy-path"
            disabled={!name}
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
          // A wheel over the row moves it sideways (it has no vertical scroll of its own).
          onWheel={(event) => {
            if (event.deltaX === 0) event.currentTarget.scrollLeft += event.deltaY;
          }}
        >
          {files.map((file) => (
            <button
              key={file.name}
              type="button"
              className="artifact-viewer-file"
              aria-current={file.name === name ? 'true' : undefined}
              data-testid={`artifact-file-${file.name}`}
              onClick={() => select(file.name)}
            >
              {file.name}
            </button>
          ))}
        </nav>
      )}

      <div
        ref={bodyRef}
        className="artifact-viewer-body"
        tabIndex={0}
        role="region"
        aria-label={name ? `${name} for ${ticketKey}` : `Files for ${ticketKey}`}
        aria-busy={loading || undefined}
        data-testid="artifact-body"
      >
        {list.state === 'error' && !name ? (
          <p className="artifact-viewer-note" data-testid="artifact-error">
            {list.message}
          </p>
        ) : loading ? (
          <p className="artifact-viewer-note" data-testid="artifact-loading">
            Loading…
          </p>
        ) : !name ? (
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
              <MarkdownView data-testid="artifact-markdown" files={fileNames} onOpenFile={select}>
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
