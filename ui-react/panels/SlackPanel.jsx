import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, Card, LoadingState } from '../components/Primitives.jsx';
import { SlackThreadDialog } from '../components/SlackThreadDialog.jsx';
import { SlackWatchCard } from '../components/SlackWatchCard.jsx';
import { BoardColumn } from '../components/BoardShell.jsx';
import { useDashboardApi } from '../hooks/useDashboardApi.js';
import { usePreservedInteraction } from '../hooks/usePreservedInteraction.js';
import { useSlackActivityClock } from '../hooks/useSlackActivityClock.js';
import { timeAgo } from '../../ui/dom.js';
import {
  eligibleSlackRoot,
  groupSlackActivity,
  slackSessionIdentity,
} from '../../ui/slack-activity.js';
import { SLACK_POLL_MS } from '../../ui/polling.js';
import { slackStaleReplyWarning, slackStandaloneMentionWarning } from '../../ui/slack-coverage.js';
import { notifySlackSessionChanged } from '../hooks/useSlackPending.js';

const SECTIONS = {
  started: { label: 'Threads I started', empty: 'No started threads loaded in #ezat_claudio.' },
  mentions: { label: 'Mentions', empty: 'No mentions loaded in #ezat_claudio.' },
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
  const [openThread, setOpenThread] = useState(null);
  // Which snapshot the enrichment retries belong to, so a refreshed snapshot
  // starts with its own budget instead of inheriting the previous one's.
  const [enrichRetries, setEnrichRetries] = useState({ updatedAt: null, count: 0 });
  const inFlight = useRef(false);
  const wasConnected = useRef(false);
  const generation = useRef(0);
  const statusRequest = useRef(0);
  const sessionIdentity = useRef('');
  const boardRoot = useRef(null);
  const sectionScroll = useRef(new Map());
  usePreservedInteraction(boardRoot);
  const [now, currentTime] = useSlackActivityClock(threads, active, openThread);
  const threadIsEligible = (ts) => eligibleSlackRoot(ts, currentTime());

  const switchSection = (next) => {
    if (next === section) return;
    const bodies = boardRoot.current?.querySelectorAll('.my-tickets-column-body') || [];
    sectionScroll.current.set(
      section,
      new Map([...bodies].map((body) => [body.dataset.testid, body.scrollTop])),
    );
    setSection(next);
  };
  useLayoutEffect(() => {
    const saved = sectionScroll.current.get(section);
    const bodies = boardRoot.current?.querySelectorAll('.my-tickets-column-body') || [];
    for (const body of bodies) body.scrollTop = saved?.get(body.dataset.testid) || 0;
  }, [section]);

  const clearSession = useCallback(() => {
    generation.current += 1;
    statusRequest.current += 1;
    sessionIdentity.current = '';
    wasConnected.current = false;
    setThreads(null);
    setOpenThread(null);
    setStatus(null);
    setThreadsFailed(false);
  }, []);

  const load = useCallback(async () => {
    const request = ++statusRequest.current;
    const currentGeneration = generation.current;
    const next = await api.getSlackStatus();
    if (request !== statusRequest.current || currentGeneration !== generation.current) return null;
    const identity = slackSessionIdentity(next, sessionIdentity.current);
    if (sessionIdentity.current && sessionIdentity.current !== identity) {
      generation.current += 1;
      setThreads(null);
      setOpenThread(null);
      notifySlackSessionChanged('slack');
    }
    sessionIdentity.current = identity;
    setStatus(next);
    // Announce the transition rather than every poll: the tab badge refetches on
    // this event, so a finished sign-in shows up without waiting for its own poll.
    if (next?.connected && !wasConnected.current) notifySlackSessionChanged('slack');
    wasConnected.current = !!next?.connected;
    return next;
  }, [api]);

  useEffect(() => {
    const sessionChanged = (event) => {
      if (event.detail?.source === 'slack') return;
      clearSession();
      if (active) load();
    };
    window.addEventListener('slack-session-changed', sessionChanged);
    return () => window.removeEventListener('slack-session-changed', sessionChanged);
  }, [active, clearSession, load]);

  const dialogSessionMismatch = useCallback(() => {
    clearSession();
    notifySlackSessionChanged('slack');
    if (active) load();
  }, [active, clearSession, load]);

  const loadThreads = useCallback(
    async (continuation) => {
      if (inFlight.current) return null;
      inFlight.current = true;
      const current = generation.current;
      try {
        const requestStartedWallAt = Date.now();
        const requestStartedAt = performance.now();
        const result = await api.getSlackThreads(continuation);
        // The list can finish after a replacement session was captured. Check
        // status again before letting that response repaint the board.
        const statusAfter = await load();
        if (!statusAfter?.connected || current !== generation.current) return null;
        if (result?.available)
          setThreads({
            ...result,
            _requestStartedAt: requestStartedAt,
            _requestStartedWallAt: requestStartedWallAt,
          });
        setThreadsFailed(!result?.available);
        return result;
      } finally {
        inFlight.current = false;
      }
    },
    [api, load],
  );

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
    const timer = setInterval(async () => {
      if (document.hidden) return;
      const currentStatus = await load();
      if (currentStatus?.connected) loadThreads();
    }, SLACK_POLL_MS);
    return () => clearInterval(timer);
  }, [active, connected, load, loadThreads]);

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
    generation.current += 1;
    statusRequest.current += 1;
    const disconnected = await api.disconnectSlack();
    setThreads(null);
    setOpenThread(null);
    setStatus({ connected: false, connecting: false });
    wasConnected.current = false;
    sessionIdentity.current = '';
    setPending(false);
    // Only once the server dropped the session: the badge refetch reads that state.
    if (disconnected) notifySlackSessionChanged('slack');
  };

  const meta = !status
    ? 'Checking…'
    : connected
      ? `Connected as @${status.user || 'you'}${status.team ? ` · ${status.team}` : ''}`
      : connecting
        ? 'Waiting for sign-in…'
        : 'Not connected';

  const items = (threads?.[section] || []).filter((thread) => eligibleSlackRoot(thread.ts, now));
  const { groups, unknown } = groupSlackActivity(items, now);
  const needsReply = items.filter((thread) => thread.needsReply === true).length;
  const checking = threads?.enriched === false;
  const replyUnknown = items.some((thread) => thread.needsReply == null);
  const staleReplyWarning = slackStaleReplyWarning(threads);
  const standaloneWarning = slackStandaloneMentionWarning(threads);
  const updatedLabel = threads ? new Date(threads.updatedAt).toLocaleTimeString() : '';

  useEffect(() => {
    if (openThread && !eligibleSlackRoot(openThread.ts, now)) setOpenThread(null);
  }, [openThread, now]);

  const resolveOpener = (ts) =>
    [...(boardRoot.current?.querySelectorAll('[data-testid]') || [])].find(
      (element) => element.dataset.testid === `slack-thread-${ts}`,
    ) || boardRoot.current?.querySelector('[role="region"]');

  const threadCard = (thread, activityKnown = true) => (
    <button
      key={thread.ts}
      type="button"
      className="slack-thread"
      data-testid={`slack-thread-${thread.ts}`}
      data-needs-reply={thread.needsReply == null ? 'unknown' : thread.needsReply ? 'yes' : 'no'}
      data-tooltip="Open the conversation"
      aria-haspopup="dialog"
      onClick={() => setOpenThread(thread)}
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
        <span className="slack-thread-when">
          {activityKnown ? timeAgo(thread.activityAt, now) : 'Time unavailable'}
        </span>
        {thread.needsReply === true && <span className="slack-needs">Needs reply</span>}
        {thread.needsReply == null && <span>Reply status unknown</span>}
      </span>
    </button>
  );

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
                  onClick={() => switchSection(id)}
                >
                  {entry.label}
                  <span className="slack-tab-count">
                    {
                      (threads?.[id] || []).filter((thread) => eligibleSlackRoot(thread.ts, now))
                        .length
                    }
                  </span>
                </button>
              ))}
            </div>
            <span className="pr-open-count" role="status" data-testid="slack-threads-meta">
              {!threads
                ? 'Loading…'
                : checking
                  ? `Checking replies… · ${needsReply} loaded need a reply · updated ${updatedLabel}`
                  : replyUnknown
                    ? `Reply status unknown for some loaded threads · ${needsReply} need a reply`
                    : `${needsReply} loaded threads need a reply · updated ${updatedLabel}`}
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
            ) : (
              <>
                {(threads.partial ||
                  threads.truncated ||
                  threads.stale ||
                  threadsFailed ||
                  checking ||
                  replyUnknown ||
                  staleReplyWarning ||
                  standaloneWarning) && (
                  <p className="slack-note slack-coverage" role="status">
                    {threads.stale || threadsFailed ? 'Showing the last available update. ' : ''}
                    Results or reply status may be incomplete; counts cover loaded threads only.
                    {staleReplyWarning ? ` ${staleReplyWarning}` : ''}
                    {standaloneWarning ? ` ${standaloneWarning}` : ''}
                    {threads.coverageNotes?.length ? ` ${threads.coverageNotes.join(' ')}` : ''}
                  </p>
                )}
                {items.length === 0 && <p className="slack-note">{SECTIONS[section].empty}</p>}
                <div ref={boardRoot} className="slack-board-frame">
                  <div
                    className="my-tickets-board slack-board"
                    role="region"
                    aria-label="Slack activity board"
                    tabIndex={0}
                    data-testid="slack-board"
                  >
                    {groups.map((group) => (
                      <BoardColumn
                        key={group.id}
                        id={group.id}
                        label={group.label}
                        count={group.threads.length}
                        testIdPrefix="slack-column-"
                      >
                        {group.threads.map((thread) => (
                          <li key={thread.ts}>{threadCard(thread)}</li>
                        ))}
                      </BoardColumn>
                    ))}
                  </div>
                  {unknown.length > 0 && (
                    <div className="slack-unknown">
                      <h3>Activity time unavailable</h3>
                      <ul className="slack-unknown-list">
                        {unknown.map((thread) => (
                          <li key={thread.ts}>{threadCard(thread, false)}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
                {threads.continuation && (
                  <Button onClick={() => loadThreads(threads.continuation)}>
                    Load more eligible threads
                  </Button>
                )}
              </>
            )}
          </div>
        </Card>
      )}
      {connected && <SlackWatchCard active={active} />}
      <SlackThreadDialog
        thread={openThread}
        onClose={() => setOpenThread(null)}
        resolveOpener={resolveOpener}
        isEligible={threadIsEligible}
        sessionIdentity={sessionIdentity.current}
        onSessionMismatch={dialogSessionMismatch}
      />
    </section>
  );
}
