// Node decoder for the database's stream blobs. Mirrors ingest/codec.py
// (ENCODING_VERSION 1), one blob per channel:
//   zlib( int64 LE deltas ), each delta against the last *present* quantized
//   value (0 before the first); the sentinel -2**63 marks a missing sample and
//   does not move the running value. Decoded value = quantized / scale.
// Checked against Python-encoded blobs in scripts/fixtures/codec.json.

import { inflateSync } from "node:zlib";

export const ENCODING_VERSION = 1;

export type StreamChannel =
  | "time"
  | "lat"
  | "lon"
  | "altitude"
  | "hr"
  | "cadence"
  | "speed"
  | "distance"
  | "power"
  | "temperature";

/** Quantization scale per channel; must equal ingest/codec.py CHANNEL_SCALES. */
export const CHANNEL_SCALES: Record<StreamChannel, number> = {
  time: 1,
  lat: 1e7,
  lon: 1e7,
  altitude: 10,
  hr: 1,
  cadence: 1,
  speed: 1000,
  distance: 100,
  power: 1,
  temperature: 1,
};

const MISSING = -(2n ** 63n);

/** Decode one channel blob into values (null for a missing sample). */
export function decodeChannel(channel: StreamChannel, blob: Uint8Array): (number | null)[] {
  if (!Object.hasOwn(CHANNEL_SCALES, channel)) throw new Error(`unknown stream channel: ${channel}`);
  const scale = CHANNEL_SCALES[channel];
  const raw = inflateSync(blob);
  if (raw.length % 8 !== 0) throw new Error(`${channel}: blob is not a whole number of int64s`);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const out: (number | null)[] = new Array(raw.length / 8);
  let prev = 0n;
  for (let i = 0; i < out.length; i++) {
    const d = view.getBigInt64(i * 8, true);
    if (d === MISSING) {
      out[i] = null;
      continue;
    }
    prev += d;
    out[i] = Number(prev) / scale;
  }
  return out;
}
