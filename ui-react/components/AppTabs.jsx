export function AppTabs({ tabs, active, onNavigate }) {
  return (
    <nav className="tabs" id="tabs" data-testid="tabs" aria-label="Workspace">
      {tabs.map(({ id, label }) => (
        <a
          key={id}
          className={`tab${active === id ? ' active' : ''}`}
          href={`#/${id}`}
          data-tab={id}
          data-testid={`tab-${id}`}
          aria-current={active === id ? 'page' : undefined}
          onClick={(event) => {
            if (
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey ||
              event.button !== 0
            )
              return;
            event.preventDefault();
            onNavigate(id);
          }}
        >
          {label}
        </a>
      ))}
    </nav>
  );
}
