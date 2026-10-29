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
    '/api/slack/status',
    '/api/slack/threads',
    '/api/slack/pending',
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
    'SlackThreadLink.jsx',
  ];
  for (const name of components)
    assert.ok(fs.existsSync(path.join(root, 'components', name)), `${name} exists`);
  const panels = [
    'HomePanel.jsx',
    'ServicesPanel.jsx',
    'PrsPanel.jsx',
    'MyTicketsPanel.jsx',
    'ReleasesPanel.jsx',
    'SlackPanel.jsx',
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

test('the Slack tab carries a pending-count badge and chases an enriched thread snapshot', () => {
  assert.ok(
    fs.existsSync(path.join(root, 'components', 'SlackTabBadge.jsx')),
    'SlackTabBadge.jsx exists',
  );
  const badge = read('components/SlackTabBadge.jsx');
  assert.match(badge, /tab-slack-badge/);
  assert.match(badge, /tab-badge-dot/);
  assert.match(badge, /useSlackPending/);
  const hook = read('hooks/useSlackPending.js');
  assert.match(hook, /getSlackPending/);
  assert.match(hook, /SLACK_POLL_MS/);
  assert.match(hook, /notifySlackSessionChanged/);
  assert.match(read('components/AppTabs.jsx'), /\{badge\}/);
  const app = read('App.jsx');
  assert.match(app, /from '\.\/components\/SlackTabBadge\.jsx'/);
  assert.match(app, /id: 'slack', label: 'Slack', badge: <SlackTabBadge \/>/);
  const panel = read('panels/SlackPanel.jsx');
  assert.match(panel, /notifySlackSessionChanged\(\)/);

  // Rows arrive immediately while the server enriches "Needs reply" in the
  // background, so the panel must chase the enriched snapshot a bounded number
  // of times and must not claim "All caught up" while the flags are still null.
  assert.match(panel, /const ENRICH_RETRY_MS = 2_000;/);
  assert.match(panel, /const ENRICH_RETRY_LIMIT = 3;/);
  // Only an explicit false means "still checking"; a missing field stays on the
  // old copy so a rolling start against an older backend behaves as before.
  assert.match(panel, /threads\?\.enriched === false/);
  assert.match(panel, /threads\?\.enriched !== false/);
  assert.match(panel, /setTimeout\([\s\S]*?\},\s*ENRICH_RETRY_MS,?\s*\)/);
  assert.match(panel, /attempts >= ENRICH_RETRY_LIMIT/);
  // The budget belongs to one snapshot: a new updatedAt starts a new count.
  assert.match(panel, /enrichRetries\.updatedAt === snapshot \? enrichRetries\.count : 0/);
  assert.match(panel, /setEnrichRetries\(\{ updatedAt: snapshot, count: attempts \+ 1 \}\)/);
  // The retry reuses loadThreads (and its existing inFlight guard) rather than
  // opening a second request path.
  assert.match(panel, /setEnrichRetries\(\{[\s\S]*?loadThreads\(\);/);
  assert.equal((panel.match(/const inFlight = useRef\(false\);/g) || []).length, 1);

  // Three meta states: honest "checking", the existing count, the caught-up copy.
  assert.match(panel, /Checking replies… · updated \$\{updatedLabel\}/);
  assert.match(panel, /`\$\{needsReply\} need a reply · updated \$\{updatedLabel\}`/);
  assert.match(panel, /`All caught up · updated \$\{updatedLabel\}`/);
  const metaBlock = panel.slice(panel.indexOf('data-testid="slack-threads-meta"'));
  assert.match(
    metaBlock,
    /checking[\s\S]*?Checking replies…[\s\S]*?need a reply[\s\S]*?All caught up/,
    'the checking state is a third branch before the reply count and caught-up copy',
  );
});

test('My Tickets rows link to their Slack threads and load them off the ticket path', () => {
  // Presentational only: the glyph, the link, and the text a hover or a screen
  // reader needs — every anchor carries its own tooltip and accessible name.
  const link = read('components/SlackThreadLink.jsx');
  assert.match(link, /export function SlackThreadLinks\(/);
  assert.match(link, /className="slack-thread-link"/);
  assert.match(link, /data-tooltip=\{/);
  assert.match(link, /aria-label=\{/);
  assert.match(link, /target="_blank"/);
  assert.match(link, /rel="noopener noreferrer"/);
  assert.match(link, /timeAgo/);
  // Icon only, drawn not shipped: no <img>, no text node, a currentColor glyph
  // hidden from assistive tech because the anchor's label already says it all.
  assert.match(link, /stroke="currentColor"/);
  assert.match(link, /fill="none"/);
  assert.match(link, /aria-hidden="true"/);
  assert.match(link, /focusable="false"/);
  assert.doesNotMatch(link, /<img\b/);
  // No match means no container at all, so a disconnected Slack renders the row
  // exactly as before.
  assert.match(link, /if \(!links\.length\) return null;/);

  // The panel fetches once per ticket load and groups with the shared module.
  const panel = read('panels/MyTicketsPanel.jsx');
  assert.match(panel, /getSlackThreads\(\)/);
  assert.match(panel, /threadsByTicket\(slackStarted\)/);
  assert.match(panel, /linksByTicket=\{linksByTicket\}/);
  // Slack must never sit on the ticket path: its call starts before the ticket
  // request is awaited, and is never awaited itself.
  const slackCall = panel.indexOf('loadSlack();');
  const ticketsAwait = panel.indexOf('await api.getMyTickets');
  assert.ok(slackCall > -1, 'the ticket load fires a Slack load');
  assert.ok(ticketsAwait > -1, 'the ticket load awaits the ticket request');
  assert.ok(slackCall < ticketsAwait, 'Slack is loaded before the ticket request is awaited');
  assert.doesNotMatch(panel, /await loadSlack\(/, 'Slack is never awaited on the ticket path');
  // A failed Slack call must leave the ticket list alone rather than reject the
  // unawaited promise.
  assert.match(panel, /catch \{\s*setSlackStarted\(\[\]\);/);

  // The row renders the links inside the key cell, so it stays one account of
  // the ticket; the group resolves the same normalised key the matcher produced.
  const row = read('components/WorkTicket.jsx');
  assert.match(row, /from '\.\/SlackThreadLink\.jsx'/);
  assert.match(row, /normalizeTicketKey/);
  assert.match(row, /slackLinks = \[\]/);
  assert.match(row, /<SlackThreadLinks links=\{slackLinks\} \/>/);
  assert.match(
    row,
    /slackLinks=\{linksByTicket\.get\(normalizeTicketKey\(ticket\.key\)\) \|\| \[\]\}/,
  );

  const css = read('styles/my-tickets.css');
  assert.match(css, /\.my-ticket-slack\s*\{/);
  assert.match(css, /\.slack-thread-link\s*\{/);
  // The new rules read the palette from tokens, never from a literal colour.
  const slackCss = css.slice(css.indexOf('.my-ticket-slack'));
  assert.doesNotMatch(slackCss, /#[0-9a-f]{3,8}\b/i, 'Slack link colours come from tokens');
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
