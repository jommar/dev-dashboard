import { useCallback, useEffect, useRef, useState } from 'react';
import { CssBaseline, ThemeProvider } from '@mui/material';
import { AppShell, StartupState } from './components/AppShell.jsx';
import { dashboardTheme } from './theme.js';
import { getConfig } from './lib/api.js';
import { useServiceEvents } from './hooks/useServiceEvents.js';
import { HomePanel } from './panels/HomePanel.jsx';
import { ServicesPanel } from './panels/ServicesPanel.jsx';
import { PrsPanel } from './panels/PrsPanel.jsx';
import { MyTicketsPanel } from './panels/MyTicketsPanel.jsx';
import { ReleasesPanel } from './panels/ReleasesPanel.jsx';
import { SettingsPanel } from './panels/SettingsPanel.jsx';
import { TooltipLayer } from './components/Tooltip.jsx';
import './styles.css';

const READY_TABS = [
  { id: 'home', label: 'Home' },
  { id: 'services', label: 'Services' },
  { id: 'prs', label: 'Pull Requests' },
  { id: 'my-tickets', label: 'My Tickets' },
  { id: 'releases', label: 'Releases' },
  { id: 'settings', label: 'Settings' },
];
const SETTINGS_TAB = [{ id: 'settings', label: 'Settings' }];
const parseHash = () => {
  const [route = '', query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  return { route, query };
};
const routeFromHash = (tabs) => {
  const { route } = parseHash();
  return tabs.some(({ id }) => id === route) ? route : tabs[0].id;
};
// Only Releases keeps its query string (?view=list); every other route drops it.
const hashFor = (route, query = '') =>
  `#/${route}${route === 'releases' && query ? `?${query}` : ''}`;
// Any of these keys set to "list" selects the list view; anything else is the card view.
const releaseViewFromQuery = (query) => {
  const params = new URLSearchParams(query);
  return ['mode', 'view', 'v', 'm'].some((key) => params.get(key) === 'list') ? 'list' : 'cards';
};

export function App() {
  const [config, setConfig] = useState(null);
  const [bootError, setBootError] = useState(false);
  const [active, setActive] = useState('home');
  const [releaseView, setReleaseView] = useState(() => releaseViewFromQuery(parseHash().query));
  const [reloadKey, setReloadKey] = useState(0);
  const redirecting = useRef(false);
  const ready = config?.setup?.ready === true;
  const tabs = ready ? READY_TABS : SETTINGS_TAB;
  const setupChanged = useCallback(() => {
    if (redirecting.current) return;
    redirecting.current = true;
    history.replaceState(null, '', '#/settings');
    location.reload();
  }, []);
  const { services, connection } = useServiceEvents(ready, setupChanged);

  const boot = useCallback(async () => {
    setBootError(false);
    try {
      const result = await getConfig();
      setConfig(result);
      const nextTabs = result.setup?.ready === true ? READY_TABS : SETTINGS_TAB;
      const next = routeFromHash(nextTabs);
      const target = hashFor(next, parseHash().query);
      if (location.hash !== target) history.replaceState(null, '', target);
      setActive(next);
      setReleaseView(releaseViewFromQuery(parseHash().query));
    } catch {
      setBootError(true);
    }
  }, []);

  useEffect(() => {
    boot();
  }, [boot, reloadKey]);

  useEffect(() => {
    const change = () => {
      const next = routeFromHash(tabs);
      const target = hashFor(next, parseHash().query);
      if (location.hash !== target) history.replaceState(null, '', target);
      setActive(next);
      setReleaseView(releaseViewFromQuery(parseHash().query));
    };
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, [tabs]);

  const navigate = useCallback(
    (id) => {
      const allowed = (ready ? READY_TABS : SETTINGS_TAB).some((tab) => tab.id === id);
      const next = allowed ? id : ready ? 'home' : 'settings';
      if (location.hash !== hashFor(next)) location.hash = hashFor(next);
      setActive(next);
    },
    [ready],
  );

  // Pushes a history entry, so Back returns to the previous view.
  const changeReleaseView = useCallback((view) => {
    const target = hashFor('releases', view === 'list' ? 'view=list' : '');
    if (location.hash !== target) location.hash = target;
    setReleaseView(view);
  }, []);

  return (
    <ThemeProvider theme={dashboardTheme}>
      <CssBaseline />
      {!config ? (
        <StartupState error={bootError} onRetry={() => setReloadKey((key) => key + 1)} />
      ) : (
        <AppShell
          tabs={tabs}
          active={active}
          onNavigate={navigate}
          connection={connection}
          ready={ready}
        >
          {ready && (
            <>
              <HomePanel config={config} active={active === 'home'} services={services} />
              <ServicesPanel config={config} active={active === 'services'} services={services} />
              <PrsPanel config={config} active={active === 'prs'} />
              <MyTicketsPanel config={config} active={active === 'my-tickets'} />
              <ReleasesPanel
                config={config}
                active={active === 'releases'}
                view={releaseView}
                onViewChange={changeReleaseView}
              />
            </>
          )}
          <SettingsPanel config={config} active={active === 'settings'} />
          <TooltipLayer />
        </AppShell>
      )}
    </ThemeProvider>
  );
}
