import { describe, expect, it } from "vitest";
import { frameIssues, type FrameFacts } from "./frameCheck";

const ok: FrameFacts = {
  row: "idle",
  frame: 1,
  frames: 4,
  wantedFile: "parrot/parrot-2x/idle.png",
  shownFile: "parrot/parrot-2x/idle.png",
  hasImage: true,
  scaleX: 1,
  lidShown: false,
  lidSize: 0,
  cellWidth: 168,
};
const causes = (f: Partial<FrameFacts>) => frameIssues({ ...ok, ...f }).map((i) => i.cause);

describe("the debug frame check", () => {
  it("passes a whole frame", () => {
    expect(frameIssues(ok)).toEqual([]);
  });

  it("names each way a frame can be missing or incomplete", () => {
    expect(causes({ hasImage: false })).toEqual(["no-image"]);
    expect(causes({ frame: 4 })).toEqual(["frame-outside-row"]);
    expect(causes({ shownFile: "parrot/parrot-2x/walk.png" })).toEqual(["previous-row-held"]);
    expect(causes({ scaleX: -0.08 })).toEqual(["turn-squeeze"]);
    expect(causes({ lidShown: true, lidSize: 60 })).toEqual(["lid-too-big"]);
    expect(causes({ lidShown: true, lidSize: 8, shownFile: "x" })).toEqual(["previous-row-held", "lid-over-other-row"]);
  });

  it("doesn't call an ordinary turn or blink a problem", () => {
    expect(causes({ scaleX: -0.5 })).toEqual([]);
    expect(causes({ lidShown: true, lidSize: 8 })).toEqual([]);
  });
});
