import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card } from './Primitives.jsx';
import { ServiceActionsMenu } from './ServiceActionsMenu.jsx';
import { ServiceCheckoutPicker } from './ServiceCheckoutPicker.jsx';
import { Terminal } from './Terminal.jsx';
import { useDashboardApi } from '../hooks/useDashboardApi.js';

// The bulk toolbar's Start all / Stop all / Restart all; a card's own actions are the Actions menu.
export function ServiceControlButtons({ disabled, onAction }) {
  return ['start', 'stop', 'restart'].map((action) => (
    <Button
      key={action}
      className={action}
      disabled={disabled}
      data-testid={`${action}-all`}
      onClick={() => onAction(action)}
    >
      {action[0].toUpperCase() + action.slice(1)} all
    </Button>
  ));
}

export function ServiceCard({
  service,
  config,
  locked,
  repo,
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
      <header className="service-header">
        <div className="service-header-row">
          <h2 data-testid={`card-title-${service.id}`}>{service.label}</h2>
          <div className="service-meta">
            <code data-testid={`card-dir-${service.id}`}>{service.dir}</code>
            {service.port && service.id !== 'legacy-ui' && (
              <a
                className="service-port"
                href={`http://127.0.0.1:${service.port}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                :{service.port}
              </a>
            )}
          </div>
          <span
            className="board-chip service-status"
            data-status={service.status}
            data-exit={
              service.status === 'exited' && service.exitCode != null && service.exitCode !== 0
                ? 'error'
                : undefined
            }
            data-testid={`status-${service.id}`}
          >
            {service.status}
            {service.exitCode != null && service.exitCode !== service.status
              ? ` (${service.exitCode})`
              : ''}
          </span>
        </div>
        <div className="service-header-row">
          <ServiceCheckoutPicker service={service} repo={repo} onFeedback={setControlState} />
          <ServiceActionsMenu serviceId={service.id} disabled={locked} onAction={command} />
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
      <Terminal
        id={service.id}
        getLog={api.getLog}
        defaultTail={config.defaultTailLines}
        follow={follow}
        active={active}
        onState={setLogState}
        expose={setTerminal}
      />
      <p
        className="feedback log-feedback"
        data-testid={`log-feedback-${service.id}`}
        role="status"
        data-state={logState.state}
      >
        {logState.message}
      </p>
    </Card>
  );
}
