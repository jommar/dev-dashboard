import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BoardNote,
  BoardPanel,
  BoardSection,
  BoardState,
  RefreshControl,
} from '../components/BoardShell.jsx';
import { WorkFilters } from '../components/WorkFilters.jsx';
import { TicketBoard } from '../components/TicketBoard.jsx';
import { LazyDialog } from '../components/ScreenSlot.jsx';
import { ClaudeDialog, loadClaudeDialog } from '../lib/lazy-overlays.js';
import { UpstreamNote } from '../components/UpstreamNote.jsx';
import { useDashboardApi } from '../hooks/useDashboardApi.js';
import { useActivePolling } from '../hooks/useActivePolling.js';
import { useTicketSlackThreads } from '../hooks/useTicketSlackThreads.jsx';
import { useClaudeTickets } from '../hooks/useClaudeTickets.js';
import { filterTickets, ticketFilterOptions } from '../../ui/work-filters.js';
import { sprintDay, sprintCountdown } from '../../ui/domain-helpers.js';
import { MY_TICKETS_POLL_MS } from '../../ui/polling.js';

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

// `requestedTicket` is the key a #/my-tickets?ticket=KEY address asks to open (or null); the panel opens
// it once its list is in, then calls `onTicketHandled` so the address is cleared.
export function MyTicketsPanel({ config, active, requestedTicket = null, onTicketHandled }) {
  const api = useDashboardApi();
  const [includeDone, setIncludeDone] = useState(false);
  const [data, setData] = useState(null);
  const [meta, setMeta] = useState('loading…');
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState('');
  const [prs, setPrs] = useState(null);
  const [prStale, setPrStale] = useState(false);
  // The ticket whose Claude dialog is open. It is held here, not in a card, so a card that
  // remounts (a filter or column change) does not close it.
  const [openClaudeKey, setOpenClaudeKey] = useState(null);
  const closeClaude = useCallback(() => setOpenClaudeKey(null), []);
  // Load the dialog's code first, then open it (also when the load fails: Reload alert).
  const openClaude = useCallback((key) => {
    const show = () => setOpenClaudeKey(key);
    loadClaudeDialog().then(show, show);
  }, []);
  // A deep-linked ticket that is not in the assigned list: named in a note until the tab is left.
  const [missingTicket, setMissingTicket] = useState(null);
  // A deep-linked ticket not in the list yet, while the list on screen is older than a poll: the
  // activation load decides, so "missing" is never said from stale data.
  const [checkingTicket, setCheckingTicket] = useState(null);
  const loadedAt = useRef(0);
  const ticketBaseline = useRef(null);
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
  const claude = useClaudeTickets({ active });
  const {
    loadSlack,
    openThread,
    linksByTicket,
    dialog,
    snapshot: slackSnapshot,
    staleReplyWarning,
    standaloneWarning,
    incomplete,
  } = useTicketSlackThreads({ source: 'my-tickets', active });
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
        loadedAt.current = Date.now();
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
  const { load: refresh, countdown } = useActivePolling({
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
  const openClaudeTicket = openClaudeKey && rows.find((ticket) => ticket.key === openClaudeKey);
  // A ticket that left the list (a status change on the 90 s poll) takes its dialog with it, and so
  // does leaving the tab: the panel only goes hidden, and a modal left open in it would keep the
  // rest of the page inert.
  useEffect(() => {
    if (openClaudeKey && (!active || !openClaudeTicket)) setOpenClaudeKey(null);
  }, [active, openClaudeKey, openClaudeTicket]);
  useEffect(() => {
    if (!requestedTicket || !active || !data) return;
    const row = rows.find(({ key }) => key.toUpperCase() === requestedTicket);
    if (!row) {
      if (ticketBaseline.current?.ticket !== requestedTicket)
        ticketBaseline.current = { ticket: requestedTicket, data };
      const current =
        ticketBaseline.current.data !== data || Date.now() - loadedAt.current <= MY_TICKETS_POLL_MS;
      if (!current) {
        setCheckingTicket(requestedTicket);
        return;
      }
    }
    ticketBaseline.current = null;
    if (row) openClaude(row.key);
    setCheckingTicket(null);
    setMissingTicket(row ? null : requestedTicket);
    onTicketHandled?.();
  }, [requestedTicket, active, data, rows, onTicketHandled, openClaude]);
  useEffect(() => {
    if (!active) {
      setMissingTicket(null);
      setCheckingTicket(null);
      ticketBaseline.current = null;
    }
  }, [active]);
  const options = useMemo(
    () => ticketFilterOptions(rows, data?.allSprints),
    [rows, data?.allSprints],
  );
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
        claudeByTicket={claude.byTicket}
        onOpenThread={openThread}
        onOpenClaude={openClaude}
      />
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the board element is memoized on purpose (see the comment above); openThread is left out so it stays stable
    [
      filtered,
      config.jiraBase,
      data?.activeSprints,
      linksByTicket,
      prs?.byTicket,
      claude.byTicket,
      openClaude,
    ],
  );
  // The sub line is a set of elements, so memoize it with the options above: only a new answer
  // changes either, not the other re-renders this panel gets.
  const sprint = useMemo(() => data && sprintHtml(data.activeSprints), [data]);
  return (
    <BoardPanel id="my-tickets" active={active} busy={loading}>
      <BoardSection
        name="my-tickets"
        title="My Tickets"
        sub={sprint}
        subHidden={!data}
        testIds={{ sub: 'my-tickets-sprint' }}
        meta={meta}
        controls={
          <>
            <label className="board-toggle" data-testid="my-tickets-toggle-wrap">
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
            <RefreshControl
              name="my-tickets"
              loading={loading}
              countdown={countdown}
              onRefresh={refresh}
            />
          </>
        }
        filters={
          <WorkFilters
            id="my-tickets-filter"
            view="tickets"
            options={options}
            total={rows.length}
            shown={filtered.length}
            onChange={setFilters}
            collapsible
          />
        }
        notes={
          <>
            <UpstreamNote
              integrations={['jira', 'github', 'slack']}
              active={active}
              refreshKey={countdown.lastLoadedAt}
            />
            {checkingTicket && (
              <BoardNote testId="my-tickets-ticket-checking">
                Looking for {checkingTicket} in your assigned tickets…
              </BoardNote>
            )}
            {missingTicket && (
              <BoardNote testId="my-tickets-ticket-missing">
                {missingTicket} is not in your assigned tickets, so it cannot be opened here. Tick
                Include Done if it is finished work.
              </BoardNote>
            )}
            {(prStale || prs?.truncated) && (
              <BoardNote testId="my-tickets-prs-note">
                {prStale ? prNoteText(prs) : PR_TRUNCATED_NOTE}
              </BoardNote>
            )}
            {(incomplete || slackSnapshot?.continuation) && (
              <BoardNote testId="my-tickets-slack-coverage">
                Slack thread results may be incomplete.{' '}
                <a href="#/slack">View Slack and load more</a>.
                {staleReplyWarning ? ` ${staleReplyWarning}` : ''}
                {standaloneWarning ? ` ${standaloneWarning}` : ''}
              </BoardNote>
            )}
          </>
        }
      >
        {!data ? (
          failure ? (
            <BoardState kind="error" testId="my-tickets-error">
              {failure}
            </BoardState>
          ) : (
            <BoardState kind="loading" label="Loading tickets…" testId="my-tickets-loading" />
          )
        ) : (
          <>
            {data.truncated && (
              <BoardState kind="warning" testId="my-tickets-truncated">
                Not all tickets were fetched — this list and its totals may be incomplete.
              </BoardState>
            )}
            {rows.length === 0 ? (
              <BoardState testId="my-tickets-empty">No tickets assigned to you.</BoardState>
            ) : filtered.length === 0 ? (
              <BoardState testId="my-tickets-no-matches">
                No matches. Try changing or clearing filters.
              </BoardState>
            ) : (
              board
            )}
          </>
        )}
      </BoardSection>
      {dialog}
      {openClaudeTicket && (
        <LazyDialog key={openClaudeTicket.key} label="The Claude dialog" onClose={closeClaude}>
          <ClaudeDialog
            ticketKey={openClaudeTicket.key}
            summary={openClaudeTicket.summary}
            entry={claude.byTicket[openClaudeTicket.key]}
            onClose={closeClaude}
            launch={claude.launch}
            answer={claude.answer}
            approve={claude.approve}
            continueSession={claude.continueSession}
            sessionIds={claude.sessionIds[openClaudeTicket.key]}
          />
        </LazyDialog>
      )}
    </BoardPanel>
  );
}
