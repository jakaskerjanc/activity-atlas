import { describe, expect, test } from "vitest";
import {
  climbCorrection,
  climbSlope,
  fitnessComparison,
  fitnessPoints,
  paceAt,
  paceTicks,
  rollingLine,
  timeTicks,
  type FitnessPoint,
  type FitRun,
  type LinePoint,
} from "./fitness";
import { record } from "./testFixtures";

const DAY = 86_400;
const T0 = Date.UTC(2025, 0, 1) / 1000;
const point = (day: number, pace: number, id = `d${day}`): FitnessPoint => ({
  id,
  name: id,
  ts: T0 + day * DAY,
  pace,
  rawPace: pace,
  climb: 0,
});
/** The middle of the k-th two-month time bin from Jan 2025 (Jan–Feb, Mar–Apr, …). */
const binTs = (k: number) => Date.UTC(2025, 2 * k, 20) / 1000;

describe("paceAt", () => {
  test("flat-ground pace at 150 bpm, in seconds per km", () => {
    // 1.2 m per beat at 2.5 beats a second is 3 m/s: 333 s per km (5:33).
    expect(paceAt(1.2)).toBeCloseTo(1000 / 3, 6);
    expect(paceAt(1.2, 120)).toBeCloseTo(1000 / 2.4, 6);
  });
});

describe("climbSlope", () => {
  test("by hand: climbing 10 m per km more reads 10 s/km slower, a slope of 1", () => {
    const runs: FitRun[] = Array.from({ length: 20 }, (_, i) => ({
      ts: binTs(0) + i * 3600,
      pace: i % 2 ? 310 : 300,
      climb: i % 2 ? 10 : 0,
    }));
    expect(climbSlope(runs)).toBeCloseTo(1, 9);
  });

  test("recovers a known slope while fitness changes from bin to bin", () => {
    // Six bins, each 10 s/km faster than the one before, five runs a bin over the same
    // climbs: pace = level of the bin + 0.9 × climb.
    const runs: FitRun[] = [];
    for (let k = 0; k < 6; k++) {
      for (const [j, climb] of [0, 5, 10, 20, 30].entries()) {
        runs.push({ ts: binTs(k) + j * DAY, pace: 400 - 10 * k + 0.9 * climb, climb });
      }
    }
    expect(climbSlope(runs)).toBeCloseTo(0.9, 9);
  });

  test("a fitness trend doesn't leak into the slope", () => {
    // Early bins are both hillier and slower, but within a bin climbing doesn't change
    // the pace: one line through all the runs would read hills as slow; the bins don't.
    const runs: FitRun[] = [];
    for (let k = 0; k < 6; k++) {
      for (const [j, extra] of [0, 2, 4, 6].entries()) {
        runs.push({ ts: binTs(k) + j * DAY, pace: 400 - 10 * k, climb: 40 - 5 * k + extra });
      }
    }
    const pooled = (() => {
      const mx = runs.reduce((s, r) => s + r.climb, 0) / runs.length;
      const my = runs.reduce((s, r) => s + r.pace, 0) / runs.length;
      const sxy = runs.reduce((s, r) => s + (r.climb - mx) * (r.pace - my), 0);
      return sxy / runs.reduce((s, r) => s + (r.climb - mx) ** 2, 0);
    })();
    expect(pooled).toBeGreaterThan(1);
    expect(climbSlope(runs)).toBeCloseTo(0, 9);
  });

  test("0 with too few runs to fit, counting only runs that share a bin", () => {
    const pair = (k: number): FitRun[] => [
      { ts: binTs(k), pace: 300, climb: 0 },
      { ts: binTs(k) + DAY, pace: 310, climb: 10 },
    ];
    // 9 bins of two: 18 runs.
    expect(climbSlope(Array.from({ length: 9 }, (_, k) => pair(k)).flat())).toBe(0);
    // A 10th bin of two reaches 20.
    expect(climbSlope(Array.from({ length: 10 }, (_, k) => pair(k)).flat())).toBeCloseTo(1, 9);
    // 20 runs alone in their bins say nothing about the slope.
    expect(climbSlope(Array.from({ length: 20 }, (_, k) => ({ ts: binTs(k), pace: 300 + k, climb: k })))).toBe(0);
    expect(climbSlope([])).toBe(0);
  });

  test("0 when the climbs don't vary, and never below 0", () => {
    const flat = Array.from({ length: 20 }, (_, i) => ({ ts: binTs(0) + i, pace: 300 + i, climb: 5 }));
    expect(climbSlope(flat)).toBe(0);
    const downhill = Array.from({ length: 20 }, (_, i) => ({ ts: binTs(0) + i, pace: 300 - i, climb: i }));
    expect(climbSlope(downhill)).toBe(0);
  });
});

describe("climbCorrection", () => {
  test("fits climb per km (elevation gain over distance) of the runs with a value", () => {
    const runs = Array.from({ length: 20 }, (_, i) =>
      record({
        id: `r${i}`,
        ts: binTs(0) + i * 3600,
        // 10 km, 0 or 100 m climbed: 0 or 10 m/km; 5:33 and 5:43 at 150 bpm.
        distance: 10_000,
        elevation_gain: i % 2 ? 100 : 0,
        efficiency: 1000 / (2.5 * (i % 2 ? 343 : 333)),
      }),
    );
    const others = [
      record({ id: "ride", type: "Ride", ts: binTs(0), efficiency: 2, elevation_gain: 900 }),
      record({ id: "no-gain", ts: binTs(0), efficiency: 0.5, elevation_gain: undefined }),
    ];
    expect(climbCorrection([...runs, ...others])).toBeCloseTo(1, 6);
  });
});

describe("fitnessPoints", () => {
  test("runs with a value, distance and climb, oldest first, less the climb correction", () => {
    const points = fitnessPoints(
      [
        record({ id: "b", ts: T0 + 10, efficiency: 1.2, distance: 5000, elevation_gain: 100 }),
        record({ id: "ride", type: "Ride", ts: T0 + 5, efficiency: 1.5 }),
        record({ id: "none", ts: T0 + 3 }),
        record({ id: "zero", ts: T0 + 4, efficiency: 0 }),
        record({ id: "no-gain", ts: T0 + 6, efficiency: 1, elevation_gain: undefined }),
        record({ id: "no-distance", ts: T0 + 7, efficiency: 1, distance: undefined }),
        record({ id: "a", name: "Morning run", ts: T0 + 1, efficiency: 1, distance: 10_000, elevation_gain: 0 }),
      ],
      0.5,
    );
    expect(points.map((p) => p.id)).toEqual(["a", "b"]);
    expect(points[0]).toEqual({ id: "a", name: "Morning run", ts: T0 + 1, pace: 400, rawPace: 400, climb: 0 });
    // 20 m/km climbed: 0.5 × 20 = 10 s/km credited.
    expect(points[1].climb).toBe(20);
    expect(points[1].rawPace).toBeCloseTo(1000 / 3, 6);
    expect(points[1].pace).toBeCloseTo(1000 / 3 - 10, 6);
  });
});

describe("rollingLine", () => {
  const days = (line: LinePoint[][]) => line.map((seg) => seg.map((p) => (p.ts - T0) / DAY));

  test("weekly back from the newest run: the mean of the trailing window, once five runs are in it", () => {
    const line = rollingLine([0, 7, 14, 21, 28, 35].map((d, i) => point(d, 300 + 10 * i)));
    expect(days(line)).toEqual([[28, 35]]);
    expect(line[0][0]).toMatchObject({ pace: 320, runs: 5 });
    // Standard deviation of 300…340 is √250, over √5 runs.
    expect(line[0][0].se).toBeCloseTo(Math.sqrt(250 / 5), 9);
    expect(line[0][1]).toMatchObject({ pace: 325, runs: 6 });
  });

  test("runs older than the window drop out (exactly 91 days back is out)", () => {
    const line = rollingLine([point(4, 1000), ...[91, 92, 93, 94, 95].map((d) => point(d, 300))]);
    expect(days(line)).toEqual([[95]]);
    expect(line[0][0].pace).toBe(300);
  });

  test("breaks where the newest run in the window is over 28 days old, without bridging", () => {
    const every3 = (from: number, to: number) =>
      Array.from({ length: (to - from) / 3 + 1 }, (_, i) => point(from + 3 * i, 330));
    const line = rollingLine([...every3(0, 60), ...every3(200, 260)]);
    // Ends at 260, 253, …: day 85 is 25 days after the run on day 60, day 92 is 32.
    // Day 211 has four runs in its window, day 218 seven.
    expect(line.map((seg) => [seg[0], seg[seg.length - 1]].map((p) => (p.ts - T0) / DAY))).toEqual([
      [15, 85],
      [218, 260],
    ]);
  });

  test("no line without runs", () => {
    expect(rollingLine([])).toEqual([]);
  });
});

describe("fitnessComparison", () => {
  const seg = (days: number[], pace = (d: number) => 360 - d / 10): LinePoint[] =>
    days.map((d) => ({ ts: T0 + d * DAY, pace: pace(d), se: 5, runs: 10 }));

  test("the line now against the line a year earlier, across its breaks", () => {
    const c = fitnessComparison([seg([0, 300]), seg([360, 380]), seg([700, 730])]);
    expect(c?.now.ts).toBe(T0 + 730 * DAY);
    // The last point at or before 365 days earlier (day 365).
    expect(c?.then.ts).toBe(T0 + 360 * DAY);
  });

  test("none when the line is younger than a year", () => {
    expect(fitnessComparison([seg([0, 100, 300])])).toBeNull();
    expect(fitnessComparison([])).toBeNull();
  });

  test("none when the line has a gap over 28 days around a year ago", () => {
    // Nothing between day 300 and day 700: day 300 is too far from day 365.
    expect(fitnessComparison([seg([0, 300]), seg([700, 730])])).toBeNull();
  });
});

describe("paceTicks", () => {
  test("whole steps of a clock, wide enough to cover the paces in a few ticks", () => {
    expect(paceTicks(300, 400, 4)).toEqual([300, 330, 360, 390, 420]);
    expect(paceTicks(318, 342, 4)).toEqual([310, 320, 330, 340, 350]);
    expect(paceTicks(270, 510, 4)).toEqual([240, 360, 480, 600]);
  });

  test("a single pace still gets an axis around it", () => {
    expect(paceTicks(333, 333, 4)).toEqual([330, 335]);
  });
});

describe("timeTicks", () => {
  const at = (iso: string) => Date.parse(iso) / 1000;

  test("month starts every few months, January named by its year", () => {
    expect(timeTicks(at("2025-01-15T00:00:00Z"), at("2026-12-01T00:00:00Z"), 6)).toEqual([
      { ts: at("2025-07-01T00:00:00Z"), label: "Jul" },
      { ts: at("2026-01-01T00:00:00Z"), label: "2026" },
      { ts: at("2026-07-01T00:00:00Z"), label: "Jul" },
    ]);
  });

  test("every month when they fit", () => {
    expect(timeTicks(at("2025-11-20T00:00:00Z"), at("2026-02-10T00:00:00Z"), 6).map((t) => t.label)).toEqual([
      "Dec",
      "2026",
      "Feb",
    ]);
  });

  test("years only over a long span", () => {
    expect(timeTicks(at("2020-03-01T00:00:00Z"), at("2026-11-01T00:00:00Z"), 8).map((t) => t.label)).toEqual([
      "2021",
      "2022",
      "2023",
      "2024",
      "2025",
      "2026",
    ]);
  });
});
