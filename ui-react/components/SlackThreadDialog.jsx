// SlackThreadDialog.jsx — a My Tickets Slack glyph opens the conversation here,
// in-app, instead of leaving for slack.com. The row summary only carries the
// thread's headline, so the full conversation is fetched on open from
// /api/slack/thread; a disconnected Slack is a quiet state with a Retry, never
// a thrown error.
import { Fragment, useEffect, useId, useRef, useState } from 'react';
import { Button, LoadingState } from './Primitives.jsx';
import { getSlackThread } from '../lib/api.js';
import { parseSlackText } from '../../ui/slack-mrkdwn.js';
import { ticketKeyFromThread } from '../../ui/slack-ticket-links.js';

const AVATAR_TONES = 4;

// A stable muted tone per author: the same person keeps the same avatar colour
// in every message without a stored colour or any randomness.
function toneFor(author) {
  const seed = `${author?.id || ''}${author?.name || ''}`;
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 1000003;
  }
  return hash % AVATAR_TONES;
}

// "You" → "Y", "Patrick Rivera" → "PR".
function initialsFor(name) {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return '?';
  const first = parts[0][0] || '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] || '' : '';
  return `${first}${last}`.toUpperCase();
}

function dayKey(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toDateString();
}

function dayLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return 'Today';
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function messageTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// mrkdwn is rendered from parsed tokens, never from an HTML string, so a
// message cannot inject markup into the panel.
function MessageBody({ message, names }) {
  const tokens = parseSlackText(message?.mrkdwn || message?.text || '', names);
  if (!tokens.length) return <span className="slack-message-empty">(no text)</span>;
  const render = (list) =>
    list.map((token, index) => {
      switch (token.type) {
        case 'bold':
          return <strong key={index}>{render(token.children || [])}</strong>;
        case 'italic':
          return <em key={index}>{render(token.children || [])}</em>;
        case 'strike':
          return <s key={index}>{render(token.children || [])}</s>;
        case 'code':
          return (
            <code key={index} className="slack-message-code">
              {token.text}
            </code>
          );
        case 'codeblock':
          return (
            <pre key={index} className="slack-message-codeblock">
              <code>{token.text}</code>
            </pre>
          );
        case 'link':
          return (
            <a
              key={index}
              className="slack-message-link"
              href={token.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {token.text}
            </a>
          );
        case 'mention':
          return (
            <span key={index} className="slack-message-mention">
              {token.text}
            </span>
          );
        case 'channel':
          return (
            <span key={index} className="slack-message-channel">
              {token.text}
            </span>
          );
        default:
          return <Fragment key={index}>{token.text}</Fragment>;
      }
    });
  return render(tokens);
}

export function SlackThreadDialog({ thread, onClose }) {
  const dialogRef = useRef(null);
  const opener = useRef(null);
  const copyTimer = useRef(null);
  const request = useRef(0);
  // The panel passes a fresh arrow for onClose on every render; a ref keeps the
  // Esc listener from being torn down and rebuilt on each poll.
  const close = useRef(onClose);
  const titleId = useId();
  const ts = thread?.ts || '';
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState({ status: 'idle', data: null });
  const [copy, setCopy] = useState('idle');

  useEffect(() => {
    close.current = onClose;
  }, [onClose]);

  // Open once per thread and restore the glyph that opened it: a modal <dialog>
  // traps focus itself, but the browser does not remember where focus came from.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !ts) return undefined;
    opener.current = document.activeElement;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      const target = opener.current;
      opener.current = null;
      if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
    };
  }, [ts]);

  // Esc must close through the parent state, the same path as the Close button,
  // so the dialog and its data go away together.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const cancel = (event) => {
      event.preventDefault();
      close.current?.();
    };
    dialog.addEventListener('cancel', cancel);
    return () => dialog.removeEventListener('cancel', cancel);
    // The <dialog> only exists while a thread is open, so the listener has to be
    // attached on that same transition rather than once at mount.
  }, [ts]);

  useEffect(() => {
    if (!ts) return undefined;
    let live = true;
    const id = request.current + 1;
    request.current = id;
    setLoad({ status: 'loading', data: null });
    setCopy('idle');
    clearTimeout(copyTimer.current);
    getSlackThread(ts)
      .then((result) => {
        // A response that lands after the dialog closed or moved to another
        // thread must not repaint it.
        if (!live || request.current !== id) return;
        if (result?.available && result.thread) setLoad({ status: 'ready', data: result.thread });
        else setLoad({ status: 'unavailable', data: null });
      })
      .catch(() => {
        // getSlackThread resolves on failure by contract; this keeps a future
        // change to it from turning into an unhandled rejection.
        if (live && request.current === id) setLoad({ status: 'unavailable', data: null });
      });
    return () => {
      live = false;
    };
  }, [ts, attempt]);

  useEffect(() => () => clearTimeout(copyTimer.current), []);

  const url = load.data?.url || thread?.url || '';

  const copyLink = async () => {
    if (!url) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(url);
      setCopy('copied');
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopy('idle'), 2000);
    } catch {
      setCopy('failed');
    }
  };

  if (!thread) return null;

  const data = load.status === 'ready' ? load.data : null;
  const messages = data?.messages || [];
  // A mentions row previews the mentioning message rather than the subject, so
  // the loaded root message supplies a key the preview cannot. Plain `text`, not
  // mrkdwn: a key buried in emphasis would not be a subject prefix.
  const ticketKey = ticketKeyFromThread(thread.text) || ticketKeyFromThread(messages[0]?.text);
  const title = ticketKey ? `${ticketKey} · Slack thread` : 'Slack thread';
  const replies = Number.isFinite(data?.replyCount) ? data.replyCount : null;
  const subtitle = [
    data?.channel?.name ? `#${data.channel.name}` : '',
    replies === null ? '' : `${replies} ${replies === 1 ? 'reply' : 'replies'}`,
  ]
    .filter(Boolean)
    .join(' · ');
  // MUI renders an anchor when href is present, and an anchor has no disabled
  // state — so an absent link swaps in a genuinely inert button instead.
  const openProps = url
    ? { href: url, target: '_blank', rel: 'noopener noreferrer' }
    : { disabled: true };

  return (
    <dialog
      ref={dialogRef}
      className="slack-thread-dialog"
      aria-labelledby={titleId}
      data-testid="slack-thread-dialog"
      onClick={(event) => {
        // A backdrop click targets the <dialog> itself; everything inside it is
        // a child, so this cannot fire from a click on the panel.
        if (event.target === dialogRef.current) close.current?.();
      }}
    >
      <header className="slack-thread-dialog-head">
        <div>
          <h3
            className="slack-thread-dialog-title"
            id={titleId}
            data-testid="slack-thread-dialog-title"
          >
            {title}
          </h3>
          {subtitle && <p className="slack-thread-dialog-sub">{subtitle}</p>}
        </div>
      </header>

      <div className="slack-thread-dialog-body" data-testid="slack-thread-dialog-body">
        {load.status === 'loading' && (
          <LoadingState label="Loading thread…" testId="slack-thread-loading" />
        )}
        {load.status === 'unavailable' && (
          <div className="slack-thread-failure">
            <p role="alert">This thread could not be loaded. Slack may be disconnected.</p>
            <Button
              data-testid="slack-thread-retry"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Retry
            </Button>
          </div>
        )}
        {data && messages.length === 0 && (
          <p className="slack-note">No messages in this thread yet.</p>
        )}
        {messages.map((message, index) => {
          const previous = index === 0 ? null : messages[index - 1];
          const divider =
            index === 0 || dayKey(previous?.at) !== dayKey(message.at) ? dayLabel(message.at) : '';
          const author = message.author || {};
          const name = author.name || data?.names?.[author.id] || 'Unknown';
          return (
            <Fragment key={message.ts}>
              {divider && (
                <div className="slack-day-divider" role="separator">
                  {divider}
                </div>
              )}
              <article
                className="slack-message"
                data-root={index === 0 ? 'true' : undefined}
                data-testid={`slack-thread-message-${message.ts}`}
              >
                <span
                  className={`slack-message-avatar slack-avatar-tone-${toneFor(author)}`}
                  aria-hidden="true"
                >
                  {initialsFor(name)}
                </span>
                <div className="slack-message-main">
                  <div className="slack-message-head">
                    <strong className="slack-message-author">{name}</strong>
                    {message.at && (
                      <time className="slack-message-time" dateTime={message.at}>
                        {messageTime(message.at)}
                      </time>
                    )}
                    {index === 0 && <span className="slack-message-tag">thread root</span>}
                  </div>
                  <div className="slack-message-body">
                    <MessageBody message={message} names={data?.names} />
                  </div>
                </div>
              </article>
            </Fragment>
          );
        })}
        {data?.truncated && <p className="slack-note">Showing the most recent replies.</p>}
      </div>

      <footer className="slack-thread-dialog-foot">
        <Button data-testid="slack-thread-open" {...openProps}>
          Open in Slack
        </Button>
        <Button data-testid="slack-thread-copy" disabled={!url} onClick={copyLink}>
          {copy === 'copied' ? 'Copied' : 'Copy link'}
        </Button>
        {copy === 'failed' && (
          <>
            <span className="slack-copy-feedback" role="status">
              Couldn&apos;t copy — copy the URL manually
            </span>
            <input
              className="slack-copy-url"
              data-testid="slack-thread-copy-url"
              readOnly
              value={url}
              aria-label="Thread link"
              onFocus={(event) => event.currentTarget.select()}
            />
          </>
        )}
        <Button
          className="slack-thread-dialog-close"
          data-testid="slack-thread-close"
          onClick={() => close.current?.()}
        >
          Close
        </Button>
      </footer>
    </dialog>
  );
}
