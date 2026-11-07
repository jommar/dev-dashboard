const paths = {
  home: 'm3 10 9-7 9 7M5 9v11h5v-6h4v6h5V9',
  'my-tickets': 'M8 5H5v16h14V5h-3M8 3h8v4H8zM8 12h8M8 16h5',
  slack: 'M4 5h16v12H9l-5 4V5zM8 9h8M8 13h5',
  prs: 'M6 6v12M18 18v-5a5 5 0 0 0-5-5h-2m3-3-3 3 3 3',
  releases: 'M4 5h8l8 8-7 7-9-9V5zM8 9h.01',
  services: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01M12 10v4',
  settings:
    'm9 3-.5 3-2 1-2.5-1-2 3 2 2.5v2L2 16l2 3 2.5-1 2 1L9 22h4l.5-3 2-1 2.5 1 2-3-2-2.5v-2L20 9l-2-3-2.5 1-2-1L13 3z',
  tools: 'M5 6h14M5 12h14M5 18h14',
};

export function NavIcon({ name }) {
  return (
    <svg
      className="nav-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths[name]} />
      {name === 'prs' && (
        <>
          <circle cx="6" cy="4" r="2" />
          <circle cx="6" cy="20" r="2" />
          <circle cx="18" cy="20" r="2" />
        </>
      )}
      {name === 'settings' && <circle cx="11" cy="12.5" r="3" />}
    </svg>
  );
}
