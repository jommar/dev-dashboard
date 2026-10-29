import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, LoadingState } from '../components/Primitives.jsx';
import { useDashboardApi } from '../hooks/useDashboardApi.js';
import { timeAgo } from '../../ui/dom.js';
import { SLACK_POLL_MS } from '../../ui/polling.js';
import { notifySlackSessionChanged } from '../hooks/useSlackPending.js';

const SECTIONS = {
  started: { label: 'Threads I started', empty: 'No threads started in #ezat_claudio yet.' },
  mentions: { label: 'Mentions', empty: 'Nobody has mentioned you there yet.' },
};

// The server answers a cold cache in about a second with the rows it has and
// "Needs reply" still unknown, then finishes checking in the background. A
// couple of short retries collect that enriched snapshot; the cap is what keeps
// a server that never finishes from being polled faster than the 60 s refresh.
const ENRICH_RETRY_MS = 2_000;
const ENRICH_RETRY_LIMIT = 3;

// Slack is entirely optional. Every state below is rendered from a status that
// already degraded a failure into "not connected" — there is no error surface,
// because a missing Slack session must never look like a broken dashboard.
export function SlackPanel({ active }) {
  const api = useDashboardApi();
  const [status, setStatus] = useState(null);
  const [pending, setPending] = useState(false);
  const [threads, setThreads] = useState(null);
  const [threadsFailed, setThreadsFailed] = useState(false);
  const [section, setSection] = useState('started');
  // Which snapshot the enrichment retries belong to, so a refreshed snapshot
  // starts with its own budget instead of inheriting the previous one's.
  const [enrichRetries, setEnrichRetries] = useState({ updatedAt: null, count: 0 });
  const inFlight = useRef(false);
  const wasConnected = useRef(false);

  const load = useCallback(async () => {
    const next = await api.getSlackStatus();
    setStatus(next);
    // Announce the transition rather than every poll: the tab badge refetches on
    // this event, so a finished sign-in shows up without waiting for its own poll.
    if (next?.connected && !wasConnected.current) notifySlackSessionChanged();
    wasConnected.current = !!next?.connected;
    return next;
  }, [api]);

  const loadThreads = useCallback(async () => {
    if (inFlight.current) return null;
    inFlight.current = true;
    try {
      const result = await api.getSlackThreads();
      if (result?.available) setThreads(result);
      setThreadsFailed(!result?.available);
      return result;
    } finally {
      inFlight.current = false;
    }
  }, [api]);

  useEffect(() => {
    if (active) load();
  }, [active, load]);

  const connecting = !!status?.connecting;
  const connected = !!status?.connected;

  useEffect(() => {
    if (!active || !connecting) return undefined;
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  }, [active, connecting, load]);

  useEffect(() => {
    if (!active || !connected) return undefined;
    loadThreads();
    const timer = setInterval(() => {
      if (!document.hidden) loadThreads();
    }, SLACK_POLL_MS);
    return () => clearInterval(timer);
  }, [active, connected, loadThreads]);

  // A snapshot can arrive with `enriched: false`: the rows are real, but the
  // server had not finished checking "Needs reply" when it answered. Retry a
  // few times to collect the enriched version, then stop — after the cap the
  // honest "Checking replies…" line stands until the next 60 s poll, so a
  // server that never enriches cannot turn into a spin. The retry goes through
  // loadThreads, which already refuses to overlap an in-flight request.
  useEffect(() => {
    if (!active || !connected || threads?.enriched !== false) return undefined;
    const snapshot = threads.updatedAt ?? null;
    const attempts = enrichRetries.updatedAt === snapshot ? enrichRetries.count : 0;
    if (attempts >= ENRICH_RETRY_LIMIT) return undefined;
    const timer = setTimeout(() => {
      setEnrichRetries({ updatedAt: snapshot, count: attempts + 1 });
      loadThreads();
    }, ENRICH_RETRY_MS);
    return () => clearTimeout(timer);
  }, [active, connected, threads, enrichRetries, loadThreads]);

  // A first load that fails must not leave the tab spinning forever: retry on a
  // short interval until one attempt succeeds, then fall back to the slow poll.
  const waiting = !threads;
  useEffect(() => {
    if (!active || !connected || !waiting) return undefined;
    const timer = setInterval(loadThreads, 5000);
    return () => clearInterval(timer);
  }, [active, connected, waiting, loadThreads]);

  const connect = async () => {
    setPending(true);
    const started = await api.connectSlack();
    setStatus(
      started
        ? (previous) => ({ ...(previous || {}), connecting: true })
        : { connected: false, connecting: false },
    );
    setPending(false);
  };

  const disconnect = async () => {
    setPending(true);
    const disconnected = await api.disconnectSlack();
    setThreads(null);
    setStatus({ connected: false, connecting: false });
    wasConnected.current = false;
    setPending(false);
    // Only once the server dropped the session: the badge refetch reads that state.
    if (disconnected) notifySlackSessionChanged();
  };

  const meta = !status
    ? 'Checking…'
    : connected
      ? `Connected as @${status.user || 'you'}${status.team ? ` · ${status.team}` : ''}`
      : connecting
        ? 'Waiting for sign-in…'
        : 'Not connected';

  const items = threads?.[section] || [];
  const needsReply = items.filter((thread) => thread.needsReply).length;
  // Only an explicit `false` means the server is still checking: a missing field
  // comes from a backend that predates enrichment, and there the old copy is the
  // truthful one.
  const checking = threads?.enriched === false;
  const updatedLabel = threads ? new Date(threads.updatedAt).toLocaleTimeString() : '';

  return (
    <section
      id="panel-slack"
      className="panel"
      data-testid="panel-slack"
      hidden={!active}
      aria-busy={pending}
    >
      <header className="page-intro">
        <p className="eyebrow">Workspace</p>
        <h2>Slack</h2>
        <p>
          Threads you started and threads that mention you in #ezat_claudio, newest activity first.
          Optional — skip it and every other tab behaves exactly as it does today.
        </p>
      </header>
      <Card className="slack-section" data-testid="slack-section">
        <div className="pr-open-heading" data-testid="slack-title">
          <span className="section-label">Account</span>
          <span className="pr-open-count" role="status" data-testid="slack-meta">
            {meta}
          </span>
          {connected ? (
            <Button data-testid="slack-disconnect" disabled={pending} onClick={disconnect}>
              Disconnect
            </Button>
          ) : (
            <Button data-testid="slack-connect" disabled={pending || connecting} onClick={connect}>
              Connect Slack
            </Button>
          )}
        </div>
        {!status ? (
          <div className="slack-body" data-testid="slack-body">
            <LoadingState label="Checking Slack…" testId="slack-loading" />
          </div>
        ) : connected ? null : (
          <div className="slack-body" data-testid="slack-body">
            {connecting ? (
              <p className="slack-note" data-testid="slack-connecting">
                Finish signing in to Slack in the window that just opened. Closing that window
                cancels — nothing else in the dashboard changes.
              </p>
            ) : (
              <p className="slack-note" data-testid="slack-disconnected">
                Signing in opens a separate Slack window. Until that finishes, this tab stays empty
                and no other panel waits on it.
              </p>
            )}
          </div>
        )}
      </Card>
      {connected && (
        <Card className="slack-section slack-threads-card" data-testid="slack-threads-card">
          <div className="slack-section-head">
            <div className="slack-tabs" role="tablist" aria-label="Slack lists">
              {Object.entries(SECTIONS).map(([id, entry]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  className="slack-tab"
                  aria-selected={section === id}
                  data-testid={`slack-tab-${id}`}
                  onClick={() => setSection(id)}
                >
                  {entry.label}
                  <span className="slack-tab-count">{threads?.[id]?.length ?? 0}</span>
                </button>
              ))}
            </div>
            <span className="pr-open-count" role="status" data-testid="slack-threads-meta">
              {!threads
                ? 'Loading…'
                : checking
                  ? `Checking replies… · updated ${updatedLabel}`
                  : needsReply
                    ? `${needsReply} need a reply · updated ${updatedLabel}`
                    : `All caught up · updated ${updatedLabel}`}
            </span>
          </div>
          <div className="slack-thread-list" data-testid="slack-threads">
            {!threads ? (
              threadsFailed ? (
                <p className="slack-note" data-testid="slack-threads-unavailable">
                  Slack is not responding right now. Retrying — nothing else is waiting on it.
                </p>
              ) : (
                <LoadingState label="Loading threads…" testId="slack-threads-loading" />
              )
            ) : items.length === 0 ? (
              <p className="slack-note">{SECTIONS[section].empty}</p>
            ) : (
              items.map((thread) => (
                <a
                  key={thread.ts}
                  className="slack-thread"
                  href={thread.url}
                  target="_blank"
                  rel="noreferrer"
                  data-testid={`slack-thread-${thread.ts}`}
                  data-needs-reply={thread.needsReply ? 'yes' : 'no'}
                >
                  <span className="slack-thread-text">{thread.text || '(no text)'}</span>
                  <span className="slack-thread-meta">
                    {section === 'mentions' && thread.author?.name && (
                      <span className="slack-thread-who">@{thread.author.name} mentioned you</span>
                    )}
                    {section === 'mentions' &&
                      thread.starter?.name &&
                      thread.starter.name !== thread.author?.name && (
                        <span>started by {thread.starter.name}</span>
                      )}
                    <span>
                      {thread.replyCount} {thread.replyCount === 1 ? 'reply' : 'replies'}
                    </span>
                    {thread.replyCount > 0 && thread.latestReplyBy?.name && (
                      <span>last by {thread.latestReplyBy.name}</span>
                    )}
                    <span className="slack-thread-when">{timeAgo(thread.activityAt)}</span>
                    {thread.needsReply && <span className="slack-needs">Needs reply</span>}
                  </span>
                </a>
              ))
            )}
          </div>
        </Card>
      )}
    </section>
  );
}
