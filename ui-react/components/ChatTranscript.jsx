// ChatTranscript.jsx — the conversation of the Chat screen: messages, collapsible tool chips and the
// reply being written. A message and a chip are memoized on their item, and the reducer keeps every
// item it did not change, so a streamed delta re-renders only the live tail. The assistant's text is
// Markdown (MarkdownView, with a Copy button on each code block); the user's is plain text.
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MarkdownView } from './MarkdownView.jsx';
import { Button } from './Primitives.jsx';
import { copyText } from '../../ui/dom.js';

// How long "Copied" shows on a copy button.
const COPIED_MS = 2000;
// How close to the end the reader must be for the log to keep following new output.
const FOLLOW_SLACK_PX = 24;

// `label` is the visible word; `name` is the longer accessible name that starts with it, left off while
// the word says "Copied" or "Copy failed" so a screen reader hears the outcome.
function CopyButton({ text, label, name, testId }) {
  const [outcome, setOutcome] = useState(null);
  useEffect(() => {
    if (!outcome) return undefined;
    const timer = setTimeout(() => setOutcome(null), COPIED_MS);
    return () => clearTimeout(timer);
  }, [outcome]);
  return (
    <Button
      className="subtle chat-copy"
      data-testid={testId}
      aria-label={outcome ? undefined : name}
      onClick={async () => setOutcome((await copyText(text)) ? 'Copied' : 'Copy failed')}
    >
      {outcome ?? label}
    </Button>
  );
}

// The text of a fenced block, from the Markdown tree: react-markdown ends it with a newline.
const codeText = (node) =>
  (node?.children ?? [])
    .flatMap((code) => code.children ?? [])
    .map(({ value }) => value ?? '')
    .join('')
    .replace(/\n$/, '');

function CodeBlock({ node, children }) {
  return (
    <div className="chat-code">
      <CopyButton text={codeText(node)} label="Copy code" />
      <pre>{children}</pre>
    </div>
  );
}
const MARKDOWN_COMPONENTS = { pre: CodeBlock };

const ChatMessage = memo(function ChatMessage({ item }) {
  const mine = item.kind === 'user';
  return (
    <article className="chat-message" data-kind={item.kind} data-testid={`chat-message-${item.id}`}>
      <header className="chat-message-head">
        <span className="chat-who">{mine ? 'You' : 'Claude'}</span>
        <CopyButton
          text={item.text}
          label="Copy"
          name={mine ? 'Copy your text' : 'Copy reply'}
          testId={`chat-copy-${item.id}`}
        />
      </header>
      {mine ? (
        <p className="chat-plain">{item.text}</p>
      ) : (
        <MarkdownView components={MARKDOWN_COMPONENTS}>{item.text}</MarkdownView>
      )}
    </article>
  );
});

// A tool call is closed by default: its name and status in the summary, its input and result inside.
// The status is a word, never colour alone.
const ChatToolChip = memo(function ChatToolChip({ item }) {
  const status = !item.result ? 'running' : item.result.isError ? 'failed' : 'done';
  return (
    <details className="chat-tool" data-status={status} data-testid={`chat-tool-${item.id}`}>
      <summary>
        <span className="chat-tool-name">{item.name}</span>
        <span className="chat-tool-status">{status}</span>
      </summary>
      <div className="chat-tool-body">
        <span className="chat-tool-label">Input</span>
        <pre>{item.input}</pre>
        {item.result && (
          <>
            <span className="chat-tool-label">{item.result.isError ? 'Error' : 'Result'}</span>
            <pre>{item.result.text}</pre>
          </>
        )}
        {item.truncated && <p className="chat-tool-cut">Shortened for display.</p>}
      </div>
    </details>
  );
});

// The scrolling log. It follows new output only while the reader is at the bottom, so scrolling up
// to read is never undone, except when a message of the reader's own arrives. It is announced by the screen's one status line, not as it streams
// (`aria-live="off"`), and it takes focus so the keyboard can scroll it.
export function ChatLog({ items, tail }) {
  const log = useRef(null);
  const following = useRef(true);
  const lastSent = useRef(null);
  useLayoutEffect(() => {
    // Sending a message is asking to see the answer, wherever the reader had scrolled to.
    const sent = items.findLast(({ kind }) => kind === 'user')?.id;
    if (sent !== lastSent.current) following.current = true;
    lastSent.current = sent;
    if (following.current) log.current.scrollTop = log.current.scrollHeight;
  }, [items, tail]);
  return (
    <div
      ref={log}
      className="chat-log"
      role="log"
      aria-live="off"
      aria-label="Conversation"
      tabIndex={0}
      data-testid="chat-log"
      onScroll={() => {
        const { scrollHeight, scrollTop, clientHeight } = log.current;
        following.current = scrollHeight - scrollTop - clientHeight <= FOLLOW_SLACK_PX;
      }}
    >
      {items.map((item) =>
        item.kind === 'tool' ? (
          <ChatToolChip key={item.id} item={item} />
        ) : (
          <ChatMessage key={item.id} item={item} />
        ),
      )}
      {tail && (
        <div className="chat-message" data-kind="assistant">
          <span className="chat-who">Claude</span>
          <p className="chat-plain" data-testid="chat-tail">
            {tail}
          </p>
        </div>
      )}
    </div>
  );
}
