// Decodes every sheet the manifest names, the way an image library would, so a
// PNG the webview can't load fails here and not as an invisible bird. It holds
// for real art too: all five PNG row filters are handled. An .mjs so that the
// app's tsconfig, which has no Node types, leaves it alone.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import manifest from "./sprites.manifest.json";

const SIGNATURE = "89504e470d0a1a0a";
const publicDir = fileURLToPath(new URL("../../public/", import.meta.url));

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function decode(png) {
  if (png.subarray(0, 8).toString("hex") !== SIGNATURE) throw new Error("no PNG signature");
  const idat = [];
  let at = 8;
  let header = null;
  let ended = false;
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const typed = png.subarray(at + 4, at + 8 + length);
    if (typed.length !== 4 + length) throw new Error("truncated chunk");
    if (crc32(typed) !== png.readUInt32BE(at + 8 + length)) throw new Error("bad chunk CRC");
    const type = typed.subarray(0, 4).toString("latin1");
    const data = typed.subarray(4);
    if (type === "IHDR") {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        colour: data[9],
        interlace: data[12],
      };
    }
    if (type === "IDAT") idat.push(data);
    if (type === "IEND") ended = true;
    at += 12 + length;
  }
  if (!header || !ended || at !== png.length) throw new Error("bad chunk layout");

  const { width, height } = header;
  const stride = width * 4;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length !== (stride + 1) * height) throw new Error("wrong amount of pixel data");

  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? pixels[y * stride + x - 4] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? pixels[(y - 1) * stride + x - 4] : 0;
      let predicted;
      if (filter === 0) predicted = 0;
      else if (filter === 1) predicted = a;
      else if (filter === 2) predicted = b;
      else if (filter === 3) predicted = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
        predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else throw new Error(`unknown row filter ${filter}`);
      pixels[y * stride + x] = (line[x] + predicted) & 255;
    }
  }
  return { ...header, pixels };
}

/** How many pixels in one cell aren't fully transparent. */
function opaqueIn(sheet, cell, column, row) {
  let count = 0;
  for (let y = row * cell.height; y < (row + 1) * cell.height; y++) {
    for (let x = column * cell.width; x < (column + 1) * cell.width; x++) {
      if (sheet.pixels[(y * sheet.width + x) * 4 + 3] !== 0) count++;
    }
  }
  return count;
}

describe.each(manifest.scales)("$file", (scale) => {
  const sheet = decode(readFileSync(publicDir + scale.file));

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

describe("the decoder itself", () => {
  it("refuses the bug that hid the bird: stray bytes after a chunk", () => {
    const good = readFileSync(publicDir + manifest.scales[0].file);
    const firstChunkEnd = 8 + 12 + good.readUInt32BE(8);
    const bad = Buffer.concat([good.subarray(0, firstChunkEnd), Buffer.alloc(4), good.subarray(firstChunkEnd)]);
    expect(() => decode(bad)).toThrow();
  });
});
