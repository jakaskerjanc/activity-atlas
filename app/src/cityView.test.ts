import { describe, expect, test } from "vitest";
import type { CityComparison } from "./cityMatch";
import type { CityDistance } from "./cities";
import {
  cityCards,
  cityRouteSubtitle,
  comparisonDetail,
  countryName,
  formatShare,
  formatTripKm,
  pickLead,
  routeTitle,
} from "./cityView";

const origin = { name: "Ljubljana", lat: 46.0569, lon: 14.5058 };

const lisbon: CityDistance = {
  id: 2267057, name: "Lisbon", country: "PT", fc: "PPLC",
  lat: 38.7167, lon: -9.1333, population: 517802,
  cycling: { m: 2_818_000, coords: [[14.5, 46], [-9.1, 38.7]] },
  walking: null,
};

function comparison(over: Partial<CityComparison["pick"]> = {}, totalM = 2_704_300): CityComparison {
  return {
    profile: "cycling",
    totalM,
    pick: { kind: "match", city: lisbon, route: lisbon.cycling!, ratio: totalM / 2_818_000, ...over },
  };
}

describe("formatTripKm", () => {
  test("whole km with separators, one decimal under 10 km", () => {
    expect(formatTripKm(2_704_300)).toBe("2,704");
    expect(formatTripKm(26_400)).toBe("26");
    expect(formatTripKm(7_420)).toBe("7.4");
  });
});

describe("formatShare", () => {
  test("percent up to twice the route, then a multiple", () => {
    expect(formatShare(0.9597)).toBe("96%");
    expect(formatShare(1.44)).toBe("144%");
    expect(formatShare(2.31)).toBe("2.3×");
  });
});

describe("countryName", () => {
  test("names a country, and falls back to the code", () => {
    expect(countryName("PT")).toBe("Portugal");
    expect(countryName("not a code")).toBe("not a code");
  });
});

describe("comparison text", () => {
  test("titles the route from the origin", () => {
    expect(routeTitle(origin, lisbon)).toBe("Ljubljana → Lisbon");
  });

  test("details the route distance, country and share", () => {
    expect(comparisonDetail(comparison())).toBe("2,818 km by bike · Portugal · 96% of the way");
  });

  test("leads with how a total misses every city", () => {
    expect(pickLead(comparison())).toBeNull();
    expect(pickLead(comparison({ kind: "under" }))).toBe("Not yet");
    expect(pickLead(comparison({ kind: "over" }))).toBe("Beyond");
  });

  test("the map panel's subtitle", () => {
    expect(cityRouteSubtitle(comparison())).toBe("By bike · Portugal");
  });

  test("the map panel's cards", () => {
    const cards = cityCards(comparison(), origin);
    expect(cards.map((c) => [c.label, c.value])).toEqual([
      ["Route", "2,818"],
      ["Rides total", "2,704"],
      ["Of the way", "96%"],
      // Ljubljana → Lisbon is ~2,010 km as the crow flies.
      ["As the crow flies", expect.stringMatching(/^2,0\d\d$/)],
    ]);
    expect(cards[0].accent).toBe(true);
  });
});
