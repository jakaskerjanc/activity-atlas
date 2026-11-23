import { describe, expect, test } from "vitest";
import {
  fitnessComparison,
  fitnessPoints,
  paceAt,
  paceTicks,
  rollingLine,
  ROLLING_DAYS,
  timeTicks,
  type FitnessPoint,
} from "./fitness";
import { record } from "./testFixtures";

const DAY = 86_400;
const T0 = Date.UTC(2025, 0, 1) / 1000;
const point = (day: number, pace: number, id = `d${day}`): FitnessPoint => ({ id, name: id, ts: T0 + day * DAY, pace });

describe("paceAt", () => {
  test("flat-ground pace at 150 bpm, in seconds per km", () => {
    // 1.2 m per beat at 2.5 beats a second is 3 m/s: 333 s per km (5:33).
    expect(paceAt(1.2)).toBeCloseTo(1000 / 3, 6);
    expect(paceAt(1.2, 120)).toBeCloseTo(1000 / 2.4, 6);
  });
});

describe("fitnessPoints", () => {
  test("runs with an efficiency, oldest first", () => {
    const points = fitnessPoints([
      record({ id: "b", ts: T0 + 10, efficiency: 1.2 }),
      record({ id: "ride", type: "Ride", ts: T0 + 5, efficiency: 1.5 }),
      record({ id: "none", ts: T0 + 3 }),
      record({ id: "zero", ts: T0 + 4, efficiency: 0 }),
      record({ id: "a", name: "Morning run", ts: T0 + 1, efficiency: 1 }),
    ]);
    expect(points.map((p) => p.id)).toEqual(["a", "b"]);
    expect(points[0]).toEqual({ id: "a", name: "Morning run", ts: T0 + 1, pace: 400 });
  });
});

describe("rollingLine", () => {
  test("the median of the runs in the trailing window, once three are in it", () => {
    const line = rollingLine([point(0, 360), point(2, 330), point(4, 350), point(6, 300)]);
    // No line before the third run.
    expect(line.map((p) => p.ts)).toEqual([T0 + 4 * DAY, T0 + 6 * DAY]);
    expect(line[0].pace).toBe(350);
    // An even count: the mean of the middle two (330, 350).
    expect(line[1].pace).toBe(340);
  });

  test("runs older than the window drop out", () => {
    const line = rollingLine([
      point(0, 400),
      point(1, 400),
      point(2, 400),
      point(ROLLING_DAYS + 1, 300),
      point(ROLLING_DAYS + 2, 300),
      point(ROLLING_DAYS + 3, 300),
    ]);
    // Day 43 and 44 have only two runs in their window (day 1 is exactly 42 days back: out).
    expect(line.map((p) => [(p.ts - T0) / DAY, p.pace])).toEqual([
      [2, 400],
      [ROLLING_DAYS + 3, 300],
    ]);
  });
});

describe("fitnessComparison", () => {
  const line = (days: number[], pace = (d: number) => 360 - d / 10) => days.map((d) => ({ ts: T0 + d * DAY, pace: pace(d) }));

  test("the line now against the line a year earlier", () => {
    const c = fitnessComparison(line([0, 300, 360, 380, 700, 730]));
    expect(c?.now.ts).toBe(T0 + 730 * DAY);
    // The last point at or before 365 days earlier (day 365).
    expect(c?.then.ts).toBe(T0 + 360 * DAY);
  });

  test("none when the line is younger than a year", () => {
    expect(fitnessComparison(line([0, 100, 300]))).toBeNull();
    expect(fitnessComparison([])).toBeNull();
  });

  test("none when the line has a gap over the window around a year ago", () => {
    // Nothing between day 300 and day 700: day 300 is too far from day 365.
    expect(fitnessComparison(line([0, 300, 700, 730]))).toBeNull();
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
