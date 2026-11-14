// command-palette.js — the entries of the command palette and the search over them, with no DOM.
// An entry is `{ id, group, name, hint, text, action }`: `name` is its accessible name, `hint` the
// chord shown beside it, `text` what a search matches and `action` what choosing it does (the palette's
// owner carries it out): `tab`, `session`, `new-chat`, `refresh` or `ticket`.
import { phaseWords } from './session-phases.js';
import { BOT_STATE_WORDS } from './bot-bar.js';
import { chordHint } from './shortcuts.js';
import { ticketFromText } from './ticket-link.js';

// A tab's tooltip: its label and, when it has one, its chord.
export const tabLabelWithChord = (label, tabId) => {
  const chord = chordHint(tabId);
  return chord ? `${label} (g then ${chord})` : label;
};

const entry = (group, id, name, action, { hint = '', extra = '' } = {}) => ({
  id,
  group,
  name,
  hint,
  text: `${group} ${name} ${hint} ${extra}`.toLowerCase(),
  action,
});

// The entries for `tabs` (`{ id, label }`), the session `groups` of the drawer (`sessionGroups`), the
// active tab id, whether that screen has a registered refresh and the typed `query`. A ticket key typed
// in whole adds an entry that opens it in My Tickets, among the actions (after any session of that
// ticket, so Enter on a session's key still opens the session).
export function paletteEntries({ tabs, groups, active, refresh, query }) {
  const key = ticketFromText(query);
  const tab = tabs.find(({ id }) => id === active);
  return [
    ...tabs.map(({ id, label }) => {
      const chord = chordHint(id);
      return entry(
        'Go to',
        `tab-${id}`,
        `Go to ${label}`,
        { type: 'tab', id },
        {
          hint: chord ? `g ${chord}` : '',
        },
      );
    }),
    ...groups.flatMap(({ rows }) =>
      rows.map((row) =>
        entry(
          'Sessions',
          `session-${row.key}`,
          `Open ${row.title ?? row.ticket} ${phaseWords(row.phase)} session`,
          { type: 'session', ticket: row.ticket, phase: row.phase },
          { extra: BOT_STATE_WORDS[row.state] ?? '' },
        ),
      ),
    ),
    ...(key
      ? [entry('Actions', `ticket-${key}`, `Open ${key} in My Tickets`, { type: 'ticket', key })]
      : []),
    entry('Actions', 'new-chat', 'New chat', { type: 'new-chat' }),
    ...(refresh && tab
      ? [entry('Actions', 'refresh', `Refresh ${tab.label}`, { type: 'refresh', id: tab.id })]
      : []),
  ];
}

// The entries every whitespace term of `query` appears in (case-insensitive); a blank query keeps all.
export function filterEntries(entries, query) {
  const terms = String(query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return terms.length === 0
    ? entries
    : entries.filter(({ text }) => terms.every((term) => text.includes(term)));
}
