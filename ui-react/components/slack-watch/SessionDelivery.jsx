import { Button } from '../Primitives.jsx';
import { RelativeTime } from './RelativeTime.jsx';

const NO_DELIVERY_LABEL = 'no delivery yet';

export function SessionDelivery({ linkKey, sessionId, name, delivery, onDetach }) {
  const idSuffix = `${linkKey}-${sessionId}`;
  return (
    <li className="slack-watch-session" data-testid={`slack-watch-session-${idSuffix}`}>
      <span className="slack-watch-session-identity">
        <code className="slack-watch-session-id">{sessionId}</code>
        {typeof name === 'string' && name.trim() && (
          <span
            className="slack-watch-session-name"
            data-testid={`slack-watch-session-name-${idSuffix}`}
          >
            {name}
          </span>
        )}
      </span>
      <span
        className="slack-watch-delivery"
        data-status={delivery?.status ?? 'none'}
        data-testid={`slack-watch-session-status-${idSuffix}`}
      >
        {delivery ? delivery.status : NO_DELIVERY_LABEL}
      </span>
      {delivery?.at && (
        <RelativeTime
          iso={delivery.at}
          className="slack-watch-session-time"
          data-testid={`slack-watch-session-time-${idSuffix}`}
        />
      )}
      {delivery?.reason && (
        <span
          className="slack-watch-session-reason"
          data-status={delivery.status}
          data-testid={`slack-watch-session-reason-${idSuffix}`}
        >
          {delivery.reason}
        </span>
      )}
      <Button data-testid={`slack-watch-detach-${idSuffix}`} onClick={onDetach}>
        Detach
      </Button>
    </li>
  );
}
