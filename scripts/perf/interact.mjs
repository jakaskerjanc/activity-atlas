// Cost of each interaction on a built site: main-thread time, long tasks, frames and
// DOM nodes, one line per step. See README.md.
//
//   BASE=http://localhost:4173/ THROTTLE=1 ONLY=activities node scripts/perf/interact.mjs
//
// ONLY takes a comma-separated list of sections (map, replay, analytics, activities,
// selected); the map has to load either way.
import { createRequire } from "node:module";
const PLAYWRIGHT_DIR =
  process.env.PLAYWRIGHT_DIR ??
  `${process.env.HOME}/.local/share/mise/installs/playwright/latest/node_modules/`;
const require = createRequire(
  PLAYWRIGHT_DIR.endsWith("/") ? PLAYWRIGHT_DIR : `${PLAYWRIGHT_DIR}/`,
);
const { chromium } = require("playwright");

const BASE = process.env.BASE ?? "http://localhost:4173/";
const THROTTLE = Number(process.env.THROTTLE ?? 4);
const THEME = process.env.THEME ?? "dark";
const ONLY = process.env.ONLY
  ? new Set(process.env.ONLY.split(",").map((x) => x.trim()))
  : null;
const run = (section) => !ONLY || ONLY.has(section);

const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  args: ["--headless=new", "--no-sandbox", "--enable-gpu", "--use-angle=gl"],
});
const context = await browser.newContext({
  colorScheme: THEME,
  viewport: { width: 1440, height: 900 },
});
const page = await context.newPage();
await page.addInitScript(() => {
  window.__long = [];
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) window.__long.push(Math.round(e.duration));
  }).observe({ type: "longtask", buffered: true });
  window.__ft = [];
  let last = performance.now();
  const tick = (now) => {
    window.__ft.push(now - last);
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
const cdp = await context.newCDPSession(page);
await cdp.send("Performance.enable");
page.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 200)));

async function metrics() {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}

async function measure(label, fn, settle = 1500) {
  await page.evaluate(() => {
    window.__long = [];
    window.__ft = [];
  });
  const a = await metrics();
  const t0 = Date.now();
  await fn();
  await page.waitForTimeout(settle);
  const wall = Date.now() - t0;
  const b = await metrics();
  const { long, ft } = await page.evaluate(() => ({
    long: window.__long,
    ft: window.__ft,
  }));
  const ms = (k) => ((b[k] - a[k]) * 1000).toFixed(0).padStart(6);
  const slow = ft.filter((d) => d > 34).length;
  const p95 = [...ft].sort((x, y) => x - y)[Math.floor(ft.length * 0.95)] ?? 0;
  const worstFrame = Math.max(0, ...ft);
  console.log(
    `${label.padEnd(44)} wall=${String(wall).padStart(5)} script=${ms("ScriptDuration")} layout+style=${((b.LayoutDuration - a.LayoutDuration + b.RecalcStyleDuration - a.RecalcStyleDuration) * 1000).toFixed(0).padStart(5)} task=${ms("TaskDuration")} frames=${String(ft.length).padStart(4)} slow>34ms=${String(slow).padStart(3)} p95=${p95.toFixed(0).padStart(4)} worst=${worstFrame.toFixed(0).padStart(5)} long=[${long
      .sort((x, y) => y - x)
      .slice(0, 4)
      .join(",")}] nodes=${b.Nodes}`,
  );
}

await page.goto(BASE, { waitUntil: "load" });
await page.waitForSelector("canvas.mapboxgl-canvas", { timeout: 60000 });
await page.waitForFunction(
  () => !document.querySelector('[role="status"]'),
  null,
  { timeout: 120000 },
);
await page.waitForTimeout(4000);
await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
console.log(`--- throttle ${THROTTLE}x theme ${THEME}`);

const typeButtons = page.locator('[aria-label="Activity types"] button');
const fromSlider = page.locator('input[aria-label="Earliest month"]');

if (run("map")) {
  await measure("idle map 3s", async () => {}, 3000);

  // Hover across the map.
  await measure("hover sweep across map (80 moves)", async () => {
    for (let i = 0; i < 80; i++) {
      await page.mouse.move(420 + i * 9, 300 + Math.sin(i / 6) * 180);
    }
  });

  // Type toggles.
  await measure("toggle 1st type row off", async () =>
    typeButtons.nth(0).click(),
  );
  await measure("toggle 1st type row on", async () =>
    typeButtons.nth(0).click(),
  );

  // Date slider.
  await fromSlider.focus();
  await measure("date slider: 12 steps right", async () => {
    for (let i = 0; i < 12; i++)
      await page.keyboard.press("ArrowRight", { delay: 30 });
  });
  await measure("date slider: 12 steps back", async () => {
    for (let i = 0; i < 12; i++)
      await page.keyboard.press("ArrowLeft", { delay: 30 });
  });

  // Color modes.
  for (const mode of ["Type", "Recency", "Speed", "Heat", "Grade", "Plain"]) {
    await measure(
      `color mode -> ${mode}`,
      async () =>
        page
          .locator('[aria-label="Route color"] button', { hasText: mode })
          .click(),
      2500,
    );
  }
}

if (run("replay")) {
  await page
    .locator('button.replay-btn, button:has-text("Replay history")')
    .first()
    .click();
  await page.waitForTimeout(1800); // the fly-to, then playback starts
  await measure("replay playing, 5 s", async () => {}, 5000);
  await page.locator('button:has-text("Exit replay")').first().click();
  await page.waitForTimeout(1000);
}

if (run("analytics")) {
  await measure(
    "switch to Analytics",
    async () =>
      page
        .locator('nav[aria-label="Pages"] button[aria-label="Analytics"]')
        .click(),
    3000,
  );
  await measure("analytics: toggle type row off", async () =>
    typeButtons.nth(0).click(),
  );
  await measure("analytics: toggle type row on", async () =>
    typeButtons.nth(0).click(),
  );
  await fromSlider.focus();
  await measure("analytics: date slider 12 steps right", async () => {
    for (let i = 0; i < 12; i++)
      await page.keyboard.press("ArrowRight", { delay: 30 });
  });
  await measure("analytics: date slider 12 steps back", async () => {
    for (let i = 0; i < 12; i++)
      await page.keyboard.press("ArrowLeft", { delay: 30 });
  });
  await measure(
    "analytics: theme toggle",
    async () => page.locator('button[aria-label^="Switch to"]').click(),
    2500,
  );
  await page.locator('button[aria-label^="Switch to"]').click();
  await page.waitForTimeout(1500);
}

if (run("activities") || run("selected")) {
  await measure(
    "switch to Activities",
    async () =>
      page
        .locator('nav[aria-label="Pages"] button[aria-label="Activities"]')
        .click(),
    3000,
  );
  const search = page.locator('input[aria-label="Search activities"]');
  await search.focus();
  await measure("activities: type 's'", async () => page.keyboard.type("s"));
  await measure("activities: type 'm' (-> sm)", async () =>
    page.keyboard.type("m"),
  );
  await measure("activities: clear search", async () => search.fill(""));
  await measure("activities: sort by distance", async () =>
    page.locator(".activities__head button").nth(2).click(),
  );
  await measure(
    "activities: open a row preview",
    async () => page.locator("button[data-row]").nth(3).click(),
    2500,
  );
  await measure("activities: toggle type row off", async () =>
    typeButtons.nth(0).click(),
  );
  await measure("activities: toggle type row on", async () =>
    typeButtons.nth(0).click(),
  );
  await measure(
    "activities: theme toggle",
    async () => page.locator('button[aria-label^="Switch to"]').click(),
    2500,
  );
  await page.locator('button[aria-label^="Switch to"]').click();
  await page.waitForTimeout(1500);
  await page.mouse.move(900, 600);
  await measure("activities: scroll down (40 wheel steps)", async () => {
    for (let i = 0; i < 40; i++) {
      await page.mouse.wheel(0, 400);
      await page.waitForTimeout(16);
    }
  });
  await search.focus();
  await measure("activities: ArrowDown through 30 rows", async () => {
    for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowDown");
  });
  const focused = await page.evaluate(() => document.activeElement?.getAttribute("data-row") ?? null);
  console.log(`activities: focus after 30 ArrowDown presses: ${focused === null ? "LOST" : "on a row"}`);
}

// Selected activity on the map: chart cursor. Opened from the preview the Activities
// section left open.
if (run("selected")) {
  const show = page.locator('button:has-text("Show on map")');
  if (await show.count()) {
    await measure(
      "open activity on map (fly-to + charts)",
      async () => show.first().click(),
      4000,
    );
    const chart = page
      .locator("svg")
      .filter({ has: page.locator("path") })
      .last();
    const box = await page
      .locator('[aria-label*="levation"], svg[role="img"]')
      .first()
      .boundingBox()
      .catch(() => null);
    if (box) {
      await measure("chart cursor sweep (80 moves)", async () => {
        for (let i = 0; i < 80; i++)
          await page.mouse.move(
            box.x + 10 + (i * (box.width - 20)) / 80,
            box.y + box.height / 2,
          );
      });
    } else console.log("no chart box found");
  }
}
await browser.close();
