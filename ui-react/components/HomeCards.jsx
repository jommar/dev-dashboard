import { useRef } from 'react';
import { slug, timeAgo } from '../../ui/dom.js';
import { jiraStatusKind } from '../../ui/components/pr-card.js';
import { filterActionTiers, filterTickets } from '../../ui/work-filters.js';
import { PrItem } from './PrCard.jsx';
import { WorkTicketRow } from './WorkTicket.jsx';
import { usePreservedInteraction } from '../hooks/usePreservedInteraction.js';

const fmtPoints = (n) => String(Math.round(n * 100) / 100);
const BAND = { todo: 'To Do', active: 'In Progress', done: 'Done', unestimated: 'Unestimated' };

export function HomeActionQueue({ tiers, hidden, jiraBase, search }) {
  const visibleTiers = filterActionTiers(tiers, { search });
  return (
    <>
      {visibleTiers.map(
        (tier) =>
          tier.items.length > 0 && (
            <section
              className="action-group"
              data-testid={`home-action-group-${tier.id}`}
              key={tier.id}
            >
              <h4 className="action-reason" data-testid={`home-action-reason-${tier.id}`}>
                {tier.reason}
                <span className="action-count">{tier.items.length}</span>
              </h4>
              {tier.items.map((item) =>
                tier.kind === 'pr' ? (
                  <PrItem key={`${item.repo}#${item.number}`} pr={item} variant="home-action" />
                ) : (
                  <div
                    className="action-ticket"
                    data-testid={`home-action-ticket-${item.key}`}
                    key={item.key}
                  >
                    <span className="action-ticket-key">
                      {jiraBase ? (
                        <a
                          className="jira-link"
                          href={`${jiraBase}${item.key}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          data-testid={`home-action-key-${item.key}`}
                        >
                          {item.key}
                        </a>
                      ) : (
                        <span data-testid={`home-action-key-${item.key}`}>{item.key}</span>
                      )}
                    </span>
                    <span className="action-ticket-summary">{item.summary || ''}</span>
                    <div className="action-ticket-meta">
                      <span className="pill" data-jira-status-kind={jiraStatusKind(item.status)}>
                        {item.status}
                      </span>
                      {item.issueType && <span className="action-dim">{item.issueType}</span>}
                      <span className="updated">{timeAgo(item.updated)}</span>
                    </div>
                  </div>
                ),
              )}
            </section>
          ),
      )}
      {hidden > 0 && (
        <p className="home-more" data-testid="home-actions-more">
          {hidden} more not shown
        </p>
      )}
    </>
  );
}

export function HomeKpis({ tiles }) {
  return (
    <div className="home-kpis" data-testid="home-kpi-row">
      <div className="kpi-row" data-testid="home-kpis">
        {tiles.map(({ id, label, value, unknown, hint, target }) => {
          const content = (
            <>
              <span className="kpi-value" data-testid={`kpi-value-${id}`}>
                {unknown ? '—' : String(value)}
              </span>
              <span className="kpi-label">{label}</span>
            </>
          );
          const props = {
            className: 'kpi-tile',
            'data-testid': `kpi-${id}`,
            'data-tooltip': hint || undefined,
            'data-unknown': unknown ? 'true' : undefined,
          };
          return target ? (
            <a href={`#/${target}`} {...props} key={id}>
              {content}
            </a>
          ) : (
            <div {...props} key={id}>
              {content}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function HomeSprintCard({
  entry,
  range,
  countdown,
  expanded,
  jiraBase,
  listFilters,
  onToggle,
}) {
  const card = useRef(null);
  usePreservedInteraction(card);
  const testId = `home-sprint-${slug(entry.sprint.name)}`;
  const { sprint, counts, total, points, pointsTotal, unestimated, byBand } = entry;
  if (!total)
    return (
      <p className="home-empty" data-testid={`${testId}-empty`}>
        No tickets in this sprint
      </p>
    );
  const sprintKey = String(sprint.id ?? sprint.name);
  const isOpen = (key) => expanded.has(`${sprintKey}:${key}`);
  const listId = (key) => `sprint-${slug(sprintKey)}-list-${key}`;
  const byPoints = pointsTotal > 0;
  const denom = byPoints ? pointsTotal : total;
  const bands = ['todo', 'active', 'done'].map((key) => ({
    key,
    label: BAND[key],
    kind: { todo: 'queued', active: 'active', done: 'done' }[key],
    n: counts[key],
    pts: points[key],
    w: byPoints ? points[key] : counts[key],
  }));
  const tooltip = (band) => {
    const pct = denom ? Math.round((band.w / denom) * 100) : 0;
    const tickets = `${band.n} ${band.n === 1 ? 'ticket' : 'tickets'}`;
    return byPoints
      ? `${band.label}: ${fmtPoints(band.pts)} of ${fmtPoints(denom)} points (${pct}%) across ${tickets}`
      : `${band.label}: ${tickets} of ${denom} (${pct}%)`;
  };
  const listKeys = [...bands.filter((band) => band.n > 0).map((band) => band.key), 'unestimated'];
  const when = [range, countdown].filter(Boolean).join(' · ');
  return (
    <article ref={card} className="sprint-card" data-testid={testId}>
      <header className="sprint-head">
        <h3 className="sprint-name" data-testid={`${testId}-name`}>
          {sprint.name}
        </h3>
        {when && (
          <span className="sprint-when" data-testid={`${testId}-when`}>
            {when}
          </span>
        )}
      </header>
      <div className="sprint-bar" data-testid={`${testId}-bar`}>
        {bands
          .filter((band) => band.w > 0)
          .map((band) => (
            <span
              key={band.key}
              className="sprint-band"
              data-kind={band.kind}
              style={{ width: `${((band.w / denom) * 100).toFixed(2)}%` }}
              data-tooltip={tooltip(band)}
              data-testid={`${testId}-band-${band.key}`}
            />
          ))}
      </div>
      <div className="sprint-legend">
        {bands
          .filter((band) => band.n > 0)
          .map((band) => {
            const label = byPoints
              ? `${fmtPoints(band.pts)} pts · ${band.n} ${band.label}`
              : `${band.n} ${band.label}`;
            const hint = tooltip(band);
            const key = band.key;
            return (
              <button
                key={key}
                type="button"
                className="sprint-legend-item"
                data-kind={band.kind}
                data-band={key}
                data-sprint={sprintKey}
                aria-expanded={isOpen(key)}
                aria-controls={listId(key)}
                aria-label={`${label}. ${hint}`}
                data-tooltip={hint}
                data-testid={`${testId}-count-${key}`}
                onClick={() => onToggle(`${sprintKey}:${key}`)}
              >
                {label}
                <span className="sprint-caret" aria-hidden="true">
                  ▾
                </span>
              </button>
            );
          })}
        <span className="sprint-legend-total" data-testid={`${testId}-total`}>
          {byPoints
            ? `${fmtPoints(points.done)} of ${fmtPoints(pointsTotal)} pts · ${total} tickets`
            : `${total} tickets`}
        </span>
        {!byPoints ? (
          <span
            className="sprint-legend-note"
            data-tooltip="No ticket in this sprint has a story-point estimate, so the bar counts tickets instead."
            data-testid={`${testId}-nopoints`}
          >
            no estimates
          </span>
        ) : (
          unestimated > 0 && (
            <button
              type="button"
              className="sprint-legend-note"
              data-band="unestimated"
              data-sprint={sprintKey}
              aria-expanded={isOpen('unestimated')}
              aria-controls={listId('unestimated')}
              aria-label={`${unestimated} unestimated. ${unestimated} of your ${total} sprint tickets have no story points, so they add no width to the bar and are not in the pts figures.`}
              data-tooltip={`${unestimated} of your ${total} sprint tickets have no story points, so they add no width to the bar and are not in the pts figures.`}
              data-testid={`${testId}-unestimated`}
              onClick={() => onToggle(`${sprintKey}:unestimated`)}
            >
              {unestimated} unestimated
              <span className="sprint-caret" aria-hidden="true">
                ▾
              </span>
            </button>
          )
        )}
      </div>
      {listKeys
        .filter((key) => isOpen(key) && byBand[key]?.length)
        .map((key) => {
          const rows = filterTickets(byBand[key], listFilters);
          return (
            <div
              className="sprint-tickets"
              id={listId(key)}
              role="region"
              aria-label={`${BAND[key]} tickets`}
              data-testid={listId(key)}
              key={key}
            >
              <h5 className="sprint-tickets-head" data-testid={`${listId(key)}-head`}>
                {BAND[key]}
                <span className="sprint-tickets-count">{rows.length}</span>
              </h5>
              <div
                className="sprint-tickets-rows"
                style={{ overflowAnchor: 'none' }}
                data-testid={`${listId(key)}-rows`}
              >
                {rows.map((ticket) => {
                  const hasPoints = Number.isFinite(ticket.storyPoints);
                  const testPoints = `${listId(key)}-points-${slug(ticket.key)}`;
                  return (
                    <WorkTicketRow
                      key={ticket.key}
                      ticket={ticket}
                      jiraBase={jiraBase}
                      showSprint={false}
                      testIdPrefix={`${listId(key)}-item`}
                      extraMeta={
                        <span
                          className="pill sprint-points"
                          data-unestimated={hasPoints ? undefined : 'true'}
                          data-tooltip={hasPoints ? 'Story points' : 'No story-point estimate'}
                          data-testid={testPoints}
                        >
                          {hasPoints ? `${fmtPoints(ticket.storyPoints)} pts` : 'no estimate'}
                        </span>
                      }
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
    </article>
  );
}

export function HomeVelocity({ series }) {
  if (!series?.length)
    return (
      <p className="home-empty" data-testid="home-velocity-empty">
        No completed sprint data yet
      </p>
    );
  const max = Math.max(0, ...series.map((entry) => entry.points));
  const total = series.reduce((sum, entry) => sum + entry.points, 0);
  const unestimated = series.reduce((sum, entry) => sum + entry.unestimated, 0);
  return (
    <div className="velocity-chart" data-testid="home-velocity-chart">
      <div className="velocity-bars" role="list" aria-label="Done story points by sprint">
        {series.map((entry) => {
          const key = String(entry.sprint.id ?? entry.sprint.name);
          const height = max > 0 ? (entry.points / max) * 100 : 0;
          const hint = `${entry.sprint.name}: ${fmtPoints(entry.points)} points across ${entry.count} ${entry.count === 1 ? 'ticket' : 'tickets'}${entry.unestimated ? `, ${entry.unestimated} unestimated` : ''}`;
          return (
            <div
              className="velocity-column"
              role="listitem"
              aria-label={hint}
              data-testid={`home-velocity-column-${key}`}
              key={key}
            >
              <span className="velocity-value">{fmtPoints(entry.points)}</span>
              <div className="velocity-track">
                <span
                  className="velocity-bar"
                  style={{ height: `${height}%` }}
                  data-tooltip={hint}
                  data-testid={`home-velocity-bar-${key}`}
                />
              </div>
              <span className="velocity-label" title={entry.sprint.name}>
                {entry.sprint.name}
              </span>
            </div>
          );
        })}
      </div>
      <div className="velocity-summary">
        <span>{fmtPoints(total)} pts total</span>
        {max <= 0 ? (
          <span className="velocity-note">no estimates</span>
        ) : unestimated > 0 ? (
          <span className="velocity-note">{unestimated} unestimated</span>
        ) : null}
      </div>
    </div>
  );
}

export function ServiceStrip({ services, controlPendingIds, onControl }) {
  return services.map((service) => {
    const id = service.id;
    const running = service.status === 'running';
    const label =
      service.status +
      (service.exitCode != null && service.exitCode !== service.status
        ? ` (${service.exitCode})`
        : '');
    return (
      <div className="svc-row" data-testid={`home-svc-${id}`} key={id}>
        <span
          className="pill status"
          data-status={service.status}
          data-testid={`home-svc-status-${id}`}
        >
          {label}
        </span>
        <span className="svc-name" data-testid={`home-svc-name-${id}`}>
          {service.label}
        </span>
        {service.port && id !== 'legacy-ui' && (
          <a
            className="port"
            href={`http://127.0.0.1:${service.port}`}
            target="_blank"
            rel="noopener noreferrer"
            data-testid={`home-svc-port-${id}`}
          >
            :{service.port}
          </a>
        )}
        <span className="svc-spacer" />
        <button
          className={`btn ${running ? 'stop' : 'start'}`}
          disabled={controlPendingIds.has(id)}
          data-action={running ? 'stop' : 'start'}
          data-service={id}
          data-testid={`home-svc-toggle-${id}`}
          onClick={() => onControl(id, running ? 'stop' : 'start')}
        >
          {running ? 'Stop' : 'Start'}
        </button>
      </div>
    );
  });
}
