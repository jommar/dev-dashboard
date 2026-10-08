import { getPrDiff } from '../../ui-react/lib/api.js';

export const MAX_RENDER_BYTES = 256 * 1024;
export const MAX_RENDER_ROWS = 3000;
export const MAX_LINE_LENGTH = 4000;

export function parseUnifiedDiff(diff) {
  // Bound allocation before encoding/splitting, including a patch with one huge line.
  const bytes = new TextEncoder().encode(diff.slice(0, MAX_RENDER_BYTES));
  const preview = new TextDecoder().decode(bytes.subarray(0, MAX_RENDER_BYTES));
  let truncated = diff.length > MAX_RENDER_BYTES || bytes.length > MAX_RENDER_BYTES;
  const lines = preview.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const rows = [];
  let oldLine = 0,
    newLine = 0,
    oldRemaining = 0,
    newRemaining = 0;
  for (const line of lines) {
    if (rows.length === MAX_RENDER_ROWS) {
      truncated = true;
      break;
    }
    const row = { type: 'meta', text: line, oldLine: null, newLine: null };
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (line.startsWith('diff --git ')) {
      row.type = 'file';
      oldRemaining = newRemaining = 0;
    } else if (hunk) {
      row.type = 'hunk';
      oldLine = Number(hunk[1]);
      oldRemaining = Number(hunk[2] ?? 1);
      newLine = Number(hunk[3]);
      newRemaining = Number(hunk[4] ?? 1);
    } else if (
      line.startsWith('\\ No newline') ||
      /^(Binary files |GIT binary patch|rename (from|to) |similarity index )/.test(line)
    ) {
      row.type = 'notice';
    } else if (line.startsWith('-') && oldRemaining > 0) {
      row.type = 'deletion';
      row.oldLine = oldLine++;
      oldRemaining--;
    } else if (line.startsWith('+') && newRemaining > 0) {
      row.type = 'addition';
      row.newLine = newLine++;
      newRemaining--;
    } else if (line.startsWith(' ') && oldRemaining > 0 && newRemaining > 0) {
      row.type = 'context';
      row.oldLine = oldLine++;
      row.newLine = newLine++;
      oldRemaining--;
      newRemaining--;
    }
    if (row.text.length > MAX_LINE_LENGTH) {
      row.text = row.text.slice(0, MAX_LINE_LENGTH) + ' [line truncated]';
      truncated = true;
    }
    rows.push(row);
  }
  return { rows, truncated };
}

export function renderUnifiedDiff(diff, container) {
  const parsed = parseUnifiedDiff(diff);
  const doc = container.ownerDocument;
  const table = doc.createElement('table');
  table.className = 'diff-table';
  table.setAttribute('aria-label', 'Unified diff: old and new line numbers');
  const head = table.createTHead().insertRow();
  for (const label of ['Old', 'New', 'Patch']) {
    const cell = doc.createElement('th');
    cell.scope = 'col';
    cell.textContent = label;
    head.append(cell);
  }
  const body = table.createTBody();
  for (const row of parsed.rows) {
    const tr = body.insertRow();
    tr.className = `diff-${row.type}`;
    if (['file', 'hunk', 'meta', 'notice'].includes(row.type)) {
      const cell = tr.insertCell();
      cell.colSpan = 3;
      const text = doc.createElement(row.type === 'file' ? 'h3' : 'span');
      text.textContent = row.text;
      cell.append(text);
    } else {
      for (const value of [row.oldLine, row.newLine, row.text]) {
        tr.insertCell().textContent = value ?? '';
      }
    }
  }
  container.replaceChildren(table);
  return parsed;
}

let viewer;

export function openDiffViewer(button) {
  viewer ??= createDiffViewer();
  viewer.open(button);
}

function createDiffViewer() {
  const dialog = document.createElement('dialog');
  dialog.className = 'diff-viewer';
  dialog.dataset.testid = 'diff-viewer';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-label', 'Diff viewer');
  dialog.innerHTML = `
    <header class="diff-header">
      <div class="diff-heading"><h2>Diff viewer</h2><p class="diff-identity"></p><p class="diff-base"></p></div>
      <div class="diff-controls">
        <button type="button" class="btn" data-testid="diff-copy" disabled>Copy diff</button>
        <button type="button" class="btn" data-testid="diff-retry" hidden>Retry</button>
        <button type="button" class="btn" data-testid="diff-close" autofocus>Close</button>
      </div>
    </header>
    <div class="diff-diagnostics" tabindex="0" role="region" aria-label="Diff status and preview limits">
      <p class="diff-truncation" hidden>Preview truncated: only the first 3,000 rows / 256 KiB are shown, with long lines shortened. Copy diff still copies the complete original patch.</p>
      <p class="diff-status" data-testid="diff-status" role="status" aria-live="polite"></p>
    </div>
    <div class="diff-content" data-testid="diff-content" tabindex="0" role="region" aria-label="Diff content"></div>`;
  document.body.append(dialog);
  const identity = dialog.querySelector('.diff-identity');
  const base = dialog.querySelector('.diff-base');
  const copy = dialog.querySelector('[data-testid="diff-copy"]');
  const retry = dialog.querySelector('[data-testid="diff-retry"]');
  const closeButton = dialog.querySelector('[data-testid="diff-close"]');
  const status = dialog.querySelector('.diff-status');
  const truncation = dialog.querySelector('.diff-truncation');
  const content = dialog.querySelector('.diff-content');
  let generation = 0,
    raw = null,
    opener = null,
    openedHash = '',
    request = null;

  const current = (id) => id === generation && dialog.open && openedHash === location.hash;
  function feedback(message, state) {
    status.textContent = message;
    status.dataset.state = state;
  }
  function finishClose() {
    if (dialog.open || !opener) return;
    generation++;
    raw = null;
    content.replaceChildren();
    const original = opener;
    opener = null;
    const visible = (el) => el && !el.disabled && el.getClientRects().length > 0;
    const replacement = [...document.querySelectorAll('.view-diff')].find(
      (el) => el.dataset.testid === original.dataset.testid && visible(el),
    );
    const target = visible(original) ? original : replacement;
    (
      target ||
      document.querySelector('.tab[aria-current="page"]') ||
      document.getElementById('workspace')
    )?.focus({ preventScroll: true });
  }
  function close() {
    dialog.close();
    finishClose();
  }
  async function load() {
    const id = ++generation;
    raw = null;
    copy.disabled = true;
    retry.hidden = true;
    truncation.hidden = true;
    content.replaceChildren();
    content.setAttribute('aria-busy', 'true');
    feedback('Loading diff...', 'pending');
    try {
      const result = await getPrDiff(request.repo, request.number);
      if (!current(id)) return;
      if (typeof result?.diff !== 'string') throw new Error('Invalid diff response');
      raw = result.diff;
      identity.textContent = `${result.repo ?? request.repo} #${result.number ?? request.number}`;
      if (raw === '') {
        content.textContent = 'No changes against this base.';
        feedback('Diff loaded. No changes.', 'success');
      } else {
        const { truncated } = renderUnifiedDiff(raw, content);
        truncation.hidden = !truncated;
        feedback(
          truncated
            ? 'Diff loaded. Preview truncated; Copy diff copies the complete original patch.'
            : 'Diff loaded.',
          'success',
        );
      }
      copy.disabled = false;
    } catch (error) {
      if (!current(id)) return;
      raw = null;
      retry.hidden = false;
      feedback(`Could not load diff: ${error.message}. Use Retry to try again.`, 'error');
    } finally {
      if (current(id)) content.setAttribute('aria-busy', 'false');
    }
  }
  copy.addEventListener('click', async () => {
    if (raw === null || copy.disabled) return;
    const id = generation;
    copy.disabled = true;
    feedback('Copying diff...', 'pending');
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard unavailable. Open this workspace on localhost or HTTPS');
      }
      await navigator.clipboard.writeText(raw);
      if (current(id)) feedback('Diff copied to clipboard.', 'success');
    } catch (error) {
      if (current(id))
        feedback(`Copy failed: ${error.message}. Use Copy diff to try again.`, 'error');
    } finally {
      if (current(id)) copy.disabled = false;
    }
  });
  retry.addEventListener('click', load);
  closeButton.addEventListener('click', close);
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener('close', finishClose);
  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const targets = [...dialog.querySelectorAll('button, [tabindex]')].filter(
      (el) => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length > 0,
    );
    const first = targets[0],
      last = targets.at(-1);
    if (event.shiftKey ? document.activeElement === first : document.activeElement === last) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  });
  window.addEventListener('hashchange', () => {
    if (dialog.open && openedHash !== location.hash) close();
  });
  return {
    open(button) {
      opener = button;
      openedHash = location.hash;
      request = { repo: button.dataset.repo, number: button.dataset.number };
      identity.textContent = `${request.repo} #${request.number}`;
      base.textContent = 'Compared against origin/ops/development';
      if (!dialog.open) dialog.showModal();
      closeButton.focus({ preventScroll: true });
      load();
      content.scrollTop = content.scrollLeft = 0;
    },
  };
}
