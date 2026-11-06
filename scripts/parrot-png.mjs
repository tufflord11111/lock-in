/**
 * PNG in and out for the parrot sheets, with no dependencies: 8-bit RGBA,
 * every row filter on the way in, and a verified round trip on the way out.
 * Shared by the placeholder generator, the art importer and the sheet test.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = "89504e470d0a1a0a";

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(8 + body.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 4 + body.length);
  return out;
};

/** 8-bit RGBA, filter 0 on every row. */
export function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from(SIGNATURE, "hex"),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Decodes the way an image library would: every chunk's length and CRC, the
 * layout, and all five row filters. Throws on anything a webview would refuse.
 */
export function decodePng(png) {
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
      header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], colour: data[9], interlace: data[12] };
    }
    if (type === "IDAT") idat.push(data);
    if (type === "IEND") ended = true;
    at += 12 + length;
  }
  if (!header || !ended || at !== png.length) throw new Error("bad chunk layout");
  if (header.depth !== 8 || header.colour !== 6 || header.interlace !== 0) {
    throw new Error(`not 8-bit RGBA: depth ${header.depth}, colour ${header.colour}, interlace ${header.interlace}`);
  }

  const { width, height } = header;
  const stride = width * 4;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length !== (stride + 1) * height) throw new Error("wrong amount of pixel data");

  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const above = y > 0 ? (y - 1) * stride : -1;
    const here = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? pixels[here + x - 4] : 0;
      const b = above >= 0 ? pixels[above + x] : 0;
      const c = x >= 4 && above >= 0 ? pixels[above + x - 4] : 0;
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
      pixels[here + x] = (line[x] + predicted) & 255;
    }
  }
  return { ...header, pixels };
}

/** A rectangle of an RGBA buffer as its own RGBA buffer. */
export function crop(pixels, width, x0, y0, w, h) {
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) pixels.copy(out, y * w * 4, ((y0 + y) * width + x0) * 4, ((y0 + y) * width + x0 + w) * 4);
  return out;
}

/** Bytes a webview holds once it has decoded an image this size. */
export const decodedBytes = (width, height) => width * height * 4;

const writeVerified = (path, width, height, rgba) => {
  const png = encodePng(width, height, rgba);
  const back = decodePng(png);
  if (back.width !== width || back.height !== height || !back.pixels.equals(rgba)) throw new Error(`round trip failed for ${path}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, png);
  return png.length;
};

/**
 * Writes one scale's images from a full-sheet RGBA buffer: the whole sheet to
 * `scale.file`, or, when the scale has `rowFiles`, one strip per row cropped to
 * that row's frames, so the page decodes only the rows it shows. Returns what
 * was written, for the log.
 */
export function writeScale(publicDir, scale, rows, columns, rgba) {
  const { width, height } = scale.sheet;
  const { cell } = scale;
  if (width !== columns * cell.width || height !== rows.length * cell.height) {
    throw new Error(`${scale.file ?? scale.rowFiles}: sheet ${width}x${height} isn't ${columns} x ${rows.length} cells of ${cell.width}x${cell.height}`);
  }
  if (scale.rowFiles) {
    rmSync(join(publicDir, dirname(scale.rowFiles)), { recursive: true, force: true });
    const written = rows.map((row, r) => {
      const w = row.frames * cell.width;
      const strip = crop(rgba, width, 0, r * cell.height, w, cell.height);
      const path = join(publicDir, scale.rowFiles.replace("{state}", row.state));
      return { path, width: w, height: cell.height, bytes: writeVerified(path, w, cell.height, strip) };
    });
    if (scale.file) rmSync(join(publicDir, scale.file), { force: true });
    return written;
  }
  const path = join(publicDir, scale.file);
  return [{ path, width, height, bytes: writeVerified(path, width, height, rgba) }];
}
