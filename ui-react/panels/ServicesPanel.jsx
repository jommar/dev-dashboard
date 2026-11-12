import { useCallback, useEffect, useMemo, useState } from 'react';
import { BoardPanel, BoardSection, BoardState } from '../components/BoardShell.jsx';
import { Button } from '../components/Primitives.jsx';
import { ServiceCard, ServiceControlButtons } from '../components/ServiceCard.jsx';
import { useDashboardApi } from '../hooks/useDashboardApi.js';

export function ServicesPanel({ config, active, services: snapshots = [] }) {
  const api = useDashboardApi();
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [bulkPending, setBulkPending] = useState(false);
  const [pending, setPending] = useState(() => new Set());
  const [bulkFeedback, setBulkFeedback] = useState({ message: '', state: '' });
  const [followStates, setFollowStates] = useState({});
  const [followVersion, setFollowVersion] = useState(0);
  const [listings, setListings] = useState({});
  useEffect(() => {
    const refreshLocks = () =>
      setPending((ids) => {
        const next = new Set([...ids].filter((id) => api.isControlPending(id)));
        for (const service of services) if (api.isControlPending(service.id)) next.add(service.id);
        return next;
      });
    const unsubscribe = api.onControlPending((id, isPending) =>
      setPending((current) => {
        const next = new Set(current);
        if (isPending) next.add(id);
        else next.delete(id);
        return next;
      }),
    );
    refreshLocks();
    return unsubscribe;
  }, [api, services]);
  useEffect(() => {
    if (active && !services.length) load();
  }, [active]);
  // A repo's worktrees are read when the services load and when a picker gains focus, never on a timer.
  const listCheckouts = useCallback(
    async (dir) => {
      const { worktrees } = await api.getWorktrees(dir);
      setListings((listed) => ({ ...listed, [dir]: worktrees }));
    },
    [api],
  );
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await api.getServices();
      setServices(result);
      for (const dir of new Set(result.map((service) => service.dir)))
        listCheckouts(dir).catch(() => {});
    } catch (cause) {
      setError(`Services unavailable: ${cause.message}`);
    } finally {
      setLoading(false);
    }
  }, [api, listCheckouts]);
  const current = useMemo(
    () =>
      services.map(
        (service) => snapshots.find((snapshot) => snapshot.id === service.id) || service,
      ),
    [services, snapshots],
  );
  const control = async (id, action) => {
    await api.control(id, action);
  };
  // The picker's view of a service's repo: every service sharing its dir switches and locks together.
  const repoOf = (service) => {
    const members = current.filter(({ dir }) => dir === service.dir);
    const ids = members.map(({ id }) => id);
    return {
      worktrees: listings[service.dir],
      services: members,
      disabled: bulkPending || ids.some((id) => pending.has(id)),
      list: () => listCheckouts(service.dir),
      switchTo: (path, restart) => api.setCheckout(service.dir, path, { restart, ids }),
    };
  };
  const controlAll = async (action) => {
    if (bulkPending || pending.size) return;
    setBulkPending(true);
    setBulkFeedback({ message: `${action} requested for all services…`, state: 'pending' });
    const results = await Promise.all(
      current.map(async (service) => {
        try {
          await control(service.id, action);
          return null;
        } catch (error) {
          return `${service.label}: ${error.message}`;
        }
      }),
    );
    const failures = results.filter(Boolean);
    setBulkFeedback({
      message: failures.length
        ? failures.join(' · ')
        : 'All commands accepted. Status follows the service feed.',
      state: failures.length ? 'error' : 'success',
    });
    setBulkPending(false);
  };
  const currentFollow = current.map((service) => followStates[service.id] ?? true);
  const followMixed = currentFollow.some(Boolean) && !currentFollow.every(Boolean);
  const statusCounts = current.reduce((counts, service) => {
    counts[service.status] = (counts[service.status] || 0) + 1;
    return counts;
  }, {});
  const statusSummary = Object.entries(statusCounts)
    .map(([status, count]) => `${count} ${status}`)
    .join(' · ');
  return (
    <BoardPanel id="services" active={active} busy={loading}>
      <BoardSection
        name="services"
        title="Services"
        sub={`Local runtime · Last ${Number(config.defaultTailLines)} lines · full retained log available`}
        meta={statusSummary}
        controls={
          <>
            <div className="service-bulk-controls">
              <ServiceControlButtons
                disabled={loading || !services.length || bulkPending || pending.size > 0}
                onAction={controlAll}
              />
            </div>
            <Button
              className="subtle service-autoscroll"
              data-testid="autoscroll-toggle"
              aria-pressed={followMixed ? 'mixed' : currentFollow.every(Boolean)}
              onClick={() => {
                const next = !currentFollow.every(Boolean);
                setFollowStates(Object.fromEntries(current.map((service) => [service.id, next])));
                setFollowVersion((version) => version + 1);
              }}
            >
              Auto-scroll: {followMixed ? 'Mixed' : currentFollow.every(Boolean) ? 'On' : 'Off'}
            </Button>
          </>
        }
        notes={
          <>
            <p
              className="feedback"
              data-testid="bulk-feedback"
              role="status"
              data-state={bulkFeedback.state}
            >
              {bulkFeedback.message}
            </p>
            <p
              className="feedback"
              data-testid="services-feedback"
              role="status"
              data-state={error ? 'error' : ''}
            >
              {error}
            </p>
            <Button data-testid="services-retry" hidden={!error} onClick={load}>
              Retry services
            </Button>
          </>
        }
      >
        {loading && !services.length ? (
          <BoardState kind="loading" label="Loading services…" />
        ) : error ? (
          <BoardState kind="error">
            Service discovery failed. Retry services to reconnect.
          </BoardState>
        ) : current.length ? (
          <div className="board-pane services-pane">
            <div
              className="grid service-grid"
              data-testid="service-grid"
              data-follow-version={followVersion}
            >
              {current.map((service) => (
                <ServiceCard
                  key={service.id}
                  service={service}
                  config={config}
                  active={active}
                  snapshot={snapshots}
                  followAll={followStates[service.id] ?? true}
                  locked={bulkPending || pending.has(service.id)}
                  repo={repoOf(service)}
                  onControl={control}
                  onFollowChange={(id, value) => {
                    setFollowStates((states) => ({ ...states, [id]: value }));
                    setFollowVersion((version) => version + 1);
                  }}
                />
              ))}
            </div>
          </div>
        ) : (
          <BoardState>No services configured.</BoardState>
        )}
      </BoardSection>
    </BoardPanel>
  );
}
