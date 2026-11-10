// Draws Resona's icons (a dot with two resonance rings) into desktop/assets. Run: node scripts/icons.mjs
// Output: trayTemplate.png + @2x (black on transparent; macOS tints template images), icon.png (1024) and icon.icns.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const out = path.join(import.meta.dirname, "../assets");

function encodePng(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** Renders size×size; shade(u, v) gets coordinates in -1..1 and returns [r, g, b, a] (0..1, straight alpha). */
function render(size, shade, ss = 3) {
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let i = 0; i < ss; i++) {
        for (let j = 0; j < ss; j++) {
          const [cr, cg, cb, ca] = shade(((x + (i + 0.5) / ss) / size) * 2 - 1, ((y + (j + 0.5) / ss) / size) * 2 - 1);
          r += cr * ca; g += cg * ca; b += cb * ca; a += ca;
        }
      }
      const o = (y * size + x) * 4;
      if (a > 0) {
        px[o] = Math.round((r / a) * 255);
        px[o + 1] = Math.round((g / a) * 255);
        px[o + 2] = Math.round((b / a) * 255);
      }
      px[o + 3] = Math.round((a / (ss * ss)) * 255);
    }
  }
  return encodePng(size, px);
}

// Resonance: a centre dot and rings that fade as they spread. Units are the drawing radius.
const RINGS = [
  { r: 0.44, w: 0.065, a: 1 },
  { r: 0.7, w: 0.055, a: 0.62 },
  { r: 0.94, w: 0.05, a: 0.3 },
];
const DOT = 0.2;

// Menu bar: solid shapes only (template images use alpha), so all rings at full strength.
const tray = (u, v) => {
  const d = Math.hypot(u, v);
  return [0, 0, 0, d <= DOT * 1.15 || RINGS.slice(0, 2).some((g) => Math.abs(d - g.r * 1.05) <= g.w * 1.4) ? 1 : 0];
};

const mix = (a, b, t) => a.map((x, i) => x + (b[i] - x) * t);
function app(u, v) {
  // macOS icon grid: the tile fills ~80% of the canvas, as a superellipse ("squircle").
  const s = 0.805, n = 5;
  if (Math.abs(u / s) ** n + Math.abs(v / s) ** n > 1) return [0, 0, 0, 0];
  const t = Math.min(1, Math.max(0, ((u + v) / (2 * s)) * 0.5 + 0.5));
  let c = mix([0.24, 0.1, 0.5], [0.04, 0.3, 0.38], t); // violet to teal, like the app's aurora
  const k = 0.62; // drawing radius inside the tile
  const d = Math.hypot(u, v) / k;
  c = mix(c, [0.62, 0.5, 1], Math.max(0, 1 - d / 0.75) ** 2 * 0.55); // glow around the dot
  for (const g of RINGS) if (Math.abs(d - g.r) <= g.w) c = mix(c, [0.86, 0.95, 1], g.a);
  if (d <= DOT) c = [1, 1, 1];
  return [...c, 1];
}

fs.writeFileSync(path.join(out, "trayTemplate.png"), render(16, tray, 4));
fs.writeFileSync(path.join(out, "trayTemplate@2x.png"), render(32, tray, 4));
fs.writeFileSync(path.join(out, "icon.png"), render(1024, app));

const iconset = fs.mkdtempSync(path.join(os.tmpdir(), "resona-icon-")) + "/icon.iconset";
fs.mkdirSync(iconset);
for (const base of [16, 32, 128, 256, 512]) {
  fs.writeFileSync(path.join(iconset, `icon_${base}x${base}.png`), render(base, app, 4));
  fs.writeFileSync(path.join(iconset, `icon_${base}x${base}@2x.png`), render(base * 2, app, base * 2 >= 512 ? 2 : 4));
}
execFileSync("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", path.join(out, "icon.icns")]);
fs.rmSync(path.dirname(iconset), { recursive: true });
console.log("wrote", fs.readdirSync(out).join(", "));
