import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BOT_PHASES,
  DONE_TTL_MS,
  FADE_MS,
  NO_MEMORY,
  CALLOUT_AUTO_HIDE_MS,
  DONE_ZONE_SHARE,
  ZONES,
  ZONES_MIN_WIDTH_PX,
  walkStretch,
  zoneBounds,
  zoneOf,
  zoneSpots,
  CALLOUT_EXIT_MS,
  CALLOUT_PENDING_MS,
  CALLOUT_TEXT,
  IDLE_CYCLE_FACTOR,
  MAX_CALLOUTS,
  STROLL_CYCLE_FACTOR,
  addCallouts,
  attendCallout,
  botPose,
  liveCallouts,
  nextCalloutChange,
  rememberStates,
  sessionStates,
  settleChanges,
  stateChanges,
  botsFromTickets,
  dismissBot,
  hashOf,
  inActiveSprint,
  laneStyle,
  liveBots,
  nextSprintKeys,
  normalizeTicketKey,
  nextBotChange,
  pickMascot,
  rememberBots,
  restingSpots,
  walks,
  roamFor,
} from '../ui/bot-bar.js';

const FIVE = ['dux', 'wick', 'glim', 'pinch', 'pinch-crab'];
const SIX = [...FIVE, 'moss'];
const keys = (count) => Array.from({ length: count }, (_, i) => `TAP-${1000 + i}:review`);

// The shape of one GET /api/claude/tickets entry, only the parts the bar reads.
const entry = (phase, state, { review, groom } = {}) => ({
  phase,
  state,
  reason: 'r',
  review: review ?? { state: 'none', reason: null },
  groom: groom ?? { state: 'none', reason: null },
});

test('pickMascot is stable, always one of the ids and uses every id', () => {
  const picks = keys(1000).map((key) => pickMascot(key, FIVE));
  assert.deepEqual(
    picks,
    keys(1000).map((key) => pickMascot(key, FIVE)),
  );
  assert.ok(picks.every((id) => FIVE.includes(id)));
  const counts = Object.fromEntries(FIVE.map((id) => [id, picks.filter((p) => p === id).length]));
  for (const id of FIVE) assert.ok(counts[id] > 100, `${id} is used (${counts[id]} of 1000)`);
  assert.equal(pickMascot('TAP-1:review', ['only']), 'only');
  assert.equal(pickMascot('TAP-1:review', []), null);
});

test('pickMascot does not depend on the order of the ids', () => {
  for (const key of keys(200))
    assert.equal(pickMascot(key, FIVE), pickMascot(key, [...FIVE].reverse()));
});

test('adding a mascot moves about a sixth of the sessions, all of them to the new one', () => {
  const all = keys(1000);
  const before = all.map((key) => pickMascot(key, FIVE));
  const after = all.map((key) => pickMascot(key, SIX));
  const moved = all.filter((_, i) => before[i] !== after[i]);
  assert.ok(moved.length > 0, 'the new mascot is used');
  assert.ok(moved.length <= 1000 / 6 + 60, `${moved.length} of 1000 moved`);
  for (const key of moved) assert.equal(pickMascot(key, SIX), 'moss');
  assert.ok(after.every((id, i) => id === 'moss' || id === before[i]));
});

test('removing a mascot moves only the sessions that had it', () => {
  const without = FIVE.filter((id) => id !== 'glim');
  for (const key of keys(500)) {
    const was = pickMascot(key, FIVE);
    if (was !== 'glim') assert.equal(pickMascot(key, without), was);
    else assert.notEqual(pickMascot(key, without), 'glim');
  }
});

test('roamFor is deterministic and keeps every walk inside the bar', () => {
  for (const key of keys(300)) {
    const roam = roamFor(key);
    assert.deepEqual(roam, roamFor(key));
    assert.ok(roam.range >= 25 && roam.range <= 70);
    assert.ok(roam.from >= 0 && roam.from + roam.range <= 100);
    assert.ok(roam.seconds >= 14 && roam.seconds <= 28);
    assert.ok(roam.phase >= 0 && roam.phase < 1);
    assert.ok(roam.rest >= 0 && roam.rest <= 100);
    assert.ok(roam.facing === 'left' || roam.facing === 'right');
  }
  const starts = new Set(keys(50).map((key) => roamFor(key).from));
  assert.ok(starts.size > 20, 'bots do not all start at one place');
  assert.notDeepEqual(roamFor('TAP-1:review'), roamFor('TAP-1:implement'));
});

test('hashOf is a fixed 32-bit function, so a session keeps its look across machines', () => {
  assert.equal(hashOf(''), 0x811c9dc5);
  assert.equal(hashOf('a'), 0xe40c292c);
  assert.notEqual(hashOf('a', 'x'), hashOf('a', 'y'));
});

test('restingSpots keep done and failed bots apart and never reorder them', () => {
  const bots = keys(8).map((key) => ({ key }));
  const spots = restingSpots(bots);
  const placed = [...spots.values()].sort((a, b) => a - b);
  assert.equal(placed.length, 8);
  for (let i = 1; i < placed.length; i += 1) assert.ok(placed[i] - placed[i - 1] >= 11.9);
  assert.ok(placed[0] >= 0 && placed.at(-1) <= 100);
  assert.deepEqual(restingSpots(bots), spots);
  // Too many for the gap: still inside the bar, still apart.
  const crowd = restingSpots(keys(30).map((key) => ({ key })));
  const row = [...crowd.values()].sort((a, b) => a - b);
  assert.ok(row[0] >= 0 && row.at(-1) <= 100 && new Set(row).size === 30);
  // A lone bot keeps its own place.
  assert.equal(
    restingSpots([{ key: 'TAP-1:review' }]).get('TAP-1:review'),
    roamFor('TAP-1:review').rest,
  );
});

test('only the implement and review sessions get a bot', () => {
  assert.deepEqual(BOT_PHASES, ['implement', 'review']);
  const tickets = {
    'TAP-1': entry('investigate-and-plan', 'working'),
    'TAP-2': entry('implement-plan', 'working', {
      review: { state: 'done', reason: 'finished' },
      groom: { state: 'working', reason: 'running' },
    }),
    'TAP-3': entry('implement-plan', 'none'),
    'TAP-4': entry(null, 'none', { groom: { state: 'done', reason: 'finished' } }),
  };
  assert.deepEqual(
    botsFromTickets(tickets).map(({ key, state }) => [key, state]),
    [
      ['TAP-2:implement', 'working'],
      ['TAP-2:review', 'done'],
    ],
  );
});

test('a bot shows working, waiting, done or failed; none and unknown are left out', () => {
  const reviews = Object.fromEntries(
    ['working', 'waiting', 'done', 'failed', 'none', 'unknown', 'stopped', undefined].map(
      (state, i) => [`TAP-${i + 1}`, entry(null, 'none', { review: { state, reason: 'x' } })],
    ),
  );
  assert.deepEqual(
    botsFromTickets({ tickets: reviews }).map(({ state }) => state),
    ['working', 'waiting', 'done', 'failed'],
  );
});

test('bots come in a stable order whatever the order of the response', () => {
  const a = {
    'TAP-20': entry('implement-plan', 'done'),
    'TAP-3': entry('implement-plan', 'working', { review: { state: 'failed', reason: 'x' } }),
  };
  const b = { 'TAP-3': a['TAP-3'], 'TAP-20': a['TAP-20'] };
  assert.deepEqual(botsFromTickets(a), botsFromTickets(b));
  assert.deepEqual(
    botsFromTickets(a).map(({ key }) => key),
    ['TAP-20:implement', 'TAP-3:implement', 'TAP-3:review'],
  );
  assert.deepEqual(botsFromTickets(null), []);
  assert.deepEqual(botsFromTickets({ 'TAP-1': null, 'TAP-2': 'x' }), []);
});

test('a done bot leaves after its time to live and fades in the last stretch', () => {
  const bots = botsFromTickets({
    'TAP-1': entry('implement-plan', 'done'),
    'TAP-2': entry('implement-plan', 'working'),
  });
  const t0 = 1_000_000;
  let memory = rememberBots(NO_MEMORY, bots, t0);
  assert.equal(memory.seenDoneAt.get('TAP-1:implement'), t0);
  assert.equal(memory.seenDoneAt.size, 1, 'only a done bot has a clock');
  assert.equal(rememberBots(memory, bots, t0 + 5000), memory, 'the first time seen is kept');
  const at = (ms) => liveBots(bots, memory, t0 + ms).map(({ key, fading }) => [key, fading]);
  assert.deepEqual(at(0), [
    ['TAP-1:implement', false],
    ['TAP-2:implement', false],
  ]);
  assert.deepEqual(at(DONE_TTL_MS - FADE_MS), [
    ['TAP-1:implement', true],
    ['TAP-2:implement', false],
  ]);
  assert.deepEqual(at(DONE_TTL_MS), [['TAP-2:implement', false]]);
  assert.equal(nextBotChange(bots, memory, t0), DONE_TTL_MS - FADE_MS);
  assert.equal(nextBotChange(bots, memory, t0 + DONE_TTL_MS - FADE_MS), FADE_MS);
  assert.equal(nextBotChange(bots, memory, t0 + DONE_TTL_MS), null);
  // A done bot not seen yet counts as just seen; a custom time to live is honoured.
  assert.deepEqual(
    liveBots(bots, NO_MEMORY, t0).map(({ key }) => key),
    ['TAP-1:implement', 'TAP-2:implement'],
  );
  assert.deepEqual(
    liveBots(bots, memory, t0 + 61_000, { ttl: 60_000 }).map(({ key }) => key),
    ['TAP-2:implement'],
  );
  // A re-run forgets the clock; done again, it starts a new one.
  const rerun = botsFromTickets({ 'TAP-1': entry('implement-plan', 'working') });
  memory = rememberBots(memory, rerun, t0 + 10_000);
  assert.equal(memory.seenDoneAt.size, 0);
  memory = rememberBots(memory, bots, t0 + 20_000);
  assert.equal(memory.seenDoneAt.get('TAP-1:implement'), t0 + 20_000);
});

test('a dismissed bot stays away until its state changes', () => {
  const done = botsFromTickets({ 'TAP-1': entry('implement-plan', 'done') });
  const failed = botsFromTickets({ 'TAP-1': entry('implement-plan', 'failed') });
  const working = botsFromTickets({ 'TAP-1': entry('implement-plan', 'working') });
  let memory = dismissBot(rememberBots(NO_MEMORY, done, 0), done[0]);
  assert.deepEqual(liveBots(done, memory, 1), []);
  assert.deepEqual(liveBots(done, rememberBots(memory, done, 5), 6), []);
  memory = rememberBots(memory, failed, 10);
  assert.equal(liveBots(failed, memory, 11).length, 1, 'a new state brings it back');
  memory = dismissBot(memory, failed[0]);
  assert.deepEqual(liveBots(failed, memory, 12), []);
  assert.equal(dismissBot(memory, working[0]), memory, 'a working bot cannot be dismissed');
});

test('only bots whose ticket is in the active sprint pass, and an unknown sprint shows none', () => {
  const bots = botsFromTickets({
    'TAP-1': entry('implement-plan', 'working', { review: { state: 'done', reason: 'finished' } }),
    'TAP-2': entry('implement-plan', 'failed'),
    'TAP-3': entry(null, 'none', { review: { state: 'waiting', reason: 'blocked' } }),
  });
  const keysOf = (items) => items.map(({ key }) => key);
  assert.deepEqual(keysOf(inActiveSprint(bots, new Set(['TAP-1', 'TAP-3']))), [
    'TAP-1:implement',
    'TAP-1:review',
    'TAP-3:review',
  ]);
  assert.deepEqual(keysOf(inActiveSprint(bots, ['TAP-2'])), ['TAP-2:implement']);
  assert.deepEqual(inActiveSprint(bots, null), [], 'not loaded yet: no bots');
  assert.deepEqual(inActiveSprint(bots, new Set()), [], 'an empty sprint: no bots');
  assert.deepEqual(inActiveSprint(bots, new Set(['TAP-99'])), []);
  assert.deepEqual(inActiveSprint([], new Set(['TAP-1'])), []);
  // Keys are compared the way the app does: trimmed, upper case.
  assert.equal(normalizeTicketKey(' tap-12 '), 'TAP-12');
  assert.deepEqual(keysOf(inActiveSprint(bots, [' tap-2'])), ['TAP-2:implement']);
  assert.equal(inActiveSprint(bots, new Set(['TAP-1'])).length, 2, 'both sessions of a ticket');
});

test('a good sprint answer replaces the keys; a failed or unavailable one keeps the last good set', () => {
  const good = nextSprintKeys(null, { ok: true, available: true, keys: ['tap-1', 'TAP-2'] });
  assert.deepEqual([...good].sort(), ['TAP-1', 'TAP-2']);
  assert.equal(nextSprintKeys(good, { ok: true, available: true, keys: ['TAP-2', 'TAP-1'] }), good);
  assert.deepEqual([...nextSprintKeys(good, { ok: true, available: true, keys: [] })], []);
  for (const bad of [
    { ok: false, status: 0, keys: [] },
    { ok: true, available: false, reason: 'jira_unavailable', keys: [] },
    { ok: true, available: true },
    { ok: true, available: true, keys: 'TAP-1' },
    undefined,
  ])
    assert.equal(nextSprintKeys(good, bad), good);
  assert.equal(nextSprintKeys(null, { ok: true, available: false, keys: [] }), null);
});

const states = (entries) => new Map(Object.entries(entries));

test('session states cover implement and review, including the states that get no bot', () => {
  const map = sessionStates({
    'TAP-1': entry('implement-plan', 'working', { review: { state: 'none', reason: null } }),
    'TAP-2': entry('investigate-and-plan', 'done', { review: { state: 'done', reason: 'x' } }),
    'TAP-3': entry('implement-plan', 'unknown'),
  });
  assert.deepEqual(Object.fromEntries(map), {
    'TAP-1:implement': 'working',
    'TAP-1:review': 'none',
    'TAP-2:review': 'done',
    'TAP-3:implement': 'unknown',
    'TAP-3:review': 'none',
  });
  assert.equal(sessionStates(null).size, 0);
});

test('stateChanges: nothing on first load, nothing unchanged, a change when the state moves', () => {
  const next = states({ 'TAP-1:review': 'done', 'TAP-2:implement': 'working' });
  assert.deepEqual(stateChanges(null, next), [], 'first load is a baseline, not news');
  assert.deepEqual(stateChanges(next, next), []);
  const changes = stateChanges(
    states({ 'TAP-1:review': 'working', 'TAP-2:implement': 'working', 'TAP-3:review': 'done' }),
    states({ 'TAP-3:review': 'failed', 'TAP-2:implement': 'waiting', 'TAP-1:review': 'done' }),
  );
  assert.deepEqual(
    changes.map(({ key, ticket, phase, from, to }) => [key, ticket, phase, from, to]),
    [
      ['TAP-1:review', 'TAP-1', 'review', 'working', 'done'],
      ['TAP-2:implement', 'TAP-2', 'implement', 'working', 'waiting'],
      ['TAP-3:review', 'TAP-3', 'review', 'done', 'failed'],
    ],
    'in key order, whatever the order of the map',
  );
});

test('stateChanges: a session with no state is news only when it starts working', () => {
  const previous = states({ 'TAP-1:review': 'none', 'TAP-2:review': 'unknown' });
  const next = states({
    'TAP-1:review': 'working',
    'TAP-2:review': 'done',
    'TAP-3:review': 'working', // a session that was not there at all
    'TAP-4:review': 'done', // a new session already done: not news
    'TAP-5:review': 'none',
  });
  assert.deepEqual(
    stateChanges(previous, next).map(({ key }) => key),
    ['TAP-1:review', 'TAP-3:review'],
  );
  // Going to no state (none, unknown) is not a callout.
  assert.deepEqual(
    stateChanges(states({ 'TAP-1:review': 'working' }), states({ 'TAP-1:review': 'unknown' })),
    [],
  );
});

test('a listing glitch (unknown) keeps the known state, so its end is not a change', () => {
  const before = states({ 'TAP-1:review': 'working' });
  const glitch = rememberStates(before, states({ 'TAP-1:review': 'unknown' }));
  assert.equal(glitch.get('TAP-1:review'), 'working');
  assert.deepEqual(stateChanges(glitch, states({ 'TAP-1:review': 'working' })), []);
  assert.equal(
    rememberStates(null, states({ 'TAP-1:review': 'unknown' })).get('TAP-1:review'),
    'unknown',
  );
});

test('a bot hidden by a dismissal or its time to live is no change when it shows again', () => {
  // The baseline is the raw session state, so what the bar hides never moves it.
  const raw = states({ 'TAP-1:review': 'done' });
  assert.deepEqual(stateChanges(raw, rememberStates(raw, raw)), []);
});

test('a change waits for its bot to be shown, then shows; a stale or lost one is dropped', () => {
  const t0 = 1000;
  const change = (key, to) => ({
    key,
    ticket: key.split(':')[0],
    phase: 'review',
    from: 'working',
    to,
    at: t0,
  });
  const shown = [{ key: 'TAP-1:review', state: 'done' }];
  const pending = [
    change('TAP-1:review', 'done'),
    change('TAP-2:review', 'done'),
    change('TAP-3:review', 'failed'),
  ];
  const settled = settleChanges(
    pending,
    [...shown, { key: 'TAP-3:review', state: 'working' }],
    t0 + 100,
  );
  assert.deepEqual(
    settled.ready.map(({ key }) => key),
    ['TAP-1:review'],
  );
  assert.deepEqual(
    settled.waiting.map(({ key }) => key),
    ['TAP-2:review'],
    'not shown yet: waits',
  );
  assert.equal(
    settleChanges(settled.waiting, shown, t0 + CALLOUT_PENDING_MS).waiting.length,
    0,
    'gives up',
  );
});

test('callouts: one per bot, at most three (the oldest go), working and done hide by themselves', () => {
  const change = (key, to) => ({ key, ticket: key.split(':')[0], phase: 'review', to });
  const now = 10_000;
  let list = addCallouts(
    [],
    [change('TAP-1:review', 'done'), change('TAP-2:review', 'waiting')],
    now,
  );
  assert.deepEqual(
    list.map(({ key, state, hideAt }) => [key, state, hideAt]),
    [
      ['TAP-1:review', 'done', now + CALLOUT_AUTO_HIDE_MS],
      ['TAP-2:review', 'waiting', null],
    ],
  );
  list = addCallouts(list, [change('TAP-1:review', 'failed')], now + 1);
  assert.deepEqual(
    list.map(({ key, state }) => [key, state]),
    [
      ['TAP-2:review', 'waiting'],
      ['TAP-1:review', 'failed'],
    ],
    "a newer callout replaces its own bot's",
  );
  list = addCallouts(
    list,
    [change('TAP-3:review', 'done'), change('TAP-4:review', 'done')],
    now + 2,
  );
  assert.equal(list.length, MAX_CALLOUTS);
  assert.deepEqual(
    list.map(({ key }) => key),
    ['TAP-1:review', 'TAP-3:review', 'TAP-4:review'],
  );
  assert.equal(CALLOUT_TEXT.done, 'Done ✓');
});

test('callouts leave by time or when attended, waiting and failed only then', () => {
  const change = (key, to) => ({ key, ticket: 'TAP-1', phase: 'review', to });
  const t0 = 5000;
  const list = addCallouts(
    [],
    [change('TAP-1:review', 'done'), change('TAP-2:review', 'failed')],
    t0,
  );
  const at = (ms) => liveCallouts(list, t0 + ms).map(({ key, leaving }) => [key, leaving]);
  assert.deepEqual(at(0), [
    ['TAP-1:review', false],
    ['TAP-2:review', false],
  ]);
  assert.deepEqual(at(CALLOUT_AUTO_HIDE_MS), [
    ['TAP-1:review', true],
    ['TAP-2:review', false],
  ]);
  assert.deepEqual(at(CALLOUT_AUTO_HIDE_MS + CALLOUT_EXIT_MS), [['TAP-2:review', false]]);
  assert.deepEqual(at(10 * 60 * 1000), [['TAP-2:review', false]], 'a failed one stays');
  assert.equal(nextCalloutChange(list, t0), CALLOUT_AUTO_HIDE_MS);
  const attended = attendCallout(list, 'TAP-2:review', t0 + 1000);
  assert.deepEqual(
    liveCallouts(attended, t0 + 1000).map(({ key, leaving }) => [key, leaving]),
    [
      ['TAP-1:review', false],
      ['TAP-2:review', true],
    ],
  );
  assert.equal(liveCallouts(attended, t0 + 1000 + CALLOUT_EXIT_MS).length, 1);
  assert.equal(attendCallout(list, 'TAP-1:review', t0), list, 'a timed one is left alone');
  assert.equal(
    nextCalloutChange(addCallouts([], [change('TAP-2:review', 'failed')], t0), t0),
    null,
  );
});

test('the bar is mounted once in the shell, behind setup, with its own tickets poll and overlay rules', () => {
  const read = (file) => readFileSync(new URL(`../ui-react/${file}`, import.meta.url), 'utf8');
  assert.match(read('components/AppShell.jsx'), /\{ready && <BotBar \/>\}/);
  assert.match(
    read('components/BotBar.jsx'),
    /useClaudeTickets\(\{ active: true, source: 'bot-bar' \}\)/,
  );
  assert.match(read('components/BotBar.jsx'), /inActiveSprint\(sessions, sprintKeys\)/);
  assert.match(read('hooks/useActiveSprintKeys.js'), /getActiveSprintTickets/);
  // Hover detail is the app's popup (DashboardTooltip), never a native title or the old data-tooltip.
  const bar = read('components/BotBar.jsx');
  assert.doesNotMatch(bar, /<(?:button|div|span|svg)\b[^>]*\stitle=|data-tooltip|describeChild/);
  assert.match(bar, /<DashboardTooltip/);
  assert.match(bar, /role="status" aria-live="polite"/);
  assert.match(read('styles.css'), /@import '\.\/styles\/bot-bar\.css'/);
  const css = read('styles/bot-bar.css');
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, 'colours come from tokens');
  assert.match(css, /\.bot-bar\s*\{[^}]*position:\s*fixed/);
  assert.match(css, /\.bot-bar\s*\{[^}]*pointer-events:\s*none/);
  assert.match(css, /safe-area-inset-bottom/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.doesNotMatch(css, /(?<![\w-])columns:\s*\d/);
  for (const [, name] of css.matchAll(/@keyframes\s+([\w-]+)/g))
    assert.match(name, /^bot-bar-/, `${name} is namespaced`);
  for (const [, value] of css.matchAll(/transition(?:-duration|-property)?\s*:\s*([^;}]+)/g)) {
    for (const [, amount, unit] of value.matchAll(/(\d*\.?\d+)\s*(ms|s)\b/g))
      assert.ok((unit === 's' ? amount * 1000 : Number(amount)) <= 200, `${value.trim()} <= 200ms`);
    assert.doesNotMatch(value, /\ball\b/);
  }
  const selectors = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)]
    .map(([, selector]) => selector.trim())
    .filter((selector) => !selector.startsWith('@') && !/^(?:from|to|\d)/.test(selector))
    .flatMap((selector) => selector.split(/,(?![^(]*\))/));
  for (const selector of selectors)
    assert.match(selector.trim(), /^\.bot-bar\b/, `${selector.trim()} stays bot-bar scoped`);
});

test('working, waiting and done bots walk and are handed right; only failed stands and looks as its key says', () => {
  const roam = (facing) => ({ ...roamFor('TAP-1:review'), facing });
  for (const facing of ['left', 'right']) {
    assert.deepEqual(botPose('working', roam(facing)), { facing: 'right', stepping: true });
    assert.deepEqual(botPose('waiting', roam(facing)), { facing: 'right', stepping: false });
    assert.deepEqual(botPose('done', roam(facing)), { facing: 'right', stepping: false });
    assert.deepEqual(botPose('failed', roam(facing)), { facing, stepping: false });
  }
  assert.deepEqual(['working', 'waiting', 'done', 'failed'].map(walks), [true, true, true, false]);
});

test('the done stroll is the slowest walk, from one named factor next to the idle one', () => {
  assert.ok(STROLL_CYCLE_FACTOR > IDLE_CYCLE_FACTOR && IDLE_CYCLE_FACTOR > 1);
  for (const key of keys(100)) {
    const roam = roamFor(key);
    assert.equal(roam.idleSeconds, Math.round(roam.seconds * IDLE_CYCLE_FACTOR * 10) / 10);
    assert.equal(roam.strollSeconds, Math.round(roam.seconds * STROLL_CYCLE_FACTOR * 10) / 10);
    assert.ok(roam.strollSeconds > roam.idleSeconds && roam.idleSeconds > roam.seconds);
  }
});

test('a lane is styled with the custom properties bot-bar.css reads', () => {
  const roam = roamFor('TAP-1:review');
  assert.deepEqual(laneStyle(roam, 42.5), {
    '--bot-from': roam.from,
    '--bot-range': roam.range,
    '--bot-zone-from': roam.zoneFrom,
    '--bot-zone-range': roam.zoneRange,
    '--bot-zone-left-share': ZONES.left.share,
    '--bot-zone-left-min': ZONES.left.minPx,
    '--bot-zone-right-share': ZONES.right.share,
    '--bot-zone-right-min': ZONES.right.minPx,
    '--bot-dur': roam.seconds,
    '--bot-dur-idle': roam.idleSeconds,
    '--bot-dur-stroll': roam.strollSeconds,
    '--bot-phase': roam.phase,
    '--bot-rest': 42.5,
  });
});

const ZONE_TABLE = [
  // state, zone, where the zone is on a 1440px bar
  ['done', 'left', 0, 432],
  ['working', 'center', 432, 1008],
  ['waiting', 'center', 432, 1008],
  ['failed', 'right', 1008, 1440],
];

test('the zones: numbers, shares, and which state lives in which', () => {
  assert.deepEqual(ZONES, {
    left: { share: 20, minPx: 200, spread: 35 },
    center: { share: 60, minPx: 200, spread: 12 },
    right: { share: 20, minPx: 200, spread: 35 },
  });
  assert.equal(ZONES_MIN_WIDTH_PX, 600);
  assert.equal(DONE_ZONE_SHARE, 20);
  assert.deepEqual(
    ['done', 'working', 'waiting', 'failed'].map((state) => zoneOf(state)),
    ['left', 'center', 'center', 'right'],
  );
  assert.deepEqual(
    ['done', 'working', 'waiting', 'failed'].map((state) => zoneOf(state, true)),
    ['all', 'all', 'all', 'all'],
  );
  assert.deepEqual(zoneBounds('left', 1440), { start: 0, end: 288 });
  assert.deepEqual(zoneBounds('center', 1440), { start: 288, end: 1152 });
  assert.deepEqual(zoneBounds('right', 1440), { start: 1152, end: 1440 });
  // The minimums bite below 1000px, the centre keeps its own 200px at 600px (where zones stop).
  assert.deepEqual(zoneBounds('left', 600), { start: 0, end: 200 });
  assert.deepEqual(zoneBounds('center', 600), { start: 200, end: 400 });
});

test('every state walks and stands inside its own zone, deterministically; a state change moves it', () => {
  for (const width of [600, 700, 1024, 1440, 2560]) {
    const edge = 88;
    for (const key of keys(200)) {
      const roam = roamFor(key);
      for (const [state, zone] of ZONE_TABLE.map(([s, z]) => [s, z])) {
        const walk = walkStretch(roam, state, width, { edge });
        const bounds = zoneBounds(zone, width);
        const start = bounds.start === 0 ? edge : bounds.start;
        const end = bounds.end === width ? width - edge : bounds.end;
        assert.ok(walk.min >= start - 1e-9, `${state} at ${width}: starts inside its zone`);
        assert.ok(walk.max + 56 <= end + 1e-9, `${state} at ${width}: ends inside its zone`);
        assert.deepEqual(walk, walkStretch(roamFor(key), state, width, { edge }), 'deterministic');
      }
      // The same session in two states is in two zones: a state change moves it, whole.
      const done = walkStretch(roam, 'done', width, { edge });
      const working = walkStretch(roam, 'working', width, { edge });
      const failed = walkStretch(roam, 'failed', width, { edge });
      assert.ok(done.max + 56 <= working.zone.start + 1e-9, 'done lies left of working');
      assert.ok(working.max + 56 <= failed.zone.start + 1e-9, 'working lies left of failed');
    }
  }
  // Working and idle share the centre but walk their own stretches, by key.
  const stretches = new Set(keys(50).map((key) => walkStretch(roamFor(key), 'working', 1440).min));
  assert.ok(stretches.size > 20, 'working bots do not collapse on one spot');
});

test('under 600px the zones collapse: every state has the whole width between the edge margins', () => {
  for (const width of [320, 480, 599]) {
    for (const key of keys(100)) {
      const roam = roamFor(key);
      for (const state of ['done', 'working', 'waiting', 'failed']) {
        const walk = walkStretch(roam, state, width, { edge: 40 });
        assert.deepEqual(walk.zone, { start: 0, end: width });
        assert.ok(walk.min >= 40 - 1e-9 && walk.max + 56 <= width - 40 + 1e-9);
        assert.equal(walk.room, width - 80 - 56);
      }
    }
  }
});

test('resting places are spread inside each zone, apart from the others zones', () => {
  const bots = [
    ...keys(6).map((key) => ({ key: `${key}:d`, state: 'done' })),
    ...keys(5).map((key) => ({ key: `${key}:w`, state: 'working' })),
    ...keys(3).map((key) => ({ key: `${key}:i`, state: 'waiting' })),
    ...keys(4).map((key) => ({ key: `${key}:f`, state: 'failed' })),
  ];
  const spots = zoneSpots(bots);
  assert.equal(spots.size, bots.length);
  assert.ok([...spots.values()].every((at) => at >= 0 && at <= 100));
  for (const zone of ['left', 'center', 'right']) {
    const row = bots
      .filter(({ state }) => zoneOf(state) === zone)
      .map(({ key }) => spots.get(key))
      .sort((a, b) => a - b);
    for (let i = 1; i < row.length; i += 1)
      assert.ok(row[i] > row[i - 1], `${zone}: no shared spot`);
  }
  // Working and idle bots spread together in the centre.
  const centre = bots.filter(({ state }) => state === 'working' || state === 'waiting');
  const row = centre.map(({ key }) => spots.get(key)).sort((a, b) => a - b);
  for (let i = 1; i < row.length; i += 1)
    assert.ok(row[i] - row[i - 1] >= Math.min(ZONES.center.spread, 100 / (row.length - 1)) - 0.2);
  // Narrow: one zone for everyone.
  const narrow = zoneSpots(bots, true);
  const all = [...narrow.values()].sort((a, b) => a - b);
  assert.equal(new Set(all).size, bots.length);
});
