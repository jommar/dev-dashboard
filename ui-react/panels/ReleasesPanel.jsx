import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, LoadingState } from '../components/Primitives.jsx';
import { ReleaseGroups } from '../components/ReleaseCards.jsx';
import { useDashboardApi } from '../hooks/useDashboardApi.js';
import {
  clearStoredSelection,
  groupByMergeState,
  readStoredSelection,
  storeSelection,
  summarizeRelease,
} from '../../ui/releases-data.js';

const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const INSTANCE_MISMATCH_ADVICE =
  'PR lookup returned nothing for tickets Jira says have PRs — check the Jira GitHub integration. Refresh will not fix this.';
function storage() {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

export function ReleasesPanel({ config, active, view = 'cards', onViewChange }) {
  const api = useDashboardApi();
  const [data, setData] = useState(null);
  const [version, setVersion] = useState(null);
  const [scopeAll, setScopeAll] = useState(false);
  const [meta, setMeta] = useState('loading…');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(false);
  const [lag, setLag] = useState(false);
  const [unavailable, setUnavailable] = useState('');
  const [restored, setRestored] = useState(false);
  const [, setRequestId] = useState(0);
  const [shown, setShown] = useState({ version: null, scopeAll: false });
  const [successAt, setSuccessAt] = useState(0);
  const load = useCallback(
    async ({
      refresh = false,
      scope = scopeAll ? 'all' : 'mine',
      selectedVersion = version,
    } = {}) => {
      const current = ++currentRequest.current;
      setRequestId(current);
      setBusy(true);
      setFailure(false);
      setMeta(data ? (refresh ? 'Refreshing…' : 'Loading…') : 'loading…');
      try {
        const result = await api.getReleases({ version: selectedVersion, scope, refresh });
        if (current !== currentRequest.current) return;
        setData(result);
        setVersion(result.version?.id ?? null);
        setScopeAll(result.scope === 'all');
        setShown({ version: result.version?.id ?? null, scopeAll: result.scope === 'all' });
        setMeta(
          `${plural(summarizeRelease(result.tickets).tickets.total, 'ticket')} · ${summarizeRelease(result.tickets).prs.merged} of ${plural(summarizeRelease(result.tickets).prs.total, 'PR')} merged · updated ${new Date().toLocaleTimeString()}`,
        );
        setSuccessAt(Date.now());
        setFailure(false);
        setLag(true);
        const unavailableCount = result.tickets.filter(
          ({ prsStatus }) => prsStatus === 'unavailable',
        ).length;
        setUnavailable(
          !unavailableCount
            ? ''
            : result.tickets.some(({ prsError }) => prsError === 'instance-mismatch')
              ? INSTANCE_MISMATCH_ADVICE
              : `${plural(unavailableCount, 'ticket')} with PRs unavailable — Jira could not return their linked PRs. Use Refresh to retry.`,
        );
      } catch (error) {
        if (current !== currentRequest.current) return;
        if (error.status === 400 && restored) {
          clearStoredSelection(storage());
          setVersion(null);
          return load({ refresh, selectedVersion: null, scope });
        }
        setFailure(true);
        if (data) {
          setVersion(shown.version);
          setScopeAll(shown.scopeAll);
          setMeta(
            `Refresh failed — showing last update ${new Date(successAt).toLocaleTimeString()}`,
          );
        } else setMeta('error');
      } finally {
        if (current === currentRequest.current) setBusy(false);
      }
    },
    [api, data, restored, scopeAll, shown, successAt, version],
  );
  const currentRequest = useRef(0);
  useEffect(() => {
    if (active && !restored) {
      setVersion(readStoredSelection(storage()));
      setRestored(true);
    }
  }, [active, restored]);
  useEffect(() => {
    if (active && restored && !data && !busy) load();
  }, [active, restored]);
  const versionChange = (event) => {
    const next = event.target.value;
    setVersion(next);
    storeSelection(storage(), next);
    load({ selectedVersion: next });
  };
  const groups = data ? groupByMergeState(data.tickets) : [];
  return (
    <section
      id="panel-releases"
      className="panel"
      data-testid="panel-releases"
      hidden={!active}
      aria-busy={busy}
    >
      <header className="page-intro">
        <p className="eyebrow">Fix versions</p>
        <h2>Releases</h2>
        <p>
          Every ticket in a fix version with its GitHub PRs, and whether the work reached
          ops/development.
        </p>
      </header>
      <Card className="releases-section" data-testid="releases-section">
        <div className="pr-open-heading" data-testid="releases-title">
          <span className="section-label">Release</span>
          <select
            className="releases-version"
            data-testid="releases-version"
            aria-label="Fix version"
            disabled={!data?.versions.length}
            value={version || ''}
            onChange={versionChange}
          >
            {!data && <option value="">Loading versions…</option>}
            {data?.versions.filter((item) => !item.released).length > 0 && (
              <optgroup label="Unreleased">
                {data.versions
                  .filter((item) => !item.released)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
              </optgroup>
            )}
            {data?.versions.filter((item) => item.released).length > 0 && (
              <optgroup label="Released">
                {data.versions
                  .filter((item) => item.released)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
              </optgroup>
            )}
          </select>
          <label className="releases-toggle">
            <input
              type="checkbox"
              data-testid="releases-scope"
              checked={scopeAll}
              onChange={(event) => {
                const checked = event.target.checked;
                setScopeAll(checked);
                load({ scope: checked ? 'all' : 'mine' });
              }}
            />{' '}
            All release tickets
          </label>
          <div className="releases-view" role="group" aria-label="Ticket view">
            {['cards', 'list'].map((option) => (
              <Button
                key={option}
                data-testid={`releases-view-${option}`}
                aria-pressed={view === option}
                onClick={() => onViewChange?.(option)}
              >
                {option === 'cards' ? 'Cards' : 'List'}
              </Button>
            ))}
          </div>
          <span className="pr-open-count" data-testid="releases-meta" role="status">
            {meta}
          </span>
          <Button
            data-testid="releases-refresh"
            disabled={busy}
            onClick={() => load({ refresh: true })}
          >
            Refresh
          </Button>
        </div>
        <p className="releases-lag-note" data-testid="releases-lag-note" hidden={!lag}>
          Merge state comes from Jira and can lag GitHub by a few minutes.
        </p>
        <div className="home-warn" data-testid="releases-unavailable" hidden={!unavailable}>
          {unavailable}
        </div>
        <div className="releases-list" data-testid="releases-list">
          {failure && !data ? (
            <div className="pr-error" data-testid="releases-error">
              Could not load this release. Use Refresh to try again.
            </div>
          ) : data ? (
            <>
              {data.truncated && (
                <p className="home-warn" data-testid="releases-truncated">
                  Only the first {data.total} tickets are shown — totals may be incomplete.
                </p>
              )}
              <ReleaseGroups groups={groups} jiraBase={config.jiraBase} view={view} />
            </>
          ) : (
            <LoadingState label="Loading release…" testId="releases-loading" />
          )}
        </div>
      </Card>
    </section>
  );
}
