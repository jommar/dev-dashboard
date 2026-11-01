// A session's picker label: its name or id, its state, and "attached" when it is already
// on some thread. The Watch threads card and the thread dialog's picker both show it.
export const sessionOptionLabel = ({ sessionId, name, state, attached }) =>
  [name || sessionId, state, attached ? 'attached' : null].filter(Boolean).join(' · ');
