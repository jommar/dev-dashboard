import { createContext } from 'react';

// What the keyboard layer shares with the bot bar, which renders the command palette (it owns the
// session list and the open-a-session handler): `{ palette, setPalette, tabs, onNavigate }`, where
// `palette` is null while closed and `{ active }` (the tab id it opened over) while open. Null outside
// the app shell.
export const ShortcutsContext = createContext(null);
