import { useEffect, useRef, useState } from 'react';
import { NavIcon } from './NavIcon.jsx';

const PRIMARY_ROUTES = new Set(['home', 'my-tickets', 'slack']);

function NavLink({ tab: { id, label, badge }, active, onNavigate }) {
  return (
    <a
      className={`tab${active === id ? ' active' : ''}`}
      href={`#/${id}`}
      title={label}
      data-tab={id}
      data-testid={`tab-${id}`}
      aria-current={active === id ? 'page' : undefined}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
          return;
        event.preventDefault();
        onNavigate(id);
      }}
    >
      <NavIcon name={id} />
      <span className="nav-label">{label}</span>
      {badge}
    </a>
  );
}

export function AppTabs({ tabs, active, onNavigate }) {
  const [open, setOpen] = useState(false);
  const toolsRef = useRef(null);
  const toggleRef = useRef(null);
  const primary = tabs.filter(({ id }) => PRIMARY_ROUTES.has(id));
  const tools = tabs.filter(({ id }) => !PRIMARY_ROUTES.has(id));
  const compact = primary.length > 0;
  const activeTool = tools.find(({ id }) => id === active);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event) => {
      if (!toolsRef.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      toggleRef.current?.focus();
    };
    const close = () => setOpen(false);
    const media = window.matchMedia('(min-width: 1200px)');
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    window.addEventListener('hashchange', close);
    media.addEventListener('change', close);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('hashchange', close);
      media.removeEventListener('change', close);
    };
  }, [open]);

  return (
    <nav className="tabs" id="tabs" data-testid="tabs" aria-label="Workspace">
      {primary.length > 0 && (
        <div className="nav-primary">
          {primary.map((tab) => (
            <NavLink key={tab.id} tab={tab} active={active} onNavigate={onNavigate} />
          ))}
        </div>
      )}
      <div
        className={`nav-tools${compact ? ' nav-tools-compact' : ''}`}
        ref={toolsRef}
        onBlur={(event) => {
          if (!toolsRef.current?.contains(event.relatedTarget)) setOpen(false);
        }}
      >
        {compact && (
          <button
            type="button"
            className="nav-tools-toggle"
            data-testid="nav-tools-toggle"
            data-active={Boolean(activeTool)}
            aria-expanded={open}
            aria-controls="nav-tools-panel"
            ref={toggleRef}
            onClick={() => setOpen((value) => !value)}
          >
            <NavIcon name="tools" />
            <span>Tools</span>
            {activeTool && <span className="sr-only"> · Current view: {activeTool.label}</span>}
          </button>
        )}
        <div className={`nav-tools-panel${open ? ' is-open' : ''}`} id="nav-tools-panel">
          {tools.map((tab) => (
            <NavLink
              key={tab.id}
              tab={tab}
              active={active}
              onNavigate={(id) => {
                if (open) toggleRef.current?.focus();
                setOpen(false);
                onNavigate(id);
              }}
            />
          ))}
        </div>
      </div>
    </nav>
  );
}
