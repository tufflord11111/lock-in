/**
 * How the bird looks where its feet are, from meta.layers. The main sheet
 * alone is the perch look. On the ground the underband goes under it (the
 * white border and outer line below the belly line). On the branch (perched,
 * landing, taking off, asleep there) the front grip goes over it, cell for
 * cell, so the toes wrap round the bark: the branch, its shadow, the bird, the
 * grip (meta.branch.drawOrder). In the air, neither. Pure: the overlay draws
 * from it.
 */
import { contactAt, frameRect, layerRect, type SheetScale } from "./animator";
import { nextRows, type BirdState } from "./machine";

export type Layer = "underband" | "frontGrip";
/** The layer drawn under the bird, and the one drawn over it, for this frame. */
export type Look = { under: Layer | null; over: Layer | null };

/**
 * This frame's look: `onBranch` is whether its feet are on the branch (perch.ts
 * feetOnBranch). On the branch the grip is B's own cell for the frame, empty
 * where the art has none, so it goes over every frame there.
 */
export function lookFor(row: string, frame: number, onBranch: boolean): Look {
  if (onBranch) return { under: null, over: "frontGrip" };
  return contactAt(row, frame) ? { under: "underband", over: null } : { under: null, over: null };
}

/**
 * The layers it may need next: the one for where it is, and both while it
 * flies between the ground and the branch or is carried (a drop by the branch
 * lands on it).
 */
export function layersWanted(s: BirdState): Layer[] {
  if (s.mode === "drag" || s.mode === "fall") return ["underband", "frontGrip"];
  if (s.mode === "flight" && s.flight) {
    const { toBranch, fromBranch } = s.flight;
    if (toBranch && fromBranch) return ["frontGrip"];
    return toBranch || fromBranch ? ["underband", "frontGrip"] : ["underband"];
  }
  return s.onBranch ? ["frontGrip"] : ["underband"];
}

/** Every file the bird may draw next at this scale: its rows, and their strips of the layers it may need. */
export function wantedFiles(s: BirdState, now: number, scale: SheetScale): string[] {
  const rows = nextRows(s, now);
  const files = rows.map((row) => frameRect(scale, row, 0).file);
  for (const layer of layersWanted(s)) {
    for (const row of rows) {
      const rect = layerRect(scale, layer, row, 0);
      if (rect) files.push(rect.file);
    }
  }
  return [...new Set(files)];
}
