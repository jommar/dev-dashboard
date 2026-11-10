import { useCallback, useState } from 'react';
import { BoardPanel, BoardSection, BoardState, RefreshControl } from '../components/BoardShell.jsx';
import { Button } from '../components/Primitives.jsx';
import { useActivePolling } from '../hooks/useActivePolling.js';
import { DEVTOOLS_POLL_MS } from '../../ui/polling.js';
import { timeAgo } from '../../ui/dom.js';
import {
  getDevtoolsBrowsers,
  launchDevtoolsBrowser,
  startDevtoolsBrowser,
  stopDevtoolsBrowser,
  removeDevtoolsBrowser,
} from '../lib/api.js';

// The DevTools tab opens a visible Chromium with a CDP port, so a human can sign
// in and an agent attaches with `agent-browser connect <port>`. One instance per
// agent, each on its own profile, so several can run side by side.
export function DevtoolsPanel({ active }) {
  const [browsers, setBrowsers] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [feedback, setFeedback] = useState('');

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

  const act = async (request, id, done) => {
    setBusy(id);
    setFeedback('');
    try {
      const result = await request(id);
      if (!result.ok) {
        setFeedback(result.error || 'That did not work.');
        return;
      }
      setBrowsers((current) =>
        current.map((entry) => (entry.id === result.browser.id ? result.browser : entry)),
      );
      setFeedback(done);
    } finally {
      setBusy(null);
    }
  };

  // Remove is the only action that discards a profile; Stop keeps it so Start
  // comes back signed in.
  const remove = async (id) => {
    setBusy(id);
    setFeedback('');
    try {
      const result = await removeDevtoolsBrowser(id);
      if (!result.ok) {
        setFeedback(result.error || 'Could not remove that browser.');
        return;
      }
      setBrowsers((current) => current.filter((entry) => entry.id !== id));
      setFeedback('Removed.');
    } finally {
      setBusy(null);
    }
  };

  const launch = async (event) => {
    event.preventDefault();
    setBusy('launch');
    setFeedback('');
    try {
      const result = await launchDevtoolsBrowser({ label: label.trim(), url: url.trim() });
      if (!result.ok) {
        setFeedback(result.error || 'Could not open a browser.');
        return;
      }
      setBrowsers((current) => [result.browser, ...current]);
      setLabel('');
      setFeedback(`Opened on port ${result.browser.port} — sign in, then attach the agent to it.`);
    } finally {
      setBusy(null);
    }
  };

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
          placeholder="about:blank"
          onChange={(event) => setUrl(event.target.value)}
        />
      </label>
      <Button type="submit" data-testid="devtools-launch" disabled={busy === 'launch'}>
        New browser
      </Button>
    </form>
  );

  const notes = feedback ? (
    <p className="devtools-feedback" data-testid="devtools-feedback">
      {feedback}
    </p>
  ) : null;

  return (
    <BoardPanel id="devtools" active={active}>
      <BoardSection
        name="devtools"
        title="DevTools"
        sub="Visible Chromium windows with a CDP port, one per agent."
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
            No debug browsers yet. Open one, sign in, then tell the agent its port.
          </BoardState>
        ) : (
          <div className="board-pane devtools-pane" data-testid="devtools-browsers">
            <div className="devtools-table-wrap">
              <table className="devtools-table">
                <thead>
                  <tr>
                    <th scope="col">Label</th>
                    <th scope="col">Port</th>
                    <th scope="col">Start at</th>
                    <th scope="col">PID</th>
                    <th scope="col">Started</th>
                    <th scope="col">Status</th>
                    <th scope="col">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {browsers.map((browser) => (
                    <tr key={browser.id} data-testid={`devtools-row-${browser.id}`}>
                      <td data-testid={`devtools-label-${browser.id}`}>{browser.label}</td>
                      <td className="devtools-port" data-testid={`devtools-port-${browser.id}`}>
                        {browser.port ?? '—'}
                      </td>
                      <td className="devtools-url" data-testid={`devtools-url-${browser.id}`}>
                        {browser.url}
                      </td>
                      <td className="devtools-pid" data-testid={`devtools-pid-${browser.id}`}>
                        {browser.pid ?? '—'}
                      </td>
                      <td data-testid={`devtools-started-${browser.id}`}>
                        {timeAgo(browser.startedAt)}
                      </td>
                      <td>
                        <span
                          className="devtools-status"
                          data-status={browser.status}
                          data-testid={`devtools-status-${browser.id}`}
                        >
                          {browser.status}
                        </span>
                      </td>
                      <td className="devtools-actions">
                        {browser.status === 'running' ? (
                          <Button
                            data-testid={`devtools-stop-${browser.id}`}
                            disabled={busy === browser.id}
                            onClick={() =>
                              act(stopDevtoolsBrowser, browser.id, `Stopped ${browser.label}.`)
                            }
                          >
                            Stop
                          </Button>
                        ) : (
                          <Button
                            data-testid={`devtools-start-${browser.id}`}
                            disabled={busy === browser.id}
                            onClick={() =>
                              act(startDevtoolsBrowser, browser.id, `Started ${browser.label}.`)
                            }
                          >
                            Start
                          </Button>
                        )}
                        <Button
                          data-testid={`devtools-remove-${browser.id}`}
                          disabled={busy === browser.id}
                          onClick={() => remove(browser.id)}
                        >
                          Remove
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </BoardSection>
    </BoardPanel>
  );
}
