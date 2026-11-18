# 10× benchmark

These scripts measure the built site with ten times today's activities. They are for
checking performance work by hand; CI doesn't run them.

1. Build the site and copy it to a scratch folder:

   ```sh
   pnpm --filter app run build
   cp -r app/dist /tmp/atlas-x10
   ```

2. Replace its display files with ten copies of every activity:

   ```sh
   node scripts/perf/scale-display-files.mjs app/dist/data /tmp/atlas-x10/data 10
   ```

3. Serve it, then run the interactions:

   ```sh
   npx serve@14 /tmp/atlas-x10 -l 4173
   BASE=http://localhost:4173/ THROTTLE=1 node scripts/perf/interact.mjs
   ```

`interact.mjs` prints one line per step. Each line gives the step's main-thread time
(`script`, `layout+style`), how many frames it had, how many of them took over 34 ms,
the p95 and worst frame, the longest tasks, and the page's DOM node count.

- `ONLY=map,replay,analytics,activities,selected` runs only those sections. The map
  page always loads first.
- `THROTTLE` is the CPU slowdown. `THEME` is `dark` or `light`.
- Playwright is loaded from `PLAYWRIGHT_DIR`, which defaults to mise's install.

Chromium has to run with the GPU. The script starts `/usr/bin/chromium` with
`--headless=new --no-sandbox --enable-gpu --use-angle=gl`. Without those flags Mapbox
renders in software, and the map numbers are meaningless.
