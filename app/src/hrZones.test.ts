import { describe, expect, test } from "vitest";
import { formatHours, formatShare, zoneBands, zoneSummary } from "./hrZones";
import { monthIndex } from "./format";
import { record } from "./testFixtures";

const AUG_2024 = monthIndex(Date.UTC(2024, 7, 18) / 1000);

describe("zoneBands", () => {
  test("names each band with its bpm range from the reference limits", () => {
    expect(zoneBands([100, 119, 139, 159, 179])).toEqual([
      { label: "Below zone 1", range: "under 100 bpm" },
      { label: "Zone 1", range: "100–119 bpm" },
      { label: "Zone 2", range: "119–139 bpm" },
      { label: "Zone 3", range: "139–159 bpm" },
      { label: "Zone 4", range: "159–179 bpm" },
      { label: "Zone 5", range: "179+ bpm" },
    ]);
  });
});

describe("zoneSummary", () => {
  const sep = Date.UTC(2024, 8, 3) / 1000;

  test("adds the bands over the activities and per month of the range, empty months included", () => {
    const s = zoneSummary(
      [
        record({ id: "a", hr_zones: [60, 120, 0, 0, 0, 0] }),
        record({ id: "b", hr_zones: [0, 0, 300, 60, 0, 0] }),
        record({ id: "c", ts: sep, hr_zones: [0, 0, 0, 0, 30, 30] }),
      ],
      AUG_2024 - 1,
      AUG_2024 + 1,
    );
    expect(s.seconds).toEqual([60, 120, 300, 60, 30, 30]);
    expect(s.total).toBe(600);
    expect(s.counted).toBe(3);
    expect(s.missing).toBe(0);
    expect(s.months.map((m) => [m.month - AUG_2024, m.total, m.activities])).toEqual([
      [-1, 0, 0],
      [0, 540, 2],
      [1, 60, 1],
    ]);
    expect(s.months[1].seconds).toEqual([60, 120, 300, 60, 0, 0]);
  });

  test("leaves out and counts activities without zones, never as 0", () => {
    const s = zoneSummary(
      [
        record({ id: "a", hr_zones: [0, 600, 0, 0, 0, 0] }),
        record({ id: "none" }),
        record({ id: "zeros", hr_zones: [0, 0, 0, 0, 0, 0] }),
        record({ id: "short", hr_zones: [1, 2, 3] }),
      ],
      AUG_2024,
      AUG_2024,
    );
    expect(s.counted).toBe(1);
    expect(s.missing).toBe(3);
    expect(s.total).toBe(600);
    expect(s.months[0].activities).toBe(1);
  });
});

describe("formatting", () => {
  test("shares as whole percentages, a sliver as <1%", () => {
    expect(formatShare(1, 4)).toBe("25%");
    expect(formatShare(1, 1000)).toBe("<1%");
    expect(formatShare(0, 10)).toBe("0%");
    expect(formatShare(5, 0)).toBe("0%");
  });

  test("minutes under an hour, hours with a decimal under 10", () => {
    expect(formatHours(0)).toBe("0 h");
    expect(formatHours(20)).toBe("<1 min");
    expect(formatHours(1500)).toBe("25 min");
    expect(formatHours(3590)).toBe("1.0 h");
    expect(formatHours(5400)).toBe("1.5 h");
    expect(formatHours(36000 * 12.4)).toBe("124 h");
  });
});
