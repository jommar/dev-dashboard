// tooltip.js — one shared floating tooltip for every element carrying a
// data-tooltip attribute (review badges, ticket status and sprint pills, the
// Home KPI tiles and sprint bands), positioned near the hovered element
// (position:fixed + viewport clamping) so a card's overflow:hidden never clips
// it. Delegated from document, so markup rendered later is picked up without
// re-mounting. The text wraps inside a max-width — see .tooltip in prs.css.
import { clamp } from '../dom.js';

const TOOLTIP_TARGET = '[data-tooltip]';

export function mountTooltip(tooltip) {
  const show = (el) => {
    tooltip.textContent = el.getAttribute('data-tooltip') || '';
    const rect = el.getBoundingClientRect();
    tooltip.hidden = false;
    // Measure from the origin. Now that the text wraps, a box still parked
    // near the right edge would shrink to the space left there and report a
    // taller, narrower size than it will actually have once positioned.
    tooltip.style.left = '0px';
    tooltip.style.top = '0px';
    const tip = tooltip.getBoundingClientRect();
    const x = clamp(
      rect.left + rect.width / 2 - tip.width / 2,
      4,
      window.innerWidth - tip.width - 4,
    );
    let y = rect.top - tip.height - 6;
    if (y < 4) y = rect.bottom + 6;
    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
  };

  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest && e.target.closest(TOOLTIP_TARGET);
    if (el) show(el);
  });
  document.addEventListener('mouseout', (e) => {
    if (e.target.closest && e.target.closest(TOOLTIP_TARGET)) tooltip.hidden = true;
  });
}
