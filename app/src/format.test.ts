import { describe, expect, test } from "vitest";
import {
  formatKm,
  formatDuration,
  pacePerKm,
  speedKmh,
  formatDate,
  formatDateYear,
  isFootBased,
} from "./format";

describe("formatKm", () => {
  test("meters to km with one decimal by default", () => {
    expect(formatKm(9944)).toBe("9.9");
  });
  test("respects digit count", () => {
    expect(formatKm(9944, 0)).toBe("10");
  });
  test("zero meters", () => {
    expect(formatKm(0)).toBe("0.0");
  });
});

describe("formatDuration", () => {
  test("under an hour shows minutes only", () => {
    expect(formatDuration(2849)).toBe("47m");
  });
  test("over an hour shows hours and minutes", () => {
    expect(formatDuration(5933)).toBe("1h 39m");
  });
  test("exact hour", () => {
    expect(formatDuration(3600)).toBe("1h 0m");
  });
  test("zero", () => {
    expect(formatDuration(0)).toBe("0m");
  });
});

describe("pacePerKm", () => {
  test("minutes:seconds per km", () => {
    // 10 km in 50 min => 5:00 /km
    expect(pacePerKm(10000, 3000)).toBe("5:00");
  });
  test("pads seconds", () => {
    // 10 km in 51 min => 5:06 /km
    expect(pacePerKm(10000, 3060)).toBe("5:06");
  });
  test("zero distance yields dash", () => {
    expect(pacePerKm(0, 100)).toBe("—");
  });
});

describe("speedKmh", () => {
  test("km per hour with one decimal", () => {
    // 30 km in 1 h => 30.0
    expect(speedKmh(30000, 3600)).toBe("30.0");
  });
  test("zero time yields dash", () => {
    expect(speedKmh(1000, 0)).toBe("—");
  });
});

describe("formatDate", () => {
  test("formats epoch seconds as short month + day (UTC)", () => {
    // 2024-08-18T09:58:55Z
    expect(formatDate(1723975135)).toBe("Aug 18");
  });
});

describe("formatDateYear", () => {
  test("formats epoch seconds as short month + day + year (UTC)", () => {
    // 2024-08-18T09:58:55Z
    expect(formatDateYear(1723975135)).toBe("Aug 18, 2024");
  });
});

describe("isFootBased", () => {
  test.each(["Run", "TrailRun", "Trail Run", "Walk", "Hike", "VirtualRun"])(
    "%s is foot-based",
    (t) => expect(isFootBased(t)).toBe(true),
  );
  test.each(["Ride", "Swim", "EBikeRide", "Kayaking"])(
    "%s is not foot-based",
    (t) => expect(isFootBased(t)).toBe(false),
  );
});
