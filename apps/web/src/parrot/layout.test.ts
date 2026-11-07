import { describe, expect, it } from "vitest";
import { birdBox, cardAnchor, dragPosition, grabOffset, physicalBox } from "./layout";
import { initialState, reduce } from "./machine";

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

describe("the grab point stays under the cursor, at every display scale", () => {
  const CELL = { width: 168, height: 152 };
  // An overlay the size of this laptop's work area, in physical px.
  const PHYS_W = 2880;
  const PHYS_H = 1752;

  describe.each([1, 1.5, 2])("at %sx", (dpr) => {
    const innerWidth = PHYS_W / dpr;
    const innerHeight = PHYS_H / dpr;
    const css = (p: { x: number; y: number }) => ({ x: p.x / dpr, y: p.y / dpr });

    const pressAndDrag = (pressPhys: { x: number; y: number }, toPhys: { x: number; y: number }) => {
      let s = initialState(0, innerWidth, false, false, 0, CELL);
      // The press: where on the bird, from the state's box, in CSS px.
      const grab = grabOffset(css(pressPhys), birdBox(s, innerHeight));
      s = reduce(s, { type: "dragStart" }, 1, 0);
      s = reduce(s, { type: "dragMove", ...dragPosition(css(toPhys), grab, innerHeight, s.cell) }, 2, 0);
      return { grab, s, box: physicalBox(birdBox(s, innerHeight), dpr) };
    };

    it("grabs at the point pressed, inside a cell wider than it is tall", () => {
      const s = initialState(0, innerWidth, false, false, 0, CELL);
      const box = physicalBox(birdBox(s, innerHeight), dpr);
      expect([box.w, box.h]).toEqual([Math.round(168 * dpr), Math.round(152 * dpr)]);
      const press = { x: box.x + 40 * dpr, y: box.y + 100 * dpr };
      // The box was rounded to whole physical px, so allow one of them.
      const grab = grabOffset(css(press), birdBox(s, innerHeight));
      expect(Math.abs(grab.x - 40) * dpr).toBeLessThanOrEqual(1);
      expect(Math.abs(grab.y - 100) * dpr).toBeLessThanOrEqual(1);
    });

    it("keeps the pressed point under the cursor after a drag, to the physical pixel", () => {
      const start = physicalBox(birdBox(initialState(0, innerWidth, false, false, 0, CELL), innerHeight), dpr);
      const press = { x: start.x + 150 * dpr, y: start.y + 30 * dpr }; // near the right edge, high up
      const to = { x: 900, y: 700 };
      const { box } = pressAndDrag(press, to);
      expect(Math.abs(box.x + 150 * dpr - to.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(box.y + 30 * dpr - to.y)).toBeLessThanOrEqual(1);
    });

    it("stops the box at the top and side edges by the cell's own width and height", () => {
      const start = physicalBox(birdBox(initialState(0, innerWidth, false, false, 0, CELL), innerHeight), dpr);
      const press = { x: start.x + 10 * dpr, y: start.y + 10 * dpr };
      const { s, box } = pressAndDrag(press, { x: PHYS_W + 500, y: -500 });
      expect(s.x).toBe(innerWidth - 168);
      expect(s.lift).toBe(innerHeight - 152);
      expect(box.x + box.w).toBeLessThanOrEqual(PHYS_W + 1);
      expect(box.y).toBe(0);
    });
  });
});
