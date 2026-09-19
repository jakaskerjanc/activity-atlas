import { describe, expect, test } from "vitest";
import {
  formatKm,
  formatDuration,
  pacePerKm,
  speedKmh,
  formatDate,
  monthIndex,
  monthStart,
  monthEnd,
  formatMonth,
  isFootBased,
  activityLink,
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
  test("formats epoch seconds as short month + day + year (UTC)", () => {
    // 2024-08-18T09:58:55Z
    expect(formatDate(1723975135)).toBe("Aug 18, 2024");
  });
});

describe("month index helpers", () => {
  // 2024-08-18T09:58:55Z -> August (zero-based 7) => 2024 * 12 + 7
  const AUG_2024 = 2024 * 12 + 7;

  test("monthIndex maps a timestamp to year * 12 + month", () => {
    expect(monthIndex(1723975135)).toBe(AUG_2024);
  });

  test("monthStart is 00:00 UTC on the 1st", () => {
    expect(new Date(monthStart(AUG_2024) * 1000).toISOString()).toBe(
      "2024-08-01T00:00:00.000Z",
    );
  });

  test("monthEnd is the last second of the month", () => {
    expect(new Date(monthEnd(AUG_2024) * 1000).toISOString()).toBe(
      "2024-08-31T23:59:59.000Z",
    );
  });

  test("adjacent indices step exactly one month, across a year boundary", () => {
    expect(monthIndex(monthStart(AUG_2024 + 5))).toBe(AUG_2024 + 5); // Jan 2025
    expect(monthEnd(AUG_2024 + 5) + 1).toBe(monthStart(AUG_2024 + 6));
  });

  test("formatMonth reads long month + year", () => {
    expect(formatMonth(AUG_2024)).toBe("August 2024");
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

describe("activityLink", () => {
  test("strava id -> strava url", () => {
    expect(activityLink("s:10089952322")).toEqual({
      url: "https://www.strava.com/activities/10089952322",
      label: "View on Strava",
    });
  });
  test("garmin id -> garmin url", () => {
    expect(activityLink("g:12345678")).toEqual({
      url: "https://connect.garmin.com/modern/activity/12345678",
      label: "View on Garmin Connect",
    });
  });
  test("unknown prefix / malformed -> null", () => {
    expect(activityLink("x:1")).toBeNull();
    expect(activityLink("")).toBeNull();
    expect(activityLink("12345")).toBeNull();
  });
});
