// The one table of the Claude session phases the Sessions drawer shows: the words (tooltip, row name,
// search), the icon (a `NavIcon` name, paths in NavIcon.jsx) and the colour (a custom property declared
// in styles/tokens.css, never a hex). A new phase, or a new look for one, is a row here, plus its token
// and icon path when it needs them.
export const PHASES = {
  investigate: { words: 'Investigate and plan', icon: 'investigate', color: '--phase-investigate' },
  implement: { words: 'Implement plan', icon: 'implement', color: '--phase-implement' },
  review: { words: 'Code review', icon: 'review', color: '--phase-review' },
  groom: { words: 'Groom ticket', icon: 'groom', color: '--phase-groom' },
  e2e: { words: 'E2E check', icon: 'e2e', color: '--phase-e2e' },
  chat: { words: 'Chat', icon: 'chat', color: '--phase-chat' },
};

// The words of a phase; one the table does not know is shown as it is.
export const phaseWords = (phase) => PHASES[phase]?.words ?? phase;
