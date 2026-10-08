// spinner.js — one accessible loading spinner, shared by every panel.
import { esc } from '../dom.js';

export function spinnerHtml({ label = 'Loading…', testId = 'loading-spinner' } = {}) {
  return (
    `<div class="spinner-wrap" role="status" aria-live="polite" data-testid="${esc(testId)}">` +
    '<span class="spinner" aria-hidden="true"></span>' +
    `<span class="spinner-label">${esc(label)}</span>` +
    '</div>'
  );
}
