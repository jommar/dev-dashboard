// dom.js — the handful of primitives every component needs.

export function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Safe for a data-testid / id fragment built from arbitrary text.
export function slug(s) {
  return esc(s).replace(/[^A-Za-z0-9-]+/g, '-');
}

export function clamp(v, min, max) {
  return Math.max(min, Math.min(v, max));
}

export function replaceRegion(el, html) {
  const focused = el.contains(document.activeElement)
    ? document.activeElement.dataset.testid
    : null;
  const scrolls = [...el.querySelectorAll('[data-testid]')]
    .filter((node) => node.scrollTop || node.scrollLeft)
    .map((node) => [node.dataset.testid, node.scrollTop, node.scrollLeft]);
  el.innerHTML = html;
  if (focused)
    el.querySelector(`[data-testid="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  for (const [id, top, left] of scrolls) {
    const node = el.querySelector(`[data-testid="${CSS.escape(id)}"]`);
    if (node) {
      node.scrollTop = top;
      node.scrollLeft = left;
    }
  }
}

// Compact relative time, e.g. "just now", "3m ago", "2h ago", "5d ago".
export function timeAgo(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24);
  if (d < 30) return d + 'd ago';
  const mo = Math.floor(d / 30);
  if (mo < 12) return mo + 'mo ago';
  return Math.floor(mo / 12) + 'y ago';
}
