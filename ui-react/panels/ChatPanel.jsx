import { useEffect, useId, useRef, useState } from 'react';
import { BoardPanel, BoardSection } from '../components/BoardShell.jsx';
import { ChatLog } from '../components/ChatTranscript.jsx';
import { Button } from '../components/Primitives.jsx';
import { useChatSession } from '../hooks/useChatSession.js';
import { notifyClaudeTicketsChanged, useClaudeTickets } from '../hooks/useClaudeTickets.js';
import { BOT_STATE_WORDS } from '../../ui/bot-bar.js';
import { chatHref } from '../../ui/chat-stream.js';
import { timeAgo } from '../../ui/dom.js';

const ANNOUNCEMENTS = {
  working: 'Claude is working',
  completed: 'Claude replied',
  stopped: 'Turn stopped',
  failed: 'Turn failed',
};
const FAILURE_WORDS = {
  spawn_failed: 'Claude could not be started.',
  api_error: 'Claude returned an error.',
  exited: 'Claude stopped unexpectedly.',
};
// Why a send or a stop was refused, by the server's reason (`errors[0]`) or, with none, its code.
const REFUSAL_WORDS = {
  chat_busy: 'A turn is already running in this chat.',
  session_running: 'This session is running outside the chat.',
  session_not_found: 'That session could not be found.',
  too_many_turns: 'Four chats are already replying. Wait for one to finish.',
  no_turn: 'There is no turn to stop.',
  listing_unavailable: 'Claude status is unavailable.',
  live_at_resume: 'The Claude session is still running.',
  spawn_failed: 'Could not start Claude. Is the claude command installed?',
  INVALID_MESSAGE: 'A message cannot be empty or longer than 32000 characters.',
};
const refusal = ({ errors, code }, fallback) => REFUSAL_WORDS[errors?.[0] ?? code] ?? fallback;
const OUTSIDE_WORDS =
  'This session is running outside the chat, so it is read-only here. Refresh to read its latest messages.';

// Where a chat stands, as one word: working, then how its last turn ended.
const turnPhase = (view) => (view.state === 'working' ? 'working' : (view.turn?.outcome ?? 'idle'));

// Follows the chat being read from turn to turn: `onChange()` runs when its phase changes, and the
// text of the one polite status line says what changed. Nothing for the first view of a chat, so
// opening one is silent.
function useTurnChanges(view, onChange) {
  const [message, setMessage] = useState('');
  const seen = useRef(null);
  const id = view?.session;
  const phase = view && turnPhase(view);
  useEffect(() => {
    const before = seen.current;
    seen.current = id ? { id, phase } : null;
    if (!id || before?.id !== id || before.phase === phase) return;
    setMessage(ANNOUNCEMENTS[phase] ?? '');
    onChange();
  }, [id, phase, onChange]);
  return message;
}

// What an ended turn says under the conversation: that it was stopped, why it failed, and the tools it
// was not allowed to use.
function turnNote(turn) {
  if (!turn) return '';
  const ended =
    turn.outcome === 'stopped'
      ? ['Stopped before Claude finished.']
      : turn.outcome === 'failed'
        ? [turn.error || FAILURE_WORDS[turn.reason] || 'The turn failed.']
        : [];
  const denied = turn.denials?.length ? [`Not allowed to use ${turn.denials.join(', ')}.`] : [];
  return [...ended, ...denied].join(' ');
}

const OUTCOME_LABELS = { failed: 'Failed', stopped: 'Stopped' };
function stateLabel(view) {
  if (view.state === 'working') return view.live ? 'Working' : 'Working elsewhere';
  return OUTCOME_LABELS[view.turn?.outcome] ?? 'Idle';
}

// Why the composer waits, in words: nothing when it does not.
function blockedReason({ sending, loading, outside, working }) {
  if (sending) return 'Sending…';
  if (loading) return 'Loading the conversation…';
  if (outside) return OUTSIDE_WORDS;
  return working ? 'Claude is replying. Stop the turn to write again.' : '';
}

function ChatList({ chats, session }) {
  return (
    <nav className="chat-list" aria-label="Chats" data-testid="chat-list">
      <Button
        href="#/chat"
        className="chat-new"
        data-testid="chat-new"
        aria-current={session ? undefined : 'page'}
      >
        New chat
      </Button>
      <ul>
        {chats.map((chat) => (
          <li key={chat.id}>
            <a
              className="chat-list-item"
              href={chatHref(chat.id)}
              data-testid={`chat-list-item-${chat.id}`}
              data-state={chat.state}
              aria-current={chat.id === session ? 'page' : undefined}
            >
              <span className="chat-list-title">{chat.title}</span>
              <span className="chat-list-meta">
                {BOT_STATE_WORDS[chat.state]} · {timeAgo(chat.lastActiveAt)}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

// The conversation with one session, or the empty page of a chat not yet sent (no `session`). The
// composer is a form: Enter sends, Shift+Enter is a new line. While a turn runs or the session is
// working outside the chat it is read-only and says why in words; it stays aria-disabled, not
// disabled, so the focus the writer had is still there when the turn ends.
function ChatConversation({ active, session, focusOnMount }) {
  const { view, error, send, stop, refresh } = useChatSession({ active, session });
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [problem, setProblem] = useState('');
  const fieldId = useId();
  const reasonId = useId();
  const sendingNow = useRef(false);
  const field = useRef(null);
  const announcement = useTurnChanges(view, notifyClaudeTicketsChanged);

  const working = view?.state === 'working';
  const live = view?.live === true;
  const outside = working && !live;
  const loading = Boolean(session) && !view && !error;
  const blocked = sending || loading || working;
  const reason = blockedReason({ sending, loading, outside, working });
  const lastUser = view?.items.findLast(({ kind }) => kind === 'user');
  const retryable = !working && ['stopped', 'failed'].includes(view?.turn?.outcome) && lastUser;
  const note = view && !working ? turnNote(view.turn) : '';

  // A chat started from here is this component again under its own key: the writer keeps the focus.
  useEffect(() => {
    if (!focusOnMount.current) return;
    focusOnMount.current = false;
    field.current.focus();
  }, [focusOnMount]);

  // Sends `message`; true once the turn has started. A new chat then moves to its own address. One
  // send at a time: a second submit in the same tick is not a second message.
  async function deliver(message) {
    if (sendingNow.current) return false;
    sendingNow.current = true;
    setSending(true);
    setProblem('');
    const result = await send(message);
    sendingNow.current = false;
    setSending(false);
    if (!result.ok) {
      setProblem(refusal(result, 'Could not send the message.'));
      return false;
    }
    notifyClaudeTicketsChanged();
    if (!session) {
      focusOnMount.current = true;
      location.hash = chatHref(result.session);
    }
    return true;
  }
  const submit = async (event) => {
    event.preventDefault();
    const message = text.trim();
    if (message && !blocked && (await deliver(message))) setText('');
  };
  const halt = async () => {
    setStopping(true);
    const result = await stop();
    setStopping(false);
    if (!result.ok) setProblem(refusal(result, 'Could not stop the turn.'));
  };

  return (
    <div className="chat-main" data-testid="chat-main">
      <div className="chat-head">
        <h3 className="chat-title" data-testid="chat-title">
          {view?.title ?? (session ? '' : 'New chat')}
        </h3>
        {view && (
          <span className="chat-state" data-testid="chat-state" data-state={turnPhase(view)}>
            {stateLabel(view)}
          </span>
        )}
      </div>
      <p className="sr-only" role="status" aria-live="polite" data-testid="chat-announce">
        {announcement}
      </p>
      {view?.truncated && <p className="chat-note">Only the latest messages are shown.</p>}
      {view ? (
        <ChatLog key={view.session} items={view.items} tail={view.tail} />
      ) : (
        <p className="chat-empty" data-testid="chat-empty">
          {session
            ? 'Loading the conversation…'
            : 'Send a message to start a new Claude session. It has no ticket.'}
        </p>
      )}
      {error && (
        <p className="chat-turn-note" data-testid="chat-stream-error">
          {error}
        </p>
      )}
      {note && (
        <p className="chat-turn-note" data-testid="chat-turn-note">
          {note}
        </p>
      )}
      <form className="chat-composer" onSubmit={submit}>
        <label className="sr-only" htmlFor={fieldId}>
          Message
        </label>
        <textarea
          id={fieldId}
          ref={field}
          rows={3}
          value={text}
          readOnly={blocked}
          aria-disabled={blocked || undefined}
          aria-describedby={reason ? reasonId : undefined}
          placeholder="Message Claude"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            event.currentTarget.form.requestSubmit();
          }}
        />
        {reason && (
          <p id={reasonId} className="chat-disabled-reason" data-testid="chat-disabled-reason">
            {reason}
          </p>
        )}
        {problem && (
          <p className="chat-turn-note" role="alert" data-testid="chat-send-error">
            {problem}
          </p>
        )}
        <div className="chat-actions">
          <Button type="submit" data-testid="chat-send" disabled={blocked || !text.trim()}>
            Send
          </Button>
          {live && (
            <Button data-testid="chat-stop" disabled={stopping} onClick={halt}>
              Stop
            </Button>
          )}
          {retryable && (
            <Button
              data-testid="chat-retry"
              disabled={blocked}
              onClick={() => deliver(lastUser.text)}
            >
              Retry
            </Button>
          )}
          {(outside || error) && (
            <Button data-testid="chat-refresh" onClick={refresh}>
              Refresh
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}

// The Chat screen: the standalone chats on the left, one conversation on the right. `session` is the
// chat the address names (`#/chat?session=<uuid>`), or null for a new one. The conversation is keyed by
// it, so another chat starts from nothing: no transcript, draft or Retry of the last one. Its stream is
// open only while this screen is.
export function ChatPanel({ active, session }) {
  const claude = useClaudeTickets({ active, source: 'chat' });
  const focusOnMount = useRef(false);
  return (
    <BoardPanel id="chat" active={active}>
      <BoardSection
        name="chat"
        title="Chat"
        sub="Talk to a Claude session, with or without a ticket."
        testIds={{ title: 'chat-heading', list: 'chat-body' }}
      >
        <div className="board-pane chat-pane">
          <div className="chat">
            <ChatList chats={claude.chats} session={session} />
            <ChatConversation
              key={session ?? 'new'}
              active={active}
              session={session}
              focusOnMount={focusOnMount}
            />
          </div>
        </div>
      </BoardSection>
    </BoardPanel>
  );
}
