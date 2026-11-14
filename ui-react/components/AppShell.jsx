import { memo, useCallback, useMemo } from 'react';
import { Button, DashboardTooltip } from './Primitives.jsx';
import { AppTabs as AppTabsView } from './AppTabs.jsx';
import { BotBar as BotBarView } from './BotBar.jsx';
import { LazyDialog } from './ScreenSlot.jsx';
import { ShortcutsHelp } from '../lib/lazy-overlays.js';
import { useGlobalShortcuts } from '../hooks/useGlobalShortcuts.js';
import { useRouteChange } from '../hooks/useRouteChange.js';
import { ShortcutsContext } from '../lib/shortcuts-context.js';
import logoUrl from '../assets/logo.svg?no-inline';

// The service feed re-renders App, and so this shell, on every status or log line; neither the tab
// row (stable `tabs` and `onNavigate`) nor the bot bar (no props, its own polling) depends on it.
const AppTabs = memo(AppTabsView);
const BotBar = memo(BotBarView);

export function AppShell({ children, tabs, active, onNavigate, connection, ready }) {
  const { palette, setPalette, helpOpen, setHelpOpen } = useGlobalShortcuts({
    tabs,
    active,
    onNavigate,
  });
  const announcement = useRouteChange({ active, tabs });
  const shortcuts = useMemo(
    () => ({ palette, setPalette, tabs, onNavigate }),
    [palette, setPalette, tabs, onNavigate],
  );
  const closeHelp = useCallback(() => setHelpOpen(false), [setHelpOpen]);
  const connectionLabel =
    connection === 'connected'
      ? 'Live service feed'
      : connection === 'connecting'
        ? 'Connecting to services'
        : 'Reconnecting · status may be stale';
  return (
    <>
      <a
        className="skip-link"
        href="#workspace"
        data-testid="skip-workspace"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById('workspace')?.focus();
        }}
      >
        Skip to workspace
      </a>
      <header className="app-head" data-testid="main-nav">
        <h1 data-testid="dashboard-title">
          <a
            href={ready ? '#/home' : '#/settings'}
            className="home-link"
            data-testid="home-link"
            onClick={(event) => {
              event.preventDefault();
              onNavigate(ready ? 'home' : 'settings');
            }}
          >
            <span className="brand-mark" aria-hidden="true">
              <img src={logoUrl} alt="" width="36" height="36" draggable={false} />
            </span>
            <span className="brand-name">
              EZAT<span className="brand-caption">Dev workspace</span>
            </span>
          </a>
        </h1>
        <AppTabs tabs={tabs} active={active} onNavigate={onNavigate} />
        <div className="shell-foot">
          <span className="shell-location">Local workspace</span>
          {ready && (
            <DashboardTooltip title={connectionLabel} describeChild>
              <span
                id="connection-status"
                data-testid="connection-status"
                role="status"
                data-state={connection}
              >
                <span className="connection-label">{connectionLabel}</span>
              </span>
            </DashboardTooltip>
          )}
        </div>
      </header>
      <main className="panels" id="workspace" tabIndex={-1}>
        {children}
      </main>
      {/* The one polite region that says which screen was opened; empty on first load. */}
      <div className="sr-only" role="status" aria-live="polite" data-testid="route-announcement">
        {announcement}
      </div>
      {/* An overlay on every screen once the app is set up; setup-only mode (Settings alone) has none.
          It also renders the command palette, which needs the shortcuts' state. */}
      <ShortcutsContext.Provider value={shortcuts}>{ready && <BotBar />}</ShortcutsContext.Provider>
      {helpOpen && (
        <LazyDialog label="The shortcuts help" onClose={closeHelp}>
          <ShortcutsHelp tabs={tabs} onClose={closeHelp} />
        </LazyDialog>
      )}
    </>
  );
}

export function StartupState({ error, onRetry }) {
  return (
    <section className="startup" data-testid="startup">
      <h2>{error ? 'Workspace unavailable' : 'Opening your workspace'}</h2>
      {error ? (
        <>
          <p role="alert">
            Could not load configuration. Check the dashboard connection and try again.
          </p>
          <Button data-testid="startup-retry" onClick={onRetry}>
            Try again
          </Button>
        </>
      ) : (
        <p role="status">Connecting to the dashboard…</p>
      )}
    </section>
  );
}
