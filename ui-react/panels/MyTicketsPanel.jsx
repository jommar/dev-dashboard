import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, LoadingState } from '../components/Primitives.jsx';
import { WorkFilters } from '../components/WorkFilters.jsx';
import { TicketBoard } from '../components/TicketBoard.jsx';
import { SlackThreadDialog } from '../components/SlackThreadDialog.jsx';
import { useDashboardApi } from '../hooks/useDashboardApi.js';
import { useActivePolling } from '../hooks/useActivePolling.js';
import { useSlackActivityClock } from '../hooks/useSlackActivityClock.js';
import { notifySlackSessionChanged } from '../hooks/useSlackPending.js';
import { filterTickets, ticketFilterOptions } from '../../ui/work-filters.js';
import { sprintDay, sprintCountdown } from '../../ui/domain-helpers.js';
import { threadsByTicket } from '../../ui/slack-ticket-links.js';
import { eligibleSlackRoot, slackSessionIdentity } from '../../ui/slack-activity.js';
import { MY_TICKETS_POLL_MS } from '../../ui/polling.js';
import { slackStaleReplyWarning, slackStandaloneMentionWarning } from '../../ui/slack-coverage.js';

function sprintHtml(sprints) {
  if (!sprints?.length) return 'No active sprint among your tickets';
  return sprints.map((sprint, index) => (
    <Fragment key={sprint.id ?? sprint.name}>
      {index > 0 && <span className="my-tickets-sprint-sep">·</span>}
      <span className="my-tickets-sprint-name">{sprint.name}</span>
      <span className="my-tickets-sprint-when">
        {[
          sprintDay(sprint.startDate) && sprintDay(sprint.endDate)
            ? `${sprintDay(sprint.startDate)} – ${sprintDay(sprint.endDate)}`
            : sprintDay(sprint.startDate) || sprintDay(sprint.endDate),
          sprintCountdown(sprint.endDate),
        ]
          .filter(Boolean)
          .join(' · ')}
      </span>
    </Fragment>
  ));
}

function prNoteText(prs) {
  if (!prs) return 'PR status unavailable. Tickets show without PR lines.';
  const when = prs.updatedAt ? ` ${new Date(prs.updatedAt).toLocaleTimeString()}` : '';
  return `PR status could not refresh. Showing the last update${when}.`;
}

const PR_TRUNCATED_NOTE = 'Not all open PRs were fetched, so some tickets may show no PR lines.';

// One shared empty map until the first PR answer, so the board's props stay equal between ticks.
const NO_PR_LINES = Object.freeze({});

export function MyTicketsPanel({ config, active }) {
  const api = useDashboardApi();
  const [includeDone, setIncludeDone] = useState(false);
  const [data, setData] = useState(null);
  const [meta, setMeta] = useState('loading…');
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState('');
  const [slackSnapshot, setSlackSnapshot] = useState(null);
  const [prs, setPrs] = useState(null);
  const [prStale, setPrStale] = useState(false);
  const [openThread, setOpenThread] = useState(null);
  const [filters, setFilters] = useState({
    search: '',
    status: '',
    sprint: '',
    priority: '',
    type: '',
  });
  const dataRef = useRef(data);
  dataRef.current = data;
  const prRequest = useRef(0);
  const slackRequest = useRef(0);
  const slackIdentity = useRef('');
  const slackDirty = useRef(false);
  const dialogWasOpen = useRef(false);
  const expiredDialog = useRef(false);
  const [slackNow, currentTime] = useSlackActivityClock(slackSnapshot, active, openThread);
  const threadIsEligible = (ts) => eligibleSlackRoot(ts, currentTime());
  const clearSlackData = useCallback(() => {
    dialogWasOpen.current = false;
    setOpenThread(null);
    setSlackSnapshot(null);
  }, []);
  // Slack is optional and often slow. The request degrades to "no threads" on
  // its own, and the catch is there because this runs without being awaited:
  // anything thrown would otherwise become an unhandled rejection with nowhere
  // to surface, and My Tickets has no error state for Slack by design.
  const loadSlack = useCallback(async () => {
    const request = ++slackRequest.current;
    try {
      // One immediate retry can load a versioned replacement session without
      // allowing changing credentials to create an unbounded request loop.
      for (let attempt = 0; attempt < 2; attempt++) {
        const status = await api.getSlackStatus();
        const before = slackSessionIdentity(status, slackIdentity.current);
        if (request !== slackRequest.current) return;
        if (slackIdentity.current && before !== slackIdentity.current) {
          clearSlackData();
          notifySlackSessionChanged('my-tickets');
        }
        slackIdentity.current = before;
        if (!before) {
          clearSlackData();
          return;
        }
        const requestStartedWallAt = Date.now();
        const requestStartedAt = performance.now();
        const result = await api.getSlackThreads();
        const after = slackSessionIdentity(await api.getSlackStatus(), before);
        if (request !== slackRequest.current) return;
        if (after !== before) {
          clearSlackData();
          slackIdentity.current = after;
          notifySlackSessionChanged('my-tickets');
          // A legacy savedAt/account identity does not establish that the
          // backend invalidated its old list cache. Discard rather than
          // immediately re-requesting a possibly old-session snapshot.
          if (before.startsWith('version:') && after.startsWith('version:')) continue;
          return;
        }
        slackIdentity.current = after;
        setSlackSnapshot(
          result?.available
            ? {
                ...result,
                _requestStartedAt: requestStartedAt,
                _requestStartedWallAt: requestStartedWallAt,
              }
            : null,
        );
        return;
      }
    } catch {
      if (request === slackRequest.current) setSlackSnapshot(null);
    }
  }, [api, clearSlackData]);
  useEffect(() => {
    const sessionChanged = (event) => {
      if (event.detail?.source === 'my-tickets') return;
      slackRequest.current += 1;
      slackIdentity.current = '';
      clearSlackData();
      if (active) loadSlack();
      else slackDirty.current = true;
    };
    window.addEventListener('slack-session-changed', sessionChanged);
    return () => window.removeEventListener('slack-session-changed', sessionChanged);
  }, [active, clearSlackData, loadSlack]);
  useEffect(() => {
    if (!active || !slackDirty.current) return;
    slackDirty.current = false;
    loadSlack();
  }, [active, loadSlack]);
  const dialogSessionMismatch = useCallback(() => {
    slackRequest.current += 1;
    slackIdentity.current = '';
    clearSlackData();
    notifySlackSessionChanged('my-tickets');
    if (active) loadSlack();
    else slackDirty.current = true;
  }, [active, clearSlackData, loadSlack]);
  useEffect(() => {
    if (openThread && !eligibleSlackRoot(openThread.ts, slackNow)) {
      expiredDialog.current = true;
      setOpenThread(null);
    }
  }, [openThread, slackNow]);
  // PR status is optional in the same way. The last good map stays on screen when
  // a refresh fails, and only the newest request may change the state.
  const loadPrs = useCallback(async () => {
    const request = ++prRequest.current;
    try {
      const result = await api.getTicketPrs();
      if (request !== prRequest.current) return;
      if (result?.available) {
        setPrs(result);
        setPrStale(false);
      } else setPrStale(true);
    } catch {
      if (request === prRequest.current) setPrStale(true);
    }
  }, [api]);
  const load = useCallback(
    async ({ silent = false, include = includeDone, skipPrs = false } = {}) => {
      // Fired, never awaited: the ticket list must not wait on Slack or on GitHub,
      // and neither outage may turn into a failed refresh. Cards and PR lines fill
      // in on their own once their answers arrive. Include Done passes skipPrs: it
      // changes which tickets come back, not which PRs exist.
      loadSlack();
      if (!skipPrs) loadPrs();
      setLoading(true);
      if (!silent) setMeta(dataRef.current ? 'Refreshing…' : 'loading…');
      try {
        const result = await api.getMyTickets(include);
        if (result === null) {
          setIncludeDone(!!dataRef.current?.includeDone);
          setMeta(
            dataRef.current ? 'Jira not configured — showing last update' : 'Jira not configured',
          );
          return;
        }
        setData(result);
        setMeta(
          `${result.total} assigned to me${result.includeDone ? ' (incl. Done)' : ''} · updated ${new Date().toLocaleTimeString()}`,
        );
        setFailure('');
      } catch (error) {
        setIncludeDone(!!dataRef.current?.includeDone);
        if (!dataRef.current) {
          setMeta('error');
          setFailure(`Failed to load tickets: ${error.message}`);
        } else setMeta(`Refresh failed — showing last update ${new Date().toLocaleTimeString()}`);
      } finally {
        setLoading(false);
      }
    },
    [api, includeDone, loadSlack, loadPrs],
  );
  // The thread dialog is where a Claude session gets attached, so the threads are read again
  // once it closes and the chip shows the attach at once. The route answers from its cache, so
  // this costs no Slack call within the cache's lifetime.
  useEffect(() => {
    if (openThread) dialogWasOpen.current = true;
    else if (dialogWasOpen.current) {
      dialogWasOpen.current = false;
      if (!expiredDialog.current) loadSlack();
      expiredDialog.current = false;
    }
  }, [openThread, loadSlack]);
  const { countdown } = useActivePolling({
    active,
    interval: MY_TICKETS_POLL_MS,
    load,
    loaded: !!data,
  });
  const rows = useMemo(
    () => data?.tickets || Object.values(data?.groupsByCategory || {}).flat(),
    [data],
  );
  const filtered = useMemo(() => filterTickets(rows, filters), [rows, filters]);
  const options = ticketFilterOptions(rows, data?.allSprints);
  const linksByTicket = useMemo(
    () =>
      threadsByTicket(
        (slackSnapshot?.started || []).filter((row) => eligibleSlackRoot(row.ts, slackNow)),
      ),
    [slackSnapshot, slackNow],
  );
  const staleReplyWarning = slackStaleReplyWarning(slackSnapshot);
  const standaloneWarning = slackStandaloneMentionWarning(slackSnapshot);
  // The board is memoized as an element: the countdown re-renders this panel every second,
  // and an identical element lets React skip the board and its card-wide DOM scan.
  const board = useMemo(
    () => (
      <TicketBoard
        tickets={filtered}
        jiraBase={config.jiraBase}
        currentSprints={data?.activeSprints}
        linksByTicket={linksByTicket}
        prsByTicket={prs?.byTicket || NO_PR_LINES}
        onOpenThread={setOpenThread}
      />
    ),
    [filtered, config.jiraBase, data?.activeSprints, linksByTicket, prs?.byTicket],
  );
  return (
    <section
      id="panel-my-tickets"
      className="panel"
      data-testid="panel-my-tickets"
      hidden={!active}
      aria-busy={loading}
    >
      <Card className="my-tickets-section" data-testid="my-tickets-section">
        <div className="my-tickets-toolbar">
          <div className="my-tickets-bar">
            <h2 className="my-tickets-title" data-testid="my-tickets-title">
              My Tickets
            </h2>
            <div className="my-tickets-sprint" data-testid="my-tickets-sprint" hidden={!data}>
              {data && sprintHtml(data.activeSprints)}
            </div>
            <span className="my-tickets-meta" data-testid="my-tickets-meta" role="status">
              {meta}
            </span>
            <div className="my-tickets-controls">
              <label className="my-tickets-toggle" data-testid="my-tickets-toggle-wrap">
                <input
                  type="checkbox"
                  data-testid="my-tickets-include-done"
                  checked={includeDone}
                  disabled={loading}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setIncludeDone(checked);
                    load({ include: checked, skipPrs: true });
                  }}
                />{' '}
                Include Done
              </label>
              <Button data-testid="my-tickets-refresh" disabled={loading} onClick={() => load()}>
                Refresh
              </Button>
              <span className="my-tickets-next" data-testid="my-tickets-next">
                {countdown}
              </span>
            </div>
          </div>
          <WorkFilters
            id="my-tickets-filter"
            view="tickets"
            options={options}
            total={rows.length}
            shown={filtered.length}
            onChange={setFilters}
            collapsible
          />
          {(prStale || prs?.truncated) && (
            <p className="my-tickets-prs-note" data-testid="my-tickets-prs-note">
              {prStale ? prNoteText(prs) : PR_TRUNCATED_NOTE}
            </p>
          )}
          {(slackSnapshot?.partial ||
            slackSnapshot?.truncated ||
            slackSnapshot?.continuation ||
            staleReplyWarning ||
            standaloneWarning) && (
            <p
              className="my-tickets-prs-note"
              role="status"
              data-testid="my-tickets-slack-coverage"
            >
              Slack thread results may be incomplete. <a href="#/slack">View Slack and load more</a>
              .{staleReplyWarning ? ` ${staleReplyWarning}` : ''}
              {standaloneWarning ? ` ${standaloneWarning}` : ''}
            </p>
          )}
        </div>
        <div className="my-tickets-list" data-testid="my-tickets-list">
          {!data ? (
            <>
              {failure ? (
                <div className="pr-error" data-testid="my-tickets-error">
                  {failure}
                </div>
              ) : (
                <LoadingState label="Loading tickets…" testId="my-tickets-loading" />
              )}
            </>
          ) : (
            <>
              {data.truncated && (
                <p className="home-warn" data-testid="my-tickets-truncated">
                  Not all tickets were fetched — this list and its totals may be incomplete.
                </p>
              )}
              {rows.length === 0 ? (
                <div className="pr-empty" data-testid="my-tickets-empty">
                  No tickets assigned to you.
                </div>
              ) : filtered.length === 0 ? (
                <div className="pr-empty" data-testid="my-tickets-no-matches">
                  No matches. Try changing or clearing filters.
                </div>
              ) : (
                board
              )}
            </>
          )}
        </div>
      </Card>
      <SlackThreadDialog
        thread={openThread}
        onClose={() => setOpenThread(null)}
        isEligible={threadIsEligible}
        sessionIdentity={slackIdentity.current}
        onSessionMismatch={dialogSessionMismatch}
      />
    </section>
  );
}
