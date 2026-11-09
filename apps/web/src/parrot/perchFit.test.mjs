// The perched bird composited on the branch at every scale, in device px,
// from the PNGs that ship and placed exactly as the overlay places it (the
// CSS-px rounding included). An .mjs so that the app's tsconfig, which has no
// Node types, leaves it alone.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodePng } from "../../../../scripts/parrot-png.mjs";
import { DISPLAY_CELL, SCALES } from "./animator";
import { birdBox } from "./layout";
import { BRANCH_DRAWINGS, branchBox, branchOf, perchSpot } from "./perch";

const publicDir = fileURLToPath(new URL("../../public/", import.meta.url));
const png = (file) => decodePng(readFileSync(publicDir + file));
const alpha = (img, x, y) => img.pixels[(y * img.width + x) * 4 + 3];
const WIDTH = 1440;
const HEIGHT = 900;

/** Each scale: the branch drawing and sheet it goes with, the perch row's frame 0, and where the app puts both, device px. */
function perched(d) {
  const sheet = SCALES.find((s) => s.cell.width === DISPLAY_CELL.width * d.scale);
  const k = d.scale;
  const b = branchOf(d);
  const box = branchBox(WIDTH, HEIGHT, b);
  const bird = birdBox({ ...perchSpot(WIDTH, HEIGHT, DISPLAY_CELL, b), cell: DISPLAY_CELL }, HEIGHT);
  const branch = png(d.file);
  const strip = png(sheet.rowFiles.replace("{state}", "perch"));
  const barkTop = (x) => {
    for (let y = 0; y < branch.height; y++) if (alpha(branch, x, y) > 127) return y;
    return null;
  };
  return { d, k, sheet, branch, strip, barkTop, birdTop: (bird.y - box.y) * k, birdLeft: (bird.x - box.x) * k };
}

describe("the perched bird's feet in the bark, at every scale", () => {
  it.each(BRANCH_DRAWINGS.map((d) => [`${d.scale}x`, d]))("%s: meta.feetBottom lands sinkPx below the trunk's top line (plus the facing-in drop), within a device px", (_, d) => {
    const { k, sheet, barkTop, birdTop } = perched(d);
    expect(d.sinkPx, "meta.branch.sinkPx").toBeGreaterThan(0);
    // The trunk's top line at the perch point is where meta.branch says: perchY less sinkPx.
    expect(barkTop(d.perchX)).toBe(d.perchY - d.sinkPx);
    const feetBottom = sheet.feetBottom.perch[0];
    const sink = birdTop + feetBottom - barkTop(d.perchX);
    expect(Math.abs(sink - (d.sinkPx + (d.dropIn ?? 0))), `sinks ${sink} device px`).toBeLessThanOrEqual(1);
    // Never the bark's other side: the lowest toe stays under the front lip.
    expect(birdTop + feetBottom).toBeLessThanOrEqual(d.front.y + d.front.h + 1);
    expect(k).toBe(d.scale);
  });

  it.each(BRANCH_DRAWINGS.map((d) => [`${d.scale}x`, d]))("%s: facing in, the drop brings the mirrored near foot down by dropIn toward the bark", (_, d) => {
    const { k, sheet, strip, barkTop, birdTop, birdLeft } = perched(d);
    const cw = sheet.cell.width;
    const baseline = (DISPLAY_CELL.baseline ?? DISPLAY_CELL.height) * k;
    const feetIn = cw - d.feetX;
    let worst = -Infinity;
    for (let c = Math.round(feetIn - 30 * k); c <= Math.round(feetIn + 30 * k); c++) {
      const bx = Math.round(birdLeft + c);
      if (bx < 0 || bx >= d.width) continue;
      // Mirrored: column c of the bird facing in is column cw-1-c of the art.
      let low = -1;
      for (let y = sheet.cell.height - 1; y >= 0; y--) {
        if (alpha(strip, cw - 1 - c, y) > 127) {
          low = y;
          break;
        }
      }
      if (low < 0 || low < baseline - 10 * k) continue;
      worst = Math.max(worst, barkTop(bx) - (birdTop + low));
    }
    // Where B's perch point alone would put it, these toes floated by dropIn more.
    const atPerchPoint = worst + (d.dropIn ?? 0);
    expect(d.dropIn).toBeGreaterThan(0);
    expect(worst).toBeLessThan(atPerchPoint);
    console.log(`${d.scale}x facing in: the near toes floated ${atPerchPoint.toFixed(1)} device px over the bark, now ${Math.max(0, worst).toFixed(1)} (lowered ${d.dropIn})`);
  });
});
