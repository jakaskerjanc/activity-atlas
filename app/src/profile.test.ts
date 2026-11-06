import { describe, expect, test } from "vitest";
import {
  areaPath,
  buildProfile,
  linePath,
  nearestIndex,
  niceTicks,
  paceTicks,
  readout,
  summaryReadout,
  smoothSpeed,
} from "./profile";
import type { DetailFile } from "./types";

function detail(over: Partial<DetailFile> = {}): DetailFile {
  return { v: 1, step: 5, t: [0, 5, 10, 15], ...over };
}

const full = detail({
  d: [0, 15, 30, 45],
  alt: [300, 310, 320, 315],
  hr: [100, 120, 140, 150],
  speed: [3, 3, 3, 3],
  cad: [80, 82, 84, 86],
  lat: [46, 46.0001, 46.0002, 46.0003],
  lon: [14, 14, 14, 14],
});

describe("buildProfile", () => {
  test("charts follow the channels", () => {
    expect(buildProfile(full, "Run")!.charts.map((c) => c.kind)).toEqual(["elevation", "hr", "pace", "cadence"]);
    expect(buildProfile(full, "Ride")!.charts.map((c) => c.kind)).toEqual(["elevation", "hr", "speed", "cadence"]);
    expect(buildProfile(detail({ hr: [1, 2, 3, 4] }), "Run")!.charts.map((c) => c.kind)).toEqual(["hr"]);
    expect(buildProfile(detail({ cad: [1, 2, 3, 4] }), "Run")!.charts.map((c) => c.kind)).toEqual(["cadence"]);
    // All-zero cadence (a coasting sensor) has nothing to chart.
    expect(buildProfile(detail({ cad: [0, 0, 0, 0] }), "Run")).toBeNull();
  });

  test("x is distance when d exists, else time", () => {
    const p = buildProfile(detail({ d: [0, null, 30, 45], hr: [1, 2, 3, 4] }), "Run")!;
    expect(p.xKind).toBe("distance");
    expect(p.x).toEqual([0, 0, 30, 45]);
    const q = buildProfile(detail({ hr: [1, 2, 3, 4] }), "Run")!;
    expect(q.xKind).toBe("time");
    expect(q.x).toEqual([0, 5, 10, 15]);
  });

  test("pace is faster-up and gaps at stops", () => {
    const n = 40;
    const speed = Array.from({ length: n }, (_, i) => (i >= 15 && i < 25 ? 0 : 2.5));
    const t = speed.map((_, i) => i * 5);
    const pace = buildProfile(detail({ t, speed }), "Hike")!.charts[0];
    expect(pace.kind).toBe("pace");
    expect(pace.invert).toBe(true);
    expect(pace.values[20]).toBeNull();
    expect(pace.values[0]).toBeCloseTo(400);
  });

  test("pace domain spans p5..p95, so one slow stretch doesn't flatten it", () => {
    const n = 101;
    const speed = Array.from({ length: n }, (_, i) => (i === 50 ? 0.31 : 3 + (i % 10) / 100));
    const t = speed.map((_, i) => i * 5);
    const pace = buildProfile(detail({ t, speed }), "Run")!.charts[0];
    expect(pace.domain[1]).toBeLessThan(400); // the outlier (~3,200 s/km) is clipped
    expect(pace.domain[0]).toBeGreaterThanOrEqual(300); // widened to the whole minute
  });

  test("pace axis stops at twice the median, so a slow climb doesn't squash the walking", () => {
    // Median ~14:36/km with a long tail of slow climbing (~46 min/km).
    const speed = Array.from({ length: 200 }, (_, i) => (i < 140 ? 1.14 : 0.36));
    const t = speed.map((_, i) => i * 5);
    const pace = buildProfile(detail({ t, speed }), "Hike")!.charts[0];
    expect(pace.domain[1]).toBeCloseTo(2 * (1000 / 1.14), 0);
  });

  test("pace ticks land on whole minutes", () => {
    const speed = Array.from({ length: 100 }, (_, i) => 1000 / (600 + i * 12)); // 10:00 .. ~29:48 /km
    const pace = buildProfile(detail({ t: speed.map((_, i) => i * 5), speed }), "Hike")!.charts[0];
    const ticks = paceTicks(pace.domain[0], pace.domain[1]);
    expect(ticks.length).toBeGreaterThan(0);
    for (const t of ticks) expect(t % 60).toBe(0);
  });

  test("paceTicks only returns whole minutes, even on a narrow domain", () => {
    expect(paceTicks(290, 320)).toEqual([300]);
    expect(paceTicks(270, 330)).toEqual([300]);
    for (const t of paceTicks(290, 320)) expect(t % 60).toBe(0);
  });

  test("paceTicks on a wide domain steps by nice whole minutes", () => {
    const ticks = paceTicks(600, 1800);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    expect(ticks.length).toBeLessThanOrEqual(6);
    for (const t of ticks) {
      expect(t % 60).toBe(0);
      expect(t).toBeGreaterThanOrEqual(600);
      expect(t).toBeLessThanOrEqual(1800);
    }
  });

  test("paceTicks steps down to give at least two ticks (real hike and walk domains)", () => {
    for (const [lo, hi] of [[613, 1585], [671, 1136], [638, 826]]) {
      const ticks = paceTicks(lo, hi);
      expect(ticks.length).toBeGreaterThanOrEqual(2);
      for (const t of ticks) {
        expect(t % 60).toBe(0);
        expect(t).toBeGreaterThanOrEqual(lo);
        expect(t).toBeLessThanOrEqual(hi);
      }
    }
  });

  test("a steady run's narrow pace domain widens to whole minutes with >= 2 ticks", () => {
    const speed = Array.from({ length: 100 }, (_, i) => 3.4 + ((i % 5) - 2) * 0.01); // ~294 s/km +- 2
    const pace = buildProfile(detail({ t: speed.map((_, i) => i * 5), speed }), "Run")!.charts[0];
    const [lo, hi] = pace.domain;
    expect(lo % 60).toBe(0);
    expect(hi % 60).toBe(0);
    expect(paceTicks(lo, hi).length).toBeGreaterThanOrEqual(2);
  });

  test("speed is km/h from 0", () => {
    const sp = buildProfile(detail({ speed: [5, 5, 5, 5] }), "Ride")!.charts[0];
    expect(sp.kind).toBe("speed");
    expect(sp.invert).toBe(false);
    expect(sp.domain[0]).toBe(0);
    expect(sp.values[1]).toBeCloseTo(18);
  });

  test("flat elevation gets a 20 m window", () => {
    const el = buildProfile(detail({ alt: [300, 300, 300, 300] }), "Run")!.charts[0];
    expect(el.domain).toEqual([290, 310]);
  });
});

describe("smoothSpeed", () => {
  test("averages present neighbours in a centred window", () => {
    expect(smoothSpeed([1, 2, 6], 3)).toEqual([1.5, 3, 4]);
  });

  test("never fills a missing sample", () => {
    expect(smoothSpeed([1, null, 3], 3)).toEqual([1, null, 3]);
  });
});

describe("niceTicks", () => {
  test("steps down to give at least two ticks", () => {
    for (const [lo, hi, n] of [[120, 165, 2], [0.1, 0.4, 2], [3, 9, 1]]) {
      const ticks = niceTicks(lo, hi, n);
      expect(ticks.length).toBeGreaterThanOrEqual(2);
      for (const t of ticks) {
        expect(t).toBeGreaterThanOrEqual(lo);
        expect(t).toBeLessThanOrEqual(hi);
        expect(String(t).length).toBeLessThan(8); // no float artefacts
      }
    }
  });

  test("round steps inside the range", () => {
    expect(niceTicks(0, 1234, 3)).toEqual([0, 500, 1000]);
    expect(niceTicks(296, 342, 3)).toEqual([300, 320, 340]);
  });
});

describe("paths", () => {
  const id = (v: number) => v;
  test("linePath breaks at null", () => {
    const d = linePath([0, 1, 2, 3], [1, null, 2, 3], id, id);
    expect(d.match(/M/g)).toHaveLength(2);
    expect(d).toBe("M0.0,1.0M2.0,2.0L3.0,3.0");
  });

  test("areaPath closes each segment to the baseline", () => {
    const d = areaPath([0, 1, 2, 3], [1, 2, null, 3], id, id, 10);
    expect(d).toBe("M0.0,10.0L0.0,1.0L1.0,2.0L1.0,10.0ZM3.0,10.0L3.0,3.0L3.0,10.0Z");
  });
});

describe("nearestIndex", () => {
  test("picks the closest x", () => {
    const x = [0, 10, 20, 30];
    expect(nearestIndex(x, -5)).toBe(0);
    expect(nearestIndex(x, 14)).toBe(1);
    expect(nearestIndex(x, 16)).toBe(2);
    expect(nearestIndex(x, 99)).toBe(3);
  });
});

describe("readout", () => {
  test("lists present channels in order, distance first", () => {
    const p = buildProfile(full, "Run")!;
    const r = readout(full, p, 2, "Run");
    expect(r.map((e) => e.label)).toEqual(["km", "time", "m", "bpm", "/km", "spm"]);
    expect(r.map((e) => e.value)).toEqual(["0.03", "0:10", "320", "140", "5:33", "84"]);
  });

  test("a missing value at that index is a dash", () => {
    const d = { ...full, hr: [100, 120, null, 150] };
    const r = readout(d, buildProfile(d, "Run")!, 2, "Run");
    expect(r.find((e) => e.label === "bpm")!.value).toBe("—");
  });

  test("rides read speed and rpm", () => {
    const r = readout(full, buildProfile(full, "Ride")!, 2, "Ride");
    expect(r.map((e) => e.label)).toEqual(["km", "time", "m", "bpm", "km/h", "rpm"]);
    expect(r[4].value).toBe("10.8");
  });
});

describe("cadence", () => {
  test("is charted when recorded, so the readout's spm/rpm has a chart to point at", () => {
    expect(buildProfile(full, "Run")!.charts.map((c) => c.kind)).toContain("cadence");
  });
});

describe("summaryReadout", () => {
  test("the whole activity, in the same chips and order as the cursor readout", () => {
    const p = buildProfile(full, "Run")!;
    const s = summaryReadout(full, p, "Run");
    expect(s.map((e) => e.label)).toEqual(["km", "time", "m high", "bpm avg", "/km avg", "spm avg"]);
    expect(s).toHaveLength(readout(full, p, 2, "Run").length);
    expect(s[0].value).toBe(readout(full, p, full.t.length - 1, "Run")[0].value);
  });
});
