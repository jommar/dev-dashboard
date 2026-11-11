import { useCallback, useEffect, useState } from 'react';
import { BoardPanel, BoardSection, BoardState, RefreshControl } from '../components/BoardShell.jsx';
import { Button } from '../components/Primitives.jsx';
import { ShowWindowToggle } from '../components/ShowWindowToggle.jsx';
import { DevtoolsTile } from '../components/DevtoolsTile.jsx';
import { DevtoolsViewer } from '../components/DevtoolsViewer.jsx';
import { useActivePolling } from '../hooks/useActivePolling.js';
import { DEVTOOLS_POLL_MS } from '../../ui/polling.js';
import { DEFAULT_DEVTOOLS_URL } from '../../ui/devtools-defaults.js';
import {
  getDevtoolsBrowsers,
  launchDevtoolsBrowser,
  startDevtoolsBrowser,
  stopDevtoolsBrowser,
  removeDevtoolsBrowser,
} from '../lib/api.js';

// The registry with one record swapped for its newer self.
const replaced = (browser) => (current) =>
  current.map((entry) => (entry.id === browser.id ? browser : entry));

// The DevTools tab is a wall of live tiles, one per debug browser: each is a real Chromium (headless
// unless "Show browser window" was ticked) with a CDP port, so a human can sign in and an agent
// attaches with `agent-browser connect <port>`. One instance per agent, each on its own profile, so several run
// side by side. A tile opens the full viewer (and "Take control") for its browser.
export function DevtoolsPanel({ active }) {
  const [browsers, setBrowsers] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [headed, setHeaded] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [viewing, setViewing] = useState(null);
  const closeViewer = useCallback(() => setViewing(null), []);

  const load = useCallback(async () => {
    try {
      const result = await getDevtoolsBrowsers();
      if (!result.ok) {
        setError(result.error || 'Could not read the browser registry.');
        return;
      }
      setBrowsers(result.browsers || []);
      setError(null);
    } catch {
      setError('Could not reach the dashboard.');
    } finally {
      setLoaded(true);
    }
  }, []);

  const polling = useActivePolling({
    active,
    interval: DEVTOOLS_POLL_MS,
    load,
    loaded,
  });

  // Runs one action on one browser: the tile is busy meanwhile, and the answer says how it went.
  // `job` returns the feedback line, or null when it has already said why it failed.
  const run = useCallback(async (id, job) => {
    setBusy(id);
    setFeedback('');
    try {
      const said = await job();
      if (said) setFeedback(said);
    } finally {
      setBusy(null);
    }
  }, []);

  const change = useCallback(
    (request, { id, label: name }, done) =>
      run(id, async () => {
        const result = await request(id);
        if (!result.ok) return result.error || 'That did not work.';
        setBrowsers(replaced(result.browser));
        return done(name);
      }),
    [run],
  );

  // Restart is Stop then Start, so the profile (and the sign-in) is kept, as in Stop and Start.
  const restart = useCallback(
    ({ id, label: name }) =>
      run(id, async () => {
        const stopped = await stopDevtoolsBrowser(id);
        if (!stopped.ok) return stopped.error || 'Could not stop that browser.';
        setBrowsers(replaced(stopped.browser));
        const started = await startDevtoolsBrowser(id);
        if (!started.ok) return started.error || 'Stopped, but it did not start again.';
        setBrowsers(replaced(started.browser));
        return `Restarted ${name}.`;
      }),
    [run],
  );

  // Remove is the only action that discards a profile; Stop keeps it so Start comes back signed in.
  const remove = useCallback(
    ({ id }) =>
      run(id, async () => {
        const result = await removeDevtoolsBrowser(id);
        if (!result.ok) return result.error || 'Could not remove that browser.';
        setBrowsers((current) => current.filter((entry) => entry.id !== id));
        return 'Removed.';
      }),
    [run],
  );

  // One handler for every tile, so tiles can be memoized: what a tile asked for, and of which browser.
  const onAction = useCallback(
    (kind, browser) => {
      if (kind === 'open') setViewing(browser.id);
      else if (kind === 'start')
        change(startDevtoolsBrowser, browser, (name) => `Started ${name}.`);
      else if (kind === 'stop') change(stopDevtoolsBrowser, browser, (name) => `Stopped ${name}.`);
      else if (kind === 'restart') restart(browser);
      else if (kind === 'remove') remove(browser);
    },
    [change, restart, remove],
  );

  const launch = async (event) => {
    event.preventDefault();
    setBusy('launch');
    setFeedback('');
    try {
      const result = await launchDevtoolsBrowser({
        label: label.trim(),
        url: url.trim(),
        headed,
      });
      if (!result.ok) {
        setFeedback(result.error || 'Could not open a browser.');
        return;
      }
      setBrowsers((current) => [result.browser, ...current]);
      setLabel('');
      setHeaded(false);
      setFeedback(`Opened on port ${result.browser.port} — sign in, then attach the agent to it.`);
    } finally {
      setBusy(null);
    }
  };

  // The viewer follows the registry: a browser that stops or is removed takes its viewer with it.
  const viewed = browsers.find((entry) => entry.id === viewing && entry.status === 'running');
  useEffect(() => {
    // Forget it, or a later restart of the same browser would reopen a viewer nobody asked for.
    if (viewing && !viewed) setViewing(null);
  }, [viewing, viewed]);

  const filters = (
    <form className="devtools-launch" onSubmit={launch}>
      <label>
        Label
        <input
          data-testid="devtools-label-input"
          value={label}
          maxLength={60}
          placeholder="optional"
          onChange={(event) => setLabel(event.target.value)}
        />
      </label>
      <label>
        Start at
        <input
          data-testid="devtools-url-input"
          value={url}
          placeholder={DEFAULT_DEVTOOLS_URL}
          onChange={(event) => setUrl(event.target.value)}
        />
      </label>
      <ShowWindowToggle checked={headed} onChange={setHeaded} />
      <Button type="submit" data-testid="devtools-launch" disabled={busy === 'launch'}>
        Launch
      </Button>
    </form>
  );

  const notes = feedback ? (
    <p className="devtools-feedback" data-testid="devtools-feedback">
      {feedback}
    </p>
  ) : null;

  const running = browsers.filter((entry) => entry.status === 'running').length;

  return (
    <BoardPanel id="devtools" active={active}>
      <BoardSection
        name="devtools"
        title="DevTools"
        sub="Every debug browser, live. Open one to look closer or take control."
        meta={loaded && browsers.length ? `${running} running · ${browsers.length} total` : ''}
        controls={
          <RefreshControl
            name="devtools"
            loading={busy === 'refresh'}
            countdown={polling.countdown}
            onRefresh={polling.load}
          />
        }
        filters={filters}
        notes={notes}
      >
        {error ? (
          <BoardState kind="error" testId="devtools-error">
            {error}
          </BoardState>
        ) : !loaded ? (
          <BoardState kind="loading" testId="devtools-loading" label="Loading browsers…" />
        ) : browsers.length === 0 ? (
          <BoardState kind="empty" testId="devtools-empty">
            No browsers yet — launch one above, sign in, then tell the agent its port.
          </BoardState>
        ) : (
          <div className="board-pane devtools-pane" data-testid="devtools-browsers">
            <ul
              className="devtools-wall"
              role="list"
              aria-label="Debug browsers"
              data-testid="devtools-wall"
            >
              {browsers.map((browser) => (
                <DevtoolsTile
                  key={browser.id}
                  browser={browser}
                  active={active}
                  busy={busy === browser.id}
                  onAction={onAction}
                />
              ))}
            </ul>
          </div>
        )}
      </BoardSection>
      {viewed && (
        <DevtoolsViewer
          key={viewed.id}
          id={viewed.id}
          label={viewed.label}
          port={viewed.port}
          onClose={closeViewer}
        />
      )}
    </BoardPanel>
  );
}
