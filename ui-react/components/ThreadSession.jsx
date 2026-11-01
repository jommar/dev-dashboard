// ThreadSession.jsx — the thread dialog's "Claude session" section: the sessions attached
// to this thread on the Slack watcher, with attach and detach. It uses the watcher's own
// routes and matches this thread by the `watchKey` the server hands the dialog, so the
// UI derives no key itself. Reads happen on open and after each successful change; nothing polls.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from './Primitives.jsx';
import { actionErrorText } from './slack-watch/actionErrorText.js';
import { sessionOptionLabel } from './slack-watch/sessionOptionLabel.js';
import { useDashboardApi } from '../hooks/useDashboardApi.js';

const UNAVAILABLE_TEXT =
  'Claude sessions are unavailable, so nothing can be attached to this thread right now.';
const NO_LINK_TEXT = 'No link to attach to';

function sessionsAttachedTo(links, watchKey) {
  if (!watchKey) return [];
  return links.find((entry) => entry.key === watchKey)?.sessions ?? [];
}

export function ThreadSession({ ts, url, watchKey, keyPending }) {
  const api = useDashboardApi();
  const titleId = useId();
  // Bumped whenever the thread changes or the section unmounts, so a response that
  // settles after that is dropped rather than painted onto the wrong thread.
  const epoch = useRef(0);
  const [watch, setWatch] = useState(null);
  const [watchFailed, setWatchFailed] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [picked, setPicked] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const readWatch = useCallback(
    async (started) => {
      const next = await api.getSlackWatch();
      if (epoch.current !== started) return;
      if (next.ok) setWatch(next);
      setWatchFailed(!next.ok);
    },
    [api],
  );

  useEffect(() => {
    epoch.current += 1;
    const started = epoch.current;
    setWatch(null);
    setWatchFailed(false);
    setSessions([]);
    setPicked('');
    setError('');
    setBusy(false);
    readWatch(started);
    api.getSlackWatchSessions().then((next) => {
      if (epoch.current === started && next.ok) setSessions(next.sessions ?? []);
    });
    return () => {
      epoch.current += 1;
    };
  }, [ts, api, readWatch]);

  const runAction = async (request, onSuccess) => {
    const started = epoch.current;
    setBusy(true);
    setError('');
    const response = await request();
    if (epoch.current !== started) return;
    if (response.ok) {
      onSuccess?.();
      await readWatch(started);
    } else {
      setError(actionErrorText(response));
    }
    if (epoch.current === started) setBusy(false);
  };

  const attach = () =>
    runAction(
      () => api.attachSlackWatchSession(url, picked),
      () => setPicked(''),
    );
  const detach = (sessionId) => runAction(() => api.detachSlackWatchSession(url, sessionId));

  const unavailable = watchFailed || watch?.state === 'disabled';
  const loading = !unavailable && (keyPending || !watch);
  const hasLink = Boolean(url);
  const attached = sessionsAttachedTo(watch?.links ?? [], watchKey);
  const attachedIds = new Set(attached.map(({ sessionId }) => sessionId));
  const offered = sessions.filter(({ sessionId }) => !attachedIds.has(sessionId));

  return (
    <section
      className="slack-thread-session"
      aria-labelledby={titleId}
      data-testid="thread-session"
    >
      <h4 className="slack-thread-session-title" id={titleId}>
        Claude session
      </h4>
      {unavailable && (
        <p className="slack-note" data-testid="thread-session-unavailable">
          {UNAVAILABLE_TEXT}
        </p>
      )}
      {loading && (
        <p className="slack-note" data-testid="thread-session-loading">
          Loading…
        </p>
      )}
      {!unavailable && !loading && (
        <>
          {attached.length === 0 ? (
            <p className="slack-note" data-testid="thread-session-empty">
              No session attached
            </p>
          ) : (
            <ul className="slack-thread-session-list" data-testid="thread-session-list">
              {attached.map(({ sessionId }) => (
                <li
                  key={sessionId}
                  className="slack-thread-session-item"
                  data-testid={`thread-session-item-${sessionId}`}
                >
                  <code className="slack-watch-session-id">{sessionId}</code>
                  <Button
                    data-testid={`thread-session-detach-${sessionId}`}
                    disabled={busy}
                    onClick={() => detach(sessionId)}
                  >
                    Detach
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="slack-thread-session-attach">
            <select
              data-testid="thread-session-picker"
              aria-label="Claude session to attach"
              value={picked}
              disabled={busy || !hasLink}
              onChange={(event) => setPicked(event.target.value)}
            >
              <option value="">Choose a session</option>
              {offered.map((session) => (
                <option key={session.sessionId} value={session.sessionId}>
                  {sessionOptionLabel(session)}
                </option>
              ))}
            </select>
            <Button
              data-testid="thread-session-attach"
              disabled={busy || !hasLink || !picked}
              onClick={attach}
            >
              Attach
            </Button>
          </div>
          {!hasLink && (
            <p className="slack-note" data-testid="thread-session-no-link">
              {NO_LINK_TEXT}
            </p>
          )}
          {error && (
            <p className="slack-watch-error" role="alert" data-testid="thread-session-error">
              {error}
            </p>
          )}
        </>
      )}
    </section>
  );
}
