import { useState } from 'react';
import { Button } from '../Primitives.jsx';
import { useDashboardApi } from '../../hooks/useDashboardApi.js';

const sessionOptionLabel = ({ sessionId, name, state, attached }) =>
  [name || sessionId, state, attached ? 'attached' : null].filter(Boolean).join(' · ');

export function AttachForm({ links, pickerSessions, disabled, onSettled }) {
  const api = useDashboardApi();
  const [chosenLink, setChosenLink] = useState('');
  const [pickedSessionId, setPickedSessionId] = useState('');
  const [typedSessionId, setTypedSessionId] = useState('');

  const link = links.some((entry) => entry.link === chosenLink) ? chosenLink : '';
  // A typed id wins over the picker: it is the way in when the picker is empty.
  const sessionId = typedSessionId.trim() || pickedSessionId;

  const attach = async () => {
    const response = await api.attachSlackWatchSession(link, sessionId);
    if (response.ok) setTypedSessionId('');
    await onSettled(response, { refreshPicker: true });
  };

  return (
    <div className="slack-watch-attach" data-testid="slack-watch-attach-form">
      <label className="slack-watch-field">
        <span>Link</span>
        <select
          data-testid="slack-watch-attach-link"
          value={link}
          onChange={(event) => setChosenLink(event.target.value)}
        >
          <option value="">Choose a link</option>
          {links.map((entry) => (
            <option key={entry.key} value={entry.link}>
              {entry.link}
            </option>
          ))}
        </select>
      </label>
      <label className="slack-watch-field">
        <span>Session</span>
        <select
          data-testid="slack-watch-picker"
          value={pickedSessionId}
          onChange={(event) => setPickedSessionId(event.target.value)}
        >
          <option value="">Choose a session</option>
          {pickerSessions.map((session) => (
            <option key={session.sessionId} value={session.sessionId}>
              {sessionOptionLabel(session)}
            </option>
          ))}
        </select>
      </label>
      <label className="slack-watch-field">
        <span>Or paste a session id</span>
        <input
          type="text"
          data-testid="slack-watch-attach-session-id"
          value={typedSessionId}
          onChange={(event) => setTypedSessionId(event.target.value)}
        />
      </label>
      <Button
        data-testid="slack-watch-attach"
        disabled={disabled || !link || !sessionId}
        onClick={attach}
      >
        Attach
      </Button>
    </div>
  );
}
