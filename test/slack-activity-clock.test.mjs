import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSlackActivityClock } from '../ui/slack-activity-clock.js';

const BASE = 1_767_225_600_000; // 2026-01-01T00:00:00.000Z

function makeClock(wall = BASE, monotonic = 100) {
  const time = { wall, monotonic };
  const clock = createSlackActivityClock({
    wallNow: () => time.wall,
    monotonicNow: () => time.monotonic,
  });
  return { clock, time };
}

test('clock includes the entire request and delayed status time in the server bound', () => {
  const { clock, time } = makeClock(BASE - 10_000);
  const requestStartedAt = time.monotonic;

  time.monotonic = 5_100;
  clock.observe('2026-01-01T00:00:00.000Z', requestStartedAt);
  assert.equal(clock.now(), BASE + 5_000);

  time.monotonic = 5_200;
  assert.equal(clock.now(), BASE + 5_100);
});

test('clock advances monotonically when the wall clock goes backwards', () => {
  const { clock, time } = makeClock();
  time.monotonic += 500;
  assert.equal(clock.now(), BASE + 500);

  time.wall -= 60_000;
  time.monotonic += 1;
  assert.equal(clock.now(), BASE + 501);
  time.monotonic += 5_000;
  assert.equal(clock.now(), BASE + 5_501);
});

test('clock advances calibrated server time across suspend when the monotonic clock is frozen', () => {
  const { clock, time } = makeClock(BASE - 86_400_000);
  clock.observe('2026-01-01T00:00:00.000Z', time.monotonic);
  assert.equal(clock.now(), BASE);

  time.wall += 600_000;
  assert.equal(clock.now(), BASE + 600_000);
  time.monotonic += 1;
  assert.equal(clock.now(), BASE + 600_001);
});

test('clock rebases a backwards wall adjustment before a later suspend', () => {
  const { clock, time } = makeClock(BASE - 86_400_000);
  clock.observe('2026-01-01T00:00:00.000Z', time.monotonic);
  time.monotonic += 500;
  time.wall += 500;
  assert.equal(clock.now(), BASE + 500);

  time.wall -= 3_600_000;
  time.monotonic += 100;
  assert.equal(clock.now(), BASE + 600);
  time.wall += 300_000;
  assert.equal(clock.now(), BASE + 300_600);
});

test('clock rebases a rollback that stays above the original wall anchor', () => {
  const { clock, time } = makeClock(BASE - 86_400_000);
  clock.observe('2026-01-01T00:00:00.000Z', time.monotonic);
  time.wall += 600_000;
  time.monotonic += 600_000;
  assert.equal(clock.now(), BASE + 600_000);
  time.wall -= 300_000;
  time.monotonic += 1;
  assert.equal(clock.now(), BASE + 600_001);
  time.wall += 120_000;
  assert.equal(clock.now(), BASE + 720_001);
});

test('clock counts concurrent wall and monotonic elapsed time only once', () => {
  const { clock, time } = makeClock(BASE - 86_400_000, 100);
  clock.observe('2026-01-01T00:00:00.000Z', 100);
  time.wall += 10_000;
  time.monotonic += 10_000;
  assert.equal(clock.now(), BASE + 10_000);
});

test('clock includes suspended wall time during a delayed list response', () => {
  const { clock, time } = makeClock(BASE - 86_400_000, 100);
  const startWall = time.wall;
  time.wall += 600_000;
  clock.observe('2026-01-01T00:00:00.000Z', 100, startWall);
  assert.equal(clock.now(), BASE + 600_000);
});

test('re-observing the same snapshot does not double-count suspended time', () => {
  const { clock, time } = makeClock(BASE - 86_400_000, 100);
  const startWall = time.wall;
  clock.observe('2026-01-01T00:00:00.000Z', 100, startWall);
  time.wall += 600_000;
  assert.equal(clock.now(), BASE + 600_000);
  clock.observe('2026-01-01T00:00:00.000Z', 100, startWall);
  assert.equal(clock.now(), BASE + 600_000);
  time.wall += 500;
  time.monotonic += 500;
  assert.equal(clock.now(), BASE + 600_500);
});

test('a backwards wall correction and old observation cannot undo time advanced during suspend', () => {
  const { clock, time } = makeClock(BASE - 86_400_000, 100);
  clock.observe('2026-01-01T00:00:00.000Z', 100);
  time.wall += 600_000;
  assert.equal(clock.now(), BASE + 600_000);

  time.wall -= 3_600_000;
  clock.observe('2025-12-31T23:59:00.000Z', 100);
  assert.equal(clock.now(), BASE + 600_000);
  time.wall += 60_000;
  assert.equal(clock.now(), BASE + 660_000);
});

test('clock respects a fast wall clock and does not lose that progress on rollback', () => {
  const { clock, time } = makeClock();
  time.wall = BASE + 20_000;
  time.monotonic += 200;
  assert.equal(clock.now(), BASE + 20_000);

  time.wall = BASE - 1_000;
  time.monotonic += 1;
  assert.equal(clock.now(), BASE + 20_001);

  clock.observe('2026-01-01T00:00:01.000Z', 100);
  assert.equal(clock.now(), BASE + 20_001);
});

test('clock ignores older observations without freezing elapsed monotonic time', () => {
  const { clock, time } = makeClock(BASE - 10_000, 2_000);
  time.monotonic = 5_000;
  clock.observe('2026-01-01T00:00:01.000Z', 2_000);
  assert.equal(clock.now(), BASE + 4_000);

  time.monotonic = 5_200;
  clock.observe('2025-12-31T23:59:50.000Z', 100);
  assert.equal(clock.now(), BASE + 4_200);
  time.monotonic += 1;
  assert.equal(clock.now(), BASE + 4_201);
});

test('clock ignores invalid timestamps without poisoning or advancing its server bound', () => {
  const { clock, time } = makeClock(0);
  time.monotonic += 200;
  for (const invalid of [
    undefined,
    null,
    0,
    '',
    '0',
    'not a timestamp',
    '2026-02-30T00:00:00.000Z',
    '2026-02-29T00:00:00.000Z',
    '2026-04-31T00:00:00.000Z',
    '2026-13-01T00:00:00.000Z',
    '2026-01-01T25:00:00.000Z',
    '2026-01-01T00:00:00.000+25:00',
  ]) {
    clock.observe(invalid, 100);
    assert.equal(clock.now(), 200);
  }
  time.monotonic += 1;
  assert.equal(clock.now(), 201);
});

test('clock ignores observations with invalid request start times', () => {
  const { clock, time } = makeClock();
  time.monotonic += 200;
  for (const invalid of [undefined, null, NaN, Infinity, -Infinity, '100']) {
    clock.observe('2026-01-02T00:00:00.000Z', invalid);
    assert.equal(clock.now(), BASE + 200);
  }
});

test('clock accepts a valid ISO offset and keeps fractional millisecond elapsed time', () => {
  const { clock, time } = makeClock(BASE - 10_000, 100.25);
  time.monotonic = 250.75;
  clock.observe('2026-01-01T08:30:01.250+08:30', 100.25);
  assert.equal(clock.now(), BASE + 1_400.5);
  time.monotonic += 0.25;
  assert.equal(clock.now(), BASE + 1_400.75);
});

test('clock clamps a negative request elapsed time to zero', () => {
  const { clock } = makeClock(BASE - 10_000, 100);
  clock.observe('2026-01-01T00:00:01.000Z', 200);
  assert.equal(clock.now(), BASE + 1_000);
});

test('clock accepts the Unix epoch as a valid server timestamp', () => {
  const { clock } = makeClock(-5_000, 100);
  clock.observe('1970-01-01T00:00:00.000Z', 100);
  assert.equal(clock.now(), 0);
});

test('clock accepts valid leap days', () => {
  const { clock } = makeClock(0, 100);
  clock.observe('2024-02-29T00:00:00.000Z', 100);
  assert.equal(clock.now(), 1_709_164_800_000);
});

test('clock does not accumulate fractional rounding error over repeated reads', () => {
  const { clock, time } = makeClock(BASE, 0);
  for (let i = 1; i <= 10_000; i++) {
    time.monotonic = i / 10;
    clock.now();
  }
  assert.equal(clock.now(), BASE + 1_000);
});
