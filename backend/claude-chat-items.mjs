// claude-chat-items.mjs — what the chat shows of a Claude session, as pure functions: one stdout line
// of a turn's process becomes the events the browser gets (`liveMessages`), and a session's
// transcript becomes the items of its history (`historyItems`). Both build the same items (a user
// message, an assistant text, a tool call with its result), so a reply looks the same live and
// after a reload.
//
// Nothing here reads a file, runs a process or logs: a raw CLI event never leaves this module, only
// the normalized `item`, `delta` and the turn's outcome do.

// A tool's input and result are each cut to this many characters, and a turn's error text to its own.
const TEXT_LIMIT = 8192;
const ERROR_LIMIT = 2000;
// The history keeps the newest of this many items.
const HISTORY_ITEM_LIMIT = 300;
const NON_TEXT_RESULT = '[non-text result]';

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function cutText(text) {
  return text.length > TEXT_LIMIT
    ? { text: text.slice(0, TEXT_LIMIT), cut: true }
    : { text, cut: false };
}

// A tool result's text: a string as it is, a list of text blocks joined, anything else a marker.
function resultText(content) {
  if (typeof content === 'string') return content;
  if (
    Array.isArray(content) &&
    content.length &&
    content.every((block) => block?.type === 'text' && typeof block.text === 'string')
  )
    return content.map((block) => block.text).join('\n');
  return NON_TEXT_RESULT;
}

function toolItem({ id, name, input }) {
  const { text, cut } = cutText(JSON.stringify(input ?? {}, null, 2));
  return { id, kind: 'tool', name, input: text, result: null, truncated: cut };
}

// The same tool item once its result is known.
function withResult(item, block) {
  const { text, cut } = cutText(resultText(block.content));
  return {
    ...item,
    result: { text, isError: block.is_error === true },
    truncated: item.truncated || cut,
  };
}

// The items of one assistant message: its text, and each tool call (a thinking block is nothing).
function itemsOfAssistant({ message, uuid }) {
  const content = Array.isArray(message?.content) ? message.content : [];
  const items = [];
  for (const block of content) {
    if (block?.type === 'text' && block.text && typeof uuid === 'string')
      items.push({ id: uuid, kind: 'assistant', text: block.text });
    else if (block?.type === 'tool_use' && typeof block.id === 'string')
      items.push(toolItem({ id: block.id, name: String(block.name), input: block.input }));
  }
  return items;
}

const resultBlocks = ({ message }) =>
  (Array.isArray(message?.content) ? message.content : []).filter(
    (block) => block?.type === 'tool_result' && typeof block.tool_use_id === 'string',
  );

// What the turn's `result` line says: how the turn ended, and the facts the `state` event carries.
function noteResult(line, turn) {
  const aborted =
    typeof line.terminal_reason === 'string' && line.terminal_reason.startsWith('aborted');
  const outcome = aborted ? 'stopped' : line.is_error === true ? 'failed' : 'completed';
  turn.outcome = outcome;
  turn.reason = outcome === 'failed' ? 'api_error' : null;
  turn.error =
    outcome === 'failed' && typeof line.result === 'string'
      ? line.result.slice(0, ERROR_LIMIT)
      : null;
  turn.denials = (Array.isArray(line.permission_denials) ? line.permission_denials : [])
    .map((denial) => denial?.tool_name)
    .filter((name) => typeof name === 'string');
  turn.costUsd = Number.isFinite(line.total_cost_usd) ? line.total_cost_usd : null;
}

// One stdout line of the turn's process, as the events it becomes: `[{ event, data }]`, usually
// none. `turn` is one object kept for the whole turn: it remembers the tool items sent (a result
// comes as the same item again) and, once the `result` line is seen, holds `outcome`, `reason`,
// `error`, `denials` and `costUsd`. A line that is not JSON, subagent traffic and every line the chat
// has no use for are nothing.
export function liveMessages(text, turn) {
  let line;
  try {
    line = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isObject(line) || line.parent_tool_use_id) return [];
  if (line.type === 'stream_event') {
    const { event } = line;
    return event?.type === 'content_block_delta' &&
      event.delta?.type === 'text_delta' &&
      typeof event.delta.text === 'string'
      ? [{ event: 'delta', data: { text: event.delta.text } }]
      : [];
  }
  if (line.type === 'assistant') {
    const items = itemsOfAssistant(line);
    turn.tools ??= new Map();
    for (const item of items) if (item.kind === 'tool') turn.tools.set(item.id, item);
    return items.map((item) => ({ event: 'item', data: { item } }));
  }
  if (line.type === 'user') {
    const messages = [];
    for (const block of resultBlocks(line)) {
      const known = turn.tools?.get(block.tool_use_id);
      if (!known) continue;
      const item = withResult(known, block);
      turn.tools.set(item.id, item);
      messages.push({ event: 'item', data: { item } });
    }
    return messages;
  }
  if (line.type === 'result') noteResult(line, turn);
  return [];
}

// The transcript's lines that have a uuid, by uuid; a line without one is bookkeeping, not a node.
function transcriptNodes(text) {
  const nodes = new Map();
  const order = [];
  for (const raw of text.split('\n')) {
    let line;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isObject(line) || typeof line.uuid !== 'string') continue;
    nodes.set(line.uuid, line);
    order.push(line);
  }
  return { nodes, order };
}

// The newest branch of the transcript, root first: it starts at the last user or assistant line that
// is not a sidechain and follows `parentUuid` up. A resume that interleaves two writers leaves the
// older branch behind.
function newestBranch(text) {
  const { nodes, order } = transcriptNodes(text);
  const leaf = order.findLast(
    (line) => (line.type === 'user' || line.type === 'assistant') && line.isSidechain !== true,
  );
  const branch = [];
  const seen = new Set();
  for (let node = leaf; node && !seen.has(node.uuid); node = nodes.get(node.parentUuid)) {
    seen.add(node.uuid);
    branch.push(node);
  }
  return branch.reverse();
}

// The items of a session's transcript (the text of its `.jsonl`): the newest branch only, in order.
// A user line with string content (and no `isMeta`) is a user item; an assistant line gives its text
// and tool calls (a `<synthetic>` one gives nothing); a tool result goes inside its tool item. At
// most the newest 300 items are kept, and `truncated` says when the rest was dropped.
export function historyItems(text) {
  const items = [];
  const tools = new Map();
  for (const line of newestBranch(text)) {
    if (line.type === 'assistant' && line.message?.model !== '<synthetic>') {
      for (const item of itemsOfAssistant(line)) {
        items.push(item);
        if (item.kind === 'tool') tools.set(item.id, item);
      }
    } else if (line.type === 'user') {
      if (typeof line.message?.content === 'string' && line.isMeta !== true)
        items.push({ id: line.uuid, kind: 'user', text: line.message.content });
      for (const block of resultBlocks(line)) {
        const tool = tools.get(block.tool_use_id);
        if (tool) items[items.indexOf(tool)] = withResult(tool, block);
      }
    }
  }
  const truncated = items.length > HISTORY_ITEM_LIMIT;
  return { items: truncated ? items.slice(-HISTORY_ITEM_LIMIT) : items, truncated };
}
