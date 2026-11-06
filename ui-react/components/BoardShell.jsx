// A shared board column: presentation is supplied by the existing ticket-board
// classes; its rows and the meaning of the columns remain domain-specific.
export function BoardColumn({ id, label, count, testIdPrefix, kind, children, className = '' }) {
  const titleId = `${testIdPrefix}title-${id}`;
  return (
    <section
      className={`my-tickets-column ${className}`}
      role="group"
      data-jira-status-kind={kind}
      data-testid={`${testIdPrefix}${id}`}
      aria-labelledby={titleId}
    >
      <div className="my-tickets-column-head" data-testid={`${testIdPrefix}head-${id}`}>
        <h3 className="my-tickets-column-title" id={titleId}>
          {label}
        </h3>
        <span className="my-tickets-column-count" data-testid={`${testIdPrefix}count-${id}`}>
          {count}
        </span>
      </div>
      <ul className="my-tickets-column-body" data-testid={`${testIdPrefix}body-${id}`} tabIndex={0}>
        {children}
      </ul>
    </section>
  );
}
