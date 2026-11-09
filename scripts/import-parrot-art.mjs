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
 * overlay decodes only the rows it shows.
 *
 * The branch: branch@<s>x.png for each scale, and its contact shadow
 * (meta.branch.shadow: image, and where it goes on the branch), are copied to
 * parrot/props/. Each scale's meta.branch (size, perch point, where the
 * bird's feet are in its cell, sinkPx, outlinePx, rowDy, the shadow and
 * drawOrder, all in that scale's px, the right side flush with the screen's
 * edge) goes with it into the manifest's "branches", one entry per scale.
 * Without meta.branch the overlay guesses a perch point on the drawing.
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
 *
 * meta.loops gives a row the frames it loops on while it is held (the pet row
 * loops 2 to 3 while the bird is being rubbed); it becomes that row's
 * "loopFrames". meta.head (the pet row's head centre and radius, per frame)
 * goes into each scale in its own px, like the eyes. meta.contact (every
 * row's footprint per frame: the centre cx and width w of the toes and belly
 * bottom on the feet line, null where it is in the air) is taken from the 1x
 * JSON only, so in CSS px, as the manifest's "contact": the shadow drawn from
 * it is soft, and the larger sheets' measurements disagree in places (81dfb9e:
 * 1.5x idle frame 0 is 43 px wide where 1x and 2x are 24).
 *
 * Layers: every sheet meta.layers names (parrot-art da9d6b2: the underband,
 * the white border and outer line below the belly line, drawn under the bird
 * on the ground; and frontGrip, the branch's front face under each toe, drawn
 * over the bird on the branch exactly like its cell) has the sheet's layout.
 * Each row of each is written cropped to the rows of pixels it has (most of a
 * cell is empty), with that crop's top and height, and the layer's "use" and
 * "draw", in the scale's "layers"; a row with nothing in it gets no file. meta.feetBottom (the
 * bird's lowest px per row and frame, at that scale) goes into each scale.
 *
 * Perched, the bird faces into the screen, mirrored, and meta.branch is
 * measured for it so (parrot-art 95c5814): every x in it, birdFeetX too, is in
 * the mirrored cell. B's rule, in that scale's px: cell left = branch left +
 * perchX - birdFeetX; cell top = branch top + round(perchY - meta.baseline) +
 * rowDy[row] (0 for a row it doesn't list). Each branch entry carries "cell"
 * ({x, y}: the first two terms, worked out here once) and "rowDy" as given.
 *
 * The delivered rows must start with the manifest's rows, in order: new rows
 * are added after them, never in between, so a row's place on the sheet keeps
 * its meaning.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crop, decodePng, decodedBytes, encodePng, writeScale } from "./parrot-png.mjs";

const WEB = "apps/web";
const PUBLIC = join(WEB, "public");
const MANIFEST = join(WEB, "src/parrot/sprites.manifest.json");
const ROW_FILES_OVER_BYTES = 16 * 1024 * 1024;
const WALK_FPS = 7.5;
// The rows the blink layer draws over (apps/web/src/parrot/blink.ts BLINK_ROWS): only their eyes ship.
const EYE_ROWS = ["idle", "walk", "talk", "peck", "perch"];
// The rows whose head the overlay uses: petting leans toward the cursor from the head.
const HEAD_ROWS = ["pet"];
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
let contact = null;
const scales = [];
const sheets = new Map();
for (const { name, maxDpr } of SCALES) {
  const meta = JSON.parse(readFileSync(join(dir, `parrot@${name}.json`), "utf8")).meta;
  const cell = { width: meta.cell.w, height: meta.cell.h };
  const sheet = { width: meta.size.w, height: meta.size.h };
  const these = meta.frameTags.map((t) => {
    const frames = t.to - t.from + 1;
    const held = meta.loops?.[t.name];
    if (held && !(Number.isInteger(held.from) && Number.isInteger(held.to) && held.from >= 0 && held.from <= held.to && held.to < frames)) {
      throw new Error(`parrot@${name}.json: meta.loops.${t.name} is ${JSON.stringify(held)} for ${frames} frames`);
    }
    return {
      state: t.name,
      frames,
      fps: t.name === "walk" ? WALK_FPS : t.fps,
      loop: t.loop,
      ...(fromMarks.get(t.name) ? { from: fromMarks.get(t.name) } : {}),
      ...(t.name === "walk" ? { stride: walkStride, ...(walkContact ? { contact: walkContact } : {}) } : {}),
      ...(held ? { loopFrames: { from: held.from, to: held.to } } : {}),
    };
  });
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
  // The head, for the rows that lean from it; null frames kept so indexes line up.
  let head = null;
  if (meta.head) {
    head = {};
    for (const row of HEAD_ROWS) {
      const list = meta.head[row];
      if (!list) continue;
      const frames = these.find((r) => r.state === row)?.frames;
      if (list.length !== frames) throw new Error(`parrot@${name}.json: meta.head.${row} has ${list.length} entries for ${frames} frames`);
      head[row] = list.map((h) => (h ? { x: h.x, y: h.y, r: h.r } : null));
    }
  }
  // The footprint, every row, for the contact shadow; null where the bird is in the air. 1x only.
  if (name === "1x" && meta.contact) {
    contact = {};
    for (const row of these) {
      const list = meta.contact[row.state];
      if (!list) continue;
      if (list.length !== row.frames) throw new Error(`parrot@${name}.json: meta.contact.${row.state} has ${list.length} entries for ${row.frames} frames`);
      contact[row.state] = list.map((c) => (c ? { cx: c.cx, w: c.w } : null));
    }
  }
  const big = decodedBytes(sheet.width, sheet.height) > ROW_FILES_OVER_BYTES;
  if (big) scale.rowFiles = `parrot/parrot-${name}/{state}.png`;
  else scale.file = `parrot/parrot-${name}.png`;
  if (eyes) scale.eyes = eyes;
  if (head) scale.head = head;
  // The lowest px per frame, for checking where the feet land; null where it is in the air.
  if (meta.feetBottom) {
    scale.feetBottom = {};
    for (const row of these) {
      const list = meta.feetBottom[row.state];
      if (!list) continue;
      if (list.length !== row.frames) throw new Error(`parrot@${name}.json: meta.feetBottom.${row.state} has ${list.length} entries for ${row.frames} frames`);
      scale.feetBottom[row.state] = list;
    }
  }
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
  sheets.set(name, { image, meta, cell });
  // The layers meta.layers names, each row cropped to the pixel rows it has. Any old layer's
  // folder for this scale goes first, so a layer the art no longer has leaves nothing behind.
  for (const old of readdirSync(join(PUBLIC, "parrot"))) {
    if (old.endsWith(`-${name}`) && old !== `parrot-${name}`) rmSync(join(PUBLIC, "parrot", old), { recursive: true, force: true });
  }
  const layerNames = Object.keys(meta.layers ?? {}).filter((k) => typeof meta.layers[k] === "object" && meta.layers[k]?.image);
  for (const layer of layerNames) {
    const out = `parrot/${layer}-${name}`;
    const spec = meta.layers[layer];
    const img = decodePng(readFileSync(join(dir, spec.image ?? `parrot-${layer}@${name}.png`)));
    if (img.width !== sheet.width || img.height !== sheet.height) throw new Error(`${layer}@${name} is ${img.width}x${img.height}, the sheet is ${sheet.width}x${sheet.height}`);
    mkdirSync(join(PUBLIC, out), { recursive: true });
    const layerRows = {};
    let layerBytes = 0;
    rows.forEach((row, r) => {
      const w = row.frames * cell.width;
      let y0 = cell.height;
      let y1 = -1;
      for (let y = 0; y < cell.height; y++) {
        for (let x = 0; x < w; x++) {
          if (img.pixels[((r * cell.height + y) * img.width + x) * 4 + 3] > 0) {
            y0 = Math.min(y0, y);
            y1 = Math.max(y1, y);
            break;
          }
        }
      }
      if (y1 < 0) return;
      const h = y1 - y0 + 1;
      writeFileSync(join(PUBLIC, out, `${row.state}.png`), encodePng(w, h, crop(img.pixels, img.width, 0, r * cell.height + y0, w, h)));
      layerRows[row.state] = { y: y0, h };
      layerBytes += decodedBytes(w, h);
    });
    scale.layers = { ...scale.layers, [layer]: { rowFiles: `${out}/{state}.png`, use: spec.use, draw: spec.draw, rows: layerRows } };
    console.log(`  ${layer} ${name}: ${Object.keys(layerRows).length} rows, ${(layerBytes / 2 ** 20).toFixed(2)} MiB decoded if every row is`);
  }
  const bytes = written.reduce((n, w) => n + w.bytes, 0);
  const decoded = written.reduce((n, w) => n + decodedBytes(w.width, w.height), 0);
  console.log(
    `${name}: cell ${cell.width}x${cell.height}, sheet ${sheet.width}x${sheet.height}, ` +
      `${(decodedBytes(sheet.width, sheet.height) / 2 ** 20).toFixed(1)} MiB decoded whole -> ` +
      (big ? `${written.length} row files, ${(decoded / 2 ** 20).toFixed(1)} MiB if every row is decoded` : "one file") +
      `, ${(bytes / 1024).toFixed(0)} KB on disk`,
  );
}

if (rows.length < current.rows.length || current.rows.some((r, i) => r.state !== rows[i].state)) {
  throw new Error("the delivered rows do not start with the manifest's rows in order");
}
const added = rows.slice(current.rows.length).map((r) => r.state);
if (added.length) console.log(`new rows: ${added.join(", ")}`);
console.log(`rows: ${rows.length}, ${rows.reduce((n, r) => n + r.frames, 0)} frames`);
if (rows.some((r) => r.frames > current.columns)) throw new Error(`a row has more than ${current.columns} frames`);

console.log(`ink: x ${ink.left} to ${ink.right} of the ${scales[0].cell.width} px cell`);

// The branch, per scale, in that scale's px. The old copies go first, so nothing stale is left.
rmSync(join(PUBLIC, "parrot/props"), { recursive: true, force: true });
const branches = [];
for (const { name } of SCALES) {
  const file = `branch@${name}.png`;
  if (!existsSync(join(dir, file))) continue;
  const scale = Number(name.replace("x", ""));
  const image = decodePng(readFileSync(join(dir, file)));
  mkdirSync(join(PUBLIC, "parrot/props"), { recursive: true });
  const out = `parrot/props/branch-${name}.png`;
  copyFileSync(join(dir, file), join(PUBLIC, out));
  const entry = { scale, file: out, width: image.width, height: image.height };
  const meta = JSON.parse(readFileSync(join(dir, `parrot@${name}.json`), "utf8")).meta.branch;
  if (meta) {
    if (meta.edge !== undefined && meta.edge !== "right") throw new Error(`meta.branch.edge is ${meta.edge}; the overlay draws a right-edge branch`);
    for (const k of ["w", "h", "perchX", "perchY"]) if (typeof meta[k] !== "number") throw new Error(`parrot@${name}.json: meta.branch.${k} is missing`);
    if (meta.w !== image.width || meta.h !== image.height) throw new Error(`${file} is ${image.width}x${image.height}, meta.branch says ${meta.w}x${meta.h}`);
    Object.assign(entry, { perchX: meta.perchX, perchY: meta.perchY });
    if (typeof meta.birdFeetX === "number") entry.feetX = meta.birdFeetX;
    if (typeof meta.sinkPx === "number") entry.sinkPx = meta.sinkPx;
    if (typeof meta.outlinePx === "number") entry.outlinePx = meta.outlinePx;
    if (meta.shadow) {
      const sh = meta.shadow;
      const shadow = decodePng(readFileSync(join(dir, sh.image)));
      if (shadow.width !== sh.w || shadow.height !== sh.h) throw new Error(`${sh.image} is ${shadow.width}x${shadow.height}, meta.branch.shadow says ${sh.w}x${sh.h}`);
      const shadowOut = `parrot/props/branch-shadow-${name}.png`;
      copyFileSync(join(dir, sh.image), join(PUBLIC, shadowOut));
      entry.shadow = { file: shadowOut, x: sh.x, y: sh.y, w: sh.w, h: sh.h };
    }
    if (meta.drawOrder) {
      // The overlay draws branch, shadow, bird, then the grip over it; it can't follow another order.
      const want = ["branch", "shadow", "bird", "frontGrip"];
      const got = meta.drawOrder.map((d) => d.split(" ")[0]);
      if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`meta.branch.drawOrder is ${JSON.stringify(meta.drawOrder)}; the overlay draws ${want.join(", ")}`);
      entry.drawOrder = meta.drawOrder;
    }
    if (typeof meta.birdFeetX === "number") {
      const baseline = JSON.parse(readFileSync(join(dir, `parrot@${name}.json`), "utf8")).meta.baseline;
      entry.cell = { x: meta.perchX - meta.birdFeetX, y: Math.round(meta.perchY - baseline) };
    }
    if (meta.rowDy) {
      for (const [row, dy] of Object.entries(meta.rowDy)) {
        if (!rows.some((r) => r.state === row)) throw new Error(`meta.branch.rowDy names ${row}, which isn't a row`);
        if (!Number.isInteger(dy)) throw new Error(`meta.branch.rowDy.${row} is ${dy}, not whole px`);
      }
      entry.rowDy = meta.rowDy;
    }
  }
  branches.push(entry);
  console.log(
    `branch ${name}: ${entry.width}x${entry.height}` +
      (meta ? `, perch at ${entry.perchX},${entry.perchY}, mirrored cell at ${entry.cell ? `${entry.cell.x},${entry.cell.y}` : "?"}, rowDy ${JSON.stringify(entry.rowDy ?? {})}` : ", no meta.branch") +
      (entry.shadow ? `, shadow ${entry.shadow.w}x${entry.shadow.h} at ${entry.shadow.x},${entry.shadow.y}` : "") +
      (entry.outlinePx ? `, outline ${entry.outlinePx} px` : ""),
  );
}

const manifest = {
  columns: current.columns,
  displayCell: baseline === null ? scales[0].cell : { ...scales[0].cell, baseline },
  ...(lidColour ? { lidColour } : {}),
  ink,
  scales,
  rows,
  ...(branches.length ? { branches } : {}),
  ...(contact ? { contact } : {}),
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
  branches.length || contact ? "  ]," : "  ]",
  ...(branches.length ? ['  "branches": [', ...branches.map((b, i) => `    ${line(b)}${i < branches.length - 1 ? "," : ""}`), contact ? "  ]," : "  ]"] : []),
  ...(contact ? [`  "contact": ${line(contact)}`] : []),
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
