import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGeonamesLine, prefilter, serializeCities } from "./prepare-geonames.ts";
import type { GeoCity } from "./city-types.ts";

// cities15000.txt columns: 0 id, 1 name, 2 asciiname, 3 alternatenames, 4 lat,
// 5 lon, 6 feature class, 7 feature code, 8 country, … 14 population, …
const ZAGREB = [
  "3186886", "Zagreb", "Zagreb", "Agram,Zagabria", "45.81444", "15.97798", "P", "PPLC",
  "HR", "", "21", "", "", "", "698966", "", "158", "Europe/Zagreb", "2019-09-05",
].join("\t");

test("parseGeonamesLine: picks the seven fields", () => {
  assert.deepEqual(parseGeonamesLine(ZAGREB), {
    id: 3186886, name: "Zagreb", country: "HR", lat: 45.81444, lon: 15.97798,
    population: 698966, fc: "PPLC",
  });
});

test("parseGeonamesLine: rejects blank and short lines", () => {
  assert.equal(parseGeonamesLine(""), null);
  assert.equal(parseGeonamesLine("1\tX\tX"), null);
});

function geo(id: number, lat: number, lon: number, population: number): GeoCity {
  return { id, name: `C${id}`, country: "XX", lat, lon, population, fc: "PPL" };
}

test("prefilter: drops the origin itself, under-floor and out-of-range cities", () => {
  const out = prefilter([
    geo(4, 45.815, 15.9819, 700_000), // Zagreb-ish, kept
    geo(1, 46.0569, 14.5058, 280_000), // origin, < 20 km
    geo(3, 51.5, -0.12, 20_000), // London-ish distance, under floor
    geo(2, 45.815, 15.9819, 16_000), // ~117 km, floor 15k, kept
  ]);
  assert.deepEqual(out.map((c) => c.id), [2, 4]);
});

test("serializeCities: one object per line, parseable", () => {
  const text = serializeCities([geo(1, 1, 1, 1), geo(2, 2, 2, 2)]);
  assert.equal(text.split("\n").length, 4); // [ , row, row, ]
  assert.equal(JSON.parse(text).length, 2);
});

test("prefilter: drops city districts, historical and abandoned places", () => {
  const at = (id: number, fc: string): GeoCity => ({ ...geo(id, 45.815, 15.9819, 700_000), fc });
  const out = prefilter([at(1, "PPLX"), at(2, "PPLH"), at(3, "PPLQ"), at(4, "PPLA2"), at(5, "PPLC")]);
  assert.deepEqual(out.map((c) => c.id), [4, 5]);
});
