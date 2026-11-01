import { Button } from '../Primitives.jsx';
import { Countdown } from './Countdown.jsx';
import { RelativeTime } from './RelativeTime.jsx';

const NO_DELIVERY_LABEL = 'no delivery yet';

export function SessionDelivery({ linkKey, sessionId, delivery, onDetach, onDue }) {
  const idSuffix = `${linkKey}-${sessionId}`;
  return (
    <li className="slack-watch-session" data-testid={`slack-watch-session-${idSuffix}`}>
      <code className="slack-watch-session-id">{sessionId}</code>
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
      {delivery?.step != null && (
        <span className="slack-watch-step" data-testid={`slack-watch-step-${idSuffix}`}>
          {`step ${delivery.step} of ${delivery.steps}`}
        </span>
      )}
      {delivery?.nextStepAt && (
        <Countdown
          className="slack-watch-countdown"
          iso={delivery.nextStepAt}
          label="next step in"
          onDue={onDue}
        />
      )}
      <Button data-testid={`slack-watch-detach-${idSuffix}`} onClick={onDetach}>
        Detach
      </Button>
    </li>
  );
}
