// The 10x benchmark's data: K copies (default 10) of every activity in a built site's
// data folder. Copy k has its id suffixed `_k`, its start moved back k years, its route
// nudged k * 0.003 deg north and k * 0.0021 deg east so the copies don't overdraw
// exactly, and no detail file. Copy 0 is the original. See README.md.
//
//   node scripts/perf/scale-display-files.mjs <srcDataDir> <outDataDir> [K=10]
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(
  new URL("../../app/package.json", import.meta.url),
);
const polyline = require("@mapbox/polyline");
const [src, out, K] = [
  process.argv[2],
  process.argv[3],
  Number(process.argv[4] ?? 10),
];
if (!src || !out) {
  console.error(
    "usage: node scripts/perf/scale-display-files.mjs <srcDataDir> <outDataDir> [K=10]",
  );
  process.exit(2);
}
fs.mkdirSync(out, { recursive: true });
const routes = JSON.parse(fs.readFileSync(`${src}/routes.json`, "utf8"));
const acts = JSON.parse(fs.readFileSync(`${src}/activities.json`, "utf8"));
const profiles = JSON.parse(fs.readFileSync(`${src}/profiles.json`, "utf8"));
const R = { ...routes, routes: {} },
  A = { ...acts, activities: [] },
  P = { ...profiles, profiles: {} };
const YEAR = 365 * 86400;
for (let k = 0; k < K; k++) {
  for (const a of acts.activities) {
    const id = k === 0 ? a.id : `${a.id}_${k}`;
    const ts = a.ts - k * YEAR;
    const shift = (s) =>
      s ? String(Number(s.slice(0, 4)) - k) + s.slice(4) : s;
    A.activities.push({
      ...a,
      id,
      ts,
      start_date: shift(a.start_date),
      start_local: shift(a.start_local),
      detail: k === 0 ? a.detail : false,
    });
    const r = routes.routes[a.id];
    if (r) {
      const d = k * 0.003;
      R.routes[id] =
        k === 0
          ? r
          : polyline.encode(
              polyline.decode(r).map(([la, lo]) => [la + d, lo + d * 0.7]),
            );
    }
    if (profiles.profiles[a.id]) P.profiles[id] = profiles.profiles[a.id];
  }
}
A.activities.sort((x, y) => x.ts - y.ts);
fs.writeFileSync(`${out}/routes.json`, JSON.stringify(R));
fs.writeFileSync(`${out}/activities.json`, JSON.stringify(A));
fs.writeFileSync(`${out}/profiles.json`, JSON.stringify(P));
console.log(
  "activities",
  A.activities.length,
  "routes",
  Object.keys(R.routes).length,
);
