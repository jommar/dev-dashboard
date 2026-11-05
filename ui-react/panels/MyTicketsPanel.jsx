import { Fragment, useCallback, useMemo, useRef, useState } from 'react';
import { Button, Card, LoadingState } from '../components/Primitives.jsx';
import { WorkFilters } from '../components/WorkFilters.jsx';
import { TicketBoard } from '../components/TicketBoard.jsx';
import { SlackThreadDialog } from '../components/SlackThreadDialog.jsx';
import { useDashboardApi } from '../hooks/useDashboardApi.js';
import { useActivePolling } from '../hooks/useActivePolling.js';
import { filterTickets, ticketFilterOptions } from '../../ui/work-filters.js';
import { sprintDay, sprintCountdown } from '../../ui/domain-helpers.js';
import { threadsByTicket } from '../../ui/slack-ticket-links.js';
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

export function MyTicketsPanel({ config, active }) {
  const api = useDashboardApi();
  const [includeDone, setIncludeDone] = useState(false);
  const [data, setData] = useState(null);
  const [meta, setMeta] = useState('loading…');
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState('');
  const [slackStarted, setSlackStarted] = useState([]);
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
  // Slack is optional and often slow. The request degrades to "no threads" on
  // its own, and the catch is there because this runs without being awaited:
  // anything thrown would otherwise become an unhandled rejection with nowhere
  // to surface, and My Tickets has no error state for Slack by design.
  const loadSlack = useCallback(async () => {
    try {
      const result = await api.getSlackThreads();
      setSlackStarted(result?.available ? result.started || [] : []);
    } catch {
      setSlackStarted([]);
    }
  }, [api]);
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
  const linksByTicket = useMemo(() => threadsByTicket(slackStarted), [slackStarted]);
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
      <SlackThreadDialog thread={openThread} onClose={() => setOpenThread(null)} />
    </section>
  );
}
