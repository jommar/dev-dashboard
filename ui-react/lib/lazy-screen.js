import { lazy } from 'react';

// `React.lazy` for a module that exports its component by name (every panel and dialog here does):
// `lazyScreen(() => import('../panels/ChatPanel.jsx'), 'ChatPanel')`. The importer stays a literal
// `import()` at the call site so the bundler can split it.
export const lazyScreen = (importer, name) =>
  lazy(() => importer().then((module) => ({ default: module[name] })));
