import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { CssBaseline, ThemeProvider } from '@mui/material';
import { AppShell, StartupState } from './components/AppShell.jsx';
import { ScreenSlot } from './components/ScreenSlot.jsx';
import { dashboardTheme } from './theme.js';
import { getConfig } from './lib/api.js';
import { lazyScreen } from './lib/lazy-screen.js';
import { useServiceEvents } from './hooks/useServiceEvents.js';
import { HomePanel } from './panels/HomePanel.jsx';
import { ServicesPanel } from './panels/ServicesPanel.jsx';
import { PrsPanel } from './panels/PrsPanel.jsx';
import { MyTicketsPanel } from './panels/MyTicketsPanel.jsx';
import { SlackPanel } from './panels/SlackPanel.jsx';
import { SlackTabBadge } from './components/SlackTabBadge.jsx';
import { SettingsPanel } from './panels/SettingsPanel.jsx';
import { chatSessionFromQuery } from '../ui/chat-stream.js';
import { ticketFromQuery } from '../ui/ticket-link.js';
import './styles.css';

// Every screen is a `memo`, so the service feed re-rendering App (a status or log line changed) only
// re-renders the screen whose props changed: Services is the one that takes `services`. Home,
// My Tickets, Slack, Pull Requests, Services and Settings are eager; Chat, Releases, DevTools and
// Mascots load on first visit (see ScreenSlot), which keeps them out of the first-paint bundle.
const Home = memo(HomePanel);
const Services = memo(ServicesPanel);
const Prs = memo(PrsPanel);
const MyTickets = memo(MyTicketsPanel);
const Slack = memo(SlackPanel);
const Settings = memo(SettingsPanel);
const Releases = memo(lazyScreen(() => import('./panels/ReleasesPanel.jsx'), 'ReleasesPanel'));
const Chat = memo(lazyScreen(() => import('./panels/ChatPanel.jsx'), 'ChatPanel'));
const Devtools = memo(lazyScreen(() => import('./panels/DevtoolsPanel.jsx'), 'DevtoolsPanel'));
const Mascots = memo(lazyScreen(() => import('./panels/MascotsPanel.jsx'), 'MascotsPanel'));

// The badge polls from inside the Slack tab entry, so setup-only mode (which
// renders SETTINGS_TAB) never starts a Slack request at all.
const READY_TABS = [
  { id: 'home', label: 'Home' },
  { id: 'my-tickets', label: 'My Tickets' },
  { id: 'slack', label: 'Slack', badge: <SlackTabBadge /> },
  { id: 'prs', label: 'Pull Requests' },
  { id: 'chat', label: 'Chat' },
  { id: 'releases', label: 'Releases' },
  { id: 'services', label: 'Services' },
  { id: 'devtools', label: 'DevTools' },
  { id: 'mascots', label: 'Mascots' },
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
// Only Releases (?view=list), Chat (?session=<uuid>) and My Tickets (?ticket=KEY, when it is a ticket
// key) keep their query string; every other route drops it.
const QUERY_ROUTES = new Set(['releases', 'chat', 'my-tickets']);
const keepsQuery = (route, query) =>
  QUERY_ROUTES.has(route) && query && (route !== 'my-tickets' || ticketFromQuery(query));
const hashFor = (route, query = '') => `#/${route}${keepsQuery(route, query) ? `?${query}` : ''}`;
// The ticket a My Tickets address asks to open, or null (any other route ignores the parameter).
const ticketRequestFor = (route) =>
  route === 'my-tickets' ? ticketFromQuery(parseHash().query) : null;
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
  const [chatSession, setChatSession] = useState(() => chatSessionFromQuery(parseHash().query));
  const [ticketRequest, setTicketRequest] = useState(null);
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
      setChatSession(chatSessionFromQuery(parseHash().query));
      setTicketRequest(ticketRequestFor(next));
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
      setChatSession(chatSessionFromQuery(parseHash().query));
      setTicketRequest(ticketRequestFor(next));
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

  // The panel has opened (or reported missing) the requested ticket: the address goes back to plain
  // My Tickets, so closing the dialog or reloading does not open it again.
  const ticketHandled = useCallback(() => {
    if (location.hash !== '#/my-tickets') history.replaceState(null, '', '#/my-tickets');
    setTicketRequest(null);
  }, []);

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
              <Home config={config} active={active === 'home'} />
              <Services config={config} active={active === 'services'} services={services} />
              <Prs config={config} active={active === 'prs'} />
              <MyTickets
                config={config}
                active={active === 'my-tickets'}
                requestedTicket={ticketRequest}
                onTicketHandled={ticketHandled}
              />
              <ScreenSlot
                id="releases"
                label="Releases"
                board={false}
                Screen={Releases}
                config={config}
                active={active === 'releases'}
                view={releaseView}
                onViewChange={changeReleaseView}
              />
              <Slack active={active === 'slack'} />
              <ScreenSlot
                id="chat"
                label="Chat"
                Screen={Chat}
                active={active === 'chat'}
                session={chatSession}
              />
              <ScreenSlot
                id="devtools"
                label="DevTools"
                Screen={Devtools}
                active={active === 'devtools'}
              />
              <ScreenSlot
                id="mascots"
                label="Mascots"
                Screen={Mascots}
                active={active === 'mascots'}
              />
            </>
          )}
          <Settings config={config} active={active === 'settings'} />
        </AppShell>
      )}
    </ThemeProvider>
  );
}
