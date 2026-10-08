import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, LoadingState } from '../components/Primitives.jsx';
import { Terminal } from '../components/Terminal.jsx';
import { useDashboardApi } from '../hooks/useDashboardApi.js';

function ServiceCard({
  service,
  config,
  locked,
  active,
  followAll,
  snapshot,
  onControl,
  onFollowChange,
}) {
  const api = useDashboardApi();
  const [follow, setFollow] = useState(followAll);
  useEffect(() => {
    setFollow(followAll);
  }, [followAll]);
  const [expanded, setExpanded] = useState(false);
  const [controlState, setControlState] = useState({ message: '', state: '' });
  const [logState, setLogState] = useState({ message: '', state: '' });
  const terminal = useRef(null);
  const setTerminal = useCallback((node) => {
    terminal.current = node;
  }, []);
  useEffect(() => {
    if (active && snapshot) terminal.current?.refresh();
  }, [active, snapshot]);
  const command = async (action) => {
    setControlState({ message: `${action} requested…`, state: 'pending' });
    try {
      await onControl(service.id, action);
      setControlState({
        message: 'Command accepted. Status follows the service feed.',
        state: 'success',
      });
    } catch (error) {
      setControlState({ message: error.message, state: 'error' });
    }
  };
  return (
    <Card className="service-card" id={`card-${service.id}`} data-testid={`card-${service.id}`}>
      <header>
        <div className="title">
          <h2 data-testid={`card-title-${service.id}`}>{service.label}</h2>
          {service.port && service.id !== 'legacy-ui' && (
            <a
              className="port"
              href={`http://127.0.0.1:${service.port}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              :{service.port}
            </a>
          )}
          <span
            className="pill status"
            data-status={service.status}
            data-testid={`status-${service.id}`}
          >
            {service.status}
            {service.exitCode != null && service.exitCode !== service.status
              ? ` (${service.exitCode})`
              : ''}
          </span>
        </div>
        <div className="controls">
          {['start', 'stop', 'restart'].map((action) => (
            <Button
              key={action}
              className={action}
              disabled={locked}
              data-testid={`${action}-${service.id}`}
              data-service={service.id}
              data-action={action}
              onClick={() => command(action)}
            >
              {action[0].toUpperCase() + action.slice(1)}
            </Button>
          ))}
        </div>
      </header>
      <p
        className="feedback control-feedback"
        data-testid={`control-feedback-${service.id}`}
        role="status"
        data-state={controlState.state}
      >
        {controlState.message}
      </p>
      <div className="meta">
        <code data-testid={`card-dir-${service.id}`}>{service.dir}</code>
      </div>
      <div className="log-tools">
        <span className="log-label">Output</span>
        <Button
          className="subtle"
          data-testid={`follow-${service.id}`}
          aria-pressed={follow}
          onClick={() => {
            const next = !follow;
            setFollow(next);
            onFollowChange(service.id, next);
          }}
        >
          Follow
        </Button>
        <Button
          className="subtle expand"
          data-testid={`expand-${service.id}`}
          onClick={() => {
            setExpanded((value) => !value);
            terminal.current?.toggleLines();
          }}
        >
          {expanded ? `Tail (${config.defaultTailLines})` : 'Full retained log'}
        </Button>
        <Button
          className="subtle"
          data-testid={`log-retry-${service.id}`}
          onClick={() => terminal.current?.refresh()}
        >
          Refresh log
        </Button>
      </div>
      <p
        className="feedback log-feedback"
        data-testid={`log-feedback-${service.id}`}
        role="status"
        data-state={logState.state}
      >
        {logState.message}
      </p>
      <Terminal
        id={service.id}
        getLog={api.getLog}
        defaultTail={config.defaultTailLines}
        follow={follow}
        active={active}
        onState={setLogState}
        expose={setTerminal}
      />
    </Card>
  );
}

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
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await api.getServices();
      setServices(result);
    } catch (cause) {
      setError(`Services unavailable: ${cause.message}`);
    } finally {
      setLoading(false);
    }
  }, [api]);
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
  return (
    <section
      id="panel-services"
      className="panel"
      data-testid="panel-services"
      hidden={!active}
      onClick={(event) => {
        const button = event.target.closest('[data-testid^="follow-"]');
        if (!button) return;
        const id = button.dataset.testid.slice('follow-'.length);
        const prior = followStates[id] ?? true;
        setFollowStates((states) => ({ ...states, [id]: !prior }));
        setFollowVersion((version) => version + 1);
      }}
    >
      <header className="page-intro">
        <p className="eyebrow">Local runtime</p>
        <h2>Services & logs</h2>
      </header>
      <div className="service-toolbar">
        <div className="bulk-controls">
          {['start', 'stop', 'restart'].map((action) => (
            <Button
              key={action}
              className={action}
              data-testid={`${action}-all`}
              disabled={loading || !services.length || bulkPending || pending.size > 0}
              onClick={() => controlAll(action)}
            >
              {action[0].toUpperCase() + action.slice(1)} all
            </Button>
          ))}
        </div>
        <span className="tail-hint">
          Last {Number(config.defaultTailLines)} lines · full retained log available
        </span>
        <Button
          className="subtle"
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
      </div>
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
      <div className="grid" data-testid="service-grid" data-follow-version={followVersion}>
        {loading && !services.length ? (
          <LoadingState label="Loading services…" />
        ) : error ? null : current.length ? (
          current.map((service) => (
            <ServiceCard
              key={service.id}
              service={service}
              config={config}
              active={active}
              snapshot={snapshots}
              followAll={followStates[service.id] ?? true}
              locked={bulkPending || pending.has(service.id)}
              onControl={control}
              onFollowChange={(id, value) =>
                setFollowStates((states) => ({ ...states, [id]: value }))
              }
            />
          ))
        ) : (
          <p>{services.length === 0 && !loading ? 'No services configured.' : ''}</p>
        )}
      </div>
    </section>
  );
}
