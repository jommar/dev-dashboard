import { useState } from 'react';
import { Button } from '../Primitives.jsx';
import { useDashboardApi } from '../../hooks/useDashboardApi.js';

const FIELD_BY_SERVER_FIELD = {
  'slackWatch.intervalSeconds': 'interval',
  'slackWatch.noticeTemplate': 'template',
};

// Mounted only after the first list response, so the stored settings seed the
// form once and a later poll can never overwrite what is being typed.
export function WatchSettingsForm({ settings, onSettled }) {
  const api = useDashboardApi();
  const [intervalSeconds, setIntervalSeconds] = useState(String(settings.intervalSeconds));
  const [template, setTemplate] = useState(settings.noticeTemplate);
  const [fieldErrors, setFieldErrors] = useState({});

  const save = async () => {
    setFieldErrors({});
    const response = await api.saveSlackWatchSettings({
      intervalSeconds: Number(intervalSeconds),
      noticeTemplate: template,
    });
    const nextErrors = {};
    for (const { field, message } of response.errors) {
      const known = FIELD_BY_SERVER_FIELD[field];
      if (known) nextErrors[known] = message;
    }
    setFieldErrors(nextErrors);
    // A refusal that names a field is answered inline; every other outcome goes
    // to the card, which reloads and shows a whole-call failure.
    if (Object.keys(nextErrors).length === 0) await onSettled(response);
  };

  return (
    <div className="slack-watch-settings" data-testid="slack-watch-settings">
      <label className="slack-watch-field">
        <span>Interval (seconds)</span>
        <input
          type="number"
          data-testid="slack-watch-interval"
          aria-invalid={!!fieldErrors.interval}
          value={intervalSeconds}
          onChange={(event) => setIntervalSeconds(event.target.value)}
        />
      </label>
      {fieldErrors.interval && (
        <p className="slack-watch-error" role="alert" data-testid="slack-watch-interval-error">
          {fieldErrors.interval}
        </p>
      )}
      <label className="slack-watch-field">
        <span>Notice template</span>
        <textarea
          rows={2}
          data-testid="slack-watch-template"
          aria-invalid={!!fieldErrors.template}
          value={template}
          onChange={(event) => setTemplate(event.target.value)}
        />
      </label>
      {!template.includes('{link}') && (
        <p className="slack-watch-warning" data-testid="slack-watch-template-warning">
          The notice has no {'{link}'}, so a session will not know which thread changed.
        </p>
      )}
      {fieldErrors.template && (
        <p className="slack-watch-error" role="alert" data-testid="slack-watch-template-error">
          {fieldErrors.template}
        </p>
      )}
      <Button data-testid="slack-watch-settings-save" onClick={save}>
        Save
      </Button>
    </div>
  );
}
