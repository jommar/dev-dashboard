import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

// The bundle budget: what the browser must parse before first paint (the entry chunk and every
// chunk it imports statically) stays small, because the rarely used screens and dialogs load on
// first use. The build runs in memory (`write: false`, throwaway outDir), never into dist/, so it
// needs no dist test lock and cannot disturb a server or Playwright run reading dist/.
//
// Baseline at b2eb63d: one entry chunk, 831 KiB raw, 252 KiB gzip -9, 164 kB of CSS.
const KIB = 1024;
const MAX_INITIAL_RAW = 640 * KIB;
// Raised from 200→202 KiB (My Tickets merged PRs, Slack ticket-thread search), 203 KiB for
// per-PR viewer review indicators on the Pull Requests board, 206 KiB when Releases joined
// Sprint as a second lazy consumer of useTicketSlackThreads (causing Rolldown to split it into
// its own initial chunk), and 207 KiB for shared BoardDivider / person grouping on Pull Requests.
const MAX_INITIAL_GZIP = 207 * KIB;
// A guard against bloat, not a target: lazy loading splits code, it must not add much of it.
// Raised from 884 KiB for the lazy Sprint screen, which could not fit the 1.5 KiB that was left,
// to 902 KiB for the ticket-thread search in the shared Slack hook (about 1 KiB of eager code), and
// to 904 KiB for the Stop button of the Sessions drawer's rows (lazy body, a little eager wiring),
// and to 908 KiB for the question choices and Independent tooltips of the Claude dialog (all lazy),
// and to 914 KiB for the Copy prompt buttons across the Claude dialog, prompts editor and E2E check
// (all lazy, plus one tiny helper in api.js), to 919 KiB for the redesigned lazy Releases board,
// and to 921 KiB for shared person grouping & dividers across Releases, Sprint and Pull Requests.
const MAX_TOTAL_RAW = 921 * KIB;
// Raised from 180 KiB for per-PR viewer review background tints in prs.css, and to 182 KiB for
// assignee dividers in releases.css.
const MAX_TOTAL_CSS = 182 * KIB;
// Modules that must load on demand: the five rarely used screens and the two dialogs, plus the
// markdown renderer both the viewer and the chat pull in.
const LAZY_MODULES = [
  'panels/ChatPanel.jsx',
  'panels/ReleasesPanel.jsx',
  'panels/DevtoolsPanel.jsx',
  'panels/MascotsPanel.jsx',
  'panels/SprintPanel.jsx',
  'components/ArtifactViewer.jsx',
  'components/E2eCheckDialog.jsx',
  'components/MarkdownView.jsx',
  // Opened only by a key press: the key listener is eager and tiny, these load before they open.
  'components/CommandPalette.jsx',
  'components/ShortcutsHelp.jsx',
  // The ticket's Claude dialog (and the prompts editor, CopyPromptButton and UseInServices it holds) opens on a click.
  'components/ClaudeDialog.jsx',
  'components/ClaudePromptsEditor.jsx',
  'components/CopyPromptButton.jsx',
  'components/UseInServices.jsx',
  // The Slack activity drawer's list: its edge tab is eager and tiny, the list loads before it opens.
  'components/SlackFeedPanel.jsx',
  // The Sessions drawer's list, loaded before the drawer opens.
  'components/SessionsBody.jsx',
];

const repo = fileURLToPath(new URL('../', import.meta.url));
const bytes = (text) => Buffer.byteLength(text);
const gzipped = (text) => zlib.gzipSync(text, { level: 9 }).length;
const kib = (size) => `${(size / KIB).toFixed(1)} KiB`;

async function buildInMemory() {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-dashboard-bundle-budget-'));
  try {
    const result = await build({
      configFile: path.join(repo, 'vite.config.js'),
      logLevel: 'silent',
      build: { outDir, emptyOutDir: true, write: false },
    });
    const { output } = Array.isArray(result) ? result[0] : result;
    return output;
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

// The entry chunk plus everything it imports statically, transitively.
function initialClosure(chunks) {
  const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const entry = chunks.find((chunk) => chunk.isEntry);
  assert.ok(entry, 'the build has an entry chunk');
  const seen = new Set();
  const visit = (chunk) => {
    if (seen.has(chunk.fileName)) return;
    seen.add(chunk.fileName);
    for (const name of chunk.imports) if (byName.has(name)) visit(byName.get(name));
  };
  visit(entry);
  return chunks.filter((chunk) => seen.has(chunk.fileName));
}

let outputPromise;
const output = () => (outputPromise ??= buildInMemory());

test('initial JavaScript stays within the raw and gzip budget', async () => {
  const chunks = (await output()).filter((item) => item.type === 'chunk');
  const initial = initialClosure(chunks);
  const raw = initial.reduce((sum, chunk) => sum + bytes(chunk.code), 0);
  const gzip = initial.reduce((sum, chunk) => sum + gzipped(chunk.code), 0);
  assert.ok(
    raw <= MAX_INITIAL_RAW,
    `initial JS is ${kib(raw)} raw, budget ${kib(MAX_INITIAL_RAW)} (baseline 831 KiB)`,
  );
  assert.ok(
    gzip <= MAX_INITIAL_GZIP,
    `initial JS is ${kib(gzip)} gzip -9, budget ${kib(MAX_INITIAL_GZIP)} (baseline 252 KiB)`,
  );
});

test('heavy screens, dialogs and the markdown stack are outside the initial closure', async () => {
  const chunks = (await output()).filter((item) => item.type === 'chunk');
  const initial = new Set(initialClosure(chunks).map((chunk) => chunk.fileName));
  for (const module of LAZY_MODULES) {
    const owner = chunks.find((chunk) =>
      Object.keys(chunk.modules ?? {}).some((id) => id.endsWith(`/ui-react/${module}`)),
    );
    assert.ok(owner, `${module} is in an emitted chunk`);
    assert.ok(!initial.has(owner.fileName), `${module} is in the initial chunk ${owner.fileName}`);
    if (
      module.startsWith('panels/') ||
      module.endsWith('Viewer.jsx') ||
      module.endsWith('Dialog.jsx') ||
      module.endsWith('Palette.jsx') ||
      module.endsWith('Help.jsx') ||
      module === 'components/SlackFeedPanel.jsx'
    )
      assert.ok(owner.isDynamicEntry, `${module} loads through a dynamic import`);
  }
});

test('splitting does not bloat the total code or the stylesheet', async () => {
  const items = await output();
  const js = items
    .filter((item) => item.type === 'chunk')
    .reduce((sum, chunk) => sum + bytes(chunk.code), 0);
  const css = items
    .filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'))
    .reduce((sum, asset) => sum + bytes(asset.source), 0);
  assert.ok(js <= MAX_TOTAL_RAW, `all JS is ${kib(js)}, ceiling ${kib(MAX_TOTAL_RAW)}`);
  assert.ok(css <= MAX_TOTAL_CSS, `all CSS is ${kib(css)}, ceiling ${kib(MAX_TOTAL_CSS)}`);
});
