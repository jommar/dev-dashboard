// What a tab in the DevTools viewer's strip is called: its title, else the site it is on, else
// the address itself, else a placeholder for a tab that has loaded nothing yet.
export function tabLabel(tab) {
  const title = String(tab?.title || '').trim();
  if (title) return title;
  const url = String(tab?.url || '').trim();
  try {
    const { hostname } = new URL(url);
    if (hostname) return hostname;
  } catch {
    // Not an address: fall through to showing it as it is.
  }
  return url || 'New tab';
}
