#!/usr/bin/env node
/**
 * Writes the placeholder parrot sheets the manifest describes: a coloured shape,
 * the row label and the frame number in every used cell, transparent elsewhere.
 * Cells are whatever width and height the manifest gives each scale, and a
 * scale with rowFiles gets one strip per row. Real art goes through
 * import-parrot-art.mjs instead. No dependencies.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeScale } from "./parrot-png.mjs";

const WEB = "apps/web";
const manifest = JSON.parse(readFileSync(join(WEB, "src/parrot/sprites.manifest.json"), "utf8"));

// 5×7 capitals and digits, one string per row.
const GLYPHS = {
  A: "01110 10001 10001 11111 10001 10001 10001", B: "11110 10001 10001 11110 10001 10001 11110",
  C: "01111 10000 10000 10000 10000 10000 01111", D: "11110 10001 10001 10001 10001 10001 11110",
  E: "11111 10000 10000 11110 10000 10000 11111", F: "11111 10000 10000 11110 10000 10000 10000",
  G: "01111 10000 10000 10011 10001 10001 01111", H: "10001 10001 10001 11111 10001 10001 10001",
  I: "11111 00100 00100 00100 00100 00100 11111", K: "10001 10010 10100 11000 10100 10010 10001",
  L: "10000 10000 10000 10000 10000 10000 11111", M: "10001 11011 10101 10101 10001 10001 10001",
  N: "10001 11001 10101 10011 10001 10001 10001", O: "01110 10001 10001 10001 10001 10001 01110",
  P: "11110 10001 10001 11110 10000 10000 10000", R: "11110 10001 10001 11110 10100 10010 10001",
  S: "01111 10000 10000 01110 00001 00001 11110", T: "11111 00100 00100 00100 00100 00100 00100",
  U: "10001 10001 10001 10001 10001 10001 01110", W: "10001 10001 10001 10101 10101 11011 10001",
  Y: "10001 10001 01010 00100 00100 00100 00100", _: "00000 00000 00000 00000 00000 00000 11111",
  0: "01110 10001 10011 10101 11001 10001 01110", 1: "00100 01100 00100 00100 00100 00100 01110",
  2: "01110 10001 00001 00110 01000 10000 11111", 3: "11110 00001 00001 01110 00001 00001 11110",
  4: "00010 00110 01010 10010 11111 00010 00010", 5: "11111 10000 11110 00001 00001 10001 01110",
  6: "00110 01000 10000 11110 10001 10001 01110", 7: "11111 00001 00010 00100 01000 01000 01000",
  8: "01110 10001 10001 01110 10001 10001 01110", 9: "01110 10001 10001 01111 00001 00010 01100",
};

const hsl = (h, s, l) => {
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)))));
  };
  return [f(0), f(8), f(4)];
};

for (const scale of manifest.scales) {
  const { width, height } = scale.sheet;
  const cell = scale.cell;
  const rgba = Buffer.alloc(width * height * 4);
  const put = (x, y, [r, g, b]) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    rgba[i] = r;
    rgba[i + 1] = g;
    rgba[i + 2] = b;
    rgba[i + 3] = 255;
  };
  // Line widths and text scale with the cell's width; the body fills the cell
  // by proportion, so a wide or tall cell gets a wide or tall placeholder.
  const u = cell.width / manifest.displayCell.width;
  const px = (fraction, of) => Math.round(fraction * of);
  const text = (s, x, y, size, colour) => {
    [...s.toUpperCase()].forEach((ch, n) => {
      const glyph = GLYPHS[ch];
      if (!glyph) return;
      glyph.split(" ").forEach((bits, gy) =>
        [...bits].forEach((bit, gx) => {
          if (bit !== "1") return;
          for (let dy = 0; dy < size; dy++)
            for (let dx = 0; dx < size; dx++) put(x + n * 6 * size + gx * size + dx, y + gy * size + dy, colour);
        }),
      );
    });
  };

  manifest.rows.forEach((row, r) => {
    const colour = hsl((r * 360) / manifest.rows.length, 0.62, 0.42);
    for (let f = 0; f < row.frames; f++) {
      const ox = f * cell.width;
      const oy = r * cell.height;
      // Rounded body, feet 4 px (at 1×) above the cell's bottom edge, so the
      // pivot matches the art spec. A small per-frame bob makes playback visible.
      const bob = Math.round(Math.sin((f / row.frames) * Math.PI * 2) * 2 * u);
      const left = px(14 / 96, cell.width);
      const right = px(82 / 96, cell.width);
      const top = px(20 / 96, cell.height) + bob;
      const bottom = cell.height - Math.round(4 * u);
      const radius = Math.min(px(14 / 96, cell.width), px(14 / 96, cell.height));
      const border = Math.max(1, Math.round(u));
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          const cx = Math.min(x - left, right - 1 - x);
          const cy = Math.min(y - top, bottom - 1 - y);
          if (cx < radius && cy < radius && (radius - cx) ** 2 + (radius - cy) ** 2 > radius ** 2) continue;
          const edge = cx < border || cy < border;
          put(ox + x, oy + y, edge ? [255, 255, 255] : colour);
        }
      }
      text(row.state.slice(0, 9), ox + left + Math.round(4 * u), oy + top + Math.round(10 * u), Math.max(1, Math.round(u)), [255, 255, 255]);
      text(String(f), ox + px(40 / 96, cell.width), oy + top + Math.round(28 * u), Math.round(3 * u), [255, 255, 255]);
    }
  });

  for (const out of writeScale(join(WEB, "public"), scale, manifest.rows, manifest.columns, rgba)) {
    console.log(`${out.path}  ${out.width}x${out.height}  ${(out.bytes / 1024).toFixed(0)} KB`);
  }
}
