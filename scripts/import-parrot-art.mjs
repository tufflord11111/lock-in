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
 * as a static prop, listed under "props" in the manifest. meta.branch in the
 * 1x JSON (its size and the perch point, where the bird's feet go, in 1x px,
 * the right side flush with the screen's edge) becomes the manifest's
 * "branch"; without it the overlay guesses a perch point on the prop.
 *
 * "ink" is how far the drawing reaches across the cell in any frame of any
 * row, CSS px from the cell's left (alpha over 8 in the 1x sheet), so the
 * overlay can keep the whole bird, beak and tail, on the screen.
 *
 * The walk row plays at WALK_FPS, whatever its frameTag says, so it divides
 * the overlay's 15 fps walk timer. Its stride (how far the sprite moves per
 * frame, CSS px) comes from meta.walkSpeed.pxPerFrame divided by each sheet's
 * scale, which must agree across the three; --walk-stride=<px> overrides it,
 * and without either the current manifest's stride is kept.
 *
 * The walk row's contact frames (both feet down, where a walk may stop) come
 * from meta.walkContact, else --walk-contact=<i,j>, else the app's default of 0
 * and half way. Row frame numbers, not gait phases: a row that starts part way
 * round the cycle has its contacts elsewhere.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodePng, decodedBytes, writeScale } from "./parrot-png.mjs";

const WEB = "apps/web";
const PUBLIC = join(WEB, "public");
const MANIFEST = join(WEB, "src/parrot/sprites.manifest.json");
const ROW_FILES_OVER_BYTES = 16 * 1024 * 1024;
const WALK_FPS = 7.5;
// The rows the blink layer draws over (apps/web/src/parrot/blink.ts BLINK_ROWS): only their eyes ship.
const EYE_ROWS = ["idle", "walk", "talk", "peck", "perch"];
const SCALES = [
  { name: "1x", maxDpr: 1.25 },
  { name: "1.5x", maxDpr: 1.75 },
  { name: "2x", maxDpr: null },
];

const dir = process.argv.slice(2).find((a) => !a.startsWith("--"));
const strideArg = process.argv.find((a) => a.startsWith("--walk-stride="));
const contactArg = process.argv.find((a) => a.startsWith("--walk-contact="));
if (!dir) {
  console.error("usage: node scripts/import-parrot-art.mjs <dir with parrot@1x|1.5x|2x.png + .json>");
  process.exit(2);
}

const current = JSON.parse(readFileSync(MANIFEST, "utf8"));
const fromMarks = new Map(current.rows.map((r) => [r.state, r.from]));
const keptStride = current.rows.find((r) => r.state === "walk")?.stride;
// The art's own stride, CSS px per frame, from every scale; they must agree.
const artStrides = SCALES.map(({ name }) => {
  const meta = JSON.parse(readFileSync(join(dir, `parrot@${name}.json`), "utf8")).meta;
  return meta.walkSpeed ? meta.walkSpeed.pxPerFrame / meta.scale : null;
});
if (artStrides.some((s) => s !== artStrides[0])) throw new Error(`walkSpeed.pxPerFrame disagrees across scales: ${artStrides}`);
const walkStride = strideArg ? Number(strideArg.split("=")[1]) : (artStrides[0] ?? keptStride);
if (!(walkStride > 0)) throw new Error("No walk stride: the art has no meta.walkSpeed; pass --walk-stride=<px per frame>");
const metaContact = JSON.parse(readFileSync(join(dir, "parrot@1x.json"), "utf8")).meta.walkContact;
const walkContact = metaContact ?? (contactArg ? contactArg.split("=")[1].split(",").map(Number) : undefined);
if (walkContact && !walkContact.every((f) => Number.isInteger(f) && f >= 0)) throw new Error(`bad walk contact frames: ${walkContact}`);
console.log(`walk contact frames: ${walkContact ? walkContact.join(", ") + (metaContact ? " (meta.walkContact)" : " (--walk-contact)") : "the app's default"}`);
console.log(`walk: ${walkStride} px per frame at ${WALK_FPS} fps = ${walkStride * WALK_FPS} px/s` +
  (strideArg ? " (--walk-stride)" : artStrides[0] !== null ? " (meta.walkSpeed)" : " (kept)"));

let rows = null;
let ink = null;
let baseline = null;
let lidColour = null;
const scales = [];
for (const { name, maxDpr } of SCALES) {
  const meta = JSON.parse(readFileSync(join(dir, `parrot@${name}.json`), "utf8")).meta;
  const cell = { width: meta.cell.w, height: meta.cell.h };
  const sheet = { width: meta.size.w, height: meta.size.h };
  const these = meta.frameTags.map((t) => ({
    state: t.name,
    frames: t.to - t.from + 1,
    fps: t.name === "walk" ? WALK_FPS : t.fps,
    loop: t.loop,
    ...(fromMarks.get(t.name) ? { from: fromMarks.get(t.name) } : {}),
    ...(t.name === "walk" ? { stride: walkStride, ...(walkContact ? { contact: walkContact } : {}) } : {}),
  }));
  if (name === "1x" && typeof meta.baseline === "number") baseline = meta.baseline;
  if (name === "1x" && typeof meta.lidColour === "string") lidColour = meta.lidColour;
  if (rows === null) rows = these;
  else if (JSON.stringify(these) !== JSON.stringify(rows)) throw new Error(`parrot@${name}.json: rows differ from parrot@1x.json`);

  const scale = { maxDpr, cell, sheet };
  // Eyes in this sheet's own px, for the blink rows; null frames kept so indexes line up.
  let eyes = null;
  if (meta.eyes) {
    eyes = {};
    for (const row of EYE_ROWS) {
      const list = meta.eyes[row];
      const frames = these.find((r) => r.state === row)?.frames;
      if (!list) continue;
      if (list.length !== frames) throw new Error(`parrot@${name}.json: ${row} has ${list.length} eyes for ${frames} frames`);
      eyes[row] = list.map((e) => (e ? { x: e.x, y: e.y, r: e.r, open: e.open === true } : null));
    }
  }
  const big = decodedBytes(sheet.width, sheet.height) > ROW_FILES_OVER_BYTES;
  if (big) scale.rowFiles = `parrot/parrot-${name}/{state}.png`;
  else scale.file = `parrot/parrot-${name}.png`;
  if (eyes) scale.eyes = eyes;
  scales.push(scale);

  const png = readFileSync(join(dir, `parrot@${name}.png`));
  const image = decodePng(png);
  if (image.width !== sheet.width || image.height !== sheet.height) {
    throw new Error(`parrot@${name}.png is ${image.width}x${image.height}, the JSON says ${sheet.width}x${sheet.height}`);
  }
  // Clear both forms of the old scale before writing either.
  rmSync(join(PUBLIC, `parrot/parrot-${name}.png`), { force: true });
  rmSync(join(PUBLIC, `parrot/parrot-${name}`), { recursive: true, force: true });
  if (name === "1x") ink = inkExtent(image, cell, rows);
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
const propScale = (file) => Number(/@([\d.]+)x\.png$/.exec(file)?.[1] ?? 1);
for (const file of readdirSync(dir).filter((f) => /^branch@.*\.png$/.test(f)).sort((a, b) => propScale(a) - propScale(b))) {
  const png = readFileSync(join(dir, file));
  const image = decodePng(png);
  const out = `parrot/props/${file.replace("@", "-")}`;
  mkdirSync(join(PUBLIC, "parrot/props"), { recursive: true });
  copyFileSync(join(dir, file), join(PUBLIC, out));
  props.push({ name: "branch", scale: propScale(file), file: out, width: image.width, height: image.height });
  console.log(`prop ${file}: ${image.width}x${image.height} -> ${out}`);
}
console.log(`ink: x ${ink.left} to ${ink.right} of the ${scales[0].cell.width} px cell`);

// The perch: 1x px are CSS px.
const metaBranch = JSON.parse(readFileSync(join(dir, "parrot@1x.json"), "utf8")).meta.branch;
let branch = null;
if (metaBranch) {
  if (metaBranch.edge !== undefined && metaBranch.edge !== "right") throw new Error(`meta.branch.edge is ${metaBranch.edge}; the overlay draws a right-edge branch`);
  for (const k of ["w", "h", "perchX", "perchY"]) if (typeof metaBranch[k] !== "number") throw new Error(`meta.branch.${k} is missing`);
  branch = { width: metaBranch.w, height: metaBranch.h, perchX: metaBranch.perchX, perchY: metaBranch.perchY };
  console.log(`branch: ${branch.width}x${branch.height}, perch at ${branch.perchX},${branch.perchY} (meta.branch)`);
}
if (props.length === 0 && existsSync(join(PUBLIC, "parrot/props"))) rmSync(join(PUBLIC, "parrot/props"), { recursive: true, force: true });

const manifest = {
  columns: current.columns,
  displayCell: baseline === null ? scales[0].cell : { ...scales[0].cell, baseline },
  ...(lidColour ? { lidColour } : {}),
  ink,
  scales,
  rows,
  ...(props.length ? { props } : {}),
  ...(branch ? { branch } : {}),
};
const line = (o) => JSON.stringify(o);
const text = [
  "{",
  `  "columns": ${manifest.columns},`,
  `  "displayCell": ${line(manifest.displayCell)},`,
  ...(manifest.lidColour ? [`  "lidColour": ${line(manifest.lidColour)},`] : []),
  `  "ink": ${line(manifest.ink)},`,
  '  "scales": [',
  ...manifest.scales.map((s, i) => `    ${line(s)}${i < manifest.scales.length - 1 ? "," : ""}`),
  "  ],",
  '  "rows": [',
  ...manifest.rows.map((r, i) => `    ${line(r)}${i < manifest.rows.length - 1 ? "," : ""}`),
  props.length || branch ? "  ]," : "  ]",
  ...(props.length ? ['  "props": [', ...props.map((p, i) => `    ${line(p)}${i < props.length - 1 ? "," : ""}`), branch ? "  ]," : "  ]"] : []),
  ...(branch ? [`  "branch": ${line(branch)}`] : []),
  "}",
  "",
].join("\n");
writeFileSync(MANIFEST, text);
console.log(`wrote ${MANIFEST}: display cell ${manifest.displayCell.width}x${manifest.displayCell.height}`);

/** The leftmost and rightmost opaque columns over every frame of every row: [left, right) in the cell. */
function inkExtent(image, cell, rowList) {
  let left = cell.width;
  let right = 0;
  rowList.forEach((row, r) => {
    for (let f = 0; f < row.frames; f++) {
      for (let y = 0; y < cell.height; y++) {
        const base = ((r * cell.height + y) * image.width + f * cell.width) * 4;
        for (let x = 0; x < cell.width; x++) {
          if (image.pixels[base + x * 4 + 3] > 8) {
            if (x < left) left = x;
            if (x + 1 > right) right = x + 1;
          }
        }
      }
    }
  });
  if (right === 0) throw new Error("the 1x sheet has no opaque pixels");
  return { left, right };
}
