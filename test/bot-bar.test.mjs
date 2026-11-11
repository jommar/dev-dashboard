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
  botKey,
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
  heldDoneBots,
  inActiveSprint,
  laneStyle,
  liveBots,
  nextSprint,
  normalizeTicketKey,
  nextBotChange,
  pickMascot,
  pickPoster,
  rememberBots,
  restingSpots,
  sessionGroups,
  SESSION_GROUPS,
  filterSessionGroups,
  walks,
  roamFor,
} from '../ui/bot-bar.js';

const FIVE = ['dux', 'wick', 'glim', 'pinch', 'pinch-crab'];
const SIX = [...FIVE, 'moss'];
const keys = (count) => Array.from({ length: count }, (_, i) => `TAP-${1000 + i}:review`);

// The shape of one GET /api/claude/tickets entry, only the parts the bar reads.
const entry = (phase, state, { review, groom, e2e } = {}) => ({
  phase,
  state,
  reason: 'r',
  review: review ?? { state: 'none', reason: null },
  groom: groom ?? { state: 'none', reason: null },
  ...(e2e && { e2e }),
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

const POSTERS_FIVE = ['paper', 'glow', 'pixel', 'craft', 'wild'];
const POSTERS_SIX = [...POSTERS_FIVE, 'neon'];

test('pickPoster is stable, always one of the ids and uses every id', () => {
  const picks = keys(1000).map((key) => pickPoster(key, POSTERS_FIVE));
  assert.deepEqual(
    picks,
    keys(1000).map((key) => pickPoster(key, POSTERS_FIVE)),
  );
  assert.ok(picks.every((id) => POSTERS_FIVE.includes(id)));
  for (const id of POSTERS_FIVE)
    assert.ok(picks.filter((p) => p === id).length > 100, `${id} is used`);
  assert.equal(pickPoster('TAP-1:review', ['only']), 'only');
  assert.equal(pickPoster('TAP-1:review', []), null);
});

test('pickPoster does not depend on the order of the ids', () => {
  for (const key of keys(200))
    assert.equal(pickPoster(key, POSTERS_FIVE), pickPoster(key, [...POSTERS_FIVE].reverse()));
});

test('adding a poster moves about a sixth of the sessions, all of them to the new one', () => {
  const all = keys(1000);
  const before = all.map((key) => pickPoster(key, POSTERS_FIVE));
  const after = all.map((key) => pickPoster(key, POSTERS_SIX));
  const moved = all.filter((_, i) => before[i] !== after[i]);
  assert.ok(moved.length > 0, 'the new poster is used');
  assert.ok(moved.length <= 1000 / 6 + 60, `${moved.length} of 1000 moved`);
  for (const key of moved) assert.equal(pickPoster(key, POSTERS_SIX), 'neon');
  assert.ok(after.every((id, i) => id === 'neon' || id === before[i]));
});

test('removing a poster moves only the sessions that had it', () => {
  const without = POSTERS_FIVE.filter((id) => id !== 'pixel');
  for (const key of keys(500)) {
    const was = pickPoster(key, POSTERS_FIVE);
    if (was !== 'pixel') assert.equal(pickPoster(key, without), was);
    else assert.notEqual(pickPoster(key, without), 'pixel');
  }
});

test('the poster a session carries is independent of its mascot', () => {
  // Were the picks tied, each mascot would always come with the same poster: a chi-square test of the
  // 5 x 5 table of pairs (16 degrees of freedom; 39.3 is the 99.9% mark).
  const mascots = ['dux', 'wick', 'glim', 'pinch', 'pinch-crab'];
  const all = keys(5000);
  const count = new Map();
  for (const key of all) {
    const pair = `${pickMascot(key, mascots)}/${pickPoster(key, POSTERS_FIVE)}`;
    count.set(pair, (count.get(pair) ?? 0) + 1);
  }
  assert.equal(count.size, 25, 'every mascot is seen with every poster');
  const total = (side, id) =>
    [...count].filter(([pair]) => pair.split('/')[side] === id).reduce((n, [, c]) => n + c, 0);
  let chi = 0;
  for (const m of mascots)
    for (const p of POSTERS_FIVE) {
      const expected = (total(0, m) * total(1, p)) / all.length;
      chi += ((count.get(`${m}/${p}`) ?? 0) - expected) ** 2 / expected;
    }
  assert.ok(chi < 39.3, `the picks look independent (chi-square ${chi.toFixed(1)})`);
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

test('every kind of session gets a bot, in draw order, when it has a state to show', () => {
  assert.deepEqual(BOT_PHASES, ['investigate', 'implement', 'review', 'groom', 'e2e']);
  const tickets = {
    'TAP-1': entry('investigate-and-plan', 'working'),
    'TAP-2': entry('implement-plan', 'working', {
      review: { state: 'done', reason: 'finished' },
      groom: { state: 'working', reason: 'running' },
      e2e: { state: 'working', reason: 'running' },
    }),
    'TAP-3': entry('implement-plan', 'none'),
    'TAP-4': entry(null, 'none', { groom: { state: 'done', reason: 'finished' } }),
    'TAP-5': entry('investigate-and-plan', 'unknown'),
  };
  assert.deepEqual(
    botsFromTickets(tickets).map(({ key, state }) => [key, state]),
    [
      ['TAP-1:investigate', 'working'],
      ['TAP-2:implement', 'working'],
      ['TAP-2:review', 'done'],
      ['TAP-2:groom', 'working'],
      ['TAP-2:e2e', 'working'],
      ['TAP-4:groom', 'done'],
    ],
  );
});

test('e2e: a working, waiting, done or failed e2e session is a bot after the review one; none and unknown are not', () => {
  const tickets = Object.fromEntries(
    ['working', 'waiting', 'done', 'failed', 'none', 'unknown'].map((state, i) => [
      `TAP-${i + 1}`,
      entry(null, 'none', { e2e: { state, reason: 'x' } }),
    ]),
  );
  assert.deepEqual(
    botsFromTickets({ tickets }).map(({ key, ticket, phase, state }) => [
      key,
      ticket,
      phase,
      state,
    ]),
    [
      ['TAP-1:e2e', 'TAP-1', 'e2e', 'working'],
      ['TAP-2:e2e', 'TAP-2', 'e2e', 'waiting'],
      ['TAP-3:e2e', 'TAP-3', 'e2e', 'done'],
      ['TAP-4:e2e', 'TAP-4', 'e2e', 'failed'],
    ],
  );
  // A ticket with an entry that has no e2e record at all gets none.
  assert.deepEqual(botsFromTickets({ 'TAP-9': entry(null, 'none') }), []);
  // Drawn after the ticket's implement and review bots.
  assert.deepEqual(
    botsFromTickets({
      'TAP-1': entry('implement-plan', 'working', {
        review: { state: 'done', reason: 'finished' },
        e2e: { state: 'done', reason: 'finished' },
      }),
    }).map(({ phase }) => phase),
    ['implement', 'review', 'e2e'],
  );
});

test('e2e: a ticket outside the active sprint gets no e2e bot', () => {
  const bots = botsFromTickets({
    'TAP-1': entry(null, 'none', { e2e: { state: 'working', reason: 'running' } }),
    'TAP-2': entry(null, 'none', { e2e: { state: 'done', reason: 'finished' } }),
  });
  assert.deepEqual(
    inActiveSprint(bots, new Set(['TAP-2'])).map(({ key }) => key),
    ['TAP-2:e2e'],
  );
  assert.deepEqual(inActiveSprint(bots, new Set(['TAP-99'])), []);
});

test('e2e: working to done is a state change that raises one callout', () => {
  const at = (state) =>
    sessionStates({ 'TAP-1': entry(null, 'none', { e2e: { state, reason: 'x' } }) });
  assert.equal(at('working').get('TAP-1:e2e'), 'working');
  const changes = stateChanges(at('working'), at('done'));
  assert.deepEqual(
    changes.map(({ key, ticket, phase, from, to }) => [key, ticket, phase, from, to]),
    [['TAP-1:e2e', 'TAP-1', 'e2e', 'working', 'done']],
  );
  const callouts = addCallouts([], changes, 1000);
  assert.deepEqual(
    callouts.map(({ key, state }) => [key, state]),
    [['TAP-1:e2e', 'done']],
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

test('a good sprint answer replaces the keys and statuses; a failed one keeps the last good set', () => {
  const good = nextSprint(null, {
    ok: true,
    available: true,
    keys: ['tap-1', 'TAP-2'],
    statuses: { 'TAP-1': 'Code Review', 'tap-2': 'Deployed' },
  });
  assert.deepEqual([...good.keys].sort(), ['TAP-1', 'TAP-2']);
  assert.deepEqual(Object.fromEntries(good.statuses), {
    'TAP-1': 'Code Review',
    'TAP-2': 'Deployed',
  });
  assert.equal(
    nextSprint(good, {
      ok: true,
      available: true,
      keys: ['TAP-2', 'TAP-1'],
      statuses: { 'TAP-2': 'Deployed', 'TAP-1': 'Code Review' },
    }),
    good,
    'the same answer keeps the same object',
  );
  assert.deepEqual(
    [...nextSprint(good, { ok: true, available: true, keys: [], statuses: {} }).keys],
    [],
  );
  const moved = nextSprint(good, {
    ok: true,
    available: true,
    keys: ['TAP-1', 'TAP-2'],
    statuses: { 'TAP-1': 'Code Review', 'TAP-2': 'Ready for Deployment' },
  });
  assert.equal(moved.statuses.get('TAP-2'), 'Ready for Deployment');
  assert.deepEqual([...moved.keys].sort(), ['TAP-1', 'TAP-2']);
  // A status Jira did not report is left out, not guessed.
  assert.deepEqual(
    Object.fromEntries(nextSprint(good, { ok: true, available: true, keys: ['TAP-1'] }).statuses),
    {},
  );
  for (const bad of [
    { ok: false, status: 0, keys: [] },
    { ok: true, available: false, reason: 'jira_unavailable', keys: [], statuses: {} },
    { ok: true, available: true },
    { ok: true, available: true, keys: 'TAP-1' },
    undefined,
  ])
    assert.equal(nextSprint(good, bad), good);
  assert.equal(nextSprint(null, { ok: true, available: false, keys: [] }), null);
});

test('a done implement bot is held while its ticket is open in Jira', () => {
  const bots = botsFromTickets({
    'TAP-1': entry('implement-plan', 'done'),
    'TAP-2': entry('implement-plan', 'working', { review: { state: 'done', reason: 'finished' } }),
    'TAP-3': entry('implement-plan', 'done'),
    'TAP-4': entry('implement-plan', 'working'),
  });
  const status = (items) => [...heldDoneBots(bots, new Map(items))].sort();
  // Working tickets hold their done implement bot.
  assert.deepEqual(status([['TAP-1', 'Ready For Testing']]), ['TAP-1:implement']);
  assert.deepEqual(status([['TAP-1', 'In Progress']]), ['TAP-1:implement']);
  assert.deepEqual(status([['TAP-1', 'Blocked']]), ['TAP-1:implement'], 'blocked is not done');
  // A done-kind status ('Deployed', 'Ready for Deployment', 'Hardening in UAT', ...) lets it go.
  assert.deepEqual(status([['TAP-1', 'Deployed']]), []);
  assert.deepEqual(status([['TAP-1', 'Ready for Deployment']]), []);
  assert.deepEqual(status([['TAP-1', 'Hardening in UAT']]), []);
  // Only the implement session holds: the done review of TAP-2 does not.
  assert.deepEqual(status([['TAP-2', 'Ready For Testing']]), []);
  // A status Jira could not give, or does not recognise, falls back to the time to live.
  assert.deepEqual(status([]), []);
  assert.deepEqual(status([['TAP-1', 'Something New']]), []);
  // The ticket is matched the way the app compares keys: trimmed, upper case.
  const lower = botsFromTickets({ ' tap-1 ': entry('implement-plan', 'done') });
  assert.deepEqual(
    [...heldDoneBots(lower, new Map([['TAP-1', 'In Progress']]))],
    [' tap-1 :implement'],
  );
});

test('a held bot stays past its time to live and schedules no fade', () => {
  const bots = botsFromTickets({ 'TAP-1': entry('implement-plan', 'done') });
  const memory = rememberBots(NO_MEMORY, bots, 0);
  const held = heldDoneBots(bots, new Map([['TAP-1', 'Ready For Testing']]));
  assert.deepEqual(liveBots(bots, memory, DONE_TTL_MS * 10, { held }), [
    {
      key: 'TAP-1:implement',
      ticket: 'TAP-1',
      phase: 'implement',
      state: 'done',
      reason: 'r',
      fading: false,
    },
  ]);
  assert.equal(nextBotChange(bots, memory, 0, { held }), null, 'no fade to wake up for');
  // Once the ticket is done-kind the bot ages out as before.
  const released = heldDoneBots(bots, new Map([['TAP-1', 'Deployed']]));
  assert.deepEqual(liveBots(bots, memory, DONE_TTL_MS, { held: released }), []);
  assert.equal(nextBotChange(bots, memory, 0, { held: released }), DONE_TTL_MS - FADE_MS);
});

const states = (entries) => new Map(Object.entries(entries));

test('session states cover every session, including the states that get no bot', () => {
  const map = sessionStates({
    'TAP-1': entry('implement-plan', 'working', { review: { state: 'none', reason: null } }),
    'TAP-2': entry('investigate-and-plan', 'done', { review: { state: 'done', reason: 'x' } }),
    'TAP-3': entry('implement-plan', 'unknown'),
  });
  assert.deepEqual(Object.fromEntries(map), {
    'TAP-1:implement': 'working',
    'TAP-1:review': 'none',
    'TAP-1:groom': 'none',
    'TAP-2:investigate': 'done',
    'TAP-2:review': 'done',
    'TAP-2:groom': 'none',
    'TAP-3:implement': 'unknown',
    'TAP-3:review': 'none',
    'TAP-3:groom': 'none',
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
  assert.match(read('components/BotBar.jsx'), /inActiveSprint\(sessions, sprint\?\.keys\)/);
  assert.match(read('components/BotBar.jsx'), /heldDoneBots\(bots, sprint\?\.statuses\)/);
  assert.match(read('hooks/useActiveSprintKeys.js'), /getActiveSprintTickets/);
  assert.match(read('hooks/useActiveSprintKeys.js'), /nextSprint\(/);
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

// -- the session list -------------------------------------------------------------------------------

test('sessionGroups groups bots by what they need, in a fixed order, and drops empty groups', () => {
  const bot = (ticket, phase, state) => ({ key: botKey(ticket, phase), ticket, phase, state });
  const bots = [
    bot('TAP-1', 'implement', 'done'),
    bot('TAP-2', 'review', 'working'),
    bot('TAP-3', 'implement', 'waiting'),
    bot('TAP-4', 'groom', 'done'),
  ];
  const groups = sessionGroups(bots, { tickets: {} });
  assert.deepEqual(
    groups.map(({ state, rows }) => [state, rows.map(({ key }) => key)]),
    [
      ['waiting', ['TAP-3:implement']],
      ['working', ['TAP-2:review']],
      ['done', ['TAP-1:implement', 'TAP-4:groom']],
    ],
  );
  assert.ok(groups.every(({ title }) => typeof title === 'string' && title));
  assert.deepEqual(
    SESSION_GROUPS.map(({ state }) => state),
    ['waiting', 'working', 'failed', 'done'],
  );
  assert.deepEqual(sessionGroups([], {}), []);
});

test('sessionGroups attaches the join command of the entry for that phase, and none for review', () => {
  const resume = { kind: 'resume', command: 'cd ~/pathwise && claude --resume abc' };
  const attach = { kind: 'attach', command: 'claude attach ab12cd34' };
  const response = {
    tickets: {
      'TAP-1': {
        goTo: { investigate: null, implement: attach, groom: resume },
        review: { state: 'done' },
      },
    },
  };
  const bot = (phase, state) => ({ key: botKey('TAP-1', phase), ticket: 'TAP-1', phase, state });
  const rows = sessionGroups(
    [bot('implement', 'working'), bot('groom', 'done'), bot('review', 'done'), bot('e2e', 'done')],
    response,
  ).flatMap(({ rows: found }) => found);
  const goTo = Object.fromEntries(rows.map(({ phase, goTo: join }) => [phase, join]));
  assert.deepEqual(goTo.implement, attach);
  assert.deepEqual(goTo.groom, resume);
  assert.equal(goTo.review, null);
  assert.equal(goTo.e2e, null);
});

test('filterSessionGroups is one AND search over a row and its group title, dropping empty groups', () => {
  const row = (ticket, phase, state, text) => ({
    key: `${ticket}:${phase}`,
    ticket,
    phase,
    state,
    text,
  });
  const groups = [
    {
      state: 'waiting',
      title: 'Needs you',
      rows: [row('TAP-1', 'review', 'waiting', 'Code review idle · blocked, needs you')],
    },
    {
      state: 'done',
      title: 'Done',
      rows: [
        row('TAP-1', 'implement', 'done', 'Implement plan done · implemented Copy resume'),
        row('TAP-2', 'groom', 'done', 'Groom ticket done · finished'),
      ],
    },
  ];
  const keysOf = (found) => found.flatMap(({ rows }) => rows.map(({ key }) => key));
  const textOf = ({ ticket, text }) => `${ticket} ${text}`;
  // Blank (or only spaces) keeps everything, and the very same groups.
  assert.equal(filterSessionGroups(groups, '', textOf), groups);
  assert.equal(filterSessionGroups(groups, '  ', textOf), groups);
  // Case-insensitive; every term must match somewhere on the row.
  assert.deepEqual(keysOf(filterSessionGroups(groups, 'tap-1', textOf)), [
    'TAP-1:review',
    'TAP-1:implement',
  ]);
  assert.deepEqual(keysOf(filterSessionGroups(groups, 'TAP-1 DONE', textOf)), ['TAP-1:implement']);
  assert.deepEqual(keysOf(filterSessionGroups(groups, 'resume', textOf)), ['TAP-1:implement']);
  // The group's title is on screen too, so it matches every row under it.
  assert.deepEqual(keysOf(filterSessionGroups(groups, 'needs you', textOf)), ['TAP-1:review']);
  // A group with no match is dropped; no match at all leaves nothing.
  assert.deepEqual(
    filterSessionGroups(groups, 'groom', textOf).map(({ state }) => state),
    ['done'],
  );
  assert.deepEqual(filterSessionGroups(groups, 'nothing here', textOf), []);
});
