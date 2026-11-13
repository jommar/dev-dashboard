const paths = {
  home: 'm3 10 9-7 9 7M5 9v11h5v-6h4v6h5V9',
  'my-tickets': 'M8 5H5v16h14V5h-3M8 3h8v4H8zM8 12h8M8 16h5',
  slack: 'M4 5h16v12H9l-5 4V5zM8 9h8M8 13h5',
  chat: 'M4 5h16v11H11l-4 4v-4H4zM8 9h8M8 12h5',
  prs: 'M6 6v12M18 18v-5a5 5 0 0 0-5-5h-2m3-3-3 3 3 3',
  releases: 'M4 5h8l8 8-7 7-9-9V5zM8 9h.01',
  services: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01M12 10v4',
  devtools: 'M4 5h16v11H4zM9 20h6M12 16v4M8 9l2 2-2 2M13 13h3',
  mascots: 'M5 9h14v10H5zM12 9V6m0-1h.01M9 13h.01M15 13h.01M9 16h6M3 13v3M21 13v3',
  settings:
    'm9 3-.5 3-2 1-2.5-1-2 3 2 2.5v2L2 16l2 3 2.5-1 2 1L9 22h4l.5-3 2-1 2.5 1 2-3-2-2.5v-2L20 9l-2-3-2.5 1-2-1L13 3z',
  tools: 'M5 6h14M5 12h14M5 18h14',
  // Not tabs: the copy buttons of the Sessions drawer's rows, and their done mark.
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  // The phase of a Claude session in the Sessions drawer (investigate and review also draw a circle).
  investigate: 'm20 20-4.5-4.5',
  implement: 'm8 8-4 4 4 4M16 8l4 4-4 4M13.5 6l-3 12',
  review: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z',
  groom: 'M4 20l1-4L16 5l3 3L8 19zM13.5 7.5l3 3',
  e2e: 'M4 5h16v14H4zM10 9l5 3-5 3z',
  check: 'm5 12 5 5 9-10',
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
      {name === 'investigate' && <circle cx="11" cy="11" r="6" />}
      {name === 'review' && <circle cx="12" cy="12" r="3" />}
    </svg>
  );
}
