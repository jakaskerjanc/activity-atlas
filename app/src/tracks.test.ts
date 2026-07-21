import { describe, expect, test } from "vitest";
import polyline from "@mapbox/polyline";
import { decodeTracks, PAYLOAD_VERSION } from "./tracks";
import type { EncodedTrack, TrackPayload } from "./types";

/** Encode a [lng, lat] path the way scripts/build-tracks.ts does. */
function encodeLngLat(coords: [number, number][]): string {
  return polyline.encode(coords.map(([lng, lat]) => [lat, lng] as [number, number]));
}

function track(over: Partial<EncodedTrack> & { poly: string }): EncodedTrack {
  return {
    id: 1,
    name: "Test",
    type: "Run",
    ts: 1723975135,
    start_date: "2024-08-18T09:58:55Z",
    distance: 10000,
    moving_time: 3000,
    elevation_gain: 100,
    ...over,
  };
}

const PATH: [number, number][] = [
  [14.48691, 46.05017],
  [14.4906, 46.05243],
  [14.49459, 46.05698],
];

describe("decodeTracks", () => {
  test("expands a payload into a GeoJSON FeatureCollection", () => {
    const fc = decodeTracks({ v: 1, tracks: [track({ poly: encodeLngLat(PATH) })] });
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].type).toBe("Feature");
    expect(fc.features[0].geometry.type).toBe("LineString");
  });

  test("round-trips coordinates in [lng, lat] order (5-decimal precision)", () => {
    const fc = decodeTracks({ v: 1, tracks: [track({ poly: encodeLngLat(PATH) })] });
    const coords = fc.features[0].geometry.coordinates as [number, number][];
    expect(coords).toHaveLength(PATH.length);
    coords.forEach(([lng, lat], i) => {
      expect(lng).toBeCloseTo(PATH[i][0], 5);
      expect(lat).toBeCloseTo(PATH[i][1], 5);
      // longitude first — guards against a lat/lng swap regression
      expect(lng).toBeLessThan(lat);
    });
  });

  test("carries the filterable props through onto feature.properties", () => {
    const fc = decodeTracks({
      v: 1,
      tracks: [
        track({
          poly: encodeLngLat(PATH),
          id: 42,
          name: "Morning Ride",
          type: "Ride",
          ts: 1700000000,
          distance: 25000,
          moving_time: 3600,
          elevation_gain: 350,
        }),
      ],
    });
    expect(fc.features[0].properties).toEqual({
      id: 42,
      name: "Morning Ride",
      type: "Ride",
      ts: 1700000000,
      start_date: "2024-08-18T09:58:55Z",
      distance: 25000,
      moving_time: 3600,
      elevation_gain: 350,
    });
    // poly must not leak into properties
    expect("poly" in fc.features[0].properties).toBe(false);
  });

  test("empty payload yields an empty FeatureCollection", () => {
    expect(decodeTracks({ v: 1, tracks: [] }).features).toEqual([]);
  });

  test("drops degenerate geometries (< 2 points) instead of emitting them", () => {
    const onePoint = encodeLngLat([[14.5, 46.05]]); // a single coordinate
    const fc = decodeTracks({
      v: 1,
      tracks: [
        track({ id: 1, poly: onePoint }),
        track({ id: 2, poly: encodeLngLat(PATH) }),
      ],
    });
    expect(fc.features.map((f) => f.properties.id)).toEqual([2]);
  });

  test("throws on an unsupported payload version", () => {
    const bad = { v: PAYLOAD_VERSION + 1, tracks: [] } as TrackPayload;
    expect(() => decodeTracks(bad)).toThrow(/Unsupported tracks payload version/);
  });
});
