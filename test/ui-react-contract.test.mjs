import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../ui-react/', import.meta.url));
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const readRepoFile = (file) =>
  fs.readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');

// The declarations of every rule whose selector names `attribute`, joined.
const rulesFor = (css, attribute) =>
  [...css.matchAll(/([^{}]*)\{([^}]*)\}/g)]
    .filter(([, selector]) => selector.includes(attribute))
    .map(([, , body]) => body)
    .join('\n');

// The shared board frame and the Jira ticket-card sheet it is layered under.
const BOARD_SHEETS = ['styles/board.css', 'styles/my-tickets.css'];

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
    '/api/ticket-prs',
    '/api/releases',
    '/api/pr-diff',
    '/api/slack/status',
    '/api/slack/threads',
    '/api/slack/thread?ts=',
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

test('Services composes the shared console shell and states without a second polling owner', () => {
  const panel = read('panels/ServicesPanel.jsx');
  for (const name of ['BoardPanel', 'BoardSection', 'BoardState']) {
    assert.match(panel, new RegExp(`<${name}\\b`), `Services renders ${name}`);
  }
  assert.match(panel, /<BoardPanel\b[^>]*\bid="services"/);
  assert.match(panel, /<BoardSection\b[^>]*\bname="services"/);
  assert.match(panel, /className="board-pane services-pane"/);
  assert.match(panel, /className="grid service-grid"/);
  assert.match(panel, /data-testid="service-grid"/);
  assert.match(panel, /data-follow-version=/);
  assert.doesNotMatch(panel, /useActivePolling|new EventSource|setInterval/);
  assert.doesNotMatch(panel, /<BoardPanel\b[^>]*\bonClick=/);
});

test('Services styles are scoped token rules with explicit responsive grid columns', () => {
  const css = read('styles/services.css');
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, 'Services colours come from tokens');
  assert.match(
    css,
    /\.services-pane\s+\.service-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/,
  );
  for (const [width, columns] of [
    [760, 2],
    [1700, 3],
  ]) {
    assert.match(
      css,
      new RegExp(
        `@media\\s*\\(min-width:\\s*${width}px\\)[\\s\\S]*?\\.services-pane\\s+\\.service-grid\\s*\\{[^}]*grid-template-columns:\\s*repeat\\(${columns}, minmax\\(0, 1fr\\)\\)`,
      ),
    );
  }
  const selectors = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)]
    .map(([, selector]) => selector.trim())
    .filter((selector) => !selector.startsWith('@'))
    .flatMap((selector) => selector.split(','));
  for (const selector of selectors)
    assert.match(
      selector.trim(),
      /^(?:\.services?[-\w]*|#panel-services)\b/,
      `${selector.trim()} stays Services-scoped`,
    );
  assert.doesNotMatch(
    css,
    /(?:height|min-height):\s*calc\([^;]*100(?:d?vh)/,
    'viewport fill belongs to the shared shell',
  );
});

test('checkout 23: the checkout picker is a native select with a native modal and the app tooltip', () => {
  const picker = read('components/ServiceCheckoutPicker.jsx');
  assert.match(picker, /<select\b/, 'a native select, not a custom popup');
  assert.match(picker, /showModal\(/, 'the confirm is a native modal dialog');
  assert.match(picker, /DashboardTooltip/, 'the badge uses the app tooltip');
  assert.doesNotMatch(picker, /Listbox/, 'no custom listbox');
  assert.doesNotMatch(picker, /<[a-z][\w-]*\b[^<>]*\stitle=/, 'no native title attribute');
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
    'TicketBoard.jsx',
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
    'DevtoolsPanel.jsx',
    'SettingsPanel.jsx',
  ];
  for (const name of panels) {
    const source = read(`panels/${name}`);
    assert.doesNotMatch(
      source,
      /PanelAdapter|create(?:Home|Service|Pr|MyTickets|Releases|Settings)Panel/,
    );
    // The board screens get their card and their Refresh button from the shared board shell.
    assert.match(source, /components\/(?:Primitives|BoardShell)\.jsx/);
    assert.match(source, /<Card\b|<BoardSection\b/);
    assert.match(source, /<Button\b|<RefreshControl\b/);
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
  // The My Tickets board replaced the category/status groups; the row stays for Home.
  assert.match(read('components/TicketBoard.jsx'), /export function TicketBoard/);
  assert.doesNotMatch(read('components/WorkTicket.jsx'), /MyTicketsGroups/);
  assert.match(read('components/WorkTicket.jsx'), /export function WorkTicketRow/);
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
  assert.match(panel, /notifySlackSessionChanged\('slack'\)/);

  // Rows arrive immediately while the server enriches "Needs reply" in the
  // background, so the panel must chase the enriched snapshot a bounded number
  // of times and must not claim "All caught up" while the flags are still null.
  assert.match(panel, /const ENRICH_RETRY_MS = 2_000;/);
  assert.match(panel, /const ENRICH_RETRY_LIMIT = 3;/);
  // An unresolved individual reply is also unknown, even when enrichment ended.
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

  // Counts describe loaded threads and never claim complete coverage.
  assert.match(panel, /items\.some\(\(thread\) => thread\.needsReply == null\)/);
  assert.match(panel, /Checking replies… · \$\{needsReply\} loaded need a reply/);
  assert.match(panel, /\$\{needsReply\} loaded threads need a reply/);
  assert.doesNotMatch(panel, /All caught up/);
  assert.ok(
    panel.indexOf('Checking replies…') > -1 &&
      panel.indexOf('Checking replies…') < panel.indexOf('loaded threads need a reply'),
    'the checking state precedes the loaded-scope reply count',
  );
});

test('My Tickets rows open their Slack thread in an in-app dialog', () => {
  // Presentational only: the glyph, the tooltip and the text a screen reader
  // needs — every control carries its own tooltip and accessible name, and the
  // click hands the thread to the panel's dialog rather than navigating.
  const link = read('components/SlackThreadLink.jsx');
  assert.match(link, /export function SlackThreadLinks\(/);
  assert.match(link, /className="slack-thread-link"/);
  assert.match(link, /<DashboardTooltip\b[^>]*\btitle=\{label\}/);
  assert.doesNotMatch(link, /data-tooltip|\stitle="/);
  assert.match(link, /aria-label=\{/);
  assert.match(link, /<button/);
  assert.match(link, /type="button"/);
  assert.match(link, /onClick=\{\(\) => onOpen\?\.\(thread\)\}/);
  assert.doesNotMatch(link, /href=/);
  assert.match(link, /timeAgo/);
  // Icon only, drawn not shipped: no <img>, no text node, a currentColor glyph
  // hidden from assistive tech because the button's label already says it all.
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
  const slackHook = read('hooks/useTicketSlackThreads.jsx');
  assert.match(slackHook, /getSlackThreads\(\)/);
  assert.match(slackHook, /threadsByTicket\([\s\S]*?eligibleSlackRoot\(row\.ts, now\)/);
  assert.match(panel, /linksByTicket=\{linksByTicket\}/);
  // Slack must never sit on the ticket path: its call starts before the ticket
  // request is awaited, and is never awaited itself.
  const slackCall = panel.indexOf('loadSlack();');
  const ticketsAwait = panel.indexOf('await api.getMyTickets');
  assert.ok(slackCall > -1, 'the ticket load fires a Slack load');
  assert.ok(ticketsAwait > -1, 'the ticket load awaits the ticket request');
  assert.ok(slackCall < ticketsAwait, 'Slack is loaded before the ticket request is awaited');
  assert.doesNotMatch(panel, /await loadSlack\(/, 'Slack is never awaited on the ticket path');
  // PR status is optional the same way: fired before the ticket request is
  // awaited, never awaited itself, so tickets render without waiting for GitHub.
  const prsCall = panel.indexOf('loadPrs();');
  assert.ok(prsCall > -1, 'the ticket load fires a PR load');
  assert.ok(prsCall < ticketsAwait, 'PRs are loaded before the ticket request is awaited');
  assert.doesNotMatch(panel, /await loadPrs\(/, 'PRs are never awaited on the ticket path');
  assert.match(panel, /api\.getTicketPrs\(/);
  // A failed Slack call must leave the ticket list alone rather than reject the
  // unawaited promise.
  assert.match(slackHook, /catch \{\s*if \(id === request\.current\) setSnapshot\(null\);/);

  // The card renders the links on its first line, so it stays one account of
  // the ticket; the board resolves the same normalised key the matcher produced
  // and forwards the thread with the selected card's key to the dialog opener.
  const row = read('components/TicketBoard.jsx');
  assert.match(row, /from '\.\/TicketLaunchers\.jsx'/);
  // The board hands the row the whole maps and its card's key; finding the ticket's threads (by the
  // normalised key the matcher produced) and its Claude entry is the row component's own job, and
  // the clicked card forwards its displayed key without normalising it.
  const launchers = read('components/TicketLaunchers.jsx');
  assert.doesNotMatch(row, /normalizeTicketKey/);
  assert.match(row, /<TicketLaunchers\s[^>]*ticketKey=\{ticket\.key\}/);
  assert.match(row, /linksByTicket=\{linksByTicket\}/);
  assert.match(row, /claudeByTicket=\{claudeByTicket\}/);
  assert.match(row, /onOpenThread=\{onOpenThread\}/);
  assert.match(launchers, /linksByTicket\?\.get\(normalizeTicketKey\(ticketKey\)\)/);
  assert.match(launchers, /claudeByTicket\?\.\[ticketKey\]/);
  assert.match(
    launchers,
    /<SlackThreadLinks\s+links=\{links\}\s+onOpen=\{\(thread\) =>\s*onOpenThread\?\.\(\{\s*\.\.\.thread,\s*selectedTicketKey:\s*ticketKey\s*\}\)\s*\}\s*\/>/,
  );

  const css = read('styles/my-tickets.css');
  assert.match(css, /\.my-ticket-slack\s*\{/);
  assert.match(css, /\.slack-thread-link\s*\{/);
  // The new rules read the palette from tokens, never from a literal colour.
  const slackCss = css.slice(css.indexOf('.my-ticket-slack'));
  assert.doesNotMatch(slackCss, /#[0-9a-f]{3,8}\b/i, 'Slack link colours come from tokens');
});

test('the Slack thread dialog renders the conversation without leaving the app', () => {
  assert.ok(
    fs.existsSync(path.join(root, 'components', 'SlackThreadDialog.jsx')),
    'SlackThreadDialog.jsx exists',
  );
  const dialog = read('components/SlackThreadDialog.jsx');
  assert.match(
    dialog,
    /export function SlackThreadDialog\(\{\s*thread,\s*onClose,\s*resolveOpener,\s*isEligible,\s*sessionIdentity,\s*onSessionMismatch,\s*\}\)/,
  );
  assert.match(dialog, /openerResolver\.current\?\.\(ts\)/);
  assert.match(dialog, /showModal\(\)/, 'the dialog opens modally');
  assert.doesNotMatch(dialog, /dangerouslySetInnerHTML|innerHTML/, 'mrkdwn is rendered as tokens');
  assert.match(dialog, /aria-labelledby=\{titleId\}/);
  // A response that lands after the dialog closed must not repaint it.
  assert.match(dialog, /if \(!live \|\| request\.current !== id\) return;/);
  assert.match(dialog, /getSlackThread\(ts\)/);
  assert.match(dialog, /await getSlackStatus\(\)/);
  assert.match(dialog, /slackSessionIdentity\(status, sessionIdentity\) !== sessionIdentity/);
  assert.match(dialog, /parseSlackText/);
  assert.match(dialog, /slack-thread-dialog-title/);
  assert.match(dialog, /slack-thread-dialog-body/);
  assert.match(dialog, /slack-thread-message-\$\{message\.ts\}/);
  assert.match(dialog, /data-testid="slack-thread-copy"/);
  assert.match(dialog, /data-testid="slack-thread-open"/);
  assert.match(dialog, /data-testid="slack-thread-close"/);
  assert.match(dialog, /copyText\(url\)/);
  assert.match(dialog, /setCopy\('copied'\)/);
  assert.match(dialog, /Couldn&apos;t copy/);
  assert.match(dialog, /noopener noreferrer/);
  assert.match(dialog, /if \(!thread\) return null;/);

  // The renderer is a real module the dialog imports, not parsing inlined here.
  assert.ok(
    fs.existsSync(fileURLToPath(new URL('../ui/slack-mrkdwn.js', import.meta.url))),
    'ui/slack-mrkdwn.js exists',
  );
  const renderer = fs.readFileSync(
    fileURLToPath(new URL('../ui/slack-mrkdwn.js', import.meta.url)),
    'utf8',
  );
  assert.match(renderer, /export function parseSlackText/);
  assert.match(dialog, /import \{ parseSlackText \} from '\.\.\/\.\.\/ui\/slack-mrkdwn\.js';/);

  const api = read('lib/api.js');
  assert.match(api, /export async function getSlackThread\(ts\)/);
  assert.match(api, /\/api\/slack\/thread\?ts=\$\{encodeURIComponent\(ts\)\}/);
  assert.match(api, /if \(!res\.ok\) return \{ available: false \};/);

  // The panel owns the open thread; the shared hook wires the dialog and the panel renders it
  // inside its section (see the hook test below).
  const panel = read('panels/MyTicketsPanel.jsx');
  assert.match(
    read('hooks/useTicketSlackThreads.jsx'),
    /const \[openThread, setOpenThread\] = useState\(null\);/,
  );
  assert.match(panel, /onOpenThread=\{openThread\}/);
  assert.match(panel, /useTicketSlackThreads\(\{[^}]*\bsource: 'my-tickets'/);
  assert.ok(
    panel.indexOf('{dialog}') > panel.lastIndexOf('</BoardSection>') &&
      panel.indexOf('{dialog}') < panel.indexOf('</BoardPanel>'),
    'the dialog is rendered after the card, inside the panel',
  );

  const css = read('styles/slack.css');
  for (const selector of [
    '.slack-thread-dialog',
    '.slack-thread-dialog[open]',
    '.slack-thread-dialog-body',
    '.slack-message',
    '.slack-message-avatar',
    '.slack-message-head',
    '.slack-message-body',
    '.slack-message-code',
    '.slack-day-divider',
    '.slack-copy-feedback',
  ]) {
    assert.ok(css.includes(selector), `${selector} is styled`);
  }
  assert.match(css, /\.slack-thread-dialog::backdrop\s*\{/);
  assert.match(css, /width:\s*min\(760px, 92vw\)/);
  // Tokens only: the dialog introduces no literal colours.
  const dialogCss = css.slice(css.indexOf('.slack-thread-dialog'));
  assert.doesNotMatch(dialogCss, /#[0-9a-f]{3,8}\b/i, 'dialog colours come from tokens');
});

test('the Slack tab opens thread conversations in the shared dialog', () => {
  const panel = read('panels/SlackPanel.jsx');
  // One dialog implementation for the whole dashboard: the panel gets it from the hook My Tickets
  // already uses rather than growing a second copy.
  assert.match(panel, /useSlackThreadDialog\(\{[^}]*\bsource: 'slack'/);
  assert.match(panel, /const \[openThread, setOpenThread\] = useState\(null\);/);
  // Rendered with the section, not inside the thread card that unmounts on
  // disconnect, so an open conversation is not torn down by a status change.
  const card = panel.indexOf('<BoardSection');
  const cardEnd = panel.lastIndexOf('</BoardSection>');
  const dialog = panel.indexOf('{dialog}');
  const panelEnd = panel.indexOf('</BoardPanel>');
  assert.ok(card > -1 && cardEnd > card, 'the panel renders one board card');
  assert.ok(dialog > cardEnd, 'the dialog is rendered after the card, outside it');
  assert.ok(dialog < panelEnd, 'the dialog lives inside the panel section');

  // A row is a button now: it hands the thread to the dialog instead of
  // navigating, so the dashboard tab keeps whatever it was showing.
  assert.match(panel, /<button[\s\S]*?className="[^"]*(?<![\w-])board-card-action(?![\w-])/);
  assert.doesNotMatch(
    panel,
    /href=\{thread\.url\}/,
    'the row no longer links out of the dashboard',
  );
  assert.doesNotMatch(panel, /target="_blank"/);
  // The rows stay addressable exactly as they were, plus the affordance that
  // says a click opens a dialog.
  assert.match(panel, /aria-haspopup="dialog"/);
  assert.match(panel, /data-testid=\{`slack-thread-\$\{thread\.ts\}`\}/);

  // The row is a button wearing the shared board card, so the button reset and the hover and focus
  // tint live with the card shell rather than in slack.css.
  const css = read('styles/board.css');
  const block = css.match(/\.board-card-action\s*\{([^}]*)\}/)?.[1];
  assert.ok(block, 'the button variant of the board card is styled');
  for (const declaration of [
    'width: 100%',
    'text-align: left',
    'font: inherit',
    'cursor: pointer',
  ]) {
    assert.ok(block.includes(declaration), `.board-card-action declares ${declaration}`);
  }
  for (const state of ['hover', 'focus-visible']) {
    assert.match(
      rulesFor(css, `.board-card-action:${state}`),
      /var\(--accent\)/,
      `.board-card-action:${state} takes the accent`,
    );
  }

  // A mentions row previews the mentioning message, so the list text alone cannot
  // name the ticket: without a selected card key, the dialog falls back to the
  // preview and then the loaded root message's plain text, and keeps its plain
  // title when neither does. Nothing is cached in a ref or effect.
  const dialogSource = read('components/SlackThreadDialog.jsx');
  assert.match(
    dialogSource,
    /const ticketKey =\s*thread\.selectedTicketKey\s*\|\|\s*ticketKeyFromThread\(thread\.text\)\s*\|\|\s*ticketKeyFromThread\(messages\[0\]\?\.text\);/,
    'the selected card key takes priority, with the preview and thread root as fallbacks',
  );
  assert.doesNotMatch(
    dialogSource,
    /ticketKeyFromThread\(messages\[0\]\?\.mrkdwn\)/,
    'the fallback reads the cleaned text, not mrkdwn',
  );
  assert.match(
    dialogSource,
    /const title = ticketKey \? `\$\{ticketKey\} · Slack thread` : 'Slack thread';/,
  );
  assert.doesNotMatch(dialogSource, /useRef\(ticketKey|useMemo\(\(\) => ticketKey/);
});

test('Slack and My Tickets wire the thread dialog through one hook, not two copies', () => {
  const hook = read('hooks/useSlackThreadDialog.jsx');
  // The hook is where the dialog element, the clock, the expiry rule and the session reaction live.
  const element = hook.match(/<SlackThreadDialog\b[\s\S]*?\/>/)?.[0] ?? '';
  for (const prop of [
    'thread',
    'onClose',
    'resolveOpener',
    'isEligible',
    'sessionIdentity',
    'onSessionMismatch',
  ])
    assert.match(element, new RegExp(`\\b${prop}=`), `the dialog element passes ${prop}`);
  assert.match(hook, /useSlackActivityClock\(/);
  assert.match(hook, /eligibleSlackRoot\(/);
  assert.match(hook, /addEventListener\('slack-session-changed'/);
  assert.match(hook, /event\.detail\?\.source/);
  assert.match(hook, /notifySlackSessionChanged\(/);

  // Each panel only passes what is its own; none keeps a copy of the wiring.
  // (My Tickets and Pull Requests reach it through useTicketSlackThreads, which is itself a user.)
  assert.match(read('hooks/useTicketSlackThreads.jsx'), /from '\.\/useSlackThreadDialog\.jsx'/);
  for (const file of ['panels/MyTicketsPanel.jsx', 'panels/PrsPanel.jsx'])
    assert.match(read(file), /from '\.\.\/hooks\/useTicketSlackThreads\.jsx'/, `${file} uses it`);
  for (const file of [
    'panels/SlackPanel.jsx',
    'panels/MyTicketsPanel.jsx',
    'panels/PrsPanel.jsx',
  ]) {
    const panel = read(file);
    if (file === 'panels/SlackPanel.jsx')
      assert.match(panel, /from '\.\.\/hooks\/useSlackThreadDialog\.jsx'/, `${file} uses the hook`);
    assert.doesNotMatch(
      panel,
      /<SlackThreadDialog\b|useSlackActivityClock|slack-session-changed/,
      `${file} leaves the dialog wiring to the hook`,
    );
  }
});

test('keeping a scroll place, per re-render and per view, shares one read and one write', () => {
  const shared = read('hooks/usePreservedInteraction.js');
  assert.match(shared, /export function readScroll\b/);
  assert.match(shared, /export function writeScroll\b/);
  const section = read('hooks/useSectionScroll.js');
  assert.match(
    section,
    /import \{[^}]*\breadScroll\b[^}]*\bwriteScroll\b[^}]*\} from '\.\/usePreservedInteraction\.js'/,
  );
  // Neither hook reads or writes an offset itself, so a change to how places are kept is made once.
  for (const source of [
    shared.slice(shared.indexOf('export function usePreservedInteraction')),
    section,
  ]) {
    assert.match(source, /readScroll\(/);
    assert.match(source, /writeScroll\(/);
    assert.doesNotMatch(source, /\.scroll(?:Top|Left)\b/);
  }
});

test('the shared API boundary carries every Slack watch route as a literal', () => {
  const api = read('lib/api.js');
  const hasLiteral = (route) =>
    [`'${route}'`, `"${route}"`, `\`${route}\``].some((literal) => api.includes(literal));
  for (const route of [
    '/api/slack/watch',
    '/api/slack/watch/links',
    '/api/slack/watch/remove',
    '/api/slack/watch/attach',
    '/api/slack/watch/detach',
    '/api/slack/watch/sessions',
    '/api/slack/watch/settings',
    '/api/slack/watch/pause',
    '/api/slack/watch/resume',
  ]) {
    assert.ok(hasLiteral(route), `API route ${route} is represented as a literal`);
  }
});

test('the Slack watch card composes the shared primitives, lists links in a table and guards its poll', () => {
  assert.ok(
    fs.existsSync(path.join(root, 'components', 'SlackWatchCard.jsx')),
    'SlackWatchCard.jsx exists',
  );
  const card = read('components/SlackWatchCard.jsx');
  assert.match(card, /export const SlackWatchCard = memo\(/);
  const primitives = card.match(/import \{([^}]*)\} from '\.\/Primitives\.jsx';/);
  assert.ok(primitives, 'the card imports from Primitives.jsx');
  assert.match(primitives[1], /\bButton\b/);
  assert.match(card, /<Button\b/);
  // The watcher is the third view of the Slack card: a pane of the board shell, not a card of its own.
  assert.match(card, /board-pane/);
  assert.doesNotMatch(card, /<Card\b/);
  // The poll belongs to a visible tab only, the same guard the thread list uses.
  assert.match(card, /document\.hidden/);
  // Links are tabular records, not a card list, so the masonry pattern does not apply.
  assert.match(card, /<table\b/);
  assert.match(card, /<thead\b/);
  assert.match(card, /<th\b/);
});

test('delivery statuses and reasons are pinned against the backend sources, the stylesheet and the README', () => {
  const statuses = ['delivered', 'waiting', 'failed-transient', 'failed-permanent'];
  const deliveryReasons = [
    'woke_itself',
    'resumed',
    'inbox_only',
    'not_listed',
    'awaiting_wake',
    'settling',
    'live_at_resume',
    'append_failed',
    'listing_unavailable',
    'spawn_failed',
    'timed_out',
    'stop_failed',
    'untrusted_workspace',
    'resume_forked',
    'never_idle',
    'ambiguous_id',
  ];
  // Stop results are not delivery reasons; `unavailable` is how a failed Slack read is recorded.
  const tolerableCodes = ['stopped', 'not_idle', 'unavailable'];

  const backend = ['backend/slack-watcher.mjs', 'backend/claude-sessions.mjs'].map(readRepoFile);
  const reasonProperty = /\breason:\s*'([a-z_]+)'/g;
  const outcomeCall = /\b(?:failure|delivered|waiting)\(\s*'([a-z_-]+)'(?:\s*,\s*'([a-z_-]+)')?/g;
  const reasonLiterals = backend.flatMap((source) => [
    ...[...source.matchAll(reasonProperty)].map(([, reason]) => reason),
    ...[...source.matchAll(outcomeCall)].flatMap(([, first, second]) => [first, second]),
  ]);
  const unexpectedReasons = new Set(
    reasonLiterals.filter(
      (literal) =>
        literal && ![...statuses, ...deliveryReasons, ...tolerableCodes].includes(literal),
    ),
  );

  const stylesheet = read('styles/slack.css');
  const hasStatusRule = (status) =>
    new RegExp(`\\.slack-watch-delivery\\[data-status=(['"])${status}\\1\\]`).test(stylesheet);
  const readme = readRepoFile('README.md');

  const problems = [
    ...(reasonLiterals.length ? [] : ['the reason scan found no literal in either backend source']),
    ...deliveryReasons
      .filter((reason) => !backend.some((source) => source.includes(`'${reason}'`)))
      .map((reason) => `no backend source names the reason '${reason}'`),
    ...[...unexpectedReasons].map(
      (reason) => `a backend source uses the unpinned reason '${reason}'`,
    ),
    ...statuses
      .filter((status) => !hasStatusRule(status))
      .map((status) => `slack.css has no rule for the status '${status}'`),
    ...[...statuses, ...deliveryReasons]
      .filter((code) => !readme.includes(`\`${code}\``))
      .map((code) => `the README does not name \`${code}\``),
  ];
  assert.deepEqual(problems, []);
});

test('wake flow: the check route and the poll countdown stay, the step fields and the grace wait are gone, and the 15 s settle gap is named once', () => {
  const watcher = readRepoFile('backend/slack-watcher.mjs');
  const httpApp = readRepoFile('backend/http-app.mjs');
  const api = read('lib/api.js');
  const watchComponents = path.join(root, 'components', 'slack-watch');
  const uiSource = [
    read('components/SlackWatchCard.jsx'),
    ...fs
      .readdirSync(watchComponents)
      .map((file) => read(path.join('components', 'slack-watch', file))),
  ].join('\n');
  const readme = readRepoFile('README.md');
  const checkRoute = '/api/slack/watch/check';
  const hasLiteral = (source, text) =>
    [`'${text}'`, `"${text}"`, `\`${text}\``].some((literal) => source.includes(literal));
  const names = (source, name) => new RegExp(`\\b${name}\\b`).test(source);
  const retiredBackendNames = ['nextStepAt', 'WAKE_STEPS', 'stepOf', 'WAKE_GRACE_MS'];
  const retiredUiPatterns = [
    ['nextStepAt', /\bnextStepAt\b/],
    ['delivery.step or delivery.steps', /\bdelivery\??\.steps?\b/],
    ['the next step countdown label', /next step in/],
    ['the step row test id', /slack-watch-step/],
  ];
  const retiredReadmePatterns = [
    ['`nextStepAt`', /`nextStepAt`/],
    ['`step`', /`step`/],
    ['`steps`', /`steps`/],
    ['WAKE_GRACE_MS', /\bWAKE_GRACE_MS\b/],
    ['a step count such as 1 of 3', /\b\d of 3\b/],
    ['the next step countdown', /next step in/],
  ];
  const settleGapLiterals = watcher.match(/\b15_000\b/g) ?? [];
  const readmeParagraphs = readme.split(/\n\s*\n/);

  const problems = [
    ...['nextCheckAt', 'checkNow', 'SETTLE_MS', 'WAKE_DEADLINE_MS']
      .filter((name) => !names(watcher, name))
      .map((name) => `the watcher source does not name ${name}`),
    ...retiredBackendNames
      .filter((name) => names(watcher, name))
      .map((name) => `the watcher source still names ${name}`),
    ...(/export const SETTLE_MS = 15_000;/.test(watcher)
      ? []
      : ['the watcher does not export SETTLE_MS as 15_000']),
    ...(settleGapLiterals.length === 1
      ? []
      : [`the watcher names 15_000 ${settleGapLiterals.length} times, not once`]),
    ...(/\b90_000\b/.test(watcher) ? ['the watcher still names the old 90_000 gap'] : []),
    ...(hasLiteral(httpApp, `POST ${checkRoute}`)
      ? []
      : [`http-app.mjs has no POST ${checkRoute}`]),
    ...(hasLiteral(api, checkRoute) ? [] : [`api.js has no literal ${checkRoute}`]),
    ...['nextCheckAt', 'Check now']
      .filter((text) => !names(uiSource, text))
      .map((text) => `the Watch threads card sources do not use ${text}`),
    ...retiredUiPatterns
      .filter(([, pattern]) => pattern.test(uiSource))
      .map(([label]) => `the Watch threads card sources still use ${label}`),
    ...(readme.includes(checkRoute) ? [] : [`the README does not name ${checkRoute}`]),
    ...(readme.includes('`nextCheckAt`') ? [] : ['the README does not name `nextCheckAt`']),
    ...(readme.includes('Check now') ? [] : ['the README does not name the Check now button']),
    ...(readmeParagraphs.some((text) => text.includes('`SETTLE_MS`') && /\b15 s/.test(text))
      ? []
      : ['no README paragraph pairs `SETTLE_MS` with the 15 s settle gap']),
    ...retiredReadmePatterns
      .filter(([, pattern]) => pattern.test(readme))
      .map(([label]) => `the README still names ${label}`),
  ];
  assert.deepEqual(problems, []);
});

test('the Slack panel mounts the watch card as an active-aware section', () => {
  const panel = read('panels/SlackPanel.jsx');
  assert.match(panel, /import \{ SlackWatchCard \} from '\.\.\/components\/SlackWatchCard\.jsx';/);
  assert.match(panel, /<SlackWatchCard\b[^>]*\bactive=\{active\}/);
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

const readUiFile = (file) =>
  fs.readFileSync(fileURLToPath(new URL(`../ui/${file}`, import.meta.url)), 'utf8');

test('My Tickets is a focusable ticket board built on the DOM-free board helper', () => {
  assert.ok(
    fs.existsSync(fileURLToPath(new URL('../ui/ticket-board.js', import.meta.url))),
    'ui/ticket-board.js exists',
  );
  const helper = readUiFile('ticket-board.js');
  for (const name of ['boardColumns', 'ciSummaryText', 'reviewText']) {
    assert.match(helper, new RegExp(`export function ${name}\\b`), `${name} is exported`);
  }
  assert.doesNotMatch(helper, /\b(?:document|window)\./, 'the helper is DOM-free');
  assert.doesNotMatch(helper, /backend\//, 'the helper ships in the browser bundle');

  const board = read('components/TicketBoard.jsx');
  assert.match(board, /from '\.\.\/\.\.\/ui\/ticket-board\.js'/);
  assert.match(board, /ciSummaryText\(/, 'the PR line words its CI through the helper');
  assert.match(board, /reviewText\(/, 'the PR line words its review through the helper');
  // A scroll region of its own, reachable and scrollable from the keyboard: the shared `Board` owns the
  // region, and the ticket board names it and keeps its test id.
  assert.match(board, /<Board\b[^>]*\btestId="my-tickets-board"/);
  assert.match(board, /<Board\b[^>]*\blabel="Ticket board"/);
  const shell = read('components/BoardShell.jsx');
  assert.match(shell, /role="region"/);
  assert.match(shell, /tabIndex=\{0\}/);
  for (const part of ['my-tickets-column-', 'my-tickets-pr-']) {
    assert.ok(board.includes(part), `${part}<…> test ids are rendered`);
  }
  assert.match(board, /data-ci-state=/);
  assert.match(board, /data-in-current-sprint=/);
  // A PR line is a link out, and a link to a new tab never hands over the opener.
  assert.match(board, /target="_blank"/);
  assert.match(board, /rel="noopener noreferrer"/);
  assert.doesNotMatch(board, /innerHTML|dangerouslySetInnerHTML|<Markup\b/);
  assert.doesNotMatch(board, /\p{Extended_Pictographic}|\p{Emoji_Presentation}/u, 'no emoji');

  const panel = read('panels/MyTicketsPanel.jsx');
  assert.match(panel, /import \{ TicketBoard \} from '\.\.\/components\/TicketBoard\.jsx';/);
  assert.match(panel, /<TicketBoard\b/);
  assert.doesNotMatch(panel, /MyTicketsGroups/);
  assert.match(`${panel}\n${board}`, /boardColumns\(/);
  assert.match(shell, /usePreservedInteraction/, 'scroll survives poll re-renders');
  // The note that tells the user PR status is stale lives in the toolbar.
  assert.match(panel, /testId="my-tickets-prs-note"/);
  // Kept for the existing specs and for the error state. The section and list ids are the shell's
  // `<name>-section` and `<name>-list`, so naming the section keeps them.
  assert.match(panel, /<BoardSection\b[^>]*\bname="my-tickets"/);
  assert.match(panel, /testId="my-tickets-error"/);
  assert.match(shell, /\$\{name\}-section/);
  assert.match(shell, /\$\{name\}-list/);
});

test('My Tickets and Slack are two consumers of one board shell, not two copies of it', () => {
  const shell = read('components/BoardShell.jsx');
  for (const name of [
    'BoardPanel',
    'BoardSection',
    'RefreshControl',
    'BoardTabs',
    'BoardNote',
    'BoardState',
    'Board',
    'BoardColumn',
  ]) {
    assert.match(shell, new RegExp(`export function ${name}\\b`), `${name} is a shared export`);
  }
  for (const file of ['panels/MyTicketsPanel.jsx', 'panels/SlackPanel.jsx']) {
    const source = read(file);
    const imported = source.match(
      /import \{([^}]*)\} from '\.\.\/components\/BoardShell\.jsx'/,
    )?.[1];
    for (const name of ['BoardPanel', 'BoardSection']) {
      assert.match(imported ?? '', new RegExp(`\\b${name}\\b`), `${file} imports ${name}`);
      assert.match(source, new RegExp(`<${name}\\b`), `${file} renders ${name}`);
    }
  }
  for (const file of ['components/TicketBoard.jsx', 'panels/SlackPanel.jsx']) {
    assert.match(read(file), /<Board\b/, `${file} renders the shared Board`);
  }

  // Slack styles itself with the shared classes: no My Tickets name, no private tab, board or
  // unresolved-section class, and nothing for the removed block.
  const panel = read('panels/SlackPanel.jsx');
  assert.doesNotMatch(panel, /my-tickets-/);
  assert.doesNotMatch(panel, /className=["{`'][^"}`']*\bslack-(?:board|tab|unknown)/);
  assert.doesNotMatch(panel, /Activity time unavailable/);
  assert.doesNotMatch(read('styles/slack.css'), /\.slack-(?:section|tab|board|unknown)/);

  // The shared sheet loads before the panel sheets that override it.
  const rootCss = read('styles.css');
  const importAt = (sheet) =>
    rootCss.search(new RegExp(`@import ['"]\\./styles/${sheet}\\.css['"]`));
  assert.ok(importAt('board') > -1, 'styles.css imports board.css');
  assert.ok(importAt('board') < importAt('my-tickets'), 'board.css loads before my-tickets.css');
  assert.ok(importAt('board') < importAt('slack'), 'board.css loads before slack.css');
});

test('the My Tickets masonry is gone while Home, PR-tab and Slack rules stay', () => {
  const css = read('styles/my-tickets.css');
  const rootCss = read('styles.css');
  for (const selector of [
    '.my-ticket-groups',
    '.my-ticket-status-group',
    '.my-ticket-category-head',
    '.my-ticket-status-head',
  ]) {
    assert.ok(!css.includes(selector), `${selector} is removed from my-tickets.css`);
    assert.ok(!rootCss.includes(selector), `${selector} is removed from styles.css`);
  }
  // Still used by Home's sprint rows, the PR tab's sprint pill and the Slack glyph.
  for (const kept of ['.my-ticket', '.my-ticket-key', '.ticket-sprint', '.my-ticket-slack']) {
    assert.ok(css.includes(`${kept} {`) || css.includes(`${kept}[`), `${kept} is kept`);
  }
  assert.match(rootCss, /\.release-ticket-groups/, 'the Releases masonry is untouched');
});

test('the board scrolls inside itself, snaps, clamps the summary and scopes the compact toolbar', () => {
  const css = BOARD_SHEETS.map(read).join('\n');
  assert.match(css, /overflow-x:\s*auto/);
  assert.match(css, /scroll-snap-type:\s*x\b/);
  assert.match(css, /overscroll-behavior-x:\s*contain/);
  assert.match(css, /-webkit-line-clamp:\s*2\b/, 'a summary shows two lines');
  assert.match(css, /\.board-toolbar\b/, 'the compact filters are scoped to the toolbar');
  assert.doesNotMatch(
    css,
    /(?<![\w-])columns:\s*\d/,
    'columns are board tracks, never multi-column masonry',
  );
});

test('the board stylesheets use tokens only, short transitions and honour reduced motion', () => {
  const sheets = BOARD_SHEETS.map(read);
  for (const css of sheets) {
    assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, 'colours come from tokens, never a hex literal');
    // Every transition is short and names its properties: colour and background only.
    const declarations = [...css.matchAll(/transition(?:-duration|-property)?\s*:\s*([^;}]+)/g)];
    for (const [, value] of declarations) {
      for (const [, amount, unit] of value.matchAll(/(\d*\.?\d+)\s*(ms|s)\b/g)) {
        const ms = unit === 's' ? Number(amount) * 1000 : Number(amount);
        assert.ok(ms <= 200, `transition "${value.trim()}" stays within 200 ms`);
      }
      assert.doesNotMatch(value, /\ball\b/, 'transition names its properties');
    }
    // Radii come from the tokens (10 px card) or a literal of at most 12 px.
    for (const [, value] of css.matchAll(/border-radius\s*:\s*([^;}]+)/g)) {
      for (const [, px] of value.matchAll(/(\d*\.?\d+)px/g)) {
        assert.ok(Number(px) <= 12, `border-radius "${value.trim()}" is at most 12 px`);
      }
    }
  }
  const css = sheets.join('\n');
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /tabular-nums/, 'counts and numbers do not jiggle');
  const tokens = read('styles/tokens.css');
  const radius = Number(tokens.match(/--radius:\s*(\d+)px/)?.[1]);
  assert.ok(radius <= 12, 'the shared card radius token is at most 12 px');
});

test('the DevTools sheet stays token-only, short and DevTools-scoped', () => {
  const css = read('styles/devtools.css');
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, 'colours come from tokens, never a hex literal');
  assert.doesNotMatch(css, /(?<![\w-])columns:\s*\d/, 'the wall is a uniform grid, not masonry');
  // The recurring bug of this repo: a `display: grid` with no column rule is one column forever.
  const wall = css.match(/\.devtools-wall\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(wall, /display:\s*grid/);
  assert.match(
    wall,
    /grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(\d+px,\s*1fr\)\)/,
    'the wall names its columns',
  );
  const declarations = [...css.matchAll(/transition(?:-duration|-property)?\s*:\s*([^;}]+)/g)];
  for (const [, value] of declarations) {
    for (const [, amount, unit] of value.matchAll(/(\d*\.?\d+)\s*(ms|s)\b/g)) {
      const ms = unit === 's' ? Number(amount) * 1000 : Number(amount);
      assert.ok(ms <= 200, `transition "${value.trim()}" stays within 200 ms`);
    }
    assert.doesNotMatch(value, /\ball\b/, 'transition names its properties');
  }
  for (const [, value] of css.matchAll(/border-radius\s*:\s*([^;}]+)/g)) {
    for (const [, px] of value.matchAll(/(\d*\.?\d+)px/g)) {
      assert.ok(Number(px) <= 12, `border-radius "${value.trim()}" is at most 12 px`);
    }
  }
  assert.match(
    css,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)/,
    'the sheet carries its own block',
  );
  assert.match(css, /tabular-nums/, 'the port does not jiggle');
  // The sheet carries only its own domain rules; nothing here reaches another screen.
  const selectors = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)]
    .map(([, selector]) => selector.trim())
    .filter((selector) => !selector.startsWith('@'))
    .flatMap((selector) => selector.split(','));
  for (const selector of selectors)
    assert.match(selector.trim(), /^\.devtools\b/, `${selector.trim()} stays DevTools-scoped`);
});

test('a DevTools tile is view-only: it can watch a browser but never send it input or a tab', () => {
  const tile = read('components/DevtoolsTile.jsx');
  assert.doesNotMatch(
    tile,
    /sendDevtoolsInput|selectDevtoolsTab|screencast-input|createInputQueue/,
  );
  assert.doesNotMatch(tile, /onMouse|onKey|onWheel|onPointer/, 'no input handler on a tile');
  assert.match(tile, /devtoolsStream\.watch\(id, 'tile'/, 'a tile watches at tile quality');
  // One shared stream: nothing but the stream client opens an EventSource for the wall.
  for (const file of [
    'components/DevtoolsTile.jsx',
    'components/DevtoolsViewer.jsx',
    'hooks/useScreencast.js',
  ])
    assert.doesNotMatch(
      read(file),
      /new EventSource|openDevtoolsStream/,
      `${file} opens no stream`,
    );
});

test('the primary routes are unchanged', () => {
  assert.match(
    read('components/AppTabs.jsx'),
    /const PRIMARY_ROUTES = new Set\(\['home', 'my-tickets', 'slack'\]\);/,
    'DevTools joins the tools row, never the primary one',
  );
});

// -- comment chips, the attached Slack chip and the all-approved card -------------------------------

const EMOJI = /\p{Extended_Pictographic}|\p{Emoji_Presentation}/u;

test('the board helper exports the comment and approval helpers and the PR line and card use them', () => {
  const helper = readUiFile('ticket-board.js');
  for (const name of ['commentChips', 'commentSummaryText', 'allPrsApproved']) {
    assert.match(helper, new RegExp(`export function ${name}\\b`), `${name} is exported`);
  }
  assert.doesNotMatch(helper, /\b(?:document|window)\./, 'the helper stays DOM-free');
  assert.doesNotMatch(helper, /backend\//, 'the helper ships in the browser bundle');

  const board = read('components/TicketBoard.jsx');
  const imported =
    board.match(/import \{([^}]*)\} from '\.\.\/\.\.\/ui\/ticket-board\.js'/)?.[1] ?? '';
  for (const name of ['commentChips', 'commentSummaryText', 'allPrsApproved']) {
    assert.match(
      imported,
      new RegExp(`\\b${name}\\b`),
      `${name} is imported from the board helper`,
    );
    assert.match(board, new RegExp(`\\b${name}\\(`), `${name} is called`);
  }
  // The states are in the markup for the stylesheet and for the specs, and each is also a word.
  assert.match(board, /data-all-approved=/);
  assert.match(board, /data-comment-state=/);
  assert.ok(board.includes('my-tickets-pr-comments-'), 'the comment chips render their test ids');
  // The card builds its ids with `testId(name)`, so the seal's id is `my-tickets-item-approved-<KEY>`.
  assert.match(
    board,
    /testId\('approved'\)|my-tickets-item-approved-/,
    'the seal renders its test id',
  );
  assert.match(board, /All PRs approved/, 'the seal is named in words');
  assert.doesNotMatch(board, /innerHTML|dangerouslySetInnerHTML|<Markup\b/);
  assert.doesNotMatch(board, EMOJI, 'no emoji: every glyph is inline SVG');
});

test('the Slack chip marks an attached session by a filled glyph and words, keeping its pinned contract', () => {
  const link = read('components/SlackThreadLink.jsx');
  assert.match(link, /attachedSessions/, 'the chip reads the count the threads route annotates');
  assert.match(link, /data-attached=/);
  assert.match(link, /Claude session attached/);
  assert.match(link, /Claude sessions attached/, 'a count above one is worded as sessions');
  // Shape and words carry the state; the stroke contract of the glyph is unchanged.
  assert.ok(
    (link.match(/currentColor/g) || []).length >= 2,
    'a stroke and a fill take the chip colour',
  );
  assert.match(link, /fill="none"/, 'the SVG itself keeps fill none');
  assert.match(link, /<button/);
  assert.match(link, /type="button"/);
  assert.doesNotMatch(link, /href=/);
  assert.doesNotMatch(link, /<img\b/);
  assert.doesNotMatch(link, /innerHTML|dangerouslySetInnerHTML/);
  assert.doesNotMatch(link, EMOJI, 'no emoji');
  assert.match(link, /if \(!links\.length\) return null;/, 'no thread still means no container');
});

test('the green card, the comment chips and the attached chip take their colours from tokens', () => {
  const css = read('styles/my-tickets.css');
  assert.doesNotMatch(css, EMOJI, 'no emoji in the stylesheet');

  const approved = rulesFor(css, 'data-all-approved');
  assert.ok(approved, 'a rule styles the all-approved card');
  // 8 % green over the card surface keeps --muted at 4.5:1 or better; 10 % does not.
  assert.match(approved, /color-mix\(in srgb,\s*var\(--green\)\s+8%,\s*var\(--panel2\)\)/);
  assert.match(
    approved,
    /var\(--green\)[^;]*inset|inset[^;]*var\(--green\)/,
    'a green inset hairline',
  );
  assert.match(approved, /var\(--shadow\)/, 'the shared shadow stack is kept');
  assert.doesNotMatch(approved, /#[0-9a-f]{3,8}\b/i, 'no hex literal');

  const attached = rulesFor(css, 'data-attached');
  assert.ok(attached, 'a rule styles the attached chip');
  assert.match(attached, /var\(--support\)/, 'the one token that means nothing else on the card');

  const open = rulesFor(css, 'data-comment-state');
  assert.ok(open, 'the comment chips are styled by their state');
  assert.match(open, /var\(--amber\)/, 'an open comment chip is amber');
  assert.match(open, /var\(--muted\)/, 'a resolved comment chip is muted');
});

test('the e2e check dialog uses the app tooltip and the shared stream, never a native title or its own stream', () => {
  const source = read('components/E2eCheckDialog.jsx');
  assert.doesNotMatch(source, /\btitle=/, 'no native title attribute');
  assert.doesNotMatch(source, /data-tooltip/, 'no data-tooltip');
  assert.doesNotMatch(
    source,
    /new EventSource|openDevtoolsStream/,
    'it opens no stream of its own',
  );
});

test('the e2e check styles in the Claude launcher sheet use tokens only and short transitions', () => {
  const css = read('styles/claude-launcher.css');
  const rules = [...css.matchAll(/([^{}]*)\{([^}]*)\}/g)].filter(([, selector]) =>
    selector.includes('.claude-e2e'),
  );
  assert.ok(rules.length > 0, 'the sheet styles the e2e check dialog');
  const body = rules.map(([, , declarations]) => declarations).join('\n');
  assert.doesNotMatch(body, /#[0-9a-f]{3,8}\b/i, 'colours come from tokens, never a hex literal');
  for (const [, value] of body.matchAll(/transition(?:-duration|-property)?\s*:\s*([^;}]+)/g)) {
    for (const [, amount, unit] of value.matchAll(/(\d*\.?\d+)\s*(ms|s)\b/g)) {
      const ms = unit === 's' ? Number(amount) * 1000 : Number(amount);
      assert.ok(ms <= 200, `transition "${value.trim()}" stays within 200 ms`);
    }
    assert.doesNotMatch(value, /\ball\b/, 'transition names its properties');
  }
});

test('question phase labels preserve accessible names', async () => {
  const jsx = read('components/ClaudeDialog.jsx');

  // The number, the phase and the tick sit outside the label, so its name is the question.
  const rowStart = jsx.indexOf('{questions.map(');
  const rowEnd = jsx.indexOf('<textarea', rowStart);
  assert.ok(rowStart > -1 && rowEnd > rowStart, 'the question row is the one render site');
  const row = jsx.slice(rowStart, rowEnd);
  assert.equal(
    (row.match(/className="claude-question-phase"/g) || []).length,
    1,
    'exactly one phase label per row',
  );

  // The label binds only the question text: any phase word inside it would join its name.
  const labelStart = row.indexOf('<label');
  const labelEnd = row.indexOf('</label>');
  assert.ok(labelStart > -1 && labelEnd > labelStart, 'the question label is present');
  assert.equal(
    row.slice(labelStart, labelEnd + '</label>'.length),
    '<label htmlFor={`${formId}-${id}`}>{question}</label>',
    'the label is the question-only binding',
  );
  assert.doesNotMatch(
    row.slice(labelStart, labelEnd),
    /phase|claude-question|<span/i,
    'no phase text or span inside the question label',
  );

  const phaseSpan = row.match(
    /<span[\s\S]*?className="claude-question-phase"[\s\S]*?<\/span>/,
  )?.[0];
  assert.ok(phaseSpan, 'the phase is its own span');
  assert.match(
    phaseSpan,
    /\{QUESTION_PHASE_LABEL\[\s*phase\s*\?\?\s*INVESTIGATE\s*\]\}/,
    'the span shows the question’s own phase, investigate when absent',
  );

  const phaseAt = row.indexOf('claude-question-phase');
  const tickAt = row.indexOf('claude-question-answered');
  assert.ok(labelEnd > -1 && labelEnd < phaseAt, 'after the question text and outside the label');
  assert.ok(tickAt === -1 || phaseAt < tickAt, 'before the answered tick');

  // Each phase word is the existing step label, never a second hard-coded copy.
  const mapStart = jsx.indexOf('const QUESTION_PHASE_LABEL');
  const mapEnd = jsx.indexOf('};', mapStart);
  assert.ok(mapStart > -1 && mapEnd > mapStart, 'the phase label map is declared');
  const phaseLabels = jsx.slice(mapStart, mapEnd + 2);
  assert.match(phaseLabels, /\[INVESTIGATE\]:\s*STEP_LABEL\.investigate\b/);
  assert.match(phaseLabels, /\[IMPLEMENT\]:\s*STEP_LABEL\.implement\b/);
  assert.doesNotMatch(phaseLabels, /['"`]/, 'the words come from STEP_LABEL, not literals');
  assert.doesNotMatch(jsx, /phaseWords/, 'not the session drawer’s phase words');

  // One rule, token-only, in the launcher sheet.
  const css = read('styles/claude-launcher.css');
  assert.equal(css.split('.claude-question-phase').length - 1, 1, 'exactly one rule');
  const body = rulesFor(css, '.claude-question-phase');
  assert.match(body, /flex:\s*none/);
  assert.match(body, /align-self:\s*center/);
  assert.match(body, /color:\s*var\(--muted\)/);
  assert.match(body, /font-size:\s*var\(--fs-xs\)/);
  assert.doesNotMatch(body, /#[0-9a-f]{3,8}\b|rgba?\(/i, 'colours come from tokens');

  // The e2e question factory carries the asking phase and leaves an untagged question untagged.
  const { claudeQuestion } = await import('../e2e/data.js');
  assert.deepEqual(claudeQuestion('q1', 'Which repo owns the fix?'), {
    id: 'q1',
    question: 'Which repo owns the fix?',
    answer: null,
  });
  assert.deepEqual(claudeQuestion('q1', 'Which repo owns the fix?', null, 'implement-plan'), {
    id: 'q1',
    question: 'Which repo owns the fix?',
    answer: null,
    phase: 'implement-plan',
  });
});

// -- Chat (plan scenario 20) -------------------------------------------------------------------------

test('scenario 20: chat.css loads after board.css and is token-only, short, small-radius and Chat-scoped', () => {
  const rootCss = read('styles.css');
  const importAt = (sheet) =>
    rootCss.search(new RegExp(`@import ['"]\\./styles/${sheet}\\.css['"]`));
  assert.ok(importAt('chat') > -1, 'styles.css imports chat.css');
  assert.ok(importAt('board') < importAt('chat'), 'board.css loads before chat.css');

  const css = read('styles/chat.css');
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, 'colours come from tokens, never a hex literal');
  // Every token it reads is one the app declares (in the shared sheets) or one the sheet declares.
  const declared = new Set(
    [read('styles/tokens.css'), rootCss, css].flatMap((sheet) =>
      [...sheet.matchAll(/(--[\w-]+)\s*:/g)].map(([, name]) => name),
    ),
  );
  for (const [, name] of css.matchAll(/var\((--[\w-]+)/g))
    assert.ok(declared.has(name), `${name} is a declared token`);
  assert.doesNotMatch(css, /(?<![\w-])columns:\s*\d/, 'a chat is not a masonry');
  assert.doesNotMatch(css, /scroll-behavior:\s*smooth/, 'scrolling is never smooth');
  for (const [, value] of css.matchAll(/transition(?:-duration|-property)?\s*:\s*([^;}]+)/g)) {
    for (const [, amount, unit] of value.matchAll(/(\d*\.?\d+)\s*(ms|s)\b/g)) {
      const ms = unit === 's' ? Number(amount) * 1000 : Number(amount);
      assert.ok(ms <= 200, `transition "${value.trim()}" stays within 200 ms`);
    }
    assert.doesNotMatch(value, /\ball\b/, 'transition names its properties');
  }
  for (const [, value] of css.matchAll(/border-radius\s*:\s*([^;}]+)/g))
    for (const [, px] of value.matchAll(/(\d*\.?\d+)px/g))
      assert.ok(Number(px) <= 12, `border-radius "${value.trim()}" is at most 12 px`);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*(?:reduce|no-preference)\)/);
  const selectors = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)]
    .map(([, selector]) => selector.trim())
    .filter((selector) => !selector.startsWith('@') && !/^(?:from|to|\d)/.test(selector))
    .flatMap((selector) => selector.split(/,(?![^(]*\))/));
  assert.ok(selectors.length > 0, 'the sheet has rules');
  for (const selector of selectors)
    assert.match(selector.trim(), /^\.chat\b/, `${selector.trim()} stays Chat-scoped`);
});

test('scenario 20: Chat is a tools-row tab, its components use no native title, its routes are literals', () => {
  assert.match(read('App.jsx'), /\{ id: 'chat', label: '[^']+'/, 'chat is one of the ready tabs');
  assert.match(
    read('components/AppTabs.jsx'),
    /const PRIMARY_ROUTES = new Set\(\['home', 'my-tickets', 'slack'\]\);/,
    'chat never joins the primary row',
  );
  for (const file of ['panels/ChatPanel.jsx', 'components/ChatTranscript.jsx']) {
    const source = read(file);
    assert.doesNotMatch(source, /<[a-z][\w-]*\b[^<>]*\stitle=/, `${file} has no native title`);
    assert.doesNotMatch(source, /data-tooltip/, `${file} uses the app tooltip`);
  }
  const api = read('lib/api.js');
  for (const route of ['/api/claude/chat/send', '/api/claude/chat/stop', '/api/claude/chat/stream'])
    assert.ok(api.includes(route), `API route ${route} is a literal in api.js`);
});
