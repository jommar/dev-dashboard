import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, LoadingState } from '../components/Primitives.jsx';
import { useDashboardApi } from '../hooks/useDashboardApi.js';

function normalizeSettings(source) {
  const value = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  const github = { ...value.github };
  github.repos = Array.isArray(github.repos)
    ? github.repos.filter((repo) => typeof repo === 'string')
    : typeof github.repos === 'string'
      ? [github.repos]
      : [''];
  if (!github.repos.length) github.repos = [''];
  const local = { ...value.local };
  const rows = Array.isArray(local.services)
    ? local.services
    : local.services && typeof local.services === 'object'
      ? [local.services]
      : [];
  local.services = rows.map((service) => {
    const normalized =
      service && typeof service === 'object' && !Array.isArray(service) ? { ...service } : {};
    if (Array.isArray(normalized.command)) normalized.command = JSON.stringify(normalized.command);
    return normalized;
  });
  return {
    ...value,
    github: { ...github },
    jira: { ...value.jira },
    local,
    credentials: { github: {}, jira: {}, ...value.credentials },
    setup: value.setup || {},
  };
}

function fieldErrors(error) {
  return (error || []).map((entry) => ({
    field:
      entry.field === 'credentials.github'
        ? 'credentials.githubToken'
        : entry.field === 'credentials.jira'
          ? 'credentials.jiraToken'
          : entry.field,
    message: entry.message || 'Check this setting',
  }));
}

export function SettingsPanel({ config, active, enabled = true }) {
  const api = useDashboardApi();
  const setup = config.setup;
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [errors, setErrors] = useState([]);
  const [connectionErrors, setConnectionErrors] = useState([]);
  const [banner, setBanner] = useState('');
  const failedLoad = useRef(false);
  const load = useCallback(async () => {
    if (load.pending) return;
    load.pending = true;
    failedLoad.current = false;
    setLoading(true);
    setBanner('');
    try {
      setSettings(normalizeSettings(await api.getSettings()));
    } catch {
      failedLoad.current = true;
      setSettings(null);
      setBanner('Could not load settings. Check the connection and retry.');
    } finally {
      load.pending = false;
      setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    if (active && enabled && !settings && !loading && !failedLoad.current) load();
  }, [active, enabled, settings, loading, load]);
  const update = (path, value) =>
    setSettings((current) => {
      const next = structuredClone(current);
      const keys = path.split('.');
      let target = next;
      for (const key of keys.slice(0, -1)) {
        if (Array.isArray(target)) target = target[Number(key)];
        else target = target[key] ??= {};
      }
      target[keys.at(-1)] = value;
      return next;
    });
  const updateAt = (path, index, key, value) =>
    setSettings((current) => {
      const next = structuredClone(current);
      next.local.services[index][key] = value;
      return next;
    });
  const changeRepos = (next) =>
    setSettings((current) => ({
      ...current,
      github: { ...current.github, repos: next.length ? next : [''] },
    }));
  const changeServices = (next) =>
    setSettings((current) => ({ ...current, local: { ...current.local, services: next } }));
  const submit = async (validate = false) => {
    if (!settings || busy) return;
    setBusy(true);
    setErrors([]);
    setNotice(validate ? 'Checking saved connections…' : 'Validating and saving settings…');
    try {
      let candidate = settings;
      if (!validate) {
        const localServices = settings.local.services.map((service, index) => {
          let command;
          try {
            command = JSON.parse(service.command);
          } catch {
            throw {
              errors: [
                {
                  field: `local.services.${index}.command`,
                  message: 'Enter a JSON array of command arguments',
                },
              ],
            };
          }
          if (
            !Array.isArray(command) ||
            !command.length ||
            command.some((arg) => typeof arg !== 'string' || !arg.trim())
          )
            throw {
              errors: [
                {
                  field: `local.services.${index}.command`,
                  message: 'Command must be a nonempty array of nonblank strings',
                },
              ],
            };
          return {
            ...service,
            command,
            port: service.port === '' || service.port == null ? null : Number(service.port),
          };
        });
        const credentials = {};
        for (const token of ['githubToken', 'jiraToken'])
          if (settings.credentials[token]?.trim()) credentials[token] = settings.credentials[token];
        candidate = {
          schemaVersion: 1,
          expectedRevision: settings.revision,
          github: {
            ...settings.github,
            repos: settings.github.repos,
            maxResults: Number(settings.github.maxResults),
          },
          jira: settings.jira,
          local: { ...settings.local, services: localServices },
          minPrApprover: Number(settings.minPrApprover),
          ...(Object.keys(credentials).length ? { credentials } : {}),
        };
      }
      const result = validate
        ? await api.validateSettings(settings.revision)
        : await api.saveSettings(candidate);
      if (!validate) {
        location.reload();
        return;
      }
      const status = result.setup || result;
      const revision = result.revision ?? status.revision;
      if (Number.isSafeInteger(revision)) setSettings((current) => ({ ...current, revision }));
      if (typeof status.ready === 'boolean' && status.ready !== setup.ready) {
        history.replaceState(null, '', '#/settings');
        location.reload();
        return;
      }
      const state = status.connection?.state;
      setNotice(
        state === 'legacy-unverified'
          ? 'Migrated; connection not yet verified. Check saved connections to verify access.'
          : state === 'degraded'
            ? 'Connection degraded. Your previously accepted settings remain available.'
            : status.ready
              ? 'Setup complete.'
              : 'All integrations are required. Save settings to validate access and finish setup.',
      );
      const validationErrors = [...(status.errors || []), ...(status.connection?.errors || [])];
      setErrors(fieldErrors(status.errors || []));
      setConnectionErrors(fieldErrors(status.connection?.errors || []));
      if (!validationErrors.length && state !== 'degraded')
        setNotice('Saved connection checks completed. Unsaved edits have been retained.');
      setBanner('');
    } catch (error) {
      setNotice('Your edits have been retained.');
      setErrors(fieldErrors(error.errors));
      setConnectionErrors([]);
      if (error.code === 'REVISION_CONFLICT')
        setBanner(
          'Settings changed elsewhere. Your edits are retained; reload to review the latest revision before saving again.',
        );
      else if (!error.errors?.length)
        setBanner(
          error.message || 'Could not save settings. Check the highlighted fields and retry.',
        );
    } finally {
      setBusy(false);
    }
  };
  const input = (
    path,
    label,
    value,
    { type = 'text', hint = '', placeholder = '', readOnly = false, onChange } = {},
  ) => {
    const id = `settings-${path.replaceAll('.', '-')}`;
    const error = errors.find((item) => item.field === path);
    return (
      <div className="settings-field" key={path}>
        <label htmlFor={id}>{label}</label>
        <input
          id={id}
          data-field={path}
          type={type}
          value={value ?? ''}
          readOnly={readOnly}
          placeholder={placeholder}
          autoComplete={type === 'password' ? 'new-password' : 'off'}
          aria-invalid={!!error}
          aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`}
          disabled={busy}
          onChange={(event) => (onChange || ((next) => update(path, next)))(event.target.value)}
        />
        <small id={`${id}-hint`}>{hint}</small>
        {error && (
          <small className="settings-field-error" id={`${id}-error`}>
            {error.message}
          </small>
        )}
      </div>
    );
  };
  const credentialHint = (name) =>
    settings.credentials[name]?.present
      ? `Saved token detected${settings.credentials[name].source === 'file' ? ' (private file)' : ''}. This field only replaces it. Leave blank to keep the saved token.`
      : 'No saved token detected. Enter a token to finish setup. It will be stored privately outside the project.';
  const focusError = (field) => {
    setBanner('Check the following settings:');
    document.getElementById(`settings-${field.replaceAll('.', '-')}`)?.focus();
  };
  const focusFirstError = () => {
    const first = errors[0];
    if (first) document.getElementById(`settings-${first.field.replaceAll('.', '-')}`)?.focus();
  };

  return (
    <section
      id="panel-settings"
      className="panel"
      data-testid="panel-settings"
      hidden={!active || !enabled}
      aria-busy={busy}
    >
      <header className="page-intro">
        <p className="eyebrow">Workspace configuration</p>
        <h2>Settings</h2>
        <p>
          {setup.ready
            ? 'Edit integrations and local services. Saving reloads your workspace.'
            : 'Finish GitHub, Jira and local service setup to open your workspace.'}
        </p>
      </header>
      <div className="settings-notice" role="status">
        {notice ||
          (setup.connection?.state === 'legacy-unverified'
            ? 'Migrated; connection not yet verified. Check saved connections to verify access.'
            : setup.connection?.state === 'degraded'
              ? 'Connection degraded. Your previously accepted settings remain available.'
              : setup.ready
                ? 'Setup complete.'
                : 'All integrations are required. Save settings to validate access and finish setup.')}
      </div>
      {(banner ||
        errors.length > 0 ||
        connectionErrors.length > 0 ||
        setup.errors?.length > 0 ||
        setup.connection?.errors?.length > 0) && (
        <div className="settings-errors" role="alert" tabIndex={-1}>
          <p>{banner || 'Check the following settings:'}</p>
          {(errors.length ? errors : fieldErrors(setup.errors)).length > 0 && (
            <ul>
              {(errors.length ? errors : fieldErrors(setup.errors)).map((error, index) => (
                <li key={`${error.field}-${index}`}>
                  <a
                    href={`#settings-${error.field.replaceAll('.', '-')}`}
                    onClick={(event) => {
                      event.preventDefault();
                      focusError(error.field);
                    }}
                  >
                    {error.message}
                  </a>
                </li>
              ))}
            </ul>
          )}
          {[...fieldErrors(setup.connection?.errors), ...connectionErrors].map((error, index) => (
            <p key={index}>{error.message}</p>
          ))}
        </div>
      )}
      {loading && !settings ? (
        <LoadingState label="Loading settings…" />
      ) : banner && !settings ? (
        <>
          <p role="alert">{banner}</p>
          <Button onClick={load}>Try again</Button>
        </>
      ) : (
        settings && (
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <div
              className="settings-groups"
              onChange={(event) => {
                const field = event.target.dataset.field;
                if (field) setBanner('');
              }}
            >
              <Card component="fieldset" className="settings-group">
                <legend>GitHub</legend>
                <p>Watch repositories under one organization.</p>
                {input('github.org', 'GitHub organization', settings.github.org)}
                <div className="settings-repositories">
                  {settings.github.repos.map((repo, index) => (
                    <div className="settings-repository" key={index}>
                      {input(`github.repos.${index}`, `Repository ${index + 1}`, repo, {
                        onChange: (value) =>
                          changeRepos(
                            settings.github.repos.map((item, i) => (i === index ? value : item)),
                          ),
                      })}
                      <Button
                        type="button"
                        disabled={busy}
                        aria-label={`Remove repository ${index + 1}`}
                        onClick={() =>
                          changeRepos(settings.github.repos.filter((_, i) => i !== index))
                        }
                      >
                        Remove
                      </Button>
                    </div>
                  ))}
                </div>
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => changeRepos([...settings.github.repos, ''])}
                >
                  Add repository
                </Button>
                {input(
                  'credentials.githubToken',
                  'GitHub token',
                  settings.credentials.githubToken || '',
                  {
                    type: 'password',
                    hint: credentialHint('github'),
                    placeholder: settings.credentials.github?.present
                      ? 'Saved token — leave blank to keep'
                      : 'No saved token — enter a token',
                  },
                )}
              </Card>
              <Card component="fieldset" className="settings-group">
                <legend>Jira</legend>
                <p>Connect your Jira account and issue fields.</p>
                {input('jira.baseUrl', 'Jira base URL', settings.jira.baseUrl, { type: 'url' })}
                {input('jira.email', 'Jira email', settings.jira.email, { type: 'email' })}
                {input(
                  'credentials.jiraToken',
                  'Jira token',
                  settings.credentials.jiraToken || '',
                  {
                    type: 'password',
                    hint: credentialHint('jira'),
                    placeholder: settings.credentials.jira?.present
                      ? 'Saved token — leave blank to keep'
                      : 'No saved token — enter a token',
                  },
                )}
              </Card>
              <Card component="fieldset" className="settings-group">
                <legend>Advanced</legend>
                {input(
                  'github.api',
                  'GitHub API URL',
                  settings.github.api || 'https://api.github.com',
                  { readOnly: true, hint: 'Public GitHub API.' },
                )}
                {input('github.maxResults', 'GitHub maximum results', settings.github.maxResults, {
                  type: 'number',
                })}
                {input('jira.sprintField', 'Jira sprint field', settings.jira.sprintField, {
                  hint: 'Field ID in customfield_<digits> format.',
                })}
                {input('jira.pointsField', 'Jira points field', settings.jira.pointsField, {
                  hint: 'Field ID in customfield_<digits> format.',
                })}
                {input('minPrApprover', 'Minimum PR approvers', settings.minPrApprover, {
                  type: 'number',
                })}
              </Card>
            </div>
            <Card component="fieldset" className="settings-group settings-local">
              <legend>Local services</legend>
              <p>
                Saving preserves unchanged running services. Changes to running service definitions
                may conflict; setup never starts or stops services.
              </p>
              {input('local.root', 'Local root', settings.local.root, {
                hint: 'Absolute workspace directory.',
              })}
              <div className="settings-services">
                {settings.local.services.map((service, index) => (
                  <Card component="fieldset" className="settings-service" key={index}>
                    <legend>Service {index + 1}</legend>
                    {input(`local.services.${index}.id`, `Service ${index + 1} ID`, service.id, {
                      onChange: (value) => updateAt('local.services', index, 'id', value),
                    })}
                    {input(
                      `local.services.${index}.label`,
                      `Service ${index + 1} label`,
                      service.label,
                      { onChange: (value) => updateAt('local.services', index, 'label', value) },
                    )}
                    {input(
                      `local.services.${index}.dir`,
                      `Service ${index + 1} directory`,
                      service.dir,
                      {
                        hint: 'Relative to local root, or an absolute directory.',
                        onChange: (value) => updateAt('local.services', index, 'dir', value),
                      },
                    )}
                    {input(
                      `local.services.${index}.command`,
                      `Service ${index + 1} command`,
                      typeof service.command === 'string'
                        ? service.command
                        : JSON.stringify(service.command),
                      {
                        hint: 'JSON argument array, for example ["npm","run","dev"]. No shell expansion.',
                        onChange: (value) => updateAt('local.services', index, 'command', value),
                      },
                    )}
                    {input(
                      `local.services.${index}.port`,
                      `Service ${index + 1} port`,
                      service.port,
                      {
                        type: 'number',
                        hint: 'Leave blank for no port; otherwise 1–65535.',
                        onChange: (value) => updateAt('local.services', index, 'port', value),
                      },
                    )}
                    <Button
                      type="button"
                      disabled={busy}
                      aria-label={`Remove service ${index + 1}`}
                      onClick={() =>
                        changeServices(settings.local.services.filter((_, i) => i !== index))
                      }
                    >
                      Remove
                    </Button>
                  </Card>
                ))}
              </div>
              <Button
                type="button"
                disabled={busy}
                onClick={() =>
                  changeServices([
                    ...settings.local.services,
                    { id: '', label: '', dir: '', command: ['npm', 'run', 'dev'], port: null },
                  ])
                }
              >
                Add service
              </Button>
            </Card>
            <div className="settings-actions">
              <Button type="submit" className="settings-save" disabled={busy}>
                Save settings
              </Button>
              <Button type="button" disabled={busy} onClick={() => submit(true)}>
                Check saved connections
              </Button>
              <p>Connection checks use saved settings. Save to validate your edits.</p>
            </div>
            {errors.length > 0 && (
              <Button className="sr-only" onClick={focusFirstError}>
                Focus first error
              </Button>
            )}
          </form>
        )
      )}
    </section>
  );
}
