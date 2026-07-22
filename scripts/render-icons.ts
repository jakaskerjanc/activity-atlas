// Rasterize app/public/favicon.svg into the PNG sizes browsers and mobile
// installs use. Run: npm run build:icons
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const publicDir = fileURLToPath(new URL("../app/public/", import.meta.url));
const svg = await readFile(publicDir + "favicon.svg");

const targets: Record<string, number> = {
  "icon-32.png": 32,
  "apple-touch-icon.png": 180,
  "icon-192.png": 192,
  "icon-512.png": 512,
};

for (const [name, size] of Object.entries(targets)) {
  const png = await sharp(svg, { density: 384 }).resize(size, size).png().toBuffer();
  await writeFile(publicDir + name, png);
  console.log(`wrote ${name} (${size}px)`);
}
