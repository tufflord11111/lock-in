import { describe, expect, it } from "vitest";
import { birdBox, cardAnchor, dragPosition, physicalBox } from "./layout";

const SQUARE = { width: 96, height: 96 };
const WIDE = { width: 128, height: 80 };

describe("the bird's box", () => {
  it("sits on the bottom edge, lifted by lift, the size of the cell", () => {
    expect(birdBox({ x: 300, lift: 0, cell: SQUARE }, 1000)).toEqual({ x: 300, y: 904, w: 96, h: 96 });
    expect(birdBox({ x: 300, lift: 50, cell: WIDE }, 1000)).toEqual({ x: 300, y: 870, w: 128, h: 80 });
  });

  it("is rounded to physical px at the display's scale", () => {
    expect(physicalBox(birdBox({ x: 301, lift: 0, cell: WIDE }, 1000), 2)).toEqual({ x: 602, y: 1840, w: 256, h: 160 });
    expect(physicalBox({ x: 10.4, y: 20.6, w: 128, h: 80 }, 1.5)).toEqual({ x: 16, y: 31, w: 192, h: 120 });
  });
});

describe("a drag", () => {
  it("keeps the grab point under the pointer, by the cell's height", () => {
    // Grabbed 10 px in and 20 px down; pointer at (500, 700) in a 1000 px tall window.
    const d = dragPosition({ x: 500, y: 700 }, { x: 10, y: 20 }, 1000, WIDE);
    expect(d.x).toBe(490);
    // Box top is at 680, so its bottom is at 760, and the feet are 240 px up.
    expect(d.lift).toBe(240);
    expect(d.maxLift).toBe(920);
    expect(dragPosition({ x: 500, y: 700 }, { x: 10, y: 20 }, 1000, SQUARE).lift).toBe(224);
  });
});

describe("a card over the bird", () => {
  it("is centred on the cell's width and sits above the cell's height", () => {
    const anchor = cardAnchor({ x: 400, lift: 30, width: 1000, cell: WIDE }, 224, 8);
    expect(anchor.left).toBe(400 + 64 - 112);
    expect(anchor.bottom).toBe(30 + 80 + 8);
  });

  it("stays on the overlay at either edge", () => {
    expect(cardAnchor({ x: 0, lift: 0, width: 1000, cell: WIDE }, 224, 8).left).toBe(8);
    expect(cardAnchor({ x: 1000 - 128, lift: 0, width: 1000, cell: WIDE }, 224, 8).left).toBe(1000 - 224 - 8);
  });
});
