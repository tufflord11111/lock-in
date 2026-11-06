#!/usr/bin/env node
/**
 * Brings a delivered set of parrot sheets into the app:
 *
 *   node scripts/import-parrot-art.mjs <dir>
 *
 * <dir> holds parrot@1x.png, parrot@1.5x.png and parrot@2x.png with their
 * Aseprite-style JSON (meta.cell, meta.size, frameTags). The manifest's cell,
 * sheet sizes, rows, fps and loops come from the JSON; the "from" version
 * marks are kept from the current manifest. A sheet that would decode to more
 * than 16 MiB is written as one strip per row, cropped to its frames, so the
 * overlay decodes only the rows it shows. Any branch@*.png in <dir> is copied
 * as a static prop, listed under "props" in the manifest; nothing draws it yet.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodePng, decodedBytes, writeScale } from "./parrot-png.mjs";

const WEB = "apps/web";
const PUBLIC = join(WEB, "public");
const MANIFEST = join(WEB, "src/parrot/sprites.manifest.json");
const ROW_FILES_OVER_BYTES = 16 * 1024 * 1024;
const SCALES = [
  { name: "1x", maxDpr: 1.25 },
  { name: "1.5x", maxDpr: 1.75 },
  { name: "2x", maxDpr: null },
];

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/import-parrot-art.mjs <dir with parrot@1x|1.5x|2x.png + .json>");
  process.exit(2);
}

const current = JSON.parse(readFileSync(MANIFEST, "utf8"));
const fromMarks = new Map(current.rows.map((r) => [r.state, r.from]));

let rows = null;
const scales = [];
for (const { name, maxDpr } of SCALES) {
  const meta = JSON.parse(readFileSync(join(dir, `parrot@${name}.json`), "utf8")).meta;
  const cell = { width: meta.cell.w, height: meta.cell.h };
  const sheet = { width: meta.size.w, height: meta.size.h };
  const these = meta.frameTags.map((t) => ({
    state: t.name,
    frames: t.to - t.from + 1,
    fps: t.fps,
    loop: t.loop,
    ...(fromMarks.get(t.name) ? { from: fromMarks.get(t.name) } : {}),
  }));
  if (rows === null) rows = these;
  else if (JSON.stringify(these) !== JSON.stringify(rows)) throw new Error(`parrot@${name}.json: rows differ from parrot@1x.json`);

  const scale = { maxDpr, cell, sheet };
  const big = decodedBytes(sheet.width, sheet.height) > ROW_FILES_OVER_BYTES;
  if (big) scale.rowFiles = `parrot/parrot-${name}/{state}.png`;
  else scale.file = `parrot/parrot-${name}.png`;
  scales.push(scale);

  const png = readFileSync(join(dir, `parrot@${name}.png`));
  const image = decodePng(png);
  if (image.width !== sheet.width || image.height !== sheet.height) {
    throw new Error(`parrot@${name}.png is ${image.width}x${image.height}, the JSON says ${sheet.width}x${sheet.height}`);
  }
  // Clear both forms of the old scale before writing either.
  rmSync(join(PUBLIC, `parrot/parrot-${name}.png`), { force: true });
  rmSync(join(PUBLIC, `parrot/parrot-${name}`), { recursive: true, force: true });
  const written = writeScale(PUBLIC, scale, rows, current.columns, image.pixels);
  const bytes = written.reduce((n, w) => n + w.bytes, 0);
  const decoded = written.reduce((n, w) => n + decodedBytes(w.width, w.height), 0);
  console.log(
    `${name}: cell ${cell.width}x${cell.height}, sheet ${sheet.width}x${sheet.height}, ` +
      `${(decodedBytes(sheet.width, sheet.height) / 2 ** 20).toFixed(1)} MiB decoded whole -> ` +
      (big ? `${written.length} row files, ${(decoded / 2 ** 20).toFixed(1)} MiB if every row is decoded` : "one file") +
      `, ${(bytes / 1024).toFixed(0)} KB on disk`,
  );
}

if (rows.length !== current.rows.length || rows.some((r, i) => r.state !== current.rows[i].state)) {
  throw new Error("the delivered rows are not the manifest's rows in order");
}
if (rows.some((r) => r.frames > current.columns)) throw new Error(`a row has more than ${current.columns} frames`);

// Static props: anything branch@*.png, copied as-is with its scale in the name.
const props = [];
for (const file of readdirSync(dir).filter((f) => /^branch@.*\.png$/.test(f)).sort()) {
  const png = readFileSync(join(dir, file));
  const image = decodePng(png);
  const out = `parrot/props/${file.replace("@", "-")}`;
  mkdirSync(join(PUBLIC, "parrot/props"), { recursive: true });
  copyFileSync(join(dir, file), join(PUBLIC, out));
  const match = /@([\d.]+)x\.png$/.exec(file);
  props.push({ name: "branch", scale: match ? Number(match[1]) : 1, file: out, width: image.width, height: image.height });
  console.log(`prop ${file}: ${image.width}x${image.height} -> ${out}`);
}
if (props.length === 0 && existsSync(join(PUBLIC, "parrot/props"))) rmSync(join(PUBLIC, "parrot/props"), { recursive: true, force: true });

const manifest = {
  columns: current.columns,
  displayCell: scales[0].cell,
  scales,
  rows,
  ...(props.length ? { props } : {}),
};
const line = (o) => JSON.stringify(o);
const text = [
  "{",
  `  "columns": ${manifest.columns},`,
  `  "displayCell": ${line(manifest.displayCell)},`,
  '  "scales": [',
  ...manifest.scales.map((s, i) => `    ${line(s)}${i < manifest.scales.length - 1 ? "," : ""}`),
  "  ],",
  '  "rows": [',
  ...manifest.rows.map((r, i) => `    ${line(r)}${i < manifest.rows.length - 1 ? "," : ""}`),
  props.length ? "  ]," : "  ]",
  ...(props.length ? ['  "props": [', ...props.map((p, i) => `    ${line(p)}${i < props.length - 1 ? "," : ""}`), "  ]"] : []),
  "}",
  "",
].join("\n");
writeFileSync(MANIFEST, text);
console.log(`wrote ${MANIFEST}: display cell ${manifest.displayCell.width}x${manifest.displayCell.height}`);
