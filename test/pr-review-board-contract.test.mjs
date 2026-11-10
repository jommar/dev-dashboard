import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as api from '../ui-react/lib/api.js';

const read = (file) => {
  const url = new URL(`../ui-react/${file}`, import.meta.url);
  assert.ok(fs.existsSync(url), `ui-react/${file} exists`);
  return fs.readFileSync(url, 'utf8');
};

test('Pull Requests directly adopts the shared board shell instead of PR sections or wrappers', () => {
  const panel = read('panels/PrsPanel.jsx');
  const imported =
    panel.match(/import \{([^}]*)\} from ['"]\.\.\/components\/BoardShell\.jsx['"]/)?.[1] ?? '';
  for (const name of [
    'BoardPanel',
    'BoardSection',
    'Board',
    'BoardColumn',
    'BoardNote',
    'BoardState',
    'RefreshControl',
  ]) {
    assert.match(imported, new RegExp(`\\b${name}\\b`), `${name} comes from BoardShell`);
    assert.match(panel, new RegExp(`<${name}\\b`), `${name} is rendered`);
  }
  assert.match(panel, /<BoardPanel\b[^>]*\bid="prs"[^>]*>\s*<BoardSection\b/);
  assert.match(panel, /<BoardSection\b[^>]*\bname="prs"/);
  assert.doesNotMatch(
    panel,
    /PrActions|TicketPrCard|pr-open-section|pr-draft-section|pr-approval-section|pr-uat-promote-section/,
  );
});

test('the board element is memoized independently of countdown ticks and reuses shared scroll preservation', () => {
  const panel = read('panels/PrsPanel.jsx');
  const memo = panel.match(/const (\w+) = useMemo\(\s*\(\) => \(?\s*<Board\b[\s\S]*?\n {2}\);/);
  assert.ok(memo, 'the board element, not just its data, is memoized like My Tickets');
  assert.doesNotMatch(memo[0], /\bcountdown\b/, 'clock ticks do not invalidate the board');
  assert.match(
    panel.slice(panel.indexOf('return (', panel.indexOf(memo[0]) + memo[0].length)),
    new RegExp(`\\b${memo[1]}\\b`),
  );
  assert.match(read('components/BoardShell.jsx'), /usePreservedInteraction\(ref\)/);
  assert.doesNotMatch(
    panel,
    /usePreservedInteraction\(/,
    'the shared Board owns scroll preservation',
  );
});

test('RefreshControl receives the guarded hook-returned load and the existing 90-second cadence', () => {
  const panel = read('panels/PrsPanel.jsx');
  const poll = panel.match(/const \{([^}]*)\} = useActivePolling\(\{([\s\S]*?)\}\)/);
  assert.ok(poll, 'the panel uses active polling');
  const guarded = poll[1].match(/\bload:\s*(\w+)/)?.[1];
  assert.ok(guarded, 'the hook-returned guarded loader is retained');
  assert.match(poll[2], /interval:\s*PR_POLL_MS/);
  assert.match(panel, new RegExp(`<RefreshControl\\b[^>]*\\bonRefresh=\\{${guarded}\\}`));
  assert.match(panel, /<RefreshControl\b[^>]*\bname="prs"/);
  assert.match(panel, /api\.getReviewTickets\(/);
  assert.doesNotMatch(
    panel,
    /api\.(?:getPrs|getTicketPrs)\(/,
    'legacy own-author feeds do not define this queue',
  );
});

test('the board renders stable ticket/lane handles from the full-snapshot selector and keeps warning states', () => {
  const panel = read('panels/PrsPanel.jsx');
  assert.match(panel, /from ['"]\.\.\/\.\.\/ui\/review-board\.js['"]/);
  assert.match(panel, /\breviewColumns\(/);
  assert.match(panel, /<Board\b[^>]*\btestId="prs-board"/);
  assert.match(panel, /<BoardColumn\b[^>]*\btestIdPrefix="prs-column-"/);
  assert.match(panel, /<ReviewTicketCard\b/);
  assert.match(panel, /prCoverage/);
  assert.match(panel, /watched repositor/i, 'the configured discovery boundary is visible');
  for (const testId of ['prs-error', 'prs-loading', 'prs-empty', 'prs-no-matches']) {
    assert.ok(panel.includes(testId), `${testId} remains distinct`);
  }
  assert.match(panel, /last update|last successful|stale/i);
  assert.match(panel, /incomplete|unavailable/i);
});

test('the shared API exposes a dedicated review-ticket read without changing legacy API exports', () => {
  assert.equal(typeof api.getReviewTickets, 'function', 'getReviewTickets is exported');
  const source = read('lib/api.js');
  assert.match(source, /(?:getJson|fetch)\(['"]\/api\/review-tickets['"]\)/);
  for (const name of [
    'getPrs',
    'getMyTickets',
    'getTicketPrs',
    'getPrDiff',
    'getClaudeTickets',
    'launchClaude',
    'answerClaude',
  ]) {
    assert.equal(typeof api[name], 'function', `${name} remains exported`);
  }
});

test('PR presentation filters retain search/repository/review and retire the Section schema and control', () => {
  const source = read('components/WorkFilters.jsx');
  const schema = source.match(/const SCHEMAS = \{[\s\S]*?\bprs:\s*\{([^}]*)\}/)?.[1] ?? '';
  const selects =
    source.match(/const SELECTS = \{[\s\S]*?\bprs:\s*\[([\s\S]*?)\n {2}\]/)?.[1] ?? '';
  for (const name of ['search', 'repo', 'review']) assert.match(schema, new RegExp(`\\b${name}:`));
  assert.match(selects, /['"]repo['"]/);
  assert.match(selects, /['"]review['"]/);
  assert.doesNotMatch(schema, /\bsection\b/);
  assert.doesNotMatch(selects, /['"]section['"]|['"]Section['"]/);
});

test('ticket prefix is a PR-only control wired to the shared key helper and existing selector', () => {
  const source = read('components/WorkFilters.jsx');
  const schema = source.match(/const SCHEMAS = \{[\s\S]*?\bprs:\s*\{([^}]*)\}/)?.[1] ?? '';
  const selects =
    source.match(/const SELECTS = \{[\s\S]*?\bprs:\s*\[([\s\S]*?)\n {2}\]/)?.[1] ?? '';
  assert.match(schema, /\bprefix:/);
  assert.match(selects, /\['prefix', 'Ticket prefix'\][\s\S]*\['repo', 'Repository'\]/);
  for (const view of ['tickets', 'actions', 'sprint']) {
    const fields = source.match(new RegExp(`\\b${view}:\\s*\\{([^}]*)\\}`))?.[1] ?? '';
    assert.doesNotMatch(fields, /\bprefix:/, `${view} filters do not gain a prefix control`);
  }
  const panel = read('panels/PrsPanel.jsx');
  const selectorSource = fs.readFileSync(new URL('../ui/review-board.js', import.meta.url), 'utf8');
  for (const [name, content] of [
    ['panel', panel],
    ['selector', selectorSource],
  ]) {
    assert.match(
      content,
      /import\s*\{[^}]*\bticketPrefix\b[^}]*\}\s*from ['"][^'"]*work-filters\.js['"]/,
      name,
    );
    assert.match(content, /\bticketPrefix\(/, `${name} calls the shared helper`);
  }
  assert.match(panel, /useState\(\{[^}]*\bprefix:\s*''/);
  assert.match(panel, /<WorkFilters\b[^>]*\boptions=\{options\}/);
  assert.match(panel, /reviewColumns\(rows,\s*data\?\.prCoverage,\s*filters\)/);
});

test('lane header help is optional shared DashboardTooltip presentation, owned by the PR panel', () => {
  const shell = read('components/BoardShell.jsx');
  const props = shell.match(/export function BoardColumn\(\{([^}]*)\}/)?.[1] ?? '';
  assert.match(props, /\bhint\b/, 'BoardColumn accepts an optional hint');
  assert.match(
    shell,
    /import\s*\{[^}]*\bDashboardTooltip\b[^}]*\}\s*from ['"]\.\/Primitives\.jsx['"]/,
  );
  assert.match(shell, /<DashboardTooltip\b[^>]*\bdescribeChild\b/);
  assert.match(shell, /<DashboardTooltip\b[^>]*\btitle=\{hint\}/);
  assert.match(shell, /<h3\b[^>]*\btabIndex=/, 'hinted heading is keyboard reachable');
  assert.match(read('panels/PrsPanel.jsx'), /<BoardColumn\b[^>]*\bhint=\{/);
  for (const file of ['components/TicketBoard.jsx', 'panels/SlackPanel.jsx']) {
    const columns = [...read(file).matchAll(/<BoardColumn\b[^>]*>/g)];
    assert.ok(columns.length, `${file} renders shared columns`);
    for (const [column] of columns) {
      assert.doesNotMatch(column, /\bhint=/, `${file} retains its no-hint default`);
    }
  }
});

test('review ticket cards use shared card surfaces and safe repo-labelled links with a separate diff button', () => {
  const card = read('components/ReviewTicketCard.jsx');
  assert.match(card, /export function ReviewTicketCard\b|export const ReviewTicketCard\b/);
  assert.match(card, /className="board-card\b/);
  assert.match(card, /board-card-summary/);
  assert.match(card, /prs-ticket-\$\{ticket\.key\}/);
  assert.match(card, /ticket\.summary/);
  assert.match(card, /ticket\.sprint/);
  assert.match(card, /pr\.repo/);
  assert.match(card, /pr\.number/);
  assert.match(card, /pr\.draft/);
  assert.match(card, /pr\.review|reviewText\(/);
  assert.match(card, /prCoverage/);
  assert.match(card, /No linked open PRs/);
  assert.match(
    card,
    /incomplete|unavailable/i,
    'incomplete empty discovery is not no-PR certainty',
  );
  assert.match(card, /aria-label=|data-tooltip=|title=/, 'full repository identity can be named');
  assert.match(card, /target="_blank"/);
  assert.match(card, /rel="noopener noreferrer"/);
  if (/<DiffViewer\b/.test(card)) {
    assert.match(card, /<DiffViewer\b[^>]*\brepo=\{pr\.repo\}[^>]*\bnumber=\{pr\.number\}/);
    assert.match(read('components/DiffViewer.jsx'), /openDiffViewer\(event\.currentTarget\)/);
  } else {
    assert.match(card, /openDiffViewer\(event\.currentTarget\)/);
    assert.match(card, /data-repo=\{pr\.repo\}/);
    assert.match(card, /data-number=\{pr\.number\}/);
  }
  for (const [link] of card.matchAll(/<a\b[\s\S]*?<\/a>/g)) {
    assert.doesNotMatch(
      link,
      /<(?:button|Button|ClaudeIcon|DiffViewer)\b/,
      'links never wrap buttons',
    );
  }
  assert.doesNotMatch(card, /innerHTML|dangerouslySetInnerHTML|draggable|onDrag/);
});

test('the PR Claude entry opts out of shared tooltips but retains code-review naming and scoped test ids', () => {
  const icon = read('components/ClaudeIcon.jsx');
  const props = icon.match(/export function ClaudeIcon\(\{([\s\S]*?)\}\)/)?.[1] ?? '';
  assert.match(props, /\btestId\b/);
  assert.match(props, /\blabel\b/);
  assert.match(props, /\btooltip\s*=\s*true/, 'tooltips remain the shared default');
  assert.match(icon, /claude-icon-\$\{ticketKey\}/, 'the My Tickets default id is retained');
  const card = read('components/ReviewTicketCard.jsx');
  const control = card.match(/<ClaudeIcon\b[\s\S]*?\/>/)?.[0] ?? '';
  assert.match(control, /testId=/);
  assert.match(control, /label=/);
  assert.match(control, /tooltip=\{false\}/);
  assert.match(control, /Claude code review for \$\{ticket\.key\}/);
  assert.doesNotMatch(control, /placeholder/i);
  assert.doesNotMatch(control, /\bentry=/, 'no invented workflow state is passed to the icon');
});

test('ClaudePlaceholderDialog keeps the native shell and adds only review launch, re-review and feedback beside Close', () => {
  const dialog = read('components/ClaudePlaceholderDialog.jsx');
  assert.match(dialog, /export function ClaudePlaceholderDialog\b/);
  assert.match(dialog, /<dialog\b/);
  assert.match(dialog, /className="claude-dialog"/);
  assert.match(dialog, /aria-labelledby=\{/);
  assert.match(dialog, /\{ticketKey\}/);
  assert.match(dialog, /\{summary\}/);
  assert.match(dialog, /data-testid="prs-claude-dialog-body"/);
  assert.match(dialog, /Start code review/);
  assert.match(dialog, /pr-review-transact/);
  assert.match(
    dialog,
    /StatePill/,
    'the state is the shared pill, which words it with claudePhrase',
  );
  assert.match(dialog, /disabled=/);
  assert.equal(
    (dialog.match(/<(?:Button|button)\b/g) ?? []).length,
    3,
    'Start code review, Re-review and Close are the only controls',
  );
  assert.match(dialog, /Re-review/);
  assert.match(dialog, />\s*Close\s*<\/(?:Button|button)>/);
  assert.doesNotMatch(
    dialog,
    /<ClaudeDialog\b|ClaudePromptsEditor|ClaudeRow|<form\b|<input\b|<textarea\b|innerHTML|dangerouslySetInnerHTML|Go to session/,
  );
});

test('the review dialog uses native modal cleanup, parent-owned Escape and genuine backdrop presses', () => {
  const dialog = read('components/ClaudePlaceholderDialog.jsx');
  assert.match(dialog, /\.showModal\(\)/);
  assert.match(dialog, /addEventListener\(['"]cancel['"]/);
  assert.match(dialog, /removeEventListener\(['"]cancel['"]/);
  assert.match(dialog, /preventDefault\(\)/);
  assert.match(dialog, /return \(\) => \{/);
  assert.match(dialog, /\.close\(\)/);
  assert.match(dialog, /onPointerDown=/);
  assert.match(dialog, /onClick=/);
  assert.match(dialog, /event\.target === \w+\.current/);
  assert.match(dialog, /&&\s*\w+\.current/, 'click dismissal also checks where the press began');
  assert.match(dialog, /onClose/);
});

test('review dialog selection lives outside lane cards and restores focus only through its PR-scoped opener', () => {
  const panel = read('panels/PrsPanel.jsx');
  const dialog = read('components/ClaudePlaceholderDialog.jsx');
  assert.match(panel, /const \[\w*[Cc]laude\w*,\s*set\w+\] = useState\(null\)/);
  assert.match(panel, /<ClaudePlaceholderDialog\b[\s\S]*?resolveOpener=/);
  assert.ok(
    panel.indexOf('<ClaudePlaceholderDialog') > panel.lastIndexOf('</BoardSection>'),
    'selection is not owned by a card or memoized board',
  );
  assert.ok(
    panel.indexOf('<ClaudePlaceholderDialog') < panel.indexOf('</BoardPanel>'),
    'the modal belongs to the panel',
  );
  assert.match(panel, /useEffect\([\s\S]*?!active[\s\S]*?set\w+\(null\)/);
  assert.match(
    panel,
    /\.find\(\(ticket\) => ticket\.key ===/,
    'eligibility is resolved from ticket data',
  );
  assert.match(
    panel,
    /(?:\w+\.current\??\.|getElementById\(['"]panel-prs['"]\)\??\.)querySelector\(/,
    'the opener lookup is rooted in this board or panel',
  );
  assert.match(dialog, /resolveOpener/);
  assert.match(dialog, /\.focus\(\{\s*preventScroll:\s*true\s*\}\)/);
  assert.doesNotMatch(
    `${panel}\n${dialog}`,
    /document\s*\.querySelector\(\s*[`'"]\[data-testid=["']claude-icon-/,
    'a hidden My Tickets icon cannot win a global lookup',
  );
});

test('the review screen reuses the existing Claude hook without a workflow dialog, direct transport or progress store', () => {
  const panel = read('panels/PrsPanel.jsx');
  assert.match(panel, /useClaudeTickets\(\{/);
  assert.match(panel, /<ClaudePlaceholderDialog\b[\s\S]*?\blaunch=/);
  const sources = [
    'panels/PrsPanel.jsx',
    'components/ReviewTicketCard.jsx',
    'components/ClaudePlaceholderDialog.jsx',
  ]
    .map(read)
    .join('\n');
  assert.doesNotMatch(
    sources,
    /(?:from ['"][^'"]*\/ClaudeDialog\.jsx)|<ClaudeDialog\b|ClaudePromptsEditor|\b(?:launchClaude|answerClaude|getClaudeTickets|getClaudePrompts|saveClaudePrompt|resetClaudePrompt)\b|\/api\/claude\//,
  );
  assert.doesNotMatch(
    sources,
    /\b(?:localStorage|sessionStorage)\b|\b(?:draggable|onDragStart|onDrop)\b|\bfetch\(/,
  );
});

test('shared board CSS loads before PR-domain styles and the PR sheet does not fork board geometry', () => {
  const root = read('styles.css');
  const board = root.search(/@import ['"]\.\/styles\/board\.css['"]/);
  const prs = root.search(/@import ['"]\.\/styles\/prs\.css['"]/);
  assert.ok(board >= 0 && prs > board, 'board.css loads before prs.css');
  const domain = read('styles/prs.css');
  assert.doesNotMatch(
    domain,
    /(?:^|\n)\s*\.board-(?:panel|section|frame|track|column|toolbar|body)\b[^{}]*\{/,
  );
});
