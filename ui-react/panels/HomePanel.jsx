import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDashboardApi } from '../hooks/useDashboardApi.js';
import { useActivePolling } from '../hooks/useActivePolling.js';
import { Button, Card, LoadingState } from '../components/Primitives.jsx';
import { WorkFilters } from '../components/WorkFilters.jsx';
import { Listbox } from '../components/Listbox.jsx';
import { PrActions } from '../components/PrActions.jsx';
import {
  HomeActionQueue,
  HomeKpis,
  HomeSprintCard,
  HomeVelocity,
  ServiceStrip,
} from '../components/HomeCards.jsx';
import {
  actionQueue,
  capTiers,
  donePointsBySprint,
  kpiCounts,
  myReviewsUnknown,
  selectableSprints,
  sprintKeyOf,
  sprintProgressFor,
} from '../../ui/home-data.js';
import { sprintDay, sprintCountdown } from '../../ui/domain-helpers.js';
import { HOME_POLL_MS } from '../../ui/polling.js';
import { filterActionTiers, filterTickets, ticketFilterOptions } from '../../ui/work-filters.js';

const ACTION_CAP = 12;
const EMPTY = <LoadingState label="Loading…" />;

export function HomePanel({ config, active, services = [] }) {
  const api = useDashboardApi();
  const root = useRef(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [actionsFilter, setActionsFilter] = useState({ search: '', action: '' });
  const [sprintFilter, setSprintFilter] = useState({ search: '', status: '' });
  const [selectedSprintKey, setSelectedSprintKey] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());
  const [serviceSnapshot, setServiceSnapshot] = useState(services);
  const [controlFeedback, setControlFeedback] = useState('');
  const [controlPendingIds, setControlPendingIds] = useState(() => new Set());
  useEffect(() => {
    if (services) setServiceSnapshot(services);
  }, [services]);
  useEffect(
    () =>
      api.onControlPending((id, pending) =>
        setControlPendingIds((current) => {
          const next = new Set(current);
          if (pending) next.add(id);
          else next.delete(id);
          return next;
        }),
      ),
    [api],
  );
  const inFlight = useRef(false);
  const dataRef = useRef(data);
  dataRef.current = data;
  const load = useCallback(
    async ({ silent = false } = {}) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setLoading(true);
      if (!silent) setError('');
      try {
        const [prs, tickets] = await Promise.all([
          api.getPrs().catch(() => undefined),
          api.getMyTickets(true).catch(() => undefined),
        ]);
        setData((previous) => ({
          prs:
            prs?.prsAvailable === false ? previous?.prs : prs !== undefined ? prs : previous?.prs,
          tickets: tickets !== undefined ? tickets : previous?.tickets,
          prsOk: prs !== undefined && prs?.prsAvailable !== false,
          ticketsOk: tickets !== undefined,
        }));
        if (prs === undefined || prs?.prsAvailable === false || tickets === undefined) {
          setError('');
        }
        if (!prs && !tickets && !dataRef.current)
          setError('Could not load overview. Refresh to try again.');
      } catch (cause) {
        if (!dataRef.current) setError(cause.message);
      } finally {
        inFlight.current = false;
        setLoading(false);
      }
    },
    [api],
  );
  const { countdown } = useActivePolling({ active, interval: HOME_POLL_MS, load, loaded: !!data });
  const tickets = data?.tickets;
  const sprints = useMemo(() => selectableSprints(tickets || {}), [tickets]);
  const chosen =
    sprints.find((sprint) => sprintKeyOf(sprint) === selectedSprintKey) ||
    sprints.find((sprint) => sprint.state === 'active') ||
    sprints[0];
  const progress = chosen && tickets ? sprintProgressFor(tickets, chosen) : null;
  const sprintRows = progress
    ? ['todo', 'active', 'done'].flatMap((key) => progress.byBand[key])
    : [];
  const visibleSprintRows = filterTickets(sprintRows, sprintFilter);
  const sprintOptions = ticketFilterOptions(sprintRows, tickets?.allSprints || []);
  const prs = data?.prs;
  const queue = actionQueue(prs, tickets);
  const filteredQueue = filterActionTiers(queue, actionsFilter);
  const totalActions = queue.reduce((sum, tier) => sum + tier.items.length, 0);
  const countActions = filteredQueue.reduce((sum, tier) => sum + tier.items.length, 0);
  const kpis = kpiCounts(prs, tickets);
  const tiles = [
    {
      id: 'my-prs',
      label: 'My open PRs',
      value: kpis.myPrs,
      unknown: !prs,
      hint: prs ? null : 'GitHub unavailable',
      target: 'prs',
    },
    {
      id: 'needs-review',
      label: prs ? `Needs review (${prs.approvalThreshold} required)` : 'Needs review',
      value: kpis.needsReview,
      unknown: !prs || prs.reviewDataAvailable === false,
      hint: myReviewsUnknown(prs) ? 'Review data unavailable' : null,
      target: 'prs',
    },
    {
      id: 'sprint-tickets',
      label: 'My tickets in sprint',
      value: kpis.sprintTickets,
      unknown: !tickets,
      hint: tickets ? null : 'Jira unavailable',
      target: 'my-tickets',
    },
    {
      id: 'sprint-done',
      label: 'Done this sprint',
      value: kpis.sprintDone,
      unknown: !tickets,
      hint: tickets ? null : 'Jira unavailable',
      target: 'my-tickets',
    },
  ];
  const cappedActions = capTiers(filteredQueue, ACTION_CAP);
  const actionCount = cappedActions.tiers.reduce((sum, tier) => sum + tier.items.length, 0);
  const toggleBand = (key) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const runControl = async (id, action) => {
    setControlFeedback('Sending command…');
    try {
      await api.control(id, action);
      setControlFeedback('Command accepted. Status follows the service feed.');
    } catch (cause) {
      setControlFeedback(cause.message);
    }
  };
  const actionUnavailable = (() => {
    if (data && (!data.prsOk || !data.ticketsOk)) {
      const gaps = [];
      if (!data.prsOk) gaps.push('GitHub unavailable');
      if (!data.ticketsOk) gaps.push('Jira unavailable');
      return gaps.join(' · ');
    }
    if (prs && (prs.reviewDataAvailable !== true || myReviewsUnknown(prs)) && !totalActions)
      return 'Review data unavailable';
    return '';
  })();

  return (
    <section
      ref={root}
      id="panel-home"
      className="panel"
      data-testid="panel-home"
      hidden={!active}
      tabIndex={-1}
    >
      <div className="home" data-testid="home-section">
        <header className="page-intro">
          <p className="eyebrow">Your workspace</p>
          <h2>Reviews, tickets & runtime</h2>
          <p>Action queue and active sprint.</p>
        </header>
        <div className="pr-open-heading" data-testid="home-title">
          <span className="section-label">Overview</span>
          <span className="pr-open-count" data-testid="home-meta" role="status">
            {loading
              ? 'loading…'
              : error ||
                [
                  data && !data.prsOk && (prs ? 'GitHub stale' : 'GitHub unavailable'),
                  prs?.prs?.length != null && `${prs.prs.length} open PRs`,
                  data && !data.ticketsOk && (tickets ? 'Jira stale' : 'Jira unavailable'),
                  tickets?.total != null && `${tickets.total} tickets`,
                ]
                  .filter(Boolean)
                  .join(' · ') ||
                'nothing to show'}
          </span>
          <Button data-testid="home-refresh" disabled={loading} onClick={() => load()}>
            Refresh
          </Button>
          <span className="pr-next" data-testid="home-next">
            {countdown}
          </span>
        </div>
        <div className="home-cols">
          <Card className="home-block home-block-actions" data-testid="home-actions-block">
            <h3 className="home-block-head">
              Needs you <span className="home-block-caption">Your next moves</span>
            </h3>
            <WorkFilters
              id="home-actions-filter"
              view="actions"
              options={{
                action:
                  prs || tickets
                    ? queue
                        .filter((tier) => tier.items.length)
                        .map((tier) => [tier.id, tier.reason])
                    : [],
              }}
              total={totalActions}
              shown={countActions}
              onChange={setActionsFilter}
            />
            <PrActions>
              <div data-testid="home-actions">
                {!data ? (
                  EMPTY
                ) : !prs && !tickets ? (
                  <p className="home-empty" data-testid="home-actions-unconfigured">
                    Neither GitHub nor Jira is configured.
                  </p>
                ) : actionCount ? (
                  <HomeActionQueue
                    tiers={cappedActions.tiers}
                    hidden={cappedActions.hidden}
                    jiraBase={config.jiraBase}
                    search={actionsFilter.search}
                  />
                ) : actionUnavailable ? (
                  <p className="home-empty" data-testid="home-actions-unknown">
                    No known actions. {actionUnavailable} — the queue may be incomplete. Refresh to
                    try again.
                  </p>
                ) : (
                  <p
                    className="home-empty"
                    data-testid={totalActions ? 'home-actions-no-matches' : 'home-actions-empty'}
                  >
                    {totalActions
                      ? 'No matches. Try changing or clearing filters.'
                      : 'Nothing needs you right now.'}
                  </p>
                )}
              </div>
            </PrActions>
          </Card>
          <Card className="home-block home-block-sprint" data-testid="home-sprint-block">
            <h4 className="home-block-head">Sprint</h4>
            <WorkFilters
              id="home-sprint-filter"
              view="sprint"
              options={{ status: sprintOptions.status }}
              total={sprintRows.length}
              shown={visibleSprintRows.length}
              onChange={setSprintFilter}
            />
            <div data-testid="home-sprint">
              {!tickets && !data?.ticketsOk ? (
                <p className="home-empty" data-testid="home-sprint-unavailable">
                  Jira is unavailable. Refresh to try again.
                </p>
              ) : !tickets ? (
                <p className="home-empty" data-testid="home-sprint-unconfigured">
                  Jira is not configured — set JIRA_BASE_URL, JIRA_EMAIL and JIRA_TOKEN.
                </p>
              ) : !sprints.length ? (
                <p className="home-empty" data-testid="home-sprint-none">
                  No active sprint among your tickets
                </p>
              ) : (
                <>
                  {tickets.truncated && (
                    <p className="home-warn" data-testid="home-sprint-truncated">
                      Not all your tickets were fetched — sprint totals may be incomplete.
                    </p>
                  )}
                  {sprints.length > 1 && (
                    <Listbox
                      label="Sprint"
                      testId="home-sprint-select"
                      active={active}
                      options={sprints.map((sprint) => ({
                        value: sprintKeyOf(sprint),
                        label: `${sprint.name}${sprint.state && sprint.state !== 'active' ? ` · ${sprint.state}` : ''}`,
                        state: sprint.state,
                      }))}
                      value={sprintKeyOf(chosen)}
                      onChange={setSelectedSprintKey}
                    />
                  )}
                  {chosen && (
                    <HomeSprintCard
                      entry={progress}
                      range={[sprintDay(chosen.startDate), sprintDay(chosen.endDate)]
                        .filter(Boolean)
                        .join(' – ')}
                      countdown={sprintCountdown(chosen.endDate)}
                      expanded={expanded}
                      jiraBase={config.jiraBase}
                      listFilters={sprintFilter}
                      onToggle={toggleBand}
                    />
                  )}
                  {!visibleSprintRows.length && sprintRows.length > 0 && (
                    <p className="home-empty" data-testid="home-sprint-no-matches">
                      No matches. Try changing or clearing filters.
                    </p>
                  )}
                </>
              )}
            </div>
          </Card>
          <Card className="home-block home-block-services" data-testid="home-services-block">
            <h4 className="home-block-head">
              Services{' '}
              <a className="home-block-more" href="#/services" data-testid="home-services-more">
                all services →
              </a>
            </h4>
            <div className="svc-strip" data-testid="home-services">
              <ServiceStrip
                services={serviceSnapshot || []}
                controlPendingIds={controlPendingIds}
                onControl={runControl}
              />
            </div>
            <p className="feedback" data-testid="home-control-feedback" role="status">
              {controlFeedback}
            </p>
          </Card>
        </div>
        <HomeKpis tiles={tiles} />
        <Card className="home-block home-block-velocity" data-testid="home-velocity-block">
          <h3 className="home-block-head">
            Sprint history <span className="home-block-caption">Done story points by sprint</span>
          </h3>
          <div data-testid="home-velocity">
            {tickets ? <HomeVelocity series={donePointsBySprint(tickets)} /> : EMPTY}
          </div>
        </Card>
      </div>
    </section>
  );
}
