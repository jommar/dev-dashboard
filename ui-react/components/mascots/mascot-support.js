// What the five mascot components share: the state-to-pose mapping, the class list and the label.
// `waiting` is the designs' idle pose, so the stylesheets keep their `--idle` class.
const POSE = { working: 'working', waiting: 'idle', done: 'done', failed: 'failed' };

/** `bot-<slug> bot-<slug>--<pose> bot-<slug>--<facing>` plus any `--<modifier>` that is truthy. */
export function botClass(slug, state, facing, ...modifiers) {
  const base = `bot-${slug}`;
  return [
    base,
    `${base}--${POSE[state] ?? 'idle'}`,
    `${base}--${facing === 'left' ? 'left' : 'right'}`,
    ...modifiers.filter(Boolean).map((modifier) => `${base}--${modifier}`),
  ].join(' ');
}

export const botLabel = (name, state, label) => label || `${name}: ${state}`;
