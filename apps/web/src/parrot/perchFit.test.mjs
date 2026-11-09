// The perched bird composited on the branch at every scale, in device px,
// from the PNGs that ship, placed as the overlay places it, checked against
// B's rule (meta.branch, parrot-art 95c5814) and B's no-float check
// (transitions.py perch_float), ported here. An .mjs so that the app's
// tsconfig, which has no Node types, leaves it alone.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodePng } from "../../../../scripts/parrot-png.mjs";
import { DISPLAY_CELL, SCALES, rowOf } from "./animator";
import { birdBox } from "./layout";
import { BRANCH_DRAWINGS, branchBox, branchOf, perchDy, perchSpot } from "./perch";

const publicDir = fileURLToPath(new URL("../../public/", import.meta.url));
const png = (file) => decodePng(readFileSync(publicDir + file));
const WIDTH = 1440;
const HEIGHT = 900;
/** The rows the app may show perched (transitions.py PERCH_ROWS). */
const PERCH_ROWS = ["idle", "perch", "sleep", "pet"];
// transitions.py: the toes are the bottom within TOE_ZONE of the lowest point; a body whose lowest point is
// within BELLY_REST of the toes rests on it; an opening of BELLY_LEGS takes the legs and toes away. 1x px.
const TOE_ZONE = 5;
const BELLY_REST = 7;
const BELLY_LEGS = 6;

/** A mask, w by h, true where the image's alpha is over 127. */
function opaque(img, x0, y0, w, h) {
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y * w + x] = img.pixels[((y0 + y) * img.width + x0 + x) * 4 + 3] > 127 ? 1 : 0;
  return m;
}

/** cv2.getStructuringElement(MORPH_ELLIPSE, 2r+1), r as cutter.disc rounds it: per dy, the half-width dx. */
function disc(r) {
  r = Math.max(1, Math.round(r));
  const rows = [];
  for (let dy = -r; dy <= r; dy++) rows.push([dy, Math.round(Math.sqrt(r * r - dy * dy))]);
  return rows;
}

/**
 * cv2 erode / dilate with OpenCV's default border (outside counts as set for erode, unset for dilate),
 * by per-row prefix sums: a disc row's span is all set (erode) or has any set (dilate) in one lookup.
 */
function morph(m, w, h, k, erode) {
  const pre = new Int32Array(h * (w + 1));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) pre[y * (w + 1) + x + 1] = pre[y * (w + 1) + x] + m[y * w + x];
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = erode ? 1 : 0;
      for (const [dy, dx] of k) {
        const yy = y + dy;
        // Rows past the edge: set for erode, unset for dilate; neither changes the answer.
        if (yy < 0 || yy >= h) continue;
        const x0 = x - dx;
        const x1 = x + dx;
        const a = Math.max(0, x0);
        const b = Math.min(w - 1, x1);
        const set = pre[yy * (w + 1) + b + 1] - pre[yy * (w + 1) + a];
        // Columns past the edge count as set for erode, unset for dilate.
        if (erode ? set < b - a + 1 : set > 0) {
          v = erode ? 0 : 1;
          break;
        }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

/** One mirrored frame (the app perches the bird facing in): RGBA for column x of the drawn cell. */
function mirroredFrame(strip, frame, cw, ch) {
  const rgba = (x, y) => {
    const i = (y * strip.width + frame * cw + (cw - 1 - x)) * 4;
    return strip.pixels.subarray(i, i + 4);
  };
  return rgba;
}

/**
 * transitions.py contact(): where a mirrored cell rests. bottom[x], its lowest opaque row; cols, the toes
 * (bottom within TOE_ZONE of the lowest point, not the red tail), plus, where the body rests low (sleep), the
 * belly beside the feet where the body itself is the bottom, within a px of the lowest of them.
 */
function contact(rgba, cw, ch, s) {
  const op = new Uint8Array(cw * ch);
  const red = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const [r, g, b, a] = rgba(x, y);
      op[y * cw + x] = a > 127 ? 1 : 0;
      red[y * cw + x] = a > 127 && r > 170 && g < 130 && b < 130 && r - g > 70 ? 1 : 0;
    }
  }
  const lowestIn = (m) => Array.from({ length: cw }, (_, x) => {
    for (let y = ch - 1; y >= 0; y--) if (m[y * cw + x]) return y;
    return -1;
  });
  const bottom = lowestIn(op);
  const low = Math.max(...bottom);
  if (low < 0) return { bottom, op, cw, cols: [], toes: [], belly: [] };
  const redNear = morph(red, cw, ch, disc(3 * s), false);
  const toes = bottom.map((bt, x) => bt >= 0 && bt >= low - TOE_ZONE * s && !redNear[bt * cw + x]);
  const k = disc(BELLY_LEGS * s);
  const body = morph(morph(op.map((v, i) => (v && !red[i] ? 1 : 0)), cw, ch, k, true), cw, ch, k, false);
  const bb = lowestIn(body);
  const cols = toes.slice();
  const blow = Math.max(...bb);
  if (blow >= 0 && blow >= low - BELLY_REST * s) {
    const tx = toes.flatMap((t, x) => (t ? [x] : []));
    const bare = bb.map((b, x) => b >= 0 && bottom[x] - b <= s && (!tx.length || x < Math.min(...tx) || x > Math.max(...tx)));
    if (bare.some(Boolean)) {
      const top = Math.max(...bb.filter((_, x) => bare[x]));
      bare.forEach((on, x) => {
        if (on && bb[x] >= top - s) cols[x] = true;
      });
    }
  }
  const list = (m) => m.flatMap((c, x) => (c ? [x] : []));
  // transitions.py toe_runs: a toe-zone column where the body itself is the bottom is not a toe.
  const toeCols = toes.map((t, x) => t && (bb[x] < 0 || bottom[x] - bb[x] > 1.5 * s));
  return { bottom, op, cw, cols: list(cols), toes: list(toeCols), belly: list(cols.map((c, x) => c && !toes[x])) };
}

/** transitions.py: toe columns this close join one toe; narrower runs are claw specks. 1x px. */
const TOE_GAP = 2;
const TOE_MIN_W = 2;
/** transitions.py TOE_H: a toe's thickness is clipped to this, 1x px. */
const TOE_H = [2, 8];
/** B's rule (meta.branch.note): every toe reaches this far into the bark fill, 1x px. */
const GRIP_INTO = 2;
/** transitions.py BRANCH_ROWS: every row drawn on the branch. */
const BRANCH_ROWS = ["idle", "perch", "sleep", "pet", "wake", "land", "takeoff"];

/**
 * transitions.py toe_runs: toe columns joined into toes (gaps of at most TOE_GAP), claw specks (narrower than
 * TOE_MIN_W) going with the nearest toe but never setting its depth; each toe's lowest row, the columns at it
 * (lowCols), and its underside (cols: bottom within the digit's thickness of the lowest row).
 */
function toeRuns({ bottom, op, cw, toes }, k) {
  const runs = [];
  for (const x of toes) {
    const last = runs[runs.length - 1];
    if (last && x - last[last.length - 1] <= TOE_GAP * k + 1) last.push(x);
    else runs.push([x]);
  }
  const width = (r) => r[r.length - 1] - r[0] + 1;
  const wide = runs.filter((r) => width(r) >= TOE_MIN_W * k);
  const specks = new Set();
  for (const r of runs) {
    if (!wide.length || width(r) >= TOE_MIN_W * k) continue;
    const gap = (w) => Math.min(Math.abs(w[0] - r[r.length - 1]), Math.abs(r[0] - w[w.length - 1]));
    const near = wide.reduce((a, w) => (gap(w) < gap(a) ? w : a));
    if (gap(near) <= 3 * TOE_GAP * k + 1) {
      near.push(...r);
      near.sort((p, q) => p - q);
      r.forEach((x) => specks.add(x));
    }
  }
  return wide.map((r) => {
    const own = r.filter((x) => !specks.has(x));
    const low = Math.max(...own.map((x) => bottom[x]));
    const thick = r.map((x) => {
      let n = 0;
      while (bottom[x] - n >= 0 && op[(bottom[x] - n) * cw + x]) n++;
      return n;
    }).sort((p, q) => p - q);
    // numpy's 25th percentile, linear between ranks.
    const at = 0.25 * (thick.length - 1);
    const p25 = thick[Math.floor(at)] + (thick[Math.ceil(at)] - thick[Math.floor(at)]) * (at - Math.floor(at));
    const h = Math.min(Math.max(p25, TOE_H[0] * k), TOE_H[1] * k);
    const cols = r.filter((x) => bottom[x] >= low - h);
    return { low, cols, lowCols: cols.filter((x) => bottom[x] === low && !specks.has(x)), h };
  });
}

/** Each scale: its drawing, sheet, the branch, its top line per column, and the app's placement, device px. */
function setup(d) {
  const k = d.scale;
  const sheet = SCALES.find((s) => s.cell.width === DISPLAY_CELL.width * k);
  const b = branchOf(d);
  const box = branchBox(WIDTH, HEIGHT, b);
  const bird = birdBox({ ...perchSpot(WIDTH, HEIGHT, DISPLAY_CELL, b), cell: DISPLAY_CELL }, HEIGHT);
  const branch = png(d.file);
  const bark = opaque(branch, 0, 0, branch.width, branch.height);
  // The top of the trunk's dark outline in a column (its first opaque row); the fill starts outlinePx below it.
  const barkTop = (x) => {
    for (let y = 0; y < branch.height; y++) if (bark[y * branch.width + x]) return y;
    return null;
  };
  const ox = Math.round((bird.x - box.x) * k);
  const oyOf = (row) => Math.round((bird.y + perchDy(b, row) - box.y) * k);
  return { k, sheet, b, box, bird, branch, barkTop, ox, oyOf };
}

/** Every grounded frame of every row drawn on the branch, with its toes, belly and grip, placed by the rule. */
function* branchFrames(d) {
  const { k, sheet, branch, barkTop, ox, oyOf } = setup(d);
  const cw = sheet.cell.width;
  const ch = sheet.cell.height;
  const grip = sheet.layers.frontGrip;
  for (const row of BRANCH_ROWS) {
    const strip = png(sheet.rowFiles.replace("{state}", row));
    const gripStrip = grip.rows[row] ? png(grip.rowFiles.replace("{state}", row)) : null;
    const gy = grip.rows[row]?.y ?? 0;
    for (let f = 0; f < rowOf(row).frames; f++) {
      if (sheet.feetBottom[row][f] === null) continue;
      const frameContact = contact(mirroredFrame(strip, f, cw, ch), cw, ch, k);
      // The grip's alpha at (x, y) of the drawn cell: the same frame, mirrored just as the bird is.
      const gripAt = (x, y) => {
        if (!gripStrip || y < gy || y >= gy + gripStrip.height) return 0;
        return gripStrip.pixels[((y - gy) * gripStrip.width + f * cw + (cw - 1 - x)) * 4 + 3];
      };
      yield { row, f, k, contact: frameContact, bottom: frameContact.bottom, belly: frameContact.belly, gripAt, oy: oyOf(row), ox, barkTop, branch, outline: d.outlinePx };
    }
  }
}

describe("the perched bird on the branch, by B's rule (meta.branch), at every scale", () => {
  it.each(BRANCH_DRAWINGS.map((d) => [`${d.scale}x`, d]))("%s: the mirrored cell is placed exactly where the rule says, rowDy and all, on whole device px", (_, d) => {
    const { k, sheet, b, box, bird } = setup(d);
    const baseline = (DISPLAY_CELL.baseline ?? DISPLAY_CELL.height) * k;
    expect(d.cell).toEqual({ x: d.perchX - d.feetX, y: Math.round(d.perchY - baseline) });
    expect(Number.isInteger(box.y * k)).toBe(true);
    expect((bird.x - box.x) * k).toBeCloseTo(d.perchX - d.feetX, 9);
    for (const row of BRANCH_ROWS) {
      const top = (bird.y + perchDy(b, row) - box.y) * k;
      expect(top, row).toBeCloseTo(Math.round(d.perchY - baseline) + (d.rowDy?.[row] ?? 0), 9);
    }
    expect(perchDy(b, "talk")).toBe(0);
    expect(sheet.cell.width).toBe(DISPLAY_CELL.width * k);
  });

  it.each(BRANCH_DRAWINGS.map((d) => [`${d.scale}x`, d]))(
    "%s: in every grounded frame of every row drawn on the branch, each toe reaches 2 px (1x) into the bark fill, and a resting belly onto it",
    { timeout: 60_000 },
    (_, d) => {
      expect(d.outlinePx, "meta.branch.outlinePx").toBeGreaterThan(0);
      const bad = [];
      let frames = 0;
      for (const fr of branchFrames(d)) {
        frames++;
        const runs = toeRuns(fr.contact, fr.k);
        if (!runs.length && !fr.belly.length) bad.push(`${fr.row} ${fr.f}: nothing rests on the branch`);
        for (const r of runs) {
          // The fill starts outlinePx below the trunk's top line; the toe's lowest row is GRIP_INTO px into it.
          for (const x of r.lowCols) {
            const into = r.low + fr.oy - (fr.barkTop(x + fr.ox) + fr.outline) + 1;
            if (into < GRIP_INTO * fr.k) bad.push(`${fr.row} ${fr.f}: a toe ${into} px into the fill at x ${x}`);
          }
          // Every column of the toe ends inside the branch.
          for (const x of r.cols) if (fr.bottom[x] + fr.oy < fr.barkTop(x + fr.ox) - 1) bad.push(`${fr.row} ${fr.f}: toe column ${x} over the bark`);
        }
        for (const x of fr.belly) if (fr.bottom[x] + fr.oy < fr.barkTop(x + fr.ox) + fr.outline - 1) bad.push(`${fr.row} ${fr.f}: belly column ${x} short of the fill`);
      }
      expect(bad).toEqual([]);
      expect(frames).toBeGreaterThan(20);
    },
  );

  it.each(BRANCH_DRAWINGS.map((d) => [`${d.scale}x`, d]))(
    "%s: the grip cell, mirrored and placed just as the bird's, lies over the lowest pixels of every toe in every grounded frame",
    { timeout: 60_000 },
    (_, d) => {
      const bad = [];
      for (const fr of branchFrames(d)) {
        for (const r of toeRuns(fr.contact, fr.k)) {
          const missed = r.lowCols.filter((x) => fr.gripAt(x, r.low) <= 127);
          if (missed.length) bad.push(`${fr.row} ${fr.f}: grip misses toe columns ${missed.join(",")} at row ${r.low}`);
        }
      }
      expect(bad).toEqual([]);
    },
  );
});
