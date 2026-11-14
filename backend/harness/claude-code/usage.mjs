// usage.mjs — what a Claude Code transcript line says about tokens: an assistant message carries
// `message.id`, `message.model` and `message.usage`. Numbers and a model id only.

const MODEL_ID = /^[\w.:[\]-]{1,100}$/;
const FIELDS = {
  input: 'input_tokens',
  output: 'output_tokens',
  cacheRead: 'cache_read_input_tokens',
  cacheCreation: 'cache_creation_input_tokens',
};

const count = (value) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

// One transcript line as `{ id, model, tokens }`, or null when it is not a message with usage.
export function parseLine(line) {
  if (!line.includes('"usage"')) return null;
  let message;
  try {
    message = JSON.parse(line)?.message;
  } catch {
    return null;
  }
  const { id, usage, model } = message ?? {};
  if (typeof id !== 'string' || !usage || typeof usage !== 'object') return null;
  return {
    id,
    model: typeof model === 'string' && MODEL_ID.test(model) ? model : null,
    tokens: Object.fromEntries(
      Object.entries(FIELDS).map(([name, key]) => [name, count(usage[key])]),
    ),
  };
}
