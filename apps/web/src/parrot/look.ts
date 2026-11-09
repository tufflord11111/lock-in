/**
 * How the bird looks where its feet are. The main sheet alone is the perch
 * look (meta.layers). On the ground the underband goes under it (the white
 * border and outer line below the belly line) and there is no shadow. On the
 * branch (perched, landing, taking off, asleep there) the toerim goes under
 * it and the contact shadow under that, so: branch, shadow, toerim, bird,
 * lip. In the air, neither. Pure: the overlay draws from it.
 */
import { contactAt, frameRect, layerRect, type SheetScale } from "./animator";
import { nextRows, type BirdState } from "./machine";
import { shadowFor, type Shadow } from "./shadow";

export type Layer = "underband" | "toerim";
export type Look = { layer: Layer | null; shadow: Shadow | null };

/** This frame's look: `onBranch` is whether its feet are on the branch (perch.ts frontShown). */
export function lookFor(row: string, frame: number, onBranch: boolean): Look {
  if (!contactAt(row, frame)) return { layer: null, shadow: null };
  return onBranch ? { layer: "toerim", shadow: shadowFor(row, frame, true) } : { layer: "underband", shadow: null };
}

/**
 * The layers it may need next: the one for where it is, and both while it
 * flies between the ground and the branch or is carried (a drop by the branch
 * lands on it).
 */
export function layersWanted(s: BirdState): Layer[] {
  if (s.mode === "drag" || s.mode === "fall") return ["underband", "toerim"];
  if (s.mode === "flight" && s.flight) {
    const { toBranch, fromBranch } = s.flight;
    if (toBranch && fromBranch) return ["toerim"];
    return toBranch || fromBranch ? ["underband", "toerim"] : ["underband"];
  }
  return s.onBranch ? ["toerim"] : ["underband"];
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
