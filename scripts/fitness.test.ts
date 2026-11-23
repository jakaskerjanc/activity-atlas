import { test } from "node:test";
import assert from "node:assert/strict";
import { minettiCost, runEfficiency, WARMUP_S } from "./fitness.ts";
import type { Streams } from "./detail.ts";

/** Samples every second; each segment holds speed (m/s), hr (bpm) and grade for some seconds. */
interface Segment {
  seconds: number;
  speed: number;
  hr: number | null;
  grade?: number;
}

function streams(segments: Segment[], { altitude = true, pauseBefore = new Map<number, number>() } = {}): Streams {
  const time: number[] = [];
  const distance: number[] = [];
  const alt: number[] = [];
  const hr: (number | null)[] = [];
  let t = 0;
  let d = 0;
  let a = 300;
  segments.forEach((s, k) => {
    t += pauseBefore.get(k) ?? 0;
    for (let i = 0; i < s.seconds; i++) {
      time.push(t);
      distance.push(d);
      alt.push(a);
      hr.push(s.hr);
      t += 1;
      d += s.speed;
      a += s.speed * (s.grade ?? 0);
    }
  });
  return altitude ? { time, distance, altitude: alt, hr } : { time, distance, hr };
}

const close = (actual: number | undefined, expected: number, tolerance = 0.002) =>
  assert.ok(actual != null && Math.abs(actual - expected) <= tolerance, `${actual} is not about ${expected}`);

const FLAT: Segment = { seconds: 1800, speed: 3, hr: 150 };

test("Minetti's cost: 3.6 J/kg/m on the flat, more uphill, less on a gentle descent", () => {
  assert.equal(minettiCost(0), 3.6);
  assert.ok(minettiCost(0.1) > minettiCost(0));
  assert.ok(minettiCost(-0.1) < minettiCost(0));
  // Steep descents cost more again than gentle ones.
  assert.ok(minettiCost(-0.3) > minettiCost(-0.15));
});

test("a flat run: metres per beat", () => {
  // 3 m each second over 2.5 beats each second.
  close(runEfficiency(streams([FLAT])), 1.2);
});

test("a run without altitude counts as flat when it reports no climb, and has no value when it does", () => {
  close(runEfficiency(streams([FLAT], { altitude: false })), 1.2);
  close(runEfficiency(streams([FLAT], { altitude: false }), 0), 1.2);
  // An inclined treadmill: climbing, but no grade to adjust by.
  assert.equal(runEfficiency(streams([FLAT], { altitude: false }), 500), undefined);
  // With altitude samples the reported climb doesn't matter.
  close(runEfficiency(streams([FLAT]), 500), 1.2);
});

test("a steep climb taken slowly still counts: the speed cut is on grade-adjusted speed", () => {
  const value = runEfficiency(
    streams([
      { seconds: WARMUP_S, speed: 3, hr: 150 },
      { seconds: 600, speed: 3, hr: 150 },
      // 1.2 m/s up 20% is about 3 m/s on the flat.
      { seconds: 600, speed: 1.2, hr: 120, grade: 0.2 },
    ]),
  );
  const metres = 1800 + (720 * minettiCost(0.2)) / minettiCost(0);
  const beats = 600 * 2.5 + 600 * 2;
  close(value, metres / beats, 0.02);
});

test("climbing and descending at the same speed and heart rate counts as more work", () => {
  const hilly = runEfficiency(
    streams([
      { seconds: 600, speed: 3, hr: 150 },
      { seconds: 600, speed: 3, hr: 150, grade: 0.1 },
      { seconds: 600, speed: 3, hr: 150, grade: -0.1 },
    ]),
  );
  // Up and down at 10% costs (C(0.1) + C(-0.1)) / 2 per metre, more than the flat's C(0).
  close(hilly, 1.2 * ((minettiCost(0.1) + minettiCost(-0.1)) / 2 / 3.6), 0.02);
  assert.ok(hilly! > 1.25);
});

test("the warm-up does not count", () => {
  const warm = runEfficiency(streams([{ seconds: WARMUP_S, speed: 3, hr: 100 }, FLAT]));
  close(warm, 1.2);
});

test("pauses, walking and samples without heart rate do not count", () => {
  const value = runEfficiency(
    streams(
      [
        { seconds: 900, speed: 3, hr: 150 },
        { seconds: 300, speed: 1, hr: 110 },
        { seconds: 120, speed: 3, hr: null },
        { seconds: 900, speed: 3, hr: 150 },
      ],
      // A 5-minute stop with the watch paused, before the second running stretch.
      { pauseBefore: new Map([[3, 300]]) },
    ),
  );
  close(value, 1.2);
});

test("too little kept running, or no heart rate or distance, is no value", () => {
  // 19 minutes: 9 left after the warm-up.
  assert.equal(runEfficiency(streams([{ seconds: 1140, speed: 3, hr: 150 }])), undefined);
  assert.equal(runEfficiency(streams([{ ...FLAT, hr: null }])), undefined);
  const { time, hr } = streams([FLAT]);
  assert.equal(runEfficiency({ time, hr }), undefined);
});

test("heart rate recorded on its own rows, every few seconds, still counts", () => {
  // Some watches write heart rate on separate records from distance: interleave them, with
  // a heart-rate row every 10 s at the same time as a distance row.
  const time: number[] = [];
  const distance: (number | null)[] = [];
  const hr: (number | null)[] = [];
  for (let t = 0; t < 1800; t++) {
    time.push(t);
    distance.push(t * 3);
    hr.push(null);
    if (t % 10 === 0) {
      time.push(t);
      distance.push(null);
      hr.push(150);
    }
  }
  close(runEfficiency({ time, distance, hr }), 1.2);
});
