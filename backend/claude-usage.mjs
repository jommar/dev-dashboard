// claude-usage.mjs — token tallies of Claude transcripts, for the Claude dialog and the Chat head.
//
// A transcript line of an assistant message carries `message.id`, `message.model` and
// `message.usage`. One API message is written as several lines with the same id and the same usage,
// and the lines of one message are contiguous, so a file keeps ONE pending `{ id, usage }` and
// commits it when a different id arrives: the state per file is constant. Each file keeps a byte
// offset and only newly appended complete lines are parsed. A file that shrinks or changes inode is
// read again from its start. A request (`tallyMany`, or one `tally`) reads at most `budgetBytes` in
// all and looks at most `maxFiles` files; the rest is reported as `complete: false` and later
// requests continue where this one stopped.
//
// Metadata only: the cache holds numbers and model ids, never a line, a message or a path's content,
// and nothing is logged. Paths come from `claudeSessions.transcriptFiles` (names only); a caller
// never supplies one. The chat's one-writer mark is never taken: this only reads.
import { open, stat } from 'node:fs/promises';

const BUDGET_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 256;
const MODEL_ID = /^[\w.:[\]-]{1,100}$/;
const FIELDS = {
  input: 'input_tokens',
  output: 'output_tokens',
  cacheRead: 'cache_read_input_tokens',
  cacheCreation: 'cache_creation_input_tokens',
};

const emptyTokens = () => Object.fromEntries(Object.keys(FIELDS).map((name) => [name, 0]));
const count = (value) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

async function readBytes(file, offset, length) {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

const freshState = (ino) => ({
  ino,
  offset: 0,
  // True after a line longer than a whole request's budget: bytes are dropped up to its newline.
  skipping: false,
  pending: null,
  tokens: emptyTokens(),
  models: new Map(),
  messages: 0,
});

function commit(state) {
  const { pending } = state;
  if (!pending) return;
  for (const name of Object.keys(FIELDS)) state.tokens[name] += pending.usage[name];
  state.messages += 1;
  if (pending.model) state.models.set(pending.model, (state.models.get(pending.model) ?? 0) + 1);
  state.pending = null;
}

// Folds one complete line into `state`. Anything that is not an assistant line with usage is ignored.
function foldLine(state, line) {
  if (!line.includes('"usage"')) return;
  let message;
  try {
    message = JSON.parse(line)?.message;
  } catch {
    return;
  }
  const { id, usage, model } = message ?? {};
  if (typeof id !== 'string' || !usage || typeof usage !== 'object') return;
  if (state.pending?.id !== id) commit(state);
  state.pending = {
    id,
    model: typeof model === 'string' && MODEL_ID.test(model) ? model : null,
    usage: Object.fromEntries(
      Object.entries(FIELDS).map(([name, key]) => [name, count(usage[key])]),
    ),
  };
}

// Reads what is new in `file` into its state, within `budget.left` bytes. False when the file could
// not be read to its end.
async function advance(state, file, size, budget, io) {
  while (state.offset < size) {
    const length = Math.min(size - state.offset, budget.left);
    if (length <= 0) return false;
    const chunk = await io.read(file, state.offset, length);
    if (!chunk.length) return false;
    budget.left -= chunk.length;
    const lastBreak = chunk.lastIndexOf(0x0a);
    if (lastBreak < 0) {
      // A half line at the end of the file waits for the rest of it.
      if (state.offset + chunk.length >= size) return true;
      // Out of budget for this request.
      if (chunk.length < budget.limit) return false;
      // A line longer than a whole request may read is dropped, up to its newline.
      state.skipping = true;
      state.offset += chunk.length;
      continue;
    }
    const complete = chunk.subarray(0, lastBreak + 1).toString('utf8');
    const lines = (state.skipping ? complete.slice(complete.indexOf('\n') + 1) : complete).split(
      '\n',
    );
    state.skipping = false;
    for (const line of lines) if (line) foldLine(state, line);
    state.offset += lastBreak + 1;
  }
  return true;
}

function snapshot(states) {
  const tokens = emptyTokens();
  const models = {};
  let messages = 0;
  for (const state of states) {
    for (const name of Object.keys(FIELDS)) tokens[name] += state.tokens[name];
    for (const [model, n] of state.models) models[model] = (models[model] ?? 0) + n;
    messages += state.messages;
    if (state.pending) {
      for (const name of Object.keys(FIELDS)) tokens[name] += state.pending.usage[name];
      messages += 1;
      if (state.pending.model) models[state.pending.model] = (models[state.pending.model] ?? 0) + 1;
    }
  }
  return { tokens, models, messages };
}

export function createUsageReader({
  io = { stat, read: readBytes },
  budgetBytes = BUDGET_BYTES,
  maxFiles = MAX_FILES,
} = {}) {
  // Least recently used first: a touched file is deleted and set again.
  const cache = new Map();
  let queue = Promise.resolve();

  async function readFile(file, budget) {
    let size;
    let ino;
    try {
      ({ size, ino } = await io.stat(file));
    } catch {
      cache.delete(file);
      return { state: null, complete: false };
    }
    let state = cache.get(file);
    if (!state || state.ino !== ino || size < state.offset) state = freshState(ino);
    cache.delete(file);
    cache.set(file, state);
    while (cache.size > maxFiles) cache.delete(cache.keys().next().value);
    try {
      return { state, complete: await advance(state, file, size, budget, io) };
    } catch {
      return { state, complete: false };
    }
  }

  // `budget` is shared by everything one request reads: bytes left and files left.
  async function tallyFiles(files, budget) {
    const states = [];
    const looked = files.slice(0, Math.max(0, budget.filesLeft));
    budget.filesLeft -= looked.length;
    let complete = looked.length === files.length;
    for (const file of looked) {
      const result = await readFile(file, budget);
      if (result.state) states.push(result.state);
      if (!result.complete) complete = false;
    }
    return { ...snapshot(states), complete };
  }

  async function tallyRequest(filesById) {
    const budget = { left: budgetBytes, limit: budgetBytes, filesLeft: maxFiles };
    const answers = {};
    for (const [id, files] of Object.entries(filesById))
      answers[id] = await tallyFiles(files, budget);
    return answers;
  }

  // Calls run one at a time, so two requests never move one file's offset together.
  function serialized(work) {
    const run = queue.then(work);
    queue = run.catch(() => {});
    return run;
  }

  // One request over several sessions, `{ [id]: files }`, sharing one byte budget and one file cap:
  // `{ [id]: { tokens, models, messages, complete } }`.
  const tallyMany = (filesById) => serialized(() => tallyRequest(filesById));

  // The tally over `files` (one session's transcript and its subagents'), as its own request.
  const tally = (files) => serialized(async () => (await tallyRequest({ files })).files);

  // The cached per-file state as plain data, so a test can see that it holds no text.
  const inspect = () =>
    [...cache.values()].map((state) => ({ ...state, models: Object.fromEntries(state.models) }));

  return { tally, tallyMany, inspect, cacheSize: () => cache.size };
}
