// tabs.js — top-level section switcher, backed by the URL hash (#/services).
//
// Adding a section is one entry in the `tabs` array plus a panel that exposes
// { activate, deactivate }.
import { esc } from '../dom.js';

export function createTabs({ root, tabs, onChange }) {
  const ids = tabs.map((t) => t.id);
  const fromHash = () => {
    const id = location.hash.replace(/^#\/?/, '');
    return ids.includes(id) ? id : ids[0];
  };

  root.innerHTML = tabs
    .map(
      (t) =>
        `<a class="tab" href="#/${esc(t.id)}" data-tab="${esc(t.id)}" data-testid="tab-${esc(t.id)}">` +
        `${esc(t.label)}</a>`,
    )
    .join('');

  let current = null;

  function select(id, { push = true } = {}) {
    if (!ids.includes(id)) id = ids[0];
    const hash = '#/' + id;
    if (location.hash !== hash) {
      if (push) location.hash = hash;
      else history.replaceState(null, '', hash);
    }
    if (id === current) return;
    current = id;
    for (const btn of root.querySelectorAll('.tab')) {
      btn.classList.toggle('active', btn.dataset.tab === id);
      if (btn.dataset.tab === id) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    }
    onChange(id);
  }

  root.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (btn && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.button === 0) {
      e.preventDefault();
      select(btn.dataset.tab);
    }
  });
  window.addEventListener('hashchange', () => select(fromHash(), { push: false }));

  select(fromHash(), { push: false });
  return {
    select,
    get current() {
      return current;
    },
  };
}
