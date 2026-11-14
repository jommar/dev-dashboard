import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, DashboardTooltip } from '../components/Primitives.jsx';
import { SlackWatchCard } from '../components/SlackWatchCard.jsx';
import { UpstreamNote } from '../components/UpstreamNote.jsx';
import {
  Board,
  BoardColumn,
  BoardNote,
  BoardPanel,
  BoardSection,
  BoardState,
  BoardTabs,
  RefreshControl,
} from '../components/BoardShell.jsx';
import { useActivePolling } from '../hooks/useActivePolling.js';
import { useDashboardApi } from '../hooks/useDashboardApi.js';
import { useSectionScroll } from '../hooks/useSectionScroll.js';
import { useSlackThreadDialog } from '../hooks/useSlackThreadDialog.jsx';
import { timeAgo } from '../../ui/dom.js';
import { groupSlackActivity, slackSessionIdentity } from '../../ui/slack-activity.js';
import { SLACK_POLL_MS } from '../../ui/polling.js';
import { slackCoverage } from '../../ui/slack-coverage.js';
import { notifySlackSessionChanged } from '../hooks/useSlackPending.js';

const SECTIONS = {
  started: { label: 'Threads I started', empty: 'No started threads loaded in #ezat_claudio.' },
  mentions: { label: 'Mentions', empty: 'No mentions loaded in #ezat_claudio.' },
};
// The third view of the card. It is not a list of threads, so it is not a section:
// counts, notes and "Load more" keep describing the last selected section.
const WATCH_VIEW = 'watch';

// The server answers a cold cache in about a second with the rows it has and
// "Needs reply" still unknown, then finishes checking in the background. A
// couple of short retries collect that enriched snapshot; the cap is what keeps
// a server that never finishes from being polled faster than the 60 s refresh.
const ENRICH_RETRY_MS = 2_000;
const ENRICH_RETRY_LIMIT = 3;

const LAST_UPDATE_NOTE = 'Showing the last available update.';
const INCOMPLETE_NOTE =
  'Results or reply status may be incomplete; counts cover loaded threads only.';
const unplacedNote = (count) =>
  `${count} loaded ${count === 1 ? 'thread with no usable activity time is' : 'threads with no usable activity time are'} not shown.`;

function SlackThreadCard({ thread, mentions, now, onOpen }) {
  const mentionedBy = mentions ? thread.author?.name : null;
  const startedBy =
    mentions && thread.starter?.name !== thread.author?.name ? thread.starter?.name : null;
  const lastBy = thread.replyCount > 0 ? thread.latestReplyBy?.name : null;
  return (
    <DashboardTooltip title="Open the conversation" describeChild>
      <button
        type="button"
        className="board-card board-card-action"
        data-testid={`slack-thread-${thread.ts}`}
        data-needs-reply={thread.needsReply == null ? 'unknown' : thread.needsReply ? 'yes' : 'no'}
        aria-haspopup="dialog"
        onClick={() => onOpen(thread)}
      >
        <span className="board-card-top">
          {thread.needsReply === true && (
            <span className="board-chip" data-tone="warn">
              Needs reply
            </span>
          )}
          {thread.needsReply == null && <span className="board-chip">Reply status unknown</span>}
          <span className="board-card-stat">
            {thread.replyCount} {thread.replyCount === 1 ? 'reply' : 'replies'}
          </span>
          <span className="board-card-stat slack-thread-when">
            {timeAgo(thread.activityAt, now)}
          </span>
        </span>
        <span className="board-card-summary">{thread.text || '(no text)'}</span>
        {(mentionedBy || startedBy || lastBy) && (
          <span className="slack-thread-meta">
            {mentionedBy && <span className="slack-thread-who">@{mentionedBy} mentioned you</span>}
            {startedBy && <span>started by {startedBy}</span>}
            {lastBy && <span>last by {lastBy}</span>}
          </span>
        )}
      </button>
    </DashboardTooltip>
  );
}

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
  const [showWatch, setShowWatch] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [openThread, setOpenThread] = useState(null);
  // The watcher's own poll feeds the Watch tab through this, so a paused or failing watcher shows
  // while another view is selected.
  const [watchSummary, setWatchSummary] = useState(null);
  // Which snapshot the enrichment retries belong to, so a refreshed snapshot
  // starts with its own budget instead of inheriting the previous one's.
  const [enrichRetries, setEnrichRetries] = useState({ updatedAt: null, count: 0 });
  const inFlight = useRef(false);
  const wasConnected = useRef(false);
  const generation = useRef(0);
  const statusRequest = useRef(0);
  const sessionIdentity = useRef('');
  const boardFrame = useRef(null);
  const view = showWatch ? WATCH_VIEW : section;
  const rememberScroll = useSectionScroll(boardFrame, view);

  const switchView = (next) => {
    if (next === view) return;
    rememberScroll();
    if (next === WATCH_VIEW) setShowWatch(true);
    else {
      setShowWatch(false);
      setSection(next);
    }
  };

  const clearSession = useCallback(() => {
    generation.current += 1;
    statusRequest.current += 1;
    sessionIdentity.current = '';
    wasConnected.current = false;
    setThreads(null);
    setOpenThread(null);
    setStatus(null);
    setThreadsFailed(false);
    setShowWatch(false);
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

  // The thread dialog stays mounted beside the card, so an open conversation survives a status
  // change; the hook wires it, the clock and the reaction to a session that changed elsewhere.
  const reloadSession = useCallback(() => {
    if (active) load();
  }, [active, load]);
  const resolveOpener = (ts) =>
    [...(boardFrame.current?.querySelectorAll('[data-testid]') || [])].find(
      (element) => element.dataset.testid === `slack-thread-${ts}`,
    ) || boardFrame.current?.querySelector('[role="region"]');
  const { now, dialog } = useSlackThreadDialog({
    source: 'slack',
    snapshot: threads,
    active,
    openThread,
    setOpenThread,
    sessionIdentity,
    resolveOpener,
    resetSession: clearSession,
    reloadSession,
  });

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

  // The first load and a manual Refresh read the list (loadThreads checks the
  // status itself afterwards); a periodic poll reads the status first and only
  // asks for the list while that session is still connected.
  const poll = useCallback(
    async ({ silent = false } = {}) => {
      setRefreshing(true);
      try {
        if (!silent) return await loadThreads();
        const current = await load();
        if (current?.connected) await loadThreads();
      } finally {
        setRefreshing(false);
      }
    },
    [load, loadThreads],
  );
  const { load: refresh, countdown } = useActivePolling({
    active: active && connected,
    interval: SLACK_POLL_MS,
    load: poll,
    loaded: !!threads,
  });

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
    setShowWatch(false);
    setStatus({ connected: false, connecting: false });
    wasConnected.current = false;
    sessionIdentity.current = '';
    setPending(false);
    // Only once the server dropped the session: the badge refetch reads that state.
    if (disconnected) notifySlackSessionChanged('slack');
  };

  const account = !status
    ? 'Checking…'
    : connected
      ? `Connected as @${status.user || 'you'}${status.team ? ` · ${status.team}` : ''}`
      : connecting
        ? 'Waiting for sign-in…'
        : 'Not connected';

  // Tab counts, the reply count and the board all read the placed threads of one
  // snapshot, so the three numbers cannot disagree. Threads without a usable
  // activity time are counted, never listed.
  const placed = useMemo(
    () =>
      Object.fromEntries(
        Object.keys(SECTIONS).map((id) => {
          const { groups, unplaced } = groupSlackActivity(threads?.[id] || [], now);
          return [id, { groups, unplaced, items: groups.flatMap((group) => group.threads) }];
        }),
      ),
    [threads, now],
  );
  const { groups, unplaced, items } = placed[section];
  const needsReply = items.filter((thread) => thread.needsReply === true).length;
  const checking = threads?.enriched === false;
  const replyUnknown = items.some((thread) => thread.needsReply == null);
  const { staleReplyWarning, standaloneWarning, incomplete } = slackCoverage(threads);
  const updatedLabel = threads ? new Date(threads.updatedAt).toLocaleTimeString() : '';
  const threadsMeta = !threads
    ? 'Loading…'
    : checking
      ? `Checking replies… · ${needsReply} loaded need a reply · updated ${updatedLabel}`
      : replyUnknown
        ? `Reply status unknown for some loaded threads · ${needsReply} need a reply`
        : `${needsReply} loaded threads need a reply · updated ${updatedLabel}`;
  // The amber note over the board, or null: why the loaded threads may not be the whole story.
  // Any reason raises it, and it names the ones that have a sentence of their own. The Watch
  // view never shows it.
  const lastUpdateNote = threads?.stale || threadsFailed ? LAST_UPDATE_NOTE : '';
  const unplacedText = unplaced > 0 ? unplacedNote(unplaced) : '';
  const coverageNote =
    threads &&
    !showWatch &&
    (incomplete || checking || replyUnknown || lastUpdateNote || unplacedText)
      ? [
          lastUpdateNote,
          INCOMPLETE_NOTE,
          staleReplyWarning,
          standaloneWarning,
          ...(threads.coverageNotes || []),
          unplacedText,
        ]
          .filter(Boolean)
          .join(' ')
      : null;

  // The countdown re-renders this panel every second; an identical element lets
  // React skip the board and its card-wide DOM scan until the threads change.
  const board = useMemo(
    () => (
      <Board label="Slack activity board" testId="slack-board" frameRef={boardFrame}>
        {groups.map((group) => (
          <BoardColumn
            key={group.id}
            id={group.id}
            label={group.label}
            count={group.threads.length}
            testIdPrefix="slack-column-"
          >
            {group.threads.map((thread) => (
              <li key={thread.ts}>
                <SlackThreadCard
                  thread={thread}
                  mentions={section === 'mentions'}
                  now={now}
                  onOpen={setOpenThread}
                />
              </li>
            ))}
          </BoardColumn>
        ))}
      </Board>
    ),
    [groups, section, now],
  );

  const renderBody = () => {
    if (!status)
      return <BoardState kind="loading" testId="slack-loading" label="Checking Slack…" />;
    if (!connected)
      return connecting ? (
        <BoardState testId="slack-connecting">
          Finish signing in to Slack in the window that just opened. Closing that window cancels —
          nothing else in the dashboard changes.
        </BoardState>
      ) : (
        <BoardState testId="slack-disconnected">
          Slack is optional — skip it and every other tab behaves exactly as it does today. Signing
          in opens a separate Slack window. Until that finishes, this tab stays empty and no other
          panel waits on it.
        </BoardState>
      );
    if (showWatch) return null;
    if (!threads)
      return threadsFailed ? (
        <BoardState testId="slack-threads-unavailable">
          Slack is not responding right now. Retrying — nothing else is waiting on it.
        </BoardState>
      ) : (
        <BoardState kind="loading" testId="slack-threads-loading" label="Loading threads…" />
      );
    if (items.length === 0)
      return <BoardState testId="slack-threads-empty">{SECTIONS[section].empty}</BoardState>;
    return board;
  };

  return (
    <BoardPanel id="slack" active={active} busy={pending}>
      <BoardSection
        name="slack"
        title="Slack"
        sub={<span role="status">{account}</span>}
        activeTab={connected ? view : undefined}
        meta={connected ? threadsMeta : undefined}
        testIds={{ sub: 'slack-meta', meta: 'slack-threads-meta', list: 'slack-threads' }}
        controls={
          status && (
            <>
              {connected ? (
                <Button data-testid="slack-disconnect" disabled={pending} onClick={disconnect}>
                  Disconnect
                </Button>
              ) : (
                <Button
                  data-testid="slack-connect"
                  disabled={pending || connecting}
                  onClick={connect}
                >
                  Connect Slack
                </Button>
              )}
              {connected && !showWatch && threads?.continuation && (
                <Button onClick={() => loadThreads(threads.continuation)}>
                  Load more eligible threads
                </Button>
              )}
              {connected && (
                <RefreshControl
                  name="slack"
                  loading={refreshing}
                  countdown={countdown}
                  onRefresh={refresh}
                />
              )}
            </>
          )
        }
        filters={
          connected && (
            <BoardTabs
              name="slack"
              label="Slack lists"
              tabs={[
                ...Object.entries(SECTIONS).map(([id, entry]) => ({
                  id,
                  label: entry.label,
                  count: placed[id].items.length,
                  testId: `slack-tab-${id}`,
                })),
                {
                  id: WATCH_VIEW,
                  label: 'Watch threads',
                  count: watchSummary?.count,
                  tone: watchSummary?.attention ? 'warn' : undefined,
                  hint: watchSummary?.attention || undefined,
                  testId: 'slack-tab-watch',
                },
              ]}
              value={view}
              onChange={switchView}
            />
          )
        }
        notes={
          <>
            <UpstreamNote
              integrations={['slack']}
              active={active && connected}
              refreshKey={countdown.lastLoadedAt}
            />
            {coverageNote && <BoardNote testId="slack-coverage">{coverageNote}</BoardNote>}
          </>
        }
      >
        {renderBody()}
        {connected && (
          <SlackWatchCard active={active} hidden={!showWatch} onSummary={setWatchSummary} />
        )}
      </BoardSection>
      {dialog}
    </BoardPanel>
  );
}
