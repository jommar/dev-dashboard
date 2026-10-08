import { useEffect, useMemo, useState } from 'react';
import { Button } from './Primitives.jsx';

const STORAGE_KEY = 'dev-dashboard.work-filters';
const SCHEMAS = {
  prs: {
    search: null,
    section: ['', 'open', 'draft', 'approval', 'uat'],
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
    ['section', 'Section'],
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
  views[view] = filters;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, views }));
  } catch {
    /* Keep in-memory filters. */
  }
}

export function WorkFilters({ id, view, options = {}, total = 0, shown = total, onChange }) {
  const schema = SCHEMAS[view];
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

  return (
    <div className="work-filters" id={id} role="group" aria-label="List filters">
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
      {SELECTS[view].map(([field, label]) => {
        const values = new Map(choices[field].filter(([value]) => value));
        if (filters[field] && !values.has(filters[field]))
          values.set(filters[field], `${filters[field]} (not in fetched data)`);
        return (
          <label key={field}>
            {label}
            <select
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
        onClick={() => {
          const next = Object.fromEntries(Object.keys(schema).map((key) => [key, '']));
          saveView(view, next);
          setFilters(next);
        }}
      >
        Clear filters
      </Button>
      <span className="work-filter-count" data-testid={`${id}-count`} role="status">
        {shown} of {total}
      </span>
    </div>
  );
}
