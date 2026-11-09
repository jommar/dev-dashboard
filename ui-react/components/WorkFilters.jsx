import { useEffect, useMemo, useState } from 'react';
import { Button } from './Primitives.jsx';

const STORAGE_KEY = 'dev-dashboard.work-filters';
const SCHEMAS = {
  prs: {
    search: null,
    prefix: null,
    repo: null,
    review: ['', 'approved', 'changes_requested', 'awaiting', 'unknown'],
  },
  tickets: { search: null, status: null, sprint: null, priority: null, type: null },
  actions: {
    search: null,
    action: ['', 'changes-requested', 'needs-approval', 'awaiting-approval', 'in-progress'],
  },
  sprint: { search: null, status: null },
};
const SELECTS = {
  prs: [
    ['prefix', 'Ticket prefix'],
    ['repo', 'Repository'],
    ['review', 'Review state'],
  ],
  tickets: [
    ['status', 'Status'],
    ['sprint', 'Sprint'],
    ['priority', 'Priority'],
    ['type', 'Type'],
  ],
  actions: [['action', 'Action type']],
  sprint: [['status', 'Status']],
};

function readViews() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (
      saved?.version !== 1 ||
      !saved.views ||
      typeof saved.views !== 'object' ||
      Array.isArray(saved.views)
    )
      return {};
    const views = {};
    for (const [view, schema] of Object.entries(SCHEMAS)) {
      const fields = saved.views[view];
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) continue;
      if (view === 'prs') delete fields.prefix;
      const valid = Object.entries(schema).every(
        ([key, values]) =>
          fields[key] === undefined ||
          (typeof fields[key] === 'string' && (!values || values.includes(fields[key]))),
      );
      views[view] = valid ? fields : {};
    }
    return views;
  } catch {
    return {};
  }
}

function saveView(view, filters) {
  const views = readViews();
  views[view] = { ...filters };
  if (view === 'prs') delete views[view].prefix;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, views }));
  } catch {
    /* Keep in-memory filters. */
  }
}

export function WorkFilters({
  id,
  view,
  options = {},
  total = 0,
  shown = total,
  onChange,
  collapsible = false,
}) {
  const schema = SCHEMAS[view];
  // Opt-in: the narrow My Tickets toolbar folds its selects behind a Filters button.
  // Elsewhere the row is always open and the DOM carries no disclosure attributes.
  const [open, setOpen] = useState(false);
  const [filters, setFilters] = useState(() => {
    const saved = readViews()[view] || {};
    return Object.fromEntries(
      Object.keys(schema).map((key) => [key, typeof saved[key] === 'string' ? saved[key] : '']),
    );
  });
  const choices = useMemo(() => {
    const result = {};
    for (const [field, allowed] of Object.entries(schema)) {
      const value = options[field] || (allowed ? allowed.slice(1) : []);
      result[field] = value.map((entry) => (Array.isArray(entry) ? entry : [entry, entry]));
    }
    return result;
  }, [options, schema]);
  useEffect(() => {
    onChange(filters);
  }, [filters, onChange]);

  const change = (field, value) =>
    setFilters((current) => {
      const next = { ...current, [field]: value };
      saveView(view, next);
      return next;
    });

  const activeFields = SELECTS[view].filter(([field]) => filters[field]).length;
  // The selects and Clear. A collapsible row wraps them in one region that the Filters
  // button controls; any other row renders them as direct children, as it always has.
  const fieldControls = (
    <>
      {SELECTS[view].map(([field, label]) => {
        const values = new Map(choices[field].filter(([value]) => value));
        if (filters[field] && !values.has(filters[field]))
          values.set(filters[field], `${filters[field]} (not in fetched data)`);
        return (
          <label key={field} className="work-filter-field">
            {label}
            <select
              aria-label={label}
              data-filter={field}
              value={filters[field]}
              onChange={(event) => change(field, event.target.value)}
            >
              <option value="">All</option>
              {[...values].map(([value, name]) => (
                <option key={value} value={value}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        );
      })}
      <Button
        type="button"
        className="work-filter-clear"
        onClick={() => {
          const next = Object.fromEntries(Object.keys(schema).map((key) => [key, '']));
          saveView(view, next);
          setFilters(next);
        }}
      >
        Clear filters
      </Button>
    </>
  );
  return (
    <div
      className="work-filters"
      id={id}
      role="group"
      aria-label="List filters"
      data-collapsible={collapsible ? 'true' : undefined}
      data-expanded={collapsible ? String(open) : undefined}
    >
      <label className="work-filter-search">
        Search
        <input
          type="search"
          data-filter="search"
          placeholder="Search fetched items"
          value={filters.search}
          onChange={(event) => change('search', event.target.value)}
        />
      </label>
      {collapsible && (
        <Button
          type="button"
          className="work-filter-toggle"
          aria-expanded={open}
          aria-controls={`${id}-fields`}
          data-testid={`${id}-toggle`}
          onClick={() => setOpen((value) => !value)}
        >
          Filters
          {activeFields > 0 && (
            <span className="work-filter-active" data-testid={`${id}-active`}>
              {activeFields} active
            </span>
          )}
        </Button>
      )}
      {collapsible ? (
        <div className="work-filter-fields" id={`${id}-fields`}>
          {fieldControls}
        </div>
      ) : (
        fieldControls
      )}
      <span className="work-filter-count" data-testid={`${id}-count`} role="status">
        {shown} of {total}
      </span>
    </div>
  );
}
