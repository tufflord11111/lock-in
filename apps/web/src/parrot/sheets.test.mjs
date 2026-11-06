// Decodes every image the manifest names, the way an image library would, so a
// PNG the webview can't load fails here and not as an invisible bird. It holds
// for real art too: all five PNG row filters are handled. An .mjs so that the
// app's tsconfig, which has no Node types, leaves it alone.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodePng, decodedBytes } from "../../../../scripts/parrot-png.mjs";
import manifest from "./sprites.manifest.json";

const ROW_FILES_OVER_BYTES = 16 * 1024 * 1024;
const publicDir = fileURLToPath(new URL("../../public/", import.meta.url));
const read = (file) => decodePng(readFileSync(publicDir + file));

/** How many pixels in one cell aren't fully transparent. */
function opaqueIn(image, cell, column, row) {
  let count = 0;
  for (let y = row * cell.height; y < (row + 1) * cell.height; y++) {
    for (let x = column * cell.width; x < (column + 1) * cell.width; x++) {
      if (image.pixels[(y * image.width + x) * 4 + 3] !== 0) count++;
    }
  }
  return count;
}

describe("the manifest's sheets", () => {
  it("ship a sheet over 16 MiB decoded as row files, and smaller ones either way", () => {
    for (const scale of manifest.scales) {
      expect(!!scale.file !== !!scale.rowFiles, `${scale.file ?? scale.rowFiles}: file or rowFiles, not both`).toBe(true);
      if (decodedBytes(scale.sheet.width, scale.sheet.height) > ROW_FILES_OVER_BYTES) {
        expect(scale.rowFiles, `${scale.file} decodes to more than 16 MiB`).toBeTruthy();
      }
    }
  });
});

describe.each(manifest.scales.filter((s) => s.file))("$file", (scale) => {
  const sheet = read(scale.file);

  it("decodes as 8-bit RGBA at the manifest's size", () => {
    expect([sheet.width, sheet.height]).toEqual([scale.sheet.width, scale.sheet.height]);
    expect(sheet.depth).toBe(8);
    expect(sheet.colour).toBe(6);
    expect(sheet.interlace).toBe(0);
  });

  it("has art in every frame of every row, and nothing in the empty cells", () => {
    manifest.rows.forEach((row, r) => {
      for (let column = 0; column < manifest.columns; column++) {
        const opaque = opaqueIn(sheet, scale.cell, column, r);
        if (column < row.frames) expect(opaque, `${row.state} frame ${column}`).toBeGreaterThan(0);
        else expect(opaque, `${row.state} cell ${column}`).toBe(0);
      }
    });
  });
});

describe.each(manifest.scales.filter((s) => s.rowFiles))("$rowFiles", (scale) => {
  it.each(manifest.rows)("$state is one strip of its frames, each with art in it", (row) => {
    const strip = read(scale.rowFiles.replace("{state}", row.state));
    expect([strip.width, strip.height]).toEqual([row.frames * scale.cell.width, scale.cell.height]);
    expect([strip.depth, strip.colour, strip.interlace]).toEqual([8, 6, 0]);
    for (let column = 0; column < row.frames; column++) {
      expect(opaqueIn(strip, scale.cell, column, 0), `${row.state} frame ${column}`).toBeGreaterThan(0);
    }
  });
});

describe("the decoder itself", () => {
  it("refuses the bug that hid the bird: stray bytes after a chunk", () => {
    const first = manifest.scales[0];
    const good = readFileSync(publicDir + (first.file ?? first.rowFiles.replace("{state}", manifest.rows[0].state)));
    const firstChunkEnd = 8 + 12 + good.readUInt32BE(8);
    const bad = Buffer.concat([good.subarray(0, firstChunkEnd), Buffer.alloc(4), good.subarray(firstChunkEnd)]);
    expect(() => decodePng(bad)).toThrow();
  });
});
