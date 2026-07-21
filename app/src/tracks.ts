// Decode the compact tracks.json wire format into the GeoJSON FeatureCollection
// the map + panels consume. The build ships Google-encoded polylines instead of
// decoded coordinate arrays (~2x smaller, cheaper to parse); we expand them here.
// Keep in sync with scripts/build-tracks.ts (the encoder side).

import polyline from "@mapbox/polyline";
import type {
  ActivityFeature,
  ActivityFeatureCollection,
  EncodedTrack,
  TrackPayload,
} from "./types";

/** Wire-format version this decoder understands (see scripts/build-tracks.ts). */
export const PAYLOAD_VERSION = 1;

function toFeature(track: EncodedTrack): ActivityFeature | null {
  const { poly, ...properties } = track;
  // @mapbox/polyline decodes to [lat, lng]; GeoJSON needs [lng, lat].
  const coordinates = polyline
    .decode(poly)
    .map(([lat, lng]) => [lng, lat] as [number, number]);
  // A LineString needs >= 2 points. The builder guarantees this, but guard
  // here too since decode is the app's only ingestion point — a corrupt or
  // truncated payload shouldn't reach the map as a degenerate geometry.
  if (coordinates.length < 2) return null;
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates },
    properties,
  };
}

/** Expand a tracks.json payload into the GeoJSON FeatureCollection the UI uses. */
export function decodeTracks(payload: TrackPayload): ActivityFeatureCollection {
  if (payload.v !== PAYLOAD_VERSION) {
    throw new Error(
      `Unsupported tracks payload version ${payload.v} (expected ${PAYLOAD_VERSION})`,
    );
  }
  return {
    type: "FeatureCollection",
    features: payload.tracks
      .map(toFeature)
      .filter((f): f is ActivityFeature => f !== null),
  };
}
