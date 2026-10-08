import { Fragment, useCallback, useMemo, useRef, useState } from 'react';
import { Button, Card, LoadingState } from '../components/Primitives.jsx';
import { WorkFilters } from '../components/WorkFilters.jsx';
import { MyTicketsGroups } from '../components/WorkTicket.jsx';
import { useDashboardApi } from '../hooks/useDashboardApi.js';
import { useActivePolling } from '../hooks/useActivePolling.js';
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

export function MyTicketsPanel({ config, active }) {
  const api = useDashboardApi();
  const [includeDone, setIncludeDone] = useState(false);
  const [data, setData] = useState(null);
  const [meta, setMeta] = useState('loading…');
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState('');
  const [filters, setFilters] = useState({
    search: '',
    status: '',
    sprint: '',
    priority: '',
    type: '',
  });
  const dataRef = useRef(data);
  dataRef.current = data;
  const load = useCallback(
    async ({ silent = false, include = includeDone } = {}) => {
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
    [api, includeDone],
  );
  const { countdown } = useActivePolling({
    active,
    interval: MY_TICKETS_POLL_MS,
    load,
    loaded: !!data,
  });
  const rows = data?.tickets || Object.values(data?.groupsByCategory || {}).flat();
  const filtered = useMemo(() => filterTickets(rows, filters), [rows, filters]);
  const keep = new Set(filtered.map((ticket) => ticket.key));
  const groups = Object.fromEntries(
    Object.entries(data?.groupsByCategory || {})
      .map(([category, tickets]) => [category, tickets.filter((ticket) => keep.has(ticket.key))])
      .filter(([, tickets]) => tickets.length),
  );
  const options = ticketFilterOptions(rows, data?.allSprints);
  return (
    <section
      id="panel-my-tickets"
      className="panel"
      data-testid="panel-my-tickets"
      hidden={!active}
      aria-busy={loading}
    >
      <header className="page-intro">
        <p className="eyebrow">Assigned to you</p>
        <h2>My Tickets</h2>
        <p>Assigned Jira tickets, grouped by status.</p>
      </header>
      <Card className="my-tickets-section" data-testid="my-tickets-section">
        <div className="pr-open-heading" data-testid="my-tickets-title">
          <span className="section-label">Work queue</span>
          <span className="pr-open-count" data-testid="my-tickets-meta" role="status">
            {meta}
          </span>
          <label className="my-tickets-toggle" data-testid="my-tickets-toggle-wrap">
            <input
              type="checkbox"
              data-testid="my-tickets-include-done"
              checked={includeDone}
              disabled={loading}
              onChange={(event) => {
                const checked = event.target.checked;
                setIncludeDone(checked);
                load({ include: checked });
              }}
            />{' '}
            Include Done
          </label>
          <Button data-testid="my-tickets-refresh" disabled={loading} onClick={() => load()}>
            Refresh
          </Button>
          <span className="pr-next" data-testid="my-tickets-next">
            {countdown}
          </span>
        </div>
        <div className="my-tickets-sprint" data-testid="my-tickets-sprint" hidden={!data}>
          {data && sprintHtml(data.activeSprints)}
        </div>
        <WorkFilters
          id="my-tickets-filter"
          view="tickets"
          options={options}
          total={rows.length}
          shown={filtered.length}
          onChange={setFilters}
        />
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
              {filtered.length === 0 && rows.length ? (
                <div className="pr-empty" data-testid="my-tickets-no-matches">
                  No matches. Try changing or clearing filters.
                </div>
              ) : (
                <MyTicketsGroups
                  groups={groups}
                  jiraBase={config.jiraBase}
                  currentSprints={data.activeSprints}
                />
              )}
            </>
          )}
        </div>
      </Card>
    </section>
  );
}
