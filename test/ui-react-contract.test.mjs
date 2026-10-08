import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../ui-react/', import.meta.url));
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('the React entry mounts a themed shell with one shared ready-mode SSE hook', () => {
  assert.match(read('main.jsx'), /createRoot\(document\.getElementById\('root'\)\)/);
  const app = read('App.jsx');
  assert.match(app, /<ThemeProvider theme=\{dashboardTheme\}>/);
  assert.match(app, /useServiceEvents\(ready, setupChanged\)/);
  assert.equal((app.match(/subscribeServices/g) || []).length, 0);
  assert.match(app, /READY_TABS/);
  assert.match(app, /SETTINGS_TAB/);
});

test('the shared API boundary retains every existing endpoint and payload operation', () => {
  const api = read('lib/api.js');
  for (const route of [
    '/api/config',
    '/api/settings',
    '/api/settings/validate',
    '/api/services',
    '/api/prs',
    '/api/my-tickets',
    '/api/releases',
    '/api/pr-diff',
    '/api/events',
  ]) {
    assert.ok(api.includes(route), `API route ${route} is represented`);
  }
  assert.match(api, /credentials|JSON\.stringify\(settings\)/);
  assert.match(api, /SETUP_REQUIRED/);
});

test('shared visual tokens preserve the Cold Room surface and compact type contract', () => {
  const css = read('styles.css');
  const tokens = read('styles/tokens.css');
  for (const token of [
    '--bg: #111113',
    '--panel: #1c1d20',
    '--panel2: #232427',
    '--accent: #67e8f9',
    '--font-text:',
    '--font-mono:',
  ])
    assert.ok(
      (css + tokens).replace(/\s+/g, ' ').includes(token),
      `theme token ${token} is declared`,
    );
  assert.match(css, /@import ['"]\.\/styles\/(?:tokens|base)\.css['"]/);
  assert.match(css, /\.home-cols\s*\{\s*columns:\s*1;/);
  assert.match(css, /@media\s*\(min-width:\s*760px\)[\s\S]*?\.home-cols\s*\{\s*columns:\s*2;/);
  assert.match(css, /@media\s*\(min-width:\s*1700px\)[\s\S]*?\.home-cols\s*\{\s*columns:\s*3;/);
  assert.match(css, /\.grid\s*\{\s*display:\s*grid;\s*grid-template-columns:\s*minmax\(0, 1fr\);/);
  assert.match(css, /\.home-block\s*\{\s*break-inside:\s*avoid;/);
  assert.match(css, /\.ticket-card\s*\+\s*\.ticket-card[\s\S]*?margin-top:\s*20px;/);
});

test('React panels own structural rendering and compose shared React components', () => {
  const components = [
    'Primitives.jsx',
    'PrCard.jsx',
    'SprintPill.jsx',
    'PrActions.jsx',
    'Tooltip.jsx',
    'DiffViewer.jsx',
    'Terminal.jsx',
    'Listbox.jsx',
    'Spinner.jsx',
  ];
  for (const name of components)
    assert.ok(fs.existsSync(path.join(root, 'components', name)), `${name} exists`);
  const panels = [
    'HomePanel.jsx',
    'ServicesPanel.jsx',
    'PrsPanel.jsx',
    'MyTicketsPanel.jsx',
    'ReleasesPanel.jsx',
    'SettingsPanel.jsx',
  ];
  for (const name of panels) {
    const source = read(`panels/${name}`);
    assert.doesNotMatch(
      source,
      /PanelAdapter|create(?:Home|Service|Pr|MyTickets|Releases|Settings)Panel/,
    );
    assert.match(source, /components\/Primitives\.jsx/);
    assert.match(source, /<Card\b/);
    assert.match(source, /<Button\b/);
  }
  for (const name of ['HomePanel.jsx', 'PrsPanel.jsx', 'MyTicketsPanel.jsx', 'ReleasesPanel.jsx']) {
    const source = read(`panels/${name}`);
    assert.doesNotMatch(
      source,
      /<Markup\b|(?:prOpenListHtml|prDraftSectionHtml|prApprovalSectionHtml|prUatPromoteSectionHtml|myTicketsHtml|releaseGroupHtml|sprintCardHtml|actionGroupHtml|serviceStripRowHtml|kpiRowHtml|velocityChartHtml)/,
      `${name} renders its structural/list content through React`,
    );
  }
  for (const name of ['Markup.jsx', 'PrCard.jsx', 'SprintPill.jsx']) {
    assert.doesNotMatch(
      read(`components/${name}`),
      /innerHTML|dangerouslySetInnerHTML/,
      `${name} does not replace React-owned DOM with HTML strings`,
    );
  }
  assert.match(read('components/PrCard.jsx'), /export function PrItem/);
  assert.match(read('components/PrCard.jsx'), /export function TicketPrCard/);
  assert.match(read('components/HomeCards.jsx'), /export function HomeSprintCard/);
  assert.match(read('components/HomeCards.jsx'), /export function ServiceStrip/);
  assert.match(read('components/WorkTicket.jsx'), /export function MyTicketsGroups/);
  assert.match(read('components/ReleaseCards.jsx'), /export function ReleaseGroups/);
  assert.match(read('components/Terminal.jsx'), /useState/);
  assert.match(read('components/Listbox.jsx'), /listboxMove/);
  assert.match(read('components/DiffViewer.jsx'), /openDiffViewer/);
});

test('production and build contract tests isolate or serialize all access to dist/', () => {
  const production = fs.readFileSync(
    fileURLToPath(new URL('../test/production-ui.test.mjs', import.meta.url)),
    'utf8',
  );
  const build = fs.readFileSync(
    fileURLToPath(new URL('../test/ui-build-contract.test.mjs', import.meta.url)),
    'utf8',
  );
  assert.match(production, /acquireDistTestLock/);
  assert.match(build, /--outDir.*buildRoot/);
  assert.match(build, /mkdtempSync/);
});
