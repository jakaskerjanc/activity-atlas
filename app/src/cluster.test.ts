import { describe, expect, test } from "vitest";
import { densestClusterBounds } from "./cluster";
import type { ActivityFeature } from "./types";

function route(coords: [number, number][]): ActivityFeature {
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: coords },
    properties: {
      id: 1,
      name: "Test",
      type: "Run",
      ts: 1000,
      start_date: "2024-08-18T09:58:55Z",
      distance: 1000,
      moving_time: 300,
      elevation_gain: 10,
    },
  };
}

describe("densestClusterBounds", () => {
  test("empty set → null", () => {
    expect(densestClusterBounds([])).toBeNull();
  });

  test("single shared location → bounds of everything", () => {
    const pt = route([
      [14.5, 46.05],
      [14.51, 46.06],
    ]);
    expect(densestClusterBounds([pt, pt])).toEqual([14.5, 46.05, 14.51, 46.06]);
  });

  test("excludes far-flung outliers, keeps the dense home cluster", () => {
    const home: ActivityFeature[] = [];
    for (let i = 0; i < 20; i++) {
      const d = i * 0.001;
      home.push(route([
        [0 + d, 0 + d],
        [0.02 + d, 0.02 + d],
      ]));
    }
    const outliers = [
      route([[100, 100], [100.1, 100.1]]),
      route([[-80, 40], [-80.1, 40.1]]),
    ];

    const box = densestClusterBounds([...home, ...outliers]);
    expect(box).not.toBeNull();
    const [w, s, e, n] = box!;
    // Framed on the home cluster (~0..0.04), nowhere near the 100 / -80 outliers.
    expect(w).toBeGreaterThanOrEqual(0);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(e).toBeLessThan(1);
    expect(n).toBeLessThan(1);
  });

  test("refines onto a tight dense knot over a looser nearby spread", () => {
    // A tight knot of 40 activities in ~[10.00, 10.02], plus 15 loosely spread over a
    // wider area around it. The refinement should zoom onto the knot.
    const knot: ActivityFeature[] = [];
    for (let i = 0; i < 40; i++) {
      const d = (i % 20) * 0.001;
      knot.push(route([[10 + d, 46 + d], [10.001 + d, 46.001 + d]]));
    }
    const loose: ActivityFeature[] = [];
    for (let i = 0; i < 15; i++) {
      const d = i * 0.05; // spread up to ~0.75° away
      loose.push(route([[10.3 + d, 46.3 + d], [10.31 + d, 46.31 + d]]));
    }
    const box = densestClusterBounds([...knot, ...loose])!;
    expect(box).not.toBeNull();
    // The knot centres sit below ~10.03 / 46.03; the loose spread reaches far past that.
    expect(box[2]).toBeLessThan(10.1);
    expect(box[3]).toBeLessThan(46.1);
  });
});
