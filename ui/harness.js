// The UI's harness wording, pure. GET /api/config carries `harness`; harnessFrom validates it and
// says nothing but Claude Code when it is absent or invalid, so every pinned string stays as it is.
export const DEFAULT_HARNESS = Object.freeze({
  id: 'claude-code',
  label: 'Claude Code',
  name: 'Claude',
  command: 'claude',
  capabilities: Object.freeze({ chat: true, usage: true }),
});

const text = (v) => typeof v === 'string' && v.length <= 40 && !/\p{Cc}/u.test(v);
const flag = (v) => typeof v === 'boolean';

export function harnessFrom(raw) {
  const c = raw?.capabilities;
  const ok =
    typeof raw?.id === 'string' &&
    /^[a-z][a-z0-9-]{0,31}$/.test(raw.id) &&
    [raw.label, raw.name, raw.command].every(text) &&
    flag(c?.chat) &&
    flag(c?.usage);
  if (!ok) return DEFAULT_HARNESS;
  const { id, label, name, command } = raw;
  return { id, label, name, command, capabilities: { chat: c.chat, usage: c.usage } };
}

// Fills {name}, {label}, {command} and {A} ("A" or "An" by the name's first letter, lower case
// unless it opens the text).
export function say(template, harness) {
  const an = /^[aeiou]/i.test(harness.name);
  return template
    .replaceAll('{name}', harness.name)
    .replaceAll('{label}', harness.label)
    .replaceAll('{command}', harness.command)
    .replace(/\{A\}/g, (m, at) => {
      const a = an ? 'An' : 'A';
      return at ? a.toLowerCase() : a;
    });
}

export const can = (harness, capability) => harness.capabilities[capability] === true;
