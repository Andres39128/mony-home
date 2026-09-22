// Renders the PWA icon set from public/icon.svg using sharp.
// Run manually after changing the brand SVG: node scripts/generate-icons.mjs
//
// ponytail: sharp is NOT a direct dependency — it rides on Next's transitive
// install. If the import below fails, stop and install it deliberately
// (`npm i -D sharp`); never add it from this script.

const { default: sharp } = await import("sharp").catch(() => ({ default: null }));
if (!sharp) {
  console.error(
    "sharp is not installed (it is a transitive dep of next). To regenerate icons, install it explicitly: npm i -D sharp",
  );
  process.exit(1);
}

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const svg = join(root, "public", "icon.svg");

const HONEY = "#ffe5a3";

async function renderArt(size, out) {
  await sharp(svg).resize(size, size).png().toFile(out);
  console.log("wrote", out);
}

// Maskable icons must fill the whole canvas (maskers crop to a circle/squircle),
// so the art is centered at ~80% scale on a solid honey background.
async function renderMaskable(size, out) {
  const inner = await sharp(svg)
    .resize(Math.round(size * 0.8), Math.round(size * 0.8))
    .png()
    .toBuffer();
  await sharp({
    create: { width: size, height: size, channels: 4, background: HONEY },
  })
    .composite([{ input: inner, gravity: "centre" }])
    .png()
    .toFile(out);
  console.log("wrote", out);
}

await renderArt(192, join(root, "public", "icon-192.png"));
await renderArt(512, join(root, "public", "icon-512.png"));
await renderMaskable(192, join(root, "public", "icon-maskable-192.png"));
await renderMaskable(512, join(root, "public", "icon-maskable-512.png"));
await renderArt(180, join(root, "src", "app", "apple-icon.png"));
