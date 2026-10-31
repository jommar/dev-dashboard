import { useCallback, useEffect, useState } from 'react';
import { Button, Card, LoadingState } from './Primitives.jsx';
import { actionErrorText } from './slack-watch/actionErrorText.js';
import { AttachForm } from './slack-watch/AttachForm.jsx';
import { RelativeTime } from './slack-watch/RelativeTime.jsx';
import { SessionDelivery } from './slack-watch/SessionDelivery.jsx';
import { WatchSettingsForm } from './slack-watch/WatchSettingsForm.jsx';
import { useDashboardApi } from '../hooks/useDashboardApi.js';
import { SLACK_WATCH_POLL_MS } from '../../ui/polling.js';

const STATE_LABELS = { running: 'Running', paused: 'Paused', disabled: 'Disabled' };

const linesOf = (text) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

// The poll reads only the server's in-memory list, never Slack, so it is cheap;
// it still stops with the tab and with a hidden document.
export function SlackWatchCard({ active }) {
  const api = useDashboardApi();
  const [watch, setWatch] = useState(null);
  const [listFailed, setListFailed] = useState(false);
  const [pickerSessions, setPickerSessions] = useState([]);
  const [linksText, setLinksText] = useState('');
  const [rejections, setRejections] = useState([]);
  const [actionError, setActionError] = useState('');

  const load = useCallback(async () => {
    const next = await api.getSlackWatch();
    if (next.ok) setWatch(next);
    setListFailed(!next.ok);
  }, [api]);

  // The picker is transient: it is replaced on every read and never kept elsewhere.
  const loadPicker = useCallback(async () => {
    const next = await api.getSlackWatchSessions();
    if (next.ok) setPickerSessions(next.sessions ?? []);
  }, [api]);

  useEffect(() => {
    if (!active) return undefined;
    load();
    loadPicker();
    const timer = setInterval(() => {
      if (!document.hidden) load();
    }, SLACK_WATCH_POLL_MS);
    return () => clearInterval(timer);
  }, [active, load, loadPicker]);

  const settle = useCallback(
    async (response, { refreshPicker = false } = {}) => {
      setActionError(response.ok ? '' : actionErrorText(response));
      await Promise.all([load(), refreshPicker ? loadPicker() : null]);
    },
    [load, loadPicker],
  );

  const addLinks = async () => {
    const response = await api.addSlackWatchLinks(linesOf(linksText));
    const rejected = (response.results ?? []).filter((result) => !result.ok);
    setRejections(rejected);
    // Accepted lines are now in the table; only the refused ones stay to be fixed.
    if (response.ok) setLinksText(rejected.map(({ input }) => input).join('\n'));
    await settle(response);
  };

  const state = watch?.state;
  const disabled = state === 'disabled';
  const links = watch?.links ?? [];

  return (
    <Card className="slack-section slack-watch-card" data-testid="slack-watch-card">
      <div className="pr-open-heading">
        <span className="section-label">Watch threads</span>
        {watch && (
          <>
            <span
              className="slack-watch-state"
              role="status"
              data-state={state}
              data-testid="slack-watch-state"
            >
              {STATE_LABELS[state] ?? state}
            </span>
            {watch.reason && (
              <span className="slack-watch-reason" data-testid="slack-watch-reason">
                {watch.reason}
              </span>
            )}
            {state === 'running' && (
              <Button
                data-testid="slack-watch-pause"
                onClick={async () => settle(await api.pauseSlackWatch())}
              >
                Pause
              </Button>
            )}
            {state === 'paused' && (
              <Button
                data-testid="slack-watch-resume"
                onClick={async () => settle(await api.resumeSlackWatch())}
              >
                Resume
              </Button>
            )}
          </>
        )}
      </div>
      <p className="slack-note">
        Paste Slack thread links and attach the Claude Code sessions to wake when a thread gets a
        new message.
      </p>
      {actionError && (
        <p className="slack-watch-error" role="alert" data-testid="slack-watch-action-error">
          {actionError}
        </p>
      )}
      {!watch ? (
        listFailed ? (
          <p className="slack-note" data-testid="slack-watch-unavailable">
            The watch list is not available right now. Retrying — nothing else is waiting on it.
          </p>
        ) : (
          <LoadingState label="Loading watch list…" testId="slack-watch-loading" />
        )
      ) : (
        <>
          <div className="slack-watch-add">
            <textarea
              rows={3}
              aria-label="Slack thread links, one per line"
              placeholder="One Slack thread link per line"
              data-testid="slack-watch-links-input"
              value={linksText}
              onChange={(event) => setLinksText(event.target.value)}
            />
            <Button
              data-testid="slack-watch-links-add"
              disabled={disabled || linesOf(linksText).length === 0}
              onClick={addLinks}
            >
              Add
            </Button>
          </div>
          {rejections.length > 0 && (
            <ul className="slack-watch-rejections">
              {rejections.map(({ input, reason }, index) => (
                <li
                  // Two identical lines can both be rejected, so the input alone is not a key.
                  key={`${index}-${input}`}
                  className="slack-watch-error"
                  data-testid="slack-watch-rejection"
                >
                  {input} · {reason}
                </li>
              ))}
            </ul>
          )}
          {links.length === 0 ? (
            <p className="slack-note" data-testid="slack-watch-empty">
              No threads are being watched yet.
            </p>
          ) : (
            <div className="slack-watch-table-wrap">
              <table className="slack-watch-table" data-testid="slack-watch-links">
                <thead>
                  <tr>
                    <th>Link</th>
                    <th>Last checked</th>
                    <th>Status</th>
                    <th>Sessions</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {links.map((entry) => (
                    <tr key={entry.key} data-testid={`slack-watch-row-${entry.key}`}>
                      <td
                        className="slack-watch-link"
                        data-testid={`slack-watch-link-${entry.key}`}
                      >
                        {entry.link}
                      </td>
                      <td data-testid={`slack-watch-checked-${entry.key}`}>
                        {entry.lastCheckedAt ? <RelativeTime iso={entry.lastCheckedAt} /> : 'never'}
                      </td>
                      <td data-testid={`slack-watch-status-${entry.key}`}>
                        {entry.lastStatus ?? '—'}
                      </td>
                      <td>
                        {entry.sessions.length === 0 ? (
                          <span className="slack-watch-none">No session attached</span>
                        ) : (
                          <ul className="slack-watch-sessions">
                            {entry.sessions.map(({ sessionId, delivery }) => (
                              <SessionDelivery
                                key={sessionId}
                                linkKey={entry.key}
                                sessionId={sessionId}
                                delivery={delivery}
                                onDetach={async () =>
                                  settle(await api.detachSlackWatchSession(entry.link, sessionId), {
                                    refreshPicker: true,
                                  })
                                }
                              />
                            ))}
                          </ul>
                        )}
                      </td>
                      <td>
                        <Button
                          data-testid={`slack-watch-remove-${entry.key}`}
                          disabled={disabled}
                          onClick={async () => settle(await api.removeSlackWatchLink(entry.link))}
                        >
                          Remove
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <AttachForm
            links={links}
            pickerSessions={pickerSessions}
            disabled={disabled}
            onSettled={settle}
          />
          <WatchSettingsForm settings={watch.settings} onSettled={settle} />
        </>
      )}
    </Card>
  );
}
