import { Button } from './Primitives.jsx';
import { AppTabs } from './AppTabs.jsx';

export function AppShell({ children, tabs, active, onNavigate, connection, ready }) {
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
              <svg viewBox="0 0 32 32" fill="none" focusable="false">
                <path d="M9 9h14M9 16h10M9 23h14" stroke="currentColor" strokeWidth="3" />
                <path d="m25 5-8 22" stroke="currentColor" strokeWidth="2" />
              </svg>
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
            <span
              id="connection-status"
              data-testid="connection-status"
              role="status"
              data-state={connection}
              title={connectionLabel}
            >
              <span className="connection-label">{connectionLabel}</span>
            </span>
          )}
        </div>
      </header>
      <main className="panels" id="workspace" tabIndex={-1}>
        {children}
      </main>
      <div id="tooltip" className="tooltip" hidden data-testid="tooltip" />
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
