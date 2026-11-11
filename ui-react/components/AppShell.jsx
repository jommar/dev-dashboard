import { Button } from './Primitives.jsx';
import { AppTabs } from './AppTabs.jsx';
import { BotBar } from './BotBar.jsx';
import logoUrl from '../assets/logo.svg?no-inline';

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
      {/* An overlay on every screen once the app is set up; setup-only mode (Settings alone) has none. */}
      {ready && <BotBar />}
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
